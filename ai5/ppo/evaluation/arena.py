"""AI 5.0 独立竞技评估 arena（任务书 14 第三/四阶段）。

纪律约束（不可协商）：
- 独立验证种子来自验证池 [900M, 1.06e9)，块分配走本地账本，且与 AI 4.0
  既有的验证账本（只读核对其 state.json）不重叠——验证种子绝不复用；
- 训练/调参/筛选用过的种子不进入本评估（--seed-pool validation 强制隔离）；
- 评估策略为贪心（argmax）推理，与训练采样的差异如实记录；
- 座位旋转 + 配对种子：同一 seed 在不同座位放置下各赛一局；
- 结论分级：只报告胜率/置信区间，不自动宣称"超越冠军"。

用法：
  python -m ai5.ppo.evaluation.arena --checkpoint ai5/ppo/reports/run-main-001/last.pt \
      --opponents champion,neutral,init --games-per-setup 40 --seed-pool validation \
      --out ai5/ppo/reports/arena-XXXX
"""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))  # noqa: E402

from ai5.ppo.env.vec_env import DecisionRequest, GameResult, SeatSpec, VecEnv  # noqa: E402
from ai5.ppo.model.actor_critic import ActorCritic, resolve_device  # noqa: E402
from ai5.ppo.training.collector import LEARNER_POLICY, PolicyBundle, derive_rng  # noqa: E402
from ai5.lib.seed_policy import (  # noqa: E402
    AI5_EVAL_TRAINING_BLOCK, VALIDATION_POOL_BLOCK,
)

VALIDATION_POOL_BASE, VALIDATION_POOL_MAX = VALIDATION_POOL_BLOCK
VALIDATION_STRIDE = 2_000
TRAINING_POOL_BASE, TRAINING_POOL_MAX = AI5_EVAL_TRAINING_BLOCK
AI4_STATE_PATH = Path("/Volumes/Extreme SSD/Projects/Century/training/reports/evolve-latest/state.json")
AI4_LEDGER_SCAN_DIRS = (  # AI4 验证账本分散持久化目录（测试可替换为临时目录）
    REPO / "training" / "reports",
    REPO / "ai5" / "openevolve" / "experiments" / "reports",
)
LEDGER_PATH = REPO / "ai5" / "ppo" / "reports" / "seed-ledger.json"


def wilson_ci(successes: int, n: int, z: float = 1.959963985) -> tuple[float, float]:
    """Wilson 得分区间（95% 默认）。"""
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def load_ai4_ledger_blocks() -> list[tuple[int, int]]:
    """只读核对 AI 4.0 训练系统的验证账本，返回其已消费 (base, size) 块。

    P0 整改修正：AI4 的验证账本并不在 state.json（该文件无 seedLedger 键），
    而是随挑战报告分散持久化（structure-challenge-*/validation-ledger.json、
    evolve-latest/validation-ledger.json、AI5 正式挑战报告等）。此处按
    validation-ledger.json 全量收集，防止漏计已消费验证块导致防重失效。
    """
    blocks: list[tuple[int, int]] = []
    ledger_files: list[Path] = []
    if AI4_STATE_PATH.exists():
        try:
            state = json.loads(AI4_STATE_PATH.read_text())
            ledger = state.get("seedLedger") or state.get("validationLedger") or {}
            if isinstance(ledger.get("history"), list):
                for entry in ledger["history"]:
                    base = int(entry.get("base", 0))
                    size = int(entry.get("size", VALIDATION_STRIDE))
                    if base >= VALIDATION_POOL_BASE:
                        blocks.append((base, size))
        except Exception as exc:
            print(f"[arena] 警告：AI4 state 账本读取失败（{exc}）")
    for pattern_dir in AI4_LEDGER_SCAN_DIRS:
        if pattern_dir.exists():
            ledger_files.extend(pattern_dir.glob("**/validation-ledger.json"))
    for path in ledger_files:
        try:
            ledger = json.loads(path.read_text())
        except Exception as exc:
            print(f"[arena] 警告：账本 {path.name} 读取失败（{exc}）")
            continue
        for entry in ledger.get("history", []) or []:
            base = entry.get("base")
            if isinstance(base, int) and base >= VALIDATION_POOL_BASE:
                size = entry.get("size")
                blocks.append((base, int(size) if isinstance(size, int) else VALIDATION_STRIDE))
        last_base = ledger.get("lastBase")
        if isinstance(last_base, int) and last_base >= VALIDATION_POOL_BASE:
            blocks.append((last_base, VALIDATION_STRIDE))  # 兜底：旧账本可能只有 lastBase
    return blocks


def _read_ledger() -> dict:
    if LEDGER_PATH.exists():
        return json.loads(LEDGER_PATH.read_text())
    return {"history": [], "lastBase": None}


def _write_ledger(ledger: dict) -> None:
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2))


class _LedgerLock:
    """账本互斥锁（P0 整改：验证池分配原子性）。

    旧实现是裸读-改-写：两个并发进程（如同时跑两个 arena）会读到同一
    highest_end 并分配出重叠块——验证种子被重复消费且难以察觉。
    现以 flock 独占锁包裹「读账本 → 计算起点 → 防重断言 → 写账本」全程，
    锁文件常驻（只锁不删，避免竞态窗口）。
    """

    def __init__(self) -> None:
        LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(LEDGER_PATH.with_suffix(".lock"), "w")

    def __enter__(self) -> "_LedgerLock":
        fcntl.flock(self._fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc) -> None:
        fcntl.flock(self._fh, fcntl.LOCK_UN)
        self._fh.close()


def allocate_validation_block(size: int, purpose: str) -> int:
    """从验证池原子分配互不重叠的种子块；账本持久化（无挑战也落盘续接）。

    只统计验证池条目（AI5 本账本中 purpose 非 training: 的条目 + AI4 账本全部块），
    训练池条目不参与 highest_end 计算——否则验证种子会被拖进训练区。
    并发安全：全程持有 flock；锁内再次执行防重断言。
    """
    with _LedgerLock():
        ledger = _read_ledger()
        validation_entries = [
            (int(e["base"]), int(e.get("size", VALIDATION_STRIDE)))
            for e in ledger.get("history", [])
            if not str(e.get("purpose", "")).startswith("training:")
        ]
        consumed = validation_entries + load_ai4_ledger_blocks()
        highest_end = max((b + s for b, s in consumed), default=VALIDATION_POOL_BASE - VALIDATION_STRIDE)
        base = highest_end + VALIDATION_STRIDE
        if base < VALIDATION_POOL_BASE:
            base = VALIDATION_POOL_BASE
        if base + size > VALIDATION_POOL_MAX:
            raise RuntimeError(f"验证种子池耗尽：下一块 [{base}, {base + size}) 超过上限 {VALIDATION_POOL_MAX}")
        for b, s in consumed:
            if base < b + s and b < base + size:
                raise RuntimeError(f"种子块重叠：[{base},{base+size}) 与 [{b},{b+s})")
        entry = {"base": base, "size": size, "purpose": purpose, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        ledger["history"] = (ledger.get("history", []) + [entry])[-99:]
        ledger["lastBase"] = base
        # challengeCount 只计验证池条目（训练块不是确认挑战，不消耗检验预算）。
        ledger["challengeCount"] = len(validation_entries) + 1
        _write_ledger(ledger)
        return base


def allocate_training_block(size: int, purpose: str) -> int:
    """训练池种子块（AI5 评测约定区 [350M, 400M)，账本记录供审计）。

    P0 整改：下界从 5M 提到 350M——旧约定区 [5M, 900M) 与 AI4 进化区
    [0, 300M)、基准区 [400M, 900M) 仅是簿记重叠；整改后 AI5 评测训练块与
    PPO 训练子块 [300.1M, 350M) 物理隔离，历史条目保留但不作为新起点。
    """
    with _LedgerLock():
        ledger = _read_ledger()
        prev = [e for e in ledger.get("history", []) if str(e.get("purpose", "")).startswith("training:")
                and int(e["base"]) >= TRAINING_POOL_BASE]
        highest_end = max((int(e["base"]) + int(e.get("size", 0)) for e in prev), default=TRAINING_POOL_BASE)
        base = highest_end
        if base + size > TRAINING_POOL_MAX:
            raise RuntimeError("训练种子池段耗尽")
        entry = {"base": base, "size": size, "purpose": f"training:{purpose}", "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        ledger["history"] = (ledger.get("history", []) + [entry])[-99:]
        ledger["lastBase"] = base + size
        _write_ledger(ledger)
        return base


def greedy_decide(bundle: PolicyBundle, requests: list[DecisionRequest],
                  device: torch.device) -> float:
    """按策略归属分组贪心决策（argmax），返回前向耗时 ms。"""
    if not requests:
        return 0.0
    groups: dict[str, list[DecisionRequest]] = {}
    for r in requests:
        groups.setdefault(r.policy_tag, []).append(r)
    t0 = time.perf_counter()
    for policy_id, reqs in groups.items():
        model = bundle.model_for(policy_id)
        obs = torch.from_numpy(np.stack([r.obs for r in reqs])).to(device)
        cand = torch.from_numpy(np.concatenate([r.cand_mat for r in reqs])).to(device)
        seg = torch.from_numpy(np.concatenate(
            [np.full(r.n_candidates, i, dtype=np.int64) for i, r in enumerate(reqs)])).to(device)
        with torch.no_grad():
            logits, _ = model.evaluate(obs, cand, seg)
        logits_cpu = logits.detach().cpu().numpy()
        offset = 0
        for i, r in enumerate(reqs):
            row = logits_cpu[offset:offset + r.n_candidates]
            r.action_index = int(np.argmax(row))
            offset += r.n_candidates
    return (time.perf_counter() - t0) * 1000


def build_layout_for(opponent: str, rotation: int) -> list[SeatSpec]:
    """learner 占据 rotation 号席位，其余席位由指定对手填充。

    对手取值：champion / neutral / random / profile-N / init（未训练 MLP）/ mixed。
    """
    variants = {"mixed": ["champion", "neutral", "profile-1", "profile-3"]}
    layout: list[SeatSpec] = []
    for seat in range(5):
        if seat == rotation % 5:
            layout.append(SeatSpec.mlp(LEARNER_POLICY))
        elif opponent == "init":
            layout.append(SeatSpec.mlp("init"))
        elif opponent == "mixed":
            layout.append(SeatSpec.node(variants["mixed"][seat % 4]))
        else:
            layout.append(SeatSpec.node(opponent))
    return layout


def sampled_decide(bundle: PolicyBundle, requests: list[DecisionRequest],
                   device: torch.device, rng_seed: int, counter: list[int]) -> float:
    """随机采样决策（softmax 采样，确定性派生 rng）。返回前向耗时 ms。

    P1 整改：旧版 --sampled 只切换了 bundle.sample 标志，play_setup 仍无条件
    argmax——采样模式实际从未生效。本函数与训练采集同一采样实现
    （softmax 概率 + numpy choice），rng 由 (rng_seed, 全局决策序号) 确定性派生。
    """
    if not requests:
        return 0.0
    groups: dict[str, list[DecisionRequest]] = {}
    for r in requests:
        groups.setdefault(r.policy_tag, []).append(r)
    t0 = time.perf_counter()
    for policy_id, reqs in groups.items():
        model = bundle.model_for(policy_id)
        obs = torch.from_numpy(np.stack([r.obs for r in reqs])).to(device)
        cand = torch.from_numpy(np.concatenate([r.cand_mat for r in reqs])).to(device)
        seg = torch.from_numpy(np.concatenate(
            [np.full(r.n_candidates, i, dtype=np.int64) for i, r in enumerate(reqs)])).to(device)
        with torch.no_grad():
            logits, _ = model.evaluate(obs, cand, seg)
        logits_cpu = logits.detach().float().cpu().numpy()
        for i, r in enumerate(reqs):
            row = logits_cpu[i * r.n_candidates:(i + 1) * r.n_candidates]
            shifted = row - row.max()
            p = np.exp(shifted)
            p /= p.sum()
            rng = derive_rng(rng_seed, "arena_decision", counter[0])
            counter[0] += 1
            r.action_index = int(rng.choice(r.n_candidates, p=p))
    return (time.perf_counter() - t0) * 1000


def play_setup(env: VecEnv, bundle: PolicyBundle, device: torch.device,
               layout: list[SeatSpec], seeds: list[int], greedy: bool = True,
               sample_seed: int = 0) -> list[dict]:
    """跑一组对局（每 seed 一局），返回逐局记录（P1 整改：不再聚合，
    逐局含 seed/opponent/rotation，供种子聚类统计）。

    同一 seed 在不同旋位下共享洗牌序列——这些对局是相关样本，统计必须按种子
    聚类（见 summarize）。"""
    records: list[dict] = []
    mlp_ms_sum = 0.0
    mlp_ms_count = 0
    pending: dict[int, dict] = {}           # worker → {seed, game_id}
    game_policies: dict[int, list[str]] = {}  # game_id → 席位 policy
    game_ids = 0
    queue_seeds = list(seeds)
    learner_seat = next(i for i, s in enumerate(layout) if s.policy_id == LEARNER_POLICY)
    sample_counter = [0]

    def launch(worker_id: int) -> None:
        nonlocal game_ids
        if worker_id in pending or not queue_seeds:
            return
        seed = queue_seeds.pop(0)
        game_policies[game_ids] = [s.policy_id for s in layout]
        env.start_game(worker_id, game_ids, seed, layout)
        pending[worker_id] = {"seed": seed, "game_id": game_ids}
        game_ids += 1

    for w in range(env.n_workers):
        launch(w)

    while queue_seeds or pending:
        msgs = env.drain(timeout=0.05)
        decisions: list[DecisionRequest] = []
        for msg in msgs:
            if isinstance(msg, DecisionRequest):
                msg.policy_tag = game_policies[msg.game_id][msg.seat]
                decisions.append(msg)
            elif isinstance(msg, GameResult):
                pending.pop(msg.worker_id, None)
                game_policies.pop(msg.game_id, None)
                game_node_ms = 0.0
                game_node_count = 0
                for i, st in enumerate(msg.seat_stats):
                    if st.get("meanDecisionMs") and layout[i].kind == "node":
                        game_node_ms += st["meanDecisionMs"] * st["decisionCount"]
                        game_node_count += st["decisionCount"]
                learner_win = msg.winner_seat == learner_seat
                rank = (msg.ranks.index(learner_seat) + 1) if msg.ranks else 0
                records.append({
                    "seed": msg.seed, "opponent": None, "rotation": None,
                    "status": msg.status, "reason": msg.reason,
                    "winnerSeat": msg.winner_seat, "learnerSeat": learner_seat,
                    "learnerWin": learner_win if msg.status == "finished" else None,
                    "learnerScore": msg.scores[learner_seat] if msg.status == "finished" else None,
                    "learnerRank": rank if msg.status == "finished" else None,
                    "nodeDecisionMs": (game_node_ms / game_node_count) if game_node_count else None,
                })
                launch(msg.worker_id)
        if decisions:
            if greedy:
                dt = greedy_decide(bundle, decisions, device)
            else:
                dt = sampled_decide(bundle, decisions, device, sample_seed, sample_counter)
            for r in decisions:
                env.respond(r.worker_id, r.game_id, r.action_index)
                mlp_ms_sum += dt / len(decisions)
                mlp_ms_count += 1
    for rec in records:
        rec["mlpDecisionMs"] = (mlp_ms_sum / mlp_ms_count) if mlp_ms_count else None
    return records


def run_arena(checkpoint: Path, opponents: list[str], games_per_setup: int, rotations: int,
              seed_pool: str, out_dir: Path, device_str: str, greedy: bool = True) -> dict:
    device = resolve_device(device_str)
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = ActorCritic(**payload["arch"]).to(device)
    model.load_state_dict(payload["modelState"])
    model.eval()

    bundle = PolicyBundle(model, device)
    bundle.sample = not greedy
    # init 对手：未训练 MLP 基线（需另行提供 checkpoint）。
    if "init" in opponents:
        init_path = checkpoint.parent / "init.pt"
        if not init_path.exists():
            raise FileNotFoundError(f"init 对手需要同目录 init.pt：{init_path}")
        init_payload = torch.load(init_path, map_location="cpu", weights_only=False)
        bundle.add_snapshot("init", init_payload["modelState"])

    if seed_pool == "validation":
        base = allocate_validation_block(games_per_setup, f"arena:{checkpoint.parent.name}")
    else:
        base = allocate_training_block(games_per_setup, f"arena:{checkpoint.parent.name}")
    seeds = list(range(base, base + games_per_setup))

    out_dir.mkdir(parents=True, exist_ok=True)
    env = VecEnv(workers=4, seed_salt=777)
    records: list[dict] = []
    try:
        for opponent in opponents:
            for rotation in range(rotations):
                layout = build_layout_for(opponent, rotation)
                setup_records = play_setup(env, bundle, device, layout, seeds, greedy=greedy,
                                           sample_seed=base)
                for rec in setup_records:
                    rec["opponent"] = opponent
                    rec["rotation"] = rotation
                records.extend(setup_records)
                finished = [r for r in setup_records if r["status"] == "finished"]
                wins = sum(1 for r in finished if r["learnerWin"])
                print(f"[arena] {opponent} 旋位{rotation}: 胜率 {wins / max(1, len(finished)):.3f} "
                      f"({wins}/{len(finished)}) 异常 {len(setup_records) - len(finished)}")
    finally:
        env.close()

    summary = summarize(records, checkpoint, seed_pool, seeds, greedy)
    (out_dir / "arena-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    (out_dir / "arena-results.json").write_text(json.dumps(records, ensure_ascii=False, indent=2))
    write_markdown(out_dir / "arena-report.md", summary)
    return summary


def summarize(records: list[dict], checkpoint: Path, seed_pool: str,
              seeds: list[int], greedy: bool) -> dict:
    """汇总统计（P1 整改）：

    - 统计单位 = 独立种子（聚类）：同一 seed 在不同旋位下的对局共享洗牌序列，
      是相关样本；把它们当独立局计算 Wilson 区间会低估方差、放大显著性。
      聚类统计：每 seed 聚合胜率指示（跨旋位均值），再对 seed 层做正态近似区间；
    - 局级 Wilson 区间仅作诊断披露；
    - 异常对局单独统计并影响验收结论（异常率 > 2% → 结论 invalid）。
    """
    by_opp: dict[str, list[dict]] = {}
    for r in records:
        by_opp.setdefault(r["opponent"], []).append(r)
    opp_summary = {}
    for opp, rows in by_opp.items():
        finished = [r for r in rows if r["status"] == "finished"]
        anomalies = len(rows) - len(finished)
        games = len(finished)
        wins = sum(1 for r in finished if r["learnerWin"])
        lo, hi = wilson_ci(wins, games)
        # —— 种子聚类（独立统计单位）——
        seed_groups: dict[int, list[dict]] = {}
        for r in finished:
            seed_groups.setdefault(r["seed"], []).append(r)
        seed_win_rates = [sum(1 for r in g if r["learnerWin"]) / len(g) for g in seed_groups.values()]
        n_clusters = len(seed_groups)
        if n_clusters >= 2:
            cluster_mean = sum(seed_win_rates) / n_clusters
            cluster_var = sum((x - cluster_mean) ** 2 for x in seed_win_rates) / (n_clusters - 1)
            cluster_se = math.sqrt(cluster_var / n_clusters)
            cluster_ci = (max(0.0, cluster_mean - 1.959963985 * cluster_se),
                          min(1.0, cluster_mean + 1.959963985 * cluster_se))
        else:
            cluster_mean, cluster_ci = (wins / games if games else 0.0), (0.0, 1.0)
        anomaly_rate = anomalies / max(1, len(rows))
        opp_summary[opp] = {
            "games": games, "wins": wins, "winRate": wins / max(1, games),
            "wilson95GameLevel": [round(lo, 4), round(hi, 4)],
            "seedClusters": {
                "uniqueSeeds": n_clusters,
                "meanWinRate": round(cluster_mean, 4),
                "normal95": [round(cluster_ci[0], 4), round(cluster_ci[1], 4)],
                "note": "以唯一种子为统计单位（同种子跨旋位对局为相关样本，按 seed 聚类）",
            },
            "meanScore": (sum(r["learnerScore"] for r in finished) / games) if games else None,
            "anomalies": anomalies,
            "anomalyRate": round(anomaly_rate, 4),
            "rankHistogram": {},
            "meanNodeDecisionMs": _mean_of([r["nodeDecisionMs"] for r in finished]),
            "meanMlpDecisionMs": _mean_of([r["mlpDecisionMs"] for r in finished]),
        }
        for r in finished:
            k = str(r["learnerRank"])
            opp_summary[opp]["rankHistogram"][k] = opp_summary[opp]["rankHistogram"].get(k, 0) + 1
        # 验收结论：种子聚类区间 + 异常率门限（异常对局必须影响验收）。
        s = opp_summary[opp]
        if s["anomalyRate"] > 0.02:
            s["verdict"] = "invalid"
            s["verdictReason"] = f"异常率 {s['anomalyRate']} 超过 2% 上限，先修复稳定性再评估"
        elif n_clusters < 30:
            s["verdict"] = "insufficient"
            s["verdictReason"] = f"独立种子 {n_clusters} 不足（最少 30）"
        elif cluster_ci[0] > 0.5:
            s["verdict"] = "better"
            s["verdictReason"] = f"种子聚类胜率 {cluster_mean:.3f}，95% CI 下界 {cluster_ci[0]:.3f} > 0.5"
        elif cluster_ci[1] > 0.5:
            s["verdict"] = "inconclusive"
            s["verdictReason"] = f"种子聚类胜率区间 [{cluster_ci[0]:.3f}, {cluster_ci[1]:.3f}] 跨 0.5，结果不确定"
        else:
            s["verdict"] = "worse"
            s["verdictReason"] = f"种子聚类胜率区间上界 {cluster_ci[1]:.3f} ≤ 0.5，劣于该对手"
    return {
        "checkpoint": str(checkpoint),
        "greedy": greedy,
        "seedPool": seed_pool,
        "seedRange": [seeds[0], seeds[-1]] if seeds else None,
        "uniqueSeedCount": len({r["seed"] for r in records}),
        "opponents": opp_summary,
        "verdict": "本报告只呈现统计事实；是否超越冠军由人工依据置信区间与异常率判定",
    }


def _mean_of(values: list) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def write_markdown(path: Path, summary: dict) -> None:
    lines = [
        "# AI 5.0 独立竞技评估报告", "",
        f"- 检查点：`{summary['checkpoint']}`",
        f"- 策略模式：{'贪心 argmax' if summary['greedy'] else '随机采样'}",
        f"- 种子池：{summary['seedPool']}（范围 {summary['seedRange']}，唯一种子 {summary['uniqueSeedCount']}）", "",
        "| 对手 | 局数 | 唯一种子 | 聚类胜率 | 种子级 95% CI | 局级 Wilson（诊断） | 平均分 | 异常率 | 判定 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for opp, s in summary["opponents"].items():
        c = s["seedClusters"]
        lines.append(
            f"| {opp} | {s['games']} | {c['uniqueSeeds']} | {c['meanWinRate']:.3f} "
            f"| [{c['normal95'][0]:.3f}, {c['normal95'][1]:.3f}] "
            f"| [{s['wilson95GameLevel'][0]:.3f}, {s['wilson95GameLevel'][1]:.3f}] "
            f"| {s['meanScore'] if s['meanScore'] is None else round(s['meanScore'], 1)} "
            f"| {s['anomalyRate']:.3f} | {s['verdict']} |")
    lines += [
        "",
        "> 判读标准：以唯一种子为统计单位（同种子跨旋位对局是相关样本）；",
        "> 种子聚类胜率 95% CI 下界 > 0.5 才具备「优于该对手」的统计证据；",
        "> 异常率 > 2% 时结论标记 invalid；平均分更高不构成结论；本报告不自动宣称超越。",
        "", summary["verdict"],
    ]
    path.write_text("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description="AI 5.0 独立竞技评估")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--opponents", default="champion,neutral,init")
    parser.add_argument("--games-per-setup", type=int, default=40)
    parser.add_argument("--rotations", type=int, default=5)
    parser.add_argument("--seed-pool", choices=["validation", "training"], default="validation")
    parser.add_argument("--out", default=None)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--sampled", action="store_true", help="随机采样策略（默认贪心）")
    args = parser.parse_args()

    out_dir = Path(args.out) if args.out else REPO / "ai5" / "ppo" / "reports" / f"arena-{time.strftime('%Y%m%d-%H%M%S')}"
    summary = run_arena(Path(args.checkpoint), args.opponents.split(","), args.games_per_setup,
                        args.rotations, args.seed_pool, out_dir, args.device, greedy=not args.sampled)
    print(json.dumps(summary["opponents"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
