# OpenEvolve codex_app_server 适配器与 codex-cli 0.149.1 的协议兼容垫片。
#
# 背景（实测，2026-10-21）：
#   OpenEvolve @6a18b39 的 CodexAppServerLLM 在 thread/start 中发送
#     "sandbox": {"mode": "read-only", "networkAccess": false}
#   codex-cli 0.149.1 的 app-server 协议要求 sandbox 为单键变体映射：
#     "sandbox": {"read-only": null}
#   形状不符时 thread/start 返回 -32600（"expected map with a single key"），
#   生成调用挂起重试，永远无法完成一次 turn。
#
# 方案：不 fork OpenEvolve —— 在运行时替换 CodexAppServerLLM._run_app_server，
# 仅改变 sandbox 参数形状（其余逻辑逐行保持上游实现）。升档 codex-cli 后应
# 重测；若上游修复此兼容性，可直接删除本垫片。
#
# 注：sandbox 只约束 LLM 会话（codex 进程读仓库以理解上下文）；Century 候选
# 代码的执行隔离由本项目自己的 Seatbelt 沙箱承担（见 sandbox/candidate.sb.tmpl），
# 两层互不替代。

import time
from typing import Any, Dict


def patch_codex_app_server_for_0_149() -> None:
    """给 CodexAppServerLLM 打协议兼容补丁（幂等）。"""
    import openevolve.llm.codex_app_server as cas

    if getattr(cas.CodexAppServerLLM, "_century_sandbox_patched", False):
        return
    upstream_run = cas.CodexAppServerLLM._run_app_server

    def _run_app_server_compat(self, prompt: str, timeout: int) -> str:
        # 与上游唯一差异：thread/start 的 sandbox 参数形状。
        # （上游实现挂在实例方法上，直接复用会携带旧形状，因此这里复制其
        #  主体并只改 sandbox 一行；升级 OpenEvolve 后需重新核对。）
        deadline = time.monotonic() + timeout
        session = self._start_session()
        try:
            session.request("initialize", {"clientInfo": cas._CLIENT_INFO}, deadline)
            session.notify("initialized")
            self._ensure_authenticated(session, deadline)

            thread_params: Dict[str, Any] = {
                "model": self.model,
                "approvalPolicy": "never",
                # codex-cli 0.149.1：单键变体映射（read-only / workspace-write / danger-full-access）
                "sandbox": {"read-only": None},
            }
            if self.cwd:
                thread_params["cwd"] = self.cwd
            thread_result = session.request("thread/start", thread_params, deadline)
            thread_id = (thread_result or {}).get("thread", {}).get("id")
            if not thread_id:
                raise RuntimeError(f"codex app-server returned no thread id: {thread_result}")

            turn_params: Dict[str, Any] = {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
            }
            if self.reasoning_effort is not None:
                turn_params["effort"] = self.reasoning_effort
            session.request("turn/start", turn_params, deadline)

            return self._collect_response(session, deadline)
        finally:
            session.close()

    cas.CodexAppServerLLM._run_app_server = _run_app_server_compat
    cas.CodexAppServerLLM._century_sandbox_patched = True
    _ = upstream_run  # 保留引用便于核对上游签名变化
