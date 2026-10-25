# Century AI 7.0｜任务 D：自主进化平台升级报告

- 仓库：`https://github.com/Xike-yuhuofei/Century`
- 分支：`feat/ai7-evolution-pipeline`
- 统一 main SHA：`19fa56403aa36ef20d0338e5c3f502de39830802`
- 独立 Worktree：`/Volumes/Extreme SSD/Projects/Century-ai7-evolution`
- 独立 PR：`https://github.com/Xike-yuhuofei/Century/pull/46`
- 交付日期：2026-10-25
- 正式冠军：`joint-js5`（本任务未改动）

---

## 0. 结论

本轮把"人工串联 OpenEvolve、手工搬候选代码/参数、只选一次快筛冠军"的流程，升级为一个**可检查点、可恢复、可停止、可审计、只使用开发池**的轻量进化控制面：

1. **Candidate Artifact v1** 统一了候选身份、源码/构建哈希、参数版本、规则版本、实验配置/种子引用、证据目录与安全状态；生成、打包、注册、加载、复现验证均有独立接口。编译型候选把 tsc 产物内容随 artifact 一起封印，加载侧无需原构建目录即可复核。
2. **多目标进化接口**从单一 `acquisitionValue` 扩展为 5 个资源/策略评价目标 + 6 个有界搜索控制目标；每个目标都有输入白名单、隐藏信息拒绝、资源预算、回退与独立回归。
3. **真实独立编译**：新增 `acquisitionValue` 编译型候选路径——AI5 `static_check`（Seatbelt）→ `assemble_candidate`（Seatbelt）→ `tsc`（Seatbelt）→ 编译产物哈希 → artifact；探针同样在 Seatbelt 内执行。
4. **搜索多样性**通过治理窗口轮换、历史/风格对手轮换、父候选继承、行为签名、去重与多候选保留实现；快筛与深验使用物理隔离的种子窗口。
5. **Campaign Controller** 跑通了"生成（含可选独立编译）→ 统一安全检查 → 快筛 → 筛选 → 深验 → 待人工审批挑战请求 → 诊断 → 下一轮"闭环，支持 checkpoint、断点恢复、安全停止、M4 预算、失败隔离、完整日志与重复运行保护。
6. **失败诊断回流**把现有 `diagnostics` / `human-analytics` 公开诊断映射为 6 类可复现标签，只生成研究提示与课程配置；显式 `advisoryOnly=true`、`notRewardTruth=true`、`rewardModified=false`。
7. **轻量闭环演示**用 6 个候选、18 局开发池对局完成端到端验证，14 项验收检查全部 PASS；中途停止后从检查点恢复；生成 1 个 `pending-human-approval` 正式挑战请求；冠军、账本、验证账本哈希零变化。

**本轮不声称产生了强于 JS5 的算法**。深验只有 6 局，且结果仅用于人工审核；本次待审批请求的深验判定为 `no-advantage`（小样本），人工应重点复核或拒绝；正式挑战与冠军晋级均未触发。

---

## 1. 执行约束核对

| 约束 | 执行情况 | 证据 |
| --- | --- | --- |
| 1. 统一 main SHA 独立 Worktree | 使用 `19fa564…` 创建 `Century-ai7-evolution`，分支 `feat/ai7-evolution-pipeline` | `git rev-parse HEAD`、本报告元信息 |
| 2. 不直接修改冠军决策代码/参数 | 未改 `web-v1/src/ai/decision.ts`、`web-v1/src/ai/parameters.ts`、`champion.json` | 演示前后 guardrail 哈希一致；`changedFiles=[]` |
| 3. 不改 Agent A 账本/晋级门禁核心 | 未改 `training/lib/seeds.mjs`、`training/tournament/challenge.mjs`、`training/adversarial/seed-ledger.mjs`、`ai5/lib/seed_policy.mjs` | `git status` 仅新增 evolution 控制面与演示产物 |
| 4. 通过适配器消费统一治理接口 | `governance-adapter.mjs` 定义 v1 provider contract；测试替身仅用于离线研发 | `tests/governance.test.mjs` 7 项 |
| 5. 不消耗正式验证池、不自动晋级 | 验证池 `[900M,1.06e9)` 在适配器与核心层硬拒绝；控制器只产生待审批请求 | 演示窗口 `1.61e9/1.62e9`；`validationPoolConsumed=false`、`promotionTriggered=false` |
| 6. 默认轻量验证、不长时间训练 | 演示 18 局、总墙钟约 180 秒（含一次 tsc 编译）；无 PPO/长训练 | `demo-summary.json` |
| 7. LLM 仅离线研发、最终推理本地 | OpenEvolve 适配器只解析有界 JSON 提案，不进入运行时；编译型候选源码来自官方函数的有界单点变异，演示无 LLM 调用 | `openevolve-adapter.mjs`、`tests/openevolve.test.mjs`、`compiled-candidate.mjs` |

---

## 2. 架构总览

```text
┌────────────────────────────────────────────────────────────────────┐
│ Campaign Controller（campaign-controller.mjs）                      │
│  生成 → 安全检查 → 构建校验 → 快筛 → 多维筛选 → 深验               │
│  → 待人工审批挑战请求 → 结果归档 → 失败诊断 → 下一轮               │
│  checkpoint / resume / safe-stop / M4 budget / failure isolation    │
└───────────────┬───────────────────────────────┬────────────────────┘
                │                               │
    ┌───────────▼───────────┐       ┌───────────▼────────────┐
    │ Candidate Generator   │       │ Governance Adapter     │
    │ 有界变异 / OpenEvolve │       │ dev-only seed windows  │
    │ 提案 / 父候选继承     │       │ human-approval requests│
    └───────────┬───────────┘       └────────────────────────┘
                │
    ┌───────────▼───────────┐       ┌────────────────────────┐
    │ Candidate Artifact v1 │       │ Artifact Store         │
    │ 身份/源码/构建/规则   │◄──────►│ 内容寻址、哈希复核     │
    │ 实验/证据/安全状态    │       │ 去重/禁止覆盖          │
    └───────────┬───────────┘       └────────────────────────┘
                │
    ┌───────────▼───────────┐       ┌────────────────────────┐
    │ Dev Evaluator         │       │ Failure Labels         │
    │ screen/deep 独立分区  │       │ diagnostics → hints    │
    │ 对手轮换 + 行为签名   │       │ advisoryOnly           │
    └───────────────────────┘       └────────────────────────┘
```

新增代码全部位于 `training/evolution/`，不替换任何正式决策或评价实现。

---

## 3. D1：Candidate Artifact v1

### 3.1 字段

`candidate-artifact.mjs` 定义 `century-candidate-artifact-v1`，至少包含任务书要求的全部字段：

| 字段 | 含义 |
| --- | --- |
| `candidateId` | `cand-` 前缀稳定候选 id |
| `parentId` | 父候选/基线（可为空） |
| `sourceHash` | 源码身份哈希（descriptor 候选 = 描述符身份；声明模块 = 文件内容哈希） |
| `algorithmStructure` | 目标插件、决策核心、结构、jointVersion、评测模式、分人数适配器选项、生产隔离级别 |
| `parameters` | `{id, version, values, boundsVersion}` |
| `buildArtifact` | `{kind, sha256, compiled, compiler, reproducible}` |
| `gameRules` | 规则语义版本 + `engineBundleSha256` |
| `experiment` | `configRef` + `configHash` + `seedRefs[{purpose,windowId,base,count}]` |
| `applicablePlayerCounts` | 2–5 人适用子集 |
| `evidenceDir` | 评测证据目录（由控制器写入） |
| `safety` | `{status, checks[]}` |
| `identityDigest` | 算法身份哈希（不含实验/证据/安全状态，跨 campaign 稳定） |
| `artifactHash` | artifact 全文封印（任何字段改动都会检出） |

### 3.2 双哈希语义

- `identityDigest`：覆盖 `candidateId/parentId/sourceHash/algorithmStructure/parameters/buildArtifact/gameRules/applicablePlayerCounts`。同一候选换实验窗口或更新证据时不变。
- `artifactHash`：覆盖除自身外全部字段；`ArtifactStore.get()` 读取即重算，篡改立即失败。
- 独立复现检查 `verifyArtifactReproducibility()` 会重算：source 文件内容哈希 → sourceHash → buildArtifact → identityDigest → artifactHash。

### 3.3 打包/注册/加载

`ArtifactStore`（`artifact-store.mjs`）采用内容寻址：

```text
artifacts/
  objects/<candidateId>/<identityDigest>/candidate.json
  objects/<candidateId>/<identityDigest>/source/<path>
  index.jsonl   # 只追加审计日志
```

- `put()`：写入临时文件 + rename；同 id 同身份幂等；**同 id 不同身份直接拒绝**，防止人工覆盖历史候选。
- `get()`/`list()`/`verify()`：读取即校验全部哈希。
- `findByIdentity()`：供多样性去重/别名检测。
- 写入禁止路径穿越（`..`/绝对路径拒绝）。

### 3.4 构建产物的三种形态

| `buildArtifact.kind` | `compiled` | 用途 | 哈希覆盖 |
| --- | --- | --- | --- |
| `descriptor-bundle-v1` | false | 参数/搜索控制候选 | 确定性运行描述符 |
| `declarative-module-bundle-v1` | false | 声明式线性模块候选 | 声明模块内容 |
| `esm-module-bundle-v1` | **true** | 真实 TS 函数候选 | tsc 产物内容（随 artifact 封印） |

编译型候选的 `buildArtifact.files` 内含 `dist/js/ai/evaluator.js` 全文与 SHA256，`validateArtifact` 读取即重算，篡改立即失败。路径为：

```text
官方 acquisitionValue 函数（单点有界变异 goalFit 2.0→2.4）
  → EVOLVE-BLOCK 包装
  → AI5 static_check（沙箱）
  → assemble_candidate（沙箱，复制官方源码树并替换函数）
  → tsc（沙箱）
  → 编译产物哈希 + artifact
```

本轮只启用 `acquisitionValue` 一个编译型目标，且变异点固定、可审计；**不允许 LLM 任意改写整个引擎**。其余资源目标仍为声明式模块，避免在 Agent C 的正式评价函数合并前越界。

---

## 4. D2：多目标进化接口

### 4.1 目标清单

`evolution-targets.mjs` 注册 11 个目标：

| 组 | 目标 | 形态 | 评测 | 生产接线 |
| --- | --- | --- | --- | --- |
| 资源/策略评价 | `acquisitionValue` | 声明式线性模块 **或编译型函数候选** | proxy | 未接线（Agent C 正式实现零改动） |
| 资源/策略评价 | `engineValue` | 声明式线性特征模块 | proxy | 未接线 |
| 资源/策略评价 | `goalValue` | 声明式线性特征模块 | proxy | 未接线 |
| 资源/策略评价 | `keepValue` | 声明式线性特征模块 | proxy | 未接线 |
| 资源/策略评价 | `restValue` | 声明式线性特征模块 | proxy | 未接线 |
| 搜索控制 | `gateThreshold` | `contestThreshold ∈ [0.5,0.99]` | game | JS5 adapter 选项 |
| 搜索控制 | `overrideMargin` | `[0,0.2]` | game | JS5 adapter 选项 |
| 搜索控制 | `candidateCap` | 整数 `[2,8]` | game | JS5 adapter 选项 |
| 搜索控制 | `searchBudget` | 整数 `workUnits ∈ [8,512]` | game | JS5 adapter 选项 |
| 搜索控制 | `searchBudgetAllocation` | 2–5p 各自 `workUnits` | game | JS5 adapter 选项 |
| 搜索控制 | `playerCountScope` | 适用人数子集 | game | 候选 artifact 结构 |

### 4.2 每个目标的强制契约

| 要求 | 实现 |
| --- | --- |
| 类型与输入检查 | `validateValues` / `normalizeModuleSpec` / `normalizeSearchValues`；未知字段/越界/非整数直接拒绝 |
| 不允许隐藏信息 | `assertTargetInput` 顶层白名单 + `HIDDEN_INFO_KEYS` 递归扫描；`merchantDeck/golemDeck/deck/seed/random/...` 一律拒绝 |
| 资源预算 | 模块：输入 ≤8192B、求值 ≤5ms、输出有限且 clamp；搜索控制：候选/局数/墙钟预算 |
| 安全沙箱 | 声明式模块**不执行候选代码**；编译型 `acquisitionValue` 候选的静态检查、组装、tsc、探针全部在 macOS Seatbelt 内，非 macOS 直接 fail closed |
| 回退机制 | 非法输入/非有限/超预算 → 默认系数或冻结冠军默认选项，并记录 `fallbackHit` |
| 独立回归测试 | 每个资源目标 ≥2 个 fixture；`tests/targets.test.mjs` 逐目标运行 |

安全门禁（`safety-check.mjs`）在 artifact 注册后按目标边界复核真实承载位置：搜索控制的 `jointOptionsByPlayerCount` 必须逐人数落在目标边界内、模块系数必须经 `normalizeModuleSpec`、冠军权重必须经正式 `validateAIParameters`。`playerCountScope` 的结构值取 `applicablePlayerCounts`，不依赖 `parameters.values`。这样即使候选绕过生成器被手工重封印，也无法把越界参数送进评估。

### 4.3 不修改正式评价函数

- 5 个资源/策略目标均为 `decisionCore='plugin-only'`、`integration='candidate-plugin-only'`、`productionWiring='not-wired'`。
- 其证据类型固定为 `offline-proxy`，`productionWiring='not-wired'`，**不冒充对局强度**。
- 搜索控制目标通过 `seatVersionFor()` 生成 `champion-guided` 席位选项，走既有 JS5 adapter 分派；`web-v1/src/js/champion-guided.ts` 与冠军归档参数未改动。

### 4.4 OpenEvolve 接入边界

`openevolve-adapter.mjs` 定义 `century-ai7-openevolve-proposal-v1`：

- LLM 只能输出 JSON 提案 `{schema,targetId,values,rationale}`；
- 禁止字段：`source/code/imports/shell/parameters/engine/patch`；
- 提案逐项校验，非法项进入 `rejected`，合法项物化为 Candidate Artifact；
- `openEvolvePromptContract()` 提供稳定 prompt 正文，不含密钥/路径；
- LLM 不参与最终游戏推理。

### 4.5 编译型候选适配器

`compiled-candidate.mjs` 复用 AI5 已验证工具链，把“函数候选”从人工搬运变成可复现构建：

- 源码来源：官方 `acquisitionValue` baseline 函数，单点变异 `goalFit * 2` → `goalFit * 2.4`；变异点必须唯一，否则拒绝；
- `static_check.mjs`：EVOLVE-BLOCK、签名、禁止构造、括号配平；在 Seatbelt 内执行；
- `assemble_candidate.mjs`：复制官方源码 import 闭包，仅替换演化函数，逐文件哈希固证；在 Seatbelt 内执行；
- `tsc`：独立工作目录编译，`noEmitOnError`；在 Seatbelt 内执行；
- artifact：`source.kind='esm-module-bundle'`、`buildArtifact.compiled=true`、`kind='esm-module-bundle-v1'`、`files` 内含编译产物全文与哈希；
- 探针：`probe_compiled.mjs` 在 Seatbelt 内导入官方与候选 evaluator，只使用公开 fixture，输出 `offline-proxy` 证据；
- 非 macOS / Seatbelt 不可用：创建编译型候选直接抛错，控制器按“生成即拒绝”隔离，绝不无沙箱执行。

---

## 5. D3：搜索多样性

### 5.1 种子窗口轮换与物理隔离

- AI7 开发池（本轮新开，未写入 Agent A 的 `seed_policy.mjs`）：
  - screen：`[1_610_000_000, 1_620_000_000)`
  - deep：`[1_620_000_000, 1_630_000_000)`
- 正式验证池 `[900M, 1.06e9)` 在 `core.mjs`/`governance-adapter.mjs` 硬拒绝。
- `governance.allocateDevSeedWindow({round,purpose,excludeWindowIds})` 按轮次轮换窗口；同一 campaign 不重复使用窗口。
- `assertIndependentWindows()` 强制 screen/deep 种子集合零交集，且各自落在对应区块。

> **必须披露的限制**：AI7 区块尚未在 `ai5/lib/seed_policy.mjs` 登记。正式集成 Agent A 的可信治理接口时，必须由该接口登记区块并通过单一账本分配；本轮测试替身不产生正式证据。

### 5.2 对手多样性

`dev-evaluator.mjs`：

- screen：轮换 `ai5-readiness-efficiency`（历史冻结冠军）、`style-rush`、`style-engine`、`style-contest`、`neutral-baseline`、`random-legal`；每局按 `(round−1+seedIndex+i) mod pool` 轮换。
- deep：保持 `js5-frozen-champion` 锚点 + 轮换风格/历史版本；检查"不只赢上一任/单一对手"。
- 所有 champion-guided 席位统一 `workUnits=32`（确定性、轻量、同口径），避免锚点因预算更高而系统性占优。

### 5.3 父候选与行为多样性

- `generateCandidateBatch` 支持 `parentArtifact`：搜索控制值从父候选的 `jointOptionsByPlayerCount` 继承，模块系数从 `parameters.values` 继承；官方基线 = `parent=null`。
- 行为签名：
  - game：动作分布（acquire/claim/rest/play/discard）+ 平均名次/得分/回合数；
  - proxy：目标 id + 归一化系数向量 + bias。
- `selectCandidates()`：
  - 同 `identityDigest` / 同 `behaviorHash` 去重；
  - 先保底各评测模式最高分，再按"game 优先 + 质量 + 最小行为距离"填充；
  - 多候选保留（默认 `retainTopK=3`），不只选一次快筛冠军。

### 5.4 快筛优秀但深验不稳定

控制器新增 `deep-unstable` 状态：

- 深验 `anomalyRate > 0.2` 或 `finishedGames=0` → 标记 `deep-unstable`；
- 不进入正式挑战待审批请求；其他候选继续；
- `tests/controller.test.mjs` 有专门用例验证"深验异常 → 0 个待审批请求"。

---

## 6. D4：Campaign Controller

### 6.1 状态机

```text
initialized
  → generation（静态预检；编译型候选额外完成 Seatbelt 内 assemble+tsc）
  → safety/build checks（逐候选；含编译产物哈希复核）
  → quick eval（逐候选，失败隔离）
  → selection（多维 + 去重 + 多保留）
  → deep confirm（逐候选，独立种子；异常则 deep-unstable）
  → pending-human-approval request（至多 1 个/轮）
  → failure diagnostics
  → next round（可选）
  → completed
```

### 6.2 能力

| 要求 | 实现 |
| --- | --- |
| Checkpoint | 每步写 `state.json` + `checkpoints/state-NNN.json`（保留最近 30 个） |
| 断点恢复 | `run({resume:true})` 校验 `runFingerprint` 后从阶段/候选状态继续 |
| 安全停止 | `requestStop()` 或 `.stop` 文件；步边界停止；可恢复 |
| M4 预算 | `maxCandidates/maxGames/maxWallMs/maxDeepConfirmations`；超限安全停止 |
| 并发限制 | `maxConcurrent` 1–4 校验；当前按单候选串行评估（CPU-bound），绝不超过上限 |
| 独立编译 | 编译型候选在生成阶段完成 `static_check → assemble → tsc`（全部 Seatbelt）；编译失败记为 `rejectedAtGeneration`，隔离失败不阻断其他候选 |
| 候选失败隔离 | 每候选 try/catch；`safety-failed`/`quick-failed`/`deep-failed` 不阻断其他候选 |
| 完整日志 | `logs/events.jsonl`：生成/安全检查/编译产物复核/快筛/筛选/深验/审批/诊断/停止/预算事件 |
| 重复运行保护 | `.campaign.lock`（pid 存活检查）+ state fingerprint；已完成 campaign 拒绝重复运行 |
| 人工审批 | 只调用治理接口创建 `pending-human-approval`；绝不触发挑战/晋级 |

### 6.3 重复运行保护细节

- `statePath` 已存在且未显式 `resume` → 抛错；
- `resume` 时 `runFingerprint` 必须一致，否则拒绝（防错配置复用预算/种子）；
- 已完成状态再次 `resume` → 抛"campaign 已完成——重复运行保护"；
- 活动锁存在且 pid 存活 → 拒绝第二进程。

---

## 7. D5：失败诊断回流

### 7.1 标签

| code | 中文 | 主要来源/规则 |
| --- | --- | --- |
| `engine-deficiency` | 引擎不足 | 魔像≤1 且获卡≤2，或每百行动得分<8 |
| `claim-delay` | 认领延迟 | 竞争机会 ≥3 未转化；或 human-analytics missed-claims |
| `rest-waste` | 休息浪费 | 休息占比 > 全场均值×1.5 且 >0.15；或 rest-cost-high |
| `capacity-waste` | 资源容量浪费 | 弃置 ≥3；或 capacity-waste/resource-mismatch |
| `endgame-error` | 终局错误 | 触发时排名垫底，或触发后错过认领 ≥2；或 endgame-pacing |
| `contest-loss` | 竞争抢牌失败 | 他人获取时本席付得起 ≥3 次；或 goal-competition |

### 7.2 纪律

- 每个标签输出 `finding / inconclusive / absent` + 证据 + 规则 id；
- 同一输入重复运行逐字节一致（无墙钟/随机）；
- `speculations` 只保留在行级，绝不进入 label evidence；
- `toResearchHints()` 输出：
  - `suggestedTargets`：标签 → 目标优先级；
  - `promptHints`：自然语言研究提示；
  - `curriculum`：`advisoryOnly=true`、`notRewardTruth=true`、`rewardModified=false`；
  - `hintDigest`：可复现指纹。

演示读取 `training/reports/diagnostics-latest/analysis.json`，得到：
- `claim-delay`（32 次）、`contest-loss`（32 次）；
- 建议目标：`candidateCap`、`overrideMargin`、`goalValue`、`acquisitionValue`；
- 下一轮生成器通过 `hints.suggestedTargets` 提高相关目标权重，但不改变评分/奖励。

---

## 8. D6：轻量闭环演示结果

演示目录：`training/reports/ai7-evolution-demo/`

### 8.1 运行参数

| 项 | 值 |
| --- | --- |
| 模式 | `real-dev-games (lightweight)` |
| 候选数 | 6（5 个通过安全，1 个安全失败；另有 1 个生成即拒绝） |
| 编译型候选 | 1 个 `acquisitionValue`（tsc 5.9.3，Seatbelt 探针） |
| 对局数 | 18（快筛 12 + 深验 6） |
| 深验确认 | 1 |
| 总墙钟 | 142,024 ms（含一次独立编译） |
| screen 窗口 | `ai7-screen-w000`，种子 `1610000000, 1610000001` |
| deep 窗口 | `ai7-deep-w000`，种子 `1620000000, 1620000001, 1620000002` |
| 停止/恢复 | 第 1 次 `run(maxSteps=8)` → `stopped`；第 2 次 `resume` → `completed` |
| 检查点 | 21 个 |

### 8.2 候选结果

| 候选 | 模式 | 阶段 | 快筛分 | 深验分 | 快筛第一名率 | proxy Δ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `cand-ai7-searchbudget-r1c0-bfe007` | game | not-selected | 0.6580 | — | 0.500 | — |
| `cand-ai7-candidatecap-r1c1-33cef5` | game | pending-approval | 0.7015 | 0.5763 | 0.750 | — |
| `cand-ai7-overridemargin-r1c0-3a144d` | game | selected | 0.6591 | — | 0.500 | — |
| `cand-ai7-acquisitionvalue-r1c1-d31db4` | proxy (声明式) | selected | 0.7366 | — | — | +0.0421 |
| `cand-ai7-compiled-acq-r1c4-1d7b60` | proxy (编译型) | selected | 0.7325 | — | — | +0.0274 |

- 安全失败候选：`cand-ai7-enginevalue-r1c3-acf817`（`hidden-info` + `forbidden-constructs`，被隔离）。
- 生成即拒绝：`candidateCap=99` 越界，未进入候选池。
- 多候选保留：2 个 game + 2 个 proxy（4 个保留）。
- 编译型候选：`buildArtifact.kind=esm-module-bundle-v1`、`compiled=true`、`compiler=tsc 5.9.3`；产物 `dist/js/ai/evaluator.js` 全文随 artifact 封印，Seatbelt 探针 2 个公开 fixture、0 错误。
- 深验候选 `candidatecap` 在独立 deep 窗口 6 局：`firstPlaceRate=0.1667`、`chanceAdjustedRate=-0.25`、`minWilsonLower=0`、`anomalyRate=0`。这**只是 6 局的人工审核信号，不构成强于或弱于 JS5 的结论**；本次信号为负，人工应拒绝或要求更大样本。

### 8.3 待审核请求

- request：`greq-030de52c930dd0ff`
- 候选：`cand-ai7-candidatecap-r1c1-33cef5`
- 状态：`pending-human-approval`
- `approvalRequired=true`、`promotionTriggered=false`、`validationPoolConsumed=false`
- 深验评估：`verdict=no-advantage`、`chanceAdjustedRate=-0.25`、`minWilsonLower=0`、`anomalyRate=0`、`finishedGames=6`
- 请求正文标注 `review-required (weak/inconclusive signal)`；这只是流程演示请求，**不是晋级建议**
- 文件：`training/reports/ai7-evolution-demo/pending-approval/greq-030de52c930dd0ff.json`

### 8.4 验收检查（全部 PASS）

```text
multipleValidCandidates       PASS
independentArtifacts          PASS
evidenceIndependence          PASS
safetyChecksRan               PASS
failureIsolation              PASS
generationRejectedInvalid     PASS
selectedMultiple              PASS
deepConfirmed                 PASS
pendingHumanApproval          PASS
stopAndResume                 PASS
noValidationPoolConsumption   PASS
noChampionMutation            PASS
diagnosticsFlowedBack         PASS
advisoryOnlyHints             PASS
```

Guardrails：

- `changedFiles=[]`
- `championAndLedgerUnchanged=true`
- `validationPoolConsumed=false`
- `promotionTriggered=false`
- `formalChallengeApprovalRequired=true`

### 8.5 可复现命令

```bash
cd training

# 1) 新增测试（62 项；编译型用例在非 macOS 自动 skip）
npm run evolution:test

# 2) 轻量真实对局演示（约 3 分钟，18 局，含一次 Seatbelt 内 tsc）
npm run evolution:demo

# 3) 仅验证演示逻辑（假评估器，不跑对局）
npm run evolution:demo:fake
```

演示产物：

- `training/reports/ai7-evolution-demo/state.json`
- `training/reports/ai7-evolution-demo/results.json`
- `training/reports/ai7-evolution-demo/logs/events.jsonl`
- `training/reports/ai7-evolution-demo/checkpoints/`
- `training/reports/ai7-evolution-demo/artifacts/`
- `training/reports/ai7-evolution-demo/evidence/`
- `training/reports/ai7-evolution-demo/pending-approval/`
- `training/reports/ai7-evolution-demo/diagnostics/`
- `training/reports/ai7-evolution-demo/demo-summary.json` / `.md`
- `training/reports/ai7-evolution-demo/governance-audit.json`

---

## 9. 测试与回归

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `npm run evolution:test` | **62/62 pass** | artifact/targets/safety/compiled/governance/selection/generator/openevolve/failure-labels/controller/demo |
| `npm test`（既有训练套件） | **153/153 pass** | 运行约 10 分钟，未受影响 |
| `web-v1 npm run build` | 成功 | 测试依赖的 `dist/js` 已构建；未改源码 |
| 演示真实对局 | 18 局，0 异常 | `demo-summary.json` |

关键测试文件：

- `training/evolution/tests/artifact.test.mjs`：双哈希、篡改检出、store 覆盖保护、独立加载。
- `training/evolution/tests/targets.test.mjs`：11 目标、边界、隐藏信息、预算回退、搜索控制映射与 fail-safe 回退。
- `training/evolution/tests/safety.test.mjs`：重封印 artifact 的联合选项/模块系数/冠军权重越界必须 fail-closed；`playerCountScope` 合法候选可通过。
- `training/evolution/tests/compiled.test.mjs`：真实 tsc 编译、产物哈希、store 注册/加载/复现、篡改检出、Seatbelt 探针、源码走私拒绝。
- `training/evolution/tests/governance.test.mjs`：dev-only、验证池拒绝、自动批准/晋级拒绝。
- `training/evolution/tests/selection.test.mjs`：行为距离、去重、多保留、分区、对手轮换。
- `training/evolution/tests/generator.test.mjs`：确定性、父候选继承、失败隔离。
- `training/evolution/tests/openevolve.test.mjs`：提案边界、代码走私拒绝。
- `training/evolution/tests/failure-labels.test.mjs`：标签确定性、证据分层、advisoryOnly。
- `training/evolution/tests/controller.test.mjs`：checkpoint/resume/stop/budget/failure isolation/deep-unstable/approval。
- `training/evolution/tests/demo.test.mjs`：端到端演示逻辑与护栏。

---

## 10. 交付物

| 交付 | 位置 |
| --- | --- |
| 1. Candidate Artifact v1 | `training/evolution/candidate-artifact.mjs`、`artifact-store.mjs` |
| 2. 多目标进化接口 | `training/evolution/evolution-targets.mjs`、`feature-extractors.mjs`、`openevolve-adapter.mjs` |
| 3. Campaign Controller 原型 | `training/evolution/campaign-controller.mjs`、`compiled-candidate.mjs`、`sandbox/` |
| 4. 安全与可复现测试 | `training/evolution/tests/`（62 项） |
| 5. 轻量闭环演示及日志 | `training/reports/ai7-evolution-demo/` |
| 6. 报告 | 本文件 |
| 7. 独立 PR | 分支 `feat/ai7-evolution-pipeline`；PR #46 |

---

## 11. 风险、限制与后续集成

### 11.1 本轮明确未做

1. **没有证明强于 JS5**：演示仅 18 局，深验 6 局且信号为负；样本量不足以做胜负结论。
2. **没有改正式评价函数**：5 个资源目标只走候选插件接口，proxy 证据不进入正式评分。
3. **编译型候选只覆盖一个目标**：本轮只启用 `acquisitionValue` 的固定单点变异；其余 4 个资源目标仍是声明式模块。开放任意函数/多目标编译需要新的目标注册、Seatbelt profile 与独立安全评审。
4. **治理接口仍是测试替身**：AI7 区块未写入 `seed_policy.mjs`；正式集成需 Agent A 登记区块、单一账本、并发分配与 alpha 治理。
5. **没有自动晋级**：只有 `pending-human-approval` 请求；正式挑战、验证池、champion.json 均未触碰。
6. **没有运行 LLM**：OpenEvolve 适配器只定义了提案边界与解析器；编译型候选源码来自官方函数的有界变异，不使用 LLM；最终推理完全本地。

### 11.2 与 Agent A/C 的正式集成清单

1. Agent A：登记 AI7 开发区块；`allocateDevSeedWindow` 改为单一账本原子分配；请求/审批状态回写账本；并发测试。
2. Agent C：把 5 个资源目标的声明式模块接入正式评价函数前，必须另开 PR、走正式回归/消融/挑战；不得在本分支直接替换。
3. 搜索控制目标：`contestThreshold/overrideMargin/candidateCap/workUnits/分人数预算` 已通过现有 JS5 adapter 选项生效；正式挑战前仍需独立预注册与 alpha 治理。
4. 证据：正式挑战候选包应把本轮 `evidence/`、`pending-approval/`、artifact hash 一起归档到 PR/评审记录。

### 11.3 为什么没有直接接正式验证池

正式验证池的消费必须由 Agent A 的账本与晋级门禁统一管理；本轮使用测试替身和独立开发块，是为了在不污染正式证据的前提下验证控制面本身。任何"用正式验证结果反复调候选"的做法都被适配器边界和 `assertNotValidationSeed` 明确禁止。

---

## 12. 总结

本轮交付的不是"又一个更强的参数"，而是一个**可持续运行、可审计、可停止/恢复、只消费开发池、把正式挑战交还人工审批**的进化平台底座：

- 候选从"人工搬运代码/参数"变成可哈希、可加载、可复现的 artifact；
- 函数候选从"人工替换文件"变成 Seatbelt 内 `static_check → assemble → tsc → 哈希` 的可复现构建；
- 搜索空间从单函数扩展为 5 个评价目标 + 6 个有界搜索控制目标；
- 评估从"固定种子 + 单一对手 + 只选冠军"变成轮换窗口、历史/风格对手、行为多样性、多候选保留；
- 闭环从"人盯脚本"变成带检查点、预算、失败隔离和完整日志的 controller；
- 诊断从"报告里的一段话"变成可复现标签 + advisory-only 研究提示/课程配置；
- 演示证明了平台能安全生成、筛选、停止、恢复、请求人工审批，且冠军/账本零改动。

这为未来连续进化提供了可复现的技术基础；下一阶段的重点应是 Agent A 治理接口正式合并、Agent C 评价函数插件接入，以及在预注册协议下用正式验证池做少量、严格控制的多代挑战。
