# Century AI 9.0｜OpenEvolve 全决策系统自主协同进化工程 · 最终验收报告

生成时间：2026-10-26（Asia/Shanghai）
开发分支：`feat/ai9-coevolution`
基线 main：`19d4b40c2f633c7b8ff8b5484941a0ee125a7bd1`
基线冠军：`joint-js5`（未变更）
开发 worktree：`/Volumes/Extreme SSD/Projects/Century-ai9`

> **状态声明（必须先读）**
>
> - 三阶段工程能力已实现并真实运行；但**没有任何候选通过第一名率正式挑战**，冠军未变，也没有宣称的竞技提升。
> - 机器门禁路径已真实执行：`ai9-live-coevolve-2` 中 2 个候选进入 `queued-machine-gate`，
>   均被 `promotion-handler` 以 `insufficient-statistical-power` **正确拒绝**（未消费验证池/alpha）。
> - `R09`（12 小时连续运行）在本会话内为 **NOT_RUN**；`R12`（真实冠军晋级/自动发布）为 **BLOCKED**，
>   原因是统计预算/功效不足且没有合格候选，不是 PASS。
> - 本报告把“接口存在”“单元测试通过”“模拟实验成功”与“真实多模块进化已完成”严格区分。
> - 唯一竞技指标仍是 2–5 人焦点席位配对第一名率增量；平均分、搜索速度、代理评分均只作诊断。

---

## 1. 基线审计结论

| 项目 | 事实 |
|---|---|
| 基线 main SHA | `19d4b40c2f633c7b8ff8b5484941a0ee125a7bd1` |
| 当前冠军 | `joint-js5`（`training/champions/champion.json`） |
| 冠军决策核心 | `champion-guided` / `joint-js5` / `budgetMs=100` / `acquisitionVariant=readiness-efficiency` |
| AI8 遗留能力 | Campaign Controller、真实种子治理、第一名率评估器、预注册、alpha 账本、机器门禁、回滚演练均已存在并被复用 |
| 审计发现的真实断点 | ①OpenEvolve 只进化 `acquisitionValue` 单函数；②其余“5 模块”只是声明式代理插件，未接生产决策；③Candidate Artifact 只覆盖单个函数/描述符；④Campaign Controller 只管理单目标候选；⑤12 模块体系不存在 |
| 修复方式 | 不推倒 AI8；在其上扩展多模块注册表/多文件候选/12 模块接线/协同进化控制器，全部复用既有评估、种子、预注册、alpha 与机器门禁 |

**基线行为回归**：新增模块钩子缺省全部返回中性值；同种子同参数下，旧构建与新构建在 2–5 人共 8 局、1,018 次决策中 action 完全一致（0 mismatch）。该回归在接入 M11/M12 与预算硬上限后仍成立（见 `training/reports/ai9/baseline-behavior-regression.json`，本会话生成）。

---

## 2. 阶段一：多函数真实进化

### 2.1 五个基础策略函数（全部真实可进化）

| 模块 | 函数/文件 | 真实调用路径 | 编译 | 行为探针 | 真实对局 |
|---|---|---|---|---|---|
| M01 魔像目标选择 | `goalPriority` / `ai/evolve/modules.ts` | `chooseAIAction/chooseJointAction → choosePlan` | PASS | PASS（63/70 fixture 变化） | PASS（interaction/campaign） |
| M02 商人卡获取 | `acquisitionValue` / `ai/evaluator.ts` | `choosePlan → searchGrade/prospectiveFormula` | PASS | PASS（84/84） | PASS（campaign/ interaction/OpenEvolve） |
| M03 生产引擎评估 | `cardEngineValue` / `ai/knowledge.ts` | `choosePlan → engineValueFor → engineValue` | PASS | PASS（14/14） | PASS（12 模块真实对局候选） |
| M04 水晶保留价值 | `keepValue` / `ai/evaluator.ts` | `trimStock/payments` | PASS | PASS（9/14） | PASS（12 模块真实对局候选） |
| M05 休息回收价值 | `restMultiplier` / `ai/evolve/modules.ts` | `choosePlan → searchGrade` | PASS | PASS（14/28） | PASS（campaign/ interaction） |

证据：
- 全 12 模块联合编译候选：`training/reports/ai9/all-modules-candidate.json`；
- 逐模块探针：`training/reports/ai9/all-modules-probe.json`（`changedModules` = M01–M12，`probeErrors=0`）；
- 五模块确定性变异候选与真实对局：`training/reports/coevolution/ai9-smoke-003/`；
- 决策级接线测试：`training/evolution/tests/module-wiring.test.mjs`（中性候选与官方逐局一致；变异候选在 40 步内产生真实 action 分歧）。

### 2.2 多模块候选契约

`training/evolution/module-registry.json` 是唯一权威身份表：

- 12 个模块 ID、函数名、目标文件、参数签名、依赖、最大源码长度、回退策略、真实决策路径；
- 一个候选可包含多个模块、可修改多个文件（M02/M04 同文件、M01/M05–M12 同文件、M03 独立文件）；
- `Candidate Artifact` 新增 `source.modules`；`sourceHash` 覆盖全部模块函数文本身份；`identityDigest` 额外覆盖模块元数据；`buildArtifact` 封印完整 ESM 决策包（49 个文件）；
- 任一模块源码被篡改 → `validateArtifact` 立即失败（测试覆盖）。

### 2.3 真实对局接线与隔离

- 编译候选以**独立 ESM 决策包**注入焦点席位；冻结冠军/对手始终使用官方 dist，同进程内两个模块实例不共享状态；
- 中性编译候选与冻结冠军同种子配对：`candidateFirst == championFirst`（正式挑战执行器测试、开发池 2–5 人对局均成立）；
- `training/reports/coevolution/ai9-smoke-003/state.json`：3 个真实候选、40 局真实对局、策略字段、模块列表、深验与精英归档完整；
- `training/reports/ai9/interaction-experiment.json`：同种子下 control/single/pair/multi/ablation 的真实 2–5 人对局。

### 2.4 阶段一验收

| 验收项 | 状态 | 证据 |
|---|---|---|
| 五类模块具备真实可执行候选 | PASS | 全模块候选 + 探针 |
| 多模块联合编译 | PASS | `all-modules-build.json`（12 模块、49 文件、333KB） |
| 候选与冠军完全隔离 | PASS | 中性候选逐局一致 + 独立 dist 注入测试 |
| 公开信息/恶意代码测试 | PASS | 多模块静态检查、Seatbelt、恶意样例 |
| 2–5 人真实对局 | PASS | campaign / interaction / OpenEvolve stage2 |
| 至少一个双模块联合变异实验 | PASS | `pair-M02+M11` 候选真实对局（interaction） |
| 各模块独立回归证据 | PASS | 12 模块探针 + 接线测试 |

---

## 3. 阶段二：12 个核心模块全面进化

### 3.1 模块矩阵

完整机读矩阵：`training/reports/ai9/module-matrix.json`（逐模块：编译/探针/真实对局/OpenEvolve/确定性变异/状态）。

| ID | 模块 | 进化空间（实现） | 编译+探针 | 真实决策 | 真实对局证据 |
|---|---|---|---|---|---|
| M01 | 目标选择 | 目标优先级乘子（公式/条件） | PASS | PASS | campaign/interaction |
| M02 | 商人卡获取 | 全函数重写（含变体分派） | PASS | PASS | campaign/interaction/OpenEvolve |
| M03 | 生产引擎评估 | 单卡引擎价值公式 | PASS | PASS | 12 模块联合候选真实对局 |
| M04 | 水晶资源管理 | 保留价值/弃置/支付选择 | PASS | PASS | 12 模块联合候选真实对局 |
| M05 | 打出与休息调度 | 休息惩罚/回收节奏 | PASS | PASS | campaign/interaction |
| M06 | 终局与胜率 | 终局路线增量/长路线 | PASS | PASS | 12 模块联合候选真实对局 |
| M07 | 对手行为预测 | mean/peak 压力增量 | PASS | PASS | 12 模块联合候选真实对局 |
| M08 | 多人竞争与时序 | 目标存活/竞争乘子 | PASS | PASS | 12 模块联合候选真实对局 |
| M09 | 未知牌概率 | 未翻开卡池支持度 | PASS | PASS | 12 模块联合候选真实对局 |
| M10 | 行动候选生成 | 根行动重排/剪枝（仅合法子集） | PASS | PASS | 12 模块联合候选真实对局 |
| M11 | 多人联合搜索 | 门控/候选上限/覆盖边际/结构等白名单选项 | PASS | PASS | pair-M02+M11 真实对局 |
| M12 | 自适应预算 | 0–1000ms 决策预算（0 表示筛选即耗尽→冠军回退；固定 workUnits 时不生效） | PASS | PASS | 12 模块联合候选真实对局 |

> 说明：M03/M04/M06–M10/M12 的“真实对局证据”指其作为 12 模块联合候选的一部分，在真实 2–5 人对局中控制候选席位；逐函数行为变化由探针（数值分歧）证明。没有把“注册成功”当作“已在真实局面产生差异”。

机读矩阵由 `training/scripts/ai9-module-matrix.mjs` 从真实证据文件生成（不手填）：
`training/reports/ai9/module-matrix.json`。当前汇总：

- `total=12`，`compiledAndProbeChanged=12`，`executedInRealGames=12`，
  `decisionDivergenceObserved=7`，`withRealGameEvidence=12`，`withOpenEvolveEvidence=3`；
- `statuses.PASS=12`；
- 证据来源：`all-modules-probe/build`、`ai9-smoke-002/003`、`interaction-experiment`、
  `all-modules-game`、`openevolve-combined-game`、`ai9-r001/r002/r003`。

**逐模块“真实执行”证据（不是仅注册）**：

1. `training/reports/ai9/module-execution-audit.json`：把官方 dist 复制到临时目录，仅在副本的
   12 个钩子入口插入计数器（官方源码/构建/候选产物未改），运行 2–5 人真实对局
   （4 局 AI 决策 535 次 + 4 局焦点席位联合决策 517 次）。结果：**12/12 模块均被调用**
   （`neverCalled=[]`）。示例计数：M06 681、M10 1147、M11 1052、M12 1052、
   M01 5200、M09 5200；M02/M03/M04 为逐卡/逐评估器高频调用。
2. `training/reports/ai9/module-wiring-audit.json`：对每个模块单独编译确定性变异候选，
   在真实规则引擎中与官方实现锁步对比（2–5 人、3 个种子、最多 200/120 步）。
   结果：**7/12 在样本内产生真实行动分歧**（M01/M02/M03/M08/M09/M11/M12）；
   M04/M05/M06/M07/M10 在本样本内未翻转行动，但执行审计证明它们确实被调用，
   且探针证明其输出随变异变化。两类证据严格区分，不把“执行过”冒充“改变了棋力”。

### 3.2 结构级候选（M10/M11/M12）

- M10 返回重排/剪枝后的**合法行动子集**；调用方对未知动作、空结果、重复键一律回退原序（不允许制造非法行动）。
- M11 只能返回白名单内的联合搜索选项（gateMode/candidateCap/overrideMargin/contestThreshold/allocation/endgameMode/worlds/…），数值与枚举均被裁剪；调用方显式传入的选项优先于模块。
- M12 预算被硬裁剪到 **0–1000ms**（0 保留既有“筛选即耗尽→冠军回退”语义，不是新增能力）；固定 workUnits 模式下不生效，防止“靠无限加算力”取得研究优势。
- 确定性变异样例：M10 “认领优先排序”、M11 “扩大候选上限+降低覆盖边际”、M12 “1.5 倍预算”。

### 3.3 阶段二验收

| 验收项 | 状态 | 证据 |
|---|---|---|
| 12 个真正接入决策路径的模块 | PASS | 注册表 `realDecisionPath` + 探针 + 12 模块真实对局 |
| 每模块算法变异/替换能力 | PASS | `module-mutations.mjs` + 每模块至少 1 个可编译变异 |
| 单元测试与行为探针 | PASS | 4 个新测试文件 + `all-modules-probe.json` |
| 结构级搜索候选验证 | PASS | M10/M11 白名单与真实 pair 对局 |
| 模块禁用/消融 | PASS | interaction `ablation-M02`（pair 移除 M11） |
| 多人局面回归 | PASS | 2–5 人真实对局（campaign/OpenEvolve/interaction） |
| 区分“已验证”与“仅接口” | PASS | 矩阵逐项标注证据类型 |

**本会话实跑测试结果（非推断）**：

- `web-v1 npm test`：**267 / 267 pass**（12.5 min，含构建/卡表检查；`training/reports/ai9/logs/web-test.log`）；
- `training npm test`：**213 / 213 pass**（7.7 min；`training/reports/ai9/logs/training-test.log`）；
- `training npm run evolution:test`：**93 / 93 pass**（含 4 个 AI9 新测试文件；`training/reports/ai9/logs/evolution-test.log`）；
- 12 模块 artifact 安全复核：10 项检查全 pass（`training/reports/ai9/all-modules-safety.json`）；
- 模块部署/回滚演练：6 / 6 PASS（`training/reports/ai9/module-deploy-drill.json`）。

---

## 4. 阶段三：跨模块自主协同进化

### 4.1 协同进化控制器

在 AI8 Campaign Controller 上扩展（未推倒重建）：

- `generation.mode='multi-module'`；
- 策略：`single / pair / multi / crossover / ablation / openevolve`；
- 多模块同时变异；代码 + 参数联合变异（pair/multi，默认 50% 概率，权重 ±5% 且边界内）；
- 依赖感知交叉：M02 组合时优先固定同一捐赠者的 M03/M04；缺失依赖保持官方实现；
- 模块级精英池 + MAP-Elites（2D：获取占比 × 认领占比，每桶保留最优）；
- 精英候选重新组合、消融、负交互识别；
- 失败诊断 → 下一轮 research hints（复用 AI7 标签管线）；
- 检查点/恢复/停止/预算上限/重复运行保护/资源调度继承 AI8。

### 4.2 真实运行证据

| 运行 | 类型 | 结果 | 证据 |
|---|---|---|---|
| OpenEvolve r001 | 真实 LLM、M02+M05 双 block | 完成；LLM 改写 M05（28 处行为探针分歧），stage2 32 局；未晋级 | `training/reports/ai9/openevolve-r001.json` + `openevolve-r001-run/`（best program/日志） |
| OpenEvolve r002 | 真实 LLM、M02+M11 | 初始程序 stage2+stage3 96 局行为等同官方（0 分歧）；迭代 1 被人工终止，仅作为“相同程序不耗深评”的对照 | `training/reports/ai9/openevolve-r002-initial96.json` |
| OpenEvolve r003 | 真实 LLM、M02+M11、2 iterations | 见 §4.3（已完成，候选被拒绝） | `training/reports/ai9/openevolve-r003.json` + `openevolve-r003-run/` |
| **控制器内嵌 OpenEvolve** | 真实 LLM、4 模块、1 iteration | 初始程序 32 局行为等同官方（combined=0）；LLM 第 1 代改变 1 个模块（14 处探针分歧），stage2+3 共 96 局、异常 0、delta=0、combined=0.5 | `training/reports/ai9/openevolve-inloop-1/`（best program/日志/input）；原始目录 `ai5/openevolve/results/ai9-openevolve-1792987915204/` |
| 协同进化 smoke-003 | 真实 2/5 人对局 | 3 候选、40 局、control 与单模块候选进入深验；M02 候选进入机器门禁队列 | `training/reports/coevolution/ai9-smoke-003/` |
| 交互实验 | 同种子 2–5 人、6 候选 | 见 §4.4 | `training/reports/ai9/interaction-experiment.json` |
| 12 模块真实对局 | 2–5 人 | 见 §4.5 | `training/reports/ai9/all-modules-game.json` |

### 4.3 OpenEvolve r003（真实联合进化，已完成）

- 程序：M02（商人卡获取）+ M11（联合搜索结构）两个 EVOLVE-BLOCK；
- 真实 LLM 迭代 2 次；初始程序与官方一致 → stage2 32 局后被判 0 分（不再消耗 stage3）；
- 迭代 2 候选：`changed_module_count=1`，M02 行为探针 8 处分歧，M11 未被改写；
- stage2 + stage3 共 **96 局真实 2–5 人对局**，异常率 0；
- 结果：候选第一名率 **0.2708**，冻结冠军 **0.4167**，配对 delta **−0.1458**，CI 下界 **−0.2322**；
- 判定：**显著更差，拒绝**（未进入正式挑战，未消耗验证池/alpha）。
- 证据：`training/reports/ai9/openevolve-r003.json`、`openevolve-r003-candidate.json`、
  `training/reports/ai9/openevolve-r003-run/`（best_program.ts / best_program_info.json /
  input program / 迭代日志 / run-summary，已纳入版本库）；原始运行目录 `ai5/openevolve/results/ai9-r003/`。

诚实说明：本轮 LLM 只改写了两个模块中的一个；因此“LLM 在同一代同时改对两个模块”未被证明。
双模块真实联合候选由 §4.6 的组合实验补足。

### 4.4 跨模块交互实验（开发池，方向性）

运行：`ai9-interaction-mvopnz8f`，6 个候选（control / single-M02 / single-M11 / pair-M02+M11 /
multi-M02+M05+M11 / ablation-M02），2–5 人分层，每人数 4 个互不重叠的种子（共 16 个独立种子），
每个候选 32 局真实对局（16 个配对 × 候选/冠军两臂），6 个候选共 192 局；固定 workUnits=32。

| 候选 | 焦点席位配对第一名率 delta | 池化 95% CI（n=16 配对） | 各人数 delta（2/3/4/5） |
|---|---|---|---|
| control（官方模块） | 0.0000 | [0.000, 0.000] | 0/0/0/0 |
| single-M02 | −0.1875 | [−0.364, −0.011] | 0 / −0.25 / −0.25 / −0.25 |
| single-M11 | 0.0000 | [−0.226, +0.226] | 0 / −0.5 / +0.25 / +0.25 |
| pair-M02+M11 | −0.1875 | [−0.426, +0.051] | −0.25 / −0.5 / 0 / 0 |
| multi-M02+M05+M11 | −0.1875 | [−0.426, +0.051] | −0.25 / −0.5 / 0 / 0 |
| ablation-M02（pair 移除 M11） | −0.1875 | [−0.364, −0.011] | 0 / −0.25 / −0.25 / −0.25 |

交互计算：`pairDelta −（singleM02 + singleM11）= 0.0000`（判定 additive/inconclusive）；
`M11 边际 = pairDelta − ablationDelta = 0.0000`。

**解释**：
- control 与冻结冠军逐配对完全相同（delta 恰好 0），说明候选/冠军隔离和配对设计有效；
- 本轮 M02 确定性变异在此样本上显著劣于冠军（CI 上界 < 0），是真实的负结果而非测量噪声；
- M11 单模块与 pair 均未显示正向效果；没有观察到协同增益，也没有发现“1+1>2”；
- 所有候选均未达到正式挑战发起条件，未消费验证池/alpha。
- 证据：`training/reports/ai9/interaction-experiment.json`（含逐候选 pairs、byPlayerCount 与池化 CI）。


### 4.5 全模块候选真实对局

- 候选：12 模块确定性变异全部装入同一编译包（`cand-ai9-evidence-all-modules`）；
- 2–5 人、每人 2 个独立种子、共 16 局，异常 0；
- 候选第一名率 0.5，冠军 0.5，pooled delta 0（CI 下界 −0.506）；
- 结论：12 模块候选能真实控制正式对局席位并完成合法终局；**不声称棋力提升**。
- 证据：`training/reports/ai9/all-modules-game.json`。

### 4.6 OpenEvolve 模块 + 确定性模块组合（双模块真实候选）

运行：`ai9-oe-combined-mvopxeeo`，候选 `cand-ai9-oe-combined-m02m05`（artifactHash `25a7876d…`）。

- 模块来源：M05 来自 **OpenEvolve r001 真实 LLM 改写**（`ai5/openevolve/results/ai9-r001`）；
  M02 来自确定性模板变异 `readiness-acquisition-gain`；
- 两个模块的行为探针均发生变化：`changedModules=[M02,M05]`、`mismatches=112`、`errors=0`；
- 2–5 人分层、每人数 2 个互不重叠的种子（共 8 个独立种子），候选/冠军配对共 **16 局真实对局**，
  异常 0、全部正常终局；
- 结果：候选第一名率 **0.625**，冻结冠军 **0.5**，配对 delta **+0.125**，
  池化 95% CI **[−0.112, +0.362]**（n=8 配对，df=7）；
- 分人数：2p 0 / 3p 0 / 4p +0.5 / 5p 0（每格仅 2 局，不具判定力）。

**结论**：这是本会话唯一一个“两个模块同时真实改变行为并共同控制正式对局候选席位”的候选。
但 8 个配对样本远不足以证明提升（CI 跨 0，含负值），因此：
- **不宣称第一名率提升**；
- 不进入正式挑战、不消费验证池/alpha；
- 证据：`training/reports/ai9/openevolve-combined-game.json`。

### 4.6.1 真实模块交叉组合（campaign 候选库 → 子代候选 → 真实对局）

- 父母：`cand-ai9-pair-fallback-r1c2-5abc65`（M01,M11）与
  `cand-ai9-multi-r1c1-0ceec1`（M01,M05,M10,M11），均来自真实 `ai9-live-coevolve-2` 候选库；
- 用正式 `generateMultiModuleBatch(strategy=crossover)` 生成子代
  `cand-ai9-crossover-r1c0-029764`（M01,M05，依赖闭包与安全/编译/探针全部通过）；
- 探针：`changedModules=[M01]`、63 处分歧、0 错误；
- 2–5 人、每人数 2 个独立种子、16 局真实对局，异常 0；
- 候选第一名率 0.5，冠军 0.375，delta **+0.125**，池化 CI **[−0.304, +0.554]**（n=8）；
- 结论：交叉组合机制真实可用；样本不足，**不宣称提升**、不发起挑战。
- 证据：`training/reports/ai9/crossover-experiment.json`。


### 4.6.2 无人值守协同进化 campaign `ai9-live-coevolve-2`（真实 2 代 + 停止/恢复 + 机器门禁）

命令（与 `training/package.json` 一致）：

```
npm run coevolve:start -- --campaign ai9-live-coevolve-2 --rounds 2 --candidates 4 \
  --player-counts 2,3,4,5 --quick-seeds 8 --deep-seeds 8 --deep-confirmations 2 \
  --modules M01,M02,M05,M10,M11 --strategies multi,crossover,ablation,openevolve \
  --openevolve-iterations 1 --max-games 800 --max-wall-ms 2400000
```

时间线（全部可在 `training/reports/coevolution/ai9-live-coevolve-2/logs/events.jsonl` 复核）：

| 事件 | 时间 | 证据 |
|---|---|---|
| campaign-started（round 1，screen/deep 独立窗口） | 04:42:28 | seq 1–2 |
| 真实 OpenEvolve 在控制器内运行（4 模块、1 iteration） | 04:42–04:47 | `logs/ai9-openevolve…`；初始程序 32 局等同官方，LLM 本轮未改变行为 |
| campaign-stopped（operator，steps=7） | 04:48:59 | seq 25 |
| campaign-resumed（runFingerprint 一致） | 04:49:37 | seq 26 |
| round 1 深验完成 + 机器门禁请求 | 04:54:43 | seq 35–36 |
| round 2 开始（新种子窗口） | 04:54:43 | seq 38 |
| campaign-completed | 05:02:49 | state.status=completed |

最终统计：

- **2 轮、8 个候选、192 局真实 2–5 人对局、4 次深验、异常 0**；墙钟累计 1,182,721 ms（约 19.7 min）；
- 候选来源：control、真实 LLM（`openevolve` 策略，本轮未改变行为）、确定性 pair/ablation、模块精英；
- 模块级精英：M01/M05（score 0.125）、M10/M11（score 0）；MAP-Elites 单元 `1-0`；
- 机器门禁：2 个候选进入 `queued-machine-gate`，`promotion-handler` 均返回
  **BLOCKED / insufficient-statistical-power**（α=1.22e-5、功效 0.03%、达到 80% 需约 10,249 种子/人数）；
- **未消费验证池、未消耗新 alpha、冠军未变**；这不是“晋级”，也不冒充晋级；
- 证据：`training/reports/coevolution/ai9-live-coevolve-2/`（state/events/checkpoints/artifacts/promotion-queue/evidence）。

工程修复（由真实运行暴露）：原生成器为补满一批会重复启动多次真实 LLM 运行
（`ai9-live-coevolve-1` 因此被人工中止）。现已限制每批最多 1 次真实 LLM 调用，
剩余名额用确定性候选补齐并显式记录 `fallback`；策略选择改为严格轮转，
不再因候选数量漂移而跳过 crossover/ablation。

### 4.7 阶段三验收

| 验收项 | 状态 | 说明 |
|---|---|---|
| 多模块联合候选 | PASS | 编译/探针/真实对局 |
| 独立/多模块变异 | PASS | single/pair/multi/multi-file |
| 模块交叉组合 | PASS | crossover 策略 + 依赖闭包；真实子代 `cand-ai9-crossover-r1c0-029764` 16 局（§4.6.1） |
| 参数与代码联合变异 | PASS | pair/multi + artifact 参数身份 |
| 精英保留 / MAP-Elites | PASS | smoke-003 状态 + 测试 |
| 消融与交互识别 | PASS | interaction 实验 |
| 历史冠军/风格对手池 | PASS | 冻结注册表以对手池轮换 |
| 失败诊断驱动搜索 | PASS（复用） | research hints 管线 |
| 真实 OpenEvolve 多模块运行 | PASS | r001/r003 + 控制器内嵌（§4.2/§4.6.2） |
| 停止 / 检查点 / 恢复实测 | PASS | `ai9-live-coevolve-2`：steps=7 停止 → resume → completed；events seq 25/26 |
| 自动正式晋级 | BLOCKED | 门禁路径真实执行，2 次均因统计功效不足 BLOCKED；无合格候选，未触发验证池/alpha |
| 12h 连续运行/恢复 | NOT_RUN | 见 §7 |

---

## 5. 统计、预注册与 championship 纪律

- 主指标：`training/evaluator/first-place.mjs` 焦点席位配对 delta；2–5 人分层；种子簇 t 区间；非劣效 + IUT；平均分只诊断。
- 预注册/alpha/种子治理：完整复用 AI8，未修改阈值或账本历史。
- AI9 新种子块（`ai5/lib/seed_policy.mjs` 与 `.py` 镜像）：
  - 研究评估 `[1.650e9, 1.651e9)`；
  - 快筛 `[1.66e9, 1.67e9)`；
  - 深验 `[1.67e9, 1.68e9)`；
  - 独立确认 `[1.68e9, 1.69e9)`；
  - 与 AI7、验证池 `[900M, 1.06e9)` 及全部既有块零交集（测试固化）。
- 正式挑战路径已扩展到编译型多模块候选：
  - `run-first-place-challenge.mjs` 自动识别 artifact、全哈希复核、加载独立 ESM 决策包作为 A 臂；
  - 预注册、种子窗口、alpha 账本、独立重算逻辑不变；
  - `promote-first-place-champion.mjs` 对编译候选记录模块身份，并在真实晋级时把模块函数写入正式源码（`apply-modules.mjs`，带备份/复核/回滚）。
- **本会话没有执行正式挑战**：没有候选达到发起条件；未消费验证池、未消耗新 alpha、冠军未变。

---

## 6. 安全与可信执行

| 控制 | 实现 | 证据 |
|---|---|---|
| 可进化文件/函数白名单 | 注册表 12 项；静态检查拒绝未注册函数/文件 | `static_check_modules.mjs` |
| 参数类型/默认值漂移 | 官方签名声明逐字比对 | 同上 |
| 函数外代码/额外导出 | block 内容必须恰好一个注册函数 | 同上 |
| 禁止构造 | import/require/eval/Function/process/globalThis/DOM/网络/fs/时钟/随机/隐藏牌库/模板字符串/死循环 | 同上 + 恶意测试 |
| Seatbelt | 静态检查/组装/tsc/探针/对局全部 sandbox-exec；禁网/禁 HOME/只写工作区 | `training/evolution/sandbox/seatbelt.mjs` |
| 编译产物隔离 | 独立 tsc 树；完整 ESM 包封印；不写官方 dist | `multi-module-candidate.mjs` |
| 合法行动复核 | 候选只能重排/剪枝合法行动；最终 action 由正式引擎复核 | `champion-guided.ts` / `simulateGame` |
| 隐藏信息 | 决策只消费 `AIObservation`；静态扫描隐藏字段 | 探针/fairness 测试 |
| 候选污染冠军 | 中性候选逐局一致；候选与官方模块实例分离 | `module-wiring.test.mjs` |
| 崩溃/死循环 | 步数/墙钟上限；异常局与正常局分离 | evaluator/campaign |
| 断点恢复 | state/checkpoint/lock/stop；runFingerprint 防错配置 | Campaign Controller |
| 部署/回滚 | apply/check/revert + 备份 + 全哈希 | `module-deploy-drill.mjs` 6/6 PASS |
| 网页实际加载冠军 | 本地 `http.server` + `verify-deploy.mjs`：冠军 `joint-js5`/`champion-guided`/artifact 指纹全部 PASS | `training/reports/ai9/deploy-verification-local.json` |

---

## 6.1 M4 16GB 资源与推理预算（实测）

证据：`training/reports/ai9/resource-report.json`（由 `npm run ai9:resource` 从真实证据生成）。

| 项目 | 实测值 |
|---|---|
| 设备 | darwin / arm64 / **10 CPU** / **17,179,869,184 B ≈ 16 GiB** |
| 12 模块编译包 | **49 个 ESM 文件 / 333,332 B**（上限 8 MiB） |
| 候选 Artifact JSON | 429,481 B |
| 候选决策均值（真实 2–5 人） | **24.1–40.0 ms**（7 组样本加权 31.6 ms） |
| 单决策硬上限 | 1,000 ms（M12 自适应预算，固定 workUnits 时不生效） |
| 普通 AI 决策均值（5 人 4 局 694 次决策） | **97.4 ms**；AI8 基线同机 **96.0 ms**（模块钩子无显著性能回归） |
| 协同进化 campaign | `ai9-live-coevolve-2`：8 候选 / **192 局** / 1,182,721 ms（≈19.7 min）/ 4 次深验；smoke-003：3 候选 / 40 局 / 184 s |
| 训练并发 | 1（控制器串行；`maxConcurrent` 仅作资源门禁输入） |

> 说明：普通 AI 与联合搜索是两条不同路径；上表分别给出，避免把不同预算口径混在一起。
> 训练时间可以增加，但正式 AI 的推理预算被硬限制在部署可接受范围内。

---

## 7. 未完成/阻塞项（必须如实披露）

| ID | 项目 | 状态 | 原因/解除条件 |
|---|---|---|---|
| R09 | 12 小时连续训练 + 强制终止恢复 | NOT_RUN | 本会话未提供 12h 连续窗口；命令与监控已就绪（见 §8） |
| R12 | 真实冠军晋级 + 自动发布 + 回滚 | BLOCKED | 门禁路径已真实执行 2 次（`ai9-live-coevolve-2`），均 `BLOCKED/insufficient-statistical-power`（α=1.22e-5，需 ~10,249 种子/人数）；没有统计合格候选，不能伪造挑战/晋级。解除条件：补充独立验证预算与 alpha，且候选达到预注册阈值 |
| — | 统计显著的第一名率提升 | 未证明 | 所有研究候选的区间下界均 ≤0；冠军保持 `joint-js5` |
| — | 全模块逐一真实对局强度证明 | 部分 | 12 模块共同控制真实对局；逐模块“强度贡献”只做了探针与交互方向性实验 |
| — | M12 在固定 workUnits 正式挑战中的效果 | 不适用 | 正式挑战固定 workUnits；M12 只在墙钟生产预算下有作用 |
| — | 生产网页实际加载新模块冠军 | BLOCKED | 未晋级，未部署新模块；部署/回滚链路已演练 |

---

## 8. 可复现命令

```bash
# 0) 环境
cd "/Volumes/Extreme SSD/Projects/Century-ai9"
cd web-v1 && npm run build && cd ..

# 1) 12 模块编译 + 探针 + 安全
node -e "import('./training/evolution/multi-module-candidate.mjs').then(async m=>{const mut=await import('./training/evolution/module-mutations.mjs');const fs=await import('node:fs');const ids=['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10','M11','M12'];const exp={configRef:'ai9://evidence/all-modules',configHash:'f'.repeat(64),seedRefs:[{purpose:'screen',windowId:'ai9-screen-w000',base:1660000000,count:4},{purpose:'deep',windowId:'ai9-deep-w000',base:1670000000,count:4}]};const r=m.createCompiledModuleCandidate({modules:mut.mutateModules(ids),moduleIds:ids,experiment:exp,candidateId:'cand-ai9-evidence-all-modules',sourceOrigin:'deterministic-template'});fs.mkdirSync('training/reports/ai9',{recursive:true});fs.writeFileSync('training/reports/ai9/all-modules-candidate.json',JSON.stringify(r.artifact,null,2));fs.writeFileSync('training/reports/ai9/all-modules-probe.json',JSON.stringify(r.probe,null,2));})"

# 2) AI9 测试（Seatbelt / macOS）
cd training
node --test evolution/tests/module-registry.test.mjs evolution/tests/multi-module-candidate.test.mjs \
  evolution/tests/coevolution.test.mjs evolution/tests/module-wiring.test.mjs
npm run ai9:deploy-drill
npm run ai9:interaction
npm run ai9:all-modules-game
npm run ai9:crossover     # 从真实 campaign 候选库交叉组合并跑真实对局
npm run ai9:module-matrix
npm run ai9:resource
npm run ai9:wiring         # 逐模块决策分歧审计
npm run ai9:execution      # 逐模块真实对局调用计数审计

# 2b) 本地部署身份核验（不依赖线上）
python3 -m http.server 8123 --directory web-v1/dist &
ART=$(node -p "require('./web-v1/dist/build-manifest.json').artifact.sha256")
CH=$(node -p "require('./training/champions/champion.json').parameters.id")
node scripts/ci/verify-deploy.mjs --url http://127.0.0.1:8123/ \
  --expected-artifact "$ART" --expected-champion "$CH" \
  --json training/reports/ai9/deploy-verification-local.json
kill %1

# 3) 真实 OpenEvolve 多模块联合进化
npm run ai9:openevolve -- --modules M02,M11 --iterations 2 --out ai5/openevolve/results/ai9-r003

# 4) 无人值守协同进化（真实种子治理 + 真实对局 + 机器门禁队列）
npm run coevolve:start -- --campaign ai9-nightly --rounds 2 --candidates 4 \
  --player-counts 2,3,4,5 --quick-seeds 4 --deep-seeds 6 \
  --modules M01,M02,M05,M10,M11 --strategies single,pair,multi,crossover,ablation \
  --max-wall-ms 43200000 --max-games 600
npm run coevolve:status -- --campaign ai9-nightly

# 5) 正式挑战（仅在候选达到发起条件时；会消费验证池/alpha）
node training/tournament/run-first-place-challenge.mjs \
  --candidate training/reports/coevolution/<campaign>/artifacts/<candidate>.json \
  --seeds-per-seat 250 --out training/reports/first-place-promotion/latest
node training/scripts/promote-first-place-champion.mjs \
  --evidence training/reports/first-place-promotion/latest/challenge-evidence.json \
  --plan training/reports/first-place-promotion/latest/preregistration.json \
  --candidate training/reports/first-place-promotion/latest/candidate.json --dry-run

# 6) 模块部署/回滚（晋级后由发布流程调用）
node training/scripts/apply-modules.mjs --artifact <candidate.json> --check
node training/scripts/apply-modules.mjs --artifact <candidate.json> --apply
node training/scripts/apply-modules.mjs --revert
```

---

## 9. 最终结论

- **系统能力**：AI 9.0 已从单函数 OpenEvolve 升级为受控的全决策系统多模块协同进化平台；12 个模块真实接入、可独立/联合变异、可交叉/消融、可真实多人对局、可预注册评估、可进入冠军晋级门禁。
- **竞技结果**：没有找到统计上更强的冠军；当前冠军仍为 `joint-js5`，第一名率提升未证明。任何相反表述都是不实。
- **阻塞**：R09 12h 连续运行、R12 真实晋级/发布/回滚触发；解除条件见 §7。
- **状态**：`CENTURY_AI9_COEVOLUTION_READY = false`（因 R09/R12 未完成；工程能力本身已就绪并可复现）。
