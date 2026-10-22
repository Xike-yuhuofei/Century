"""AI 5.0 经验采集器：VecEnv × 批量策略前向 × 轨迹回填。

关键正确性约束（任务书 7 / 9 / 17）：
- 行为策略与更新策略同源：learner 席位由当前 learner 权重前向 + 采样，
  logp/价值同一次前向计算并随转移保存；
- 冻结对手（node 冠军席位 / 快照 MLP 席位）的决策不进入 learner 的
  on-policy 缓冲（rollout.finish_game 按 policy_id 过滤）；
- 采样确定性：每个决策的采样 rng 由 (run_seed, 全局决策序号) 派生，
  断点恢复后同序号必然同采样；
- 对局派发确定性：席位布局旋转由 (run_seed, 全局对局序号) 派生。

性能策略（M4 基准）：模拟为主、GPU 即插即用——采集主循环把多个 worker 的
决策请求攒批（≤ batchWaitMs）后按策略分组前向，MPS/CPU 均可。
"""

from __future__ import annotations

import random
import time
import zlib
from dataclasses import dataclass

import numpy as np
import torch

from ..env.vec_env import DecisionRequest, GameResult, SeatSpec, VecEnv
from ...lib.seed_policy import PPO_TRAINING_BLOCK
from .rollout import RolloutBuffer

LEARNER_POLICY = "learner"

PPO_TRAINING_BLOCK_BASE, _PPO_TRAINING_BLOCK_END = PPO_TRAINING_BLOCK
PPO_TRAINING_BLOCK_SIZE = _PPO_TRAINING_BLOCK_END - PPO_TRAINING_BLOCK_BASE


def derive_rng(run_seed: int, kind: str, index: int) -> np.random.Generator:
    """从 (run_seed, kind, index) 派生独立确定性的 numpy 生成器。

    注意：必须用稳定哈希（crc32），不能用内置 hash()——其跨进程带盐随机化
    会破坏断点恢复后的采样复现。
    """
    seq = np.random.SeedSequence([int(run_seed), zlib.crc32(kind.encode()) & 0x7FFFFFFF, int(index)])
    return np.random.Generator(np.random.PCG64(seq))


def assign_seats(run_seed: int, game_index: int, layout: list[SeatSpec]) -> list[SeatSpec]:
    """确定性旋转席位布局：同 (run_seed, game_index) 必然同布局。"""
    rng = random.Random(f"{run_seed}:seats:{game_index}")
    seats = list(layout)
    rng.shuffle(seats)
    return seats


@dataclass
class CollectorConfig:
    workers: int = 4
    max_moves: int = 1200
    deadline_ms: int = 60_000
    max_candidates: int = 512
    batch_wait_ms: float = 4.0
    seed_salt: int = 0
    # P1 整改：快照席位解析策略——rotate（默认，轮转保证覆盖）/ random（按
    # (run_seed, game_index) 确定性抽样）/ latest（旧行为：永远最新快照）。
    snapshot_sampling: str = "rotate"


def resolve_snapshot_seat(snapshot_ids: list[str], game_index: int, run_seed: int,
                          sampling: str) -> str:
    """把 "snapshot" 占位席位解析为具体快照 id（确定性）。

    P1 整改：旧行为所有快照席位都经 "snap" 别名指向最新快照——历史快照池形同虚设，
    对手池退化为单一策略。rotate 轮转保证池内每个快照均匀出场；random 用
    稳定派生 rng（不用全局 random，避免影响其它随机源）。
    """
    if not snapshot_ids:
        raise RuntimeError("快照池为空：snapshot 席位要求至少先 push 一个快照")
    if sampling == "latest":
        return snapshot_ids[-1]
    if sampling == "rotate":
        return snapshot_ids[game_index % len(snapshot_ids)]
    if sampling == "random":
        return snapshot_ids[int(derive_rng(run_seed, "snapshot_pick", game_index).integers(0, len(snapshot_ids)))]
    raise ValueError(f"未知快照抽样策略：{sampling}")


class PolicyBundle:
    """learner + 冻结快照的模型集合（同一架构，多份权重）。"""

    def __init__(self, learner, device: torch.device, sample: bool = True):
        self.learner = learner
        self.device = device
        self.snapshots: dict[str, torch.nn.Module] = {}
        self.sample = sample  # 评估时可切换贪心

    def add_snapshot(self, policy_id: str, state_dict: dict) -> None:
        snap = type(self.learner)(**self.learner.arch_kwargs()).to(self.device)
        snap.load_state_dict(state_dict)
        snap.eval()
        for p in snap.parameters():
            p.requires_grad_(False)
        self.snapshots[policy_id] = snap

    def model_for(self, policy_id: str):
        if policy_id == LEARNER_POLICY:
            return self.learner
        if policy_id in self.snapshots:
            return self.snapshots[policy_id]
        raise KeyError(f"未知策略：{policy_id}（可用快照：{list(self.snapshots)}）")


def _group_by_policy(requests: list[DecisionRequest]) -> dict[str, list[DecisionRequest]]:
    groups: dict[str, list[DecisionRequest]] = {}
    for r in requests:
        groups.setdefault(r.policy_tag, []).append(r)
    return groups


def evaluate_requests(bundle: PolicyBundle, requests: list[DecisionRequest],
                      greedy: bool, rng_of) -> None:
    """对一组决策请求做批量前向并就地填充 .action_index / .logp / .value / .policy_tag。

    rng_of(request) 返回该决策的 numpy 生成器（确定性派生）。
    """
    if not requests:
        return
    model = bundle.model_for(requests[0].policy_tag)
    obs = torch.from_numpy(np.stack([r.obs for r in requests])).to(bundle.device)
    cand = torch.from_numpy(
        np.concatenate([r.cand_mat for r in requests])).to(bundle.device)
    seg = torch.from_numpy(np.concatenate(
        [np.full(r.n_candidates, i, dtype=np.int64) for i, r in enumerate(requests)])).to(bundle.device)
    with torch.no_grad():
        logits, values = model.evaluate(obs, cand, seg)
    # 每段采样（CPU numpy，确定性 rng；保证跨设备/断点可复现）。
    logp_cpu = None
    actions: list[int] = []
    for i, r in enumerate(requests):
        n = r.n_candidates
        row = logits[seg == i].detach().float().cpu().numpy()
        if greedy:
            act = int(np.argmax(row))
        else:
            shifted = row - row.max()
            p = np.exp(shifted)
            p /= p.sum()
            act = int(rng_of(r).choice(n, p=p))
        actions.append(act)
        r.action_index = act
        r._row_logits = row
        r._sampled_pos = act
    # 用与更新完全一致的实现回填 logp / 价值。
    pos = torch.tensor([r._sampled_pos for r in requests], dtype=torch.long, device=bundle.device)
    with torch.no_grad():
        chosen_logp, _, _ = model.log_probs_and_entropy(logits, seg, pos)
    for i, r in enumerate(requests):
        r.logp = float(chosen_logp[i].item())
        r.value = float(values[i].item())
        del r._row_logits, r._sampled_pos


class Collector:
    """驱动 K 个 worker 持续自对战并采集 learner 转移。"""

    def __init__(self, env: VecEnv, bundle: PolicyBundle, buffer: RolloutBuffer,
                 run_seed: int, layout: list[SeatSpec], cfg: CollectorConfig,
                 learner_policy_id: str = LEARNER_POLICY, reward_cfg: dict | None = None,
                 snapshot_ids_provider=None):
        self.env = env
        self.bundle = bundle
        self.buffer = buffer
        self.run_seed = run_seed
        self.layout = layout
        self.cfg = cfg
        self.learner_policy_id = learner_policy_id
        self.reward_cfg = reward_cfg or {"mode": "rank_win"}
        # P1 整改：snapshot 席位的池来源（返回当前池 id 列表，池增删后动态生效）。
        self.snapshot_ids_provider = snapshot_ids_provider
        self.game_counter = 0
        self.decision_counter = 0
        self.pending: list[DecisionRequest] = []
        self.game_policies: dict[int, list[str]] = {}   # game_id → 每席位 policy_id
        self.active_workers: set[int] = set()           # 已派发对局且未收到终局的 worker
        self._draining = False                          # 排水中：不再派发新局
        # 指标累计
        self.metrics = {
            "games": 0, "anomaly_games": 0, "learner_decisions": 0,
            "node_decision_ms_sum": 0.0, "node_decision_count": 0,
            "enum_full_sum": 0.0, "enum_kept_sum": 0.0, "enum_decisions": 0, "pruned_decisions": 0,
            "mlp_roundtrip_ms_sum": 0.0, "mlp_roundtrip_count": 0,
            "wall_s": 0.0,
            "stale_discarded": 0,                        # 混代轨迹丢弃的转移数（on-policy 审计）
            "opponentAppearances": {},                   # policy_id → 对局出场次数（对手池覆盖审计）
        }

    def restore_state(self, game_counter: int, decision_counter: int,
                      metrics: dict | None = None,
                      buffer_stats: dict | None = None) -> None:
        """断点恢复：续接对局/决策计数器与累计指标（P1 整改，旧版恢复时全部清零
        ——训练种子从头重放、游戏数统计断档）。"""
        self.game_counter = int(game_counter)
        self.decision_counter = int(decision_counter)
        if metrics:
            for k, v in metrics.items():
                if k in self.metrics:
                    if k == "opponentAppearances":
                        self.metrics[k] = dict(v)
                    elif isinstance(v, (int, float)):
                        self.metrics[k] = v
        if buffer_stats:
            for k, v in buffer_stats.items():
                if k in self.buffer.stats:
                    self.buffer.stats[k] = int(v)

    def _launch_game(self, worker_id: int) -> None:
        if self._draining:
            return
        layout = assign_seats(self.run_seed, self.game_counter, self.layout)
        # 快照占位席位 → 具体历史快照 id（在洗牌后的布局上解析，保持身份）。
        placeholders = [i for i, s in enumerate(layout) if s.policy_id == "snapshot"]
        if placeholders:
            ids = list(self.snapshot_ids_provider() if self.snapshot_ids_provider else [])
            for i in placeholders:
                layout[i] = SeatSpec.mlp(resolve_snapshot_seat(
                    ids, self.game_counter, self.run_seed, self.cfg.snapshot_sampling))
        seed = derive_seed(self.run_seed, self.game_counter, self.cfg.seed_salt)
        self.game_policies[self.game_counter] = [spec.policy_id for spec in layout]
        for spec in layout:
            if spec.policy_id != self.learner_policy_id:
                self.metrics["opponentAppearances"][spec.policy_id] = \
                    self.metrics["opponentAppearances"].get(spec.policy_id, 0) + 1
        self.env.start_game(worker_id, self.game_counter, seed, layout)
        self.active_workers.add(worker_id)
        self.game_counter += 1

    def _flush(self) -> None:
        if not self.pending:
            return
        for policy_id, reqs in _group_by_policy(self.pending).items():
            evaluate_requests(self.bundle, reqs, greedy=not self.bundle.sample,
                              rng_of=lambda r: derive_rng(self.run_seed, "decision", r._rng_index))
        for r in self.pending:
            self.env.respond(r.worker_id, r.game_id, r.action_index)
            if r.policy_tag == self.learner_policy_id:
                self.buffer.add_decision(r, r.policy_tag, r.action_index, r.logp, r.value)
                self.metrics["learner_decisions"] += 1
            self.metrics["mlp_roundtrip_ms_sum"] += (time.perf_counter() - r._t_recv) * 1000
            self.metrics["mlp_roundtrip_count"] += 1
        self.pending = []

    def _handle(self, msg) -> None:
        if isinstance(msg, DecisionRequest):
            # 策略归属：由派发时的席位布局决定（worker 只知道"这是 MLP 席位"）。
            policies = self.game_policies.get(msg.game_id)
            if policies is None:
                raise RuntimeError(f"decision 属于未知对局 {msg.game_id}")
            msg.policy_tag = policies[msg.seat]
            msg._t_recv = time.perf_counter()
            msg._rng_index = self.decision_counter
            self.decision_counter += 1
            self.pending.append(msg)
        elif isinstance(msg, GameResult):
            self._on_game_result(msg)
            self.game_policies.pop(msg.game_id, None)
        else:
            raise RuntimeError(f"未知消息：{msg}")

    def _on_game_result(self, result: GameResult) -> None:
        self.metrics["games"] += 1
        seats = result.seats
        self.active_workers.discard(result.worker_id)
        if result.status != "finished":
            self.metrics["anomaly_games"] += 1
            self.buffer.discard_game(result.game_id)
        else:
            # node 席位决策耗时统计（AI 4.0 基线口径）。
            for i, spec in enumerate(seats):
                if spec.kind == "node":
                    st = result.seat_stats[i] if i < len(result.seat_stats) else None
                    if st and st.get("meanDecisionMs"):
                        self.metrics["node_decision_ms_sum"] += st["meanDecisionMs"] * st["decisionCount"]
                        self.metrics["node_decision_count"] += st["decisionCount"]
            ea = result.enum_agg or {}
            n_dec = ea.get("fullDecisions", 0) + ea.get("prunedDecisions", 0)
            self.metrics["enum_full_sum"] += ea.get("meanFull", 0.0) * n_dec
            self.metrics["enum_kept_sum"] += ea.get("meanKept", 0.0) * n_dec
            self.metrics["enum_decisions"] += n_dec
            self.metrics["pruned_decisions"] += ea.get("prunedDecisions", 0)
            # learner 轨迹回填奖励。
            scores = result.scores
            n = len(scores)
            # P1 整改：终局 claimed（认领魔像数）由 bridge terminal 逐席位回传，
            # 辅助奖励启用时走 finish_game_full 完整结算链（旧版 claimed 恒 0、
            # 且从不调用 finish_game_full——辅助奖励实际不可用）。
            final_states = []
            for i in range(n):
                st = result.seat_stats[i] if i < len(result.seat_stats) else {}
                final_states.append({"claimed": int(st.get("claimed", 0)),
                                     "score": scores[i],
                                     "turns": st.get("decisionCount", 1)})
            aux_cfg = self.reward_cfg.get("aux", {}) if isinstance(self.reward_cfg, dict) else {}
            aux_enabled = any(isinstance(v, (int, float)) and v for v in aux_cfg.values())
            if aux_enabled:
                self.buffer.finish_game_full(result.game_id, seats, scores, result.ranks,
                                             result.winner_seat, result.status,
                                             self.reward_cfg, self.learner_policy_id,
                                             final_states)
            else:
                self.buffer.finish_game(result.game_id, seats, scores, result.ranks,
                                        result.winner_seat, result.status,
                                        self.reward_cfg, self.learner_policy_id)
        # 立即派发下一局（worker 流水线不停；排水阶段除外）。
        self._launch_game(result.worker_id)

    def collect(self, target_learner_decisions: int, max_wall_s: float | None = None) -> dict:
        """采集直到 learner 决策数达标（或墙钟预算耗尽）。返回本段指标。

        可重入：上次调用留下的进行中对局继续推进；只对空闲 worker 派发新局。
        P1 整改（on-policy 迭代边界）：末尾排水——达到目标后不再派发新局，
        等待全部进行中对局终局并结算完毕才返回。此后训练循环做 GAE + PPO 更新，
        保证更新批内每条轨迹都完全由当前策略采集（同链不混代），
        检查点也只在排水后的干净边界保存。
        """
        assert self.layout, "席位布局为空"
        t0 = time.perf_counter()
        start_decisions = self.buffer.stats["decisions"]
        for worker_id in range(self.env.n_workers):
            if worker_id not in self.active_workers:
                self._launch_game(worker_id)
        while self.buffer.stats["decisions"] < start_decisions + target_learner_decisions:
            if max_wall_s and (time.perf_counter() - t0) > max_wall_s:
                break
            msgs = self.env.drain(timeout=self.cfg.batch_wait_ms / 1000)
            if msgs:
                for m in msgs:
                    self._handle(m)
            # 攒批：批满（全部 worker 都有挂起请求）或超时即前向。
            if len(self.pending) >= self.env.n_workers or (
                    self.pending and len(self.pending) > 0 and _waited_long(self.pending)):
                self._flush()
        # —— 排水：不再派发新局，等全部在途对局终局 ——
        self._draining = True
        while self.active_workers:
            msgs = self.env.drain(timeout=0.05)
            if msgs:
                for m in msgs:
                    self._handle(m)
            if self.pending and _waited_long(self.pending):
                self._flush()
        self._draining = False
        self._flush()
        self.metrics["stale_discarded"] = self.buffer.stats.get("stale_discarded", 0)
        self.metrics["wall_s"] = round(time.perf_counter() - t0, 2)
        return dict(self.metrics)


def _waited_long(pending: list) -> bool:
    if not pending:
        return False
    oldest = min(pending, key=lambda r: r._t_recv)
    return (time.perf_counter() - oldest._t_recv) * 1000 > 12.0  # 决策请求最长等待 12ms 攒批


def derive_seed(run_seed: int, game_index: int, seed_salt: int) -> int:
    """对局引擎种子：确定性派生，强制落在 PPO 训练子块 [300_100_000, 350_000_000)。

    P0 可靠性整改：旧实现落在 [0, 2^31) 全域——实测历史训练约 13% 种子落入
    验证池区间 [900M, 1.06e9)，破坏验证池完整性（幸而与已消费验证块无碰撞，
    审计见 ai5/ppo/reports/seed-audit/）。新实现 (raw + salt) mod 块大小后加
    块基址，保证任何 (run_seed, game_index, salt) 组合都绝不可能越界：
    - 不进入验证池 [900M, 1.06e9)（AI4 确认挑战 + AI5 arena 独立验证）；
    - 不进入 AI4 进化 [0, 300M) / 基准区 [400M, 900M)；
    - 不进入 OpenEvolve 评测子块（stage2/stage3/深度验证均在 [300M, 300.1M)）。
    历史检查点复现用旧公式：derive_seed_legacy（仅审计脚本使用）。
    """
    rng = derive_rng(run_seed, "game_seed", game_index)
    raw = int(rng.integers(0, PPO_TRAINING_BLOCK_SIZE))
    return PPO_TRAINING_BLOCK_BASE + (raw + (seed_salt & 0x7FFFFFFF)) % PPO_TRAINING_BLOCK_SIZE


def derive_seed_legacy(run_seed: int, game_index: int, seed_salt: int = 0) -> int:
    """旧版 derive_seed（[0, 2^31) 全域）——仅用于历史运行种子污染审计，
    训练代码禁止调用（见 ai5/ppo/reports/seed-audit/audit_seed_pollution.py）。"""
    rng = derive_rng(run_seed, "game_seed", game_index)
    value = (int(rng.integers(0, 2**31 - 1)) ^ (seed_salt & 0x7FFFFFFF)) & 0x7FFFFFFF
    return max(0, value)
