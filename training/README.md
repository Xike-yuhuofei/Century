# Century AI 4.0 自动进化训练系统

与正式网页游戏**共用同一份 AI 决策核心编译产物**（`web-v1/dist/js`）的离线训练基础设施。
通过大量自对战、参数进化与统计检验，持续筛选真正更强的 AI 参数，而不是制造噪声式"进步"。

## 前置条件

```bash
# Node ≥ 20；首次使用先构建决策核心（训练系统不做任何算法复制）
cd web-v1 && npm install && npm run build
```

## 目录结构

```
training/
├── simulator/    五人自动对战模拟器（固定种子、逐席位版本注入、异常隔离）
├── tournament/   冠军挑战（双向混战 + 座位轮换 + 配对种子 + 按种子配对统计检验）
├── optimizer/    参数进化（(μ,λ) 进化策略、断点续训、真实时间预算、多样化对手池）
├── evaluator/    统计工具（Wilson CI、配对晋级判定）与性能基准
├── diagnostics/  失败案例分析（确定性重放 + 事实/启发/推测分层）
├── champions/    当前冠军参数（champion.json）与历史候选（candidates/）
├── configs/      训练配置样例
├── lib/          公共工具（rng / io / paths / 对手池 / 验证种子账本）
├── reports/      运行产物（summary.json / report.md / experiments.jsonl）
├── tests/        训练系统自动化测试（含 CLI 端到端与晋级脚本测试）
└── scripts/      冠军晋级（promote-champion）与参数落地（apply-champion）
```

## 快速开始

```bash
cd training

npm run simulate -- --games 100 --seed-base 1   # 100 局快速评估
npm run perf                                     # 性能基准（单步/单局/每小时局数）
npm run challenge -- --champion champions/champion.json \
  --candidate reports/evolve-latest/candidate.json --seeds 60
npm run evolve -- --generations 3 --population 8 --time-budget-min 40
npm run diagnose -- --seeds 8                    # 失败案例分析
npm test                                         # 训练系统测试
```

## 核心概念

### AI 版本与参数

一个"版本" = 一组 8 个决策乘子（`engineWeight / tempoWeight / contestWeight /
synergyWeight / goalWeight / capacityWeight / restWeight / endgameWeight`，默认 1.0 =
基线行为）。模拟器按席位注入版本：

```js
simulateGame({ seed: 42, versions: [
  { id: 'champion', parameters: champion },   // 席位 0（训练中人类席位由 AI 代理）
  { id: 'candidate', parameters: candidate }, // 席位 1
  null, null, null,                           // 其余席位用当前激活参数
] });
```

### 席位人格映射（与正式游戏逐席一致）

正式游戏中 `profileFor` 只统计 isAI 玩家：席位 1-4 依次获得
引擎大师/速攻专家/精算大师/战术大师四种人格。训练模拟器把席位 0 的人类替换为
**中立代理**（`NEUTRAL_PROFILE`，全部乘子 1.0），并按正式游戏结果**显式注入**席位
1-4 的人格（`seatProfile()`）——代理席不再挤占人格序号，训练环境与正式对战逐席对齐。

### 训练对手池（多样化对抗）

快速筛选默认不只用冠军当对手，而是引入对手池（`lib/opponents.mjs`）：

- 冠军本体 + 中立基线；
- 冠军的风格变体（tempo/contest/engine 加权扰动，同一决策核心）；
- `champions/candidates/` 下的**历史冠军归档**（跨版本对抗，防止只在最新版本间内卷）。

非候选席位按 `(种子序×(池大小−1)+席位) mod 池大小` 从池中轮转取对手——任何池大小下
每个席位的对手都随种子遍历全池、同局对手互不重复、双向对战同席位对手一致（完全可复现）。
晋级确认挑战保持"冠军独占对手"，保证晋级语义是"胜过当前冠军"。
`--pool-size 1` 可退化为仅冠军。

### 冠军晋级规则（不可协商）

1. 候选先在**训练种子**上通过快速筛选（胜率 > 0.5）。
2. 再在**独立验证种子**上做确认挑战：双向混战（候选 1 席 ↔ 4 席）× 座位轮换 × 配对种子。
3. 统计检验**按种子配对**：同一 seed 的双向两局共享洗牌序列，是配对样本而非独立样本；
   检验统计量是决定性种子的**配对得分优势率**（不是先名率/第一名率），只有当其
   置信区间下界 > 0.5 且异常率 ≤ 2% 才允许晋级（`pairedPromotionDecision`）。
   检验阈值按**几何 alpha 消耗**随挑战次数收紧：第 k 次确认挑战的单侧显著性
   α_k = 5%/2^k（k 来自验证账本 challengeCount），无论系统终身挑战多少次，
   家族误晋级率上界恒为 5%——长期反复挑战不会"磨"出一次侥幸晋级。
4. 决定性种子数不足 `--min-seeds`（默认 60）= 样本不足；区间跨越 0.5 = 结果不确定 →
   保留冠军，增加样本。真实第一名率由 `summary.firstPlace` 一并披露；平均分更高**不构成**晋级理由。
5. `candidate.json` 必须携带逐种子 `seedPairs` 证据 + 挑战序号（challengeIndex）+ alpha 预算 +
   运行时产物指纹（engineBundleSha256）+ 代码版本（codeCommit），供 `promote-champion.mjs`
   独立重算判定、交叉核对随附验证账本、核对引擎指纹——任何一项缺失或不一致都拒绝晋级。

### 种子策略（可复现且不重复）

- **种子全局布局**（训练/验证物理隔离，全部 ≤ 2^31−1 引擎安全上限）：
  - `[0, 900M)` 训练池——进化快速筛选用（其中 `[0, 400M)` 日常进化、`[400M, 900M)` 基准评测约定区）；
  - `[900M, 1.06e9)` 验证池——确认挑战专用。
- **训练种子块分配**：`--seed-base` 是训练池内的绝对种子起点（块对齐），每个候选
  固定预留 1000 种子的块，块互不重叠、完整落在训练池内，越界（耗尽）直接抛错而
  不是静默越过训练/验证边界；候选生成 rng 与游戏种子分流（`rngCursor` / `seedCursor`）。
- **验证种子账本**（`lib/seeds.mjs`）：确认挑战每次消耗一个互不重叠的种子块
  （基数 900,000,000，步长 2,000），账本随训练状态持久化并由
  `--seed-ledger` 续接——验证种子块绝不重复使用；`challengeCount` 记录累计挑战次数，
  作为多重检验 alpha 消耗的挑战序号。
- **断点续训**：`state.json` 保存种子游标、精英池与世代状态，`--resume` 原样续接；
  旧版断点（"游标×1000"语义，会把日期基数乘出 2^31 以上的回绕种子）恢复时自动
  迁移到新语义，迁移事件随状态落盘可审计；工作流每日自动下载上次状态 artifact、上传新状态。

### 时间预算（真实生效）

`--time-budget-min` 拆分为进化预算与确认挑战预留：进化循环按墙钟截止**安全退出**
（未完成候选丢弃，最后完整代状态照常落盘，下次续训）；确认挑战时间不足时
宁可放弃候选也不降低证据标准。

### 晋级落地流程

```
确认挑战通过 → candidate.json → promote-champion.mjs
  （归档到 champions/candidates/ + 同步 champions/champion.json）
→ apply-champion.mjs 写入 web-v1/src/ai/parameters.ts 生成区
→ 全量测试 + apply-champion --check 终检 → PR → 人工评审合并
```

champion.json 与 web-v1 参数区在晋级时**同步更新**，下一轮进化始终以新冠军为基准；
`web-v1/tests/ai-fairness.test.mjs` 强制校验两者逐字段一致。

GitHub Actions（`ai-training.yml`）会自动执行上述流程并创建 PR；合并前永远不改动 main。

## 复现实验

所有运行都由（种子 × 参数 × 代码版本）完全决定：

- 模拟器：同 seed 同 versions 逐位复现（`deterministicKey` 剔除计时字段）。
- 进化：`state.json` 保存种子游标与世代状态，`--resume` 续训；中断标记随状态记录。
- 实验日志：`experiments.jsonl` 逐候选记录参数、种子与结果。

## 性能参考（M2 本地实测，详见 reports/perf-latest）

| 指标 | 数值 |
| --- | --- |
| 单步决策（均值 / 峰值） | 11.9 ms / 71 ms |
| 单局（5 AI，约 171 步） | ≈ 2.0 s |
| 单核吞吐 | ≈ 1760 局/小时 |
| 100 / 1000 / 10000 局 | 3.4 min / 34 min / 5.7 h |

## 信息公平性约束（不可妥协）

- AI 决策只消费 `AIObservation`（仅公开信息、深度冻结）；
- `src/ai/**` 对隐藏牌库字段（`merchantDeck`/`golemDeck`）的引用为零（静态扫描测试强制）；
- 隐藏牌库顺序随机化不变性测试保证：公开信息一致 ⇒ 决策一致。
- 未来牌库期望支持度（`futureDeckSupport`）与对手需求压力（`pressureModel` 的
  mean/peak 双维度）都只来自**公开可推导**的信息：卡牌全集构成、市场可见卡与各席
  公开的手牌/打出历史，不推断任何隐藏顺序。
