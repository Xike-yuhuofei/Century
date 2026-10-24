# 夜间红队审计报告：Century AI 评测系统（版本身份 × 历史证据 × 统计正确性）

> 分支 `audit/overnight-ai-evaluation-redteam`（基于 origin/main@e7d3bfa，独立 git worktree）
> 审计日期：2026-10-24 夜 · 审计角色：独立于第六阶段算法研发的统计审计员/测试专家/代码安全审查员
> 审计方式：只读审查生产代码 + 独立行为学探针 + 独立重算 + 最小复现回归测试。**未修改 `duel.mjs`/`compare.mjs`/`champion.json`/任何晋级账本；未产生任何新的高负载对局**（全部结论来自已落盘 JSON + 少量确定性单决策探针）。

---

## 0. 结论速览

**门禁判定：阻断。** 存在 4 个 P0 缺陷，第六阶段正式实验开始前必须清零（见 §8 门禁）。

| # | 严重 | 缺陷 | 一句话结论 |
|---|------|------|-----------|
| P0-1 | P0 | **版本身份污染（行为学实锤）** | 晋级 PR #30 之后，`js0`、`js1`、对手池全部风格变体（@tempo/@contest/@engine/rush/engine）在训练工具链里**实际执行的算法都是 JS5**——任何以它们为基线/对手的新实验都在做"JS5 vs JS5 自我对弈"，只有标签不同 |
| P0-2 | P0 | **晋级产物 ≠ 受试产物** | challenge-11 晋级证据产生于 commit 4a11b62（指纹 77292a19，已逐字节复现验证），但晋级 PR #30 自身改动了冠军决策核心 `champion-guided.ts`（+166/−50，含行为性 C1 修复）——main 上现在运行的冠军（指纹 a0da8883）**不是打挑战的那版 JS5**。按仓库自订规则（paths.mjs："证据不再适用，须重新挑战"）晋级证据已失效 |
| P0-3 | P0 | **全局晋级 vs 按人数门槛 B** | 正式挑战证据仅覆盖 5 人局（challenge.mjs `SEAT_COUNT=5` 硬编码），PHASE5 决策门槛 B 明确"2 人保留冠军、分人数路由须新一轮独立验证+人工审核"，但晋级把所有人数都切到了 JS5（适配器无任何人数路由）——2p 现在运行的 JS5 从未获得正式挑战证据 |
| P1-1 | P1 | **PR #29 头条局数双计** | PR #29 正文与 PHASE5 报告 §0 声明"25,600 局"，落盘 confirm 数据逐格清点为 **12,800 局**（= 报告 §5.1 自述值）。25,600 恰为 2 倍，属证据陈述失真，不改变结论但必须更正 |
| P1-2 | P1 | **挑战链路模拟流共用 simSeed=0** | duel.mjs 已修（PR #29 传 simSeed=种子），但正式挑战走的 simulate.mjs **没有传**——challenge-11 全部 500 局共用同一条联合模拟噪声流，配对 bootstrap 的独立性假设受损、CI 可能偏窄 |
| P1-3 | P1 | **账本合并 fail-open** | `run-formal-challenge-js5.mjs` 对缺失账本静默跳过——这正是已发生过的 challenge-10 种子重复消费事故（已隔离留痕）的根因，代码至今未 fail-closed |
| P1-4 | P1 | **官方挑战结构性 5p-only** | `SEAT_COUNT=5` 硬编码使 2/3/4 人局永远无法走正式挑战，与 P0-3 互为因果 |

**未发现问题的项（如实报告）**：challenge-11 晋级判定独立复算**完全一致**（188W/60L/2T，Wilson 下界 0.691 > 0.5 @α=2.44e-5，verdict=promote 可复现）；验证账本 11 个种子块去重后两两无重叠、作废运行正确隔离；confirm 块零异常、种子分区/配对/座位轮换完整；历史 confirm 数据不受 P0-1 影响（7/8 文件指纹为晋级前产物，对手标签为真实版本）；双人预注册主判定（方向A）不显著——与"2 人保留冠军"的原决策一致（问题在晋级没有执行它）。

---

## 1. 审计方法与独立性声明

- **独立重算**：所有统计复算不调用仓库聚合结果——本审计自行实现 Wilson 区间、probit、种子级配对 bootstrap（`training/redteam/stats-two-player.mjs`），并与官方 `compare.mjs` 交叉核对（点估计逐位一致，CI 区间重叠；见 §6）。
- **行为学审计而非字符串检查**：`training/redteam/audit-versions.mjs` 直接加载 web-v1/dist 正式产物，重放 `duel.mjs` 各调用点的真实分派，用 64+ 个探针状态（8 个种子 × 40 步覆盖开/中局）对比"标签声称的算法"与"实际执行的算法"。
- **指纹链验证**：在临时 worktree 中于挑战 commit 4a11b62 重建产物，指纹 77292a19…与 candidate.json 记录**逐字节一致**——证明证据链诚实（esbuild 确定性成立），问题不在伪造而在"证据生成后代码又变了"。
- 本审计不预设立场：既审计"JS5 是否被高估"，也审计"JS5 是否被冤枉"。§3 的独立复算实际上**支持**晋级方向性结论；被否决的是流程与工具链状态。

## 2. P0 缺陷详情

### P0-1 版本身份污染（晋级后 js0/js1/对手池全部执行 JS5）

**触发条件**：PR #30 晋级后（champion.json 含 `adapter: 'champion-guided'`），任何一次重新构建 dist 后运行 `duel.mjs`/`compare.mjs`/`equivalence-audit.mjs` 或任何以 js0/js1/风格变体为基线的新实验。

**根因链**（三段叠加）：
1. [apply-champion.mjs](file:///Volumes/Extreme%20SSD/Projects/Century-worktrees/audit-redteam/training/scripts/apply-champion.mjs#L57-L65) 把 `adapter: 'champion-guided'` 写入 `web-v1/src/ai/parameters.ts` 的 CHAMPION_PARAMETERS 生成区（当前 main 已确认写入）；
2. [decision.ts#L38](file:///Volumes/Extreme%20SSD/Projects/Century-worktrees/audit-redteam/web-v1/src/ai/decision.ts#L38)：`params.adapter === 'champion-guided'` 即分派到 JS5 适配器——`options.structure`（js1 的 beam-contest）在适配器分支**被忽略**，权重乘子（对手池的全部"风格"）**不被消费**；
3. [duel.mjs#L45-L52, L194-L199, L70-L90](file:///Volumes/Extreme%20SSD/Projects/Century-worktrees/audit-redteam/training/joint/duel.mjs#L45-L52)：`candidateVersion('js0')` 与 classicPool/diversePool 都引用 `CHAMPION_PARAMETERS`——晋级前它指向 ai5-readiness-efficiency（历史正确），晋级后指向 JS5。

**最小复现**（`node training/redteam/audit-versions.mjs`，64 探针）：

```
[P0] V2 「js0（冻结冠军）」标签实际执行 JS5 适配器（身份污染）
    64/64 探针决策走适配器路径；首个动作分歧 @seed=941512402 step=0：
    js0-labeled={"type":"acquire","index":3,"payment":[0,0,0]}（js5 联合仲裁：覆盖为联合最优…）
    vs 真冻结冠军={"type":"play","cardId":"S02","steps":[0,0]}
[P0] V3 「js1（beam-contest）」标签实际执行 JS5 适配器（64/64）
[P0] V4 对手池风格变体全部退化为 JS5 本体（256/256）
```

第一个 AI 决策（seed 941512402, move 0）上，"js0"标签与真冻结冠军的动作就不同——污染是即时的、可观测的。

**受影响结果**：
- 晋级后任何 js0 基线消融 = JS5 自我对弈（胜率差期望 0，实验作废）；
- `equivalence-audit.mjs`（gate=never ≡ JS0 工具）退化为 "JS5(gate=never) ≡ JS5(gate=auto)"——冠军路径回归审计失效；
- 对手池多样性承诺（classic/diverse 是 PR #29 的独立评测维度）在晋级后为空；
- **历史数据不受影响**（V6 + 指纹佐证：confirm 8 文件中 7 个为晋级前指纹 9ed80290，js0-classic 为 b0df3fc4，均早于晋级；versionsIds 为真实对手标签）。

**修复建议**（按优先级，均未实施以避免与主线冲突）：
1. duel.mjs `candidateVersion('js0')`/池构造改为从 `training/champions/candidates/ai5-readiness-efficiency.json` 读归档参数（快照冻结），不引用 CHAMPION_PARAMETERS；
2. decision.ts：适配器分派仅对"显式候选席位"生效——对手/池调用点剥离 adapter 字段（或 `resolveAIParameters` 对携带 adapter 的参数要求显式 `allowAdapter` 选项）；
3. 在 `runAblationCell` 开头加运行时守卫：候选与对手池不得同时携带 adapter 字段。

**回归测试**：`training/redteam/tests/redteam.test.mjs`（快照断言锁定现状；修复后把 3 个 todo 转正即可验证修复）。

### P0-2 晋级产物 ≠ 受试产物（挑战后代码变更）

**触发条件**：已发生（无需触发）。

**时间线**（git 佐证）：
1. challenge-11 于 commit **4a11b62**（feat/js5-promotion 线，含适配器注入基础设施，**不含** 94d285c 的 C1/A2/B 修复）运行，bundle 指纹 77292a19 → candidate.json 记录；
2. PR #30 合并（13:17）早于 PR #29 合并（13:19）；随后 29b8833 把 feat/joint-search-v1（含 C1 修复）合入晋级线，`champion-guided.ts` 变更 +166/−50；
3. main@e7d3bfa 重建指纹 = **a0da8883** ≠ 77292a19。

**关键点**：C1（平衡批次提交）是**行为性修复**——修复"预算在 world×replica×candidate 网格中途截断时，早排候选（冠军行动 index 0）获得更多试验"的系统性偏差。受试的 JS5（pre-C1）比晋级的 JS5（post-C1）**更保守**（冠军行动估计过拟合 → 覆盖更难触发）。挑战证据测的是保守版，货物发的是修复版。

**独立验证**：在 /tmp 临时 worktree 于 4a11b62 重建 → 指纹 77292a19 逐字节复现 ✓（esbuild 确定性 + 证据诚实性同时成立）。

**受影响结果**：champion.json.provenance 记录的晋级证据（challenge-11）按仓库自订规则（paths.mjs 注释："指纹不一致说明引擎在证据生成后已变更，证据不再适用，须重新挑战"）**对当前产物不再适用**。

**缓解事实（如实陈述）**：confirm 块（7/8 文件 = post-C1 指纹 9ed80290）独立显示 3p/4p/5p 显著——晋级**方向**大概率稳健；但正式晋级账本引用的 500 局证据测的是另一版代码。

**修复建议**：①以当前 main HEAD 重跑一次正式挑战（消费新验证种子块）替换晋级证据；或在 provenance 中追加 rechallenge 字段+新指纹；②promote-champion.mjs 加硬守卫：`champion.json.provenance.engineBundleSha256 === engineBundleSha256()`（工作树当前构建）不一致即拒绝晋级；③晋升流程冻结代码：晋级 PR 内不得再触碰决策核心文件（CI diff-gate）。

**回归测试**：audit-versions.mjs V7（快照已锁定）。

### P0-3 全局晋级 vs 按人数门槛 B

**触发条件**：已发生——champion.json 切换为全局生效，适配器无人数路由（audit-versions V5 已确认 web 入口同步）。

**证据缺口**：challenge.mjs `SEAT_COUNT=5` 硬编码 → challenge-11 证据仅 5p。PHASE5 报告 §0.5 决策门槛 B："3/4/5 人具备正式挑战资格；**2 人保留冠军**；分人数路由实施须经新一轮独立验证 + 人工审核"。实际晋级未实现分人数路由，2p/3p/4p 全部静默切到 JS5。

**缓解事实**：confirm 块 3p/4p 双池显著（PR #29）；2p 双池正向趋势不显著但非劣（本审计独立复算，§6）——目前无证据表明 2p 受损，但流程上"未证明显著更强的候选仅保存为实验版本"的自订规则被跳过。

**修复建议**：①实现 per-seatCount 路由（2p → ai5-readiness-efficiency），或 ②补跑 2p 正式挑战（需先解除 P1-4 的 SEAT_COUNT 硬编码）；二选一后更新 champion.json provenance 并复审。

### （关联）P1-4 官方挑战结构性 5p-only

`challenge.mjs` 的 `SEAT_COUNT = 5` 常量贯穿 versionsFor/指标聚合——2/3/4 人正式挑战在当前结构下不可表达。修复 = 参数化 seatCount + 相应统计口径（方向B 阵营 = N−1 席）与测试。

## 3. P1 缺陷详情

### P1-1 PR #29 头条局数双计（25,600 ≠ 12,800）

**触发条件**：已发生（PR #29 正文与 AI6-PHASE5-REPORT.md §0.2）。
**复现**：`node training/redteam/audit-evidence-accounting.mjs` → E1：逐格清点 8 个 confirm JSON = **12,800 局**（每 (版本,池) 4 人数格 × 400 局 × 8）。PHASE5 §5.1 自述"12,800 局全部 finished"——报告内部自相矛盾；25,600 = 12,800 × 2，疑似把"每种子 A/B 双局"重复乘入。晋级判定实际依赖 challenge-11 的 500 局，不依赖此数字；属头条陈述失真而非结论失真。
**修复建议**：更正 PR #29 描述与 PHASE5 §0 为 12,800；未来 PR 的局数声明必须由脚本从落盘 games 数组生成（本审计的 E1 即可复用）。

### P1-2 挑战链路联合模拟流共用 simSeed=0

**触发条件**：任何经 `simulateGame` 的适配器候选对局（含正式挑战）。
**复现**：[simulate.mjs#L112-L118](file:///Volumes/Extreme%20SSD/Projects/Century-worktrees/audit-redteam/training/simulator/simulate.mjs#L112-L118) 的 `chooseJointAction` 调用不传 simSeed；[adapter.ts#L109](file:///Volumes/Extreme%20SSD/Projects/Century-worktrees/audit-redteam/web-v1/src/js/adapter.ts#L109) `simSeed: options.simSeed ?? 0`。duel.mjs 已修（PR #29："修复 PR #27 跨局模拟流共用 0 的噪声相关"），挑战管线漏修——**challenge-11 的 500 局全部共用同一条联合模拟噪声流**。
**影响**：候选决策的模拟噪声跨种子完全相关 → seedPairs 非独立 → 配对 bootstrap CI 偏窄（显著性可能被高估）；且噪声流是"单次抽取"——若该实现恰好利于激进认领，整场挑战同向受益。方向未知、未证实翻转结论（confirm 块 simSeed=seed 独立支持 JS5），故 P1 而非 P0。
**修复建议**：simulate.mjs 适配器分支传 `simSeed: seed`；修复后以 60 种子做 challenge-11 抽样重验（旧账本不重复消费，按 test 块登记）。
**回归测试**：redteam.test.mjs 快照（simulate.mjs 分派中不得缺 simSeed）。

### P1-3 验证账本合并 fail-open

**触发条件**：worktree/CI 环境缺失任一历史账本文件。
**复现**：[run-formal-challenge-js5.mjs#L72-L74](file:///Volumes/Extreme%20SSD/Projects/Century-worktrees/audit-redteam/training/tournament/run-formal-challenge-js5.mjs#L72-L74)：`if (!existsSync(p)) { console.error('账本缺失（跳过）'); continue; }`。该模式已实际造成过一次事故：js5-promotion-challenge-invalid-seedreuse（INVALID.json 留痕："种子块 [941510152,941510402) 与 challengeIndex=10 重复消费……本运行结果作废"）。本次审计 E4 核对当前账本链：去重后 11 块两两无重叠、作废运行正确隔离、challengeIndex=11 复算一致——**现状干净，但根因未除**。
**修复建议**：账本缺失改抛错（fail-closed）；`assertBlockFree` 前增加"期望账本清单"存在性断言；challengeIndex 计算后打印全部块清单供人工核对。
**回归测试**：redteam.test.mjs 快照（fail-open 模式存在性）。

### P1-5（新编号）随机性隔离其余项 —— 未发现缺陷

- 引擎隐藏牌库随机（createGame(seed)）、对手席位 RNG（seatRng(seed,seat) mulberry32）、random-legal 对手、联合模拟流（simSeed）四条流互相独立；js0/js1 为确定性算法不消费模拟流——设计正确（duel.mjs L116-L119, L150-153）。
- 相同公开观察不同隐藏牌序的决策差异：adapter 只消费 `buildObservation` 的公开观察（createSimulation(observation)），未发现隐藏牌序泄漏路径（只读审查结论；未做逐字段差分穷尽，列为待验证 W3）。
- CRN 配对：方向 A/B 同种子同洗牌；候选席位轮换 i%seatCount 覆盖全部座位（E2 程序化验证通过）；challenge 对手轮换公式 (L−1)(i+s) mod L 在 L=5 下为双射——无固定对手偏置。
- 墙钟预算：100ms 预算使 JS5 负载敏感（团队已披露：js5 重放 4-6/12 不稳、classic 4 进程 vs diverse 2 进程并发不对称并声明方向偏保守）。属已知限制，非新缺陷；建议第六阶段对正式挑战使用确定性预算（trial 计数上限）替代纯墙钟，从根本上消除负载敏感性。

## 4. P2 与备注

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-1 | challenge.mjs summary | 合并口径字段名 `candidateWinRate`（实为 A+B 阵营混合第一名率）有误读风险（已随附 firstPlace.note 缓解） | 更名 `campMergedFirstPlaceRate` |
| P2-2 | challenge.mjs | `meanDecisionMs`（9267.6）实为每局决策耗时合计而非单决策均值 | 更名 `meanTotalDecisionMsPerGame` |
| P2-3 | paths.mjs | `requireBuiltEngine` 只查存在性不查新鲜度——stale dist 会让训练侧静默运行旧算法（本次审计在独立 worktree 重建即触发 P0-2 的指纹差） | 构建 manifest（源码哈希→dist）+ 启动校验 |
| P2-4 | 多重比较 | 主族 family=4 预注册 + Bonferroni 披露规范（§5 实验设计）；次级对照（js1/js5opt/方向B）未纳入 family——报告已按证据分级披露，合规；建议第六阶段把"次级对照族"也预注册 | 预注册扩展 |
| P2-5 | 指标混用 | 全文检索未发现"先名率/配对优势率/合并率"三者实质性混用；A+B 合并值均带"阵营混合参考，不得作为单候选获胜概率"caveat（compare.mjs 强制注入）——整改到位 | 保持 |

## 5. PR #29 数据量核算说明（任务 P0-2 交付）

| 项 | 声明 | 独立核算 | 判定 |
|---|------|---------|------|
| confirm 总局数 | 25,600（PR 正文、PHASE5 §0.2） | **12,800**（8 文件 × 4 格 × 400 局；= PHASE5 §5.1 自述） | ❌ 双计，须更正 |
| 每格种子数 | 200 全新配对种子 | 200 ✓（连续块，起点 = confirmSeedBase(N,pool) 分区公式逐格吻合） | ✓ |
| 种子分区隔离 | [1.36e9,1.37e9) 每 (人数,池) 独占 50 万 | 8 个子区起点互不重叠、200/格消费 | ✓ |
| A/B 配对 | 双向 | 每种子 A、B 各 1 局，200/200 齐全 | ✓ |
| 座位轮换 | 席位随 seedIndex 轮换 | 每格 4 个座位全部被候选覆盖 | ✓ |
| 异常局 | 零异常 | 0 ✓（且 compare.mjs A2 对非 finished 一律拒绝——无静默丢弃通道） | ✓ |
| 对手池 | classic/diverse 两维度 | versionsIds 为真实标签（含 neutral-baseline/历史冠军/风格变体/random-legal） | ✓ |
| 指纹 | （未在头条披露） | js0-classic=b0df3fc4（PR-25 时代），其余 7 文件=9ed80290（第五阶段 HEAD）——单文件跨构建，已由 js0 重放 24/24 逐位复现佐证 | ⚠ 已披露，可接受 |
| challenge-11（PR #30） | 500 局 promote | **独立复算一致**：500 局、188W/60L/2T、优势率 0.7581（decisive=248 口径；含平局 0.7520）、Wilson 下界 0.691 > 0.5 @α=0.05/2^11 → verdict=promote 可复现 | ✓（但见 P0-2：受试代码版本问题） |
| 账本链 | challengeIndex=11 | 去重 11 块无重叠、作废运行隔离、块清单齐 | ✓ |

## 6. 双人 A/B 独立统计报告（任务 P0-3 交付）

方法：种子级配对 bootstrap（20,000 次重抽，审计侧独立实现，重抽单位=种子）；与官方 compare.mjs 交叉核对（js5 vs js0, classic, 2p, 方向A：点估计 0.08 逐位一致，CI 区间重叠）。**N=2 特性：方向 A 与 B 都是单候选席位（互换），A+B 合并是合法的席位互换池，但仍按种子聚类且标注探索性。**

**主对照 js5 vs js0（预注册主判定 = 方向A，family=4 校正仅披露）**

| 池 | 口径 | 差 | 95% CI | 分差 CI | 分级 |
|---|------|----|--------|---------|------|
| classic | 方向A | +8.0pp | [−0.5, +16.5] | [0.84, 6.36] | **non-inferior**（正向趋势，未达显著） |
| classic | 方向B | +15.0pp | [+6.5, +23.5] | [1.75, 7.24] | significant |
| classic | A+B（事后探索） | +11.5pp | [+5.3, +17.5] | [2.07, 6.00] | significant* |
| diverse | 方向A | +2.5pp | [−5.0, +10.0] | [−1.19, 3.90] | trend（单纯正向） |
| diverse | 方向B | +6.5pp | [−1.5, +14.5] | [1.46, 6.43] | non-inferior |
| diverse | A+B（事后探索） | +4.5pp | [−1.0, +10.0] | [0.86, 4.47] | non-inferior |

\* 探索性，不得用于晋级推断。

**次级对照（classic 池，2p）**：js1 vs js0 ≈ 0（−2.0/0.0/−1.0pp，全 trend）——JS1 在 2p 无增益，与第四阶段结论一致；js5opt vs js0 与 js5 基线相当（方向A +8.5pp non-inferior，方向B +13.0pp significant）——js5 与 js5-opt 统计等价（PHASE5 §4.3 结论复现）。

**诚实结论**：2p 上 JS5 相对冻结冠军的证据 = "正向、大概率真实、幅度温和（合并 +4.5~+11.5pp），但预注册主判定（方向A）双池均不显著"。这与 PHASE5 决策门槛 B"2 人保留冠军"完全自洽——**问题不在数据，在晋级没有执行按人数部署**（→ P0-3）。

分级规则声明：significant / non-inferior（δ=5pp）/ trend 的三级划分为本审计事后选择，非预注册；预注册口径仅 PHASE5 §5 的方向A主判定。

## 7. 随机性与复现审计（任务 P1 交付）

逐项结论：

| 审计项 | 结论 |
|--------|------|
| 模拟 RNG 与隐藏牌库 RNG 隔离 | ✓ 四条独立流（engine seed / seatRng / simSeed / random-legal），见 P1-5 |
| 相同公开观察不同牌序的决策差异 | 未发现泄漏路径（只读审查）；穷尽差分待验证（W3） |
| CRN 配对与候选试验公平 | ✓ C1 修复后批次平衡；**但 challenge-11 运行于 pre-C1**（P0-2） |
| 墙钟预算不确定性 | 已知限制，团队已诚实披露（重放不稳、负载不对称偏保守）；建议改确定性预算 |
| 版本指纹 vs 实际产物 | ❌ P0-2（77292a19 vs a0da8883）；esbuild 确定性本身 ✓ |
| 验证账本重复消费 | 现状 ✓（11 块无重叠）；根因 fail-open 未除（P1-3） |
| 异常局静默丢弃 | ✓ 无（compare.mjs A2 拒绝性校验 + challenge 计数 + 2% 上限） |
| 多重比较按声明处理 | ✓ 主族 family=4 预注册 Bonferroni；次级分级披露（P2-4 建议扩展预注册） |

## 8. 第六阶段正式实验前审计门禁（任务交付）

```bash
cd web-v1 && npm run build            # 产物构建（审计需要 dist）
node training/redteam/audit-gate.mjs  # 门禁（当前：阻断，P0×4）
```

门禁聚合：①版本身份（行为学）②历史证据核算 ③双人独立统计 ④回归测试（`node --test --test-concurrency=2 training/redteam/tests/redteam.test.mjs`）⑤晋级治理（全局晋级 vs 5p 证据）。**P0 清零 + 测试全绿 → 放行**；修复后请同步更新本报告缺陷清单与测试快照断言。

放行前必须完成（对应缺陷编号）：
1. P0-1：js0/js1/池 → 归档参数 + adapter 剥离守卫；
2. P0-2：当前 HEAD 重跑正式挑战（或冻结晋级代码）+ promote 指纹硬守卫；
3. P0-3/P1-4：分人数路由（2p 回退前任冠军）或补 2p 挑战；
4. P1-2：simulate.mjs 传 simSeed=seed；
5. P1-3：账本合并 fail-closed。

## 9. 待验证清单（未证实，不得作为已确认缺陷引用）

- **W1**：C1 修复前的批次偏差对 challenge-11 具体 verdict 的影响幅度（需在固定种子子集上以两个版本对照重放；本审计为避免高负载未执行）。
- **W2**：晋级 PR 中 dist/standalone/mobile 产物是否由 post-C1 源码构建（本审计只验证了源码与可复现性；CI 构建产物未取证）。
- **W3**：adapter 信息边界的逐字段差分穷尽（当前为只读审查结论"未发现泄漏"）。
- **W4**：3p diverse 池"正向趋势"在更大样本下是否收敛显著（PHASE5 已如实标注 inconclusive，无需行动）。

## 10. 交付物索引

| 文件 | 说明 |
|------|------|
| `training/redteam/audit-versions.mjs` | P0 版本身份行为学审计（--json / --probes=N / --full） |
| `training/redteam/audit-evidence-accounting.mjs` | PR #29/#30 证据核算（E1-E5） |
| `training/redteam/stats-two-player.mjs` | 双人 A/B 独立统计（含 compare.mjs 交叉核对） |
| `training/redteam/audit-gate.mjs` | 第六阶段审计门禁（聚合判定，exit 0/2） |
| `training/redteam/tests/redteam.test.mjs` | 回归测试：5 快照 + 3 期望不变量（todo，修复后转正） |
| `training/redteam/OVERNIGHT-AUDIT.md` | 本报告 |

## 11. 复现命令

```bash
# P0-1（行为学，~5s/64 探针）
node training/redteam/audit-versions.mjs

# P0-2（指纹；需网络克隆后在临时 worktree 重建 4a11b62）
git worktree add --detach /tmp/replay 4a11b62 && cd /tmp/replay/web-v1 \
  && ln -s <repo>/web-v1/node_modules node_modules && npm run build \
  && cd .. && node --input-type=module -e "import('./training/lib/paths.mjs').then(m=>console.log(m.engineBundleSha256()))"
# 期望输出 77292a19…（= candidate.json 记录）；当前 main 构建为 a0da8883…

# P1-1 / E3 / E4（证据核算）
node training/redteam/audit-evidence-accounting.mjs

# 双人 A/B
node training/redteam/stats-two-player.mjs

# 回归测试 + 门禁
node --test --test-concurrency=2 training/redteam/tests/redteam.test.mjs
node training/redteam/audit-gate.mjs
```

---

*审计独立性声明：本审计与第六阶段算法研发（research/ai6-phase6-winrate-scaling）完全隔离，未选择性解释数据——对 JS5 有利的独立复算结果（challenge-11 统计可复现、confirm 指纹佐证、2p 非劣）与不利发现（P0-1/2/3、P1-1/2/3）均已如实并列报告。*
