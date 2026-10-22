"""历史 PPO 训练种子污染审计（P0 可靠性整改：任务 2 第 6/7 项）。

背景：旧 derive_seed 落在 [0, 2^31) 全域。本脚本用保留的旧公式
（collector.derive_seed_legacy）重放全部历史训练运行的逐局种子，与以下
保留区求交集：
  - 验证池区间 [900M, 1.06e9)；
  - 已消费验证块（AI5 arena 账本 + AI4 账本只读核对）；
  - OpenEvolve 评测种子（stage2/stage3/深度验证块）。

输出：ai5/ppo/reports/seed-audit/seed-pollution-audit.json
判定语义：
  - 与「已消费验证块」有交集 → 历史验证报告受污染，需标注并重验；
  - 仅落入验证池区间（未消费块）→ 验证池完整性受损（未来分配可能撞上
    未追踪空洞），历史验证报告不受影响，但必须在报告中披露空洞计数。

运行：~/century-ai5-env/bin/python ai5/ppo/reports/seed-audit/audit_seed_pollution.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))

from ai5.lib.seed_policy import (  # noqa: E402
    OPENEVOLVE_DEEP_VALIDATION_BLOCK, OPENEVOLVE_STAGE2_BLOCK, OPENEVOLVE_STAGE3_BLOCK,
    VALIDATION_POOL_BLOCK,
)
from ai5.ppo.evaluation.arena import load_ai4_ledger_blocks  # noqa: E402
from ai5.ppo.training.collector import derive_seed_legacy  # noqa: E402

REPORTS = REPO / "ai5" / "ppo" / "reports"
AI5_LEDGER = REPORTS / "seed-ledger.json"
OUT_PATH = REPORTS / "seed-audit" / "seed-pollution-audit.json"

# 需要审计的历史训练运行（reports 目录 + 每局种子派生参数）。
RUNS = ["run-main-001", "run-scenB-20it", "smoke-a", "smoke-223043", "smoke-2230xx"]
# 注：RUNS 里不存在的目录自动跳过；smoke-2230xx 之类不存在时忽略。


def consumed_validation_blocks() -> list[tuple[int, int]]:
    """AI5 arena 账本（验证池条目）+ AI4 账本（只读核对）。"""
    blocks: list[tuple[int, int]] = []
    if AI5_LEDGER.exists():
        ledger = json.loads(AI5_LEDGER.read_text())
        for e in ledger.get("history", []):
            if not str(e.get("purpose", "")).startswith("training:"):
                blocks.append((int(e["base"]), int(e.get("size", 0))))
    blocks += load_ai4_ledger_blocks()
    return blocks


def main() -> None:
    val_lo, val_hi = VALIDATION_POOL_BLOCK
    consumed = consumed_validation_blocks()
    oe_eval_seeds: set[int] = set()
    for lo, hi in (OPENEVOLVE_STAGE2_BLOCK, OPENEVOLVE_STAGE3_BLOCK, OPENEVOLVE_DEEP_VALIDATION_BLOCK):
        oe_eval_seeds.update(range(lo, hi))

    runs_out = []
    for run in RUNS:
        cfg_path = REPORTS / run / "config.json"
        if not cfg_path.exists():
            continue
        cfg = json.loads(cfg_path.read_text())
        run_seed = int(cfg["train"]["runSeed"])
        summary_path = REPORTS / run / "summary.json"
        if summary_path.exists():
            games = int(json.loads(summary_path.read_text()).get("totals", {}).get("games", 0))
        else:
            games = 0
        if games <= 0:
            runs_out.append({"run": run, "runSeed": run_seed, "games": 0, "skipped": "无对局记录"})
            continue
        seeds = [derive_seed_legacy(run_seed, i, 0) for i in range(games)]
        in_val_range = sorted({s for s in seeds if val_lo <= s < val_hi})
        hit_consumed = sorted({s for s in seeds for b, size in consumed if b <= s < b + size})
        hit_oe = sorted(set(seeds) & oe_eval_seeds)
        runs_out.append({
            "run": run, "runSeed": run_seed, "games": games,
            "validationRangeHits": in_val_range,
            "validationRangeHitCount": len(in_val_range),
            "consumedValidationBlockHits": hit_consumed,
            "openevolveEvalSeedHits": hit_oe,
        })

    any_consumed_hit = any(r.get("consumedValidationBlockHits") for r in runs_out)
    any_oe_hit = any(r.get("openevolveEvalSeedHits") for r in runs_out)
    audit = {
        "schema": "ai5-ppo-seed-pollution-audit-v1",
        "auditedAt": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
        "method": "derive_seed_legacy 重放历史运行全部逐局种子（collector.py 保留的旧公式）",
        "validationPoolBlock": list(VALIDATION_POOL_BLOCK),
        "consumedValidationBlocks": [list(b) for b in consumed],
        "runs": runs_out,
        "verdict": {
            "consumedValidationBlocksPolluted": any_consumed_hit,
            "openevolveEvalSeedsPolluted": any_oe_hit,
            "validationPoolIntegrityDamaged": any(r.get("validationRangeHitCount") for r in runs_out),
            "action": (
                "历史验证报告需标注并重新分配独立种子验证"
                if any_consumed_hit else
                "历史已消费验证块无碰撞：既有验证报告（arena-run-main-001-validation 等）无需作废；"
                "但训练种子曾落入验证池区间（未消费块），验证池完整性受损——已在本次整改中"
                "将 PPO 训练种子收敛到专用子块 [300.1M, 350M)，该空洞不再扩大"
            ),
        },
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(audit, ensure_ascii=False, indent=2))
    print(json.dumps(audit["verdict"], ensure_ascii=False, indent=2))
    for r in runs_out:
        if "validationRangeHitCount" in r:
            print(f"  {r['run']}: games={r['games']} 验证池区间命中={r['validationRangeHitCount']} "
                  f"已消费块命中={len(r['consumedValidationBlockHits'])} OpenEvolve命中={len(r['openevolveEvalSeedHits'])}")
    if any_consumed_hit:
        raise SystemExit("审计结论：已消费验证块被污染——必须重验历史验证报告")
    print("审计完成：", OUT_PATH)


if __name__ == "__main__":
    main()
