# AI 11.0 基线审计报告（Century × OpenEvolve 自主研究系统）

审计时间：2026-10-29（Asia/Shanghai）
审计设备：Mac mini M4 / 10 核 / 16 GB 统一内存 / macOS
审计对象：`origin/main` @ `52b1601`（Merge PR #74 `run/ai9-36h`）

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| main SHA | `52b1601`（PR #74 合并后） |
| OpenEvolve 版本 | `0.4.0`（`ai5/openevolve/.venv`，Python 3.13.2） |
| 基线测试 | `training/evolution/tests/*` 109/109 PASS（新 worktree 需先 `npm run build` 生成 `web-v1/dist`） |
| LLM 通道 | `codex login status` = `Logged in using ChatGPT`（真实可用） |
| 真实吞吐 | 36h campaign 实测约 **5.5 局/分钟**（12,960 局 / 39.24h） |
| 核心闭环 | **不成立**：跨代源码继承、研究上下文注入、配对第一名率筛选均缺失或形同虚设 |
| 统计门禁 | **死锁**：几何 alpha 已耗尽（剩余 2.44e-5），第 12 次挑战功效恒为 0.599 < 0.8，永远 BLOCKED |

## 1. 审计范围与实测证据

### 1.1 代码与运行产物

审计覆盖：
`training/evolution/{openevolve-multi-bridge,multi-module-generator,module-mutations,campaign-controller,selection,promotion-handler,dev-evaluator,compiled-game-evaluator}.mjs`、
`ai5/openevolve/{config-ai9.yaml,century_evaluator_ai9.py,run_openevolve.py}`、
`training/evaluator/{first-place,power}.mjs`、`training/lib/alpha-ledger.mjs`、
`training/governance/{alpha-ledger.json,seed-consumption-registry.json}`，
以及 `training/reports/coevolution/ai9-36h-endurance-2/`（PR #74 归档的 36 小时训练）。

36h 运行实测：91 轮、637 候选、12,960 局、180 次深验，状态 `budget-exhausted`；
期间发出 90 次正式挑战请求，**全部 `BLOCKED: insufficient-statistical-power`**。

### 1.2 PR #74 / 36h 训练审计要点

- 真实 LLM 参与确实发生：每轮 1 次 `openevolve` 策略尝试，91 轮累计 91 次真实 OpenEvolve 运行。
- 但候选生成的**代数谱系是断裂的**（详见 §2.1），LLM 每次看到的是官方函数文本。
- 深验证据文件含 `firstPlaceDelta`（如 `+0.25`，下界 `−0.224`），但**控制器未把它写入候选状态，选择器也未使用它**（详见 §2.3）。
- 90 次挑战请求中包含 `control`（官方基线）候选，说明"是否进入挑战队列"与竞技增益无关。

### 1.3 已完成（真实实现，不可重复建设）

- 12 个决策模块的可进化注册表、依赖闭包、静态检查、隔离组装、独立 `tsc`、macOS Seatbelt 执行；
- 编译型多模块候选 artifact（内容寻址、哈希封印、可复现校验）；
- **配对 A/B 第一名率评估**（`compiled-game-evaluator.mjs`：同种子/同对手/同焦点席位，A=候选、B=冻结冠军）；
- 形式化统计判定（`first-place.mjs`：簇级 t 区间、非劣效、IUT、跨人数独立种子块）；
- alpha 追加账本、种子治理账本、故障注入 9 项、回滚演练、隔离晋级全链路演练；
- 卡死监督（45 分钟无状态推进即终止并 resume）、campaign 锁、checkpoint 快照与 resume 校验；
- CI 唯一入口 `ci.yml`（变更分类、分片、ui-smoke、promotion-machine-gate、deploy-verify）。

## 2. 关键缺口（逐项核实，均以源码/产物为证）

### 2.1 P0.1 跨代源码继承 —— 实际不存在（严重）

证据：

1. `multi-module-generator.mjs` 的 `single/pair/multi` 策略全部调用
   `mutateModuleFunction(id, variant)`，而该函数内部是 `mutation.apply(officialFunctionText(module))`
   —— **基线恒为官方实现**，父代源码只用于依赖闭包（`expandDependencies(texts, {...parentTexts})`）。
2. OpenEvolve 路径 `materializeMultiModuleProgram(moduleIds)` → `composeProgram(moduleIds)`
   同样组合**官方**模块文本；`parentArtifact` 只作为 `parentId` 元数据传给
   `createCandidateFromOpenEvolveMulti`。
3. 仅 `crossover`/`ablation` 读取精英候选源码。
4. `campaign-controller._parentArtifact()` 默认返回 `null`（`continueFromSelected` 默认 false），
   且父候选不可用时 `catch` 静默回落到基线，不记录、不拒绝。

后果：所谓"第 N 代"与官方源码的编辑距离并不累积；无法回答"这一代在上一代基础上改了什么"。

### 2.2 OpenEvolve 原生能力使用 —— 部分声明、实际未接线

- `config-ai9.yaml` 声明 `population_size: 16` / `num_islands: 3` / `diff_based_evolution: true`，
  但 `runMultiModuleOpenEvolve()` 只传 `--config/--iterations/--output`，
  **从不传 `--checkpoint`**（上游 `openevolve-run` 支持该参数），跨轮次/跨进程无原生种群恢复；
- 每次调用都是全新 run（新 `results/<timestamp>` 目录），Program Database 不跨 round 延续；
- 因此"保留原生 MAP-Elites/岛屿/Program Database"目前只在**单次 run 内部**成立。

### 2.3 P0.2 研究上下文与证据 —— 未进入 LLM 上下文

- `config-ai9.yaml` 的 `system_message` 是固定通用文本，不含具体问题、失败局面、历史修改与结果、
  竞争性假设或可证伪预测；
- `century_evaluator_ai9.py` 的 `evaluate()` **不返回 `artifacts`**，
  上游 `openevolve.prompt.sampler` 的 `program_artifacts` 通道（真实存在于 0.4.0 源码）未被使用；
- 无跨进程研究记忆：每轮只读 `training/reports/diagnostics-latest/analysis.json`，
  且 36h 运行的生成拒绝原因只有 26 条"ablation 无可移除模块"，无任何结构化研究假设。

### 2.4 P0.3 筛选与配对第一名率 —— 不一致（严重）

- `selection.mjs::scoreCandidate()` 对 game 候选使用 `chanceAdjustedRate` 与 `minWilsonLower`，
  **完全忽略配对 `firstPlaceDelta`**；
- `campaign-controller._deepNext()` 写入 `item.deep.metrics` 时只保留
  `{firstPlaceDelta?, chanceAdjustedRate, minWilsonLower, anomalyRate, finishedGames}`
  —— 实测 36h 的 180 个深验候选中 `firstPlaceDelta` **全部缺失**（`metrics` 里根本没有该键）；
- `_approval()` 按 `composite` 排序取第一名，`verdict` 由 `chanceAdjustedRate > 0.05` 判定，
  与"配对第一名率增量"无关；
- 研究保留资格与正式挑战资格没有区分：任何深验通过的候选（含 `control`）都会排队。

### 2.5 P0.4 统计功效死锁 —— 确认且数学上不可解

- 账本：`alphaBudget=0.05`，几何消耗 11 次，已用 `0.0499756`，剩余 `2.44e-5`；
- 第 12 次 `α = 1.22e-5`（z≈4.38）；
- `promotion-handler` 默认策略 `seedsPerSeat=500, effect=0.2, variance=1` →
  `power = 0.599 < 0.8` → **永远 `insufficient-statistical-power`**；
- 达到 80% 功效需 `requiredSeeds = 641`/人数；按实测 5.5 局/分钟，
  4 人数 × 2 臂 × 641 = 5,128 局 ≈ **15.5 小时**，且仍需 α=1.22e-5 的极端证据；
- 36h 运行发出 90 次请求，全部阻塞于此——"无人值守进化"在统计层是空转。

### 2.6 P2 无人值守 —— 部分实现

已有：campaign 锁、state.json 原子写 + 30 个滚动 checkpoint、`resume` 指纹校验、
45 分钟卡死监督（`run-36h-stress.sh`）、退出码语义、资源快照。

缺口：
- **无持久任务队列/状态机**（`PENDING→CLAIMED→RUNNING→COMMITTING→DONE`），
  失败重试与结果提交不在同一事务语义内；
- 无幂等提交键，进程崩溃后可能重复提交实验结果；
- 正式验证种子的"执行前持久预留"依赖外部预注册流程，**campaign 侧无预留账本**；
- 无 API 熔断/模型故障切换的统一治理（仅 OpenEvolve 层"额度不足→确定性降级"，且不记录回退原因到候选）；
- LaunchAgent 因外置卷 `getcwd EPERM` 不可用（历史已证实），当前靠 `screen + caffeinate`；
- 无 6 小时验收器；R09 审计器只认 12h JSON 产物。

### 2.7 P3 —— 仅有分级评估原型

- `century_evaluator_ai9.py` 有 stage1/2/3 级联，但阈值写死（`[0.5, 0.45]`），
  未按实际成本校准，亦无 Successive Halving/Hyperband；
- 无 mutation operator 效果统计，无跨方向选择（bandit）的数据基础；
- 参数与代码联合变异已有雏形（`jointParameterMutation`），但与 CMA-ES/BO 无接口。

## 3. 结论与开发优先级

开发必须从"真实继承 + 证据契约 + 配对筛选 + 统计治理"开始（P0），
否则后续所有研究结论都建立在无谱系、无配对、无研究上下文的信号之上。

本报告作为后续变更的基线；每一阶段的验收证据必须可追溯到本报告的缺口编号。
