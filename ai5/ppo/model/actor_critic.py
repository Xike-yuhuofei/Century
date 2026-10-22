"""AI 5.0 MLP Actor-Critic 网络（任务书第五节）。

架构（默认 3×256 主力规模，全部可配置）：
- 共享特征主干：obs_dim → [hidden × L] → 状态嵌入 h；
- Actor：候选行动经共享行动编码器（act_dim → act_embed）得到候选嵌入，
  与状态嵌入拼接后经小型头输出每个候选的 logit，仅在合法候选内 softmax
  （Masked Policy / 动态候选集合，任务书第六节推荐实现）；
- Critic：h → 小型 MLP → 标量价值（视角席位语义，训练侧约定见 rollout）。

设备：MPS 优先、CPU 回退（M4 基准：3×256 且 batch ≥ 256 时 MPS 更快）；
FP32；全部前向支持变长候选（ragged）批处理。
"""

from __future__ import annotations

import math

import torch
import torch.nn as nn


def resolve_device(device: str = "auto") -> torch.device:
    if device == "auto":
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    return torch.device(device)


def mlp(sizes: list[int], activation: str = "relu", final_activation: bool = True) -> nn.Sequential:
    layers: list[nn.Module] = []
    act = {"relu": nn.ReLU, "tanh": nn.Tanh, "gelu": nn.GELU}[activation]
    for i in range(len(sizes) - 1):
        layers.append(nn.Linear(sizes[i], sizes[i + 1]))
        if i < len(sizes) - 2 or final_activation:
            layers.append(act())
    return nn.Sequential(*layers)


class ActorCritic(nn.Module):
    """状态-候选双塔 MLP Actor-Critic。"""

    def __init__(self, obs_dim: int, act_dim: int, hidden=(256, 256, 256),
                 act_embed_dim: int = 128, head_hidden: int = 128, activation: str = "relu"):
        super().__init__()
        self.obs_dim = obs_dim
        self.act_dim = act_dim
        self.hidden = tuple(hidden)
        self.act_embed_dim = act_embed_dim
        self.head_hidden = head_hidden
        self.activation = activation
        self.trunk = mlp([obs_dim, *hidden], activation)
        self.critic = mlp([hidden[-1], head_hidden, 1], activation, final_activation=False)
        self.act_encoder = mlp([act_dim, act_embed_dim], activation)
        self.act_head = mlp([hidden[-1] + act_embed_dim, head_hidden, 1], activation, final_activation=False)
        self.apply(self._init_weights)

    def arch_kwargs(self) -> dict:
        """架构参数（快照重建 / 导出清单使用）。"""
        return {
            "obs_dim": self.obs_dim, "act_dim": self.act_dim, "hidden": list(self.hidden),
            "act_embed_dim": self.act_embed_dim, "head_hidden": self.head_hidden,
            "activation": self.activation,
        }

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            bound = math.sqrt(6 / (module.in_features + module.out_features))
            nn.init.uniform_(module.weight, -bound, bound)
            nn.init.zeros_(module.bias)

    def embed_states(self, obs: torch.Tensor) -> torch.Tensor:
        """[B, obs_dim] → [B, hidden[-1]]。"""
        return self.trunk(obs)

    def logits_over_candidates(self, state_emb: torch.Tensor, cand_flat: torch.Tensor,
                               cand_index: torch.Tensor) -> torch.Tensor:
        """变长候选批量的 Actor logits。

        state_emb: [B, H]；cand_flat: [N, act_dim]（N = ΣB 的候选数）；
        cand_index: [N] int64，每个候选所属状态在批量内的下标。
        返回 [N] logits（每个候选一个，同状态候选之间可比）。
        """
        cand_emb = self.act_encoder(cand_flat)                     # [N, E]
        joined = torch.cat([state_emb[cand_index], cand_emb], dim=-1)  # [N, H+E]
        return self.act_head(joined).squeeze(-1)                   # [N]

    def values(self, state_emb: torch.Tensor) -> torch.Tensor:
        """[B, H] → [B] 价值估计。"""
        return self.critic(state_emb).squeeze(-1)

    def evaluate(self, obs: torch.Tensor, cand_flat: torch.Tensor,
                 cand_index: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        emb = self.embed_states(obs)
        return self.logits_over_candidates(emb, cand_flat, cand_index), self.values(emb)

    def log_probs_and_entropy(self, logits: torch.Tensor, cand_index: torch.Tensor,
                              action_pos: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """段内 masked softmax：返回（每段所选动作 logp，每段熵，所选候选全局位置）。

        logits: [N]；cand_index: [N] 每个候选所属段；action_pos: [B] 每段所选候选的段内序号。
        """
        seg_ids = cand_index
        if seg_ids.numel() == 0:
            empty = logits.new_empty(0)
            return empty, empty, torch.empty(0, dtype=torch.long, device=logits.device)
        n_seg = int(seg_ids.max().item()) + 1
        max_per_seg = logits.new_full((n_seg,), float("-inf"))
        max_per_seg.scatter_reduce_(0, seg_ids, logits, reduce="amax", include_self=False)
        shifted = logits - max_per_seg[seg_ids]                    # 数值稳定 logsumexp
        seg_sum = logits.new_zeros(n_seg).index_add_(0, seg_ids, shifted.exp())
        log_z = seg_sum.clamp_min(1e-30).log()[seg_ids]
        logp_all = shifted - log_z                                 # [N] 段内 log-softmax
        counts = torch.bincount(seg_ids, minlength=n_seg)
        seg_start = torch.zeros(n_seg, dtype=torch.long, device=logits.device)
        if n_seg > 1:
            seg_start[1:] = torch.cumsum(counts, 0)[:-1]
        # action_pos[k] 是第 k 段内所选候选的局部序号（调用方保证按段序对齐），
        # 全局位置 = 段起点 + 段内序号（逐元素）。
        global_pos = seg_start + action_pos
        chosen_logp = logp_all[global_pos]                         # [B]
        p_all = logp_all.exp()
        seg_neg_ent = logits.new_zeros(n_seg).index_add_(0, seg_ids, p_all * logp_all)
        entropy = -seg_neg_ent                                     # [B] 每段熵
        return chosen_logp, entropy, global_pos

    def num_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())
