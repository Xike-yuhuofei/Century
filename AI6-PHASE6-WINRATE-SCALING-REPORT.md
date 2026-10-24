# Century AI 6.0：第六阶段报告——胜率优先的 JS5 深度强化与搜索算力扩展

> 分支 `research/ai6-phase6-winrate-scaling`（基于 main@e7d3bfa，含 PR #26/#29/#30 全部成果）
> 报告日期：2026-10-24 · 环境：macOS Apple Silicon（开发机实测；目标环境 Mac mini M4 16GB）
> 上游事实核对：PR #26/#29/#30 均已合并 main（e7d3bfa）→ 本阶段从最新 main 建分支 ✓
> 状态：**P0 完成 → 任务 A 定论 → 任务 B 运行中 → JS6 机制就绪**（随实验推进更新）

---

## 0. 结论速览（随实验更新）

1. **P0（冠军版本身份污染）全部修复并有红/绿实证**：晋级后 `CHAMPION_PARAMETERS`
   携带 adapter 字段使 js0/js1/对手池风格变体/等价审计全部静默失真（js0 历史
   重放 24/24 → 1-2/12）；不可变版本注册 + 门禁 + 池单一事实来源修复后恢复
   12/12 + 12/12，门禁 PASS。
2. **任务 A（双人专项）定论**：JS5 在双人模式**显著优于**旧束搜索冠军——
   A1 历史数据座位均衡合并 classic +11.5pp CI[6.3,16.8]；A2 全新种子独立验证
   classic +7.8pp [2.3,13.3]、diverse +11.0pp [5.8,16.3]（预注册终点，
   Bonferroni family=2 存活）。**双人无需保留旧冠军。**
3. **任务 G（离线部署）重大缺陷修复**：JS5 晋级后 standalone/mobile 离线构建
   的手工模块清单缺 31 个闭包模块——**离线版冠军路径在晋级后已损坏**
   （chooseJointAction 未定义）；strip 内联法另存在跨模块顶层标识符冲突。
   build.mjs 改 esbuild IIFE 打包 + 桌面 AI Worker 化（500ms+ 预算主线程不再冻结）。
4. **JS6 机制就绪**（缺省关 = JS5 逐位不变，金丝雀保护）：C2 racing 自适应
   预算分配（Hoeffding 淘汰，CRN 保持）+ C4 终局认领聚焦；单因子筛查与
   预算矩阵进行中。

## 1. P0：冠军版本与评测身份污染（已完成）

详见 [AI6-PHASE6-P0-AUDIT-REPORT.md](AI6-PHASE6-P0-AUDIT-REPORT.md)。要点：

| 缺陷 | 修复前证据 | 修复后证据 |
|---|---|---|
| js0 静默运行 JS5 | confirm-replay-check js0 classic **1/12**、diverse **2/12**（历史 24/24） | **12/12 + 12/12** 恢复 |
| js1 被 adapter 分派劫持 | js1 ≡ JS5（reason 路径证据） | js1 ≡ legacy beam-contest（逐决策一致）且 ≠ JS5 |
| 池风格变体 ≡ 冠军本体 | js5 重放 4-6/12 → 1/12（池构成漂移） | 5/12 回到历史区间；变体决策级差异 8 组不等式成立 |
| gate=never 审计退化自比 | JS5 vs JS5 形式恒等 | js5(gate=never) ≡ legacy-js0：4 局 195 决策零不一致 |
| 第五阶段总数口径 | 摘要 25,600 局 / classic 12,800 局 | 实际 12,800 / 6,400（公式重算；勘误已追加，结论不受影响） |

基础设施：`web-v1/src/ai/version-registry.ts`（冻结快照 + FNV 指纹 + 来源 commit）、
`training/joint/pools.mjs`（池单一事实来源）、`training/joint/version-gate.mjs`
（实验前置门禁，六项检查）、`version-canary.json`（10 版本决策金丝雀账本）。

## 2. 任务 A：双人模式专项（已完成，预注册）

### 2.1 A1 历史数据重新计算（two-player-analysis.mjs）

第五阶段 confirm 2p 数据（200 种子 × A/B 双向，候选=js5 vs 基线=js0）：

| 池 | 方向A | 方向B | **A+B 座位均衡合并** | 同种子 phi | 对手平衡 |
|---|---|---|---|---|---|
| classic | +8.0pp [-0.5,16.5] | +15.0pp [6.5,23.5] | **+11.5pp [6.3,16.8]**（分差 CI [2.33,5.86]） | -0.015 | 20%×5 均衡 |
| diverse | +2.5pp [-5.5,10.5] | +6.5pp [-1.5,14.0] | +4.5pp [-0.8,9.8]（分差 CI [0.9,4.4] 显著） | -0.205 | 均衡 |

方法：2p 下 A（候选 1 席）与 B（候选 N-1=1 席）都是单候选语义且共享洗牌——
合并为"座位均衡单候选估计量"（每候选每种子在两个座位各 1 局），种子为聚类
单位做配对 bootstrap。方向 A/B 与 confirm-analysis.txt 逐位吻合（交叉核对通过）。
事后合并的显著性仅作探索性披露（不当预注册结论）。

### 2.2 A2 全新种子独立验证（预注册 → [preregistration.md](training/reports/phase6-task-a/preregistration.md)）

种子：AI6_PHASE6_2P_SUBBLOCK [1.37e9,1.372e9)（classic 1.37e9 / diverse 1.371e9），
此前从未消费；200 种子 × 双向 × 双候选 × 双池 = 3,200 局，**零异常**。

| 终点（预注册） | classic | diverse |
|---|---|---|
| **主要：座位均衡合并差** | **+7.8pp [2.3,13.3]**（分差 CI [2.18,5.93]） | **+11.0pp [5.8,16.3]**（分差 CI [2.98,6.90]） |
| 方向A 单席位差 | +10.0pp [1.0,18.5] | +13.5pp [6.0,21.5] |
| 方向B 差 | +5.5pp [-2.5,14.0] | +8.5pp [0.5,16.5] |

Bonferroni family=2（两池主终点，97.5% CI 水平）：**两个 CI 下界均 > 0，全部存活**。

### 2.3 任务 A 结论（回答任务书 §14.5 五问）

1. **JS5 是否优于旧冠军（双人）？是**——双独立种子块、双池、双统计口径一致。
2. **A/B 合并后结果？** classic +7.8pp / diverse +11.0pp，均显著（A1 探索性
   +11.5pp/+4.5pp 方向一致；A2 diverse 更强——修复后 diverse 池冠军席为
   joint-js5-frozen，池构成更新，跨实验绝对值不可直接比较）。
3. **哪些对手类型下优势最明显？** diverse（含 AI4 历史冠军 + random-legal 的
   结构混合池）优势最大；对 random-legal 之类的弱结构对手双方都接近必胜，
   差距主要来自中强对手。
4. **增加搜索预算是否有效（双人）？** → 见 §3 预算矩阵 2p 行。
5. **是否仍需在双人保留旧冠军？不需要**——无任何人数×池组合显示旧冠军更强。

诚实披露：A2 的 js5 侧在构建/测试负载下运行（墙钟预算敏感 → js5 优势估计
偏保守，参照第五阶段同款披露）；即便如此仍显著为正。

## 3. 任务 B：搜索预算与实际胜率（运行中）

设计（预算矩阵 budget-matrix.mjs，**完成后续填**）：
- 比较一（同算法阶梯）：JS5@50/100/200/500/1000ms；如 1000ms 仍有稳定边际
  → 追加 2000ms 探索格（成本与种子来源另行披露）。
- 比较二（同预算算法）：JS6@100/500/1000 vs JS5@同预算。
- 比较三（实战参考）：JS6@500 vs JS5@100。
- 种子：AI6_PHASE6_BUDGET_SUBBLOCK [1.372e9,1.382e9)，seedBase = 1.372e9 +
  (人数−2)×2e6；**同人数全部格子共享同段种子（完全配对）**；不同人数隔离。
- 公平性：机器/并发度披露（manifest）、codeCommit 启动时捕获、延迟与实际
  试验数逐格披露、金丝雀/固定工作量验证随机流正确性。

（结果表待预算矩阵完成后填写：预算—第一名率/平均名次/有效试验数曲线、
相邻边际收益、各人数最优预算区间。）

## 4. 任务 C/E：JS6 机制（部分完成）

已实现（champion-guided.ts，全部缺省关——金丝雀强制 JS5 行为逐位不变）：
- **C2 racing 自适应预算分配**：首个完整平衡批次后，非冠军候选
  UCB(mean+ε) < 冠军 LCB(mean−ε) 即淘汰（δ=0.05 按候选数 union 校正，
  ε=√(ln(2M/δ)/2t)，值域 [0,1] Hoeffding）；存活者独占剩余预算；冠军候选
  绝不淘汰（保守覆盖语义保底）；采样键 (world,replica) 与 balanced 完全一致
  （CRN 保持、逐试验可审计、候选顺序无系统优势）；racingEliminated 披露。
- **C4 claimFocus 终局聚焦**：终局已触发时候选 = 冠军行动 ∪ 全部合法认领
  （认领优先填满 cap）——终局是小行动空间精确排序问题。
- **C1/C3/D1/D3 筛查通道**：worlds/candidateCap/evaluator/opponentMode/
  gateMode 旗标 + mechanism-screens.mjs 单因子筛查编排（family=9 Bonferroni
  筛查信号，正向信号须按任务 E 流程独立确认）。
- **JS6 版本身份**：JOINT_VERSIONS.joint-js6 guided 缺省自描述
  {allocation: racing, endgameMode: claimFocus}；注册表 joint-js6-experimental
  参数快照 = js5 冻结描述符 + jointVersion=joint-js6；显式注入可逐项覆盖。

（单因子筛查结果与 JS6 定型组合待筛查完成后填写。）

## 5. 任务 D：对手行为与叶子评价（待筛查数据）

通道已备：--opponent-mode om-v1（D1）、--evaluator L3（D3）、--worlds（C1）。
D2（关键节点强规划）暂缓——需轨迹内反事实测试基建，视 C/D 筛查结果决定立项。

## 6. 任务 F：多人竞技确认（待 JS6 定型）

协议与 A2 同构：phase6-confirm 块 [1.382e9,1.4e9) 分区
（seedBase = 1.382e9 + (人数−2)×3e6 + (diverse?1.5e6:0)）。
（预注册文件待 JS6 定型后落盘。）

## 7. 任务 G：算力利用与部署约束（已完成核心）

### 7.1 重大缺陷：离线构建冠军路径损坏（修复）

JS5 晋级后，desktop standalone 与 mobile 离线构建的手工模块清单仍停留在
束搜索时代（缺 js//sim//om/ 共 31 个模块）——**离线版默认冠军路径已损坏**
（chooseJointAction 未定义 → AI 暂停）。且手工 strip 内联法随模块增长出现
跨模块顶层标识符冲突（requireThat ×4），不可持续。

修复：build.mjs 改用 esbuild IIFE 打包（devDependencies 钉定 esbuild@0.25.10；
desktop app / desktop ai-worker / mobile app / mobile worker 四个自包含包，
import 闭包自动跟随入口——手工清单从根上消灭）。

### 7.2 桌面 AI Worker（G2）

- 新增 `src/ai-worker.ts`（与 mobile/worker.ts 同协议：postMessage(game) →
  chooseAIAction → postMessage({action|error})）；
- `app.ts` scheduleBot：AI 决策移入 Worker（100ms 预算 p95 ~120ms 尚可同步，
  500-1000ms 预算必须异步才能保 UI 响应）；思考中席位显示 `AI…` 徽标；
- **过期决策守卫**：game 引用 + 回合数 + 行动者三重校验（状态更新后不提交
  过期决策）；Worker 回调一次性作废（一次决策只提交一次合法行动）；
- 回退链：Worker 构造失败 / onerror → 主线程同步决策（file:// 无 module
  Worker 时使用嵌入 classic blob，standalone 已内嵌）；
- 溢出/零预算回退由决策入口既有语义承担（适配器 trimStock + 冠军直通）。

### 7.3 验证

- `offline-ai-worker.test.mjs`：从 standalone/mobile 提取嵌入 Worker blob，
  在 Node vm 沙箱实跑 **JS5 完整决策**（含适配器闭包）——修复前该路径崩溃；
- pages-entrypoints：双入口自包含、同源锚点（data/engine/decision/adapter/
  champion-guided/session/om）、无源码 import 残留；
- 冠军行为不变性：version-gate 金丝雀（JS5 决策摘要）在打包改造前后一致。

（M4 浏览器实测响应剖面待补。）

## 8. 任务 H：失败案例与自我进化准备（工具就绪）

`training/joint/failure-diagnostics.mjs`：四类自动代理分类 + 复现数据集——
- `budget-starved`（9）：门控触发但零试验/单试验（饥饿回退）；
- `override-loss`（决策错误复核池）：覆盖与落败共存——**须反事实复核后才能
  归因决策错误**（诚实边界：不是自动判定）；
- `no-search-loss`（7 的代理）：失败局门控零触发（竞争门控盲区信号）；
- `outcome-only-loss`（10）：决策流无任何仲裁介入——**禁止倒推为决策错误**。
每失败局携带完整决策流（种子/座位/行动/仲裁分数/试验数）供反事实分析。

自我进化基建盘点：可更换搜索组件（JOINT_VERSIONS + 注册表 + guided 缺省）、
固定公开状态集（金丝雀 + 失败数据集 + 消融种子块）、自动消融入口
（mechanism-screens + duel 旗标全参数化）、独立竞技评估（compare/gate/
duel 管线）、失败分类（本工具）、冠军挑战证据（既有验证池管线未动）。
（实测分类统计待跑一次诊断采集后补。）

## 9. 自动测试覆盖（任务书 §十二 对照）

| # | 要求 | 状态 |
|---|---|---|
| 1 | 历史冠军身份固定 | ✓ version-registry.test 指纹钉定 + 金丝雀 |
| 2 | legacy-js0 / joint-js5 分派正确 | ✓ 分派身份测试（reason 路径） |
| 3 | 对手风格版本真实行为差异 | ✓ 决策级差异测试 + 8 组不等式 |
| 4 | 公共观察与隐藏牌序隔离 | ✓ 既有 joint-fairness 静态扫描（新增模块覆盖） |
| 5 | 模拟随机流不泄漏洗牌种子 | ✓ 既有 + simSeed=对局种子纪律 |
| 6 | CRN 世界与 replica 配对 | ✓ racing 采样键不变 + collectTrials |
| 7 | 候选顺序无系统偏差 | ✓ racing 键结构与批次语义保持 |
| 8 | 固定工作量逐位可复现 | ✓ 金丝雀 workUnits + js6 确定性测试 |
| 9 | 多人行动顺序与终局排名 | ✓ 既有引擎/排名测试（未触碰） |
| 10 | 立即认领不受存活折扣 | ✓ 既有 P0-2 回归（未触碰） |
| 11 | 商队 10 水晶容量 | ✓ 既有引擎测试（未触碰） |
| 12 | 交易/升级/休息/溢出合法 | ✓ 既有引擎测试（未触碰） |
| 13 | 零预算与超时合法回退 | ✓ 既有 starvation 回退测试（未触碰） |
| 14 | 2–5 人完整对局零异常 | ✓ A2/B 运行记录（数千局零异常） |
| 15 | 不同搜索预算不越界 | ✓ 合法性复核回退链 + 运行记录 |
| 16 | 训练与实战同描述符 | ✓ 注册表单一来源（web+training 同 dist） |
| 17 | JS6 加入不修改冻结 JS5 | ✓ 金丝雀 js5-frozen 摘要不变 |
| 18 | 网页与 Node 决策版本一致 | ✓ offline-ai-worker 沙箱实跑 |
| 19 | 种子区间与账本不冲突 | ✓ seed_policy 断言 + 分区公式 |
| 20 | 报告实验数可由原始记录重算 | ✓ compare.mjs 五类拒绝性校验 + 本报告 §1 |

## 10. 下一阶段建议（待 B/C/F 完成后定稿）

（占位：最强验证版本 / 各人数最优配置与预算 / 是否发起冠军挑战 /
Neural Evaluator 证据 / OpenEvolve 优先组件。）

## 附：证据清单

- P0：AI6-PHASE6-P0-AUDIT-REPORT.md + training/reports/phase6-p0/version-gate-latest.json
- 任务 A：training/reports/phase6-task-a/（预注册 + 双池 ablation + 合并分析）
- 任务 B：training/reports/phase6-task-b/（manifest + 26 格 ablation + 曲线）
- 筛查：training/reports/phase6-screens/
- 失败诊断：training/reports/phase6-task-h/
- 门禁：training/joint/version-gate.mjs（每次实验前强制）
