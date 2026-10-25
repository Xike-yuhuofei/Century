# 引擎轴候选批次 v1 · 立项报告（engine-axis-candidates-v1）

- 依据：预注册联赛（PR #40）确立的 style-engine 克制信号（JS5 对其仅 33.3% [0.192, 0.512]）
- 执行：2026-10-25，用户批准立项；两阶段评估管线（快档初筛 → official 确认）
- 代码：`research/engine-axis-candidates-v1`（含 CLI `--seed-offset` 选项：支持在部分消费的块内续接种子分区）

## 阶段 1 · 初筛（快档 workUnits:64，matrix-dev 块）

- 12 个引擎轴候选（style-engine 基座 ± engine/capacity/tempo/rest/synergy/goal/endgame/获取估值变异）
- 600 局 **0 异常**，~95 分钟；同批次共享种子（跨候选配对设计）
- 排名前二：`cand-eng-cap-12`（轴A 45%）与 `cand-eng-baseline-acq`（轴A 45% + 泛化最佳 70%/50%）

## 阶段 2 · official 确认（budgetMs=100 墙钟，prereg 块 offset 1620）

- 2 候选 × 150 局 = **300 局 0 异常**，~31 分钟
- **双双 reject（诚实负结果）**：

| 候选 | 轴A（vs 冻结冠军）3 单元 | 轴G 泛化 | 判定 |
|---|---|---|---|
| cand-eng-cap-12 | 43.3% / 43.3% / 46.7%（下界 0.316–0.346） | 2p 33.3%、5p 16.7%（分差 −2.43/−1.15） | reject |
| cand-eng-baseline-acq | 26.7% / 26.7% / 56.7%（下界 0.171–0.441） | 2p 46.7%、5p 20.0%（分差 −0.37/−0.97） | reject |

## 结论

1. **初筛信号未被 official 确认**——快档 n=10 的 weak-vs-champion 读数在 official n=60 下回归；
   两阶段管线按设计工作（初筛放宽、确认收紧）。
2. **引擎轴单权重变异不构成对 JS5 的威胁**：加深 engine（1.8/2.0）反而全面劣化；
   style-engine 的联赛克制信号（33.3%）依赖其完整权重组合，单轴拆解均不能保持。
3. **下一步方向**：克制组合是多轴耦合的——单轴网格无法抵达，需 OpenEvolve 多轴搜索
   （以 style-engine / cand-eng-cap-12 为种子，允许 3+ 权重联合变异 + acquisitionVariant 轴）。
   候选接口（`century-adversarial-candidate-v1`）与两阶段评估管线已就绪，无需新代码。

## 产物

- `training/adversarial/candidates/engine-axis-batch-v1.json`（12 候选契约，指纹逐一披露于初筛报告）
- `training/adversarial/candidates/engine-axis-confirm-v1.json`（确认批次）
- `training/reports/adversarial-league/candidates/engine-axis-screen-v1/evaluation-report.json`（600 局逐局）
- `training/reports/adversarial-league/candidates/engine-axis-confirm-v1/evaluation-report.json`（300 局逐局）
- CLI `--seed-offset`：块内续接种子分区的通用能力（本次实际消费 prereg 块 offset 1620 起 300 种子）
