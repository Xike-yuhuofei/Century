# AI 11.0 最终交付报告（Century × OpenEvolve 研究型自主进化系统）

生成时间：2026-10-29（Asia/Shanghai）
基线：`origin/main` @ `52b1601`
开发分支：`feat/ai11-research-system`（PR #75）
OpenEvolve：0.4.0（`ai5/openevolve/.venv`，Python 3.13.2）

> 本报告区分三类结论：**功能完成**、**可靠性通过**、**竞技收益已证明**。
> 三者不得互相替代。

## A. 实际交付情况

### P0 核心闭环

| 项 | 状态 | 证据 |
|---|---|---|
| P0.1 真实跨代源码继承 | 完成 | `composeProgramFromTexts`、`mutateModuleText`、artifact `lineage` 哈希链；`lineage.test.mjs` 三代真实继承 + 父代缺失/哈希篡改拒绝（macOS CI `ai9-research` PASS） |
| P0.2 统一证据契约 | 完成 | `research-index.mjs`（candidate/lineage/evaluation/failureCase/formalChallenge）；候选记录 `researchContextHash`、lineage 记录 `configPath`/`bestProgramHash`/`hypothesisId`、evaluation 记录 `behaviorHash` + 种子批次；LLM token 从 OpenEvolve 日志聚合，未知写 null |
| P0.3 配对第一名率筛选 | 完成 | 深验指标保留 `firstPlaceDelta`/CI；selector 主键改为配对增量下界；研究保留 vs 正式挑战资格分离（≥10pp、≥16 对、非对照基线） |
| P0.4 统计功效死锁 | 完成 | `statistical-plan-ai11.json`：K=12、α=1/240、方差 1.0、MDE 20pp、313 种子/人数、功效 0.80、H0 FWER 模拟 0.003；旧几何账本只读保留；`--check` 通过 |

### P1 科研闭环

| 项 | 状态 | 证据 |
|---|---|---|
| Research Orchestrator | 完成 | `research-orchestrator.mjs`：bootstrap / exploit-weakness / replicate / ablate / switch-direction；每轮假设由 `pair-verdict-rule-v1` 与深验证据对齐并回写状态 |
| ResearchBrief 进入 LLM | 完成 | 每轮生成 `openevolve-configs/rNNN.yaml`（system_message 注入）+ `.brief.json`（evaluator artifacts 通道）；contextHash 可核验 |
| Failure Diagnosis | 完成 | `failure-diagnosis.mjs` 按人数分层比较 A/B 动作分布与胜负翻转；状态 supported/weakened/rejected/inconclusive |
| 独立新种子复现 | 完成（结论 weakened/rejected） | `ai11-replicate-diagnosis.mjs`：对两个最深负增量候选各用独立 AI9 深验窗口、8 种子/人数（64 局/候选）复现；原 −0.25/−0.5 弱点**未复现**，判为噪声；结论写入研究索引与研究记忆 |
| 最小失败改动定位 | 完成（观测性） | `module-effects.mjs` + `ai11-module-effects.mjs`：同 (轮, 父代, 种子) 层内比较含/不含模块的配对第一名结果；65 层、12 模块，M08 负关联、M10 正关联，其余 inconclusive；同种子 A/B 政策反事实已由配对评估覆盖，单步动作反事实回放未实现 |
| Research Memory | 完成 | `research-memory.mjs` JSONL 跨进程；否定假设保留；检索已测假设/正向模块/失败；历史失败同时渲染进 `system_message`（prompt 通道）与 `.brief.json`（artifacts 通道） |

### P2 无人值守

| 项 | 状态 | 证据 |
|---|---|---|
| Supervisor | 完成 | 心跳、后代 CPU 活动判活、进程树清理、有界重试+退避、连续失败熔断、模型故障转移、资源门控、安全停止（15 分钟硬超时）、运行报告 |
| 持久任务队列 | 完成 | `task-queue.mjs`：PENDING→…→DONE、幂等提交标记、COMMITTING 崩溃标记待核验、种子预留（重叠拒绝） |
| 故障注入 7 点 | 7/7 实测 PASS | `training/reports/ai11-fault-injection.json`（含真实 OpenEvolve/codex 中断） |
| 6 小时无人值守验收 | **完成（PASS）** | `ai11-6h-v4`：6.109h / 58 轮 / 348 候选 / 3256 局；审计 8/8 硬性证据通过（`training/reports/ai11-6h-endurance-audit.json`） |

### P3 高级优化

| 项 | 状态 | 说明 |
|---|---|---|
| 多保真评价 | 保留既有级联 | OpenEvolve stage1→2→3 级联仍在；本轮未新增 Successive Halving/Hyperband（缺少成本校准证据） |
| 参数与代码分离 | 接口已存在 | `jointParameterMutation` + PARAMETER_BOUNDS；未接 CMA-ES/BO（缺乏实证收益） |
| 跨方向选择 | 数据积累中 | mutation operator 效果已可统计（research index），未启用 contextual bandit |
| 结构级创新 | 已有 M10/M11 等结构候选 | 未新增神经价值网络/MCTS 重构 |

**P3 结论**：按任务书"根据实证收益逐项启用"的要求，本轮不强行集成高级优化器；保留接口与数据积累路径。

### 统一操作入口（融入现有工程）

| 能力 | 命令 |
|---|---|
| 环境诊断 | `node training/readiness/run-readiness.mjs`；`node training/scripts/statistical-plan-ai11.mjs --check` |
| 启动 / 恢复 / 状态 / 停止 | `node training/evolution/autonomous-run.mjs start|resume|status|stop`（`--coevolve` 多模块） |
| 无人值守启动 | `node training/scripts/run-supervisor.mjs --campaign <id> --hours 6 ...` |
| 研究/谱系/统计报告 | `node training/scripts/research-report.mjs --campaign <id> --out <path>` |
| 模块级观测效应（最小改动定位） | `node training/scripts/ai11-module-effects.mjs --campaign <id> --out <path>` |
| 独立新种子复现 | `node training/scripts/ai11-replicate-diagnosis.mjs --campaign <id> --candidate <id> --seeds-per-count 8` |
| 运行验收 | `node training/scripts/ai11-endurance-audit.mjs --campaign <id> --hours 6` |
| 故障注入 | `node training/scripts/ai11-fault-injection.mjs` |
| 对照实验 | `node training/scripts/ai11-experiments.mjs --experiment A|B|C` |
| checkpoint 恢复演练 | `node training/scripts/ai11-a2-checkpoint-drill.mjs` |

### 限制与未完成（必须显式披露）

1. **竞技收益未证明**：6h 与三组实验均为 inconclusive/负增量；无候选满足正式挑战资格。
2. **未产生 supported 级弱点**：6h 内 57 份归因为 inconclusive（每层仅 1 对）；
   对两个最深负增量候选做 8 种子/人独立复现，结论为 weakened/rejected——原负增量
   是噪声而非系统性弱点。反馈通道存在且已写入研究记忆，但本轮没有"supported"结论。
   模块级最小改动定位只到观测关联（`ai11-module-effects.json`）；同种子 A/B 政策
   反事实已由配对评估覆盖，**单步动作反事实回放未实现**（需引擎快照/恢复支持）。
3. **顺序检验 interim 未启用**：设计已模拟验证（两次查看：313 种子/人、功效 0.80），
   runner 仍为固定样本单次 final look。
4. **编排器停滞策略单一**：6h 中 crossover 134 + ablation 97，探索多样性不足（见 F 节）。
5. **长跑内存/耗时**：第 32 轮出现 45 分钟无推进（进程仍占 CPU），靠监督器杀进程恢复；
   根因未定位，建议把候选评估移入子进程。
6. **6h 假设状态未回写**：6h 运行产生的 116 条假设在运行当时未写 experiment/status；
   回写闭环随后补齐（演示运行得到 H2A supported / H2B rejected），但 6h 原始记忆保持原样。
7. **P3 高级优化未启用**（多保真新实现、CMA-ES/BO、bandit、MCTS/神经价值网络）。
8. **docs PR 影响**：代码/证据 SHA 与文档回填 SHA 分离；仅文档提交不改变决策代码身份。

## B. 系统运行能力

### LLM 与路由
- 研究变异：Codex（`codex exec`）经 OpenEvolve `codex_app_server` 重定向；模型按权重轮换
  `gpt-5.6-sol/terra/luna`；连续失败时监督器切换到 `config-ai9-fallback.yaml`（单模型 + 更长超时）。
- 日志统计、指标计算、正式判定：确定性程序，不使用 LLM。
- 备用 Provider（GLM 4.7 Flash / OpenRouter 免费模型）仅用于探索，有并发/间隔限制与指数退避。

### 最终 6 小时无人值守运行（`ai11-6h-v4`）

| 指标 | 数值 |
|---|---|
| 实际墙钟 | **6.109 小时**（2026-10-29 15:05 → 21:12 UTC） |
| 结束状态 | `stopped`（监督器到期安全停止，非崩溃） |
| 轮次 / 候选 / 对局 / 深验 | 58 / 348 / 3256 / 58 |
| 生成策略 | control 58、single 17、pair 15、multi 13、openevolve 14、crossover 134、ablation 97 |
| 真实 LLM 候选 | **14**（OpenEvolve + Codex） |
| LLM 修改率 | **14/14 = 100%**（原样返回的候选在生成阶段即被拒绝，不计入） |
| Token | **624,013**（14 次调用，约 44.6k/候选） |
| 谱系记录 | 290 条，最大深度 **5**，三代链 = true |
| 研究简报 | 58 份注入配置（`openevolve-configs/rNNN.yaml` + `.brief.json`） |
| 研究上下文可核验 | **58/58 轮**含 `contextHash`；14/14 LLM 候选可按轮映射到本次上下文哈希（候选级字段自 PR #79 起写入索引） |
| 行为改变率 | **285/285 = 100%**（有父代候选的 behaviorHash 与父代不同） |
| 研究假设 | 6h：116 条（当时未回写）；演示：4 条已回写（H2A supported / H2B rejected / H1A-B inconclusive）；失败归因文件 57 份 |
| 预算 | wallUsed 19.26M / 21.6M ms；候选 348/4000；对局 3256/400000 |
| 有效研究时间 | wallUsed ≈ 5.35h / 总墙钟 6.109h（其余为轮间开销与卡死恢复） |
| 设备资源基线 | M4 10 核 / 16GB；监督器采样：可用内存 30.6%→31.7%、进程 RSS 51→62MB、磁盘可用 961GB；未触发资源门控 |
| 正式验证池 | **零消耗**（`validationPoolConsumed=false`，全程使用 AI9 开发块） |

### 恢复记录（真实发生）

| 时间（UTC） | 事件 |
|---|---|
| 2026-10-29 19:02:36 | 第 32 轮生成阶段连续 45 分钟无状态推进（进程仍占 CPU）→ 判定卡死 |
| 19:02:37 | 强制清理进程树，队列任务标记失败（有界重试，attempt 1） |
| 19:02:52 | `resume` 从 checkpoint 继续（同 runFingerprint / codeDigest），无重复种子、无丢失结果 |
| 19:03 → 21:11 | 恢复后继续推进 26 轮，直到监督器到期安全停止 |

审计结论：`ai11-endurance-audit.mjs --campaign ai11-6h-v4 --hours 6` → **PASS**（8/8 硬性证据）。
独立性说明：该运行**没有**任何候选通过正式冠军统计门禁，因此属于**可靠性验收通过**，
不是竞技提升验收通过。

### 假设-实验对齐（演示运行 `ai11-hyp-verdicts`）

P1.4 的"已测假设/正模块"检索需要把每轮假设与深验证据对齐。新增 `pair-verdict-rule-v1`
（pairs<8 或 delta=0 → inconclusive；delta>0 支持机制假设 A、否定无效探索 B，delta<0 反之），
并用 2 轮 / 3 候选 / 32 深验种子（32 对）真实运行验证：

| 假设 | 含义 | 32 对深验 delta | 结论 |
|---|---|---|---|
| H1A / H1B | 第 1 轮机制改善 / 无效探索 | 0 | inconclusive |
| H2A | 第 2 轮机制改善 | +0.0625 | supported |
| H2B | 第 2 轮仅行为改变 | +0.0625 | rejected |

结论已写入 `research-memory.jsonl`（`experiment` + `hypothesis-update`）与
`research-index.jsonl`（`century-research-experiment-v1`），下一轮简报会列出已测状态。
**披露**：6h 运行的 116 条假设在运行当时未回写状态（该逻辑随后加入），本报告不追溯改写
原始记忆；6h 的"0 tested"与演示运行的"4 tested"是两段真实事实。

## C. 竞技能力

### 对照实验（真实 campaign，非模拟）

| 实验 | 组 | 候选 | 对局 | 继承候选 | 深验配对增量均值 | 正向信号 | Token |
|---|---|---|---|---|---|---|---|
| A 跨代继承 | A0 旧路径 | 9 | 96 | 0 | +0.083 | 1/3 | 0 |
| A 跨代继承 | A1 真实继承 | 8 | 88 | 3（1 个父代、深度 2） | 0 | 0/3 | 0 |
| B 失败反馈 | B0 仅分数 | 4 | 48 | 1（回退 pair） | −0.375 | 0/2 | 43,342 |
| B 失败反馈 | B1 artifacts | 4 | 48 | 1（回退 pair） | 0 | 0/2 | 0 |
| B 失败反馈 | B2 简报+假设 | 4 | 48 | 1（回退 pair） | +0.25 | 1/2 | 0 |
| C 研究效率 | C0 旧直接变异 | 12 | 112 | 0 | 0 | 0/2 | 0 |
| C 研究效率 | C1 科研闭环 | 12 | 112 | 5（深度 2） | −0.125 | 1/2 | 51,228 |
| C 研究效率 | C2 闭环 + 级联预算 8/8 | 12 | 112 | 5（深度 2） | 0 | 1/2 | 77,297 |
| A2 完整 checkpoint 恢复 | 停止→resume | 4 | 64 | 1（深度 2） | −0.25（2 个深验） | 0/2 | 0 |

A2（完整 checkpoint 恢复）实测 7/7 检查 PASS（`training/reports/ai11-a2-checkpoint-drill.json`），
2 轮 / 4 候选 / 64 局 / 0.08h，并在 6h 运行中以真实卡死恢复再次验证（kill → resume → 继续 26 轮）。

实验 C（`C-c11e`，2 LLM 候选/臂）：C0 7.2min；C1 19.3min / 51,228 token；C2 13.5min / 77,297 token。
C2 相对 C1 墙钟 −30%，但 token +51%（仅 2 次调用，token 差异在噪声内）；两臂正向信号均 1/2
（CI 0.09–0.91）。**效率差异 inconclusive**，不能声称 C2 更优。原始 `results.json` /
`research-index.jsonl` 保存在本机 `training/reports/coevolution/ai11-exp-C-*-c11e/`
（仓库既有 `.gitignore` 不入库）；入库的是汇总报告、summary、候选哈希/指标与区间估计。

### 6 小时运行的分人数配对第一名率（描述性，非单一假设检验）

| 人数 | 配对单位 | 平均增量 | 说明 |
|---|---|---|---|
| 2 | 58 | −0.1034 | 58 个候选各 1 对，单位不独立，仅描述 |
| 3 | 58 | −0.0172 | 同上 |
| 4 | 58 | −0.0690 | 同上 |
| 5 | 58 | 0.0000 | 同上 |

深验总览：58 个深验候选中 6 个正向、15 个负向、37 个为 0；均值 −0.047。

### 模块级观测边际效应（P1.3 最小失败改动定位）

`training/scripts/ai11-module-effects.mjs` 以 (round, parentId) 分层（层内候选共享该轮
screen 种子），对每个种子计算"改动含模块 M / 不含 M"的 candidateFirst 均值差，再跨层
等权汇总 + 10,000 次 bootstrap 95% 区间（报告 `training/reports/ai11-module-effects.json`）：

| 模块 | 层数 | 观测效应 | 95% 区间 | 方向 |
|---|---|---|---|---|
| M08 | 11 | −0.155 | [−0.258, −0.064] | negative-association |
| M10 | 11 | +0.099 | [0.030, 0.174] | positive-association |
| 其余 10 个模块 | 8–25 | −0.051…+0.119 | 均跨 0 | inconclusive |

口径：观测性关联，不是因果；层内生成算子仍可能不同，单步动作反事实回放未实现，
不得据此自动淘汰模块，只能作为下一轮简报的最小改动线索。

### 独立新种子复现（P1.3）

对 6h 深验中负增量最深的两个候选，各分配一个**从未使用**的 AI9 开发深验窗口
（8 种子/人数 × 4 人数 = 32 对 / 64 局），用同一预注册阈值重新判定：

| 候选 | 原深验（4 对） | 新窗口 | 2p | 3p | 4p | 5p | supported |
|---|---|---|---|---|---|---|---|
| `cand-ai9-crossover-r30c4-031feb` | −0.50 | `ai9-deep-w499` (base 1670499000) | weakened (1/1) | weakened (2/1) | rejected (0/2) | weakened (2/1) | false |
| `cand-ai9-pair-r1c2-cc83ce` | −0.25 | `ai9-deep-w500` (base 1670500000) | weakened (1/0) | rejected (0/2) | weakened (2/1) | weakened (1/1) | false |

括号内为「冠军赢翻转 / 候选赢翻转」。结论：两个原负增量候选中，**没有一个弱点能被
独立新种子复现**；原 −0.25/−0.5 更可能是 4 对样本噪声。复现结论已写入
`research-index.jsonl`（`stage=replication`）与 `research-memory.jsonl`（`replication:*`），
供下一代研究检索；未消耗正式验证种子。


### 结论

- **结构层**：真实父代继承、LLM 参与、谱系链（深度 5）、失败归因、研究简报注入均已被真实运行证据证明。
- **竞技层**：**未证明**。本轮无候选满足正式挑战资格（深验每层仅 1 对 < 16 对阈值），
  且分人数增量均为负/零；不得声称竞技提升。
- 按任务书规则，**可靠性验收通过 ≠ 竞技提升验收通过**。

## D. 研发效率

| 指标 | 数值 |
|---|---|
| 6h 运行 token | 624,013（14 次 LLM 调用） |
| token / LLM 候选 | ≈ 44,600 |
| 有效评估量 | 3,256 局（58 轮） |
| 正向深验信号 | 6（均值 −0.047） |
| 每正向信号游戏成本 | ≈ 543 局 |
| 每正向信号 token 成本 | ≈ 104,000 |
| 实验 B0 | 43,342 token → 2 个真实候选 → 0 正向 |
| 实验 A | A0/A1 各 96/88 局，结构差异明确、竞技差异不可判定 |
| 实验 C | C0/C1/C2 各 112 局、12 候选；C1/C2 各 2 个 LLM 候选（51.2k / 77.3k token），正向均 1/2 |

效率结论：
- 主要瓶颈不是 token 而是**有效变异**：14/14 的 LLM 输出改变了源码，但只有 6/58 深验为正；
- crossover/ablation 占 231/348（编排器长期停留 `ablate`），探索多样性不足；
- 每正向信号的游戏成本约 543 局，说明"少样本深验"的噪声远大于信号，需要更大的深验预算或多保真筛选。

## E. GitHub 交付

- 分支：`feat/ai11-research-system`（主体）、`feat/ai11-module-effects`（P1.3 模块效应）、
  `feat/ai11-evidence-context`（P0.2 证据字段加固）、`feat/ai11-replication-diagnosis`（P1.3 独立复现）、
  `fix/ai11-brief-memory-failures`（失败记忆进入提示）、`feat/ai11-experiment-c2`（实验 C2）、
  `feat/ai11-hypothesis-verdicts`（假设-实验回写）
- PR：#75（主体）、#78（模块级观测效应）、#79（证据字段加固）、
  #81（独立新种子复现）、#84（历史失败进入提示通道）、#86（实验 C2）、
  #88（假设-实验回写）——均已 squash 合并；#76/#77/#80/#82/#83/#85/#87 为文档回填
- 提交顺序：基线审计 → P0/P1/P2 主体 → 缺陷修复（crossover 谱系、无变化候选、
  statusPath 脏标记、消融判定）→ 实验与故障注入证据 → 6h 运行证据 → 复现、证据字段、提示闭环、C2、假设回写
- CI：每个代码 PR 最终提交 **success（0 failure，deploy/promotion/pages 按预期 skipped）**
- 最终**代码与证据** `main` SHA：**`bbdf387`**（#88 squash 合并；AI11 主体代码合并为 `a3310a6`，
  其后 #76–#88 只新增研究证据/报告、索引字段、提示渲染、实验臂与假设回写，不改变决策代码路径）。
  仅文档的后续提交会使 `main` SHA 继续前进，但代码身份不变。
- 回滚方案：本 PR 只新增研究/监督/证据模块与开关，不修改冠军、规则引擎与正式评估器；
  回滚 = revert 合并提交并重新部署上一构建（`scripts/ci/rollback-champion.mjs` 已有演练）

## F. 后续研究方向（依据本轮真实证据）

1. **提升 LLM 有效变异率**：实验 B0 用 43,342 token 产出 2 个真实候选（0 正向）；
   试运行中 14 次 LLM 调用全部产生源码变化，但配对增量多为 0 或负。
   下一步应把"行为改变"判据从"源码文本变化"升级为"行为探针差异 + 焦点层动作分布变化"，
   并在简报中给出具体失败局面与最小改动锚点。
2. **精英更新与停滞**：配对 delta=0 时精英不更新，谱系深度停在 5，后续轮次反复基于同一父代；
   需要 tie-break 规则（行为距离/较低方差/新种子复现）与"非劣即可更新"。
3. **Orchestrator 停滞策略过于单一**：连续 `ablate` 让 150 个候选里 70 个 crossover、
   28 个 ablation。应加轮换与预算上限（每 N 轮至少一次 explore/openevolve），
   并把"delta≈0"判为 inconclusive 而非停滞。
4. **深验样本预算**：4 种子 × 4 人数 = 每层 1 个配对单位，失败归因与挑战资格都无法成立。
   建议 deepSeeds ≥ 16（每层 4 对）并按评估成本校准；正式挑战 MDE 20pp 需 313 种子/人，
   若要检测 10pp 需约 2000 局/挑战（≈6h），应接入已模拟验证的 interim look。
5. **长跑稳定性**：试运行在 R37 出现长时间高 CPU 无明显推进（疑似大对象/单候选慢评估）；
   应把候选评估放入独立子进程并限制单候选最大墙钟，避免污染主进程堆。
6. **跨代谱系再深一层**：当前深度 5 来自同一父代重复；真正的 3 代累积（A→B→C）
   需要第 2 条（精英更新）先落地。
