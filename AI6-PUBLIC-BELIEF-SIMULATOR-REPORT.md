# AI 6.0 第二阶段交付报告：Public Belief Simulator（公共世界模拟器）

> 本报告为 AI 6.0 第二阶段（CAHJP 前置底座：精确、公平、可复现、高性能的公共世界模拟器）的交付物。
> 分支 `feat/public-belief-simulator`（自最新 main / PR #22 合并后创建）。
> 关联文档：`AI6-M4-BASELINE-FREEZE-REPORT.md`（第一阶段）。

## 0. 执行摘要

| 维度 | 结果 |
|---|---|
| Differential Testing | **21,227 次合法状态转移对照，零不一致**（门槛 20,000）；另 9,488 次合法性奇偶校验、615 个随机局面、18 整局对照 |
| 信息公平性 | 零隐藏牌序泄漏（结构化 #private 封装 + 静态扫描 + 扰动不变性测试全过） |
| 回归 | web-v1 **107/107**（原 77 + 新增 30）、training **84/84**、冠军记录与冻结清单零改动 |
| 性能（M4 实测） | 模拟器纯转移 79–89k t/s（与引擎同量级 0.89–1.0×）；**节点展开 0.63–1.17M expansions/s**（含全量合法行动生成 + 分支复制）；状态复制 2.7–4.2M fork/s |
| 正式 AI 行为 | 逐位不变（src/ai、app.ts、mobile 零改动；静态扫描双向强制隔离） |

本阶段**不包含**任何策略或棋力改动；成功标准是后续 Joint Search 建立在可信底座之上。

## 1. 范围与前置状态核实

- PR #22（`research/m4-baseline-freeze`）已合并至 main（a4e89ec），分支自合并后的 main 创建。
- 已通读：`engine.ts`（规则权威）、`ai/observation.ts`（AIObservation 信息边界）、`ai/planner.ts`（AI5 合法行动枚举）、`ai/knowledge.ts`（未知卡集合推导）、`tests/ai-fairness.test.mjs`（公平性测试模式）、AI6 报告（基准口径与种子纪律）。
- 核实结论：AI5 的 `actions()` 含策略性剪枝（支付组合 top-3、搜索路径内 acquire ≤ 2、非空手牌才休息），**不能**直接作为全量合法集（任务 D 明确要求保留完整口径），因此 LegalActionProvider 以 engine 接受条件为准独立实现，复用 engine 导出的 `has`/`count`/`tradeLimit`。

## 2. 代码文件清单

**生产模块（全部新增，`web-v1/src/sim/`，Node/浏览器通用，无 DOM/Node 专属 API）：**

| 文件 | 职责（任务 G 接口） |
|---|---|
| `src/sim/state.ts` | PublicStateBuilder：`buildPublicSimState(observation)` + 紧凑 `PublicSimState` 类型 + 未知卡集合推导 + 观察校验 |
| `src/sim/sampler.ts` | `BeliefDeckSampler` 接口 + `randomBeliefSampler(seed)`（mulberry32 独立随机流） |
| `src/sim/transition.ts` | PublicTransition：`stepCore`（精确状态转移，逐条镜像 engine 语义）+ `cloneCore` |
| `src/sim/legal.ts` | LegalActionProvider：`enumerateLegalActions`（全量合法行动枚举 + 可证明等价去重） |
| `src/sim/session.ts` | `PublicSimulation`（create/step/tryStep/fork/score/ranking）+ `createSimulation` + `simulatePublicAction` |
| `src/sim/hash.ts` | PublicStateHasher：`publicStateKey` / `hashPublicState`（FNV-1a） |
| `src/sim/metrics.ts` | `SimulationMetrics`（会话级计数器） |
| `src/sim/rng.ts` | mulberry32 + Fisher–Yates（独立实现，与正式牌库 LCG 零共享） |
| `src/sim/index.ts` | 公共出口与接口文档 |

**测试与装置：**

| 文件 | 职责 |
|---|---|
| `tests/public-sim-harness.mjs` | differential 装置：预设翻牌注入、公开状态投影、牌库多重集 oracle、引擎 oracle 独立枚举、差异最小复现转储 |
| `tests/public-sim.test.mjs` | 单元测试 14 项（任务 A/B/C/D/G） |
| `tests/public-sim.fairness.test.mjs` | 信息公平性 7 项（扰动不变性、随机流隔离、CRN、封装、双向静态扫描） |
| `tests/public-sim.differential.test.mjs` | 任务 E 差异测试 8 项 |
| `scripts/benchmark-public-sim.mjs` | 任务 F 基准脚本 |

**报告与数据：** 本报告；`training/reports/public-sim-perf/perf.json`（M4 实测）。

## 3. 关键设计决策

1. **规则权威的锚定方式**：`engine.ts` 是唯一规则权威；`src/sim/transition.ts` 是同一规则的紧凑整数实现（无 log/replay/JSON 深拷贝），其等价性**由任务 E 的 2 万级 differential 对照强制证明**而非口头声明。这满足任务书"紧凑结构优先，但不为性能牺牲可验证的规则正确性"与"允许先慢后快"的组合要求；若未来出现无法收敛的偏差，回退路径为委托 `engine.applyAction` 的较慢实现（接口不变）。
2. **信念采样与真实牌序的隔离是结构性的**：模拟翻牌队列存于 ES `#private` 字段——不可枚举、`JSON.stringify` 不可见、外部代码无法触达；生产入口只接受 `AIObservation`（结构上不含隐藏牌序）；模拟随机流（mulberry32）与正式牌库随机数（LCG）算法、种子空间完全分离（静态扫描禁止 LCG 常量出现）。
3. **CRN（Common Random Numbers）**：采样在 `createSimulation` 时执行一次，`fork()` 复制队列——同一 root 的所有分支共享同一随机世界，分支间对照方差降低；`simSeed` 显式控制可复现性。
4. **弃置枚举的必然规范化**：随机 differential 对局发现真实合法局面可使库存达 28 颗（市场卡上奖励水晶无上限累积），超额弃置的**有序**序列是指数级（10⁸+）。弃置 = 逐色独立扣减、顺序与后继逐位无关（交换律），因此枚举一律输出规范排序组合（多项式级），并在引擎 oracle 侧采用同一口径比对。这是任务 D"可证明后继等价时才允许去重"条款的应用，已在代码注释中给出证明要点。
5. **行动规范化（canonical form）**：engine 接受参数缺省形式（升级卡 `steps` 缺省 = 空序列、交易卡 `repeats` 缺省 = 1），与显式形式后继相同；合法集合比较按后继等价类归一。
6. **模块隔离**：`src/sim/` 不依赖 `src/ai/` 的任何运行时代码（仅 `import type` AIObservation）；`src/ai/` 与正式入口不导入 sim——双向静态扫描强制，正式网页 AI 决策路径逐位不变。

## 4. 任务 A–G 交付明细

- **A 公共状态建模**：`PublicSimState` 覆盖任务书全部字段（2–6 玩家公开状态、四色库存、手牌/已打出/已认领、双市场与卡上奖励、未知卡集合、铜银币与累计硬币、行动席位与行动次数、阶段/终局触发者/回合计数）；预留 `historySummary` 扩展位；观察校验拒绝非法输入；未知卡集合为排序规范形（集合语义、无顺序信息）。
- **B 信念采样**：无放回均匀洗牌、多重集契约校验（创建时强制）、可重复（同种子同输出）、多样（异种子异排列）、CRN、翻开卡即时进入该轨迹公开状态、未翻开队列物理不可见。扰动不变性测试：4 种打乱 × 8 中局位置 × 6 采样种子，公共状态/候选动作/采样分布全部不变。
- **C 精确状态转移**：镜像清单见 `transition.ts` 文件头（13 项逐条对应 engine），含升级合法顺序、重复交易、逐位置支付与奖励累积、休息收卡、认领与铜银币规则（0 号位铜→银回退、1 号位铜银双全）、市场补牌与牌库耗尽、溢出弃置（不推进他人回合）、真实座位轮转、2–3/4–5 人终局门槛、触发后完成整轮、计分与平分决胜（score/ranking 直接复用 engine 实现）。
- **D 合法行动枚举**：全量口径（含空升级序列、无条件 rest、全有序支付序列、全部可认领位置、全部弃置组合）+ `dedupe` 可选去重（升级按终态库存）；differential 中以"候选宇宙 × 引擎逐条接受"为 oracle 双向比对。
- **E 规则一致性验证**：见 §5。
- **F 性能**：见 §6。
- **G 接入与隔离**：六接口齐备；任意座位顺序连续推进；可记录轨迹复放（测试覆盖）；固定行动策略多轮冒烟通过；零外部网络/大模型/Python 依赖；Node 与浏览器同一 TS 模块。

## 5. 任务 E：规则一致性验证（最高优先级验收）

**结果：21,227 次合法状态转移对照，零不一致**（8/8 测试通过，运行 ~8s）。

| 对照维度 | 实现 |
|---|---|
| 后继状态逐字段 | 公开投影（全部规则意义字段）逐字段 diff，差异即失败并自动转储最小复现 |
| 合法集合一致性 | 引擎 oracle（独立候选宇宙 × 引擎逐条接受）⇔ 模拟器枚举，双向（过宽/过严） |
| 连续多步 | 18 整局（2–5 人 × 随机/贪心认领/冻结冠军 AI 驱动）模式 B 持续会话 + 每步模式 A 重建保真 |
| 牌库 oracle | 每步强制：真实剩余牌库多重集 ≡ 模拟器未知卡集合 |
| 边界 | 溢出与弃置（构造 28 颗真实极端库存）、牌库耗尽、终局触发与整轮完成、平分决胜名次、极端资源组合、终局结算对照 |
| 行动类型 | play（创造/升级/交易）、acquire（全位置×全有序支付）、claim（全位置×硬币规则）、rest、discard 全覆盖 |

测试过程中发现并修复的缺陷（印证框架价值）：

1. **模拟器缺陷（0 个规则性偏差）**——最终实现与引擎零规则不一致；
2. **测试装置缺陷 3 个**：(a) 溢出有序宇宙指数爆炸 → 改规范组合口径（该缺陷同时促成生产枚举器的必然规范化决策）；(b) 行动缺省形式未归一导致"漏掉合法行动"误报 → 引入 canonical form；(c) 构造牌库耗尽/终局局面时牌库与公开区域不一致 → 改为"移出牌放入公开区域"的一致构造。
3. 遵守"不得为了通过测试修改正式规则"：全部修复都在测试装置与模拟器侧。

## 6. 任务 F：M4 性能实测

环境：Apple M4（10 核）×1 worker｜16GB｜Node v22.16.0｜macOS（本地）｜perf 诊断种子（非统计样本，与 AI6 perf 基准同源，不消费验证种子）｜JIT 预热后计量。完整数据：`training/reports/public-sim-perf/perf.json`。

### 6.1 纯转移吞吐量（不含合法行动生成；双侧同一行动序列 + 逐条合法性校验 + 到达终局）

| N | 引擎重放 t/s | 模拟器重放 t/s | 比值 |
|---|---|---|---|
| 2 | 94,949 | 89,180 | ×0.94 |
| 3 | 87,036 | 83,766 | ×0.96 |
| 4 | 87,752 | 78,384 | ×0.89 |
| 5 | 78,866 | 79,100 | ×1.00 |

参考：AI6 报告同口径引擎基准 75,950 t/s（commit 0cd9427）；本次引擎重测 78.9–94.9k（commit 0b6c7c87，同机同法），同量级可信。

### 6.2 节点展开吞吐量（**与纯转移吞吐分开披露，不混口径**）

工作负载：每主线节点全量枚举合法行动 + **对每个行动 fork 状态复制 + tryStep**（模拟树展开的真实成本）。

| N | expansions/s | 平均分支因子 | 枚举/s |
|---|---|---|---|
| 2 | 626,303 | 34.5 | 18,158 |
| 3 | 1,031,691 | 40.8 | 25,289 |
| 4 | 1,165,780 | 53.2 | 21,914 |
| 5 | 1,112,094 | 55.2 | 20,144 |

### 6.3 微工作负载（中局位置）

| 项目 | 结果 |
|---|---|
| buildPublicSimState | 3.3–4.1 µs/op（~25–30 万 ops/s） |
| 信念采样 | ~14 万采样/s，1.32–1.44 亿卡牌/s |
| 合法行动生成 | 1.11–2.50 万位置/s，1113 万–2500 万动作/s |
| 状态复制 fork | 2.7–4.2M/s（0.24–0.37 µs/fork） |
| 内存 | 展开工作负载 heap 增量 0.4–14.2 MB（无泄漏迹象）；基线会话占用 <1 MB |

### 6.4 瓶颈与优化空间

- **当前瓶颈**：单步转移中 `cloneCore` 的玩家对象与未知卡数组复制（占 step 主要成本）；`PublicSimState` 使用字符串卡牌 id（V8 内部化后开销可接受，但整数码化可再降）。
- **结构已就绪的后续优化**：(a) copy-on-write / undo stack（`stepCore` 已是原地语义 + 显式 cloneCore，改 undo 栈不动接口）；(b) 卡牌 id 整数化 + 卡牌规则元数据预计算（`MERCHANT_BY_ID` 查表已集中，可平移为 typed array）；(c) 未知卡集合位图化。
- **对比说明**：冠军搜索探针（AI6 §4.3，内部快速模型）~31–36 万节点/s；公共模拟器展开 0.63–1.17M/s 且包含全量合法行动生成与信念采样能力。二者工作负载不同，仅作量级参考，不作优劣断言。
- 本阶段不预设性能倍数目标；正确性优先，未为吞吐牺牲任何规则校验。

## 7. 信息公平性与不变量保持

- 零隐藏牌序泄漏：观察入口不含牌库（类型层）＋ 模拟队列 `#private`（运行时）＋ 静态扫描 `src/sim/**` 禁止 `.merchantDeck/.golemDeck` 与 LCG 常量（编译期）。
- 扰动不变性、随机流隔离、CRN、封装测试全过（`public-sim.fairness.test.mjs` 7/7）。
- 正式 AI 行为不变：`src/ai/**`、`src/ai.ts`、`app.ts`、mobile 零改动；静态扫描禁止 ai 导入 sim；`chooseAIAction` 相关回归全过。
- 种子纪律：基准仅用 perf 诊断子块；未触碰训练池/AI4 基准区/验证池；未用正式验证种子做调优。
- 冠军冻结：`champion.json`、`champion-freeze.json`、种子账本零改动；本分支 `git diff HEAD -- web-v1/src/`（排除新增 sim）为空，sim 不在 `engineBundleSha256` 的 import 闭包内。
- **如实披露（沿用 AI6 报告 §4.4 已知漂移，非本阶段引入）**：在当前 HEAD 源码构建产物上运行 `npm run baseline:freeze-check` 会报冠军指纹不一致（c1dd8272… → b0df3fc4…）。根因是 PR #20/#21 对 AI 核心共享代码的改动（AI6 报告已记录"冠军产物 vs HEAD 构建 95/96 局分歧"），在 PR #22 合并进 main 时即存在。本阶段未改变冠军记录，也未改变该漂移；处置建议维持 AI6 报告结论：单独立项审计 HEAD 分歧是否可接受。

## 8. 已知风险与限制

1. **转移实现为镜像而非委托**：规则等价性由 differential 对照实证（21k+ 零不一致），理论上是"高置信实证"而非"构造性同一"；后续每次触碰 `transition.ts` 或 `engine.ts` 都必须重跑 differential 套件。
2. **弃置与升级的枚举含等价类收缩**（可证明等价、文档化），不保留有序弃置变体的"未剪枝版本"——因其在真实合法局面中是指数级的，无法作为可行基准；该收缩的证明（交换律）见 `legal.ts` 头注。获取支付顺序未做任何收缩。
3. **状态复制为全量拷贝**：分支模拟为"fork + 原地推进"，未做结构共享；大规模搜索（>10⁶ 活跃节点）下内存需要 undo/copy-on-write 支撑（结构已预留）。
4. **对手历史模型未实现**（任务书明确本阶段不做）；`historySummary` 为预留空位。
5. **6 人扩展模式**：观察校验允许 2–6 人（engine 数据结构上限），但 differential 覆盖与性能测量按任务书范围为 2–5 人；6 人未验证。
6. PR #22 报告建议的公共评测 API、统一种子总账、额外遥测：本阶段仅在最小需要范围内提供（`SimulationMetrics`、perf 脚本），未做跨模块重构；依赖关系已记录于 §9。
7. **座位偏差风险标记（沿用 PR #22 报告 §3.2，保留不销）**：镜像基准的座位最大偏差是 AI6 第一阶段基线的唯一黄旗（"未定罪"区间），已列入 B0 优先复核清单。本阶段未触碰任何基线统计结果、未修改座位轮换与种子分配规则；该风险标记原样保留，随评测阶段 B0 复核（加倍样本）处置。
8. **B0/B1/B2 命名区分（后续报告纪律）**：PR #22 报告（`AI6-M4-BASELINE-FREEZE-REPORT.md` §6）中的 B0/B1/B2 是**评测阶段**命名（B0 基线稳定性复现、B1 首个候选单变量对照、B2 系统化验证），与 CAHJP 研究报告的 B0/B1/B2 **算法消融**命名不是同一套语义。本报告未使用 B0/B1/B2 标签；后续任何报告引用时必须分别标识（建议前缀 `eval-B0/B1/B2` vs `cahjp-B0/B1/B2`），避免混淆。

## 9. 下一阶段接入建议

**Opponent Model V1**：
- 挂载点：`PublicSimState.historySummary`（已预留）——建议以"公开事件摘要"（每个席位每回合的行动类型与资源变化）为输入，由 differential playout 已验证的轨迹记录能力（`public-sim.test.mjs` 轨迹复放测试）提供训练/评估数据。
- 需要新增：`buildPublicSimState` 之外的轨迹采集器接口（建议 `PublicSimulation#onStep` 钩子或外部观察器，避免热路径回调开销）。

**Joint Search V1**：
- 已具备：确定性信念采样（`simSeed`）、CRN fork 语义、全量合法行动提供、状态哈希去重、终局即时查询、2–5 人任意座位推进。
- 建议接口形态：`root = createSimulation(obs, { simSeed })` → 每节点 `fork()` × `enumerateLegalActions(view)` × `step`，叶子用 `score/ranking` 回传；对手回合用信念采样 + 对手模型策略采样推进（本阶段未含对手策略）。
- 性能预算参考：1.1M expansions/s（N=5，含枚举与复制）意味着单决策 50ms 预算内可展开 ~5 万节点，足以支撑浅层联合搜索。

**已具备接入条件的判定**：接口与语义层面**已具备**；工程层面建议在接入前完成 (a) undo/copy-on-write 优化（长树内存），(b) differential 套件纳入 CI 常规门槛（当前 `npm test` 已包含）。

**本阶段不能用于正式 AI 的部分**：
- 全部 `src/sim/**` 均未接入正式网页 AI（`chooseAIAction` 路径零改动）——这是有意隔离，非缺陷；
- `simulatePublicAction`/枚举器未经过策略级验证（无对手响应建模），不能替代 AI5 planner 的单回合搜索；
- 性能数字为微基准口径，未经完整对局搜索负载验证。

## 10. 验收门槛对照

| 门槛 | 状态 |
|---|---|
| Differential ≥ 20,000 零不一致 | ✅ 21,227 次，零不一致 |
| 全行动类型与边界覆盖 | ✅ §5 |
| 2–5 人随机合法局面 | ✅ 615 局面 / 18 整局 / 4 档人数 |
| 终局、分数、排名一致 | ✅ 复用 engine.score/ranking + 对照断言 |
| 零隐藏牌序泄漏 / 扰动不变 / 随机流隔离 | ✅ 7/7 公平性测试 |
| 可重复（同输入同随机流） | ✅ 单元 + 复放测试 |
| 现有回归全过 | ✅ web-v1 107/107、training 84/84 |
| 冠军冻结指纹不变 | ✅ 冠军记录零改动（HEAD 漂移为既有问题，§7 如实披露） |
| 不改变正式决策行为 | ✅ AI 模块零改动 + 静态扫描 |
| Node/浏览器兼容 | ✅ 纯 TS、NodeNext 编译通过、无平台 API |
| M4 实测报告 / 瓶颈 / 优化结构 / 同口径对比 | ✅ §6 |
| 独立分支与 PR、API 说明、测试证据、基准报告、风险清单、接入建议 | ✅ 本文档 + 代码注释 |
