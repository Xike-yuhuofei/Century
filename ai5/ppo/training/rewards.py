"""AI 5.0 奖励函数（任务书第八节）。

原则：
- 主奖励只来自实际竞技结果（胜负 / 名次 / 分差），最终对局结算一次性给出；
- 辅助奖励（魔像进度、回合效率等）全部默认关闭，且必须可通过配置单独关闭，
  以建立"纯终局奖励"基准实验；
- 奖励语义是"当前席位视角"：终局后按席位名次/得分计算，训练侧不做跨席位均摊。
"""

from __future__ import annotations


def terminal_reward(scores: list[int], ranks: list[int] | None, seat: int,
                    winner_seat: int | None, cfg: dict) -> float:
    """按席位计算终局奖励。

    cfg 模式：
    - rank_win（默认）：0.5×名次分 + 0.5×胜负分；
    - win_loss：仅胜负；
    - pure_rank：仅名次分；
    - score_margin：仅归一化分差。
    名次分 = (n - rank) / (n - 1) ∈ [0,1]（第一名 1，最后一名 0）。
    分差 = (my - bestOther) / 30 后截断到 [-1, 1]。
    """
    n = len(scores)
    mode = cfg.get("mode", "rank_win")
    if n < 2:
        return 0.0
    if ranks is None:
        # 兜底：按得分推导名次（平分时与引擎 ranking 语义可能有差异，仅异常局使用）。
        order = sorted(range(n), key=lambda i: -scores[i])
        ranks = [0] * n
        for pos, i in enumerate(order):
            ranks[i] = pos
    my_rank = ranks.index(seat) + 1  # 1 = 第一
    rank_score = (n - my_rank) / (n - 1)
    win = 1.0 if seat == winner_seat else 0.0
    best_other = max(s for i, s in enumerate(scores) if i != seat)
    margin = max(-1.0, min(1.0, (scores[seat] - best_other) / 30.0))

    if mode == "win_loss":
        return win
    if mode == "pure_rank":
        return rank_score
    if mode == "score_margin":
        return margin
    w_win = float(cfg.get("winWeight", 0.5))
    w_rank = float(cfg.get("rankWeight", 0.5))
    w_margin = float(cfg.get("scoreMarginWeight", 0.0))
    return w_win * win + w_rank * rank_score + w_margin * margin


def auxiliary_reward(final_seat_state: dict, cfg: dict) -> float:
    """辅助奖励（全部默认 0）。final_seat_state: {claimed, golems?, crystals, turns, score}。

    - golemProgress：认领数 / 触发阈值（threshold 由席位人数决定，传入 cfg.threshold）；
    - turnEfficiency：score / turns 的归一化（鼓励引擎效率，但可能诱导拖延，慎开）。
    任何非零配置都必须通过消融实验验证独立竞技收益（任务书第八节）。
    """
    total = 0.0
    threshold = max(1, int(cfg.get("threshold", 5)))
    if cfg.get("golemProgress", 0.0):
        total += cfg["golemProgress"] * min(1.0, final_seat_state.get("claimed", 0) / threshold)
    if cfg.get("turnEfficiency", 0.0):
        total += cfg["turnEfficiency"] * min(1.0, final_seat_state.get("score", 0) / max(1, final_seat_state.get("turns", 1)) / 1.0)
    return total
