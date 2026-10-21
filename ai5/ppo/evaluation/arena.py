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
from ai5.ppo.training.collector import LEARNER_POLICY, PolicyBundle  # noqa: E402

VALIDATION_POOL_BASE = 900_000_000
VALIDATION_STRIDE = 2_000
VALIDATION_POOL_MAX = VALIDATION_POOL_BASE + 80_000 * VALIDATION_STRIDE
TRAINING_POOL_MAX = VALIDATION_POOL_BASE
AI4_STATE_PATH = Path("/Volumes/Extreme SSD/Projects/Century/training/reports/evolve-latest/state.json")
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
    """只读核对 AI 4.0 训练系统的验证账本，返回其已消费 (base, size) 块。"""
    blocks: list[tuple[int, int]] = []
    if not AI4_STATE_PATH.exists():
        return blocks
    try:
        state = json.loads(AI4_STATE_PATH.read_text())
        ledger = state.get("seedLedger") or state.get("validationLedger") or {}
        for entry in ledger.get("history", []):
            base = int(entry.get("base", 0))
            size = int(entry.get("size", VALIDATION_STRIDE))
            if base >= VALIDATION_POOL_BASE:
                blocks.append((base, size))
        if not blocks and isinstance(ledger.get("lastBase"), int) and ledger["lastBase"] >= VALIDATION_POOL_BASE:
            blocks.append((int(ledger["lastBase"]), VALIDATION_STRIDE))
    except Exception as exc:
        print(f"[arena] 警告：AI4 账本读取失败（{exc}），按无历史处理")
    return blocks


def _read_ledger() -> dict:
    if LEDGER_PATH.exists():
        return json.loads(LEDGER_PATH.read_text())
    return {"history": [], "lastBase": None}


def _write_ledger(ledger: dict) -> None:
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_PATH.write_text(json.dumps(ledger, ensure_ascii=False, indent=2))


def allocate_validation_block(size: int, purpose: str) -> int:
    """从验证池分配互不重叠的种子块；账本持久化（无挑战也落盘续接）。"""
    ledger = _read_ledger()
    consumed = [(int(e["base"]), int(e.get("size", VALIDATION_STRIDE))) for e in ledger.get("history", [])]
    consumed += load_ai4_ledger_blocks()
    highest_end = max((b + s for b, s in consumed), default=VALIDATION_POOL_BASE - VALIDATION_STRIDE)
    base = highest_end + VALIDATION_STRIDE
    if base + size > VALIDATION_POOL_MAX:
        raise RuntimeError(f"验证种子池耗尽：下一块 [{base}, {base + size}) 超过上限 {VALIDATION_POOL_MAX}")
    for b, s in consumed:
        if base < b + s and b < base + size:
            raise RuntimeError(f"种子块重叠：[{base},{base+size}) 与 [{b},{b+s})")
    entry = {"base": base, "size": size, "purpose": purpose, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    ledger["history"] = (ledger.get("history", []) + [entry])[-99:]
    ledger["lastBase"] = base
    ledger["challengeCount"] = len(ledger["history"])
    _write_ledger(ledger)
    return base


def allocate_training_block(size: int, purpose: str) -> int:
    """训练池种子块（评测约定区 [5M, 900M)；账本记录供审计）。"""
    ledger = _read_ledger()
    prev = [e for e in ledger.get("history", []) if str(e.get("purpose", "")).startswith("training:")]
    highest_end = max((int(e["base"]) + int(e.get("size", 0)) for e in prev), default=5_000_000)
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


def play_setup(env: VecEnv, bundle: PolicyBundle, device: torch.device,
               layout: list[SeatSpec], seeds: list[int]) -> dict:
    """跑一组对局（每 seed 一局），返回该设置统计。learner = policy 'learner'。"""
    wins = 0
    total_score = 0.0
    games = 0
    anomalies = 0
    node_ms_sum = 0.0
    node_ms_count = 0
    mlp_ms_sum = 0.0
    mlp_ms_count = 0
    ranks_hist: dict[int, int] = {}
    pending: dict[int, dict] = {}           # worker → {seed, game_id}
    game_policies: dict[int, list[str]] = {}  # game_id → 席位 policy
    game_ids = 0
    queue_seeds = list(seats := list(seeds))
    learner_seat = next(i for i, s in enumerate(layout) if s.policy_id == LEARNER_POLICY)

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
                if msg.status == "finished":
                    games += 1
                    if msg.winner_seat == learner_seat:
                        wins += 1
                    total_score += msg.scores[learner_seat]
                    rank = (msg.ranks.index(learner_seat) + 1) if msg.ranks else 0
                    ranks_hist[rank] = ranks_hist.get(rank, 0) + 1
                    for i, st in enumerate(msg.seat_stats):
                        if st.get("meanDecisionMs") and layout[i].kind == "node":
                            node_ms_sum += st["meanDecisionMs"] * st["decisionCount"]
                            node_ms_count += st["decisionCount"]
                else:
                    anomalies += 1
                launch(msg.worker_id)
        if decisions:
            dt = greedy_decide(bundle, decisions, device)
            for r in decisions:
                env.respond(r.worker_id, r.game_id, r.action_index)
                mlp_ms_sum += dt / len(decisions)
                mlp_ms_count += 1
    return {
        "games": games, "wins": wins, "winRate": wins / max(1, games),
        "meanScore": total_score / max(1, games), "anomalies": anomalies,
        "rankHistogram": ranks_hist,
        "nodeDecisionMs": node_ms_sum / max(1, node_ms_count),
        "mlpDecisionMs": mlp_ms_sum / max(1, mlp_ms_count),
    }


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
    results: list[dict] = []
    try:
        for opponent in opponents:
            for rotation in range(rotations):
                layout = build_layout_for(opponent, rotation)
                stats = play_setup(env, bundle, device, layout, seeds)
                stats["opponent"] = opponent
                stats["rotation"] = rotation
                results.append(stats)
                print(f"[arena] {opponent} 旋位{rotation}: 胜率 {stats['winRate']:.3f} "
                      f"({stats['wins']}/{stats['games']}) 均分 {stats['meanScore']:.1f} "
                      f"异常 {stats['anomalies']} mlp决策 {stats['mlpDecisionMs']:.2f}ms")
    finally:
        env.close()

    summary = summarize(results, checkpoint, seed_pool, seeds, greedy)
    (out_dir / "arena-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    (out_dir / "arena-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    write_markdown(out_dir / "arena-report.md", summary)
    return summary


def summarize(results: list[dict], checkpoint: Path, seed_pool: str,
              seeds: list[int], greedy: bool) -> dict:
    by_opp: dict[str, list[dict]] = {}
    for r in results:
        by_opp.setdefault(r["opponent"], []).append(r)
    opp_summary = {}
    for opp, rows in by_opp.items():
        games = sum(r["games"] for r in rows)
        wins = sum(r["wins"] for r in rows)
        lo, hi = wilson_ci(wins, games)
        opp_summary[opp] = {
            "games": games, "wins": wins, "winRate": wins / max(1, games),
            "wilson95": [round(lo, 4), round(hi, 4)],
            "meanScore": sum(r["meanScore"] * r["games"] for r in rows) / max(1, games),
            "anomalies": sum(r["anomalies"] for r in rows),
            "rankHistogram": {},
            "meanNodeDecisionMs": sum(r["nodeDecisionMs"] for r in rows) / len(rows),
            "meanMlpDecisionMs": sum(r["mlpDecisionMs"] for r in rows) / len(rows),
        }
        for r in rows:
            for k, v in r["rankHistogram"].items():
                opp_summary[opp]["rankHistogram"][k] = opp_summary[opp]["rankHistogram"].get(k, 0) + v
    return {
        "checkpoint": str(checkpoint),
        "greedy": greedy,
        "seedPool": seed_pool,
        "seedRange": [seeds[0], seeds[-1]] if seeds else None,
        "opponents": opp_summary,
        "verdict": "本报告只呈现统计事实；是否超越冠军由人工依据置信区间与异常率判定",
    }


def write_markdown(path: Path, summary: dict) -> None:
    lines = [
        "# AI 5.0 独立竞技评估报告", "",
        f"- 检查点：`{summary['checkpoint']}`",
        f"- 策略模式：{'贪心 argmax' if summary['greedy'] else '随机采样'}",
        f"- 种子池：{summary['seedPool']}（范围 {summary['seedRange']}）", "",
        "| 对手 | 局数 | 胜率 | Wilson 95% CI | 平均分 | 异常 | node决策ms | MLP决策ms |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for opp, s in summary["opponents"].items():
        lines.append(f"| {opp} | {s['games']} | {s['winRate']:.3f} "
                     f"| [{s['wilson95'][0]:.3f}, {s['wilson95'][1]:.3f}] | {s['meanScore']:.1f} "
                     f"| {s['anomalies']} | {s['meanNodeDecisionMs']:.1f} | {s['meanMlpDecisionMs']:.1f} |")
    lines += [
        "",
        "> 判读标准：胜率 95% CI 下界 > 0.5 才具备「优于该对手」的统计证据；"
        "平均分更高不构成结论；本报告不自动宣称超越。",
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
