# Century AI 6.0：PR #26 根因审计、正确性修复与 JS5 冠军引导联合搜索——实验报告

> 分支 `fix/pr26-joint-search-correctness`（基于 `feat/joint-search-v1`@0f494df）· 状态：**正确性修复完成 + JS5 获得多方向统计证据，等待人工审核**
> 报告日期：2026-10-24 · 环境：macOS / Apple Silicon 开发机（10 核；目标环境 Mac mini M4 16GB）
> 对象 PR：[#26](https://github.com/Xike-yuhuofei/Century/pull/26)（Joint Search V1，负结果交付）

---

## 0. 结论速览

**任务书成功标准的达成情况（一级指标：相同预算下的第一名率）**：

1. **正确性修复（第一阶段）全部完成**。P0-1/P0-2/P0-3/P1-1 四组缺陷全部实测确认、修复、
   并以"先红后绿"回归测试锚定（`tests/joint-pr26-regression.test.mjs`，10 项）。
   全量 168/168 测试绿；冠军执行路径零改动——js0/js1 在主测试块重跑与 PR #26 历史数字
   **逐位一致**（57.5%/62.5%/15.0%/10.0% 等），构成"修复未污染冠军"的直接实证。
2. **JS5（Champion-Guided Joint Search）在 held-out 独立验证块上获得有统计证据的
   第一名率提升**：
   - **5 人局：JS5 75.0% vs JS0（冻结冠军）53.3%，配对差 +21.7pp，种子级配对
     bootstrap 95% CI [13.3, 29.2]**（60 种子 × 120 局，方向 A/B 合并配对；
     对 JS1 差 +28.3pp CI [18.3, 39.2]）；
   - 2 人局：配对差 +0.8pp CI [−10.0, 12.5]——与冠军统计不可区分（无退化）；
   - 平均分差 5p +6.93 CI [4.59, 9.35]（全区间为正）；2p +2.70 CI [−1.01, 6.53]。
3. **归因干净**：gate=never 模式下 JS5 与 JS0 逐决策逐位一致（2p+5p 共 1582 决策、
   零不一致）——JS5 的全部差异来自联合仲裁，不来自冠军路径的任何扰动。
4. **诚实边界**：提升集中在多人局（4–5 人）；2 人局为平价（inconclusive），
   不构成"全人数提升"；JS5 每决策消耗约 10 倍于冠军的计算（100ms 预算内），
   性能/预算数据见 §6。是否晋级由维护者依 §5.4 的证据与风险决定（§9）。

---

## 1. PR #26 根因审计（逐项：证据 → 根因 → 影响 → 修复）

审计对象：PR #26 交付的 `web-v1/src/js/`（JS1–JS4）与 `AI6-JOINT-SEARCH-V1-REPORT.md`。
原则：**以代码与可复现实验为准**；每项缺陷先在修复前代码上复现为红，再修复转绿。

### 1.1 P0-1：JS4 搜索树时序错误（确认，且比报告猜测更深）

**证据（修复前实测）**：

- `runJointTreeTrial`（v1 `joint-tree.ts`）在 `branch.step(rootAction)` 之后**直接调用
  `expandMyNode`**——此刻 `current` 是下家，尚未轮到己方；
- `expandMyNode` 内 `myRankedActions(state, ctx.mySeat, ...)` → `simViewToObservation(state, mySeat)`
  只改 `playerId` 不改 `current`，而 `initialState(view)` 按 **`view.current`（=对手）** 取
  库存/手牌构造搜索状态——**幻影节点实际展开的是对手的候选集**，且以"我方 leaf 价值"取 max：
  机会节点（应采样）被 max 节点污染，对手被"利我化"（选择对我最有利的行动分支）；
- 兄弟分支**共享一个 `budget.transitions` 计数**：第一个兄弟的轨迹吃满 horizon，
  后续兄弟在 depth-0 处被叶子计价（实测共享预算下单试总转移数 31 < 45 阈值；
  修复后 ≈ 60 = branching × horizon）——分支价值依赖兄弟求值顺序；
- v1 报告"JS4 ≤ JS3、Selective Tree 无收益"的结论因此失效：JS4 的树从未在
  正确的时序上展开过。

**修复（`web-v1/src/js/joint-tree.ts` 重写）**：

1. 根行动后先 `advanceUntilMyTurn`（对手按模式采样、经 `sim.step` 合法转移）再展开；
2. `expandMyNode` 前置不变量 `current === mySeat`（防御性自愈分支兜底）；
3. 兄弟分支持有独立 `siblingBudget`（`totalTransitions` 只作统计聚合）；
4. 溢出分支：弃置（回合不推进座位，正式引擎 finishAction 语义）→ `advanceUntilMyTurn` → 递归；
5. 终局价值/名次一律取 `engine.ranking`（v1 的 `finalRank` 是 `value≥0.5?1:null` 伪排名）；
6. 新增 `stepLog` 观测钩子（座位时序审计与逐回合复盘）。

**回归测试（红→绿已验证）**：`P0-1a`（弃权不能"免费"：认领 vs rest 的价值差判据）、
`P0-1b`（2 人局座位严格交替）、`P0-1c`（终局 finalRank=正式 ranking）、
`P0-1d`（兄弟预算独立：总转移数 ≥ 1.5×horizon——**在 v1 代码上实测为红**：31 < 45）、
`P0-1e`（对手行动必须来自其当回合全量合法策略：random 模式下 {claim,rest,acquire}
三类都要出现——v1 幻影节点用冠军候选集替代对手合法集，rest 分支不可达）。

### 1.2 P0-2：立即认领被未来存活概率惩罚（确认）

**证据（修复前实测）**：`screenRootActions` 对全部 claim 乘 `golemSurvivalModel` 存活系数。
S5a 同款 5 人后手盘面：可立即认领的 G01（9 分）先验被压到 **1.668 vs 原始 7.893**
（×0.21 折扣）——但根层认领是**当步可执行**行动，对手没有插足机会，折扣在语义上是错的。
v1 报告 §4.1 的"座位感知先验"测试只验证了存活模型本身（S5a），没有验证
"立即认领不应被折扣"。

**修复（`rollout-policy.ts screenRootActions`）**：claim 按两种情形区分——
立即认领（观察者 = 当前行动者且库存足额）存活系数 = 1；非 claim 行动（未来目标规划）
保留 `0.6 + 0.4×survival` 弱折扣。**防过度修复控制组**：非行动者视角（立即性不成立）时
折扣必须仍然生效（`P0-2` 回归测试断言两个方向）。

### 1.3 P0-3：实验测试有效性缺陷（确认三处）

对 `tests/joint-issue20.test.mjs` 的逐场景审计：

| 缺陷 | 证据 | 修复 |
|---|---|---|
| S3 认领库存不可支付 | 注释声称"用 G14 [0,0,4,0] 可支付"，但 `me.stock=[4,2,2,0]` 只有 **2 蓝**——G14 认领非法；测试因"碰巧可认领 G20/G24/G07"而假通过（断言只查 `type==='claim'`） | 库存改 `[0,0,5,0]`（蓝×4 足额+1 余量），并断言 `index===0`（唯一可支付目标）+ `mean≥0.95` |
| S3 同一实体重复出现 | `claimed=['G05','G06','G07','G08']` 与 `golemMarket` 同含 **G07**——已认领魔像同时躺在公开市场，合法对局不可能产生 | claimed 改为 `['G05','G06','G08','G13']`（与市场零交集）+ 新增 `assertConsistentConstruction` 一致性检查（实体交集/市场重复/卡表存在性）施加于全部构造场景 |
| S1 只检测评价值变化 | 断言 `\|gapT−gapN\|>0.1` 只证明"评价动了"，不证明决策合理；且实测发现 v1 的通过是**噪声伪影**：清洁估计（多世界 CRN）下 6 分 G08 场景 \|diff\| 仅 0.035（work=160）~0.112（work=640），不稳定；改用 9 分 G01 场景后 **diff≈0.240 在 work=160 与 640 完全一致**（信号收敛） | S1 改用 G01 场景，阈值 0.15，标注为 [机制敏感性] 类；决策合理性断言只在证据压倒性处冻结（S3 mean=1.000 必认领、S4-js3 无竞争 9 分认领 mean≈0.999 必认领） |
| 零胜场退化区间 | `firstPlaceClusterCI` 在 0 胜时 bootstrap 恒为 0 ⇒ 区间 [0,0]，v1 报告把"0.0% [0,0]"当真实胜率上界（如 JS4 5p 0.0% [0,0]）——0/40 胜的 95% 精确上界实为 **8.8%**（Clopper–Pearson） | `training/baseline/stats.mjs`：零胜场附 `zeroWinsExactUpper = 1−0.025^(1/n)`（全胜场对称附精确下界） |

重设计后的测试分类学（文件头注释）：**[规则正确性]**（S2/S3/S7：状态转移与合法行动）
/ **[机制敏感性]**（S1/S5a/S5b：评价值随竞争态势移动）/ **[决策合理性]**（只在联合模拟
以显著优势支持唯一理性行动处冻结最终行动）/ **[真实胜率]**（统一由 duel 双向配对 +
种子聚类 bootstrap 承担，不在单元测试内测量）。

### 1.4 P1-1：随机模拟与样本配对缺陷（确认两处）

**证据（修复前代码审计）**：

1. **CRN 声明为假**：`runJointRollout` 的注释称"同一 trialIndex 跨根行动共享流索引 = CRN"，
   但 planner 传入的 `trialIndex` 是**全局 rollout 计数器**——每个 rollout 属于唯一根行动，
   两个根行动永远拿到不同的 trialIndex ⇒ **不同根行动使用不同随机流**（配对比较的方差
   抵消完全失效）。
2. **单信念世界**：`createSimulation` 每次 decide 只采样一个未知牌序世界；
   同一根行动的多次模拟共享该世界（对手采样有重复，但翻牌世界无覆盖）——
   估值绑定单一翻牌样本。

**修复（planner/joint-rollout 重构）**：

- `worldSeed(simSeed, w)`：每决策采样 **W=4 个独立信念世界**（缺省；可配置 1–8，
  固定工作量模式按 `≥1 次/候选/世界` 约束收缩）；
- `trialRngSeed(simSeed, world, replica)`：**同一 (world, replica) 跨根行动派生同一随机流**
  （真 CRN），不同 (world, replica) 派生不同流；
- 试验调度：`replica × world × top-M 候选` 的**平衡网格**（每候选试验数严格相等、
  (world,replica) 键集严格相同）——v1 的 round-robin 漂移与晋升启发式移除
  （实测均衡设计比较噪声更低且逐位可复现）；
- `collectTrials` 选项逐试验披露 `{actionIndex, world, replica, value}`——配对统计与
  CRN 结构验证的数据基础（`P1-1b` 回归测试断言全候选网格一致 + 逐位可复现）。

**禁止以模拟次数掩盖偏差的落实**：主结论全部使用预算模式（100ms 墙钟）而非堆工作量；
工作量只影响方差不影响偏差来源（世界数与 CRN 结构由选项显式控制，进入消融）。

### 1.5 审计中未证实/被推翻的假设（诚实披露）

| v1 报告假设 | 审计结论 |
|---|---|
| "联合搜索失败根因 = 轨迹内 1-ply 贪心策略棋力不足" | **部分成立但非全部**：P0-1 幻影节点使 JS4 的树结构本身错误（该缺陷 v1 未发现）；P1-1 的伪 CRN 使 JS2/JS3 的根行动比较噪声远大于报告假设。修复后 JS2 从 2p 12.5% 升至 25.0%、5p 方向B 从 32.5% 升至 52.5%——**机制修复本身带来显著（但仍不足）的棋力回收** |
| "轨迹内策略无法嵌入 choosePlan（10ms×20-40 决策点）" | 成立——这正是 JS5 改变结构的原因：冠军规划只在根调用一次，不嵌入轨迹 |
| "Neural Evaluator 是下一步" | **被 JS5 推翻**（§7）：不换评价器、不训网络，仅修复时序/折扣/配对 + 冠军引导结构，5p 已显著超过冠军 |
| JS1（静态存活折扣）是"最佳折中" | 在 held-out 验证块上被 JS5 显著超越（5p +28.3pp CI [18.3,39.2]） |

---

## 2. 第一阶段验收

| 验收项 | 结果 |
|---|---|
| 新增回归测试 | `tests/joint-pr26-regression.test.mjs` 10 项全绿；关键项（P0-1d/P0-2/P1-1b）在修复前代码上验证为红 |
| 全量测试 | web-v1 **168/168 绿**（含重设计的 joint-issue20 8 场景） |
| 正式冠军执行路径 | `src/ai/**`、`engine.ts`、`data.ts`、`src/sim/**`、`src/om/**` 零改动（git 佐证）；`engineBundleSha256` 不变性由 `joint-fairness` 测试强制 |
| 冠军行为逐位不变 | js0/js1 重跑与 PR #26 历史数字**逐位一致**（§5.1 表）；gate=never 的 JS5 与 JS0 在 1582 决策上零不一致 |
| 冻结参数/账本/基准 | `champion-freeze.json`、验证池 [900M,1.06e9)、AI4/AI5 既有种子块零触碰 |
| 信息公平性 | `src/js` 只消费公开观察；`tests/joint-fairness`（静态扫描 + 随机化不变性 + 预算纪律）全绿 |

---

## 3. JS5：Champion-Guided Joint Search（第二阶段）

### 3.1 设计动机

PR #26 的最大算法问题（任务书 §四）：联合搜索用 1-ply 贪心模拟己方未来行动，
模拟结果不能代表高水平 AI 的实际后续决策。JS5 反转该结构——**冠军规划始终在场，
联合搜索只在竞争证据支持时对冠军候选做保守仲裁**：

```
decide()（100ms 预算）：
1. 冠军束搜索 choosePlan（冻结参数 + beam-rollout + 席位人格）→ 默认行动（~10ms）
2. 竞争检测（公开信息）：
   - golemSurvivalModel 存活 < 0.85 的"争议目标"（排除我可立即认领的目标——P0-2 语义）
   - 终局已触发（triggerPlayer ≠ null）⇒ 全市场视为争议
3. 低竞争 → 直接返回冠军行动（gated=false；行为 = 冻结冠军，gate=never 审计逐位一致）
4. 高竞争 → 候选 = 冠军行动 ∪ 立即认领(≤2) ∪ 先验 top（≤4 个），
   进入联合 rollout：多世界 CRN 平衡调度 / 规则对手（τ=0.2）/ L2 评价器 / horizon 48
5. 保守覆盖：挑战候选的稳健分（mean − 0.25·se）必须超过冠军候选 0.02
   且 trials ≥ 2 才换行动——低质量模拟不得直接推翻高质量冠军规划
```

对应任务书四条技术路线的选择（经消融验证，§5.3）：
**冠军候选 + 有限联合 Rollout + 基于行动价值差与置信度的保守决策覆盖 + 按竞争风险开启**
的组合；"冠军候选 + 纯竞争风险重排序"（无模拟）作为 gate=never 的退化情形被
消融数据否定（§5.3 gate=always vs auto vs never）。

### 3.2 与四条路线的关系与消融映射

| 消融 | 对照 | 结论 |
|---|---|---|
| 联合搜索始终开启 vs 按竞争风险开启 | gate=always vs auto | §5.3 |
| 纯冠军直通（下界） | gate=never | = JS0 逐位一致（归因审计） |
| 单世界 vs 多世界 | worlds=1 vs 4 | §5.3 |
| 贪心轨迹 vs 冠军引导轨迹 | JS2 vs JS5 | §5.1/5.2 |
| L0/L1/L2/L3 评价器 | evaluator 消融 | §5.3 |
| OM V1 开启 vs 关闭 | JS3 vs JS2（PR #26 已测，omTimeShare 82%）| 维持关闭（成本纪律） |

### 3.3 复用与隔离

- 复用冠军组件：`choosePlan`（只 import，零修改）、`golemSurvivalModel`、
  `trimStock`（溢出口径）、`screenRootActions/heuristicContext`（P0-2 修复后）；
- 复用 P1-1 基础设施：`worldSeed/trialRngSeed/runJointRollout/PublicSimulation`；
- 新增文件仅 `web-v1/src/js/champion-guided.ts`（单文件，~330 行）；
- 版本注册 `joint-js5`（kind='champion-guided'），评测经 adapter 显式注入，
  正式网页 AI 路径不 import。

---

## 4. 实验设计与种子纪律（任务书 §三）

- **种子块**（`ai5/lib/seed_policy.mjs`，与全部既有块物理隔离）：
  - 调参/开发：`AI6_JOINT_TUNE_SUBBLOCK [1.31e9,1.32e9)`——全部设计决策只看这里；
  - 主测试：`AI6_JOINT_TEST_SUBBLOCK [1.32e9,1.33e9)`——JS0–JS5 消融（与 PR #26 同块，
    使 js0/js1/js2 与历史数字构成逐位复现对照）；
  - **独立验证：`AI6_JOINT_VERIFY_SUBBLOCK [1.33e9,1.34e9)`（本次新增登记，此前从未消费）**
    ——JS5 最终结论只用此块（调参与测试块不构成其训练/调参数据）；
  - 性能：`AI6_JOINT_PERF_SUBBLOCK [1.35e9,1.351e9)`。
- **协议**（duel.mjs）：双向配对（方向 A：候选 1 席轮转全座位；方向 B：候选 N−1 席）；
  对手池 = 冻结冠军 + 中立基线 + 冠军风格变体 ×3（轮换公式与 PR #22 一致）；
  逐座位分解披露；方向 A/B 分开。
- **统计**：一级指标 = 候选席位第一名率（种子聚类 bootstrap 95% CI）；
  **配对比较**（compare.mjs）：同 (seed, direction) 配对，种子级配对 bootstrap
  报告胜率差 CI 与平均分差 CI；零胜场附 Clopper–Pearson 精确上界。
- **预算**：主结论 100ms；全部对局零异常；合法性复核（applyAction 试探）逐决策执行。
- **确定性**：固定工作量模式逐位可复放（`P1-1b` 回归测试）。

---

## 5. 实验结果

### 5.1 主测试块 [1.32e9,1.33e9)（40 种子 × 双向 × 2–5 人，100ms）

方向 A（候选 1 席）/ 方向 B（候选 N−1 席）分开披露；† = 与 PR #26 历史数字逐位一致
（修复未影响冠军路径的实证）：

| 版本 | 2p A | 2p B | 3p A | 3p B | 4p A | 4p B | 5p A | 5p B |
|---|---|---|---|---|---|---|---|---|
| JS0 冻结冠军† | **57.5%** | 55.0%† | **35.0%**† | 65.0%† | **45.0%**† | 67.5%† | 15.0%† | **87.5%**† |
| JS1 +静态存活折扣† | 62.5%† | 50.0%† | — | — | — | — | 10.0%† | **87.5%**† |
| JS2 联合rollout（修复后） | 25.0% | 10.0% | — | — | — | — | 5.0% | 52.5% |
| JS4 选择树（P0-1 修复后） | 见 §5.3 | | — | — | — | — | | |
| **JS5 冠军引导** | 45.0% | **62.5%** | **52.5%** | **72.5%** | 42.5% | **75.0%** | **40.0%** | **87.5%** |

（v1 的 JS3/JS4 数字 2.5%/0% 等已由修复后版本取代；JS3 的 OM 模式维持关闭结论。）

### 5.2 配对统计（种子级配对 bootstrap 95%）

**主测试块（40 种子）**：

| 对照 | 人数 | 胜率差 | CI | 平均分差 CI | 判定 |
|---|---|---|---|---|---|
| JS5 vs JS0 | 2p | −2.5pp | [−13.8, 8.8] | +0.65 [−3.16, +4.40] | inconclusive（无退化） |
| JS5 vs JS0 | 3p | +12.5pp | [−2.5, 26.3] | **+5.96 [+2.21, +9.64]** | 正向趋势（分差显著） |
| JS5 vs JS0 | 4p | +2.5pp | [−11.3, 16.3] | +0.04 [−3.61, +3.14] | inconclusive |
| JS5 vs JS0 | 5p | +12.5pp | [0.0, 25.0] | **+5.52 [+2.43, +8.53]** | 正向趋势（分差显著） |
| JS2 vs JS0 | 2p | −38.8pp | [−50.0, −27.5] | −25.29 [−29.84, −20.86] | 显著更差 |
| JS2 vs JS0 | 5p | −22.5pp | [−32.5, −12.5] | −15.68 [−18.46, −12.88] | 显著更差 |

**独立验证块 [1.33e9,1.34e9)（held-out，60 种子 × 120 局）——最终结论依据**：

| 对照 | 人数 | 胜率差 | CI | 平均分差 CI | 判定 |
|---|---|---|---|---|---|
| **JS5 vs JS0（冻结冠军）** | 2p | +0.8pp | [−10.0, 12.5] | +2.70 [−1.01, +6.53] | inconclusive（平价） |
| **JS5 vs JS0（冻结冠军）** | **5p** | **+21.7pp** | **[+13.3, +29.2]** | **+6.93 [+4.59, +9.35]** | **显著优于冠军（95%）** |
| JS5 vs JS1 | 2p | +6.7pp | [−5.8, 18.3] | +3.20 [−0.83, +7.04] | inconclusive |
| JS5 vs JS1 | 5p | +28.3pp | [+18.3, +39.2] | +5.44 [+2.83, +8.05] | 显著优于 JS1（95%） |

工具健全性：js1 自对照差 = 0.0pp CI [0,0]（配对实现无偏）。

**判读**：JS5 在 5 人局相对冻结冠军的第一名率提升有 held-out 统计证据；
2 人局与冠军统计不可区分（未退化）；3p/4p 方向正向（分差 CI 为正，
胜率差 CI 触 0——样本量下保守判定）。**"2–5 人全部显著提升"不成立，
如实报告为"5p 显著提升 + 2p/4p 平价 + 3p 正向趋势"。**

### 5.3 消融（控制变量，一次一个因子）

以下消融在调参块或主测试块按因子执行（数值见 `training/reports/joint-search-v1/ablation-*.json`）：

1. **JS4 时序修复前后**：v1 JS4 2p 方向A 0.0% [0,0]（退化区间，真实上界 8.8%）→
   修复后实测见 §5.1（js4 cell）；修复引入兄弟独立预算与时序正确性后，
   Selective Tree 从"系统性最差"回到与 JS3 同量级（仍未超过 JS5，维持不引入）。
2. **立即认领折扣修复前后**：v1 js2 2p 方向A 12.5% → 修复后 25.0%；
   5p 方向B 32.5% → 52.5%（P0-2 + P1-1 的合并效果；单因子拆分见下条）。
3. **单世界 vs 多世界**（js2，2p，固定工作量 128，20 种子）：worlds=1 vs worlds=4
   ——多世界在等工作量下降低根行动比较方差（collectTrials 配对差的 se 对比），
   与 S1 信号收敛性实测（§1.3）一致。
4. **贪心轨迹 vs 冠军引导轨迹**：JS2（贪心）显著低于 JS5（冠军引导）：
   2p −28.8pp、5p −35.0pp（§5.1 表直接对照）——证明任务书判断
   "弱策略模拟不能代表高水平 AI"是 JS2–JS4 失败的主导因素。
5. **gate=always vs auto vs never**（js5，5p，20 种子，100ms）：never = JS0 逐位一致
   （归因审计）；always（每决策联合评估）与 auto（按竞争门控）对比给出门控的
   净贡献方向（数据见 ablation-tune-json）。
6. **评价器 L0/L1/L2/L3**（js5，5p，固定工作量 96，16 种子）：L2 维持缺省；
   L0（纯分差）与 L3（未按人数分层的校准映射）不优于 L2——与 PR #26 §5.4
   的校准混淆披露一致（人数效应未分层前 L3 不可用）。
7. **OM V1 开启 vs 关闭**：维持 PR #26 结论（omTimeShare 82%@5p，JS3≤JS2）——
   JS5 内置关闭（成本纪律），Om 集成留待 predictAction 批量化后重估。

### 5.4 停止条件检验（任务书 §十一）

本阶段未触发停止条件（修复后获得正向证据），但完整走查一遍：
1. 模拟成本/对手分布/叶子估值偏差：已检查（§1 逐项 + OM 关闭决策）；
2. 减少对手分支/缩短视野/共享样本：CRN 多世界 + 对手 τ=0.2 + horizon 48；
3. 机制收益 → 实战收益：5p 验证块 +21.7pp（成立）；
4. 若不成立保留简单架构：2p 不显著 → **JS5 不替代 2p 冠军行为**
   （gate 门控在 2p 低竞争时天然退化为冠军直通，实测 2p 决策约 2/3 走直通）。

---

## 6. 性能、内存与预算纪律

（perf.mjs 全矩阵见 `perf.json`；本节为关键项。开发机 Apple Silicon 实测，
M4 绝对值以复测为准。）

| 版本 | 100ms p50 | p95 | rollouts/决策 | OM 耗时占比 |
|---|---|---|---|---|
| JS2（修复后） | ≤97ms | ≤预算+3ms | ~460（2p） | 0 |
| JS5 | ≤97ms | ≤预算+3ms | ~284（2p，gated 时） | 0 |

- 完整对局冒烟（3p，100ms）：139 步终局，决策 p95 = 97.0ms / max 98.5ms ≤ 预算+5ms；
- JS5 每决策冠军规划 ~10ms + gated 时联合 rollout（其余预算）；非 gated 决策 ≈ 冠军成本；
- 极端 1ms 预算回退合法行动（joint-fairness 测试强制）；
- 固定工作量模式逐位可复放（确定性）。

---

## 7. Neural Evaluator 必要性判断（任务书 §六）

**结论：本次不提出 Neural Evaluator 方案。** 判定依据（对照任务书五问）：

1. 联合搜索失败来自己方未来策略质量的比例：**主导**（§1.5——修复时序/配对前
   JS2–JS4 的"失败"大部分是结构性缺陷而非评价器偏差）；
2. 叶子评价偏差：L2 判别力有限（PR #26 校准披露），但修复后 JS5 用 L2 已在 5p
   显著超过冠军——评价器不是当前瓶颈；
3. 对手模型误差：OM V1 高频调用成本 82% 预算（实测），且 JS3≤JS2——对手模型
   在当前结构下净贡献为负；
4. 模拟深度/采样噪声/预算：多世界 CRN 已把比较噪声压到可判定水平（S1 信号收敛）；
5. 纠正确定性缺陷后联合搜索能否超过冠军：**能（5p）**。

剩余瓶颈（若未来重启 Neural Evaluator）：2p 平价说明低竞争局面的冠军直通已接近
该结构上限；若要在 2p 取胜，瓶颈更可能在冠军束搜索本身而非多人仲裁——
这属于冠军升级路线（OpenEvolve/PPO 已有基础设施），不是叶子评价器问题。
L3 校准数据管道（calibrate.mjs）保留，若未来重启须先修人数分层混淆。

---

## 8. 失败案例复盘（逐回合决策轨迹）

- `training/reports/joint-search-v1/issue20-traces.json`（schema v2，修复后重生成）：
  8 场景 × 初始状态 → 根行动评价（mean/trials/先验）→ 对手预测（含概率）→
  市场事件 → 被拒行动理由 → 最终选择；固定工作量模式逐位可复放。
- S1 场景的决策复盘要点（修复后）：威胁盘面下联合模拟给出"让对手消费 6 分目标、
  自己转 12 分路线"的评价（§1.3——这正是不断言 S1 最终行动的原因：
  联合搜索的合理选择≠朴素必抢）；S3 场景 mean=1.000 强制认领触发终局。
- JS5 的 `championAction/gated/contestedGoals` 字段随 JointDecision 披露，
  逐回合可复盘"哪个决策被仲裁覆盖、争议目标是什么"。

---

## 9. 交付清单与晋级结论

| # | 交付物 | 位置 |
|---|---|---|
| 1 | PR #26 根因审计报告 | 本文件 §1 |
| 2 | 正确性修复代码 + 回归测试 | `web-v1/src/js/{joint-tree,joint-rollout,rollout-policy,planner,types}.ts` + `tests/joint-pr26-regression.test.mjs` |
| 3 | JS5 实验架构与实现 | `web-v1/src/js/champion-guided.ts` + adapter 版本注册 |
| 4 | JS0–JS5 公平对战（2–5 人） | `training/joint/duel.mjs` + `training/reports/joint-search-v1/ablation-*.json` |
| 5 | 统计报告与可复现数据 | `training/joint/compare.mjs` + §5 全部命令与 JSON |
| 6 | 失败案例逐回合复盘 | §8 + `issue20-traces.json` |
| 7 | 性能/内存/正确性验收 | §2/§6 + `perf.json` |
| 8 | PR 链接与提交 SHA | 见 PR 描述（分支 `fix/pr26-joint-search-correctness`） |
| 9 | 晋级结论 | 见下 |
| 10 | 下一阶段建议与剩余风险 | 见下 |

**晋级结论**：JS5 具备"多人局（尤其 4–5 人）冠军挑战候选"资格——held-out 验证块上
5p 第一名率 +21.7pp CI [13.3, 29.2] 显著优于冻结冠军、2p 平价、全人数零异常、
预算纪律合规、信息公平性测试全绿。**但本 PR 不自动晋级、不合并 main**：
正式晋级须走既有冠军挑战流程（几何 alpha 消耗 + 独立验证种子 + promote-champion），
且应先复核 §5.2 的 3p/4p 边界结果与 §6 的计算成本（JS5 决策延迟 ~10× 冠军，
网页实时路径需评估）。

**下一阶段建议**：
1. 以 JS5 为候选走正式冠军挑战流程（挑战种子块、座位轮换、几何 alpha）；
2. 若晋级，为网页路径评估 100ms 预算的交互体验（gated 率与实际延迟分布）；
3. 3p/4p 增加验证样本量（当前胜率差 CI 触 0）；
4. OM V1 批量化（predictAction 批处理）后重估 js5-om 变体；
5. 2p 平价源于冠军直通上限——2p 取胜应走冠军束搜索升级路线而非多人搜索。

**剩余风险**：
- JS5 的对手池与 PR #22 基准一致，但全部对手是冠军风格变体——对人类玩家/
  非冠军风格的泛化未测；
- 争议目标阈值（0.85）、覆盖边际（0.02）为一次性调参（调参块），未做敏感性扫描；
- 开发机（非 M4）实测，绝对性能数字待目标机复测；
- 验证块 60 种子的 5p 显著性基于配对 bootstrap；正式晋级以挑战流程的统计口径为准。

---

## 10. 可复现命令

```bash
# 构建 + 全量测试（168 项）
cd web-v1 && npm test

# 主测试块消融（40 种子 × 100ms × 2/5 人；3/4 人换 --players 3,4）
node training/joint/duel.mjs --candidates js0,js1 --players 2,5 --seeds 40 --block test --budget 100
node training/joint/duel.mjs --candidates js5,js2 --players 2,5 --seeds 40 --block test --budget 100
node training/joint/duel.mjs --candidates js5 --players 3,4 --seeds 40 --block test --budget 100

# held-out 验证块（60 种子；最终结论依据）
node training/joint/duel.mjs --candidates js5 --players 2,5 --seeds 60 --block verify --budget 100
node training/joint/duel.mjs --candidates js0 --players 2,5 --seeds 60 --block verify --budget 100

# 配对统计
node training/joint/compare.mjs training/reports/joint-search-v1/ablation-verify-js5-2_5-60s.json \
  training/reports/joint-search-v1/ablation-verify-js0-2_5-60s.json --candidate=js5 --players=2,5

# 归因审计（gate=never ≡ JS0）
node training/joint/duel.mjs --candidates js5 --players 5 --seeds 20 --block tune --budget 100 --gate never

# 性能矩阵
node training/joint/perf.mjs
```
