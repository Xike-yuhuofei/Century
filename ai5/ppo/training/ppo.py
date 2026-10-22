"""AI 5.0 PPO 更新器（任务书第七节：真 PPO，不是监督学习换皮）。

实现清单：
- On-policy 经验采集（rollout.py 保证行为策略 = 采集时策略，logp 同源）；
- PPO Clipped Objective（actor）；
- 价值损失（clip 可选）；
- GAE(λ) 优势估计 + 批内优势归一化；
- 熵奖励（动态候选集合内的段熵）；
- 梯度裁剪、近似 KL 监控、目标 KL 早停；
- 学习率调度（常数 / 线性衰减）、NaN/梯度异常检测（跳过该次更新并记录）。

经验只在 rollout 边界内复用（epoch × minibatch 遍历本次采集的数据），
不跨迭代无限复用旧策略经验。
"""

from __future__ import annotations

import math
import time

import numpy as np
import torch


class PPO:
    def __init__(self, model, cfg: dict, device: torch.device):
        self.model = model
        self.device = device
        self.cfg = cfg
        self.clip = float(cfg.get("clip", 0.2))
        self.vf_coef = float(cfg.get("vfCoef", 0.5))
        self.ent_coef = float(cfg.get("entCoef", 0.01))
        self.epochs = int(cfg.get("epochs", 4))
        self.minibatch = int(cfg.get("minibatch", 512))
        self.max_grad_norm = float(cfg.get("maxGradNorm", 0.5))
        self.target_kl = float(cfg.get("targetKl", 0.03))
        self.advantage_norm = bool(cfg.get("advantageNorm", True))
        self.value_clip = bool(cfg.get("valueClip", True))
        self.base_lr = float(cfg.get("lr", 3e-4))
        self.lr_schedule = cfg.get("lrSchedule", "constant")
        self.optimizer = torch.optim.Adam(model.parameters(), lr=self.base_lr)
        self.update_count = 0

    def lr_scale(self, progress: float) -> float:
        """progress ∈ [0,1]：训练整体进度。"""
        if self.lr_schedule == "linear_decay":
            return max(0.05, 1.0 - progress)
        return 1.0

    def _set_lr(self, scale: float) -> None:
        for group in self.optimizer.param_groups:
            group["lr"] = self.base_lr * scale

    def update(self, trajectories: list[dict], progress: float = 0.0) -> dict:
        """对本次采集的已完成轨迹执行 PPO 更新，返回指标 dict。"""
        t0 = time.perf_counter()
        self._set_lr(self.lr_scale(progress))

        # 组装扁平批量（变长候选 → 大矩阵 + 段索引）。
        obs_parts, cand_parts, seg_parts = [], [], []
        actions, old_logp, values, advantages, returns = [], [], [], [], []
        seg_base = 0
        act_dim = self.model.act_dim
        for traj in trajectories:
            n = len(traj["actions"])
            obs_parts.append(traj["obs"])
            cand_parts.append(traj["cand_flat"].reshape(-1, act_dim))
            seg_parts.append(np.repeat(np.arange(seg_base, seg_base + n), traj["cand_counts"]))
            seg_base += n
            actions.append(traj["actions"])
            old_logp.append(traj["old_logp"])
            values.append(traj["values"])
            advantages.append(traj["advantages"])
            returns.append(traj["returns"])
        obs = torch.from_numpy(np.concatenate(obs_parts)).to(self.device)
        cand = torch.from_numpy(np.concatenate(cand_parts)).to(self.device)
        seg = torch.from_numpy(np.concatenate(seg_parts).astype(np.int64)).to(self.device)
        actions = torch.from_numpy(np.concatenate(actions).astype(np.int64)).to(self.device)
        old_logp = torch.from_numpy(np.concatenate(old_logp).astype(np.float32)).to(self.device)
        old_values = torch.from_numpy(np.concatenate(values).astype(np.float32)).to(self.device)
        advantages_np = np.concatenate(advantages)
        returns = torch.from_numpy(np.concatenate(returns).astype(np.float32)).to(self.device)

        if self.advantage_norm:
            adv_np = (advantages_np - advantages_np.mean()) / max(1e-8, advantages_np.std())
        else:
            adv_np = advantages_np
        advantages = torch.from_numpy(adv_np.astype(np.float32)).to(self.device)

        total = obs.shape[0]
        if total < 8:
            return {"skipped": "samples_too_few", "samples": int(total)}

        metrics = {"samples": int(total), "updateMs": None, "approxKl": [], "clipFrac": [],
                   "policyLoss": [], "valueLoss": [], "entropy": [], "gradNorm": [], "nanSkips": 0}
        early_stop = False
        for epoch in range(self.epochs):
            if early_stop:
                break
            mb_iterator = self._minibatch_segments(obs, cand, seg, actions, old_logp,
                                                   old_values, advantages, returns, total)
            for (b_obs, b_cand, b_seg, b_act, b_oldlp, b_oldv, b_adv, b_ret) in mb_iterator:
                with torch.set_grad_enabled(True):
                    logits, value = self.model.evaluate(b_obs, b_cand, b_seg)
                    # 每段所选动作在段内的位置 = b_act（采集时存的段内序号保持不变）。
                    chosen_logp, entropy, global_pos = self.model.log_probs_and_entropy(logits, b_seg, b_act)
                    chosen_logits = logits[global_pos]
                    old_chosen_logp = b_oldlp
                    ratio = (chosen_logp - old_chosen_logp).exp()
                    surr1 = ratio * b_adv
                    surr2 = ratio.clamp(1 - self.clip, 1 + self.clip) * b_adv
                    policy_loss = -torch.min(surr1, surr2).mean()
                    if self.value_clip:
                        v_clip = b_oldv + (value - b_oldv).clamp(-self.clip, self.clip)
                        v_loss = 0.5 * torch.max((value - b_ret).pow(2), (v_clip - b_ret).pow(2)).mean()
                    else:
                        v_loss = 0.5 * (value - b_ret).pow(2).mean()
                    ent_mean = entropy.mean()
                    loss = policy_loss + self.vf_coef * v_loss - self.ent_coef * ent_mean

                    self.optimizer.zero_grad(set_to_none=True)
                    loss.backward()
                    grad_norm = torch.nn.utils.clip_grad_norm_(self.model.parameters(), self.max_grad_norm)
                    # NaN/Inf 守卫：跳过该 minibatch 更新并计数。
                    if not torch.isfinite(loss) or not torch.isfinite(grad_norm):
                        metrics["nanSkips"] += 1
                        self.optimizer.zero_grad(set_to_none=True)
                        continue
                    self.optimizer.step()

                with torch.no_grad():
                    approx_kl = (old_chosen_logp - chosen_logp).mean().item()
                metrics["approxKl"].append(approx_kl)
                metrics["clipFrac"].append(((ratio - 1).abs() > self.clip).float().mean().item())
                metrics["policyLoss"].append(policy_loss.item())
                metrics["valueLoss"].append(v_loss.item())
                metrics["entropy"].append(ent_mean.item())
                metrics["gradNorm"].append(float(grad_norm))
            # 目标 KL 早停（按 epoch 平均）。
            if metrics["approxKl"] and sum(metrics["approxKl"]) / len(metrics["approxKl"]) > self.target_kl * 1.5:
                early_stop = True
        self.update_count += 1
        metrics["updateMs"] = round((time.perf_counter() - t0) * 1000, 1)
        for key in ("approxKl", "clipFrac", "policyLoss", "valueLoss", "entropy", "gradNorm"):
            metrics[key] = round(sum(metrics[key]) / max(1, len(metrics[key])), 6)
        return metrics

    def _minibatch_segments(self, obs, cand, seg, actions, old_logp, old_values, advantages, returns, total):
        """按状态切 minibatch，同时完整迁移各段候选（全向量化，无逐段 .item()）。

        seg 中同段候选连续存放：段 i 的候选区间为 [starts[i], starts[i]+counts[i])。
        选中状态子集后：新段索引 = repeat_interleave(局部序号, 段长)；
        候选全局位置 = repeat_interleave(starts[idx], 段长) + 段内偏移。
        """
        counts = torch.bincount(seg)
        starts = torch.zeros_like(counts)
        if counts.numel() > 1:
            starts[1:] = torch.cumsum(counts, 0)[:-1]
        perm = torch.randperm(total, device=self.device)
        for start in range(0, total, self.minibatch):
            idx = perm[start:start + self.minibatch]
            if idx.numel() < 2:
                continue
            c_per_state = counts[idx]                                   # [m]
            m = idx.numel()
            new_seg = torch.repeat_interleave(
                torch.arange(m, device=self.device), c_per_state)       # [Σc]
            seg_cum = torch.cumsum(c_per_state, 0) - c_per_state        # 每状态在 minibatch 中的候选起点
            offsets = torch.arange(int(c_per_state.sum().item()), device=self.device) \
                - torch.repeat_interleave(seg_cum, c_per_state)
            b_cand_idx = torch.repeat_interleave(starts[idx], c_per_state) + offsets
            yield (obs[idx], cand[b_cand_idx], new_seg, actions[idx],
                   old_logp[idx], old_values[idx], advantages[idx], returns[idx])
