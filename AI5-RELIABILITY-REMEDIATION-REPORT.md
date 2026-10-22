# AI 5.0 双轨系统可靠性整改与独立验证报告

> 分支：`feat/ai5-goal-remaining-variant`（基于 main @ a6c3de3，PR #14/#15 合并后）
> 日期：2026-10-22
> 范围：PR #14（MLP+PPO）与 PR #15（OpenEvolve）合并后的 main 全量审查与整改
> 纪律：P0 数据可信性 → P1 训练可靠性 → CI 自动验证；本阶段不以提高胜率为目标；
> 全部工作在独立分支进行，不动 main、不动正式冠军、不动网页 UI 与游戏规则。

---

## 一、缺陷清单

| # | 严重度 | 缺陷 | 根因 | 位置 |
|---|---|---|---|---|
| D1 | **P0/严重** | OpenEvolve 深度独立验证 101 个配对样本全部使用同一种子 300001000，"100 新种子独立验证"结论失真 | ① 会话期临时种子生成器只产出 1 个种子值并以 `%g` 类浮点格式（`3.00001e+08`）写文件（未入库、无校验）；② `duel_runner.mjs loadSeeds()` 用 `Number()` 解析，静默接受科学计数法且无重复检测；③ `pairedPromotionDecision` 把同值配对当独立样本算 Wilson 区间 | [duel_runner.mjs](ai5/openevolve/node/duel_runner.mjs)（旧版 loadSeeds）、[stats.mjs](training/evaluator/stats.mjs)、种子文件留档 [deep-seeds.txt](ai5/openevolve/results/audit/deep_validation_v1_invalid/deep-seeds.txt) |
| D2 | **P0/严重** | PPO 训练种子派生覆盖 `[0, 2^31)` 全域：约 7% 落入验证池区间 [900M, 1.06e9) | `derive_seed()` 无区间约束 | [collector.py 旧版 derive_seed](ai5/ppo/training/collector.py#L276)（审计证据见 [seed-pollution-audit.json](ai5/ppo/reports/seed-audit/seed-pollution-audit.json)） |
| D3 | **P0/高** | AI5 arena 验证池账本分配为裸读-改-写，无锁——并发进程会分出重叠块（验证种子重复消费） | `allocate_validation_block` 无互斥 | [arena.py](ai5/ppo/evaluation/arena.py)（旧版） |
| D4 | **P0/高** | OpenEvolve 注释与 README 声称"所有阶段都经 Seatbelt 沙箱"，但 static_check / assemble / tsc 三个前置步骤未用 `sandbox-exec` | 沙箱化只覆盖了 probe/duel | [century_evaluator.py](ai5/openevolve/century_evaluator.py)（旧版 `_run_static`/assemble/tsc 调用） |
| D5 | **P1/高** | PPO 断点恢复不完整：三套全局 RNG（Python/NumPy/PyTorch）、gameCounter/decisionCounter、累计指标、快照池均未恢复——恢复后训练种子从头重放、采样序列分叉、对手池丢失 | 检查点缺字段；`SnapshotPool.restore` 从未被调用 | [train_cli.py](ai5/ppo/training/train_cli.py)（旧版）、[collector.py](ai5/ppo/training/collector.py) |
| D6 | **P1/高** | 跨迭代 on-policy 违规风险：未完成对局的旧策略转移跨过 PPO 更新边界，与新策略转移同链进入下一次更新（logp/价值来自两个策略） | `collect()` 不等在途对局终局即返回；缓冲无策略世代标记 | [collector.py collect()](ai5/ppo/training/collector.py)、[rollout.py](ai5/ppo/training/rollout.py) |
| D7 | **P1/高** | 对手池退化：所有快照席位经 `"snap"` 别名永远指向最新快照，历史快照池形同虚设 | `SnapshotPool.push` 每次覆盖别名；席位布局无占位解析机制 | [train_cli.py 旧版 SnapshotPool](ai5/ppo/training/train_cli.py) |
| D8 | **P1/中** | arena 统计把同种子的多旋位对局当独立样本算 Wilson 区间（方差低估、显著性虚高）；异常局不影响验收结论 | 统计聚类单位错误 | [arena.py 旧版 summarize](ai5/ppo/evaluation/arena.py) |
| D9 | **P1/中** | `--sampled` 从未生效：只切换 `bundle.sample` 标志，`play_setup` 仍无条件 argmax | 标志未接入决策路径 | [arena.py 旧版 play_setup](ai5/ppo/evaluation/arena.py) |
| D10 | **P1/中** | 辅助奖励启用后终局结算链断裂：collector 恒调 `finish_game`（内部对 aux 启用直接抛错），`claimed` 恒 0，`finish_game_full` 从未被调用；bridge 协议终局消息不含逐席位 claimed | 协议缺字段 + 调用方未接线 | [env_worker.mjs terminal()](ai5/ppo/bridge/env_worker.mjs)、[collector.py](ai5/ppo/training/collector.py) |
| D11 | **P1/低** | arena 账本 `challengeCount` 把训练块也计入确认挑战次数 | 计数口径错误 | [arena.py](ai5/ppo/evaluation/arena.py) |
| D12 | **P1/低** | arena 训练池分配从 5M 起步，与 AI4 进化区 [0, 300M) 簿记重叠 | 历史约定区过宽 | [arena.py](ai5/ppo/evaluation/arena.py) |

## 二、修复记录（修改前后行为 + 回归测试证据）

### D1 种子重复（P0 任务 1）

**调用链追踪**：临时种子生成器（未入库）→ `work/deep-seeds.txt`（101 行同值
`3.00001e+08`）→ 旧版 `loadSeeds()` `Number()` 解析 → `duel_runner` 逐种子双向对局
→ `pairedPromotionDecision`。根因在生成与解析两端的防御同时缺失。

**修复**（全部入库，不再依赖会话期临时脚本）：
- 新增 [ai5/lib/seed_policy.mjs](ai5/lib/seed_policy.mjs) / [seed_policy.py](ai5/lib/seed_policy.py)：
  AI5 种子全局布局唯一权威定义（两侧常量由单元测试逐值比对），`parseSeedList`
  强制严格十进制整数（拒绝科学计数法/浮点/正负号）、区间校验、唯一种子强制；
- [duel_runner.mjs](ai5/openevolve/node/duel_runner.mjs)：`loadSeeds()` 改走
  `parseSeedList`；输出显式记录 `config.uniqueSeedCount` 与 `stats.uniqueSeedCount`；
- [stats.mjs](training/evaluator/stats.mjs)：`pairedPromotionDecision` 对重复配对种子
  直接抛错（AI4 既有测试 32/32 通过，无回归）；
- 新增入库验证器 [deep_validation.py](ai5/openevolve/deep_validation.py)：flock 账本
  原子领种 → 纯整数种子文件写入 + 读回校验 → 沙箱对局 → 统计汇编
  （统计口径完全复用 stats.mjs，未改动任何判定标准）。

**回归测试**：[seed-policy.test.mjs](ai5/openevolve/tests/seed-policy.test.mjs) 9/9
（含"101 行科学计数法必须被拒"的事故根因回归用例）。

### D2/D3/D11/D12 种子隔离与账本原子性（P0 任务 2）

**修复**：
- `derive_seed()` 收敛到 PPO 训练专用子块 **[300_100_000, 350_000_000)**（(raw+salt)
  mod 块大小 + 基址，任何参数组合不可能越界）；旧公式保留为 `derive_seed_legacy`
  仅供审计；
- AI5 种子布局（seed_policy 双侧）：AI4 进化 [0,300M) ｜ OpenEvolve stage2/stage3/
  深度验证 [300M, 300.1M)+[300.001M, 300.002M) ｜ PPO 训练 [300.1M, 350M) ｜
  AI5 评测训练池 [350M, 400M) ｜ AI4 基准 [400M, 900M) ｜ 验证池 [900M, 1.06e9)；
- `allocate_validation_block` 全程 flock 独占锁（[arena.py](ai5/ppo/evaluation/arena.py)），
  锁内重做防重断言；`challengeCount` 只计验证条目；训练池下界提至 350M。

**历史污染审计**（[audit_seed_pollution.py](ai5/ppo/reports/seed-audit/audit_seed_pollution.py)，
证据 [seed-pollution-audit.json](ai5/ppo/reports/seed-audit/seed-pollution-audit.json)）：
用保留的旧公式重放全部历史训练运行逐局种子：
- run-main-001（3,138 局）：218 个种子落入验证池**区间**（完整性受损），
  **与已消费验证块零碰撞**；
- run-scenB-20it（1,270 局）：115 个落入区间，已消费块零碰撞；
- OpenEvolve 评测种子（stage2/stage3/深度验证）：历史训练零碰撞。
**结论**：既有验证报告（arena-run-main-001-validation 等）未被污染、无需作废；
验证池完整性受损已通过收敛 derive_seed 根治，空洞不再扩大。

**回归测试**：`test_derive_seed_confined_to_training_block`（5 组 run_seed × 2000 局 ×
3 种 salt 全部落在子块内）、`test_training_seeds_disjoint_from_reserved_zones`
（20k 种子与验证池/OpenEvolve 块零交集）、`test_concurrent_allocation_never_overlaps`
（8 线程并发分配无一重叠，旧实现此处必然失败）。

### D1 收尾：v1 结论废止 + v2 重验（P0 任务 1 第 7-9 项）

- v1 数据归档为审计证据：[results/audit/deep_validation_v1_invalid/](ai5/openevolve/results/audit/deep_validation_v1_invalid/)（含废止声明 README 与原始种子文件）；
- 原种子 300001000 在账本占位（`deep-validation:v1-invalid`），永不复用；
- v2 验证（100 个**唯一种子**，账本块 [300001003, 300001103)，404 局，0 异常）：

| 组 | 唯一种子 | 局数 | 逐种子平均分差 | 配对得分优势率（95% CI） | 判定 |
|---|---|---|---|---|---|
| 最优候选 66f6a296aa72 vs 冠军 | **100** | 200 | **+0.425** | 0.608（[0.471, 0.730]） | **inconclusive**（区间跨 0.5） |
| 官方基线 vs 冠军（同种子对照） | 100 | 200 | 0（精确） | —（决定性种子 0） | 席位公平性确认 |

**关键修正**：v1 的"候选劣势 rejected（CI 上界 0.037）"是单种子伪影——真实
100 种子下候选呈轻微正优势但不确定（tie 率 0.49）。**统计判定标准一字未改**
（同一 `pairedPromotionDecision`、同一 z=1.96），只是换上了干净数据。
两版结论均不构成晋级依据：候选仅登记为实验版本，晋级永远走 AI4 正式挑战流程。

> **与正式挑战结论的关系**：该候选此前已按 AI4 惯例以 `goal-remaining` 变体
> 走完正式 60 种子确认挑战（验证种子块 [941500092, 941500152)，challengeIndex=6，
> 120 局 0 异常，判定 insufficient → 保留冠军）。本 v2 验证只使用 AI5 深度验证
> 子块 [300001003, 300001103)，**不消耗、不覆盖、不推翻**验证池账本与正式挑战
> 结论——两者种子块、检验语义（alpha 消耗）与用途均不同：v2 是 AI5 侧的
> 管线可信性修复验证，正式晋级判定仍以 AI4 挑战流程为准。

### D5/D6 断点恢复与 on-policy 边界（P1 任务 3）

**修复**（[train_cli.py](ai5/ppo/training/train_cli.py)、[collector.py](ai5/ppo/training/collector.py)、[rollout.py](ai5/ppo/training/rollout.py)）：
- 检查点新增：Python/NumPy/PyTorch 三套 RNG 状态、collectorMetrics 全量累计指标、
  bufferStats、policyEpoch；恢复链调用 `restore_rng` + `SnapshotPool.restore`（旧版从未调用）+
  `collector.restore_state`（计数器/指标续接，训练种子不再从头重放）；
- 旧格式检查点无 rng 字段 → 降级为重新播种并显式告警（不静默）；
- **on-policy 迭代边界（安全迭代边界方案）**：`collect()` 末尾排水——达到目标后
  不再派发新局，等全部在途对局终局并结算完毕才返回；PPO 更新与检查点只发生在
  排水后的干净边界。**不序列化进行中对局**（无法可靠序列化 Node 侧引擎状态），
  以"迭代边界无在途对局"保证更新批内每条轨迹完全由当前策略采集；
- 纵深防御：每条转移带 `policy_epoch` 世代标记，混代轨迹整体丢弃并计数
  （`stats.stale_discarded`），随 metrics.jsonl 披露——若排水边界被绕过，
  数据被丢弃而不是污染更新。

**验收（可实现确定性级别：CPU 下逐位一致）**：
[TestResumeDeterminismE2E](ai5/ppo/tests/python/test_training_reliability.py) 用真实
Node worker + 官方引擎 + 冠军对手对比"连续 4 迭代"与"2 迭代中断 + 恢复续 2 迭代"：
- 最终模型哈希逐位一致；
- totals（decisions/games/updates）一致；
- 逐迭代 metrics（decisionsTotal/gamesTotal/samples/entropy）一致。
**声明**：该确定性在 CPU 设备、固定 worker 数下成立；MPS/GPU 浮点非确定性
（归约顺序）可能破坏逐位一致，属设备语义，不属恢复缺陷。

### D7 对手池（P1 任务 4）

**修复**：席位布局改用 `"snapshot"` 占位；`Collector._launch_game` 派发时按
`resolve_snapshot_seat` 解析为池内具体快照 id——`rotate`（默认，轮转保证均匀覆盖）、
`random`（(run_seed, game_index) 确定性派生）、`latest`（旧行为兼容）；`"snap"`
别名废除（配置中显式报错）。快照策略身份保留（policy_id=snap-XXXXXX ≠ learner，
rollout 按 id 过滤，绝不混入 learner 缓冲）；每轮不同快照的实际出场次数记录在
`metrics.opponentAppearances` 并写入 metrics.jsonl。

**回归测试**：rotate 轮转 4 快照 × 8 局各出场 2 次（防退化覆盖测试）、random 确定性、
空池报错、push/淘汰/恢复往返一致、快照轨迹不进 learner 缓冲（身份保持）。

### D8/D9/D10 竞技评估与奖励（P1 任务 5）

**修复**（[arena.py](ai5/ppo/evaluation/arena.py)、[env_worker.mjs](ai5/ppo/bridge/env_worker.mjs)）：
- **种子聚类统计**：逐局记录（seed/opponent/rotation/win/rank/score）落盘；
  汇总以唯一种子为统计单位（同 seed 跨旋位对局为相关样本，按 seed 聚类后对
  seed 层做正态近似区间）；局级 Wilson 区间降级为诊断披露；
- **异常局影响验收**：异常率 > 2% → 该对手结论 `invalid`；独立种子 < 30 →
  `insufficient`；判定分级 better/inconclusive/worse 全部基于种子聚类区间；
- **`--sampled` 修复**：`sampled_decide` 与训练采集同一 softmax 采样实现，
  rng 由 (种子, 全局决策序号) 确定性派生，贪心/采样路径由参数真实切换；
- **辅助奖励结算链**：bridge terminal 逐席位回传 `claimed`（终局与异常局一致口径）→
  collector 组装 final_states → aux 启用时调 `finish_game_full`（旧版恒 0 且从不调用）。

**回归测试**：混代轨迹丢弃/纯世代保留、`finish_game_full` claimed 数值进入回报、
aux 启用时 `finish_game` 抛错（防御仍在）、检查点 RNG 往返逐位一致、
旧格式检查点优雅降级。

## 三、验证报告（v2 深度独立验证）

见上文"D1 收尾"。数据可信性要点：
- 唯一种子数 **100**（真实值，账本 [300001003, 300001103) 原子分配留痕，
  [deep-validation-ledger.json](ai5/openevolve/results/deep-validation-ledger.json)）；
- 独立性：种子文件读回校验 + `parseSeedList` 唯一性强制 + `pairedPromotionDecision`
  重复抛错（三层防御）；
- 对局：2 × 200 局，异常 0；决策延迟与 v1 同量级；
- 置信区间：候选配对得分优势率 0.608，95% CI [0.471, 0.730] → inconclusive；
  基线对照分差精确 0（席位公平性机制确认）；
- 判定：**不晋级、不宣称更强**；v1 的 rejected 结论废止（单种子伪影）。

## 四、训练可靠性报告

| 项 | 结论 |
|---|---|
| 断点恢复完整性 | 模型+优化器+三套 RNG+双计数器+快照池+累计指标全部恢复；旧格式检查点显式降级告警 |
| 确定性级别 | CPU、固定 worker 数下**逐位一致**（端到端对比测试通过）；GPU/MPS 不承诺逐位一致 |
| on-policy 边界 | 迭代边界排水（无在途对局跨更新）+ 世代标记混代丢弃（纵深防御，计数披露） |
| 历史对手池 | rotate 轮转覆盖全部池内快照，出场次数逐轮披露；别名退化机制已废除 |
| 统计单位 | arena 以唯一种子为聚类单位；异常率门限进入验收结论 |
| AI4 正式冠军 | 未触碰 champion.json / parameters.ts / 挑战流程 / 验证账本；AI4 全量测试通过（见 CI 报告） |

## 五、CI 报告

新增 [\.github/workflows/ai5.yml](.github/workflows/ai5.yml)，6 个作业：

| 作业 | Runner | 内容 |
|---|---|---|
| ppo-python-tests | ubuntu | PPO 单元（GAE/PPO/奖励/softmax/种子约束）+ 训练可靠性单元（对手池/on-policy/RNG）+ **断点恢复确定性端到端**（真实 Node worker） |
| node-tests | ubuntu | 编码/枚举合法性/信息公平性/worker 协议（17 用例） |
| seed-discipline | ubuntu | 种子解析严格性/重复拒绝/区间布局（Node）+ 账本原子性/并发分配/隔离验收（Python） |
| openevolve-static-security | ubuntu | 恶意样例静态拦截 + EVOLVE-BLOCK 成对性 + 牌库字段访问拒绝 |
| macos-seatbelt | **macos-14** | Seatbelt 全链路：沙箱化 stage1 对合法候选放行、恶意样例拒绝、死循环超时淘汰、HOME 探针读拒绝/越界写拒绝/联网 EPERM 拒绝 |
| e2e-smoke | ubuntu | duel_runner 官方自对照冒烟（4 唯一种子，0 异常，分差必须为 0） |

- 任何关键测试失败 → 工作流失败（GitHub Actions 默认语义，未用 continue-on-error）；
- Seatbelt 验收只在 macOS Runner 执行；Linux 测试通过**不**冒充 Seatbelt 验证；
- **CI 实测结果（PR #17 全部作业通过，6/6）**。CI 首跑暴露了 4 个本机无法
  发现的环境缺陷，逐轮修复（这正是 CI 的价值）：
  1. macOS Runner 的 node 在 `/opt/hostedtoolcache`（非 `/usr/local/bin`）——
     SANDBOX_ENV PATH 改为 `shutil.which('node')` 实时解析；
  2. Runner 检出位于 HOME 内（`/Users/runner/work/...`），`deny file-read* HOME`
     连 node 启动的 `uv_cwd` 都会 EPERM——沙箱 cwd 移出 HOME + 显式放行读检出目录；
  3. node 解析主模块需对 HOME 本身 `lstat`（`syscall=lstat path=/Users/runner`
     EPERM）——HOME 拒绝细化为 `deny file-read-data`（内容/目录列举），
     元数据放行；`~/.codex`、`~/.ssh` 等密钥内容仍不可读（安全目标不变）；
  4. macOS 作业缺 web-v1 依赖与 dist 产物（tsc / 探针对照所需）——补
     `npm install && npm run build`。
  上述沙箱 profile 语义变更均以属性测试固化（HOME 探针文件读拒绝、
  WORKROOT 写/仓库读放行、越界写拒绝、联网 connect EPERM 拒绝）；
- 本地实测结果：
  - PPO Python 单元 + 种子政策：25/25；
  - 训练可靠性单元：12/12；断点恢复端到端：1/1（22s）；
  - Node 协议/编码/公平性：17/17；种子政策 Node：9/9；静态安全层：4/4；
  - Seatbelt 安全验收（本机 macOS）：6/6（11s）；
  - AI4 回归：training/tests 全量通过（stats.mjs 加固无回归）。
- **并行会话隔离教训**：整改期间检测到并行 OpenEvolve 会话
  （`run_openevolve.py --iterations 20`）与本仓库共享 work root，曾把安全测试
  遗留的候选文件纳入其评估队列并重写 `results/evaluations/9329531df196/` 归档
  （已 `git checkout` 还原，该目录为并行会话产物不纳入本 PR）。据此为全部安全
  测试增加**隔离临时 WORK_ROOT**（setUpClass 打补丁 + 沙箱 profile 同步隔离），
  测试不再与任何并行评估共享工作区。

## 六、交付物与证据索引

| 证据 | 路径 |
|---|---|
| v1 废止声明与原始数据 | [ai5/openevolve/results/audit/deep_validation_v1_invalid/](ai5/openevolve/results/audit/deep_validation_v1_invalid/README.md) |
| v2 深度验证（候选） | [deep_validation_v2_best.json](ai5/openevolve/results/deep_validation_v2_best.json) |
| v2 深度验证（同种子基线） | [deep_validation_v2_best_baseline.json](ai5/openevolve/results/deep_validation_v2_best_baseline.json) |
| 深度验证种子账本 | [deep-validation-ledger.json](ai5/openevolve/results/deep-validation-ledger.json) |
| 历史种子污染审计 | [seed-pollution-audit.json](ai5/ppo/reports/seed-audit/seed-pollution-audit.json)（脚本 [audit_seed_pollution.py](ai5/ppo/reports/seed-audit/audit_seed_pollution.py)） |
| 种子政策（双侧） | [seed_policy.mjs](ai5/lib/seed_policy.mjs) / [seed_policy.py](ai5/lib/seed_policy.py) |
| 回归测试 | [seed-policy.test.mjs](ai5/openevolve/tests/seed-policy.test.mjs)、[static-check.malicious.test.mjs](ai5/openevolve/tests/static-check.malicious.test.mjs)、[test_security_sandbox.py](ai5/openevolve/tests/test_security_sandbox.py)、[test_seed_policy.py](ai5/ppo/tests/python/test_seed_policy.py)、[test_training_reliability.py](ai5/ppo/tests/python/test_training_reliability.py) |
