# AI6 合并后可靠性整改报告（AI6-POST-MERGE-RELIABILITY-FIX-REPORT）

- 分支：`fix/ai6-post-merge-reliability`（独立 worktree，基于 main@2b74003，未触碰 main）
- 执行日期：2026-10-25
- 整改范围：A–E 夜间任务合并后的评测正确性、版本隔离、统计分析、种子管理、Worker 协议与数据质量
- 配套文档：[AI6-POST-MERGE-EVIDENCE-CORRECTIONS.md](AI6-POST-MERGE-EVIDENCE-CORRECTIONS.md)（历史证据勘误）

---

## A. 执行摘要

| 类别 | 数量 | 明细 |
|---|---|---|
| P0 已修复 | **5/5** | 版本身份污染、审计门禁、联赛统计分层、种子账本、挑战管线正确性 |
| P1 已修复 | **3/3** | Worker 信息边界与状态管理、复盘数据质量、战术语料公开/私有分离 |
| 未解除（治理阻断） | 3 项 | 晋级指纹漂移重验（REQUIRES_APPROVAL）、晋级证据人数覆盖、预注册扩样待人工批准 |

**第六阶段现在可以进行**：开发/研究层全部实验（audit-gate dev/research 层放行）——
消融、对手池扩研、按人数分层的联赛、种子账本管控下的扩样实验。
**仍被阻断**：正式晋级与验证池消费（promotion 层 REQUIRES_APPROVAL，需人工授权）。

关键整改效果：
1. JS0/JS1 基线恢复真实冻结身份（晋级后曾静默执行 JS5，8/8 探针实锤）——`gate=never ≡ 冻结 JS0` 等价审计重跑通过（305 决策零不一致），后续 JS5 vs JS0 消融重新具备归因效力。
2. 联赛统计按 `(人数, 协议)` 严格分层——PR #40 的 style-engine「克制信号」撤回（详见勘误文档）。
3. 新独立实验不可能意外复用已消费种子（区间防重键 + 文件锁并发安全 + fail-closed）。
4. 审计门禁恢复「可阻断也可放行」能力（三层：dev/research 放行，promotion 如实 REQUIRES_APPROVAL）。
5. 当前正式冠军（joint-js5）决策路径**代码级零改动**（`decision.ts`/`champion-guided.ts` 未触碰；`adapter.ts` 仅改动 `joint-js1` champion-contest 分支——冠军路径不经过该分支）。

---

## B. 缺陷追踪矩阵

| 编号 | 根因 | 修改文件 | 最小复现 | 修复方式 | 验证证据 | 最终状态 |
|---|---|---|---|---|---|---|
| P0-1 | 晋级后 `CHAMPION_PARAMETERS` 携带 `adapter='champion-guided'`；duel/equivalence-audit/adapter(joint-js1)/calibrate/perf-phases/confirm-replay-check 直接透传 → decision.ts 适配器分支先于 structure 生效，js0/js1 实际执行 JS5 | 新增 `training/lib/version-registry.mjs`；`training/joint/duel.mjs`、`equivalence-audit.mjs`、`perf-phases.mjs`、`calibrate.mjs`、`confirm-replay-check.mjs`、`web-v1/src/js/adapter.ts`、`training/lib/opponents.mjs`（池派生改冻结基座） | `node training/redteam/audit-versions.mjs --probes=8`（整改前 V2/V3/V4 全 P0：8/8 探针走适配器路径，首个动作分歧 @seed=941512402 step=1） | 不可变算法版本描述符：js0=ai5-readiness-efficiency 晋级归档（beam-rollout）、js1=同基座+beam-contest、js5=joint-js5 归档、live-champion 显式别名（禁用于历史对照）；全部调用点经描述符分派；报告披露注册表快照+指纹 | 修复后同审计全 PASS；`gate=never ≡ 冻结 JS0` 等价审计（8 局 305 决策零不一致）；11 项行为学回归测试（`training/tests/version-identity.test.mjs`）全绿；confirm-replay-check 历史重放身份恢复 | ✅ FIXED |
| P0-2 | audit-gate「晋级治理」写死 `verdict:'BLOCKED'`；回归测试重复执行两次；无结构化输出；缺产物/命令失败不正确阻断；缺陷快照以"漏洞存在"为通过条件 | `training/redteam/audit-gate.mjs`（重写 v2）、`audit-versions.mjs`（真实调用点探测+结构化 checks）、`tests/redteam.test.mjs`（快照→正向不变量）、`training/package.json`（gate 脚本）、`.github/workflows/ai-training.yml`（audit-gate job） | `node training/redteam/audit-gate.mjs`（整改前：无条件 BLOCKED，exit 2 恒定） | 三层门禁（dev/research/promotion）；每检查返回 {id,severity,status:PASS\|FAIL\|BLOCKED\|NOT_RUN\|REQUIRES_APPROVAL,evidence,remediation,checkVersion}；命令失败/缺产物默认阻断；晋级治理=REQUIRES_APPROVAL（只阻断 promotion 层）；JSON+MD 双输出；CI 入口 | dev 层放行（exit 0）、research 层放行（exit 0）、promotion 层 REQUIRES_APPROVAL×2（exit 2，如实阻断）；7 项正向不变量测试全绿 | ✅ FIXED |
| P0-3 | `buildWinRateMatrix()` 以 (focus,opponent) 聚合，2p h2h 与 5p field 合并（PR #40：js5 vs style-engine n=30 = 15+15），跨人数机会基准混用 | `training/adversarial/league.mjs`（v2 schema）、`evaluate.mjs`、`run-league.mjs`、新增 `stratify-league-report.mjs`；测试 `adversarial-league.test.mjs`（分层不变量 4 项） | `node training/adversarial/stratify-league-report.mjs --in <league-report.json>`（原矩阵 cell n=30 含两个协议层） | 矩阵按 `(seatCount, protocol)` 严格分层：逐层 games/wins/第一名率/Wilson CI/座位分解/异常局/焦点版本指纹；evaluate 主读数禁用合并 Wilson；CLI 按人数分节打印；schema v2 | 分层不变量测试全绿；PR #40 分层重算对账逐局守恒（108 单元）；style-engine 结论撤回（详见勘误文档） | ✅ FIXED |
| P0-4 | `run-league.mjs` 每次以 block[0] 为起点——prereg 已消费 [1403000000,1403001620)，30-seed 方案会无声重放；缺账本、无 CRN 显式化、无并发保护 | 新增 `training/adversarial/seed-ledger.mjs` + `seed-ledger.json`（历史只读导入）；`run-league.mjs` 接线（先记账后消费）；测试 `seed-ledger.test.mjs`（8 项） | 对已消费区间注册新实验 → 旧代码无任何拦截 | 全局实验账本：区间防重键（改名/换目录不可规避）、CRN 必须显式声明同组、文件锁（O_EXCL+陈旧锁接管）并发安全、断点续跑（区间内推进不新增区间）、作废留痕且继续占用、缺失账本 fail-closed、`nextSeedBase` 从未消费末端续配 | 8 项账本测试全绿（含 6 进程并发唯一性）；历史导入 verifyLedger 零缺陷；PR #40 区间已导入在账 | ✅ FIXED |
| P0-5 | ①挑战编排对缺失账本静默跳过（challenge-10 种子重复消费根因）；②codeCommit 结束时捕获（challenge-11 证据失真教训）；③无代码冻结校验；④simulate.mjs 挑战链路 simSeed 缺省=0 且 duel 曾直传洗牌种子；⑤challenge.mjs 硬编码 5 人 | `training/tournament/run-formal-challenge-js5.mjs`、`challenge.mjs`、`training/simulator/simulate.mjs`、新增 `training/lib/sim-stream.mjs`、`training/joint/duel.mjs`（派生流域） | ①删除任一账本源 → 旧代码继续跑（challengeIndex 低估）；②静态：simulate.mjs 适配器分派无 simSeed | ①账本缺失 fail-closed（缺文件即抛错）；②运行指纹进程启动时捕获 + 挑战全程产物指纹冻结校验（漂移即作废）；③`deriveSimStreamSeed`（sha256 单向、域分离、31 位安全域、CRN 保持、不暴露洗牌种子）；④seatCount 2–5 参数化 + `PRIMARY_METRIC` 按人数主统计量 + `firstPlaceByDirection` 方向分列（机会基准 1/N / (N−1)/N） | 红队正向不变量 7 项全绿；`deriveSimStreamSeed` 性质测试；tournament/simulator 46 项测试全绿；**未执行任何新挑战、未消费验证池** | ✅ FIXED |
| P1-1 | ①协议防火墙只查观察顶层（嵌套隐藏字段可穿透）；②`request.gameStateVersion !== gameStateVersion` 自比较死代码；③过期行动防线覆盖不全 | `web-v1/src/ai-runtime/protocol.ts`（v1.1 递归校验）、`worker-core.ts`（过期版本水位）、`tests/ai-runtime.test.mjs`（+3 专项） | `validateDecisionPayload` 于 players[i] 内注入 merchantDeck → v1.0 放行 | 递归 schema（players/market/payload 严格字段+范围+禁键全层级扫描；合法手牌不误判）；gameStateVersion 类型/范围校验 + 水位（迟到旧版本→cancelled，reset 重置）；协议版本 1.1.0（主版本兼容） | Worker 运行时 15 项测试全绿（含 worker_threads 往返一致性、隐藏牌库随机化不变性、换局隔离、崩溃/取消/看门狗/回退） | ✅ FIXED |
| P1-2 | ①CLI 对缺失输入静默过滤，空检查集合返回成功；②「终局在手=从未使用」误判（卡牌循环+休息收回） | `training/human-analytics/cli.mjs`、`metrics.mjs`、`tests/run-tests.mjs`（+5 项） | `check 不存在.json` → 旧代码 exit 0 | ①fail-closed 批策略：任一缺失/失败非零退出；披露 缺失/实际检查/通过/失败 计数；②`merchantUsage`（playCounts/neverPlayed/firstUseLag/frequentlyUsed）按 replay 历史打出事件追踪；deadCards 保留终局快照口径并更正注释 | 19 项测试全绿（既有 14 项兼容 + 新增 5 项：空输入非零、部分缺失披露、打出事件计数=replay 总数、休息收回不误判、模拟来源戳） | ✅ FIXED |
| P1-3 | 语料单文件含 `engineState.position`（真实牌库序）+ `gameSeed`（可确定性重导出牌库序），AI 训练工具直读即触隐藏信息 | 新增 `training/scenarios/lib/dataset.mjs`、`data/public/scenarios.public.jsonl`、`data/private/scenarios.private-oracle.jsonl`、`split-manifest.json`、`scripts/split-dataset.mjs`；`generate.mjs` 同步产出双层；`scenario-integrity.test.mjs`（+6 项） | 对 public 层做 merchantDeck 递归扫描（v1 无 public 层可扫） | 双层物理分离：公开层=公开观察+合法行动+分类+分歧+评测标签（oracle 附 exact-under-recorded-deck 限定与监督使用警告）；私有层=position+gameSeed（用途声明门禁）；scenarioId 稳定关联；原始 scenarios.jsonl 保留不覆盖；公开层泄漏递归扫描 fail-closed | 50 条局面无损迁移逐位还原测试；公开层零泄漏；合法行动/决策/分歧逐位一致；13 项完整性测试全绿 | ✅ FIXED |

---

## C. 回归验证

### 测试命令与结果（本分支完整执行）

| 套件 | 命令 | 结果 |
|---|---|---|
| web-v1 全量 | `cd web-v1 && npm test`（sync-cards 校验 + 构建 + node --test ×tests） | 见 §C.1（后台执行记录） |
| training 全量 | `cd training && npm test` | 见 §C.1 |
| 版本身份 | `node --test training/tests/version-identity.test.mjs` | 11/11 ✅ |
| 联赛/评估/注册表 | `node --test training/tests/adversarial-{league,evaluate,registry,candidate}.test.mjs` | 34/34 ✅ |
| 种子账本 | `node --test training/tests/seed-ledger.test.mjs` | 8/8 ✅ |
| 挑战+模拟器 | `node --test training/tests/{tournament,simulator}.test.mjs` | 46/46 ✅ |
| 红队正向不变量 | `node --test training/redteam/tests/redteam.test.mjs` | 7/7 ✅ |
| Worker 运行时 | `node --test web-v1/tests/ai-runtime.test.mjs` | 15/15 ✅ |
| 复盘分析 | `node --test training/human-analytics/tests/run-tests.mjs` | 19/19 ✅ |
| 战术语料 | `node --test --test-concurrency=2 training/scenarios/tests/*.test.mjs` | integrity 13/13 + decisions 5/5 ✅ |
| AI5 回归 | `node --test ai5/openevolve/tests/seed-policy.test.mjs` | 9/9 ✅（种子政策块与本分支联赛账本交叉核对一致） |
| 等价审计 | `node training/joint/equivalence-audit.mjs --seeds 4 --players 2,5` | EQUIVALENT（8 局 305 决策零不一致）✅ |
| 版本身份审计 | `node training/redteam/audit-versions.mjs --probes=8 --json` | CLEAN_WITH_GOVERNANCE ✅ |
| 审计门禁 | `node training/redteam/audit-gate.mjs --tier dev` / `--tier research` / `--tier promotion` | dev exit 0 / research exit 0 / promotion exit 2（REQUIRES_APPROVAL×2，如实阻断）✅ |
| 证据核算 | `node training/redteam/audit-evidence-accounting.mjs` | confirm 12,800 复算一致；challenge-11 独立 promote 复现；账本无重叠 ✅ |
| PR #40 分层重算 | `node training/adversarial/stratify-league-report.mjs --in ...prereg-15s-official/league-report.json` | 108 单元；逐局守恒对账通过 ✅ |
| 浏览器冒烟 | Pages 入口（standalone/mobile esbuild 产物）由 pages-entrypoints 测试与构建锚点断言覆盖（esbuild IIFE 产物含冠军链标记）；PR #44 触发的 CI `test-and-build` job 自动执行 Playwright 冒烟套件（桌面/移动/Focus 全流程） | web-v1 套件内覆盖 + CI 执行 ✅ |

### C.1 全量套件执行记录

- **web-v1：208/208 全部通过**（`npm test`，808s；含离线 Worker 决策、信息公平性、pages-entrypoints 冠军链标记、联合搜索预算纪律）。
- **training：153/153 全部通过**（`npm test`，434s；含 CLI 端到端、晋级脚本、进化管线回归；首轮 152/153 的失败为并发测试用 `process.cwd()` 拼路径的测试自身缺陷——cwd=training 时路径错位，已改为相对测试文件定位并复跑全绿）。
- CI：新增 `audit-gate` job（dev 层，PR 触发）；其余工作流沿用 main 现状（ai5.yml 四 job 失败为 main 既有损坏，与本分支无关——PR #35 报告 §11 已取证）。

### 构建产物指纹

| 项 | 值 |
|---|---|
| 分支 HEAD | fix/ai6-post-merge-reliability @ `9c7c037`（+最终报告提交） |
| 当前重建 engineBundleSha256 | `73c5a5cb3c3c67049a1f7e30a02ea9b83191123cfaacf610c526fbd6df92ed30` |
| 冠军晋级受试产物（champion.json provenance） | `77292a19c4e5…`（challenge-11，可由 4a11b62 逐字节复现） |
| 指纹差异原因 | ①PR #30 合并后 champion-guided.ts 改动（既有漂移，非本分支引入）；②本分支 adapter.ts `joint-js1` 分支修复（冠军路径不经过该分支） |

### 默认冠军行为是否变化

**决策行为零变化**：
- `web-v1/src/ai/decision.ts`、`web-v1/src/js/champion-guided.ts`：零改动；
- `adapter.ts` 仅改动 `champion-contest`（joint-js1）分支——冠军路径（`champion-guided`，joint-js5）不经过该分支；
- ai-runtime（protocol/worker-core）为 opt-in Worker 模块，默认 AI 决策路径不 import；
- 训练侧全部改动为评测基础设施（runners/audits/ledgers），不触及 `chooseAIAction` 冠军参数区；
- 实证：`gate=never ≡ 冻结 js0` 等价审计重跑通过（联合搜索的冠军直通路径与晋级前冻结冠军逐决策一致）。
- `champion.json` 未修改；验证池未消费；历史 challenge-11 数据未重跑、未改写。

---

## D. 统计证据更正

### D.1 PR #29 计数

- 原声明 25,600 局 → **实际 12,800 局**（8 个落盘文件逐文件复算：4 候选 × 2 池 × [4 人数 × 200 种子 × 2 方向 = 1600 局]）。
- 各候选方向 A 显著性结论**不变**（种子级配对统计，未受双计影响）；2p 趋势不显著结论不变。
- 勘误已落 `AI6-PHASE5-REPORT.md` 附录；原始 JSON 未覆盖。

### D.2 PR #40 按人数重新统计

- 重算：从 1620 局逐局原始数据生成 108 个 `(seatCount, protocol, focus, opponent)` 分层单元（`stratified-corrections.json`），与 v1 合并矩阵逐局守恒对账。
- style-engine「克制信号确立」**撤回**：分层后 2p 40.0% [19.8, 64.3]（基准 50%）与 5p 26.7% [10.9, 52.0]（基准 1/5）均不显著；原「显著低于 50%」系跨人数合并 + 基准误用（5p 用了 50% 而非 20%）+ 合并 CI 本就含 0.5 的三重伪影。
- JS5 在 5p 有向场对 random-legal/style-balanced/ai4/neutral 四对手显著高于 1/5 机会基准（探索性显著）；对 style-balanced 的联合搜索增量分层后成立且更强（2p 80%、5p 60%）。
- 对既有研究结论的影响：第六阶段对手池扩研不应以被撤回的 style-engine 显著性为依据；「潜在克制方向」降级为待验证假设（需分人数设计与新独立实验）。

### D.3 关联更正

- challenge-11 随机流缺陷（全 500 局共用联合模拟噪声流）：**判定 promote 独立复算仍成立**（188W/60L/2T，Wilson 下界>0.5）——噪声流缺陷不影响种子级配对统计的有效性，但新挑战必须使用修复后的独立模拟流域。
- E1/E2 版本身份修复不影响历史 confirm 数据（生成于晋级前，产物指纹 9ed80290 在案）。

---

## E. 治理状态

| 项 | 状态 |
|---|---|
| 当前活动冠军 | `joint-js5`（champion-guided 结构候选；未修改） |
| 当前代码指纹 | 分支 HEAD 重建产物 `73c5a5cb…`（含本分支 adapter/ai-runtime 整改） |
| 正式晋级证据匹配 | **不完全匹配**：challenge-11 受试于 `77292a19`（4a11b62 可逐字节复现，证据链诚实）；晋级 PR 之后产物已演化——按项目自订规则「证据不再适用，须重新挑战」 |
| 人工批准需求 | ①对当前冻结产物的新一轮正式独立挑战（可含 2–5 人数口径，`--seats 2..5` 已支持按人数独立成次）；②30-seed 联赛扩样方案启动（从未消费种子区间分配） |
| 验证池 | 未消费（本任务零种子消耗；账本无变更） |
| 门禁状态 | dev ✅ 放行 / research ✅ 放行 / promotion ⏳ REQUIRES_APPROVAL（阻断晋级，不阻断开发） |

---

## F. 后续研发

1. **可立即恢复**：JS6 搜索研发的全部开发/研究实验（消融、对手池扩展、预算扫描）——版本身份、统计分层、种子账本、门禁已就位；`npm run gate`（training）作为常规前置检查。
2. **50–1000ms 胜率扩展实验**：适合开展。前提已具备：按人数分层统计（杜绝跨人数合并）、种子账本（prereg 块从未消费区间续配、CRN 显式声明）、墙钟/工作量口径分离。建议按人数独立设计并使用 audit-gate research 层作为启动门禁。
3. **style-engine 方向**：以「待验证假设」重启——分层读数（5p 26.7% vs 1/5 基准）目前不支持克制方向；如继续，需预注册分人数设计 + 充分样本量（n≥15/层的现有数据功效不足）。
4. **JS6 研发需防的评测风险**（本整改固化的防线）：
   - 新版本一律经不可变版本注册表注入（`training/lib/version-registry.mjs`），禁读活动冠军别名；
   - 新统计口径先过分层不变量（人数/协议不得合并）；
   - 新实验先在种子账本登记（区间防重 + CRN 显式化）；
   - 任何新挑战前跑 `audit-gate --tier promotion`（REQUIRES_APPROVAL 不得伪造 PASS）；
   - AI 决策输入只读战术语料公开层接口（`loadPublicScenarios`）与 Worker 协议 v1.1 递归防火墙。

---

## 附：本分支提交清单

| 提交 | 内容 |
|---|---|
| `e33f330` | P0 整改：版本身份、审计门禁、联赛统计、种子账本、挑战管线 |
| `c72b537` | P1 整改：Worker 信息防火墙、复盘数据质量、战术语料公开/私有分离 |
| `9c7c037` | 证据更正：PR #29 勘误 + PR #40 分层重算 |
| （最终） | 本报告 |
