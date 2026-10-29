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
| P0.2 统一证据契约 | 完成 | `research-index.mjs`（candidate/lineage/evaluation/failureCase/formalChallenge）；LLM token 从 OpenEvolve 日志聚合，未知写 null |
| P0.3 配对第一名率筛选 | 完成 | 深验指标保留 `firstPlaceDelta`/CI；selector 主键改为配对增量下界；研究保留 vs 正式挑战资格分离（≥10pp、≥16 对、非对照基线） |
| P0.4 统计功效死锁 | 完成 | `statistical-plan-ai11.json`：K=12、α=1/240、方差 1.0、MDE 20pp、313 种子/人数、功效 0.80、H0 FWER 模拟 0.003；旧几何账本只读保留；`--check` 通过 |

### P1 科研闭环

| 项 | 状态 | 证据 |
|---|---|---|
| Research Orchestrator | 完成 | `research-orchestrator.mjs`：bootstrap / exploit-weakness / replicate / ablate / switch-direction |
| ResearchBrief 进入 LLM | 完成 | 每轮生成 `openevolve-configs/rNNN.yaml`（system_message 注入）+ `.brief.json`（evaluator artifacts 通道）；contextHash 可核验 |
| Failure Diagnosis | 完成 | `failure-diagnosis.mjs` 按人数分层比较 A/B 动作分布与胜负翻转；状态 supported/weakened/rejected/inconclusive |
| Research Memory | 完成 | `research-memory.mjs` JSONL 跨进程；否定假设保留；检索已测假设/正向模块/失败 |

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
| 研究假设 | 116 条；失败归因文件 57 份 |
| 预算 | wallUsed 19.26M / 21.6M ms；候选 348/4000；对局 3256/400000 |
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

## C. 竞技能力

### 对照实验（真实 campaign，非模拟）

| 实验 | 组 | 候选 | 对局 | 继承候选 | 深验配对增量均值 | 正向信号 | Token |
|---|---|---|---|---|---|---|---|
| A 跨代继承 | A0 旧路径 | 9 | 96 | 0 | +0.083 | 1/3 | 0 |
| A 跨代继承 | A1 真实继承 | 8 | 88 | 3（1 个父代、深度 2） | 0 | 0/3 | 0 |
| B 失败反馈 | B0 仅分数 | 4 | 48 | 1（回退 pair） | −0.375 | 0/2 | 43,342 |
| B 失败反馈 | B1 artifacts | 4 | 48 | 1（回退 pair） | 0 | 0/2 | 0 |
| B 失败反馈 | B2 简报+假设 | 4 | 48 | 1（回退 pair） | +0.25 | 1/2 | 0 |
| C 研究效率 | C0 旧直接变异 | 6 | 64 | 0 | +0.125 | 1/2 | 0 |
| C 研究效率 | C1 科研闭环 | 6 | 64 | 2（回退 pair） | 0 | 0/2 | 0 |
| A2 checkpoint 恢复 | 停止→resume | 4 | 32 | 1 | 完成 2 轮 | 指纹/摘要一致、证据未覆盖、种子窗口 4/4 唯一 | 0 |

A2（完整 checkpoint 恢复）实测 7/7 检查 PASS（`training/reports/ai11-a2-checkpoint-drill.json`），
并在 6h 运行中以真实卡死恢复再次验证（kill → resume → 继续 26 轮）。

### 6 小时运行的分人数配对第一名率（描述性，非单一假设检验）

| 人数 | 配对单位 | 平均增量 | 说明 |
|---|---|---|---|
| 2 | 58 | −0.1034 | 58 个候选各 1 对，单位不独立，仅描述 |
| 3 | 58 | −0.0172 | 同上 |
| 4 | 58 | −0.0690 | 同上 |
| 5 | 58 | 0.0000 | 同上 |

深验总览：58 个深验候选中 6 个正向、15 个负向、37 个为 0；均值 −0.047。

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
| 实验 C | C0/C1 各 64 局，差异处于噪声范围 |

效率结论：
- 主要瓶颈不是 token 而是**有效变异**：14/14 的 LLM 输出改变了源码，但只有 6/58 深验为正；
- crossover/ablation 占 231/348（编排器长期停留 `ablate`），探索多样性不足；
- 每正向信号的游戏成本约 543 局，说明"少样本深验"的噪声远大于信号，需要更大的深验预算或多保真筛选。

## E. GitHub 交付

- 分支：`feat/ai11-research-system`
- PR：#75（https://github.com/Xike-yuhuofei/Century/pull/75）
- 提交顺序：基线审计 → P0/P1/P2 主体 → 缺陷修复（crossover 谱系、无变化候选、
  statusPath 脏标记、消融判定）→ 实验与故障注入证据 → 6h 运行证据
- CI：最新提交 28 个 job success、6 个 skipped（deploy/promotion/pages 仅在发布时运行）
- 最终 `main` SHA：合并后回填
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
