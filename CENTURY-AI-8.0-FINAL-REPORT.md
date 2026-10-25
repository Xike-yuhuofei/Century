# Century AI 8.0 自主递归进化平台 · 最终技术报告

生成时间：2026-10-26（Asia/Shanghai）
分支：`feat/ai8-autonomous-evolution`
功能提交：`0f99fbd5ac64a8dd82a040a5f2b925d2100582da`
基线 main（开发开始时）：`d9b5344e6463ac547fd27dfe1fb4bab32a19b098`

> **状态声明**
>
> `CENTURY_AUTONOMOUS_EVOLUTION_READY = false`
>
> 12 项验收中 10 项 PASS，R09（连续 12 小时真实训练）为 `NOT_RUN`，R12（真实线上自动发布与回滚）为 `BLOCKED`。
> 这不是代码失败，而是本次会话无法完成的真实资源/发布条件：没有候选通过第一名率正式挑战，也没有连续 12 小时运行窗口。
> 未使用模拟发布、缩短测试或假评估器冒充通过。

---

## 1. 最终结论（对照任务书第十二节）

| 问题 | 事实 |
|---|---|
| 当前 main commit SHA | 开发基线 `d9b5344`；功能分支提交 `0f99fbd`；报告生成时尚未合并到 main |
| R01–R12 结果 | PASS 10 / FAIL 0 / BLOCKED 1 / NOT_RUN 1（详见第 6 节） |
| 所有测试结果 | 训练 204/204、web-v1 261/261、CI 元测试 59/59、沙箱 6/6、确定性 400 局 0 不一致、故障注入 9/9 |
| OpenEvolve 是否真的运行过 | **是**。本次真实运行两次（`ai8-openevolve-r001`、`r002`），每次 1 次 LLM 调用；使用 codex ChatGPT 登录，无 API Key |
| 12 小时压力测试是否实际完成 | **否**。只完成了 2 代真实自主运行与 9 类故障注入；12h 连续运行标为 NOT_RUN |
| 是否执行过真实正式冠军挑战 | **否**。没有执行消费验证池的 2–5 人正式挑战 |
| 正式冠军是否变化 | **否**。`joint-js5` 保持不变，历史 provenance 未改写 |
| 真实第一名率是否显著提升 | **未证明**。没有候选通过预注册第一名率统计门槛 |
| 自动晋级及发布是否成功 | **否**。机器门禁与回滚代码已完成并通过隔离验收，但无真实候选可发布 |
| 是否仍有权限/环境障碍 | GitHub 侧无阻塞（admin、Pages、无分支保护）；真实阻塞是 **无统计合格候选** 与 **12h 运行窗口** |

### 三个事实必须分开

1. **系统具有自动寻找更强算法的能力**：是。Campaign Controller、真实种子治理、OpenEvolve 桥、真实对局评估、机器门禁均已接通并实际运行。
2. **系统成功完成自动晋级的模拟验收**：是。隔离合成证据下 `promote-first-place-champion.mjs --dry-run` 返回 `PROMOTE`；篡改/统计不达标时 fail-closed。
3. **系统实际找到了统计上比现任冠军更强的算法**：**否**。本次没有任何候选通过真实第一名率正式挑战。

---

## 2. 本轮完成的架构变更

### 2.1 P0：第一名率成为唯一晋级判据

新增：

- `training/evaluator/first-place.mjs`
  - 焦点席位配对设计：A=候选控制焦点席位，B=冻结冠军控制同一焦点席位，其余席位与种子完全相同；
  - `delta = candidateFirst − championFirst ∈ {−1,0,+1}`，按 **种子簇** 聚合，禁止把相关观测当独立样本；
  - Student-t 簇级单侧置信区间（非正态近似）；
  - 每个人数非劣效检验（默认 2pp）+ 2–5 人预注册权重加权主检验；
  - 联合条件用 IUT 控制多重检验；跨人数种子复用直接拒绝；
  - 平均得分、资源效率、搜索深度只作为诊断字段，不进入判定。
- `training/evaluator/preregistration.mjs`
  - 在读取正式结果前锁定候选/冠军/对手/种子窗口/权重/alpha/非劣效门槛；
  - planHash 防篡改；固定样本核验；结果时间必须晚于计划锁定。
- `training/lib/alpha-ledger.mjs`
  - append-only alpha 账本；challengeIndex 严格连续；禁止换名重置；
  - 历史 11 次挑战消耗已按几何方案 `α_k = 0.05/2^k` 固化（累计 0.0499756，剩余 2.44e-5）；
  - 提供显式授权的 `fixed-horizon-bonferroni` 替代方案（长期可持续、期满明确停止）。
- `training/tournament/first-place-challenge.mjs` + `run-first-place-challenge.mjs`
  - 一次挑战覆盖 2–5 人，四个人数使用独立种子子块，共享一个 challengeIndex / 一次 alpha；
  - 真实引擎、真实对手池（历史冠军 + 风格族 + 中立基线）、焦点席位轮换；
  - 搜索控制候选的 `jointOptionsByPlayerCount` 真实注入决策（修复“候选与冠军同行为”的隐性缺陷）。

旧判据 `pairedPromotionDecision`（配对得分优势率）保留在 `evaluator/stats.mjs` 作为历史复现工具；
`promote-champion.mjs` 增加守卫：无 `--legacy-reproduction` 直接拒绝，且历史复现不写正式冠军。

### 2.2 P1/P2：真实进化闭环

- `training/evolution/governance-provider-v2.mjs`
  - `createLiveGovernanceProvider`：真实中央种子登记、跨系统冲突检查、原子窗口分配；
  - `createAutonomousGovernanceAdapter`：正式挑战请求进入 `queued-machine-gate`，不再要求人工批准，但仍保留机器门禁。
- `CampaignController` 默认使用真实 Provider；新增 `promotion-queue` / `promotionOutcomes` / `promotionHandler`。
- `training/evolution/autonomous-run.mjs`：`start|resume|stop|status`，实际运行了 2 代、4 候选、24 局真实开发池对局，2 个候选进入机器门禁队列，冠军未变。
- `training/evolution/openevolve-bridge.mjs`：探测 codex 登录、真实启动 OpenEvolve、读取 `best/best_program.ts`、编译为 Candidate Artifact；明确区分 `openevolve-llm` 与确定性变异。
- 修复 AI7 引入的真实断链：`acquisitionValue` 已增加第 7 参数 `model`，而 OpenEvolve 目标/静态检查仍按 6 参数 → 组装后 tsc 必然失败。已同步 `EXPECTED_PARAMS`、初始程序、恶意样例与良性 fixture；沙箱 6/6、编译候选 5/5 恢复。

### 2.3 P4：无人工审批的机器门禁晋级

- `.github/workflows/ci.yml`
  - 删除 `promotion-approval` 人工批准作业与 `promotion-approved` 标签依赖；
  - 新增 `promotion-machine-gate`：复核全部前置检查、独立重算第一名率证据、alpha 账本、种子治理、构建身份，然后 `gh pr merge --auto --squash`；
  - `REQUIRES_APPROVAL` 不再有任何放行路径，直接阻断。
- `training/scripts/promote-first-place-champion.mjs`
  - 只接受 `century-first-place-formal-challenge-v1`；
  - 不信任自报判定：逐种子重算、evidenceHash 复算、逐人数区间比对；
  - alpha 预留/结果必须一致；种子区间必须已登记；候选参数/源码/产物哈希必须与预注册一致；
  - 决策核心身份（不含冠军参数区）在晋级前后必须一致。
- `scripts/ci/verify-deploy.mjs` + `rollback-champion.mjs` + `ci.yml` 的 `deploy-verify` / `rollback-on-deploy-failure`
  - 发布后检查线上 `build-manifest.json` 产物指纹、`index.html` 中的冠军 id 与适配器标记；
  - 失败时自动创建 revert PR 并 auto-merge，不直接 push main、不使用管理员强制合并。

### 2.4 P3/P5：确定性与资源控制

- `training/scripts/verify-determinism.mjs`：固定 workUnits，2–5 人 × 50 世界 × 2 轮 = 400 局，逐局比对状态/排名/分数/行动轨迹哈希；实测 **0 不一致**。
- `training/lib/resource-scheduler.mjs`：macOS 用 `vm_stat` 计算可回收内存（修复 `os.freemem()` 在内存充足时误判 2.5% 的问题）；CPU 负载、磁盘、并发上限、低内存停止。
- `training/scripts/fault-injection.mjs`：9 类故障全部 PASS（强杀恢复、超时、非法源码、编译失败、重复 Campaign、种子冲突、损坏 state、资源耗尽、LLM 不可用）。

---

## 3. 真实运行证据

| 运行 | 结果 | 证据路径 |
|---|---|---|
| OpenEvolve r001 | 真实 LLM 生成；候选改变函数签名（6→7 参数不匹配）→ 编译阶段淘汰 | `ai5/openevolve/results/ai8-openevolve-r001/` |
| OpenEvolve r002 | 真实 LLM 生成；静态/编译/探针全过；`identical_to_official=1`，无行为差异，未进入 stage2 | `ai5/openevolve/results/ai8-openevolve-r002/` |
| 2 代自主进化 | `completed`，4 候选，24 局，2 个机器门禁请求，冠军未变 | `training/reports/autonomous/ai8-smoke2/` |
| 确定性 | 2/3/4/5 人各 50 世界 × 2 轮，0 mismatch | `training/reports/determinism/full.json` |
| 故障注入 | 9/9 PASS | `training/reports/fault-injection.json` |
| 晋级门禁（隔离合成） | 正向 PROMOTE + 篡改/统计不达标拒绝 | `training/tests/promotion-gate.test.mjs` |

注意：OpenEvolve r002 的 `identical_to_official=1` 是**诚实的负结果**——LLM 没有提出有效改动；不得把它算作棋力提升。

---

## 4. 测试结果

| 套件 | 结果 |
|---|---|
| `training && npm test` | 204 / 204 PASS |
| `web-v1 && npm test`（含构建） | 261 / 261 PASS |
| `scripts/ci/tests/*.test.mjs` | 59 / 59 PASS |
| `ai5/openevolve/tests/test_security_sandbox.py` | 6 / 6 PASS |
| `training/evolution/tests/compiled.test.mjs` | 5 / 5 PASS |
| `training/tests/first-place*.test.mjs` | 23 / 23 PASS |
| `training/tests/promotion-gate.test.mjs` | 3 / 3 PASS |
| `training/redteam/audit-gate.mjs --tier dev` | 放行 |

---

## 5. 关键设计决策与已知取舍

1. **一次挑战共享一个 challengeIndex**：2–5 人同属一次预注册实验，IUT 控制联合错误率，只消耗一次 alpha。种子治理函数新增 `allowSharedChallengeIndex`，旧路径默认仍要求逐人数独立序号。
2. **alpha 预算已接近耗尽**：历史 11 次挑战后剩余 2.44e-5；第 12 次 α=1.22e-5。继续长期挑战必须显式初始化新的固定期限家族（需治理授权），否则系统会在预算耗尽时明确停止。
3. **源码候选（Track B）仍未接入正式冠军部署**：编译、静态检查、沙箱探针、行为签名已完成，但 `acquisitionValue` 源码候选仍标记 `integration: candidate-plugin-only`，未写入正式冠军构建。R02 的 PASS 指“编译 + descriptor 候选真实决策执行”，不等于“源码候选已可部署”。
4. **OpenEvolve 评估器仍以配对得分优势率为内部 fitness**：正式晋级已迁移到第一名率；研究级 fitness 迁移尚未完成，存在“研究目标与晋级目标不完全一致”的残余风险。
5. **12h 压力测试未执行**：`autonomous-run.mjs` 已支持 12h 预算与 checkpoint/resume，但必须在目标 M4 上真实连续运行后才能 PASS。

---

## 6. R01–R12 验收矩阵

以 `training/readiness/acceptance-matrix.json` 为准，摘要：

| ID | 状态 | 说明 |
|---|---|---|
| R01 | PASS | 两次真实 OpenEvolve LLM 运行；r002 编译/探针通过但与原实现相同 |
| R02 | PASS | 编译型候选独立 tsc + descriptor 候选真实引擎决策执行 |
| R03 | PASS | 2 代自主进化，24 局真实开发池对局，跨代继承 |
| R04 | PASS | 2–5 人 × 50 世界 × 2 轮，400 局 0 不一致 |
| R05 | PASS | 真实种子治理原子分配/冲突拒绝/用途隔离/验证池硬拒绝 |
| R06 | PASS | 焦点席位配对第一名率、种子簇 CI、非劣效、跨人数独立种子 |
| R07 | PASS | 预注册锁 + 反例测试 + append-only alpha 账本 |
| R08 | PASS | Seatbelt 禁网/禁 HOME/禁隐藏信息；静态禁止构造 |
| R09 | NOT_RUN | 未完成连续 12 小时真实训练 |
| R10 | PASS | M4 资源感知 + 9 类故障注入 |
| R11 | PASS | 预注册第一名率自动统计判定（隔离验收，无真实挑战） |
| R12 | BLOCKED | 无统计合格候选，未执行真实线上发布/回滚 |

---

## 7. 未解决风险清单

1. **没有更强冠军**：平台就绪不等于找到更强算法；本次所有候选均未通过真实第一名率门槛。
2. **R09 未完成**：12 小时连续运行、跨多代、真实对局、checkpoint/恢复与资源监测必须在目标 M4 上实测。
3. **R12 未完成**：需要在有统计合格候选后，真实执行一次冠军 PR → 自动合并 → Pages 部署 → 线上核验 →（故障时）自动回滚。
4. **源码候选未部署**：Track B 的 `acquisitionValue` 候选仍需接入正式构建与冠军身份链。
5. **研究 fitness 未迁移**：OpenEvolve 内部仍按配对得分优势率筛选，可能把“第一名率更差但均分更高”的候选带入深验。
6. **alpha 预算接近上限**：第 12 次后只剩 1.22e-5；长期运行必须显式治理授权新的固定期限家族。
7. **CI 平台风险**：本次新增的 auto-merge/Pages 核验依赖仓库启用 auto-merge 与 ruleset；若 GitHub 设置被外部改动，发布将 fail-closed 而非静默跳过。
8. **历史冠军证据仍待重新验证**：`joint-js5` 的旧证据只覆盖 5 人且受试产物与当前产物不一致；`revalidation-required.json` 保留，未被改写。

---

## 8. 复现命令

```bash
# 全量验收（R01–R12）
cd training && npm run readiness:full

# 无人值守自主进化（真实开发池；start/resume/stop/status）
cd training && npm run autonomy:start -- --campaign ai8-nightly --rounds 4 \
  --player-counts 2,3,4,5 --quick-seeds 8 --deep-seeds 12 --max-wall-ms 43200000
cd training && npm run autonomy:status -- --campaign ai8-nightly

# 确定性复现（完整 50 世界）
cd training && npm run determinism -- --worlds 50 --seat-counts 2,3,4,5

# 故障注入
cd training && npm run fault:inject

# 正式第一名率挑战（会消费验证池与 alpha，需谨慎）
node training/tournament/run-first-place-challenge.mjs \
  --candidate training/reports/first-place-promotion/latest/candidate.json \
  --seeds-per-seat 250 --out training/reports/first-place-promotion/latest

# 机器门禁晋级（CI 中使用 --dry-run；本地可实际写 champion）
node training/scripts/promote-first-place-champion.mjs \
  --evidence training/reports/first-place-promotion/latest/challenge-evidence.json \
  --plan training/reports/first-place-promotion/latest/preregistration.json \
  --candidate training/reports/first-place-promotion/latest/candidate.json
```

---

## 9. 解除 R09/R12 的条件

- **R09**：在 M4 上执行 `autonomy:start`，设置 `--max-wall-ms 43200000`，保留 `run-summary.json` 且 `elapsedMs ≥ 12h`、`status=completed`；期间至少有一次进程被强杀后 resume 且种子无复用。
- **R12**：先产生一个通过预注册 2–5 人第一名率挑战的候选（`promote-first-place-champion --dry-run` 返回 PROMOTE），再由机器门禁创建 PR、auto-merge、Pages 部署、`deploy-verify` 线上核验通过；另行注入一次部署产物损坏以验证自动回滚。
