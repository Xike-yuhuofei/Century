"""AI5 种子全局政策（P0 可靠性整改：跨系统种子分配的唯一权威定义）。

与 ai5/lib/seed_policy.mjs 保持同一布局（两侧常量由单元测试逐值比对，
见 ai5/ppo/tests/python/test_seed_policy.py）：

- [0, 300M)                AI 4.0 日常进化（AI5 绝不使用）；
- [300M, 400M)             AI5 专用块，内部再分：
  - [300_000_000, 300_000_016)  OpenEvolve stage2 快筛（16 种子，固定）；
  - [300_000_100, 300_000_148)  OpenEvolve stage3 深评（48 种子，固定）；
  - [300_001_000, 300_002_000)  OpenEvolve 深度独立验证（账本管理）；
  - [300_100_000, 350_000_000)  PPO 训练对局种子（derive_seed 强制约束于此）；
  - [350_000_000, 400_000_000)  AI5 竞技评估训练池（账本管理）；
- [400M, 900M)             AI 4.0 基准评测约定区（AI5 绝不使用）；
- [900M, 1.06e9)           验证池：账本防重 + 原子分配，训练种子绝不可进入。
- [1.1e9, 1.2e9)           AI6 冠军基线冻结评测专用块（training/baseline 账本管理），
  多人（2-5 人）第一名率基准、性能基准与冻结复现对照，与各池物理隔离。

纪律：训练种子与验证/评测种子交集必须为零；越界一律抛错。
"""

from __future__ import annotations

ENGINE_SEED_MAX = 2**31 - 1

AI4_EVO_BLOCK = (0, 300_000_000)
AI5_BLOCK = (300_000_000, 400_000_000)
OPENEVOLVE_STAGE2_BLOCK = (300_000_000, 300_000_016)
OPENEVOLVE_STAGE3_BLOCK = (300_000_100, 300_000_148)
OPENEVOLVE_DEEP_VALIDATION_BLOCK = (300_001_000, 300_002_000)
PPO_TRAINING_BLOCK = (300_100_000, 350_000_000)
AI5_EVAL_TRAINING_BLOCK = (350_000_000, 400_000_000)
AI4_BENCHMARK_BLOCK = (400_000_000, 900_000_000)
VALIDATION_POOL_BLOCK = (900_000_000, 1_060_000_000)
AI6_BASELINE_BLOCK = (1_100_000_000, 1_200_000_000)
# AI6 战术基准局面库专用块（research/overnight-tactical-benchmark）：
# 仅用于基准局面的引擎 replay 种子与固定工作量测试，不用于胜率/晋级统计。
# 原拟 [1.4e9,1.5e9) 与对抗性联赛块重叠，按块不重叠纪律改登记 [1.5e9,1.6e9)。
AI6_SCENARIO_BLOCK = (1_500_000_000, 1_600_000_000)


def assert_in_block(seed: int, block: tuple[int, int], name: str = "seed") -> int:
    """断言种子落在指定区间内（含头不含尾），越界抛错。"""
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise TypeError(f"{name} 必须为整数，实际：{seed!r}")
    if not (block[0] <= seed < block[1]):
        raise ValueError(f"{name} {seed} 越界：必须在 {block[0]}..{block[1] - 1}（区间纪律违规）")
    return seed


def generate_unique_seeds(count: int, block: tuple[int, int], base: int) -> list[int]:
    """在 block 内从 base 起生成 count 个连续唯一种子（顺序切片，天然唯一可审计）。

    块间不重叠由调用方账本（原子分配）保证；本函数只保证切片自身合法。
    """
    if not isinstance(count, int) or count <= 0:
        raise ValueError(f"count 必须为正整数，实际：{count}")
    if not isinstance(base, int) or base < block[0] or base + count > block[1]:
        raise ValueError(f"种子块 [{base}, {base + count}) 越界（块 {block[0]}..{block[1]}）")
    seeds = list(range(base, base + count))
    if len(set(seeds)) != count:
        raise AssertionError("生成的种子列表存在重复（不应发生）")
    return seeds


def assert_disjoint(a: list[int] | range, b: list[int] | range, what: str) -> None:
    """断言两个种子集合无交集（训练/验证隔离验收用）。"""
    inter = set(a) & set(b)
    if inter:
        sample = sorted(inter)[:5]
        raise AssertionError(f"{what} 存在交集 {len(inter)} 个（例：{sample}）——种子隔离违规")
