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
├── tournament/   冠军挑战（双向混战 + 座位轮换 + 配对种子 + 置信区间）
├── optimizer/    参数进化（(μ,λ) 进化策略、断点续训、时间预算）
├── evaluator/    统计工具（Wilson CI、晋级判定）与性能基准
├── diagnostics/  失败案例分析（确定性重放 + 事实/启发/推测分层）
├── champions/    当前冠军参数（champion.json）与历史候选
├── configs/      训练配置样例
├── reports/      运行产物（summary.json / report.md / experiments.jsonl）
├── tests/        训练系统自动化测试
└── scripts/      冠军参数落地工具
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

策略人格（引擎大师/速攻专家/精算大师/战术大师）由席位推导，训练与正式游戏一致。

### 冠军晋级规则（不可协商）

1. 候选先在**训练种子**上通过快速筛选（胜率 > 0.5）。
2. 再在**独立验证种子**上做确认挑战：双向混战（候选 1 席 ↔ 4 席）× 座位轮换 × 配对种子。
3. 仅当先名率 **Wilson 95% 置信区间下界 > 0.5** 且异常率 ≤ 2% 才允许晋级。
4. 区间跨越 0.5 = 结果不确定 → 保留冠军，增加样本。
5. 平均分更高**不构成**晋级理由（只用于并列打破与诊断）。

### 晋级落地流程

```
确认挑战通过 → candidate.json → apply-champion.mjs 写入
web-v1/src/ai/parameters.ts 的生成区 → 全量测试 → PR → 人工评审合并
```

GitHub Actions（`ai-training.yml`）会自动执行上述流程并创建 PR；合并前永远不改动 main。

## 复现实验

所有运行都由（种子 × 参数 × 代码版本）完全决定：

- 模拟器：同 seed 同 versions 逐位复现（`deterministicKey` 剔除计时字段）。
- 进化：`state.json` 保存种子游标与世代状态，`--resume` 续训。
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
