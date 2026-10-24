# 夜间自主任务 A：Century 对抗性 AI 联赛系统 — 实验报告

- 分支：`research/overnight-adversarial-league`（基于 `origin/main@e7d3bfa`，独立 worktree）
- 日期：2026-10-24（夜间自主执行）
- 引擎产物指纹：`a0da8883695a99d1…`（HEAD@e7d3bfa 干净重建，见"限制"L1）
- 注册表指纹：`cf89c3933a94914d…`（完整值见冒烟报告 `registrySnapshot`）
- 种子块：`AI6_ADVERSARIAL_LEAGUE_BLOCK [1.4e9, 1.5e9)`（本次新登记，与全部既有块物理隔离）

---

## 1. 目标与范围

为 JS6 搜索研发建立**独立的高水平对手池与自动联赛系统**，让 Century AI 面对不断变化的强对手，
发现当前冠军（joint-js5）难以处理的竞争策略，服务核心目标：**提高真实单席位第一名率**。

交付范围（全部在 `training/adversarial/` + 任务专属测试/文档）：

| 模块 | 职责 |
|---|---|
| [registry.mjs](training/adversarial/registry.mjs) | 对手版本注册表：不可变描述符、sha256 指纹、strip-adapter 纪律、冻结身份 |
| [strategies.mjs](training/adversarial/strategies.mjs) | random-legal 独立策略（sim/legal 全量合法枚举 + 确定性席位 RNG） |
| [league.mjs](training/adversarial/league.mjs) | 联赛框架：单局循环（三决策核心按席位分派）、赛程生成、胜率矩阵、完整元数据 |
| [candidate.mjs](training/adversarial/candidate.mjs) | 对抗性候选生成接口（OpenEvolve 进出协议） |
| [evaluate.mjs](training/adversarial/evaluate.mjs) | 防过拟合双轴评估 + 强对手筛选 |
| [run-league.mjs](training/adversarial/run-league.mjs) | CLI（matrix / evaluate 两模式，种子块强制） |
| [preregistered-plan.mjs](training/adversarial/preregistered-plan.mjs) | 预注册大规模方案生成与机械校验（夜间不执行） |
| 测试 ×5 | `training/tests/adversarial-*.test.mjs`，35 项 |

---

## 2. 核心审计发现：CHAMPION_PARAMETERS.adapter 使风格变体权重 100% 失效

### 2.1 缺陷机理（代码级）

AI6 第五阶段晋级接线后，`CHAMPION_PARAMETERS` 携带 `adapter: 'champion-guided'`。
[decision.ts:38](web-v1/src/ai/decision.ts) 按 `params.adapter === 'champion-guided'` 分派决策核心：
适配器冠军的决策在 JS5 联合搜索内，**权重乘子不参与决策**（[parameters.ts:42-47](web-v1/src/ai/parameters.ts) 明文记录该语义）。

因此，任何从当前冠军**浅拷贝派生**的"风格变体"——`{...CHAMPION_PARAMETERS, tempoWeight: X}`——
都会携带 `adapter` 字段并被静默分派到 JS5 联合搜索。联合搜索核（champion-guided.ts）只消费
`CHAMPION_PARAMETERS` / `o.championParameters`，传入对象的权重乘子**不可达**。

### 2.2 行为级证据（测试固化：[adversarial-audit.test.mjs](training/tests/adversarial-audit.test.mjs)）

- 探针设计：固定种子 2 人局、中立基线推进 3/9 步的确定状态，`tempoWeight=5 / restWeight=0.05`
  的极端权重变体（若权重可达，行为必然剧变）。
- **路由证明**（确定性）：12/12 探针中，权重变体的 reason 披露 `js5 冠军直通` —— 全部走 JS5 联合搜索，
  与冠军本体同核；对照：strip-adapter 后同一极端权重走 `beam-rollout` 束搜索路径（reason 含结构标记）。
- **历史量测**（本任务开发期实测，48 探针）：携带 adapter 的权重变体与 JS5 冠军行动**逐位一致 48/48**；
  strip-adapter 后同一权重与 JS5 分歧 19/48。即：**缺陷状态下变体=冠军本体，修复后权重真实生效**。
  该量测因涉及墙钟预算模式（负载敏感）未固化为断言，确定性路由证明已固化。

### 2.3 影响范围评估（只审计不修改他人模块）

| 位置 | 派生方式 | 现状 |
|---|---|---|
| `training/lib/opponents.mjs` `styleVariants()` | `{...champion, tempoWeight×1.35, ...}` | **携带 adapter → 三个风格变体 ≡ JS5 本体**（AI4 进化对手池） |
| `training/joint/duel.mjs` `classicPool()` | `{...c, tempoWeight×1.35, ...}` | **@tempo/@contest/@engine ≡ JS5 本体** |
| `training/joint/duel.mjs` `diversePool()` | 同上 + `style-rush/style-engine` | **两个 style 条目 ≡ JS5 本体**；`ai4-struct-beam-rollout`（归档参数无 adapter）与 `random-legal` 不受影响 |
| `training/baseline/runner.mjs` `baselineOpponentPool()` | 经 `buildOpponentPool` → `styleVariants` | 同 opponents.mjs，**受影响** |

**对既有结论的含义（诚实披露）**：第五阶段任务 D 的 confirm 实验（PR #29）"diverse 池"中
style-rush/style-engine 实际是 JS5 克隆，"对手池多样性"被高估；classic 池的 3 个风格变体同然。
受影响实验的*冠军 vs 归档冠军/随机策略*读数不受影响；*风格变体*读数应视为"冠军 vs 冠军镜像"。
**建议**：后续 PR 修复 `opponents.mjs`（strip-adapter + 显式决策核心字段）与 `duel.mjs` 池构造，
并用本任务注册表替换两处手写池。本任务未越权修改（范围纪律）。

### 2.4 结构性修复（本模块落地）

- `stripAdapter()`：剥离 `adapter/jointVersion/budgetMs` 三字段（不修改输入）；
- `validateDescriptor()`：**非 champion-guided 核心携带 adapter 直接抛错**（audit 缺陷的结构性防御）；
- 注册表全部风格变体从"冠军血统基座"（strip-adapter + 权重补 1.0 + structure=beam-rollout +
  acquisitionVariant=readiness-efficiency）派生，走束搜索核心——与 JS5 的差异是结构性的（束搜索 vs 联合搜索）
  加参数性的（权重覆盖）。

---

## 3. 对手版本注册表（9 版本，身份冻结）

| id | family | decisionCore | 说明 |
|---|---|---|---|
| `js5-frozen-champion` | champion | champion-guided | **身份 = 晋级归档快照**（`training/champions/candidates/joint-js5.json`，challengeIndex=11），与活动冠军状态完全解耦 |
| `ai5-readiness-efficiency` | historical-champion | beam-search | challengeIndex=9 晋级，JS5 前任 |
| `ai4-struct-beam-rollout` | historical-champion | beam-search | AI4 结构候选世代 |
| `neutral-baseline` | baseline | beam-search | 全权重 1.0 行为锚点 |
| `style-rush` | style | beam-search | tempo 1.6 / rest 0.5 / engine 0.5 / endgame 0.6 |
| `style-engine` | style | beam-search | engine 1.6 / capacity 1.4 / tempo 0.7 |
| `style-contest` | style | beam-search | contest 1.6 / goal 1.2 |
| `style-balanced` | style | beam-search | 冠军血统基座权重（无联合搜索的 JS5 参数对照） |
| `random-legal` | random | random-legal | 确定性均匀合法采样（结构完全不同的多样性锚点） |

关键性质（均有测试）：

1. **不可变指纹**：`versionFingerprint` = sha256(canonicalJSON(决策身份字段))；键序不变、权重敏感、
   运行时选项敏感。注册表深冻结（Object.freeze 递归），变异即 TypeError。
2. **冻结身份不随冠军切换漂移**：身份只读晋级归档；测试注入"假设新冠军归档"与篡改活动参数
   （`setAIParameters`）后注册表指纹逐位不变。
3. **三决策核心按席位隔离分派**：champion-guided → `chooseJointAction`（预算/工作量显式透传）、
   beam-search → `chooseAIAction`（参数+结构）、random-legal → sim/legal 枚举采样。
   全部经正式引擎编译产物推进，非法行动由引擎裁决为异常局。
4. **信息公平**：全部核心只消费公开观察（AIObservation / 公开视图）；random-legal 的合法集合
   枚举同样只见公开字段；RNG 流只依赖 (seed, seat)，不接触隐藏牌序。

---

## 4. 自动联赛框架

- **赛程**（`planMatrix`）：2 人局 = 无序对头对头（一组对局同时填充 matrix[A][B] 与 matrix[B][A]
  互补计数）；3–5 人局 = 有向场（A 占 1 席 vs N−1 席全 B，双向各跑）。种子按 `sequentialSeeds`
  顺序切片，场间零重叠，`assertInBlock` 全程强制。
- **座位轮换**：焦点席位 = `seedIndex % seatCount`，全部座位覆盖有测试断言。
- **胜率矩阵**：`matrix[A][B] = P(A 第一名 | A 占 1 席，其余全 B)`，含 Wilson 95% CI 与逐座位分解。
- **异常纪律**：异常局绝不计入胜率，原因归类披露；终局回合数一致性校验。
- **运行时口径**：`--joint fast`（`workUnits:64` 确定性快档，冒烟/开发）与 `--joint official`
  （冻结归档 `budgetMs=100` 墙钟，正式联赛）显式分离；快档不用于结论。

---

## 5. 端到端冒烟结果（少量种子，真实运行）

### 5.1 胜率矩阵冒烟（`smoke-2-5-4s`）

命令：`run-league.mjs --mode matrix --versions <5 版本> --players 2,5 --seeds 4 --block smoke --joint fast`

- **120 局 / 30 场，种子 [1.401e9, 1.401e9+120)，0 异常，804s**（快档）。
- 胜率矩阵（行=焦点版本第一名率， Wilson 区间见报告 JSON）：

| 焦点 \ 对手 | js5-frozen | style-rush | style-engine | ai5-readiness | random-legal |
|---|---|---|---|---|---|
| **js5-frozen-champion** | — | 75.0% | 50.0% | 75.0% | 100.0% |
| **style-rush** | 12.5% | — | 12.5% | 37.5% | 100.0% |
| **style-engine** | 25.0% | 37.5% | — | 25.0% | 100.0% |
| **ai5-readiness-efficiency** | 0.0% | 37.5% | 50.0% | — | 100.0% |
| **random-legal** | 0.0% | 0.0% | 0.0% | 0.0% | — |

- 语义读数（**冒烟样本量 n=8/cell，仅验证框架，不构成结论**）：
  - JS5 对全部非 JS5 对手保持不败优势（50–100%），对前任冠军 ai5-readiness 75%（2p 头对头 100%）；
  - **被克制信号可见**：style-engine 对 JS5 的 5p 有向场表现好于 style-rush（引擎型在多人局更抗衡冠军）；
  - random-legal 全负（期望行为，校验矩阵无系统性席位泄漏）；
  - 座位轮换覆盖、逐局指纹披露、异常记账全部经自动测试断言。

### 5.2 候选双轴评估冒烟（`evaluate-smoke`）

命令：`run-league.mjs --mode evaluate --candidates candidates.example.json --players 2,5 --seeds 4 --block dev --joint fast`

3 个示例候选（文档化演示，非训练产物），每候选 轴A 12 局 + 轴G 8 局：

| 候选 | 轴 A（vs 冻结冠军）3 单元 | 轴 G（泛化池）2 单元 | 判定 |
|---|---|---|---|
| cand-js5-fast-gate（JS5 结构候选，workUnits 96） | 37.5% / 37.5% / 37.5% | 100% / 50%（下界 0.150，分差 +4.88） | reject（两轴下界均未达标） |
| cand-goal-remaining | 37.5% ×3 | 50% / 0%（分差 −3.25） | reject |
| cand-rush-plus | 25% / 25% / 50% | 75% / 0%（分差 −2.94） | reject |

- 判定符合预期：示例候选是演示变异而非训练产物，轴 A 下界 0.07–0.14 远低于 0.5 门槛 → 全部 reject。
  双轴**分开**披露可见 cand-js5-fast-gate"泛化强、对冠军弱"的画像——正是单轴评估会漏掉的过拟合信号。
- 轴间种子分区零交集有断言；冠军席位在轴 G 被结构性禁止（防口径合并）。

### 5.3 预注册大规模方案（已生成，未执行）

- `prereg/prereg-plan-30s.json`：9 版本全矩阵，2/3/5 人，30 种子/场 → **5400 局，估算 12.5h**；
- `prereg/prereg-plan-15s.json`（推荐单人夜间档）：2/5 人，15 种子/场 → **1620 局，估算 3.9h**；
- 两案均通过机械校验（`--verify`：种子无重叠、无越块、版本全注册）。
- **执行命令（人工批准后）**：

```bash
# 推荐档（~4h，official 口径 = 冻结冠军 budgetMs=100；方案 prereg-plan-15s.json 已就绪并通过校验）
node training/adversarial/run-league.mjs --mode matrix --players 2,5 --seeds 15 \
  --block prereg --joint official --out training/reports/adversarial-league/prereg

# 全量档（~12.5h；方案 prereg-plan-30s.json 已就绪并通过校验）
node training/adversarial/run-league.mjs --mode matrix --players 2,3,5 --seeds 30 \
  --block prereg --joint official --out training/reports/adversarial-league/prereg
```

---

## 6. 对抗性候选生成接口（供 OpenEvolve / 后续搜索）

`century-adversarial-candidate-v1` JSON 协议（[candidates.example.json](training/adversarial/candidates.example.json)）：

- 三条变异轴：`mutations`（束搜索权重覆盖，越界拒绝）、`parameters`（custom 完整参数）、
  `jointOptions`（冠军引导结构候选：预算/工作量/门控等）；
- `base` 可指向注册表任意版本（血统溯源自动记录基座指纹）或 `custom`；
- **防御**：候选走私 `adapter` 字段直接拒绝（audit 缺陷不会再经此通道复发）；
  mutations 键空间校验；候选 id 强制 `cand-` 前缀（与冻结 id 冲突不可能）；
- 物化纯函数（同 spec 同指纹）；`registerCandidates` 产出隔离评估注册表（原注册表不可变）。

OpenEvolve 集成路径：搜索器产出 spec JSON → `registerCandidates(buildRegistry(), specs)` →
`run-league.mjs --mode evaluate --candidates specs.json` → `selectStrongOpponents` 输出强对手清单。
无需了解联赛内部实现。

---

## 7. 防过拟合双轴评估与强对手筛选

- **轴 A（对抗轴）**：候选 vs `js5-frozen-champion`（2p 头对头 + 5p 有向场双方向）；
- **轴 G（通用轴）**：候选 vs 泛化池（4 风格 + 2 历史冠军 + 中立基线，versionsForSeats 公式轮换，
  冠军席位结构性禁止）；
- **强对手双门槛**（`selectStrongOpponents`，显式可配）：
  - 轴 A Wilson 95% 下界 ≥ 0.5（"有证据地对 JS5 构成威胁"）；
  - 轴 G 下界 ≥ 0.2 且泛化分差 ≥ −3（"不是只会打 JS5 的一招鲜"）；
- 判定四档：`strong` / `specialist`（只过轴 A）/ `weak-vs-champion`（只过轴 G）/ `reject`；
  输出标准化版本描述符 + 指纹（第六阶段可直接经 `--versions` 注入复现）。

---

## 8. 验收对照

| 验收项 | 状态 |
|---|---|
| 对手注册、版本注入、赛程、结果统计自动测试 | ✅ 35 项（registry 9 / audit 3 / candidate 7 / league 11 / evaluate 5） |
| 2–5 人联赛端到端冒烟（少量种子） | ✅ 120 局 0 异常 + 60 局评估冒烟 |
| 冻结版本身份不随当前冠军切换变化 | ✅ 归档读取 + 双重注入测试 |
| 所有参赛 AI 只使用合法公开信息 | ✅ 三核心全部只消费公开观察；非法行动由正式引擎裁决 |
| 强对手清单与标准化版本描述符输出 | ✅ `selectStrongOpponents`（schema `century-adversarial-strong-opponents-v1`） |
| 独立草稿 PR，不合并 | ✅ 见 PR（draft） |
| 夜间限制：无长训练、不触验证池、不依赖 JS6 未完成接口 | ✅ 仅冒烟对局（180 局快档）；种子块 [1.4e9,1.5e9) 新登记；零依赖新增接口 |

---

## 9. 限制与下一步

**限制（诚实披露）**

- **L1 引擎代码身份**：本次 dist 为 HEAD@e7d3bfa 重建，指纹 `a0da8883…` ≠ 冠军晋级证据指纹
  `77292a19…`（b029567 构建）。注册表冻结的是**参数身份**；若需"晋级时点字节级冠军行为"，
  正式联赛应在 `b029567` worktree 重建产物后运行（esbuild 确定性已验证可逐位复现）。
- **L2 快档口径**：冒烟全部用 `workUnits:64` 确定性快档——与 official 墙钟口径的搜索深度不同，
  胜率数字不可与正式实验互换。预注册方案统一 official。
- **L3 样本量**：冒烟 n=4–8/cell，矩阵读数只验证框架正确性，任何策略结论需预注册规模。
- **L4 预算模式不可逐位重放**：official 口径下 JS5 决策受墙钟负载影响（既有已知边界），
  可复现性检验须用 workUnits 模式（本框架 fast 档即此模式）。
- **L5 既有对手池缺陷未越权修复**：opponents.mjs / duel.mjs 的 adapter 污染需独立 PR（见 §2.3）。

**下一步（大规模实验命令已就绪）**

1. 人工批准后执行 §5.3 预注册联赛（推荐 15s 档 ≈4h）；
2. OpenEvolve 对接：以 §6 协议产出真实候选批次（建议首批 20–50 个束搜索权重/结构变异 +
   少量 champion-guided 门控变体），走 evaluate 模式（种子块 `matrix-dev`，随后 `prereg`）；
3. 强对手（`strong` 档）进入第六阶段对手清单：对 JS6 候选的"单席位第一名率"评测复用本注册表
   （`--versions` 注入，对手席位从强对手清单轮换）；
4. 独立 PR 修复 §2.3 既有对手池（strip-adapter + 决策核心显式化），并以本注册表替换手写池。

---

## 10. 证据文件清单

- 冒烟矩阵报告：`training/reports/adversarial-league/smoke-2-5-4s/league-report.json`（120 局逐局全披露）
- 评估冒烟报告：`training/reports/adversarial-league/evaluate-smoke/evaluation-report.json`
- 预注册方案：`training/reports/adversarial-league/prereg/prereg-plan-{15s,30s}.json`
- 测试：`training/tests/adversarial-{registry,audit,candidate,league,evaluate}.test.mjs`（35 项）
- 种子登记：`ai5/lib/seed_policy.mjs`（`AI6_ADVERSARIAL_LEAGUE_BLOCK` 及 4 子块）
