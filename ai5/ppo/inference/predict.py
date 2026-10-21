"""AI 5.0 纯 numpy 离线推理（无 torch 依赖）。

用途：
1. 证明导出 JSON 自足（无训练栈也能推理，任务书 13.1）；
2. 与 TS 推理（inference/policy.mjs）交叉验证导出正确性；
3. 与 torch 前向一致性测试的 Python 侧基准。

只依赖 numpy（随 torch 安装但此处不 import torch）。
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import numpy as np

INTERFACE_VERSION = "ai5-inference-v1"


class NumpyPolicy:
    """从导出 JSON 构建的推理策略（f64 前向）。"""

    def __init__(self, model_json: str | Path | dict):
        if isinstance(model_json, dict):
            parsed = model_json
        else:
            parsed = json.loads(Path(model_json).read_text())
        self.manifest = parsed["manifest"]
        if self.manifest["weightsFormat"] != "base64-f64le-v1":
            raise ValueError(f"权重格式不符：{self.manifest['weightsFormat']}")
        if self.manifest["interfaceVersion"] != INTERFACE_VERSION:
            raise ValueError(f"接口版本不符：{self.manifest['interfaceVersion']}")
        # 权重哈希校验（原始字节级，与 TS 侧同一方案）。
        h = hashlib.sha256()
        self._weights: dict[str, np.ndarray] = {}
        for name in sorted(parsed["weights"]):
            raw = base64.b64decode(parsed["weights"][name])
            h.update(f"{name}:{len(raw)}:".encode())
            h.update(raw)
            shape = self.manifest["shapes"][name]
            self._weights[name] = np.frombuffer(raw, dtype="<f8").reshape(shape).copy()
        if h.hexdigest() != self.manifest["weightsSha256"]:
            raise ValueError("权重哈希校验失败：导出文件被篡改或不完整")
        self.arch = self.manifest["arch"]

    def _linear(self, name: str, x: np.ndarray) -> np.ndarray:
        return self._weights[f"{name}.weight"] @ x + self._weights[f"{name}.bias"]

    def embed_state(self, obs: np.ndarray) -> np.ndarray:
        h = obs.astype(np.float64)
        for i in range(len(self.arch["hidden"])):
            h = np.maximum(self._linear(f"trunk.{i*2}", h), 0.0)
        return h

    def embed_action(self, cand: np.ndarray) -> np.ndarray:
        return np.maximum(self._linear("act_encoder.0", cand.astype(np.float64)), 0.0)

    def logit(self, state_emb: np.ndarray, cand_emb: np.ndarray) -> float:
        joined = np.concatenate([state_emb, cand_emb])
        h = np.maximum(self._linear("act_head.0", joined), 0.0)
        return float(self._linear("act_head.2", h)[0])

    def value(self, state_emb: np.ndarray) -> float:
        h = np.maximum(self._linear("critic.0", state_emb), 0.0)
        return float(self._linear("critic.2", h)[0])

    def policy_scores(self, obs: np.ndarray, cand_mat: np.ndarray) -> np.ndarray:
        """候选矩阵 [n, act_dim] → 概率 [n]。"""
        emb = self.embed_state(obs)
        logits = np.array([self.logit(emb, self.embed_action(row)) for row in cand_mat])
        logits = logits - logits.max()
        p = np.exp(logits)
        return p / p.sum()

    def value_of_obs(self, obs: np.ndarray) -> float:
        return self.value(self.embed_state(obs))
