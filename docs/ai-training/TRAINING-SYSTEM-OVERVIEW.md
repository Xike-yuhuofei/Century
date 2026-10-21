# Century AI 4.0 训练进化系统概览

> 更新日期：2026-10-21（本地链路验证完成后的快照）

## 一、系统定位

与正式网页游戏**共用同一份 AI 决策核心编译产物**（`web-v1/dist/js`）的离线训练基础设施。
通过大量自对战、参数进化与统计检验，筛选**统计显著更强**的 AI 参数/结构，
而不是制造噪声式"进步"。云端 GitHub Actions（`ai-training.yml`）只承担
"定时调度 + 状态中转（artifact）"，**算力完全在本地**——本系统是纯 Node.js（≥ 20）离线运行，无 GPU、无外部 API。

## 二、目录结构

```
training/
├── simulator/    五人自动对战模拟器（固定种子、逐席位版本注入、异常隔离）
├── tournament/   冠军挑战（双向混战 + 座位轮换 + 配对种子 + 按种子配对统计检验）
├── optimizer/    参数进化（(μ,λ) 进化策略、断点续训、真实时间预算、多样化对手池）
├── evaluator/    统计工具（Wilson CI、配对晋级判定）与性能基准
├── diagnostics/  失败案例分析（确定性重放 + 事实/启发/推测分层）
├── champions/    当前冠军（champion.json）与历史候选（candidates/）
├── configs/      训练配置样例
├── lib/          公共工具（rng / io / paths / 对手池 / 验证种子账本）
├── reports/      运行产物（state.json / report.json / experiments.jsonl / validation-ledger.json）
├── tests/        训练系统自动化测试（含 CLI 端到端与晋级脚本测试）
└── scripts/      冠军晋级（promote-champion）与参数落地（apply-champion）
```

## 三、核心机制

### 3.1 版本与参数

一个"版本" = 8 个决策乘子（`engineWeight / tempoWeight / contestWeight /
synergyWeight / goalWeight / capacityWeight / restWeight / endgameWeight`，1.0 = 基线）
+ 可选 `structure` 字段（如 `beam-rollout`）。模拟器按席位注入版本，
席位 0 的人类由中立代理（全乘子 1.0）替代，席位 1–4 按正式游戏规则显式注入
四种人格——训练环境与正式对战逐席对齐。

### 3.2 进化流程（evolve-cli）

```
进化（训练种子，(μ,λ) 策略）
  → 快速筛选：胜率 > 0.5 才算 improved
  → 确认挑战（独立验证种子，冠军独占对手，双向 1席↔4席 × 座位轮换）
  → 配对统计检验（pairedPromotionDecision）
  → 达标输出 candidate.json → promote-champion.mjs → apply-champion.mjs → PR
```

- **时间预算**：`--time-budget-min` 拆分为进化预算与确认挑战预留，按墙钟安全退出；
  未完成候选丢弃，最后完整代状态落盘，下次 `--resume` 续训。
- **断点续训**：`state.json` 保存种子游标、精英池与世代状态；CLI 每代结束即落盘。
- **训练种子块分配**（P0 整改）：`--seed-base` 为训练池内绝对种子起点（块对齐），
  每候选固定预留 1000 种子块，全部落在 `[0, 900M)` 内、互不重叠、越界抛错；
  候选生成 rng 与游戏种子分流（`rngCursor`/`seedCursor`）；旧断点自动迁移。
- **对手池**：默认冠军本体 + 中立基线 + 冠军风格变体 + 历史冠军归档轮转
  （按 `(种子序×(池大小−1)+席位) mod 池大小` 完全可复现，任何池大小逐种子轮换）；
  `--pool-size 1` 退化为仅冠军。

### 3.3 晋级规则（不可协商）

1. 训练种子快速筛选胜率 > 0.5；
2. 独立验证种子确认挑战（训练/验证种子池物理隔离：训练 < 900M ≤ 验证，且全部 ≤ 2^31−1）；
3. 统计量是**配对得分优势率**（不是先名率），其 CI 下界 > 0.5 且异常率 ≤ 2% 才晋级；
   检验阈值按**几何 alpha 消耗**随挑战次数收紧（第 k 次挑战单侧 α_k = 5%/2^k，
   k 来自验证账本 challengeCount）——长期家族误晋级率上界恒为 5%，
   反复挑战无法"磨"出侥幸晋级；
4. 真实第一名率由 `summary.firstPlace` 披露；平均分更高**不构成**晋级理由；
5. 不确定（CI 跨 0.5）→ 保留冠军、增加样本；`candidate.json` 必须携带逐种子
   `seedPairs` 证据、挑战序号（challengeIndex）、alpha 预算、运行时产物指纹
   （engineBundleSha256）与代码版本（codeCommit），供 `promote-champion.mjs`
   独立重算判定、交叉核对随附账本、核对引擎指纹——缺失或不一致一律拒绝晋级。

### 3.4 种子账本与池布局（lib/seeds.mjs）

- 训练池 `[0, 900M)`（其中 `[0, 400M)` 日常进化、`[400M, 900M)` 基准评测约定区）；
  验证池 `[900M, 1.06e9)`——两池物理隔离，训练种子永不越界（越界抛错）；
- 确认挑战每次消耗一个互不重叠的验证种子块（基数 900,000,000，步长 2,000）；
- 账本无条件落盘（即使本次无挑战也原样续写，防止断链后重复消费）；
- 下一次起点 = 全部已消费块的最高末端 + 步长（不只看 lastBase）；
- 拟消费块与任何历史块重叠时**直接抛错拒绝挑战**；
- 种子池上限 1.06e9（< 2^31），引擎 generator 的 `seed >>> 0`（mod 2^32 回绕）
  不会影响任何已分配种子；模拟器对 ≥ 2^31 的种子直接拒绝；
- `challengeCount` 随每次确认挑战递增，是多重检验 alpha 消耗的挑战序号来源。

### 3.5 信息公平性（不可妥协）

- AI 决策只消费 `AIObservation`（仅公开信息、深度冻结）；
- `src/ai/**` 对隐藏牌库字段的引用为零（静态扫描测试强制）；
- 隐藏牌库顺序随机化不变性测试保证：公开信息一致 ⇒ 决策一致。

## 四、性能参考（M2 本地实测）

| 指标 | 数值 |
| --- | --- |
| 单步决策（均值 / 峰值） | 11.9 ms / 71 ms |
| 单局（5 AI，约 171 步） | ≈ 2.0 s |
| 单核吞吐 | ≈ 1760 局/小时 |

## 五、当前状态（2026-10-21）

### 5.1 当前冠军

- **id**：`struct-beam-rollout`（蒙特卡洛 rollout 结构版，决策质量分 = 0.7 解析先验 + 0.3 模拟实际得分）
- **晋级证据**（PR #11）：两轮共 1200 局配对挑战；确认挑战 300 种子先名率 0.634，
  95% CI [0.578, 0.687] 下界 > 0.5；beam-adaptive 变体同轮 inconclusive 落选。
- 所有 8 个乘子均为 1.0——纯结构晋级，参数未被改动。

### 5.2 本地链路验证结果

| 轮次 | 配置 | 结果 |
| --- | --- | --- |
| 冒烟一 | gen 1 × pop 4 × 4 局，6 确认种子 | 86 s 跑通；快速筛选 0.625 → 确认挑战 inconclusive，保留冠军 |
| 冒烟二 | + `--resume` + `--seed-ledger` | 断点正确续接 gen 2；种子块无重叠推进（941494000 → 941496006） |
| 正式轮 | gen 3 × pop 8 × 20 局，80 确认种子 | 32.7 min；4 个世代最佳胜率钉在 0.625（平台期）；160 局确认挑战胜率 0.4625、优势率 CI [0.379, 0.596] 跨 0.5 → inconclusive |

**结论**：冠军稳固；参数维度连续 4 代无突破，当前结构下决策乘子接近收敛；
统计检验严格把关，训练筛选通过 ≠ 真实更强（0.625 筛选胜率的候选确认挑战仅 0.4625）。

### 5.3 已知遗留项

- 真人竞技优势验证、手机端决策延迟实测、GitHub Pages 线上版本核验。
- ~~长期重复挑战误晋级控制~~：已在 2026-10-22 可靠性整改中解决
  （几何 alpha 消耗 + 账本 challengeCount，见 RELIABILITY-FIX-20261022.md）。

## 六、下一步方向（按性价比排序）

1. **beam-adaptive 结构变体再战**（零代码）：上次 300 种子 inconclusive 只说明差距在噪声边缘；
   用账本新种子块 + 更大样本（≈500 种子）重跑确认挑战。
2. **rollout 混合比参数化**（小改动，潜力最大）：把写死的 `0.7 解析 + 0.3 模拟` 权重
   升级为第 9 个进化参数——给进化器一个真梯度维度，直接控制"信先验还是信模拟"。
3. **rollout 算力维度**：beam 宽度、rollout 步数参数化，用算力换决策质量。

## 七、常用命令

```bash
# 前置：构建决策核心（训练系统不做任何算法复制）
cd web-v1 && npm install && npm run build

# 日常本地进化（断点续训 + 种子账本续接，种子永不复用）
cd training
npm run evolve -- --generations 3 --population 8 --time-budget-min 45 \
  --seed-base $(date +%Y%m%d) \
  --resume reports/evolve-latest/state.json \
  --seed-ledger reports/evolve-latest/validation-ledger.json

# 其他
npm run simulate -- --games 100 --seed-base 1   # 快速评估
npm run perf                                     # 性能基准
npm run challenge -- --champion champions/champion.json \
  --candidate reports/evolve-latest/candidate.json --seeds 60
npm run diagnose -- --seeds 8                    # 失败案例分析
npm test                                         # 训练系统测试
```

注意：端到端测试须显式传小种子参数（`--confirm-seeds`/`--min-seeds`），
否则默认 80 确认种子会触发 160 局挑战，把用例拖到分钟级。

## 八、冠军落地流程

```
确认挑战通过 → candidate.json
  → promote-champion.mjs（归档候选 + 同步 champion.json）
  → apply-champion.mjs（写 web-v1/src/ai/parameters.ts 生成区）
  → 全量测试 + apply-champion --check 终检 → PR → 人工评审合并
```

- champion.json 与 web-v1 参数区在晋级时同步更新，下一轮进化以新冠军为基准；
- `web-v1/tests/ai-fairness.test.mjs` 强制校验两者逐字段一致；
- 冠军切换后 evolve 按 `championFingerprint` 强制失效旧精英池；
- 永不直接提交 main，所有算法升级走 PR。
