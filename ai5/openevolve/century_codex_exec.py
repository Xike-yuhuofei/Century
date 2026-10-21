# AI5 LLM 后端：codex exec 子进程（ChatGPT 登录，无 API Key）。
#
# 背景（实测，2026-10-21）：OpenEvolve 内置的 codex_app_server 后端在本机
# codex-cli 0.149.1 上（除协议兼容问题外）单 turn 响应极慢（PONG 40-80s，
# 真实生成 > 7 分钟未返回），而同一模型经 `codex exec` 标准路径秒级返回
# （PONG ≈ 5s，真实代码生成 ≈ 30-90s）。因此本后端用 `codex exec --json`
# 实现 OpenEvolve 的 LLMInterface（generate / generate_with_context），
# 经 ensemble 的 _PROVIDER_REGISTRY 注入，替代 app-server 路径。
#
# 认证完全由 codex CLI 的 ChatGPT 登录管理；本文件不读取、不存储任何密钥。

import asyncio
import json
import logging
import subprocess
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


class CodexExecError(RuntimeError):
    pass


class CodexExecLLM:
    """OpenAI Codex CLI (`codex exec`) LLM backend, OpenEvolve LLMInterface 兼容。"""

    def __init__(self, model_cfg: Any):
        self.model_cfg = model_cfg
        self.name = getattr(model_cfg, "name", "gpt-5.6-sol")
        self.model = self.name  # ensemble._sample_model 以 vars(model)['model'] 记录日志
        self.weight = getattr(model_cfg, "weight", 1.0)
        self.timeout = getattr(model_cfg, "timeout", None) or 600
        self.retries = getattr(model_cfg, "retries", None)
        self.retries = 2 if self.retries is None else self.retries
        self.retry_delay = getattr(model_cfg, "retry_delay", None) or 5
        self.reasoning_effort = getattr(model_cfg, "reasoning_effort", None) or "low"
        self.last_usage: Dict[str, Any] | None = None

    def _build_command(self) -> List[str]:
        cmd = ["codex", "exec", "--skip-git-repo-check", "--json", "-m", self.name]
        if self.reasoning_effort:
            cmd += ["-c", f'model_reasoning_effort="{self.reasoning_effort}"']
        return cmd

    def _run_exec(self, prompt: str, timeout: int) -> str:
        proc = subprocess.run(
            self._build_command() + [prompt],
            capture_output=True, text=True, timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
        texts: List[str] = []
        usage: Dict[str, Any] | None = None
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "item.completed":
                item = event.get("item") or {}
                if item.get("type") == "agent_message" and item.get("text"):
                    texts.append(item["text"])
            elif event.get("type") == "turn.completed":
                # codex exec 的 usage 键（input_tokens/output_tokens…）映射为
                # OpenEvolve process_parallel 期望的 prompt/completion/total 键，
                # 使每迭代「模型调用及资源消耗」真实进入日志与 checkpoint。
                u = event.get("usage") or {}
                usage = {
                    "prompt_tokens": u.get("input_tokens", 0),
                    "completion_tokens": u.get("output_tokens", 0),
                    "total_tokens": u.get("input_tokens", 0) + u.get("output_tokens", 0),
                    "cached_input_tokens": u.get("cached_input_tokens", 0),
                    "reasoning_output_tokens": u.get("reasoning_output_tokens", 0),
                }
            elif event.get("type") == "turn.failed":
                error = (event.get("error") or {}).get("message", "turn failed")
                raise CodexExecError(f"codex exec turn failed: {error[:200]}")
        self.last_usage = usage
        if proc.returncode != 0 and not texts:
            tail = (proc.stderr or "")[-300:]
            raise CodexExecError(f"codex exec exit {proc.returncode}: {tail}")
        if not texts:
            raise CodexExecError("codex exec 未返回任何 agent_message")
        return "\n\n".join(texts)

    async def generate(self, prompt: str, **kwargs) -> str:
        sys_msg = kwargs.pop("system_message", "") or ""
        return await self.generate_with_context(
            system_message=sys_msg, messages=[{"role": "user", "content": prompt}], **kwargs
        )

    async def generate_with_context(self, system_message: str, messages: List[Dict[str, str]], **kwargs) -> str:
        user_content = "\n\n".join(m.get("content", "") for m in messages if m.get("role") == "user")
        prompt = f"{system_message}\n\n{user_content}" if system_message else user_content
        timeout = kwargs.get("timeout", self.timeout)
        retries = kwargs.get("retries", self.retries)
        loop = asyncio.get_event_loop()
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                return await asyncio.wait_for(
                    loop.run_in_executor(None, lambda p=prompt: self._run_exec(p, timeout)),
                    timeout=timeout + 30,
                )
            except FileNotFoundError:
                raise CodexExecError("未找到 codex CLI；请先 npm install -g @openai/codex 并 codex login")
            except Exception as e:  # noqa: BLE001 —— 统一重试
                last_error = e
                if attempt < retries:
                    logger.warning(
                        "codex exec attempt %d/%d failed: %s; retrying",
                        attempt + 1, retries + 1, str(e)[:150],
                    )
                    await asyncio.sleep(self.retry_delay)
        raise last_error if last_error else CodexExecError("codex exec failed")
