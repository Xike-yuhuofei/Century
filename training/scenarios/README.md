# Century 战术基准局面库（Tactical Benchmark Scenarios）

研究/回归测试资产：**可重复使用、合法、只含公开信息**的 Century 战术局面基准库。
用途是检验搜索算法是否真正理解：对手抢牌、座位次序、立即认领、商人卡投资与得分
取舍、商队容量、关键资源转换、终局与搜索深度带来的策略误差。

本目录**不开发任何新搜索算法**，也不修改规则引擎、JS5 搜索、冠军参数或验证账本；
只新增局面语料、决策记录、局部求解 oracle、自动测试与文档。

## 信息边界模型（不可妥协）

- 每个 `scenario.publicView` 与正式 AI 决策入口同源（`buildObservation`）：全部玩家
  水晶/手牌/已打出/已认领、可见商人卡与奖励、可见魔像市场、公共币池、阶段、
  终局触发者。商人卡手牌是公开历史可推导信息（本游戏无弃牌/暗置），不属于隐藏信息。
- `engineState.position` 含 `merchantDeck/golemDeck` 隐藏牌序，**仅供研究侧复演与
  oracle 局部求解**，显式标记 `containsHiddenInfo: true`；AI 决策输入一律只允许
  publicView（决策函数内部同样只经公开观察入口）。
- `tests/scenario-integrity.test.mjs` 用"牌库内容置换 → 决策逐位不变"证明语料层
  边界；引擎/决策源码层的静态扫描由 web-v1 `tests/ai-fairness.test.mjs` 承担。

## 语料来源与纪律

- 全部局面由正式引擎（`web-v1/dist/js`，与网页版同一编译产物）从固定种子完整回放
  采集——不手工构造商人卡/魔像卡/资源，无不可能局面。
- 种子块：`AI6_SCENARIO_BLOCK [1.5e9, 1.6e9)`（`ai5/lib/seed_policy.mjs` 登记；
  原拟 `[1.4e9,1.5e9)` 与并行合并的对抗性联赛块重叠，按块不重叠纪律换块并重生成语料），
  与训练/验证/进化/基线/联合搜索各池物理隔离；逐局顺序分配，消耗清单见
  `data/generation-summary.json`。**不消费冠军验证账本种子，不用于胜率联赛。**
- 驱动版本为既有确定性束搜索冻结版本（classic/js1/baseline 轮换），按正式游戏
  席位人格映射（席位 0 = 中立代理）。
- 溯源：每条语料记录 `gameSeed / decisionIndex / driver / engineCommit /
  engineBundleSha256 / generatedAt`；语料可逐位重演。

## 十类目标类别（标签启发式，阈值公开）

| 标签 | 判定（全部为公开事实） |
|---|---|
| `final-round` | 终局已触发（triggerPlayer ≠ null） |
| `opponent-ending` | 有对手认领数 = 目标−1（再认领 1 张即触发终局） |
| `contested-claim` | 存在 ≥2 席可支付同一可见魔像，或 1 席可支付 + ≥2 席差 ≤2 颗 |
| `multi-claim` | 当前席位同时可认领 ≥2 张魔像 |
| `seat-race` | 当前席位可认领且后续行动席位（本圈后手→下圈先手）亦可支付同一张 |
| `acquire-vs-score` | 当前席位既可立即认领、又可支付获取市场深度 ≥2 的商人卡 |
| `caravan-pressure` | 当前库存 ≥7 颗（上限 10） |
| `trade-chain-rest` | 已打出 ≥2 张且手中有可执行的交易卡（休息成本悬置） |
| `conversion-efficiency` | 当前库存蓝 ≥2 或粉 ≥2 或蓝粉各 ≥1 |
| `engine-overinvest` | 手牌+已打出 ≥7 张且认领 ≤1 张 |

一条局面可命中多个标签；`classification.category` 是主分类（按叙事强度排序取首个
命中），配额按（标签 × 人数）槽位采集。`stage`（opening：回合 ≤ 2N；endgame：终局
已触发或有人距目标 1 张；其余 midgame）、`competition`（竞争魔像数 0/1/≥2 →
low/medium/high）、`difficulty`（合法行动数 <15/60/200 → S/M/L/XL）随语料披露。

## 决策评估口径

每个局面记录四个**冻结版本**的确定性建议行动（`decisions`）：

| 版本 | 口径 |
|---|---|
| `js5-w128` | 正式冠军 joint-js5，workUnits=128 固定工作量（worlds=4, simSeed=0）——逐位可复现；预算模式受墙钟负载影响不可逐位重放，故基准一律用固定工作量 |
| `classic-beam-rollout` | 前任正式冠军 ai5-readiness-efficiency（参数读自 `training/baseline/champion-freeze.json`） |
| `js1-beam-contest` | JS1 = 冠军参数 + beam-contest 静态存活折扣 |
| `v4-baseline` | V3.0 等价基线 BASELINE_PARAMETERS（beam-lineage） |

分歧矩阵（`disagreement`）只披露事实（各版本行动键、唯一行动数、多数行动），
**不编造唯一正确答案**。每条语料还带：
- `objectiveConstraints`：规则层可机械验证的事实（谁可认领、库存/上限、币池、触发状态等）；
- `strategicHypotheses`：需要模拟验证的命题（抢牌存活率、引擎/得分交叉点等），
  措辞显式为假设。

## 局部终局 oracle

对"终局在即、剩余行动有界"的局面（终局圈中，或存在"认领即触发终局"的行动），
`lib/oracle.mjs` 用正式引擎穷举剩余回合，输出各候选行动下当前席位的名次/得分区间：

- `guaranteed`：对手逐一采取最不利行动的精确下界（极大化当前席位名次、次级极小化得分）；
- `best`：全部配合的精确上界；
- 口径标记 `exact-under-recorded-deck`：穷举使用记录位置的真实牌库（研究侧 ground
  truth），**AI 决策输入仍只有公开观察**——oracle 是评估基准而非 AI 输入；
- 行动后终局仍未触发 → `scope: 'open'`（不输出名次结论）；穷举超节点/时间上限 →
  `scope: 'conditional'`（不假装得到最优策略）。状态级转移去重 + 置换表 +
  nodeCap/timeCap 固定工作量护栏。

## 目录结构

```
training/scenarios/
├── README.md                  本文档
├── lib/
│   ├── versions.mjs           冻结版本注册表 + 席位人格映射 + 种子块纪律
│   ├── classify.mjs           行动键归一 / 标签 / 阶段 / 难度 / 客观约束 / 战略假设
│   ├── harvest.mjs            正式引擎对局回放与决策点采集
│   ├── decisions.mjs          基准局面装配（公开观察、合法行动、四版本决策）
│   └── oracle.mjs             局部终局求解 oracle
├── scripts/
│   ├── generate.mjs           语料生成 CLI（回放→配额采集→oracle→索引）
│   ├── record-decisions.mjs   冻结版本口径变更时重录 decisions
│   └── compare-budgets.mjs    不同搜索预算（workUnits 档位）比较接口
├── data/
│   ├── scenarios.jsonl        语料本体（机器可读，一行一条）
│   ├── index.json             机器可读分类索引
│   ├── INDEX.md               人类可读总览（分类表格）
│   └── generation-summary.json 种子消耗/异常/覆盖率清单
└── tests/
    ├── scenario-integrity.test.mjs   合法性 / 信息边界 / 合法行动集合
    └── scenario-decisions.test.mjs   可复现 / 冻结行为基准 / oracle / 预算接口
```

## 场景 JSON 字段速览

```
schema / id / title / description
classification: { category, tags[], playerCount, stage, competition, targetCount, difficulty }
provenance: { gameSeed, seatCount, decisionIndex, driver, scenarioBlock, engineCommit, engineBundleSha256, generatedAt }
phase / turnNumber / currentSeat / decisionProfile / endgame { triggerPlayer, targetClaims, claimsBySeat }
publicView          ← AIObservation 同源公开信息（AI 决策唯一输入口径）
legalActions[] / legalActionCount   ← 引擎全量口径（web-v1/src/sim/legal.ts）
engineState { containsHiddenInfo, note, position }
decisions { <versionKey>: { label, options, action, actionKey, reason, profile, ms } }
disagreement { versions, actionKeys, uniqueActions, uniqueCount, allAgree, majorityActionKey, tally }
oracle { status: exact|partial|exceeded|skipped, model, actions[], stats } | null
objectiveConstraints[] / strategicHypotheses[]
```

## 常用命令

```bash
# 自动测试（固定工作量；需先构建 web-v1：cd web-v1 && npm run build）
npm run scenarios            # = node --test --test-concurrency=2 scenarios/tests/*.test.mjs

# 语料生成（种子块 [1.5e9,1.6e9) 顺序分配；默认配额 10 类 × ≤2 × 4 人数，总量 ≤44）
node scenarios/scripts/generate.mjs [--games 2:60,3:50,4:50,5:60] [--per-slot 2] [--max-total 44]

# 冻结版本口径变更后重录（其余字段保留，差异随 PR 评审）
node scenarios/scripts/record-decisions.mjs [--id TS-5P-CON-001]

# 不同搜索预算比较（JS5 workUnits 档位；可加 --budget-ms 做墙钟参照）
node scenarios/scripts/compare-budgets.mjs --id TS-5P-CON-001 --budgets 16,64,128,256
```

## 测试覆盖（任务书 D 节）

| 测试 | 文件 | 口径 |
|---|---|---|
| 局面合法性 | scenario-integrity | publicView ≡ 引擎重建观察；头部字段一致；全部记录行动被引擎接受；认领集合 ≡ legalClaimIndices |
| 公开信息边界 | scenario-integrity | publicView 无牌库字段；牌库置换后决策逐位不变（抽样） |
| 合法行动集合 | scenario-integrity | 模拟器全量枚举 ≡ 记录集合（逐键、全语料） |
| 决策可复现 | scenario-decisions | 四冻结版本双跑逐位一致（抽样） |
| 冻结 JS5 行为基准 | scenario-decisions | 语料记录 ≡ 运行时重算（漂移报警口径） |
| 预算比较接口 | scenario-decisions | 多档 workUnits 结构完备 + 同档复现 |

## 已知边界与诚实声明

- 决策与 oracle 的确定性依赖语料记录的引擎产物指纹；引擎/搜索演进后相关测试会
  失败——这是**有意的漂移报警**，重录语料须走 `record-decisions.mjs` 并 PR 评审。
- oracle 的名次区间是穷举精确界（对手最不利 / 全配合两端），不是博弈论唯一解；
  中间结果属战略假设，需对局模拟研究（本任务不做大规模胜率联赛）。
- 预算比较的 `budgetMs` 墙钟档位受机器负载影响，输出仅供参考，不用于断言。
- 语料分类标签是启发式（阈值公开），同一局面可属多类；配额保证类别覆盖，
  不声称类别互斥。
