# Century AI5 评估适配器：OpenEvolve ↔ Node 评估管线（Python ↔ Node 接口）。
#
# OpenEvolve 级联契约（openevolve/evaluator.py::_cascade_evaluate）：
#   evaluate_stage1(program_path) → metrics；combined_score < thresholds[0] 则淘汰
#   evaluate_stage2(program_path) → metrics；combined_score < thresholds[1] 则淘汰
#   evaluate_stage3(program_path) → metrics（终评）
#
# 级联设计与 M4 资源预算（16GB，无 PPO 训练）：
#   stage1（廉价、确定性）：静态安全检查 → 候选源码树组装 → 沙箱内 tsc 编译 →
#                          沙箱内单元探针（确定性输入上的行为采样）
#   stage2（少量对战）：   沙箱内配对对战 16 种子 × 2 局 = 32 局
#   stage3（独立充分对战）：沙箱内配对对战 48 种子 × 2 局 = 96 局（种子与 stage2 隔离）
#
# 安全模型（详见 README）：
#   - OpenEvolve 生成的代码一律视为不可信；所有执行（编译/探针/对战）都通过
#     macOS Seatbelt（sandbox-exec）沙箱：禁网、禁读用户主目录、只允许写工作区；
#   - 子进程环境变量白名单（无任何密钥），HOME 指向空工作目录；
#   - 静态检查先行（禁 import/eval/隐藏牌库/随机数/时钟），超时/异常/违例直接淘汰。
#
# 本适配器不读取、不缓存、不转发任何候选代码产生的返回值作为成绩 —— 成绩只能
# 由评估管线从对局结果计算（候选无法自报分数）。

import json
import os
import shutil
import subprocess
import sys
import hashlib
from pathlib import Path

AI5_ROOT = Path(__file__).resolve().parent
REPO_ROOT = AI5_ROOT.parent.parent
NODE_DIR = AI5_ROOT / "node"
SANDBOX_TEMPLATE = AI5_ROOT / "sandbox" / "candidate.sb.tmpl"
WORK_ROOT = AI5_ROOT / "work"
CACHE_ROOT = WORK_ROOT / "cache"
RESULTS_ROOT = AI5_ROOT / "results" / "evaluations"

# AI5 种子纪律：只用训练池 [300M, 400M) 的 AI5 专用子块；与 AI 4.0 日常进化
# [0, 300M)、基准评测 [400M, 900M)、验证池 [900M, 1.06e9) 物理隔离，绝不触碰
# 冠军验证账本（lib/seeds.mjs 管理的 900M 块）。
STAGE2_SEEDS = list(range(300_000_000, 300_000_016))   # 16 种子（快筛）
STAGE3_SEEDS = list(range(300_000_100, 300_000_148))   # 48 种子（深评）

SANDBOX_ENV = {
    # PATH 必须包含当前 node 的目录：GitHub macOS Runner 的 node 在
    # /opt/hostedtoolcache/...，硬编码 /usr/local/bin 会让沙箱内 execvp(node) 失败
    # （CI 首跑实测暴露）。shutil.which 解析符号链接后取真实目录。
    "PATH": f"{os.path.dirname(os.path.realpath(shutil.which('node') or '/usr/local/bin/node'))}:/usr/bin:/bin",
    "HOME": str(WORK_ROOT / "home"),
    "TMPDIR": str(WORK_ROOT / "tmp"),
    "LANG": "en_US.UTF-8",
}

_STAGE_TIMEOUT = {1: 180, 2: 420, 3: 1200}


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
    """沙箱内执行一个命令；超时按失败处理（返回 returncode=-9 + 标记）。

    默认 cwd 用 WORK_ROOT：GitHub Runner 的检出在 HOME 内，沙箱拒绝读 HOME
    时 node 启动的 uv_cwd 会 EPERM（CI 实测）；所有沙箱化命令均用绝对路径，
    不依赖仓库根 cwd。"""
    try:
        return subprocess.run(
            cmd, cwd=str(cwd or WORK_ROOT), env=SANDBOX_ENV,
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        class _TimedOut:  # 结构化超时结果，调用方按非零返回码处理
            returncode = -9
            stdout = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            stderr = f"TIMEOUT after {timeout}s: {log_name}"
        return _TimedOut()


def _fail(stage, reason, **extra):
    return {
        "combined_score": 0.0,
        "stage_passed": 0.0,
        "failure_stage": stage,
        "failure_reason": reason[:500],
        **extra,
    }


def _function_text(program_path: str) -> str | None:
    """OpenEvolve 传入的是整个演化文件（含 EVOLVE-BLOCK 与说明注释）。
    静态检查通过后，函数文本由 static_check 单独落盘（*.fn.ts）。"""
    fn_file = Path(program_path + ".fn")
    return fn_file.read_text() if fn_file.exists() else None


def _run_static(program_path: str, profile: Path):
    out_json = WORK_ROOT / "static-check.json"
    # P0 安全整改：静态检查处理不可信源码文本，同样在 Seatbelt 内执行
    # （此前只有 probe/duel 沙箱化，与注释声称的"所有阶段沙箱"不符）。
    cmd = ["/usr/bin/sandbox-exec", "-f", str(profile), "node",
           str(NODE_DIR / "static_check.mjs"), "--program", str(program_path), "--out", str(out_json)]
    proc = _run(cmd, 60, "static")
    return proc.returncode == 0, out_json, proc


def _stage_impl(program_path: str, stage: int) -> dict:
    _ensure_dirs()
    program_path = str(Path(program_path).resolve())  # 子进程 cwd 是仓库根，统一绝对路径
    profile = _render_sandbox_profile()

    # ---------- stage 1：静态检查 → 组装 → 编译 → 探针 ----------
    ok, static_json, proc = _run_static(program_path, profile)
    if not ok:
        detail = {}
        try:
            detail = json.loads(static_json.read_text())
        except Exception:
            detail = {"stderr": proc.stderr[-400:], "stdout": proc.stdout[-400:]}
        # stderr/stdout 透出：沙箱环境差异（如 Runner 检出在 HOME 内）曾让静态
        # 检查整体失败但原因被吞掉，无法诊断（CI 实测教训）。
        return _fail("static", detail.get("reason") or detail.get("stderr")
                     or detail.get("stdout") or "static check failed")

    fn_text_file = Path(str(static_json).replace(".json", ".fn.ts"))
    fn_text = fn_text_file.read_text()
    fn_sha = hashlib.sha256(fn_text.encode()).hexdigest()
    complexity = len(fn_text)

    workdir = CACHE_ROOT / fn_sha
    asm_json = WORK_ROOT / "assemble.json"
    # P0 安全整改：候选树组装（复制不可信源码）同样沙箱化。
    asm = _run(["/usr/bin/sandbox-exec", "-f", str(profile), "node",
                str(NODE_DIR / "assemble_candidate.mjs"),
                "--program", str(fn_text_file), "--out", str(workdir)], 60, "assemble")
    if asm.returncode != 0:
        return _fail("assemble", asm.stderr[-400:])
    # 静态检查产物与组装记录归档（审计）。
    asm_json.write_text(asm.stdout)

    candidate_ai = workdir / "dist" / "js" / "ai.js"
    if not candidate_ai.exists():
        # P0 安全整改：tsc 编译不可信代码是本管线最靠前的执行型步骤，
        # 必须沙箱化（禁网、禁读主目录、只允许写工作区）。
        tsc = _run(["/usr/bin/sandbox-exec", "-f", str(profile),
                    "node", str(REPO_ROOT / "web-v1/node_modules/typescript/bin/tsc"),
                    "-p", str(workdir / "tsconfig.json")], 120, "tsc", cwd=workdir)
        if tsc.returncode != 0:
            return _fail("compile", tsc.stderr[-800:] or tsc.stdout[-400:], compile_stderr=tsc.stderr[-400:])
    if not candidate_ai.exists():
        return _fail("compile", "tsc 成功但未产出 dist/js/ai.js")

    probe_json = WORK_ROOT / "probe.json"
    probe = _run(["/usr/bin/sandbox-exec", "-f", str(profile), "node",
                  str(NODE_DIR / "probe.mjs"), "--candidate", str(workdir / "dist/js/ai/evaluator.js"),
                  "--out", str(probe_json)], 120, "probe")
    if probe.returncode != 0:
        return _fail("probe", probe.stderr[-400:] or "probe failed")
    probe_result = json.loads(probe_json.read_text())

    stage1_metrics = {
        "combined_score": 1.0,
        "stage_passed": 1.0,
        "static_ok": 1.0,
        "compile_ok": 1.0,
        "probe_ok": 1.0,
        "identical_to_official": 1.0 if probe_result["identicalToOfficial"] else 0.0,
        "function_sha256_head": float(int(fn_sha[:8], 16) / 0xFFFFFFFF),
        "code_complexity": float(complexity),
    }
    if stage == 1:
        return stage1_metrics

    # ---------- stage 2 / 3：沙箱内配对对战 ----------
    seeds = STAGE2_SEEDS if stage == 2 else STAGE3_SEEDS
    seed_list = WORK_ROOT / f"seeds-stage{stage}.txt"
    seed_list.write_text("\n".join(map(str, seeds)))
    result_json = WORK_ROOT / f"duel-stage{stage}.json"
    duel = _run(["/usr/bin/sandbox-exec", "-f", str(profile), "node",
                 str(NODE_DIR / "duel_runner.mjs"),
                 "--candidate", str(candidate_ai),
                 "--seed-list", str(seed_list),
                 "--out", str(result_json)], _STAGE_TIMEOUT[stage], "duel")
    if duel.returncode != 0:
        return _fail("duel", duel.stderr[-400:] or f"duel stage{stage} failed")
    duel_result = json.loads(result_json.read_text())
    stats = duel_result["stats"]

    # 归档每次评估的完整证据（逐候选可审计）。
    eval_dir = RESULTS_ROOT / fn_sha[:12]
    eval_dir.mkdir(parents=True, exist_ok=True)
    (eval_dir / f"stage{stage}.json").write_text(json.dumps(duel_result, ensure_ascii=False, indent=2))
    (eval_dir / "manifest.json").write_text((workdir / "manifest.json").read_text())

    anomaly_rate = stats.get("anomalyRate", 1.0)
    # 配对得分优势率：从 seedPairs 直接计算决定性种子的胜率；
    # pairedPromotionDecision 的 scoreAdvantageRate 在 insufficient 判定下缺失，
    # 这里独立计算（无决定性种子 → 中性 0.5，不误判为劣势）。
    seed_pairs = duel_result.get("seedPairs", [])
    decisive = [p for p in seed_pairs if p.get("status") == "finished" and p.get("diff", 0) != 0]
    adv_rate = (sum(1 for p in decisive if p["diff"] > 0) / len(decisive)) if decisive else 0.5
    mean_diff = stats.get("meanScoreDiffPerSeed") or 0.0
    p95 = stats.get("p95DecisionMs") or 0.0
    latency_excess = min(1.0, max(0.0, (p95 - 150.0) / 150.0))
    complexity_excess = min(1.0, max(0.0, complexity / 3000.0 - 1.0))

    # combined_score：配对得分优势（主）+ 配对胜率差（辅）- 稳定性/延迟/复杂度惩罚。
    # 平局基线（与官方逐位一致）≈ 0.5；ties 由 pairedPromotionDecision 的 decisive 口径排除。
    combined = (
        0.5
        + 0.30 * _tanh(mean_diff / 8.0)
        + 0.20 * (adv_rate - 0.5) * 2.0
        - 1.5 * anomaly_rate
        - 0.10 * latency_excess
        - 0.05 * complexity_excess
    )

    return {
        "combined_score": round(combined, 4),
        "stage_passed": 1.0,
        "games": float(stats.get("totalGames", 0)),
        "anomaly_rate": float(anomaly_rate),
        "paired_win_rate": float(adv_rate),
        "mean_score_diff_per_seed": float(mean_diff),
        "first_place_rate": float((stats.get("firstPlace") or {}).get("merged", {}).get("rate", 0.0) or 0.0),
        "p95_decision_ms": float(p95),
        "mean_decision_ms": float(stats.get("meanDecisionMs") or 0.0),
        "code_complexity": float(complexity),
        "function_sha256_head": float(int(fn_sha[:8], 16) / 0xFFFFFFFF),
        "seed_block": 300.0,  # 百万计（披露用）
    }


def _tanh(x: float) -> float:
    import math
    return math.tanh(x)


def evaluate(program_path: str, cascade_thresholds=None):
    """全管线单入口（独立实验/回归用）：依次执行三个阶段，返回终评指标。"""
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
    # 手动测试入口：python century_evaluator.py <program_path> [stage]
    path = sys.argv[1]
    stage = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    result = _stage_impl(path, stage) if stage else evaluate(path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
