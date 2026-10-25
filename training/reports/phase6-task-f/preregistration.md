# 任务 F 预注册：多人竞技确认协议（第六阶段）

预注册时间：2026-10-25（实验启动前落盘；候选身份在机制筛查后锁定并在本文件补记）

## 比较对象

- **候选**：`joint-js6`（第六阶段实验候选；组合 = js5 语义 + C2 racing + C4
  claimFocus；worlds/cap/evaluator/opponentMode 保持 JS5 缺省，除非单因子
  筛查显示可靠正向证据后升级——筛查结果与最终组合在锁定时补记于 §5）；
- **基线**：`joint-js5-frozen`（PR #30 正式冠军，注册表冻结描述符）；
- **参考臂（成功条件 B）**：`joint-js5-frozen@highBudget`（同算法 500ms）——
  若 JS6 无显著优于同预算 JS5，但高预算 JS5 稳定优于 100ms JS5，则高预算
  版本作为值得挑战的候选披露；
- 候选与基线共享种子（配对设计）；候选席不进对手池（duel 机制自动排除候选
  本体席位，池内冠军席=joint-js5-frozen 属于"场域"定义）。

## 种子（全新，此前未消费）

`AI6_PHASE6_CONFIRM_SUBBLOCK [1.382e9, 1.4e9)`：
seedBase = 1.382e9 + (人数−2)×3e6 + (diverse ? 1.5e6 : 0)。

## 设计（覆盖任务书 §九 F2/F3）

- **人数**：2/3/4/5 全覆盖；
- **对手池**：classic（强对手池：当前冠军 + 中立 + 冠军族风格变体）与
  diverse（多结构混编池：当前冠军 + AI4 历史冠军 + 手调风格 + random-legal）
  ——两池独立评测维度，分开披露；
- **模式**：单席位对混合对手（方向 A，主判定）+ 候选阵营（方向 B，辅助）+
  直接对抗（js6 vs js5-frozen 头对头即配对比较本身）；
- **预算**：JS6 与 JS5-frozen 均 100ms（实战默认档）；另设 500ms 对照格
  （预算敏感性，secondary）；
- **样本量**：每 (人数, 池) 150 种子（方向 A/B 双向 = 600 局/候选/格）——
  基于 A2 经验（200 种子 CI ±8pp 合并口径），150 种子对 ≥8pp 效应有 ~80%
  检出力；2p 格加至 200 种子（历史效应较小）；
- **种子聚类配对 bootstrap**（compare.mjs 五类拒绝性校验）；
- **多重检验**：主族 = 4 人数 × 2 池的方向 A 对照（family=8 Bonferroni）。

## 主要终点与判定

1. **单席位第一名率差（方向 A，js6 − js5-frozen，每人数×池）**——核心指标；
2. 判定「JS6 超越正式 JS5」：family=8 校正后 CI 下界 > 0 的人数×池格数
   ≥ 1 且全格无显著退化（CI 上界 < 0 的格数为 0）；
3. 平均名次/分差/门控率/覆盖率为辅助披露；错误模拟放大检查 = 联合搜索
   统计的饥饿回退率与 override 率逐格披露（任务书 §14.6）。

## 纪律

- version-gate 门禁前置（PASS 才运行）；
- 所有格子记录 codeCommit（启动时）+ 版本注册表快照 + 机器/负载剖面；
- 异常局拒绝计入；零胜/全胜格 Clopper–Pearson 精确界；
- 结果无论正负均如实披露；不晋级、不覆盖 champion.json（正式晋级走既有
  验证池 + 几何 alpha 管线，须人工批准）。

## 5. 候选身份锁定（2026-10-25 12:20，筛查后补记）

**候选 = `joint-js6`（组合 = js5 语义 + C2 racing + C4 claimFocus，budgetMs=100）**。

锁定依据（全部为筛查/矩阵信号，非确认结论）：
- B 矩阵同预算对照：JS6 vs JS5 @100ms 在 5p **+13.0pp [2.0,24.0] 显著**；
  其余 7 格平价、无显著为害（budget-curve.md §对照）；
- B 矩阵阶梯：JS6@100 (37%) ≈ JS5@500 (35%)（5p）——racing 在紧预算档抵偿
  5 倍算力；
- 单因子筛查（5p@500ms，30 种子，tune 块）：worlds8/16、cap6/8 全部负趋势
  （否决——稀释每候选试验深度，证实任务书 C3 预言）；omV1 **−25pp 显著有害**
  （D1 定论：OM V1 不进默认路径）；racing/claimFocus 单独在 500ms 平价
  （其价值在紧预算档，与 B 矩阵一致）；evaluatorL3/gateAlways 平价；
- **被否决组件**：worlds>4、candidateCap>4、om-v1、L3（默认路径）——均无
  可靠正向证据；
- **F 确认预算 = 100ms（实战档）**：JS6 的证据集中在该档；500ms 档 JS6≈JS5，
  高预算场景推荐 JS5（无需要求 JS6）。

## 6. 确认运行配置

- duel `--candidates js6,js5 --players N --seeds {150|200} --block phase6-confirm
  --pool {classic|diverse}`（同 (人数,池) 双候选共享种子 = 配对）；
- 4 workers（每人数一路）；caffeinate 防睡眠；结果目录
  training/reports/phase6-task-f/。

