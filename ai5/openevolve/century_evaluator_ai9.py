# Century AI 9.0 多模块 OpenEvolve 评估适配器（Python ↔ Node）。
#
# 与 AI5 单函数评估器的区别：
#   - 一个程序可包含多个 EVOLVE-BLOCK（每个 = 一个注册模块函数）；
#   - 静态检查/组装/编译/探针全部走 ai5/openevolve/node/*.mjs 多模块管线；
#   - stage2/3 在真实 2–5 人对局中用候选的独立 ESM 决策包控制焦点席位，
#     与冻结冠军同一座位配对比较；主指标 = 焦点席位第一名率增量。
#
# 安全模型（与 AI5 同口径）：
#   - OpenEvolve 生成代码一律视为不可信；所有执行在 macOS Seatbelt 内；
#   - 禁网、禁读用户主目录、只允许写工作区；
#   - 静态检查先行；超时/异常/违例直接淘汰；
#   - 评估器不采信候选自报结果，成绩只由真实对局/探针计算。
#
# 种子纪律：
#   - 研究评估只使用 AI9 专用研究块 [1.650e9, 1.651e9) 的子块；
#   - stage2 16 种子（每人 4）、stage3 48 种子（每人 12），互不重叠；
#   - 正式验证池 [900M, 1.06e9) 与本评估器零接触。

import json
import os
import shutil
import subprocess
import sys
import hashlib
from pathlib import Path

AI9_ROOT = Path(__file__).resolve().parent
REPO_ROOT = AI9_ROOT.parent.parent
NODE_DIR = AI9_ROOT / "node"
SANDBOX_TEMPLATE = AI9_ROOT / "sandbox" / "candidate.sb.tmpl"
WORK_ROOT = AI9_ROOT / "work-ai9"
CACHE_ROOT = WORK_ROOT / "cache"
RESULTS_ROOT = AI9_ROOT / "results" / "ai9-evaluations"

STAGE2_SEEDS = list(range(1_650_000_000, 1_650_000_016))   # 16 种子（每人 4）
STAGE3_SEEDS = list(range(1_650_000_100, 1_650_000_148))   # 48 种子（每人 12）
PLAYER_COUNTS = [2, 3, 4, 5]
FORMAL_WORK_UNITS = 32

SANDBOX_ENV = {
    "PATH": f"{os.path.dirname(os.path.realpath(shutil.which('node') or '/usr/local/bin/node'))}:/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME": str(WORK_ROOT / "home"),
    "TMPDIR": str(WORK_ROOT / "tmp"),
    "LANG": "en_US.UTF-8",
}

_STAGE_TIMEOUT = {1: 300, 2: 2400, 3: 5400}


def _ensure_dirs():
    for p in (WORK_ROOT, CACHE_ROOT, RESULTS_ROOT, WORK_ROOT / "home", WORK_ROOT / "tmp"):
        p.mkdir(parents=True, exist_ok=True)


def _render_sandbox_profile() -> Path:
    profile = (SANDBOX_TEMPLATE.read_text()
               .replace("@WORKROOT@", str(WORK_ROOT))
               .replace("@REPOROOT@", str(REPO_ROOT))
               .replace("@HOME@", str(Path.home())))
    out = WORK_ROOT / "sandbox-rendered.sb"
    out.write_text(profile)
    return out


def _run(cmd, timeout, log_name, cwd=None):
    try:
        return subprocess.run(
            cmd, cwd=str(cwd or WORK_ROOT), env=SANDBOX_ENV,
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        class _TimedOut:
            returncode = -9
            stdout = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            stderr = f"TIMEOUT after {timeout}s: {log_name}"
        return _TimedOut()


def _fail(stage, reason, **extra):
    return {
        "combined_score": 0.0,
        "stage_passed": 0.0,
        "failure_stage": stage,
        "failure_reason": str(reason)[:800],
        **extra,
    }


def _stage_impl(program_path: str, stage: int) -> dict:
    _ensure_dirs()
    program_path = str(Path(program_path).resolve())
    profile = _render_sandbox_profile()

    # ---------- stage 1：静态检查 → 组装 → 编译 → 多模块行为探针 ----------
    static_json = WORK_ROOT / "static-ai9.json"
    static = _run([
        "/usr/bin/sandbox-exec", "-f", str(profile), "node",
        str(NODE_DIR / "static_check_modules.mjs"),
        "--program", str(program_path), "--out", str(static_json),
    ], 90, "static-ai9")
    if static.returncode != 0:
        detail = {}
        try:
            detail = json.loads(static_json.read_text())
        except Exception:
            pass
        return _fail("static", detail.get("reason") or static.stderr[-800:] or static.stdout[-400:])
    static_result = json.loads(static_json.read_text())
    modules = static_result["modules"]
    module_ids = [m["id"] for m in modules]
    combined_hash = static_result["combinedSha256"]

    workdir = CACHE_ROOT / combined_hash[:24]
    asm = _run([
        "/usr/bin/sandbox-exec", "-f", str(profile), "node",
        str(NODE_DIR / "assemble_modules.mjs"),
        "--manifest", str(static_json), "--out", str(workdir),
    ], 120, "assemble-ai9")
    if asm.returncode != 0:
        return _fail("assemble", asm.stderr[-800:] or asm.stdout[-400:])

    dist_ai = workdir / "dist" / "js" / "ai.js"
    if not dist_ai.exists():
        (workdir / "package.json").write_text(json.dumps({"type": "module"}))
        tsc = _run([
            "/usr/bin/sandbox-exec", "-f", str(profile), "node",
            str(REPO_ROOT / "web-v1/node_modules/typescript/bin/tsc"),
            "-p", str(workdir / "tsconfig.json"),
        ], 240, "tsc-ai9", cwd=workdir)
        if tsc.returncode != 0:
            return _fail("compile", tsc.stderr[-1200:] or tsc.stdout[-800:], compile_stderr=tsc.stderr[-400:])
    if not dist_ai.exists():
        return _fail("compile", "tsc 成功但未产出 dist/js/ai.js")

    probe_json = WORK_ROOT / "probe-ai9.json"
    probe = _run([
        "/usr/bin/sandbox-exec", "-f", str(profile), "node",
        str(NODE_DIR / "ai9_probe.mjs"),
        "--candidate", str(workdir / "dist/js"),
        "--modules", ",".join(module_ids),
        "--out", str(probe_json),
    ], 180, "probe-ai9")
    if probe.returncode != 0:
        detail = {}
        try:
            detail = json.loads(probe_json.read_text())
        except Exception:
            pass
        return _fail("probe", detail.get("probeErrors") or probe.stderr[-600:] or "probe failed")

    probe_result = json.loads(probe_json.read_text())
    total_source = sum(int(m.get("textLength") or 0) for m in modules)
    stage1_metrics = {
        "combined_score": 1.0,
        "stage_passed": 1.0,
        "static_ok": 1.0,
        "compile_ok": 1.0,
        "probe_ok": 1.0,
        "module_count": float(len(modules)),
        "changed_module_count": float(len(probe_result.get("changedModules") or [])),
        "identical_to_official": 1.0 if probe_result.get("identicalToOfficial") else 0.0,
        "module_mismatches": float(probe_result.get("mismatchCount") or 0),
        "code_complexity": float(total_source),
        "combined_module_hash_head": float(int(combined_hash[:8], 16) / 0xFFFFFFFF),
    }
    if stage == 1:
        return stage1_metrics

    # ---------- stage 2/3：沙箱内真实 2–5 人对局 ----------
    seeds = STAGE2_SEEDS if stage == 2 else STAGE3_SEEDS
    seed_list = WORK_ROOT / f"seeds-ai9-stage{stage}.txt"
    seed_list.write_text("\n".join(map(str, seeds)))
    result_json = WORK_ROOT / f"duel-ai9-stage{stage}.json"
    duel = _run([
        "/usr/bin/sandbox-exec", "-f", str(profile), "node",
        str(NODE_DIR / "ai9_duel_runner.mjs"),
        "--candidate", str(workdir / "dist/js"),
        "--seed-list", str(seed_list),
        "--player-counts", ",".join(map(str, PLAYER_COUNTS)),
        "--work-units", str(FORMAL_WORK_UNITS),
        "--mode", "screen" if stage == 2 else "deep",
        "--out", str(result_json),
    ], _STAGE_TIMEOUT[stage], f"duel-ai9-stage{stage}")
    if duel.returncode != 0:
        return _fail("duel", duel.stderr[-800:] or f"duel stage{stage} failed")
    duel_result = json.loads(result_json.read_text())
    stats = duel_result["stats"]

    eval_dir = RESULTS_ROOT / combined_hash[:12]
    eval_dir.mkdir(parents=True, exist_ok=True)
    (eval_dir / f"stage{stage}.json").write_text(json.dumps(duel_result, ensure_ascii=False, indent=2))
    (eval_dir / "modules.json").write_text(json.dumps(static_result, ensure_ascii=False, indent=2))
    (eval_dir / "probe.json").write_text(json.dumps(probe_result, ensure_ascii=False, indent=2))

    anomaly_rate = stats.get("anomalyRate", 1.0)
    delta = (stats.get("firstPlaceDelta") or {}).get("ci")
    delta_mean = float(delta["mean"]) if delta else None
    p95_wall = stats.get("p95WallMs") or 0.0
    # 延迟约束按「单次决策平均耗时」判定（本地推理预算），整局墙钟只作诊断。
    mean_decision = stats.get("meanDecisionMs") or 0.0
    latency_excess = min(1.0, max(0.0, (mean_decision - 300.0) / 300.0))
    complexity_excess = min(1.0, max(0.0, total_source / 12000.0 - 1.0))

    if delta_mean is not None:
        combined = (
            0.5
            + 0.5 * delta_mean
            - 1.5 * anomaly_rate
            - 0.10 * latency_excess
            - 0.05 * complexity_excess
        )
    else:
        combined = 0.0
    # 行为与官方完全一致 = 没有进化增量：只做诊断，不消耗 stage3 的 96 局深评。
    if probe_result.get("identicalToOfficial"):
        combined = 0.0

    return {
        "combined_score": round(combined, 4),
        "stage_passed": 1.0,
        "primary_metric": "pairedFirstPlaceRateDelta",
        "module_count": float(len(modules)),
        "changed_module_count": float(len(probe_result.get("changedModules") or [])),
        "first_place_delta": float(delta_mean) if delta_mean is not None else 0.0,
        "first_place_ci_lower": float(delta["lower"]) if delta else 0.0,
        "candidate_first_rate": float(stats.get("candidateFirstRate") or 0.0),
        "champion_first_rate": float(stats.get("championFirstRate") or 0.0),
        "games": float(stats.get("totalGames", 0)),
        "anomaly_rate": float(anomaly_rate),
        "p95_wall_ms": float(p95_wall),
        "mean_decision_ms": float(mean_decision),
        "code_complexity": float(total_source),
        "pooled_module_hash_head": float(int(combined_hash[:8], 16) / 0xFFFFFFFF),
        "seed_block": 1650.0,
        "by_player_count": json.dumps((stats.get("firstPlaceDelta") or {}).get("byPlayerCount") or {}, ensure_ascii=False),
    }


def evaluate(program_path: str, cascade_thresholds=None):
    for stage in (1, 2, 3):
        metrics = _stage_impl(program_path, stage)
        if metrics.get("stage_passed") != 1.0:
            return metrics
        if cascade_thresholds and stage < 3 and metrics["combined_score"] < cascade_thresholds[stage - 1]:
            return metrics
    return metrics


def evaluate_stage1(program_path: str):
    return _stage_impl(program_path, 1)


def evaluate_stage2(program_path: str):
    return _stage_impl(program_path, 2)


def evaluate_stage3(program_path: str):
    return _stage_impl(program_path, 3)


if __name__ == "__main__":
    path = sys.argv[1]
    stage = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    result = _stage_impl(path, stage) if stage else evaluate(path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
