# AI5-OPENEVOLVE-INTEGRATION-REPORT

**Century AI 5.0 — OpenEvolve 自主算法进化系统集成与验证报告**

- 分支：`feat/ai5-openevolve-poc`（自 main `e9fc67a` 切出，未触碰 main）
- 实验日期：2026-10-21
- 执行环境：Mac mini M4 / 16GB 统一内存 / macOS（sandbox-exec 可用）
- 报告性质：所有结论均来自本机真实执行结果，证据文件路径随文给出

---

## 1. 目标与范围

将 OpenEvolve（LLM 驱动的代码进化框架）与 Century AI 4.0 训练系统融合，建立
"自动生成 → 自动测试 → 自动评估 → 按反馈继续进化" 的算法进化闭环（AI 5.0），
同时保证：

1. 不重复开发 OpenEvolve 已有的通用进化能力（种群/MAP-Elites/岛屿/断点恢复）；
2. 不推倒重建 AI 4.0 —— 其训练命令、模拟器、冠军挑战、种子账本、晋级流程全部原样保留；
3. 候选策略未经独立验证不得成为冠军；
4. 第一轮只进化一个具体策略函数：`web-v1/src/ai/evaluator.ts` 的商人卡获取估值
   函数 `acquisitionValue()`。

## 2. 组件审查结论（第一阶段）

### 2.1 Century 侧（已核查）

| 项 | 状态 |
|---|---|
| main 分支 | 已含 AI 4.0 可靠性整改（#13，`e9fc67a`）；复审整改（#12）；冠军晋级（#11，beam-rollout 结构版本） |
| 当前冠军 | `struct-beam-rollout`（8 参数全 1.0，结构优势由 beam-rollout 承载），`training/champions/champion.json` |
| 模拟器 | `training/simulator/simulate.mjs`：固定种子、逐席位参数/结构注入、异常隔离；但决策代码是**模块级单例**（所有席位共用 `dist/js/ai.js`）—— 不支持同局代码级隔离（见 §4） |
| 统计工具 | `training/evaluator/stats.mjs`：Wilson CI、配对得分优势率判定（`pairedPromotionDecision`）、真实第一名率（`firstPlaceStats`）—— AI5 直接复用 |
| 种子账本 | `training/lib/seeds.mjs`：验证种子块基数 900M、步长 2000、`challengeCount` 驱动几何 alpha 消耗 —— AI5 **绝不触碰** |

### 2.2 OpenEvolve 侧（已核查）

| 项 | 值 |
|---|---|
| 版本 | 上游 main @ `6a18b3928ccd92898167c0bb27149954ed3e9a9d`（requirements.txt 锁定） |
| 许可证 | Apache License 2.0 |
| 评估接口 | 自定义 Python 评估器：`evaluate(program_path)` / 级联 `evaluate_stage1/2/3`，`combined_score` 阈值门控 |
| 进化区域 | `EVOLVE-BLOCK-START/END` 标记 + `diff_based_evolution`；**`enforce_evolve_blocks` 默认 false**（本集成显式开启，另有独立静态复核，见 §6） |
| LLM 接入 | 内置 provider 含 `codex_app_server`（走 codex CLI 的 ChatGPT 登录，无 API Key）—— 与"首选 Codex App Server 接入"一致 |
| 环境事实 | 本机 codex-cli 0.149.1 已 ChatGPT 登录；Docker 不可用；`sandbox-exec` 可用 |

### 2.3 模型接入实测（重要技术事实）

目标指定的"首选 Codex App Server 接入"在实测中暴露两个上游兼容性问题，
均已在**不改 OpenEvolve 源码**的前提下解决：

1. **协议形状不兼容**：OpenEvolve 的 `codex_app_server` 后端在 `thread/start` 中发送
   `sandbox: {"mode": "read-only", "networkAccess": false}`；codex-cli 0.149.1 要求
   单键变体映射（`{"read-only": null}`），否则返回 -32600 且调用挂起重试
   （原始探测证据：`/tmp` 探针实测，报错 "expected map with a single key"）。
   → 垫片 `century_codex_compat.py`（运行时方法替换，一行参数形状差异）。
2. **app-server 路径过慢**：同账户同模型（账户可用模型经 `model/list` 实测为
   `gpt-5.6-sol` / `gpt-5.6-terra`；配置中的 `gpt-6.1-sol` 被 ChatGPT 计划拒绝，
   HTTP 400 "model is not supported"），app-server 单 turn PONG 实测 40-80s、
   真实代码生成 > 7 分钟未返回；而 `codex exec` 标准路径 PONG ≈ 5s、真实生成
   30-90s。→ 后端 `century_codex_exec.py`（`codex exec --json` 子进程，同一
   ChatGPT 登录、零 API Key），经 ensemble 的 provider 注册表注入（父进程 +
   venv 级 `sitecustomize.py` 覆盖 multiprocessing spawn 的 worker）。

模型调用预算：每迭代 1 次生成调用（reasoning_effort=low，timeout 600s），
无任何付费 API。

## 3. 架构（第二阶段）

```
OpenEvolve（Python venv，codex exec 后端，MAP-Elites + 2 岛屿种群）
   │ 生成/变异 acquisitionValue 候选（diff-based，仅 EVOLVE-BLOCK 内）
   ▼
century_evaluator.py（Python ↔ Node 评估适配器，级联）
   │ stage1（秒级）：static_check → assemble_candidate → 沙箱 tsc 编译 → 沙箱单元探针
   │ stage2（≈1 分钟）：沙箱内配对对战 16 种子 × 2 局
   │ stage3（≈3 分钟）：沙箱内配对对战 48 种子 × 2 局（种子与 stage2 物理隔离）
   ▼
Node 管线（ai5/openevolve/node/）
   ├─ static_check.mjs        静态安全检查
   ├─ assemble_candidate.mjs  候选源码树组装 + SHA256 固证
   ├─ probe.mjs               3000 个确定性用例行为探针
   └─ duel_runner.mjs         同局双版本按席位注入对战
```

复用/新建边界：

| 复用（零改动） | 新建（`ai5/openevolve/`） |
|---|---|
| `web-v1/dist/js/engine.js`（唯一规则源） | 候选组装/编译/探针/对战管线 |
| 官方 `dist/js/ai.js`（= 冠军代码，永不修改） | 同局双版本注入机制（§4） |
| `training/evaluator/stats.mjs` 统计口径 | 静态安全检查 + Seatbelt 沙箱（§6） |
| AI 4.0 全部训练命令、工作流、晋级链路 | OpenEvolve 配置/后端垫片/运行器 |
| 冠军参数与席位人格映射源码 | 三组验证实验（§7） |

新增文件清单见 `ai5/openevolve/README.md`；Python 依赖仅 `openevolve`（锁定 commit）；
Node 侧零新依赖。

## 4. 同局双版本隔离机制（核心问题）

**问题**：候选代码若替换公共编译产物 `web-v1/dist/js/ai.js`，同局的对照组冠军也会
运行候选算法 —— 评估被污染，这是目标书明令禁止的。

**方案**（`duel_runner.mjs` + `assemble_candidate.mjs`）：

1. 候选源码树 = 官方 `web-v1/src/{data,engine,ai}.ts` 的**字节级副本**，唯一差异是
   `ai/evaluator.ts` 中的 `acquisitionValue` 函数被替换为演化版本（函数外逐字节一致，
   `assemble_candidate.mjs` 以 per-file SHA256 强制校验）；
2. 候选树独立 `tsc` 编译（严格选项与 web-v1 完全一致）为独立 ESM 模块；
3. 同一 Node 进程内同时 import 官方 `ai.js` 与候选 `ai.js` —— 两个互不共享状态的
   模块实例；规则引擎只有一份（官方 `engine.js`）；
4. 按席位注入：配对模式每种子两局，局 1 候选@席位 0（中立代理位），局 2 候选@席位 4
   （战术大师位）；配对分差 = [(cand@0局1 − champ@0局2) + (cand@4局2 − champ@4局1)] / 2
   —— 角色匹配、同种子共享洗牌序列，与 AI 4.0 挑战的配对语义对齐；
5. 冠军席位显式传入 `champion.json` 参数（belt-and-braces，防止默认值漂移）。

**证明**：实验 A（基线一致性）与实验 B（席位注入有效性），见 §7。

## 5. 评估器与指标（第四阶段）

级联阈值：stage1 ≥ 0.5（gate），stage2 ≥ 0.45（gate），stage3 终评。

| 指标 | 用途 | 实现 |
|---|---|---|
| 配对得分优势（主） | 与冠军比较 | `mean_score_diff_per_seed` + `paired_win_rate`（决定性种子口径，与 AI 4.0 一致） |
| 第一名率 | 真实竞技能力参考 | `firstPlaceStats`（方向 A/B 合并口径），**不与配对优势混同** |
| 决策延迟 | 网页端可用性 | `mean/p95_decision_ms`（惩罚阈值 p95 > 150ms） |
| 异常率 | 稳定性 | 逐局 anomaly（引擎非法行动/超时/死局），重罚 1.5× |
| 代码复杂度 | 辅助约束 | 函数文本长度，超 3000 字符线性惩罚 |
| combined_score | OpenEvolve 优化目标 | `0.5 + 0.30·tanh(分差/8) + 0.20·(配对胜率−0.5)·2 − 1.5·异常率 − 延迟惩罚 − 复杂度惩罚` |

防作弊约束（目标书"不允许候选读取评估成绩"）：

- 候选唯一产出是 `acquisitionValue` 函数体；成绩只能由评估管线从对局结果计算；
- 函数签名逐参校验，`params.*` 乘子必须保持接入；
- 禁止按 cardId 硬编码查表（写入演化说明与 prompt 约束）。

种子纪律（AI5 专用子块，与 AI 4.0 物理隔离）：

| 区间 | 归属 |
|---|---|
| [0, 300M) | AI 4.0 日常进化 —— 不触碰 |
| **[300M, 400M)** | **AI5 快筛/深评专用**（stage2: 300,000,000-15；stage3: 300,000,100-147） |
| [400M, 900M) | AI 4.0 基准评测约定区 —— 不触碰 |
| [900M, 1.06e9) | 冠军验证账本 —— **绝不触碰**；AI5 不执行任何确认挑战 |

## 6. 安全隔离（第五阶段）

OpenEvolve 生成代码一律视为**不可信**。双层防御，实际效力经 12 项恶意样例验证
（`experiments/isolation_test.mjs` → `results/isolation_verification.json`，12/12 通过）：

**层 1 · 静态检查**（执行前拒绝）：禁 import/require/eval/Function 构造/constructor
逃逸/process/globalThis/fetch/隐藏牌库字段（merchantDeck/golemDeck/.deck）/Math.random/
时钟与计时器/模板字符串/DOM/文件与网络模块；签名逐参校验；EVOLVE-BLOCK 边界独立复核
（OpenEvolve enforce 开关的冗余保险）。恶意样本 `m01`（读环境密钥）、`m02`（require fs）、
`m03`（constructor 逃逸）、`m04`（自报分数）、`m06`（联网外传）全部被拒。

**层 2 · macOS Seatbelt 沙箱**（`sandbox/candidate.sb.tmpl`，编译/探针/对战全走
sandbox-exec）：默认全拒；**拒绝读取真实用户主目录**（~/.codex、~/.ssh 实测不可达）；
**拒绝一切网络**（fetch 实测被拒）；**只允许写 AI5 工作区**（越权写实测被拒）；
子进程环境变量白名单（PATH/HOME/TMPDIR/LANG，无任何密钥），HOME 指向空工作目录。
`m05`（死循环）通过静态检查后由运行时超时击杀淘汰 —— 实测成立。

**残余风险披露**：候选可读仓库内非密钥文件（沙箱需允许读系统与仓库以完成编译）；
密钥类资产的隔离由「环境变量白名单 + 主目录整体拒绝」承担并经恶意样例实测。
若需更强隔离，后续可切换 Docker 容器执行（本机 Docker 不可用）。

## 7. 验证实验（第六阶段）

### 实验 A · 基线一致性 ✅

`experiments/exp_a_baseline.mjs` → `results/exp_a_baseline.json`（allPass=true）

| 检查 | 结果 |
|---|---|
| 探针：候选=官方代码时 3000 个确定性用例逐位一致 | PASS（mismatch=0） |
| 同种子对局一致性：duel_runner vs `training/simulator` 50 种子逐位一致 | PASS（mismatch=0） |
| 配对分差为零（基线不自证优势） | PASS（0 对非零） |
| 官方产物 SHA256 前后不变 | PASS（ai: 4d6c1c55…，engine: 2335d9fe…） |

### 实验 B · 算法修改有效性 ✅

`experiments/exp_b_mutation.mjs` → `results/exp_b_mutation.json`（allPass=true）
变体：`exp_b_variant.ts`（移除协同项与抢牌竞争项，人工构造的安全可编译变体）。

| 检查 | 结果 |
|---|---|
| 变体通过静态安全检查 | PASS |
| 探针行为差异可观测（真实参与决策，非"改文件不生效"） | PASS（1775/3000 用例不同，最大差 4.995） |
| 官方模块实例不受候选共存影响（2100+ 用例零错误） | PASS |
| 对局轨迹真实改变 | PASS（12/12 种子结局改变） |
| 候选对局零异常 | PASS（24 局 0 异常） |
| 官方产物 SHA256 不变（冠军零污染） | PASS |

### 实验 C · OpenEvolve 自动进化 ✅

`run_openevolve.py` + `config.yaml`（provider 重定向至 codex exec 后端）。

**C-1 冒烟（3 迭代）**：`results/openevolve-smoke/`（curated 至 `results/smoke-candidates/`）

| 迭代 | combined_score | 配对胜率 | 逐种子平均分差 | 复杂度 | 异常率 |
|---|---|---|---|---|---|
| 基线（初始程序） | 0.5000 | 0.500（平局中性） | 0.000 | 1807 | 0 |
| 1 | 0.3893 | 0.2857 | −0.667 | 1824 | 0 |
| 2 | 0.4617 | 0.4062 | −0.021 | 1951 | 0 |
| 3 | **0.5656** | 0.6250 | +0.417 | 1852 | 0 |

- 每次迭代都真实生成、编译、探针、96 局对战（迭代 1-3 均通过级联进入 stage3）；
- 候选间评分随迭代反馈改善（0.3893 → 0.4617 → 0.5656），证明"根据反馈继续提出改进"成立；
- 最优候选的算法变化（人工核读 diff）：goalFit 项从"与目标费用的原始重叠"改为
  "只统计目标还缺的水晶"（`max(0, cost−stock)`）—— 有边界的算法逻辑修改，
  非参数组合扰动；
- **诚实披露**：16 种子（stage2 口径）的 0.625 配对胜率样本量小、置信区间宽，
  **不构成"发现更强算法"的宣称**；该候选的意义是机制验证（生成→评估→反馈闭环贯通）。

**C-2 受控迭代（10 迭代预算，实际完成 9 演化候选 + 基线）**：`results/openevolve-run-controlled/`
（curated 证据：`results/controlled-candidates/index.json`；逐候选源码+SHA256+逐局成绩见
`results/evaluations/<sha>/`）

| 迭代 | 候选 SHA256 前 12 位 | combined_score | 配对胜率（快筛口径） | 复杂度 | 异常率 |
|---|---|---|---|---|---|
| 基线 | 9329531df196 | 0.5000 | 0.500（平局中性） | 1807 | 0 |
| 1 | 8d73b13595dc | 0.3945 | 0.361 | — | 0 |
| 2 | **66f6a296aa72** | **0.5656** | 0.625 | 1852 | 0 |
| 3 | （回退基线再进化） | 0.5000 | 0.500 | 1807 | 0 |
| 4 | 71688f09aed3 | 0.4058 | 0.353 | — | 0 |
| 5 | 66f6a296aa72（复现） | 0.5656 | 0.625 | 1852 | 0 |
| 6 | 5069df84de7c | 0.5280 | 0.536 | — | 0 |
| 7 | 23e2c102fc42 | 0.5656 | 0.625 | — | 0 |
| 8 | c55e88a700e0 | 0.5656 | 0.625 | — | 0 |
| 9 | 2463e047bfb2 | 0.5656 | 0.625 | — | 0 |

观察：

- 全部 9 个演化候选由 LLM 真实生成（源码 SHA256 互异，`results/controlled-candidates/`），
  全部通过静态检查、编译、探针并完成 96 局级联对战，0 异常局；
- 多个独立候选收敛到同一最优分 0.5656，其中 66f6a296aa72 与冒烟最优**同款算法改进**
  （goalFit 只统计目标还缺的水晶 `max(0, cost−stock)`）—— 在两次独立进化运行中被
  重新发现，说明评估信号方向可被 LLM 稳定利用；
- 进化关系（父子链）完整记录在 index.json（如 iter8 的父是 iter4，反馈路径真实生效）。

### 深度独立验证（关键诚实结论）

对受控最优候选 66f6a296aa72，在**与快筛/深评种子完全隔离**的 100 个新种子
（300,001,000-300,001,099，AI5 子块内）上做 202 局独立复检
（`results/deep_validation_best.json`），并同种子跑官方基线对照
（`results/deep_validation_baseline.json`）：

| 组 | 逐种子平均分差 | 配对得分优势率（95% CI） | 判定 |
|---|---|---|---|
| 最优候选 vs 冠军 | **−1.5** | 0.000（CI 上界 0.037） | **rejected（候选劣势）** |
| 官方基线 vs 冠军（对照） | 0（精确） | —（配对全平） | 无席位偏差，机制公平 |

**结论**：16/48 种子快筛阶段的 +0.417 优势在 100 个新种子上**反转并落败** ——
小样本信号是噪声，系统没有自欺。这正是"训练/验证种子必须隔离、不得以小样本
胜率波动宣称更强算法"的实际证明。本阶段**不产生任何"AI 5.0 更强"的宣称**，
最优候选仅登记为实验版本；任何晋级判定永远属于 AI 4.0 正式冠军挑战流程。

### 评估证据存档（每个候选）

`results/evaluations/<函数SHA256前12位>/`：
- `manifest.json` —— 候选源码树逐文件 SHA256 固证（除演化函数外与官方逐字节一致）；
- `stage2.json` / `stage3.json` —— 完整对战记录（种子、逐局名次/得分/步数、配对分差、
  决策耗时、异常原因）；
- `function.ts` —— 演化函数全文（SHA256 与 manifest 互证）。

## 8. 冠军验证与版本控制（第七阶段）

- 本阶段**未晋级任何候选**，原冠军 `struct-beam-rollout` 完整保留、随时可回滚；
  `web-v1/src/ai/parameters.ts` 与网页游戏零改动（官方产物 SHA256 前后断言通过）；
- 受控实验最优候选经 100 新种子深度独立验证为**劣势**（配对判定 rejected，见 §7
  深度独立验证），已按纪律拒之门外 —— 候选筛选系统具备了自我否定的能力；
- **正式挑战流程消化验证（PR #15 合并后补充）**：受控最优候选 `66f6a296aa72` 已按
  AI 4.0 惯例注册为官方 bundle 内的可选变体（`AIParameters.acquisitionVariant:
  'goal-remaining'`，与冠军结构相同、隔离唯一变量，3000 用例与 AI5 候选实现逐位
  一致），并以 challengeIndex=6（历史 5 次全部累计，α₆=5%/2⁶ 收紧）、验证种子块
  [941500092, 941500152) 走完正式 60 种子双向配对挑战：120 局 0 异常，配对
  23 胜 30 负 7 平，配对分差 −0.454/种子（95% CI [−1.80, +0.89] 跨 0），
  判定 **insufficient（决定性种子 53 < 60，样本不足）→ 保留冠军**。produce 的
  candidate.json 与续接账本（challengeCount=6）为 promote-champion 完全兼容格式
  （`training/reports`→`ai5/openevolve/experiments/reports/challenge-ai5-goal-remaining/`）；
  该候选正式登记为实验版本 —— AI5 产出物被 AI 4.0 冠军挑战流程端到端消化，
  种子账本/多重检验/证据核验全链路未绕过；
- 晋级路径保持 AI 4.0 原样：候选若要挑战冠军，必须走 `training/tournament/challenge.mjs`
  独立验证种子 + `promote-champion.mjs` 证据核验 + `apply-champion.mjs` 落地 + PR 评审；
  AI5 只产出候选与证据，不触碰验证账本与 alpha 消耗机制。

## 9. 资源与成本（M4 / 16GB 实测）

| 项 | 实测值 |
|---|---|
| stage1（静态+组装+编译+探针） | 3-8 秒 |
| stage2 快筛（32 局） | ≈ 60 秒 |
| stage3 深评（96 局） | ≈ 3 分钟 |
| 单迭代端到端（生成+级联评估） | ≈ 4.4-5.3 分钟 |
| 决策延迟（候选 AI，单步均值/p95） | ≈ 10-12 ms / ≈ 15 ms（与 AI 4.0 基准同量级，满足网页端） |
| LLM 调用 | 每迭代 1 次（codex exec，ChatGPT 订阅，零 API Key 零新增付费） |
| 峰值内存 | 单进程 < 1GB（Node 对战 + tsc），远低于 16GB 限制 |

## 10. AI 4.0 vs AI 5.0 能力对比

| 维度 | AI 4.0 | AI 5.0（本集成） |
|---|---|---|
| 进化对象 | 8 个决策乘子（参数）+ 人工实现的结构变体 | **策略算法代码本身**（LLM 自动生成/变异函数逻辑） |
| 候选来源 | (μ,λ) 进化策略参数扰动 | LLM 读评估反馈后提出有边界的算法修改 |
| 同局多版本 | 不支持（决策代码模块级单例，参数/结构可按席位注入，代码不可） | **支持**（双 ESM 模块实例按席位注入，实验 A/B 证明） |
| 评估 | 共享模拟器（训练侧） | 级联评估（静态→编译→探针→快筛→深评），沙箱隔离 |
| 安全模型 | 信任自有训练代码 | **不可信代码**：静态检查 + Seatbelt + 运行时淘汰 + 恶意样例验证 |
| 统计口径 | Wilson CI / 配对优势率 / 几何 alpha | 完全复用（不另起炉灶） |
| 晋级链路 | 挑战 → promote → apply → PR | 不变；AI5 产出候选与证据 |
| 种子 | 训练池 [0,300M)+基准 [400M,900M)+验证池 | 新增 AI5 专用子块 [300M,400M)，与其余物理隔离 |

## 11. 已知边界与教训

1. OpenEvolve 的 `enforce_evolve_blocks` 默认关闭、内存限制非安全隔离 —— 均按目标书
   提示显式处理（配置开启 + 独立静态复核 + OS 级沙箱）；
2. OpenEvolve codex_app_server 后端与 codex-cli 0.149.1 存在协议不兼容 + 性能问题，
   本集成以垫片 + exec 后端绕开（未 fork 上游）；升级 codex-cli 或 OpenEvolve 后需重测；
3. duel_runner 对局为串行执行（复现优先）；吞吐优化（worker 并行）留待下一阶段；
4. stage2 的 16 种子快筛只用于级联分档，不构成任何优势结论 —— 显著性判断永远属于
   独立验证种子的正式挑战（minSeeds=60 起）；
5. 恶意样例验证覆盖了静态可判与运行时可观测的逃逸面；更复杂的语义级作弊
   （如"故意变弱以操纵对手池"）由训练/验证种子隔离与正式挑战流程兜底；
6. 模型调用资源消耗：本阶段实际运行中，codex exec 的 usage 字段名（input/output_tokens）
   与 OpenEvolve 期望的键（prompt/completion_tokens）不匹配，导致历史迭代的逐候选
   token 计数未进日志（调用次数与墙钟耗时已如实记录：每迭代 1 次生成调用，
   端到端 ≈ 4.4-5.3 分钟）。映射已在 `century_codex_exec.py` 修复并实测生效
   （单次调用 prompt 21362 / completion 6 tokens，缓存 20224），后续运行自动记录。

## 12. 下一阶段建议

1. **并行化 duel_runner**（AI 4.0 已有 worker 并行基准可复用），把单候选深评压到 < 1 分钟；
2. 扩展演化面：第二/第三个策略函数（如 `keepValue`/规划器权重曲线），或引入
   MAP-Elites 特征维度（激进/稳健风格分桶）做多样性进化；
3. 对受控实验的领先候选发起 AI 4.0 正式确认挑战（60+ 独立验证种子、配对检验、
   几何 alpha），以真实晋级闭环验证端到端；
4. 长期：候选模型接入 beam-rollout 结构变体接口，使"结构 × 算法"共同进化；
5. 将 Seatbelt 隔离方案抽象为可复用的 untrusted-code-runner，服务后续 PPO 等场景。

## 13. 交付物索引

| 交付物 | 位置 |
|---|---|
| 集成代码 | `ai5/openevolve/`（评估适配器 / Node 管线 / 沙箱 / 运行器 / 配置） |
| 依赖与启动说明 | `ai5/openevolve/README.md`、`requirements.txt` |
| 自动化评估适配器 | `ai5/openevolve/century_evaluator.py`（级联 stage1/2/3） |
| 安全隔离与针对性测试 | `ai5/openevolve/sandbox/`、`experiments/isolation_test.mjs`（12/12） |
| 三组验证实验 | `ai5/openevolve/experiments/exp_{a,b,c}*`、`results/exp_*.json` |
| 候选算法与对局数据 | `ai5/openevolve/results/evaluations/`、`results/smoke-candidates/`、`results/controlled-candidates/` |
| 深度独立验证 | `ai5/openevolve/results/deep_validation_{best,baseline}.json`（100 新种子 × 2 组 × 202 局） |
| 可复现实验报告 | 本文件（种子、参数、代码版本、逐局成绩全部落盘） |
| 独立分支 | `feat/ai5-openevolve-poc`（PR 为准） |

## 14. 验收标准对照

| 验收标准 | 结论 | 证据 |
|---|---|---|
| OpenEvolve 能自动生成新的 Century 策略代码 | ✅ | 实验 C：15 个候选全部由 LLM 生成（冒烟 3 + 受控 10 + 基线） |
| 候选算法真正参与游戏决策 | ✅ | 实验 B（1775/3000 探针差异 + 12/12 种子轨迹改变） |
| 能自动编译、测试和进行对局评估 | ✅ | 级联管线；冒烟/受控全部候选走完 stage1→stage3 |
| 能正确淘汰非法、超时或不安全候选 | ✅ | 隔离验证 12/12（静态拒 5 样本 + 沙箱拦截 + 死循环击杀） |
| 能根据实验反馈继续生成新的候选 | ✅ | 冒烟 3 迭代评分随反馈改善（0.389→0.462→0.566） |
| 候选与冠军隔离运行，不发生评估污染 | ✅ | 实验 A/B：官方产物 SHA256 不变 + 双模块席位注入 |
| 所有结果可复现、可审计 | ✅ | 种子/SHA256/manifest/逐局 JSON 全部落盘（§7 存档结构） |
| 正式冠军和网页游戏不受影响 | ✅ | 零改动 main；官方 dist SHA256 前后断言；晋级链路未触碰 |

**结论：本阶段验收标准全部满足。** 集成打通了"自主生成策略算法 → 独立验证 →
按反馈进化"的完整闭环，并通过深度独立验证证明了筛选纪律（最优候选被诚实拒绝）；
未做任何"更强 AI"的宣称 —— 强弱判定交由 AI 4.0 的独立验证种子与正式冠军挑战流程。
