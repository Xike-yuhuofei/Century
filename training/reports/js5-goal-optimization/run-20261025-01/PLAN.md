# JS5 Goal 优化计划（run-20261025-01）

日期：2026-10-25（Asia/Shanghai）
分支：`codex/js5-evidence-optimization`
基线提交：`e2361edc28b95c03ee5ccdd461c9afe0086dfe84`（main）
研究目录：`training/reports/js5-goal-optimization/run-20261025-01/`

## 1. 目标与边界

基于三份真人对局分析报告（c83f / agent-a / crest），在不改变正式规则、公开信息公平性、
正式冠军配置和正式验证账本的前提下：

1. 修复影响优化判断的计量与对照身份问题（P0）；
2. 实现并验证可泛化的临近终局候选保留（P1-C）；
3. 修复墙钟预算的批次准入与遥测（P1-D），并保持有效仲裁；
4. 用可复现回归、机制消融、独立配对评测和性能验证交付证据；
5. 只有当单席第一名配对差区间下界 > 0 时才声称"棋力提高"；否则只声明工程/局部决策改善。

**不做**：推送、远端 PR、合并 main、发布、替换 `training/champions/champion.json`、
修改晋级门槛、消费正式验证池 `[900e6,1.06e9)` 或写正式账本。

## 2. 不变约束

- 正式规则/牌表/得分/后手平分/公开观察边界不变。
- 历史隐藏牌库只用于原轨迹重放校验；反事实决策只用 `buildObservation`。
- 不硬编码对局文件、回合、卡 ID、人类席位。
- 不把模拟评价值称为胜率；不把回归通过称为棋力提高。
- 比较双方必须用显式配置；禁止用活动冠军参数冒充历史束搜索。

## 3. 基线定义（比较对象）

| 名称 | 解析配置 |
|---|---|
| webProduction | champion-guided, joint-js5, 100ms 墙钟, profile=NEUTRAL, simSeed 0, gate auto .85, cap 4, margin .02, claimRanking enumeration, worlds 4, horizon 48, rule/L2, **nearTerminal=off, screenScope=all, batchAdmission=legacy** |
| pureBeam | 显式 `legacy-champion.json`（ai5-readiness-efficiency, beam-rollout, 无 adapter） |
| historicalBeam | 归档 `ai5-readiness-efficiency.json`（剥离 adapter） |
| js5Opt | joint-js5-opt = joint-js5 + `claimRanking='prior'`（第五阶段 tune2 预设） |

基线源码/构建/配置/输入身份见 `BASELINE-MANIFEST.json`；基线可重建工作树为
`/tmp/century-js5-baseline-e2361ed`（真实路径，已构建 dist）。

## 4. 阶段

### 阶段 0：证据与基线（已完成/进行中）
- 冻结基线 manifest；修复 human-analytics v2 计量；审计配置分派。
- 交付：`BASELINE-MANIFEST.json`、`evidence/metrics-v2-summary.json`、
  `evidence/near-terminal-scan.json`、`evidence/budget-*.json`。

### 阶段 1：机制实现
- P1-C：`nearTerminalCandidate ∈ {off, replace, add}`；公开风险 + 当步正式净分 argmax。
- P1-D：`batchAdmission ∈ {legacy, balanced}`、`screenGoalScope ∈ {all, preferred}`；
  互斥分相计时、零试验原因、W×M 批次成本、全候选缩减批次、缩减批次最低 3 试验覆盖。
- 全部 opt-in；冻结冠军缺省 = legacy/off/all，固定工作量行为不变。

### 阶段 2：预测登记（本文件即预注册，运行前冻结）
**固定工作量机制消融**（5 人，方向 A 单席，classic 池，workUnits=16，开发种子 40 个）：
| 臂 | nearTerminal | screenScope | batchAdmission | 目的 |
|---|---|---|---|---|
| A0 | off | all | legacy | 冻结基线 |
| A1 | replace | all | legacy | 候选替换机制 |
| A2 | add | all | legacy | 候选追加机制（额外算力对照） |
| A3 | off | preferred | legacy | 筛选收窄机制 |
| A4 | replace | preferred | balanced | 组合候选 |

**墙钟部署对照**（5 人，方向 A，100ms，开发种子 40 个）：A0 vs A4。

**主候选预注册（在看到 pilot 结果之前冻结）**：A4 =
`nearTerminalCandidate='replace' + screenGoalScope='preferred' + batchAdmission='balanced'`
（固定工作量/墙钟共用同一配置哈希 `202074e5`；固定工作量下 balanced 不改变批次语义）。
A1/A2/A3 只用于机制归因，不参与确认选择；确认集不再筛选其他臂。

**独立确认**（冻结主候选 A4 后，goal-confirm `[1.38e9,1.39e9)`，5 人方向 A，classic 池）：
- 主指标：单席第一名率的种子级配对差 `d_i = 1[候选胜] − 1[基线胜]`。
- 区间：按完整种子簇 bootstrap 10,000 次，95% 区间。
- 辅指标：对最强对手分差、平均名次、异常/非法率、门控率、覆盖/零试验率、p50/p95/p99。
- 样本量：先导估计不一致率 `p_disc`，目标效应 8pp，α=.05 双侧，80% 功效：
  `N ≈ 7.85 × p_disc / 0.08²`。若 `N` 超过本次可执行上限，冻结可执行上限并在报告中
  明确"小于目标效应时证据不足"；不因结果改样本或种子。
- 停止规则：固定 N 一次跑完；异常率 >2% 拒绝；区间跨 0 = 证据不足，不声称非劣/提高。
- 多臂确认：只检验冻结的一个主候选；其他臂仅作开发期筛选（描述性，不作显著性宣称）。

**性能验证**：
- 1,000 个新公开局面（goal-dev 生成；覆盖开局/中局/终局/复杂支付），每例 3 次，
  单进程、预热、基线/候选随机交错；版本由独立 worktree/构建固定。
- 预注册门槛：100ms 档候选 p95 ≤ 110ms、p99 ≤ 150ms，且相对基线 p95 增量 ≤ 10ms；
  无非法行动/异常。参考值来自 c83f 建议，不是产品 SLA 承诺。

### 阶段 3：交付
- `FINAL-REPORT.md`、`EXPERIMENTS.jsonl`、日志、逐局证据、复现脚本、本地提交。

## 5. 种子纪律

- 开发/先导：`AI6_JS5_GOAL_DEV_SUBBLOCK [1.370e9,1.372e9)`（本任务登记，不写正式账本）。
- 独立确认：`AI6_JS5_GOAL_CONFIRM_SUBBLOCK [1.380e9,1.390e9)`，只在主候选冻结后使用一次。
- 性能局面：开发块内派生，仅用于性能，不进入任何胜率结论。
- 不使用正式验证池；不重复使用既有 tune2/confirm 块。
- 29 局真人记录全部是发现集，不作留出。

## 6. 失败与撤销规则

- 候选注入若导致 C06/C07/C11 等反误修案例行为改变、或 C10 未修复 → 撤销。
- balanced 若在固定工作量下改变任何决策 → 违规（必须固定工作量逐位不变）。
- 性能若 p95 > 110ms 或 p99 > 150ms → 不作为部署候选，保留实验态。
- 独立确认区间跨 0 → 保留机制为实验选项，不替换冠军，报告中明确"证据不足"。
- 任何非法行动、信息泄漏、CRN 键集不一致 → 立即停止并修复。
