#!/usr/bin/env python3
"""AI5 实验证据整编：从 OpenEvolve checkpoint 与评估存档生成可审计的候选索引。

产出：
- results/smoke-candidates/          冒烟 3 迭代的候选函数全文 + 指标
- results/controlled-candidates/     受控 10 迭代的候选函数全文 + 指标
- 各候选与 results/evaluations/<sha12>/ 的证据目录互相引用（SHA256 互证）

用法：python3 curate_candidates.py <openevolve-output-dir> <dest-dir>
"""
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

AI5 = Path(__file__).resolve().parent
EV_DIR = AI5 / "results" / "evaluations"


def fn_sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def extract_block(program_ts: str) -> str | None:
    m = re.search(r"/\*\s*EVOLVE-BLOCK-START\s*\*/(.*?)/\*\s*EVOLVE-BLOCK-END\s*\*/", program_ts, re.S)
    return m.group(1).strip() if m else None


def main(src: str, dest: str) -> None:
    src, dest = Path(src), Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    index = []
    seen = set()
    # 收集 checkpoint 内全部程序 + 最终 best（可能晚于最后一个 checkpoint）。
    program_files = list(src.glob("checkpoints/checkpoint_*/programs/*.json"))
    best_ts = src / "best" / "best_program.ts"
    best_info = src / "best" / "best_program_info.json"
    synthetic_best = None
    if best_ts.exists():
        best = json.loads(best_info.read_text()) if best_info.exists() else {}
        synthetic_best = {
            "id": best.get("id", "best"),
            "code": best_ts.read_text(),
            "changes_description": best.get("changes_description"),
            "metrics": best.get("metrics", {}),
            "parent_id": best.get("parent_id"),
            "generation": best.get("generation"),
            "iteration_found": best.get("iteration"),
        }
    parsed = [json.loads(p.read_text()) for p in program_files]
    if synthetic_best and not any(p.get("id") == synthetic_best["id"] for p in parsed):
        parsed.append(synthetic_best)
    for prog in parsed:
        code = prog.get("code") or ""
        block = extract_block(code)
        if not block or "acquisitionValue" not in block:
            continue
        sha = fn_sha(block)
        metrics = {k: prog.get("metrics", {}).get(k) for k in (
            "combined_score", "paired_win_rate", "mean_score_diff_per_seed",
            "code_complexity", "anomaly_rate", "games", "p95_decision_ms")}
        entry = {
            "id": prog.get("id"),
            "iteration": prog.get("iteration_found") or prog.get("generation"),
            "parent_id": prog.get("parent_id"),
            "sha256": sha,
            "metrics": metrics,
            "code_length": len(code),
            "changes_description": prog.get("changes_description"),
        }
        # 函数全文落盘（与 evaluations/<sha12>/ 证据互证）
        out = dest / f"iter{prog.get('iteration', 'x')}-{sha[:12]}.fn.ts"
        out.write_text(block)
        ev = EV_DIR / sha[:12]
        entry["evidence_dir"] = str(ev.relative_to(AI5)) if ev.exists() else None
        index.append(entry)
    index.sort(key=lambda e: (e.get("iteration") or 0, e.get("metrics", {}).get("combined_score") or 0))
    (dest / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2))
    print(f"{len(index)} candidates → {dest}")
    for e in index:
        print(f"  iter{e.get('iteration')}: score={e['metrics'].get('combined_score')} sha={e['sha256'][:12]} evidence={e['evidence_dir']}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
