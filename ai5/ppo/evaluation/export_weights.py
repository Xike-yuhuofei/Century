"""AI 5.0 权重导出（任务书 13）：torch checkpoint → 自包含 JSON（base64 f64LE 权重）。

设计要点：
- 权重以 base64(f64LE) 原始字节承载：Python/JS 双侧解析逐位一致，
  哈希校验基于原始字节（不依赖任何 JSON 文本序列化格式）；
- 导出物是离线推理的唯一依赖（无 torch、无 Python 训练栈）：
  TS 推理（inference/policy.mjs）与纯 numpy 推理（inference/predict.py）共用；
- manifest 含模型版本、编码版本、接口版本、权重哈希、架构与 git SHA——
  即 OpenEvolve 模型版本接口（任务书 12.3）。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from ai5.ppo.model.actor_critic import ActorCritic  # noqa: E402

INTERFACE_VERSION = "ai5-inference-v1"
WEIGHTS_FORMAT = "base64-f64le-v1"


def _git_sha() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO,
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return "unknown"


def stable_weights_sha(shapes: dict, b64_map: dict) -> str:
    """稳定哈希：按排序键名拼接 name:字节数: + 原始字节（双侧可精确复现）。"""
    h = hashlib.sha256()
    for name in sorted(b64_map):
        raw = base64.b64decode(b64_map[name])
        h.update(f"{name}:{len(raw)}:".encode())
        h.update(raw)
    return h.hexdigest()


def export_checkpoint(checkpoint: Path, out_path: Path) -> dict:
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = ActorCritic(**payload["arch"])
    model.load_state_dict(payload["modelState"])
    model.eval()

    shapes: dict[str, list[int]] = {}
    b64_map: dict[str, str] = {}
    for name, tensor in model.state_dict().items():
        arr = tensor.detach().cpu().numpy().astype("<f8", copy=False)  # f64LE 精确承载 f32
        shapes[name] = list(arr.shape)
        b64_map[name] = base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode()

    weights_sha = stable_weights_sha(shapes, b64_map)
    arch = model.arch_kwargs()
    manifest = {
        "modelVersion": f"ai5-mlp-{'x'.join(map(str, arch['hidden']))}-{weights_sha[:8]}",
        "stateEncodingVersion": "ai5-state-v1",
        "actionEncodingVersion": "ai5-action-v1",
        "interfaceVersion": INTERFACE_VERSION,
        "weightsFormat": WEIGHTS_FORMAT,
        "weightsSha256": weights_sha,
        "shapes": shapes,
        "arch": arch,
        "gitSha": _git_sha(),
        "sourceCheckpoint": str(checkpoint),
        "sourceCheckpointModelHash": payload.get("modelHash"),
        "sourceIteration": payload.get("iteration"),
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"manifest": manifest, "weights": b64_map}))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="AI 5.0 权重导出")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    ckpt = Path(args.checkpoint)
    out = Path(args.out) if args.out else ckpt.parent / "exported-model.json"
    manifest = export_checkpoint(ckpt, out)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"已导出：{out}")


if __name__ == "__main__":
    main()
