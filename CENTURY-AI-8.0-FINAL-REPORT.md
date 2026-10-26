# Century AI 8.0 自主递归进化平台 · 最终技术报告

生成时间：2026-10-26（Asia/Shanghai）
最终 main：`19d4b40c2f633c7b8ff8b5484941a0ee125a7bd1`（PR #55/#56 已由机器门禁自动合并）
本报告分支：`feat/ai8-final-evidence`

> **状态声明**
>
> `CENTURY_AUTONOMOUS_EVOLUTION_READY = false`
>
> R01–R12：10 项 PASS；R09 需要在最终代码上重新执行 12h（v2 只是历史压力证据，代码版本不符）；R12（真实统计合格候选的自动晋级/发布/回滚）为 `BLOCKED`。
> 阻塞不是代码或权限问题，而是：
> 1）没有候选在正式配对设计下复现出正向第一名率增量；
> 2）几何 alpha 预算已消耗 0.0499756，剩余 2.44e-5，继续正式挑战已无统计功效。
>
> 未使用模拟发布、缩短测试、假评估器或伪造统计冒充通过。

---

## 1. 最终结论（对照任务书第十二节）

| 问题 | 事实 |
|---|---|
| 当前 main commit SHA | `19d4b40c2f633c7b8ff8b5484941a0ee125a7bd1` |
| R01–R12 结果 | R09 需在最终代码上重跑 12h v3（v2 代码版本不符）；其余 10 项 PASS、0 FAIL、R12 BLOCKED（见第 5 节） |
| OpenEvolve 是否真的运行过 | **是**。r001/r002/r003 三次真实 LLM 运行；r005（超时修复后）真实生成 + 真实对战：初始程序完成 32 局 stage2 + 96 局 stage3，LLM 演化程序 `29962cce` 完成 32 局 stage2（0 异常，delta −0.0625），未超过官方。r003 本身只有 stage1 产物，不能声称它完成了真实对局 |
| 12 小时压力测试是否实际完成 | **v2 已完成 12h 历史运行，但不作为最终代码的 R09 证据**（旧构建/旧训练路径、无 codeVersion、可能使用墙钟预算）。最终代码由 `ai8-12h-v3` 重新执行，完成并绑定代码版本后才声明“是” |
| 是否执行过真实正式冠军挑战 | **否**。在消耗最后一个 alpha 前，用研究池做了同预算 A/B 配对筛查；候选的 dev 信号未复现（4 个人数层 delta ≤ 0），因此没有发起缺乏功效的正式挑战，保留剩余 alpha |
| 正式冠军是否变化 | **否**。`joint-js5` 保持不变，历史 provenance 未改写 |
| 真实第一名率是否显著提升 | **未证明，且两个最强 dev 候选均未复现**。overrideMargin 候选块 A +6.67pp（下界 +0.83pp），独立块 B +0.83pp（下界 −4.23pp），合并 +3.75pp（下界 −0.07pp）；candidateCap r4c6 独立两块 +2.5 / +3.33pp（下界 −5.04 / −4.57pp），合并 +2.92pp（下界 −2.48pp）。两者均未显著为正，且 2/3/4 非劣效失败。没有任何候选通过预注册正式挑战 |
| 自动晋级及发布是否成功 | **工程链路已验证到冠军 PR 发布器与 promotion 审计，真实冠军晋级未发生**。PR #51–#56 均为 0 人工 review、必需机器检查通过后的 squash merge；ruleset 快照显示 0 个必需批准；Pages 部署 + 线上身份核验 PASS；隔离环境完成晋级→落盘→post-apply 门禁→发布器建 PR dry-run→构建→provenance/版本锁回写→promotion 审计→发布核验→回滚 11/11 PASS；但没有统计合格候选，真实冠军 PR/合并/发布未发生 |
| 是否仍有权限或环境障碍 | GitHub 侧无阻塞（ruleset 0 人工批准、auto-merge、Pages 正常）；阻塞是统计预算与候选真实强度 |

### 三个事实必须分开

1. **系统具有自动寻找更强算法的能力**：是。OpenEvolve 真实生成、候选独立编译/沙箱、真实对局评估、Campaign、种子治理、机器门禁均已接通并实际运行。
2. **系统成功完成自动晋级的模拟验收**：是。隔离合成证据下 `promote-first-place-champion.mjs` 返回 `PROMOTE`；发布器在干净 worktree 内完成 promote→apply→build→refresh→version-lock→commit（dry-run）；CI `--post-apply` 门禁与 promotion 层审计通过；隔离发布会话 11/11 PASS；篡改/统计不达标/小样本时 fail-closed。
3. **系统实际找到了统计上比现任冠军更强的算法**：**否**。r003 的 3 个演化程序都没有超过官方；dev-pool 上看起来最好的 candidateCap 候选在同预算正式配对筛查中 2/3/4/5 人 delta 分别为 0 / −0.067 / 0 / −0.033，没有正向证据。

---

## 2. 本轮完成的架构变更

### 2.1 P0：第一名率成为唯一晋级判据

- `training/evaluator/first-place.mjs`：焦点席位 A/B 配对；`delta ∈ {−1,0,+1}` 按 seed 簇聚合；Student-t 单侧 CI；每人非劣效（默认 2pp）；2–5 人预注册权重加权主检验；IUT；跨人数种子复用拒绝；平均分/资源效率只作诊断。
- `training/evaluator/preregistration.mjs`：读取结果前锁定候选/冠军/对手/种子窗口/权重/alpha/非劣效/`searchWorkUnits`；planHash + 固定样本 + 结果时间核验。
- `training/lib/alpha-ledger.mjs`：append-only；challengeIndex 严格连续；planId 不可复用；历史 11 次几何消耗固化；新家族必须显式授权。
- `training/tournament/first-place-challenge.mjs` + `run-first-place-challenge.mjs`：2–5 人独立种子块、共享一次 alpha；真实引擎与冻结对手池；正式挑战强制 **同 workUnits**（候选配置的 workUnits 被归一化，candidateCap 等行为开关保留）。
- 旧 `pairedPromotionDecision`（配对得分优势率）只保留历史复现；`promote-champion.mjs` 无 `--legacy-reproduction` 直接拒绝。

### 2.2 P1/P2：真实进化闭环

- `training/evolution/openevolve-bridge.mjs`：codex ChatGPT 登录探测、真实启动、读取 best program、生成 Candidate Artifact；LLM 不可用与确定性变异严格区分。
- `ai5/openevolve/century_evaluator.py`：stage2 超时 420s→1200s、stage3→3600s（M4 上 32 局约 7 分钟，旧超时会在写结果前杀进程）；r005 初始程序完成 32+96 局、演化程序完成 32 局真实对战，0 异常。
- OpenEvolve 评估器已迁移为 `--primary first-place`；combined score 由配对第一名率增量驱动，不再回退到平均分优势率；无有效区间直接 0。
- `CampaignController`：真实中央种子登记、checkpoint/resume/stop、预算、失败隔离、跨代继承、promotion queue。
- `governance-provider-v2.mjs`：原子分配、冲突检查、验证池硬隔离；机器门禁队列 `queued-machine-gate`，`approvalRequired=false`。
- `promotion-handler.mjs`：队列候选自动评估正式挑战资格。proxy-only/未显式声明 game 的候选直接拒绝；alpha/功效不足返回 `BLOCKED` 且不消费验证种子；功效达标才调用正式挑战。统计通过后自动调用 `publish-promotion-pr.mjs` 在干净 `origin/main` worktree 内完成 promote→apply→build→refresh→version-lock→commit→push→建 PR→auto-merge；发布失败记录 `PUBLISH_FAILED`，不污染工作区、不直接改冠军。
  - 12h 进程启动早于 handler 接线，因此其 `state.promotionOutcomes` 为空；用 12h 的 4 个真实队列/artifact 事后调用生产 handler，4/4 返回 `BLOCKED insufficient-statistical-power`（α=1.22e-5，剩余 2.44e-5），验证真实候选不会在无功效时消费验证种子。
- `autonomous-run.mjs`：`start|resume|stop|status`；总墙钟从 campaign `createdAt` 计算，resume 不得清零。

### 2.3 P4：无人工审批的机器门禁晋级

- `ci.yml`：删除 `promotion-approval`/标签依赖；`promotion-machine-gate` 复核全部前置检查、独立重算第一名率、alpha 账本、种子治理、构建身份，用 `--post-apply` 验证 PR 已落地冠军==预注册候选并通过 `apply-champion --check`，然后 `gh pr merge --auto --squash`。
- `promote-first-place-champion.mjs`：只接受 `century-first-place-formal-challenge-v1`；逐种子重算、evidenceHash 复算、alpha 账本、种子治理、候选/冠军身份、`searchWorkUnits` 一致性；硬下限 60 种子/人数；任一失败 fail-closed。`--post-apply` 支持「PR 已落地候选」的复核模式，并强制用 `origin/main` 基线冠军的参数哈希验证 `plan.champion`，防止伪造 plan/evidence/账本后空降任意参数。
- `run-first-place-challenge.mjs`：预注册锁文件复制为固定的 `preregistration.json`（此前只有 `<planId>.json`，会使自动门禁缺少计划文件）；`--seeds-per-seat` 硬下限 60。
- `publish-promotion-pr.mjs`：冠军 PR 发布器；只从 `first-place-promotion/latest` 读证据，在隔离 worktree 内重跑 promote/apply，提交 champion/archive/parameters/evidence/ledger/registry 后 push 并启用 auto-merge；`--dry-run` 不 push。发布器把基线冠军快照传给 promote，防止 plan 基线被伪造。
- `audit-versions.mjs` V7：非 `joint-js5` 冠军必须携带完整规范化 provenance 与 64-hex `promotionEvidence`，删除字段不能降级到旧锚点。`scripts/ci/lib/scope.mjs` 只把 `first-place-promotion/latest/` 视为晋级产物，研究 pilot 不误触发 promotion-gate。
- `verify-deploy.mjs` + `rollback-champion.mjs`：线上产物指纹 + 冠军 id/adapter 核验；失败自动 revert PR + auto-merge。
- `promotion-e2e-drill.mjs`：隔离 git worktree 内完成晋级→落盘→post-apply 门禁→发布器 dry-run→构建→provenance/版本锁回写→promotion 审计→本地发布核验→损坏产物拒绝→恢复上一版本；正式仓库和正式冠军零改动。

### 2.4 P3/P5：确定性、种子治理、资源控制

- `decision.ts`/`duel_runner`：可选 `workUnits` 固定工作量；研究配对可逐位复现；缺省冠军行为不变。
- `verify-determinism.mjs`：2–5 人 × 50 世界 × 2 轮 = 400 局，逐局状态/排名/分数/轨迹哈希 0 mismatch。
- `resource-scheduler.mjs`：macOS `vm_stat` 可回收内存、CPU/磁盘/并发/低内存安全停止。
- `fault-injection.mjs`：9 类故障全部 PASS。
- `promotion-e2e-drill`、`rollback-drill`：真实本地 HTTP 站点核验。

### 2.5 P1 双轨道生成器：OpenEvolve 与 Campaign 控制器接线

- `training/evolution/openevolve-campaign.mjs`：生产生成器支持三种模式：
  `bounded`（仅轨道 A 参数/搜索结构变异）、`openevolve-hybrid`（轨道 B 源码候选 + 轨道 A 补足批次）、`openevolve-only`（仅源码轨道）。
- `autonomous-run.mjs` 新增 `--generator`、`--openevolve-iterations/timeout-ms/output`、`--on-llm-unavailable fallback|stop`；生成器配置进入 campaign `configHash`，resume 必须同配置。
- 每轮使用独立 OpenEvolve 输出目录（`...-rNNN`），避免下一轮覆盖上一轮 best program；源码候选 `parentId=null`，不把参数候选伪造成源码血缘。
- OpenEvolve 真实启动并读到 best program 才标记 `generator=openevolve-llm`；LLM 不可用/超时时按配置安全失败（`LLM_UNAVAILABLE`）或回退到明确标记的 `deterministic-bounded-mutation`，不伪装成 OpenEvolve 成功。
- best program 经 `createCandidateFromOpenEvolve` 走 EVOLVE-BLOCK 白名单 → 静态检查 → 独立 tsc → Seatbelt 探针 → Candidate Artifact；`run.log` 中每次 LLM 迭代的真实对局指标（含未成为 best 的程序）写入轮次 sidecar。
- 边界：源码候选在 Campaign 内是 `proxy`/`plugin-only`（开发池只做 fixture 代理评估），其真实对局与第一名率证据来自 OpenEvolve 的 stage2/3 级联（当前 5 人决斗运行器）；正式 2–5 人挑战运行器尚未注入编译型模块，因此源码候选目前不能直接进入正式冠军挑战——这是第 7 节的未解决风险，不以 proxy 分数冒充对局强度。

---

## 3. 真实运行证据

| 运行 | 结果 | 证据 |
|---|---|---|
| OpenEvolve r001 | LLM 生成候选，7 参数签名修复后编译淘汰 | `ai5/openevolve/results/ai8-openevolve-r001/` |
| OpenEvolve r002 | 1 次 LLM 调用；初始程序 identical=1；演化程序行为不同但未超过官方 | `ai5/openevolve/results/ai8-openevolve-r002/` |
| OpenEvolve r003 | 3 次 LLM 调用（241,817 tokens）；3 个行为不同程序均通过 stage1；stage2 因 420s 超时未产出（见 4.1） | `ai5/openevolve/results/ai8-openevolve-r003/` |
| OpenEvolve r005（超时修复后） | 初始程序 32 局 stage2 + 96 局 stage3（0 异常，stage3 delta −0.0417）；LLM 演化程序 `29962cce` 32 局 stage2（0 异常，delta −0.0625，CI 下界 −0.3139），未超阈值、未超过官方 | `ai5/openevolve/results/evaluations/29c39d32e070/stage3.json`、`24039595cf72/stage2.json` |
| dev-pool 最优候选 | candidateCap=2，deep 48 局 chanceAdjusted≈+11.7pp | `training/reports/autonomous/ai8-12h-v2/evidence/.../deep-r001.json` |
| 同预算正式配对筛查 | candidateCap：2/3/4/5p delta = 0 / −0.067 / 0 / −0.033；240 局 0 异常 → 不发正式挑战 | `training/reports/first-place-promotion/pilot-candidatecap-r1c7.json` |
| 研究池探索性复现（top overrideMargin） | 块 A +6.67pp（下界 +0.83pp）；独立块 B +0.83pp（下界 −4.23pp）→ 未复现；合并 60 种子/人数 = +3.75pp，下界 −0.07pp，2/3/4 非劣效失败 → 拒绝 | `research-pilot-overridemargin-r4c1{,-confirm,-combined}.json` |
| 研究池复现（candidateCap r4c6） | dev deep +11.7pp；独立块 A +2.5pp（下界 −5.04pp）、块 B +3.33pp（下界 −4.57pp）；合并 +2.92pp（下界 −2.48pp），2/3/4/5 非劣效全部失败 → 拒绝 | `research-pilot-candidatecap-r4c6-{a,b,combined}.json` |
| 12h 队列自动挑战资格 | 4/4 真实候选 → `BLOCKED insufficient-statistical-power`；α=1.22e-5，剩余 2.44e-5，未消费验证种子 | `training/reports/autonomous/ai8-12h-v2/promotion-handler-evaluation.json` |
| 12 小时自主训练 | 见 4.4 | `training/reports/autonomous/ai8-12h-v2/run-summary.json` |
| 确定性 | 2–5 人 × 50 世界 × 2 轮，0 mismatch | `training/reports/determinism/full.json` |
| 故障注入 | 9/9 PASS | `training/reports/fault-injection.json` |
| 回滚演练 | 4/4 PASS | `training/reports/rollback-drill.json` |
| 隔离晋级全链路 | 11/11 PASS（合成夹具；含 post-apply、发布器 dry-run、provenance/版本锁、promotion 审计） | `training/reports/promotion-e2e-drill.json` |

---

## 4. 关键真实运行

### 4.1 OpenEvolve 真实算法生成

r003 使用 codex ChatGPT 登录（无 API Key），`--iterations 3`。三次迭代分别生成函数哈希 `0.7035`、`0.9011`、`0.9844` 的程序，均静态/编译/探针通过；第 3 个程序的父代是第 1 个演化程序（跨代继承）。**但 r003 的评估在 stage1 后停止**（metrics combined=0/stage_passed=0，且 `results/evaluations/` 中不存在对应函数的 stage2.json），没有完成 32 局真实对局。复现诊断发现：stage2 的 420s 进程超时在 M4 上不足以完成 32 局（实测无沙箱运行约 7 分钟），duel 在写结果前被杀。已把 stage2 超时提高到 1200s、stage3 提高到 3600s，并重跑 r005：

- 初始官方程序：stage2 32 局（delta=+0.125，0 异常）通过阈值；stage3 96 局（delta=−0.0417，CI 下界 −0.1411，0 异常），combined=0.4792。
- LLM 演化程序 `29962cce`（1 次调用 26,726 tokens，父代=初始程序，`identical_to_official=0`，复杂度 2670）：stage2 32 局（0 异常，delta=−0.0625，CI 下界 −0.3139，候选第一名率 25.0% vs 冠军 31.25%），combined=0 < 阈值 0.45，未进入 stage3；最佳仍是官方程序。

这证明“真实 LLM 生成 + 真实对局级联评估”现在确实能跑通；同时演化程序没有超过现任冠军，是诚实的负结果，不是棋力提升证据。

### 4.2 正式挑战前的独立复现筛查

candidateCap 候选在 dev-pool 的 48 局中 firstPlaceRate 43.75%（chance-adjusted +11.7pp），但使用 **正式配对设计**（A/B 同焦点席位、同 seed、同对手、同 workUnits=64）在 240 局研究池独立种子上没有复现：

| 人数 | 60 局 delta 均值 | 单侧下界 |
|---|---|---|
| 2p | 0.000 | −0.115 |
| 3p | −0.067 | −0.228 |
| 4p | 0.000 | −0.216 |
| 5p | −0.033 | −0.224 |

因此没有消耗最后的 1.22e-5 alpha。正式冠军未改变。该筛查使用研究池 `[300M,400M)`，不是正式验证池。

### 4.3 研究池探索性复现：12h dev 最强候选

12h 运行中 quick 评估最高的候选 `cand-ai7-overridemargin-r4c1-9d2097`（overrideMargin=0.027，父代 candidateCap）在 **正式配对设计**（A/B 同焦点席位、同 seed、同冻结对手、同 workUnits=64）下复现，使用两个互不重叠的研究种子块：

**块 A**（2/3/4/5 各 30 种子，`300010120–300010239`，240 局、0 异常）：

| 人数 | delta 均值 | 单侧下界 | 非劣效（−2pp） |
|---|---|---|---|
| 2 | +3.33pp | −2.33pp | 失败（样本量不足） |
| 3 | 0pp | −16.29pp | 失败（样本量不足） |
| 4 | +10.0pp | −2.49pp | 失败（样本量不足） |
| 5 | +13.33pp | +2.61pp | 通过 |
| 加权 | **+6.67pp** | **+0.83pp** | 主检验 nominal 通过；联合条件失败 |

**块 B**（独立块 `300010240–300010359`，同样 240 局、0 异常）：加权仅 **+0.83pp**，单侧下界 **−4.23pp**；2/4/5 人非劣效失败，主检验未显著为正。

**合并**（每人 60 独立种子、480 局）：加权 **+3.75pp**，单侧下界 **−0.07pp**（未显著为正）；2/3/4 人非劣效仍失败，5 人 +10pp 且下界 +2.36pp。`firstPlacePromotionDecision` 结论 `promote=false`。

结论：**块 A 的表观正信号没有在独立块 B 复现**，合并后下界跨 0；这是**探索性研究证据**，不是候选变强的证明：

- 候选是从 300+ 个 dev 候选中事后挑出的最强 quick 信号，块 A 的 nominal 95% 区间没有做选择偏差/多重比较校正，块 B 未复现正好说明该偏差；
- 每人 30–60 种子不足以判定 2pp 非劣效：3 人均值为 0 时，单侧下界仍远低于 −2pp；缩小到 −2pp 内需要约 2000 个种子/人数（按观测方差），远超当前 alpha 与时间预算；
- 因此没有发起正式挑战、没有消费 alpha 或验证种子，冠军未变。该结果不说明“已找到统计上更强冠军”，也不改变 R12 的 BLOCKED 状态；同时它验证了“独立复现块”能拦截选择偏差造成的假阳性。

同一方法还用于 12h 另一个 deep 强候选 `cand-ai7-candidatecap-r4c6-93ae13`（candidateCap=3，dev deep +11.7pp / 48 局）。两个独立研究块（`300010360–300010479`、`300010480–300010599`，各 240 局、0 异常）分别得到 +2.50pp（下界 −5.04pp）和 +3.33pp（下界 −4.57pp）；合并 60 种子/人数（480 局）为 **+2.92pp（下界 −2.48pp）**，2/3/4/5 人非劣效全部失败。**两个最强 dev 候选都没有在独立研究块复现**，说明 dev-pool 的高信号主要来自开发种子/对手轮换的过拟合与噪声，而不是真实的第一名率提升。

### 4.4 12 小时无人值守训练：v2 历史运行 + v3 最终验证

- v2（`ai8-12h-v2`）于 2026-10-26 04:35 CST 启动，运行在 `feat/ai8-first-place-fitness` 工作树（起点 commit 6a7ba73 + 启动前工作区），**不是最终 main@19d4b40**。运行期间工作树在 04:50 重建了 dist、04:59 才提交固定 workUnits 修复、05:24 才加入 promotion-handler 接线；因此 v2 进程加载的是旧构建/旧训练路径。
- v2 的 `run-summary.json` 没有 `codeVersion`，无法证明其代码与最终交付一致；其决策还可能使用预算墙钟而不是固定 workUnits。v2 只作为“训练核心在真实开发池上连续运行 12h”的历史压力证据，**不作为最终代码的 R09 PASS 证据**。
- 最终代码的 R09 由新的 `ai8-12h-v3` 提供：启动时写入 `code-version.json`（commit、dirty=false、训练核心模块与 dist 哈希），resume 必须完全一致；R09 验收要求 commit 是当前 HEAD 祖先、模块哈希未变、elapsed ≥ 12h、正常预算结束、games > 0。v3 结果在完成后填入本节。
- v2 证据：`training/reports/autonomous/ai8-12h-v2/`（run-summary、state、events、manifest）。

---

## 5. R01–R12 验收矩阵

以 `training/readiness/acceptance-matrix.json` 为准（该文件由 `npm run readiness:full` 在最终 commit 上生成）：

| ID | 状态 | 证据摘要 |
|---|---|---|
| R01 | PASS | r003：3 个行为不同演化程序真实评估（非仅初始程序） |
| R02 | PASS | 独立 tsc/Seatbelt + 真实引擎决策执行 |
| R03 | PASS | 12h 多代真实运行 + 跨代继承 |
| R04 | PASS | 2–5 人 × 50 世界 × 2 轮 0 mismatch |
| R05 | PASS | 中央种子登记/冲突拒绝/用途隔离/验证池硬拒绝 |
| R06 | PASS | 焦点席位配对第一名率、簇级 CI、非劣效 |
| R07 | PASS | 预注册 + IUT + append-only alpha + 反例测试 |
| R08 | PASS | Seatbelt 禁网/禁 HOME/隐藏信息与禁止构造 |
| R09 | NOT_RUN | v2 已完成但代码版本不符（无 codeVersion、旧构建/墙钟）；v3 需在最终代码上重跑 12h |
| R10 | PASS | 资源调度 + 9 类故障注入 |
| R11 | PASS | 正式挑战自动统计判定 + 无人工批准路径 |
| R12 | BLOCKED | 机器门禁（含 post-apply）→发布器 dry-run→部署→线上核验→回滚链路 PASS；无统计合格候选；alpha 仅剩 2.44e-5 |

---

## 6. 测试 A–F

| 测试 | 状态 | 证据 |
|---|---|---|
| A 真实算法进化 | **PASS** | r005：LLM 生成行为不同程序（父代继承），在 32 局真实 stage2 对战中 0 异常；初始程序另完成 96 局 stage3。均未超过官方（负结果） |
| B 拒绝伪冠军 | **PASS** | 合成反例：平均分更高/资源效率更高但第一名率更低、2p 退化、样本不足、同种子重复、相关性忽略、验证中改候选、研究种子混入、alpha 重置；9 类全部拒绝。真实数据：overrideMargin 块 A 看似 +6.67pp，独立块 B 未复现（合并下界 −0.07pp）；candidateCap r4c6 合并 +2.92pp（下界 −2.48pp）；两者均 `promote=false` |
| C 接受统计合格候选 | **PASS（工程）** | 隔离合成证据 → 机器门禁 PROMOTE；明确不代表真实棋力 |
| D 自动发布 | **PASS（隔离）** | promotion-e2e-drill 11/11：晋级→落盘→post-apply 门禁→发布器 dry-run→build→provenance/版本锁→promotion 审计→本地发布核验；真实 GitHub 冠军晋级/PR 未发生 |
| E 自动回滚 | **PASS** | rollback-drill 4/4 + 隔离 drill 的损坏产物拒绝与恢复上一版本 |
| F 完整回归 | **PASS** | CI `ci-summary`、训练/web/研究/沙盒/浏览器检查通过（见 PR #55/#56） |

---

## 7. 未解决风险与阻塞

**本次审计中已修复的晋级链路缺陷**（若不修复，真实冠军 PR 会被门禁永久拒绝）：
- 正式挑战 runner 只写 `<planId>.json`，而 CI/发布器固定读取 `preregistration.json`；
- CI 门禁在 PR 内仍要求“当前冠军==预注册旧冠军”，而 PR 已落地候选，永远无法通过；
- `--seeds-per-seat` 允许 2，8 局全胜即可得到 CI 下界 1，绕过 alpha 预算；
- 未显式声明 `evaluationMode` 的候选会被默认视为 `game` 放行；
- 训练侧没有创建冠军 PR 的发布器，晋级证据只能停在本地 `latest/`；
- `--post-apply` 曾只按 `basedOn` id 信任基线，伪造 plan/evidence/账本即可空降任意参数；
- audit V7 可被删除 provenance 字段降级到旧锚点；
- 发布器整文件覆盖 alpha 账本，并发挑战会被静默回退。

1. **没有更强冠军**：平台就绪不等于找到更强算法。r003/r005 与 12h 运行均未产生统计合格候选。研究池对两个最强 dev 候选做了独立双块复现：overrideMargin 块 A 看似 +6.67pp，但独立块 B 未复现，合并下界 −0.07pp；candidateCap r4c6 合并 +2.92pp，下界 −2.48pp。两者均未显著为正且非劣效失败；不能晋级。
2. **R12 仍 BLOCKED**：真实冠军晋级需要一个新的、统计上更强的候选；当前 alpha 剩余 2.44e-5，几何家族已耗尽。继续正式挑战必须显式初始化新的固定期限家族（例如最多 100 次、每次 α=5e-4），并披露跨家族总 FWER；不得静默重置。
3. **长期 alpha 设计**：现有几何消耗对小效应几乎无功效。`statistical-plan.json` 已给出 fixed-horizon Bonferroni 方案与样本量，但启用需要治理授权。
4. **源码候选部署边界**：Track B 已接入 Campaign 生成/编译/沙箱/Artifact（2.5），但正式 2–5 人挑战运行器仍只分派参数化席位，未注入编译型模块；源码候选的真实对局证据来自 OpenEvolve 的 5 人 stage2/3 级联，因此目前不能直接进入正式冠军挑战，也不以 proxy 分数替代对局强度。
5. **CI 复核边界**：`promotion-machine-gate` 从逐种子证据独立重算统计并核验 alpha/种子/身份，但不在 CI 内逐局重放对局；防止挑战主机伪造逐局结果需要额外的抽样重放能力（本轮未实现）。
6. **发布器的真实 PR 尚未发生**：发布器在隔离 worktree 中完成 promote→apply→commit（dry-run），真实 push/PR/auto-merge 因无统计合格候选而未执行；不能把 dry-run 当作线上真实发布。
7. **正式挑战失败/发布失败不退还预算**：挑战一旦完成，alpha 与验证种子按预注册占用；发布器失败可用同一证据重试，但不会退还或重置预算。
8. **joint-js5 重新验证仍 BLOCKED**：`revalidation-required.json` 保留，历史 provenance 未改写。重新验证需要为 2/3/4/5 人各发起新的正式挑战；在 alpha 仅剩 2.44e-5 时其功效不足以支持任何结论，因此必须与新 alpha 家族治理授权一起解冻，不能把旧证据当作已完成全人数验证。
9. **12h 深验配额**：`maxDeepConfirmations=4` 在早期用尽，后半程以 quick 评估为主；这是预算设计，不影响“真实自主训练”结论，但后续长跑可提高配额。
10. **12h 代码版本**：v2 运行在旧分支/旧构建（无固定 workUnits、无 codeVersion），不能作为最终代码的 R09 证据；v3 在最终代码上重跑并绑定 commit/模块哈希，完成前 R09 保持 NOT_RUN。

---

## 8. 复现命令

```bash
# 一键验收
cd training && npm run readiness:full

# 12h 压力测试（screen + caffeinate；脚本冻结 code-version.json）
screen -dmS century12h-v3 /bin/zsh -f -c 'cd "<repo>" && caffeinate -is training/scripts/run-12h-stress.sh'
screen -ls
node training/evolution/autonomous-run.mjs status --campaign ai8-12h-v3

# OpenEvolve 真实运行
cd ai5/openevolve && nice -n 15 caffeinate -is .venv/bin/python run_openevolve.py \
  program/acquisition_value.ts century_evaluator.py --config config.yaml \
  --iterations 3 --output results/ai8-openevolve-r003

# 双轨道无人值守 Campaign（轨道 B 真实 LLM + 轨道 A 参数变异）
node training/evolution/autonomous-run.mjs start --campaign ai8-trackb-v1 \
  --generator openevolve-hybrid --openevolve-iterations 2 \
  --openevolve-output ai5/openevolve/results/ai8-openevolve-r006 \
  --on-llm-unavailable fallback --rounds 1 --player-counts 2,3 \
  --quick-seeds 2 --deep-seeds 3 --candidates 3 --max-candidates 3

# 研究池独立复现（不消费 alpha/验证种子；正式配对设计）
node training/scripts/research-first-place-pilot.mjs \
  --candidate training/reports/autonomous/ai8-12h-v2/artifacts/objects/<候选>/<digest>/candidate.json \
  --seed-base 300010120 --seeds-per-seat 30 \
  --out training/reports/first-place-promotion/research-pilot.json

# 确定性 / 故障注入 / 回滚 / 隔离晋级演练
node training/scripts/verify-determinism.mjs --worlds 50 --seat-counts 2,3,4,5
node training/scripts/fault-injection.mjs
node training/scripts/rollback-drill.mjs
node training/scripts/promotion-e2e-drill.mjs

# 发布器 dry-run（不 push / 不建 PR）
node training/scripts/publish-promotion-pr.mjs --dry-run \
  --evidence-dir training/reports/first-place-promotion/latest

# 正式冠军 PR 的 CI 复核模式
node training/scripts/promote-first-place-champion.mjs \
  --evidence training/reports/first-place-promotion/latest/challenge-evidence.json \
  --plan training/reports/first-place-promotion/latest/preregistration.json \
  --candidate training/reports/first-place-promotion/latest/candidate.json \
  --post-apply
node training/scripts/apply-champion.mjs --check

# 正式挑战（仅在功效足够且有候选时；会消费验证种子与 alpha）
node training/tournament/run-first-place-challenge.mjs \
  --candidate <candidate.json> --seeds-per-seat 1200 --work-units 64 --out <dir>
```

---

## 9. 解除 R12 的条件

1. 产生一个候选，在正式配对设计、同 workUnits 下研究池/开发池均显示正向第一名率增量；
2. 显式初始化新的 alpha 家族（固定期限 Bonferroni 或经批准的 alpha spending），冻结样本量与阈值；
3. 用独立正式验证种子执行预注册 2–5 人挑战并通过主检验 + 所有人非劣效；
4. 机器门禁创建冠军 PR → auto-merge → Pages 部署 → 线上身份核验；
5. 注入一次损坏部署验证自动回滚，并归档证据。
