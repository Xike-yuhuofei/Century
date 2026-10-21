"""AI 5.0 经验采集与 GAE（任务书第七节）。

多智能体自对战的正确处理（任务书 9 / 17 纪律）：
- 每条转移只归属"做出该决策的策略"（policy_id）：learner 席位的转移才进入
  PPO 更新；冻结对手（node 席位 / 历史快照）的决策一律不作为 learner 的
  on-policy 样本——它们不共享行为策略概率定义；
- 同一learner 策略（参数共享自对战）的多个席位各自形成独立轨迹链
  (game_id, seat)，GAE 沿该席位自己的决策序列回传；
- 奖励在轨迹终局一次性给足（终局奖励语义），中间步奖励为 0（辅助关闭时）；
- 行为策略 logp 在采集时由"当时做出决策的策略"计算并随转移保存，
  保证 PPO 重要性比率的分母与行为策略完全一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch

from .rewards import auxiliary_reward, terminal_reward


@dataclass
class Transition:
    """一条 MLP 决策转移。"""
    game_id: int
    seat: int
    policy_id: str
    obs: np.ndarray            # [obs_dim] f32
    cand_mat: np.ndarray       # [n_cand, act_dim] f32
    action_index: int
    logp: float                # 行为策略 log π(a|s)
    value: float               # 行为策略 critic V(s)
    reward: float = 0.0        # 终局结算时回填
    done: bool = False
    enum_stats: dict = field(default_factory=dict)
    turn_number: int = 0


@dataclass
class _OpenTrajectory:
    """进行中的 (game_id, seat) 轨迹。"""
    transitions: list[Transition] = field(default_factory=list)
    seat: int = 0
    policy_id: str = ""


class RolloutBuffer:
    """跨对局积累转移；按轨迹计算 GAE；输出 PPO 可用的扁平批量。"""

    def __init__(self, gamma: float = 0.999, gae_lambda: float = 0.95):
        if not (0.0 <= gamma <= 1.0):
            raise ValueError("gamma 必须在 [0,1]")
        if not (0.0 <= gae_lambda <= 1.0):
            raise ValueError("gae_lambda 必须在 [0,1]")
        self.gamma = gamma
        self.gae_lambda = gae_lambda
        self.open_traj: dict[tuple[int, int], _OpenTrajectory] = {}
        self.completed: list[list[Transition]] = []   # 已终局轨迹（转移列表）
        self.stats = {"games": 0, "anomaly_games": 0, "decisions": 0, "pruned_decisions": 0}

    def add_decision(self, req, policy_id: str, action_index: int, logp: float, value: float) -> None:
        key = (req.game_id, req.seat)
        traj = self.open_traj.get(key)
        if traj is None:
            traj = self.open_traj[key] = _OpenTrajectory(seat=req.seat, policy_id=policy_id)
        traj.transitions.append(Transition(
            game_id=req.game_id, seat=req.seat, policy_id=policy_id,
            obs=req.obs.copy(), cand_mat=req.cand_mat.copy(),
            action_index=int(action_index), logp=float(logp), value=float(value),
            enum_stats=dict(req.enum_stats), turn_number=req.turn_number,
        ))
        self.stats["decisions"] += 1
        if req.enum_stats.get("pruned"):
            self.stats["pruned_decisions"] += 1

    def finish_game(self, game_id: int, seats: list, scores: list, ranks, winner_seat,
                    status: str, reward_cfg: dict, learner_policy_id: str) -> None:
        """终局结算：为 learner 席位的轨迹回填奖励并标记 done。

        冻结对手席位（policy_id ≠ learner_policy_id）的轨迹若存在（快照 MLP 席位），
        直接丢弃——它们不是 learner 的 on-policy 样本。
        启用辅助奖励时必须改用 finish_game_full。
        """
        aux_cfg = reward_cfg.get("aux", {}) if isinstance(reward_cfg, dict) else {}
        if any(isinstance(v, (int, float)) and v for v in aux_cfg.values()):
            raise ValueError("启用辅助奖励请调用 finish_game_full")
        self.stats["games"] += 1
        if status != "finished":
            self.stats["anomaly_games"] += 1
        for seat_idx, seat_spec in enumerate(seats):
            key = (game_id, seat_idx)
            traj = self.open_traj.pop(key, None)
            if traj is None or not traj.transitions:
                continue
            if seat_spec.policy_id != learner_policy_id or status != "finished":
                continue  # 冻结对手转移 / 异常对局一律不进入训练缓冲
            last = traj.transitions[-1]
            last.reward = terminal_reward(scores, ranks, seat_idx, winner_seat, reward_cfg)
            last.done = True
            self.completed.append(traj.transitions)

    def finish_game_full(self, game_id: int, seats: list, scores: list, ranks,
                         winner_seat: int | None, status: str, reward_cfg: dict,
                         learner_policy_id: str, final_seat_states: list[dict]) -> None:
        """finish_game 的完整版：支持辅助奖励（需要逐席位终局状态）。"""
        self.stats["games"] += 1
        if status != "finished":
            self.stats["anomaly_games"] += 1
        for seat_idx, seat_spec in enumerate(seats):
            key = (game_id, seat_idx)
            traj = self.open_traj.pop(key, None)
            if traj is None or not traj.transitions:
                continue
            if seat_spec.policy_id != learner_policy_id or status != "finished":
                continue
            last = traj.transitions[-1]
            reward = terminal_reward(scores, ranks, seat_idx, winner_seat, reward_cfg)
            reward += auxiliary_reward(final_seat_states[seat_idx], reward_cfg.get("aux", {}))
            last.reward = reward
            last.done = True
            self.completed.append(traj.transitions)

    def discard_game(self, game_id: int) -> None:
        """异常对局：丢弃全部相关轨迹（不进入训练）。"""
        for key in [k for k in self.open_traj if k[0] == game_id]:
            del self.open_traj[key]

    # —— GAE 与批量组装 ——

    def compute_gae(self) -> list[dict]:
        """对全部已完成轨迹计算 GAE(λ)。

        终局奖励语义 + 无截断自举（done=True 且没有后续价值），bootstrap=0。
        返回逐轨迹 dict（numpy 数组），并清空 completed。
        """
        outputs = []
        for traj in self.completed:
            values = np.array([t.value for t in traj], dtype=np.float64)
            rewards = np.array([t.reward for t in traj], dtype=np.float64)
            T = len(traj)
            advantages = np.zeros(T, dtype=np.float64)
            gae = 0.0
            for t in range(T - 1, -1, -1):
                next_value = values[t + 1] if t + 1 < T else 0.0   # 终局自举为 0
                delta = rewards[t] + self.gamma * next_value - values[t]
                gae = delta + self.gamma * self.gae_lambda * gae
                advantages[t] = gae
            returns = advantages + values
            outputs.append({
                "obs": np.stack([t.obs for t in traj]).astype(np.float32),
                # 变长候选：扁平拼接 + 每转移候选数（PPO 侧按段重排）。
                "cand_flat": np.concatenate([t.cand_mat.reshape(-1) for t in traj]).astype(np.float32),
                "cand_counts": np.array([t.cand_mat.shape[0] for t in traj], dtype=np.int64),
                "actions": np.array([t.action_index for t in traj], dtype=np.int64),
                "old_logp": np.array([t.logp for t in traj], dtype=np.float32),
                "values": values.astype(np.float32),
                "advantages": advantages.astype(np.float32),
                "returns": returns.astype(np.float32),
            })
        self.completed = []
        return outputs

    def total_completed_decisions(self) -> int:
        return sum(len(t) for t in self.completed)

    def open_decisions(self) -> int:
        return sum(len(t.transitions) for t in self.open_traj.values())
