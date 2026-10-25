"""统一跨系统种子治理桥（AI7-A1）：Python 训练系统在动用验证种子前调用。

纪律：
- Python 侧保留自己的账本格式（PPO arena / OpenEvolve 深验），但分配验证池种子
  前必须经 Node 治理层登记：跨系统区间冲突、缺失账本、历史未入账声明统一判定；
- 治理层拒绝（exit 2）时 Python 必须中止分配，不得 fallback 到本地账本自证；
- 训练池（PPO/评测训练区）不受验证池治理约束，但同样禁止与验证池重叠（由
  seed_policy 的区块隔离保证）。

用法（Python）：
    from ai5.lib.seed_governance_bridge import reserve_seed_interval
    reserve_seed_interval("arena", "arena:run-x", base=900002000, size=40,
                          experiment_id="ppo-arena-run-x")
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "training" / "scripts" / "seed-governance-cli.mjs"


def _safe_id(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-")
    return cleaned[:80] or "python-seed"


def reserve_seed_interval(
    purpose_class: str,
    purpose: str,
    *,
    base: int,
    size: int,
    experiment_id: str,
    challenge_index: int | None = None,
    evidence_path: str | None = None,
    root: str | None = None,
) -> dict:
    """经统一治理层登记区间；失败即抛 RuntimeError（fail-closed）。"""
    if not CLI.exists():
        raise RuntimeError(f"种子治理 CLI 缺失：{CLI}——禁止在无治理层状态分配验证种子")
    cmd = [
        "node", str(CLI), "reserve",
        "--purpose-class", purpose_class,
        "--purpose", purpose,
        "--base", str(int(base)),
        "--size", str(int(size)),
        "--experiment-id", _safe_id(experiment_id),
    ]
    if challenge_index is not None:
        cmd += ["--challenge-index", str(int(challenge_index))]
    if evidence_path:
        cmd += ["--evidence", str(evidence_path)]
    if root:
        cmd += ["--root", str(root)]
    proc = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(
            f"种子治理层拒绝登记（fail-closed，rc={proc.returncode}）：{proc.stderr[-800:] or proc.stdout[-800:]}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": True, "raw": proc.stdout}
