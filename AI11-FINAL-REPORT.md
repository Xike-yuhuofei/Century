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
| 6 小时无人值守验收 | 进行中 | 见 B 节运行结果与 `ai11-endurance-audit.mjs` |

### P3 高级优化

| 项 | 状态 | 说明 |
|---|---|---|
| 多保真评价 | 保留既有级联 | OpenEvolve stage1→2→3 级联仍在；本轮未新增 Successive Halving/Hyperband（缺少成本校准证据） |
| 参数与代码分离 | 接口已存在 | `jointParameterMutation` + PARAMETER_BOUNDS；未接 CMA-ES/BO（缺乏实证收益） |
| 跨方向选择 | 数据积累中 | mutation operator 效果已可统计（research index），未启用 contextual bandit |
| 结构级创新 | 已有 M10/M11 等结构候选 | 未新增神经价值网络/MCTS 重构 |

**P3 结论**：按任务书"根据实证收益逐项启用"的要求，本轮不强行集成高级优化器；保留接口与数据积累路径。

## B. 系统运行能力

（见下方 6 小时运行结果）

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

### 结论（必须按不确定性报告）

- **实验 A（结构层）**：A1 证明真实父代继承生效（3/3 继承候选均产生源码变化；
  未修改模块与父代逐字节一致；父代缺失/篡改被拒绝）。
  但 **竞技层 inconclusive**：A0/A1 深验增量均值分别为 +0.083 与 0，
  样本各 3 个深验候选、每人数层仅 1 个配对单位，区间极宽，不能判定新版更强。
- **实验 B（inconclusive）**：B0 用 43,342 token 产出 2 个真实 LLM 候选（深验均值 −0.375）；
  B1/B2 的 LLM 输出在 2 轮中均被判为"原样返回"而拒绝，实际比较对象退化为回退候选。
  研究上下文对 LLM 输出的影响在本样本量下不可判定；不得据此宣称新通道有效或无效。
- **实验 C（inconclusive）**：C0 与 C1 均为 2 个深验候选、1/2 与 0/2 正向信号，
  差异处于噪声范围；C1 的 LLM 候选同样因"无变化"被拒绝。

### 正式竞技结论

- 本轮**没有任何候选通过正式挑战统计门禁**（6h 运行仍使用 `--no-auto-challenge`，
  未消耗正式验证种子与 alpha）。
- 因此 **竞技收益未证明**；只能报告"可靠性/功能"层结论。

## D. 研发效率

- 实验 B0：43,342 token → 2 个真实 LLM 候选（21,671 token/候选），0 个正向深验信号；
- 实验 B1/B2：0 token（LLM 输出未产生真实改动即被拒绝，未进入评估）；
- 6h 运行：真实 LLM 调用次数、token 与每正向信号的游戏成本见 B 节；
- **结论**：当前 LLM 产出效率的主要瓶颈不是 token，而是"原样返回/无行为改变"，
  需要在下一阶段用更强的行为改变约束与研究简报提升有效变异率（见 F 节）。

## E. GitHub 交付

- 分支：`feat/ai11-research-system`
- PR：#75
- CI：全绿（deploy/promotion 相关 job 对非发布 PR 按预期 skipped）
- 回滚方案：PR 只新增模块与开关，不修改冠军与正式规则；回滚 = revert 合并提交并重新部署上一构建

## F. 后续研究方向

（依据真实证据填写）
