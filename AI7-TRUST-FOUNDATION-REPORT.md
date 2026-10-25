# AI7 · 可信研发底座全面修复报告（任务 A）

> 分支：`fix/ai7-trust-foundation`  
> 基准：`origin/main = 19fa56403aa36ef20d0338e5c3f502de39830802`  
> 独立工作区：`/Volumes/Extreme SSD/Projects/Century-ai7-trust`  
> 审计输入：`01-可靠性与正确性审计报告.md`、`03-自主进化架构审计报告.md`（优先）、`02-AI-实战竞技能力审计报告.md`、`04-工程与产品审计报告.md`

---

## 0. 结论摘要

| 验收项 | 状态 | 证据 |
|---|---|---|
| 关键失败模式全部 fail-closed | **完成** | A5 负向测试逐项阻断；`promote.test.mjs` 20 项、`ai7-trust.test.mjs` 9 项 |
| 历史数据不被覆盖 | **完成** | 所有历史账本只读扫描；`historical-seed-claims.json` 保留 long20 未入账区间与不确定状态；未改写任何 `validation-ledger.json` / `champion.json` |
| 当前正式冠军决策行为不被本任务改变 | **完成** | `champion.json`、`CHAMPION_PARAMETERS` 参数值、`decision.ts` 默认路由均未改；仅把「实际消费的参数」显式注入并纳入身份 |
| 统一证据/身份校验可复用 | **完成** | `training/lib/seed-governance.mjs`、`training/lib/version-lock.mjs`、`web-v1/scripts/build-hash.mjs` + CLI |
| 所有相关测试通过 | **完成** | 见 §7（web-v1 与 training 全量） |
| 验证池零消费 / 未执行正式挑战 | **完成** | `training/governance/seed-consumption-registry.json` entries=0；下一块仍为 `941514652`，下一 challengeIndex=12 |

**最重要的一句话**：本次没有让任何旧证据"变绿"，而是把"缺账本、缺人数、缺源码指纹、序号可伪造、产物可陈旧"的路径全部改成显式拒绝；既有 `joint-js5` 冠军证据仍按治理状态标记为**待重新验证**，没有重新晋级，也没有改写历史 provenance。

---

## 1. 审计基准、工作区与纪律

- 基准 SHA：`19fa56403aa36ef20d0338e5c3f502de39830802`（`origin/main`）。
- 独立 worktree：`/Volumes/Extreme SSD/Projects/Century-ai7-trust`（分支 `fix/ai7-trust-foundation`）。
- 未修改正式冠军参数、生产默认路由、游戏规则。
- 未执行任何正式挑战；未消费验证种子池；`seed-consumption-registry.json` 保持空账本。
- 未直接合并 `main`；交付为独立 PR，等待人工审查。

---

## 2. 任务 A1：实验种子账本统一

### 2.1 统一治理层（新增）

`training/lib/seed-governance.mjs` 不是"又一本账"，而是跨系统治理层：

| 能力 | 接口 |
|---|---|
| 全来源只读归一化 | `loadSeedGovernance({ root, strict, extraLedgers })` |
| 种子/区间冲突查询 | `querySeed(registry, seed)`、`queryInterval(registry, base, size)` |
| 下一正式挑战块 | `nextFormalValidationBase(registry)` |
| 累计正式挑战次数 | `formalChallengeCount(registry)`（唯一区间数，不信任任一账本自报 `challengeCount`） |
| 正式挑战启动校验 | `assertFormalChallengeAllocation({ base, size, challengeIndex })` |
| 晋级证据登记校验 | `assertPromotionEvidenceRegistered({ seatEvidence })` |
| 新消费原子登记 | `reserveConsumption(...)`（O_EXCL 文件锁；作废继续占用区间） |
| 收尾 | `completeConsumption(experimentId, { status })` |
| CLI | `node training/scripts/seed-governance-cli.mjs status|check|next|query|reserve|complete` |

统一账本来源（`LEDGER_SOURCES`，全部 fail-closed 读取）：

| 来源 | 账本 | 用途分类 | 计入正式 challengeIndex |
|---|---|---|---|
| AI4 evolve | `training/reports/evolve-latest/validation-ledger.json` | formal-challenge | 是 |
| 结构挑战确认 | `training/reports/structure-challenge-rollout-confirm/validation-ledger.json` | formal-challenge | 是 |
| OpenEvolve 正式挑战 ×4 | `ai5/openevolve/experiments/reports/challenge-*/validation-ledger.json` | formal-challenge | 是 |
| JS5 正式/晋级挑战 | `training/reports/js5-formal-challenge/`、`js5-promotion-challenge/` | formal-challenge | 是 |
| 种子复用作废样本 | `training/reports/js5-promotion-challenge-invalid-seedreuse/` | formal-challenge（invalid-evidence） | 去重后不增计数 |
| OpenEvolve 深度验证 | `ai5/openevolve/results/deep-validation-ledger.json` | deep-validation | 否 |
| PPO arena | `ai5/ppo/reports/seed-ledger.json` | arena（验证池块）/ training（训练池块） | 否 |
| AI6 联赛 | `training/adversarial/seed-ledger.json` | league | 否 |
| AI6 基线 | `training/baseline/seed-ledger.json` | baseline | 否 |
| 统一新消费登记 | `training/governance/seed-consumption-registry.json` | 按登记 | 正式挑战为是 |
| 历史未入账声明 | `training/governance/historical-seed-claims.json` | deep-validation（只读） | 否 |

### 2.2 修复的 fail-open 路径

| 审计问题 | 修复前 | 修复后 |
|---|---|---|
| P1-1 evolve-cli 缺账本 fail-open | `nextValidationBase(null)` 按 `GITHUB_RUN_ID` / 当前小时派生起点；`assertBlockFree(..., null)` 直接放行 | `evolve-cli` 必须显式 `--seed-ledger` 且文件存在；`nextValidationBase(null)` / 空账本直接抛错；分配经统一治理层 |
| P1-2 promote 账本条件性核对 | 无 sibling `validation-ledger.json` 时仅记录 `ledgerCrossChecked:false` 仍可晋级 | 账本强制存在；必须累计到本次最大 `challengeIndex`；统一治理层复核全部来源 |
| P2-8 显式 `--resume` 缺失静默重跑 | 不存在则 `initialState=null` 从头开始 | `--resume` 指向缺失文件直接抛错（禁止重复消费训练种子块） |
| PPO 900M 验证块未被正式账本识别 | 正式挑战只合并 `validation-ledger.json` | 统一治理层从 PPO 账本识别 `[900000000, 900000040)`（arena 用途），计入防重但不计入正式 alpha |
| long20 深验未入账 | 下一次 100 种子分配 `[300001103,300001203)` 与 `[300001200,300001299)` 重叠 | `historical-seed-claims.json` 只读声明该区间，`occupiesRange=true`、`status=historical-unverified`，继续占用；不伪造账本条目 |
| PPO `challengeCount=3` 与 1 条验证条目不一致 | 可能被当作正式挑战计数 | 明确标记为历史账本缺陷；`formalChallengeCount` 不采样任何自报 `challengeCount` |

### 2.3 新消费登记链路

- AI4 evolve：`reserveConsumption` → 挑战 → 写本地账本（合并全局正式历史 + `challengeIndex` 元数据）→ `completeConsumption`。
- JS5 / OpenEvolve 正式挑战：同上；挑战开始前登记，代码冻结/挑战失败也保留区间占用。
- 联赛：`training/adversarial/seed-ledger.mjs` 在写本地账本前登记；CRN 仅当双方显式同 `crnGroup` 时可共享区间。
- 基线：`training/baseline/seed-ledger.mjs` 分配前登记；正式账本缺失 fail-closed。
- PPO arena / OpenEvolve 深验：Python 侧新增 `ai5/lib/seed_governance_bridge.py`，在写本地账本前调用 Node 治理 CLI；拒绝即中止。
- 深验账本 / PPO 正式账本缺失：不再按空账本继续分配。

### 2.4 历史迁移与兼容性

- 历史账本**未修改**；所有旧条目按原文件读入，缺 `size` 的 `924140000/924142000` 按保守 2000 步长占用，并标注不确定状态。
- 旧候选/旧账本没有 `challengeIndex` 元数据：仍计入历史累计，但不能作为"新证据的登记覆盖"（新证据必须带匹配 `challengeIndex` 的账本条目）。
- `nextValidationBase(null)` 从"可用"变为"抛错"：旧调用方必须迁移到治理层；这是有意的兼容性破坏。
- `evolve-cli --no-confirm` 为诊断/测试显式跳过确认挑战，不消费验证种子；正式流程不得使用。

---

## 3. 任务 A2：候选与冠军身份冻结

### 3.1 修复内容

| 缺陷 | 修复 |
|---|---|
| `champion-guided.ts` 的根筛选 `heuristicContext` 仍写死 `CHAMPION_PARAMETERS` | 统一使用 `o.championParameters ?? CHAMPION_PARAMETERS` 解析出的 `championParameters`；束搜索与根筛选消费同一份参数 |
| `adapter.ts` 的 JS1 基座 / 溢出 `trimStock` 读活动冠军 | 显式解析并注入 `championParameters`；JS1 基座从该参数 strip-adapter，溢出弃置使用同一参数 |
| `config.ts` 配置身份无条件读活动 `CHAMPION_PARAMETERS.id/acquisitionVariant` | 改为从实际传入的 `championParameters` 推导；配置哈希随实际消费参数变化 |
| 模拟器/联赛/duel 只传 `jointVersion/budgetMs`，描述符 `parameters` 无消费路径 | `simulate.mjs`、`league.mjs`、`duel.mjs` 把席位描述符参数校验后显式传入；`duel.candidateVersion('js5')` 解析 `joint-js5-frozen` 归档参数；`decision.ts` 生产路径显式传入活动参数 |
| 历史版本可被后续源码/归档静默改变 | 新增 `training/champions/version-lock.json` + `training/lib/version-lock.mjs`：冻结 3 份晋级归档 + 10 份决策核心源码的 sha256 |
| 归档可被覆盖 | `promote-champion` 拒绝覆盖内容不同的同名归档；拒绝同 id 冠军重晋级改写 provenance |

### 3.2 可核验的运行时参数

`chooseJointAction` 返回的 `config` 现包含实际消费的 `championParametersId` 与 `acquisitionVariant`，并纳入 `jointConfigHash`。冻结描述符与未来冠军参数会得到不同配置哈希；同一冻结描述符重复决策逐位一致。

版本锁校验：
```bash
node training/scripts/version-lock.mjs --check   # 不一致 exit 2
node training/scripts/version-lock.mjs --write --note "有意变更原因"
```
`resolveAlgorithmVersion` 在解析 `legacy-js0/js1/joint-js5-frozen` 前强制校验版本锁；`live-champion` 明确不锁（活动别名由晋级流程治理）。

---

## 4. 任务 A3：构建产物一致性

### 4.1 构建清单

`web-v1/scripts/build-hash.mjs` 单一实现，构建与训练共用；`npm run build` 最后一步写 `web-v1/dist/build-manifest.json`：

```json
{
  "schema": "century-web-build-manifest-v2",
  "gitCommit": "…",
  "gitDirty": true,
  "gitDirtyFiles": ["…"],
  "source":  { "sha256": "…", "fileCount": 69, "files": [{ "path": "web-v1/src/…", "sha256": "…" }] },
  "decisionSource": { "sha256": "…", "note": "parameters.ts 生成区替换为固定占位" },
  "championParameters": { "id": "joint-js5", "sha256": "…" },
  "artifact":{ "sha256": "…", "fileCount": 45, "files": [{ "path": "engine.js", "sha256": "…" }] },
  "decisionArtifact": { "sha256": "…", "note": "运行产物闭包排除 ai/parameters.js" },
  "parametersArtifact": { "path": "ai/parameters.js", "sha256": "…" },
  "toolchain": { "node": "v22…", "esbuild": "…", "typescript": "…" }
}
```

- 源码闭包：`web-v1/src/**`、`index.html`、`tsconfig`、`package(.lock).json`、构建脚本、`data/cards.json`。
- 决策核心源码闭包：把 `parameters.ts` 的 `CHAMPION-PARAMETERS` 生成区替换为固定占位——**参数值按预期变化时，决策核心身份不漂移**；生成区之外的校验逻辑仍参与哈希。
- 产物闭包：`dist/js/engine.js + ai.js` 的相对 import 闭包（沿用旧 `engineBundleSha256` 口径）；另拆出：
  - `decisionArtifact`：排除 `ai/parameters.js` 的决策核心产物；
  - `parametersArtifact`：`ai/parameters.js` 单独哈希；
  - `championParameters`：当前 `CHAMPION_PARAMETERS` 的 canonical JSON 哈希。
- 清单同时记录 Git commit 与 dirty 状态。
- 规范化身份解决了一个关键闭环问题：晋级会把候选参数写入 `CHAMPION_PARAMETERS`，全量 bundle 指纹必然变化；若只比对全量指纹，晋级证据会在落地瞬间自我失效。现在以「决策核心 + 待发布参数哈希」判定"部署 = 受试"，全量指纹仅作构建快照。

### 4.2 启动前强制校验

`training/lib/paths.mjs#requireBuiltEngine`：
- 清单缺失 → 抛错；
- 源码闭包哈希 ≠ 清单 → 抛错（**修改源码但未重新构建 = 拒绝训练/评测/正式挑战**）；
- 产物闭包哈希 ≠ 清单 → 抛错；
- commit 漂移 / dirty → 记录警告并写入证据（`buildProvenance()` 同时返回产物、源码、构建元数据）。

`evolve-cli`、`challenge-cli`、`simulator/cli`、`benchmark`、`run-formal-challenge-js5`、`apply-champion`、`promote-champion` 均经 `requireBuiltEngine`。

### 4.3 新增门禁

- `audit-gate --tier dev` 新增 `dist-freshness`；`audit-gate --tier research` 进入 PR CI。
- `audit-gate --tier promotion` 前仍需本地完整环境（人工授权）。

---

## 5. 任务 A4：晋级治理

### 5.1 `promote-champion.mjs` 新规则（全部收紧）

1. **账本强制**：主候选与每个 `--seat-evidence` 文件同目录必须有 `validation-ledger.json`。
2. **统一治理**：全部账本来源（含 PPO/deep/league/baseline）加载；证据区间必须已登记、不得与其它用途重叠。
3. **累计序号**：`challengeIndex` 必须唯一、连续，覆盖最近 N 次挑战，最大序号 = 治理层累计正式挑战数；至少一份随附账本累计到该最大序号。
4. **人数覆盖**：必须提供 2/3/4/5 人各自独立成次证据；缺任一人数、任一人数非 `promote`、证据重复 → 拒绝。
5. **身份校验（规范化 + 旧布局兜底）**：
   - 新证据必须携带 `decisionSourceSha256`、`decisionArtifactSha256`、`championParametersSha256`：
     - 前两者必须等于当前决策核心源码/产物；
     - `championParametersSha256` 必须等于候选参数的 canonical 哈希（即 `apply-champion` 落地后的 `CHAMPION_PARAMETERS`）。
   - 缺规范化字段的旧证据退回全量 `engineBundleSha256` / `sourceClosureSha256` 严格比对。
6. **参数身份**：所有证据文件必须描述同一候选 id 与逐字段一致的参数。
7. **历史不可变**：同名归档内容不同 → 拒绝；已在该 id 的冠军记录不得被重新晋级覆盖。
8. **人工批准保留**：脚本只写待审 `champion.json`，`apply-champion.mjs` 与 PR 审核仍由人执行。

### 5.2 人数证据格式

单人数挑战（`run-formal-challenge-js5.mjs --seats N`）产出：

```json
"seatEvidence": [{ "seatCount": 5, "seeds": 250, "seedBase": 941514652,
  "challengeIndex": 12, "engineBundleSha256": "…", "sourceClosureSha256": "…",
  "decisionSourceSha256": "…", "decisionArtifactSha256": "…",
  "championParametersSha256": "…",
  "decision": { "promote": true, … }, "seedPairs": [ … ] }],
"seatCoverage": { "required": [2,3,4,5], "covered": [5], "complete": false },
"promotionEligible": false
```

晋级时用四个独立挑战文件汇总：
```bash
node training/scripts/promote-champion.mjs --candidate seat5.json \
  --seat-evidence seat2.json --seat-evidence seat3.json --seat-evidence seat4.json
```

### 5.3 历史冠军证据处置

新增 `training/champions/revalidation-required.json`：

- 冠军：`joint-js5`；
- 证据产物：`77292a19…`（`4a11b62`），当前构建已不同；
- 覆盖人数：仅 `[5]`；
- 决策：**不重新晋级、不改写历史 provenance**；
- 状态：`REQUIRES_NEW_FORMAL_CHALLENGE`；
- `audit-gate --tier promotion` 新增 `champion-revalidation` = `REQUIRES_APPROVAL`。

---

## 6. 任务 A5：回归与红队测试

### 6.1 负向用例矩阵

| 攻击/失败模式 | 测试位置 | 预期 |
|---|---|---|
| 删除账本 | `ai7-trust.test.mjs`、`promote.test.mjs`、`evolve-cli` 负向 | 治理层 / 晋级 / CLI 拒绝 |
| 伪造 challengeIndex | `ai7-trust.test.mjs`、`promote.test.mjs` | `challengeIndex ≠ 累计+1` / 账本覆盖不匹配 → 拒绝 |
| 重用种子 | `ai7-trust.test.mjs`、`promote.test.mjs` | 区间重叠 / 历史块无匹配序号 → 拒绝 |
| 修改源码但保留旧 dist | `ai7-trust.test.mjs` | `源码在构建后已变更` → 拒绝 |
| 修改活动冠军参数后调用冻结 JS5 | `ai7-trust.test.mjs` | 冻结决策/配置哈希不变；未来参数产生独立配置身份 |
| 恢复不存在的断点 | `cli.e2e.test.mjs` | `断点不存在` → 拒绝 |
| 伪造产物指纹 | `promote.test.mjs`、`ai7-trust.test.mjs` | 产物指纹不一致 → 拒绝 |
| 使用缺失人数证据的晋级文件 | `promote.test.mjs` | `未提供 2/3/4` → 拒绝 |
| 静默修改归档/决策核心 | `ai7-trust.test.mjs` | 版本锁不一致 → 拒绝 |
| 同名归档内容不同 | `promote.test.mjs` | 历史归档不可变 → 拒绝 |
| 仅改参数块（预期晋级落地） | `ai7-trust.test.mjs` | 决策核心身份不变；参数身份变化；未重建仍 stale |
| 候选参数哈希与待发布参数不一致 | `promote.test.mjs` | 拒绝 |

### 6.2 测试前后差异

| 维度 | 修复前 | 修复后 |
|---|---|---|
| 账本缺失 | `nextValidationBase(null)` 返回派生起点（测试曾断言该行为） | 断言抛错（`ai7-trust` / `tournament` / `cli.e2e`） |
| 晋级账本 | 无 sibling 账本也可晋级 | 无账本 / 账本未累计到最大序号 → 拒绝 |
| 人数覆盖 | 5p 单份证据即可晋级 | 2–5 人缺一不可 |
| 产物一致性 | `requireBuiltEngine` 只查存在性 | 源码闭包 + 产物闭包 + Git 元数据三方一致 |
| JS5 身份 | 根筛选读活动 `CHAMPION_PARAMETERS` | 显式 `championParameters` + 版本锁 |
| 构建测试副作用 | `apply-champion` 测试改写真实 `parameters.ts` 并依赖恢复 | 新增 `--target`，测试写临时文件，不再污染仓库源码 |

---

## 7. 测试与门禁结果

> 运行环境：macOS，Node v22.16.0。以下为本次分支实测。

| 套件 | 结果 |
|---|---|
| `web-v1` 全量 `npm test`（内含重新构建） | **220/220 pass，0 fail**（本次实测；规范化身份改造后复跑） |
| `training` 全量 `npm test` | **169/169 pass，0 fail**（最终复跑） |
| `training` 新增/改写测试 | `promote` **21/21**、`ai7-trust` **10/10**、`cli.e2e` 4/4、`seed-ledger/tournament` 相关全绿 |
| `audit-gate --tier dev` | `dist-freshness` / `version-lock` / `version-identity` / `redteam-regression` 全 PASS |
| `audit-gate --tier research` | PASS（含 `seed-governance`：15 来源、正式挑战 11 次、PPO 900M 已识别、long20 已占用） |
| `audit-gate --tier promotion` | 预期 `REQUIRES_APPROVAL`（历史指纹漂移 + 待重新验证），**不伪造 PASS** |

### 7.1 全量实测记录

- `web-v1`：`npm test` → **220 tests / 220 pass / 0 fail**（含 `tsc + esbuild + build-manifest` 与 Playwright/Node 测试）。
- `training`：`npm test` → **169 tests / 169 pass / 0 fail**（含新增 AI7 信任测试与全量既有回归）。
- 规范化身份改造后的针对性复跑：`promote` 21/21、`ai7-trust` 10/10、`cli.e2e` 4/4。
- duel JS5 冻结参数注入后针对性复跑：`js5-compare + version-identity + ai7-trust` **31/31 pass**（该变更仅训练侧，不触及 `web-v1/src`）。
- `audit-gate --tier dev`：`dist-freshness`、`version-lock`、`version-identity`、`redteam-regression` 全 PASS。
- `audit-gate --tier research`：PASS；`seed-governance` 识别 15 个来源、11 次正式挑战、PPO 900M 块、long20 占用区间。
- `audit-gate --tier promotion`：3 项 `REQUIRES_APPROVAL`（V7b / promotion-governance / champion-revalidation），0 FAIL / 0 BLOCKED。这是如实治理状态，不是测试失败。

---

## 8. 未改变项与边界

- `training/champions/champion.json` 未修改；冠军参数与 `web-v1/src/ai/parameters.ts` 生成区未改。
- `web-v1/src/ai/decision.ts` 默认路由未改（仅把已解析的活动参数显式传给适配器）。
- 未执行正式挑战；验证池零消费；治理层下一块 `941514652`、下一 challengeIndex `12`。
- 未使用 `--no-confirm` 之外的任何绕过；`--no-confirm` 仅用于诊断/测试且不产生晋级证据。
- 历史账本、历史 candidate、历史报告均未改写。

---

## 9. 仍需新的正式挑战才能关闭的阻断项

以下问题**不能靠代码修复关闭**，必须在人工授权后消耗新的验证种子块：

1. **冠军证据指纹漂移**：`joint-js5` 受试产物 `77292a19…` ≠ 当前构建产物；需对当前冻结产物重新执行正式挑战。
2. **2–4 人无正式晋级证据**：当前证据仅 `[5]`；需按 `--seats 2/3/4/5` 各自独立成次，独立种子块、独立 `challengeIndex`。
3. **累计挑战序号**：下一次正式挑战为 `challengeIndex=12`，四次人数挑战将推进到 15；每次均按几何 alpha 收紧。
4. **PPO/long20 历史问题**：PPO 900M 块已识别并占用，但 PPO 自身 `challengeCount` 不一致；long20 为 inconclusive 且未入账，已保守占用但不构成晋级证据。二者都不应被"修复"为正式证据。
5. **人工批准**：`promote-champion` 产出待审记录后，仍需 PR 审核 + `apply-champion.mjs` 落地；`audit-gate --tier promotion` 在完成新挑战前保持 `REQUIRES_APPROVAL`。

在此之前，任何"当前部署的 JS5 已被全人数证明"的表述都不成立。

---

## 10. PR

- 分支：`fix/ai7-trust-foundation`
- 基准：`19fa564`
- PR 链接：创建后回填。
- 合并策略：**不自动合并 main**，等待人工审查。
