"""AI5 OpenEvolve 深度独立验证运行器（P0 可靠性整改：种子重复事故后的重建）。

事故与废止（详见 results/audit/deep_validation_v1_invalid/README.md）：
  v1 深度验证的种子文件 101 行全部为 "3.00001e+08"（科学计数法的 300001000），
  旧链路 Number() 静默接受且无重复检测——101 个"独立"配对样本实为 1 个种子，
  报告声称的 100 新种子独立验证结论失真，已废止归档。

本运行器的纪律（全部内建校验，任何一步失败即终止）：
  1. 种子从 OpenEvolve 深度验证块 [300_001_000, 300_002_000) 经账本
     （flock 原子分配）领取，绝不复用历史块；
  2. 种子文件以纯十进制整数逐行写入，读回校验（往返一致 + 唯一性）；
  3. 对战经 macOS Seatbelt 沙箱执行（与评估管线同一 profile）；
  4. duel_runner 侧 seed_policy.parseSeedList 再次强制唯一性（双保险）；
  5. 结果 JSON 显式记录 uniqueSeedCount（真实唯一种子数）与账本条目；
  6. 统计（配对得分优势率、Wilson CI、异常率、判定）由
     training/evaluator/stats.mjs 计算（与 AI 4.0 晋级判定同源），本脚本只
     汇编披露，不另造统计口径。

用法：
  python ai5/openevolve/deep_validation.py --candidate <候选 ai.js 路径> \
      --count 100 --label best
  python ai5/openevolve/deep_validation.py --official --count 100 --label baseline
"""

from __future__ import annotations

import argparse
import fcntl
import json
import subprocess
import sys
import time
from pathlib import Path

AI5_ROOT = Path(__file__).resolve().parent
REPO_ROOT = AI5_ROOT.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from ai5.lib.seed_policy import (  # noqa: E402
    OPENEVOLVE_DEEP_VALIDATION_BLOCK, assert_in_block, generate_unique_seeds,
)

# 复用评估管线的沙箱与目录设施（同一安全边界，不另起炉灶）。
from ai5.openevolve.century_evaluator import (  # noqa: E402
    SANDBOX_ENV, WORK_ROOT, _render_sandbox_profile,
)

LEDGER_PATH = AI5_ROOT / "results" / "deep-validation-ledger.json"
DUEL_RUNNER = AI5_ROOT / "node" / "duel_runner.mjs"

# v1 事故审计：种子文件 101 行同值 300001000，实际唯一种子 1 个。
V1_INVALID_CONSUMED = {"base": 300001000, "size": 1, "purpose": "deep-validation:v1-invalid",
                       "at": "2026-10-21T00:00:00",
                       "note": "v1 深度验证种子重复事故（101 配对全部同种子），结论已废止，"
                               "本条目占位防止该种子被再次分配"}


def _load_ledger() -> dict:
    if LEDGER_PATH.exists():
        return json.loads(LEDGER_PATH.read_text())
    return {"history": [dict(V1_INVALID_CONSUMED)]}


def allocate_deep_validation_seeds(count: int, purpose: str) -> tuple[int, list[int]]:
    """flock 原子分配：从验证块领取 count 个从未消费过的连续种子。"""
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LEDGER_PATH.with_suffix(".lock"), "w") as lock_fh:
        fcntl.flock(lock_fh, fcntl.LOCK_EX)
        try:
            ledger = _load_ledger()
            consumed = [(int(e["base"]), int(e.get("size", 0))) for e in ledger.get("history", [])]
            highest_end = max((b + s for b, s in consumed), default=OPENEVOLVE_DEEP_VALIDATION_BLOCK[0])
            base = max(highest_end, OPENEVOLVE_DEEP_VALIDATION_BLOCK[0])
            # 防重断言（账本历史可能乱序）。
            for b, s in consumed:
                if base < b + s and b < base + count:
                    raise RuntimeError(f"种子块重叠：[{base},{base+count}) 与 [{b},{b+s})——账本状态异常")
            seeds = generate_unique_seeds(count, OPENEVOLVE_DEEP_VALIDATION_BLOCK, base)
            entry = {"base": base, "size": count, "purpose": purpose,
                     "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            ledger["history"] = (ledger.get("history", []) + [entry])[-99:]
            ledger["lastBase"] = base + count
            LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2))
            return base, seeds
        finally:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)


def write_seed_file(path: Path, seeds: list[int]) -> None:
    """纯十进制整数逐行写入 + 读回校验（往返一致 + 唯一）。"""
    text = "\n".join(str(int(s)) for s in seeds) + "\n"
    path.write_text(text)
    roundtrip = [int(line) for line in path.read_text().splitlines() if line.strip()]
    if roundtrip != list(seeds):
        raise RuntimeError("种子文件读回校验失败：往返不一致")
    if len(set(roundtrip)) != len(roundtrip):
        raise RuntimeError("种子文件读回校验失败：存在重复")
    for s in roundtrip:
        assert_in_block(s, OPENEVOLVE_DEEP_VALIDATION_BLOCK)


def run_duel(seed_file: Path, out_json: Path, candidate: str | None, profile: Path) -> dict:
    """沙箱内执行同局双版本对战；候选为 None 时用官方代码（基线对照）。"""
    cmd = ["/usr/bin/sandbox-exec", "-f", str(profile), "node", str(DUEL_RUNNER),
           "--seed-list", str(seed_file), "--out", str(out_json)]
    if candidate:
        cmd += ["--candidate", str(candidate)]
    else:
        cmd += ["--candidate-official"]
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT), env=SANDBOX_ENV,
                          capture_output=True, text=True, timeout=7200)
    if proc.returncode != 0:
        raise RuntimeError(f"duel_runner 失败（rc={proc.returncode}）：{proc.stderr[-800:]}")
    return json.loads(out_json.read_text())


def summarize(label: str, duel: dict, seed_base: int, count: int, ledger_entry: dict,
              seed_file: Path, candidate: str | None, elapsed_s: float) -> dict:
    """汇编披露层：唯一种子数、账本、统计判定（统计本体来自 stats.mjs）。"""
    cfg = duel["config"]
    stats = duel["stats"]
    unique = cfg.get("uniqueSeedCount")
    if unique != count:
        raise RuntimeError(f"唯一种子数不符：期望 {count}，实际 {unique}")
    if len(duel["seedPairs"]) != count:
        raise RuntimeError(f"配对样本数不符：期望 {count}，实际 {len(duel['seedPairs'])}")
    seeds = [p["seed"] for p in duel["seedPairs"]]
    if len(set(seeds)) != len(seeds):
        raise RuntimeError("结果中配对样本种子存在重复（不应发生，duel_runner 已强制）")
    return {
        "label": label,
        "schema": "ai5-openevolve-deep-validation-v2",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "candidate": candidate or "official-baseline",
        "seedLedgerEntry": ledger_entry,
        "seedFile": str(seed_file.relative_to(REPO_ROOT)) if seed_file.is_relative_to(REPO_ROOT) else str(seed_file),
        "uniqueSeedCount": unique,
        "seedBase": seed_base,
        "seedCount": count,
        "seedBlock": list(OPENEVOLVE_DEEP_VALIDATION_BLOCK),
        "elapsedS": round(elapsed_s, 1),
        "stats": stats,
        "games": duel["games"],
        "seedPairs": duel["seedPairs"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenEvolve 深度独立验证（v2，种子唯一性强校验）")
    parser.add_argument("--candidate", default=None, help="候选 ai.js 路径（默认官方基线）")
    parser.add_argument("--official", action="store_true", help="仅跑官方代码对照基线")
    parser.add_argument("--with-baseline", action="store_true",
                        help="同一种子块同时跑官方基线对照（候选+基线共用种子，公平性核验）")
    parser.add_argument("--count", type=int, default=100, help="唯一种子（配对样本）数")
    parser.add_argument("--label", required=True, help="结果标签（如 best / baseline）")
    parser.add_argument("--out", default=None, help="输出 JSON 路径（默认 results/deep_validation_v2_<label>.json）")
    args = parser.parse_args()
    if not args.candidate and not args.official:
        parser.error("必须提供 --candidate 或 --official")

    count = args.count
    candidate = str(Path(args.candidate).resolve()) if args.candidate else None
    out_path = Path(args.out) if args.out else AI5_ROOT / "results" / f"deep_validation_v2_{args.label}.json"

    seed_base, seeds = allocate_deep_validation_seeds(count, f"deep-validation:v2:{args.label}")
    print(f"[deep-validation] 账本分配种子块 [{seed_base}, {seed_base + count})（{count} 个唯一种子）")

    profile = _render_sandbox_profile()
    seed_file = WORK_ROOT / f"deep-seeds-v2-{args.label}.txt"
    write_seed_file(seed_file, seeds)
    print(f"[deep-validation] 种子文件 {seed_file} 写入并读回校验通过")

    entry = {"base": seed_base, "size": count, "purpose": f"deep-validation:v2:{args.label}"}
    t0 = time.perf_counter()
    raw_json = WORK_ROOT / f"deep-validation-v2-{args.label}.json"
    duel = run_duel(seed_file, raw_json, None if args.official else candidate, profile)
    elapsed = time.perf_counter() - t0
    result = summarize(args.label, duel, seed_base, count, entry, seed_file,
                       None if args.official else candidate, elapsed)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"[deep-validation] 完成：{out_path}")
    print(json.dumps(_brief(result), ensure_ascii=False, indent=2))

    if args.with_baseline:
        if args.official:
            parser.error("--with-baseline 不能与 --official 同用")
        base_out = out_path.with_name(out_path.stem + "_baseline.json")
        t0 = time.perf_counter()
        raw_base = WORK_ROOT / f"deep-validation-v2-{args.label}-baseline.json"
        duel_base = run_duel(seed_file, raw_base, None, profile)
        elapsed_base = time.perf_counter() - t0
        result_base = summarize(args.label + "-baseline", duel_base, seed_base, count, entry,
                                seed_file, None, elapsed_base)
        base_out.write_text(json.dumps(result_base, ensure_ascii=False, indent=2))
        print(f"[deep-validation] 基线对照完成：{base_out}")
        print(json.dumps(_brief(result_base), ensure_ascii=False, indent=2))


def _brief(result: dict) -> dict:
    stats = result["stats"]
    paired = stats.get("paired") or {}
    return {
        "uniqueSeedCount": result["uniqueSeedCount"],
        "games": stats.get("totalGames"),
        "anomalyGames": stats.get("anomalyGames"),
        "meanScoreDiffPerSeed": stats.get("meanScoreDiffPerSeed"),
        "pairedVerdict": paired.get("verdict"),
        "scoreAdvantageRate": paired.get("scoreAdvantageRate"),
        "ci": paired.get("ci"),
        "elapsedS": result["elapsedS"],
    }


if __name__ == "__main__":
    main()
