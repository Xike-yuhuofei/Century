# Century AI 5.0 — MLP + PPO 自主强化学习系统 研发与训练报告

> 日期：2026-10-21 ｜ 分支：`feat/ai5-mlp-ppo`（独立 worktree 研发，未触碰 OpenEvolve 分支与 main）
> 基线 main：`e9fc67a`（AI 4.0 训练系统可靠性整改 #13） ｜ 报告对应最后提交：`ada4e59`（见 Git 一节）

---

## 1. 研发完成度总览

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 仓库审查 + 建分支 | ✅ 完成 | 独立 worktree + 分支 `feat/ai5-mlp-ppo`（main@e9fc67a） |
| P1 强化学习环境 | ✅ 完成 | 持久化 Node 对局宿主 + 合法行动枚举 + 编码协议；Node 测试 17/17 |
| P2 MLP 网络 | ✅ 完成 | Actor-Critic 3×256（588,418 参数），变长候选 masked softmax |
| P3 PPO 算法 | ✅ 完成 | Clipped Objective / GAE / 熵 / KL 早停 / NaN 守卫；Python 测试 22/22 |
| P4 真实自对战 | ✅ 完成 | 场景 A/B/C 配置齐备；AI 4.0 冠军作对手（`node:champion` 席位） |
| P5 训练实验 | ✅ 完成 | run-main-001：100 迭代、204,887 learner 决策、3,138 局、零异常 |
| P6 独立验证 | ✅ 完成 | 验证种子池评估 600 局 + 性能实测 + 导出一致性测试 |
| P7 交付 | ✅ 完成 | 本报告 + Draft PR |

**验收结论（任务书 14 第四阶段的三级区分，如实声明）：**

1. **模型完成训练：是。** 从随机初始化 MLP 出发的真实 Century 自对战 + PPO 更新全链路闭环，检查点保存/恢复、独立对抗验证全部完成。
2. **模型性能有提升：是（相对未训练基线）。** 对未训练 MLP 胜率 81.0%（95% CI [0.748, 0.859]），对局均分 3.0→32.8（对冠军局）。
3. **模型超过 AI 4.0 冠军：否。** 对冠军（struct-beam-rollout）胜率 1.5%（95% CI [0.005, 0.043]），远低于 0.5 的判读下界。当前训练量下明确未达到，本报告不做任何超出数据的宣称。

---

## 2. Git 信息

| 项 | 值 |
|---|---|
| 基线 main Commit | `e9fc67a58b3a3272fc29aed37bc8d21d8814be62` |
| 分支 | `feat/ai5-mlp-ppo`（从 main 新建，独立 worktree：`/Volumes/Extreme SSD/Projects/Century-ai5-ppo`） |
| 提交序列 | `accbc53` P1 桥接层 → `cb6e642` P2/P3 网络+PPO → `5cc6145` P4 训练入口 → `db3fcbb` P6 基础设施 → `ada4e59` P6 实测 |
| 隔离纪律 | 未修改 main、未触碰 `feat/ai5-openevolve-poc`（另一 Agent 的工作区原样保留）、未改动正式冠军与网页版 |

### 文件变更（全部位于 `ai5/ppo/`）

```
bridge/          env_worker.mjs / action_enum.mjs / encode.mjs / card_features.mjs（Node 侧）
env/             vec_env.py（worker 编排）
model/           actor_critic.py
training/        collector.py / rollout.py / ppo.py / rewards.py / train_cli.py
evaluation/      arena.py / export_weights.py / perf_report.py
inference/       policy.mjs（TS 推理）/ predict.py（纯 numpy 推理）
configs/         default.json / smoke.json / scenario-a-selfplay.json / scenario-b-vs-champion.json
tests/node/      enum-legality / enum-fairness / encoding / worker-protocol（17 测试）+ export-fixtures.mjs
tests/python/    test_ai5_ppo（15）/ test_export_consistency（7）
reports/         run-main-001（含 init.pt / last.pt / exported-model.json / metrics.jsonl）
                 arena-run-main-001-validation / arena-init-baseline / arena-run-scenB-20it / perf-*.json / seed-ledger.json
```

---

## 3. 系统架构

### 3.1 训练与推理链路

```
┌─────────────── Python 训练进程 ───────────────┐
│ train_cli → Collector（批量决策汇集/采样/回填） │
│   PolicyBundle：learner + 冻结快照（MPS/CPU）  │
│   PPO 更新器（Clipped/GAE/熵/KL/NaN 守卫）     │
└───────────────┬──────────────────────────────┘
                │ JSON lines + base64(f32) 向量（stdin/stdout）
┌───────────────┴────────────── K × Node 宿主进程 ─┐
│ env_worker.mjs：正式引擎编译产物（web-v1/dist/js）│
│  · 游戏状态转移（createGame/applyAction）        │
│  · MLP 席位：buildObservation → 枚举合法候选     │
│    → 编码（1419 维状态 / 84 维×N 候选）→ 挂起     │
│  · node 席位：chooseAIAction（AI 4.0 冠军核心）  │
└──────────────────────────────────────────────┘
```

- 游戏规则零复制：全部状态转移由与网页版相同的 `web-v1/dist/js/engine.js` 执行，行动最终由引擎验证，非法行动记为异常对局（不静默重试）。
- 编码单一来源：`bridge/encode.mjs` 同时服务训练（worker 侧编码）与 TS 离线推理；Python 侧只消费向量，通过导出一致性测试验证协议理解。

### 3.2 网络架构

- 状态嵌入主干：1419 → 256 → 256 → 256（ReLU）
- Actor：候选（84 维）→ act_encoder 84→128 → 与状态嵌入拼接 → act_head 384→128→1（logit），段内 masked softmax
- Critic：256 → 128 → 1（当前行动者视角期望终局奖励）
- 总参数：**588,418**；设备：MPS（CPU 回退已验证），FP32

### 3.3 状态编码（ai5-state-v1，1419 维）

阶段独热 3 + 当前席 6 + 视角席 6 + 终局触发独热 7 + 全局标量 24（回合数/公共池/认领进度/未翻牌数/分差等，全部公开可推导）+ 逐席位块 6×142（水晶 4+标量 12+手牌独热 45+已打出独热 45+已认领独热 36）+ 商人市场 6×51 + 魔像市场 5×43。
未翻牌计数 = 牌库公开构成 − 全部可见卡（公开可推导，不含任何隐藏顺序）。

### 3.4 行动编码（ai5-action-v1，84 维）与合法行动空间

- 类型独热 7 + 商人卡特征 14 + 魔像特征 5 + 上下文 5 + **有序支付编码 25（5 位 × 颜色独热 4 + 有效位）** + 升级步序 12 + 弃置计数 4 + 行动后库存预测 10 + 标记 2。
- 枚举（`action_enum.mjs`）只消费 `AIObservation`（函数签名上不存在完整 Game）：
  - 认领（可负担槽位）/ 创造 / 升级（按后继库存去重）/ 交易（1..tradeLimit）/ 休息 / **获取（全部有序支付序列）** / 溢出弃置（颜色多重集）；
  - **支付顺序差异保留**：引擎对 `payment[i]` 逐槽位加奖励水晶，不同顺序 → 不同后继状态 → 不同候选（任务书第六节要求；AI 4.0 的同组合折叠是其搜索近似，已测试证明其候选集 ⊆ AI5 枚举集）；
  - 触发终局后 acquire 引擎仍合法，AI5 保留（AI 4.0 规划器关闭该分支属其搜索剪枝）；
  - 候选 >512 时对 acquire 支付排列做确定性分层剪枝（升序规范支付必留 + 状态键派生种子抽样），`fullCount/keptCount/pruned` 随每步决策上报。**实测剪枝率 0.25%**（501/约 20 万决策），几乎不影响覆盖。

### 3.5 信息公平性

- 静态扫描：bridge 决策路径零引用 `merchantDeck/golemDeck`；
- 动态不变性：隐藏牌库顺序突变（公开状态不变）⇒ 状态向量与候选集合逐位不变（测试强制）；
- 训练数据仅来自公开观察编码；值函数视角 = 当前行动者。

---

## 4. PPO 超参数（default.json，全部为待实验超参数，非最优宣称）

| 项 | 值 | 项 | 值 |
|---|---|---|---|
| rolloutSteps | 2048（learner 决策） | lr | 3e-4（constant） |
| γ | 0.999 | GAE λ | 0.95 |
| clip | 0.2 | vfCoef | 0.5 |
| entCoef | 0.01 | epochs | 4 |
| minibatch | 512 | maxGradNorm | 0.5 |
| targetKl | 0.03（1.5× 早停） | advantageNorm | true |
| valueClip | true | 奖励 | rank_win：0.5×胜负 + 0.5×名次分，辅助奖励全关 |

经验采集与优化严格分离；行为策略 logp 在采集时由当时策略计算并随转移保存；冻结对手（node 冠军席位 / 快照 MLP）的转移不进入 learner on-policy 缓冲（按 policy_id 过滤，测试覆盖）。旧策略经验只在本次 rollout 的 epoch×minibatch 内复用。

---

## 5. 训练实验（P5）

### 5.1 主训练 run-main-001（场景 C：learner×2 + 冠军×2 + 快照×1，席位确定性旋转）

| 项 | 值 |
|---|---|
| 迭代 | 100 |
| learner 决策总数 | **204,887** |
| 对局总数 | **3,138**（异常 0） |
| 实际训练耗时 | 采集 1,778 s + 更新 101 s ≈ **31.3 min**（4 worker，MPS） |
| 内存峰值 | Python+worker RSS ≈ 364 MB（预算 6GB 内） |
| 策略熵 | 1.974 → 1.175（策略显著收敛） |
| approx KL | 0.001 → 0.012（目标 0.03 内，无早停触发） |
| 价值损失 | 0.004 → 0.007（终局奖励方差内正常波动） |
| NaN/梯度异常 | 0 次 |

### 5.2 布局对照（短程实验，如实报告规模差异）

| 实验 | 布局 | 规模 | 结果 |
|---|---|---|---|
| run-main-001 | C（2 learner + 2 冠军 + 1 快照） | 100 迭代 / 20.5 万决策 | 见上 |
| run-scenB-20it | B（1 learner + 4 冠军） | 20 迭代 / 4.1 万决策 | vs 冠军 0/120、均分 1.0；价值损失收敛至 0.0001 |

**场景 B 的失败模式（已发现缺陷）**：1 learner + 4 强对手 + 纯终局 rank_win 奖励下，learner 几乎恒为末位（名次分 0、胜负分 0）→ 优势恒 ≈ 0 → 无学习信号（价值网络正确学到恒 0，熵未坍缩、无 NaN——是"无信号"而非数值崩溃）。改进方向：辅助奖励/对手稀释/更多 learner 席位/负向名次分，需消融验证。

### 5.3 种子纪律

- 训练种子：确定性派生（runSeed=20261021 + 对局序号），落在引擎安全范围 [0, 2^31)；
- 验证种子：验证池块 **[900,000,000, 900,000,040)**，本地账本 `reports/seed-ledger.json` 留痕，与 AI 4.0 账本只读核对无重叠；
- 过程中发现并修复 `allocate_validation_block` 缺陷（训练池条目误入 highest_end 导致验证块落在训练区），错配块已更名留痕，最终验证评估使用修复后的真验证种子。

---

## 6. 独立竞技评估（P6，验证种子 [900M, 900M+40)，40 种子 × 5 旋位配对，贪心 argmax）

| 策略 | 对手 | 局数 | 胜率 | Wilson 95% CI | 平均分 | 异常 |
|---|---|---|---|---|---|---|
| **last.pt（训练后）** | AI 4.0 冠军 | 200 | 0.015 | [0.005, 0.043] | 32.8 | 0 |
| **last.pt** | 中立基线（AI 4.0 核心全 1.0 乘子） | 200 | 0.030 | [0.014, 0.064] | 40.0 | 0 |
| **last.pt** | 未训练 MLP（init.pt） | 189 | **0.810** | [0.748, 0.859] | 63.8 | 11（对手所致） |
| init.pt（训练前） | AI 4.0 冠军 | 200 | 0.000 | [0, 0.019] | 3.0 | 0 |
| init.pt（训练前） | 中立基线 | 200 | 0.000 | [0, 0.019] | 7.4 | 0 |

**训练前后对比**：对冠军局均分 3.0 → 32.8；对中立局均分 7.4 → 40.0；对未训练自身 0% → 81%。PPO 训练真实有效，但与冠军差距仍然巨大（胜率 1.5%）。

**诚实归因（供后续训练参考）**：204,887 决策 ≈ 6,000 局等效经验，相对 AI 4.0（束搜索 + 蒙特卡洛 rollout 的显式规划）而言，该样本量下的 MLP 远未收敛；且 rank_win 终局奖励在 5 人局中方差大、信号稀疏。这不构成"方法不行"的结论，只构成"当前训练量 + 奖励设计下未超越"的事实结论。

---

## 7. 性能实测（P6 第四阶段；不能以纯 MLP 基准替代端到端口径）

| 项 | 实测值 | 对照 |
|---|---|---|
| torch 前向（3×256，MPS） | b1 0.356 ms / b64 0.681 ms / b512 2.15 ms | M4 基准 3×256/b512 ≈ 1.3 ms（量级一致，本模型输入 1419 更大） |
| **TS 单决策推理**（导出模型，含编码） | **1.37 ms 均值 / 3.44 ms 峰值** | AI 4.0 冠军决策 11.0–14.4 ms → **MLP 快约 8–10×** |
| TS 整局离线推理 | 196 步 / 329 ms（含枚举+编码） | — |
| 端到端吞吐（4 worker） | 全冠军布局 5,472 局/h；learner 混合布局 5,903 局/h、102 决策/s | M4 基准 8 worker 8,217 局/h（4 worker 6,057 局/h，一致） |
| Python 进程 RSS | 486 MB（含 torch 运行时） | 训练组合 <2 GB，预算 6 GB 内 |

结论：模拟侧（champion ~12ms/步）仍是瓶颈，GPU 占空比极低——与既有 M4 基准判断一致；MLP 推理不是瓶颈。

---

## 8. 模型推理与导出（P6 / 任务书 13）

- 导出格式：base64(f64LE) 原始字节 + 字节级 SHA-256（跨语言逐位一致，防篡改校验测试覆盖）；
- **导出一致性（7 项测试全过）**：TS(f64) ↔ numpy(f64) 概率最大偏差 < 1e-9；TS ↔ torch(f32) < 1e-4；贪心选择一致；哈希篡改检出；
- 离线推理零依赖：TS 推理纯 Node（无训练栈、无网络）；numpy 推理不 import torch；
- 完整对局验证：导出模型 TS 推理整局 196 步正常终局，单决策 1.37ms。

### OpenEvolve 融合接口（任务书 12，已就绪并验证）

| 接口 | 入口（`inference/policy.mjs`） | 语义 |
|---|---|---|
| 局面价值 | `valueOfObservation(observation)` | 当前行动者视角期望终局奖励 ∈ [0,1]（rank_win 语义） |
| 行动策略 | `policyScores(observation, candidates)` / 向量级 `policyScoresFromVectors` | 每候选概率（masked softmax） |
| 模型版本 | `manifest` | `ai5-mlp-256x256x256-158beea4` + state/action/interface 版本 + weights SHA-256 + git SHA |

模型文件：`ai5/ppo/reports/run-main-001/exported-model.json`（清单含 `sourceCheckpointModelHash=157c16ef…`，`sourceIteration=99`）。OpenEvolve 调整搜索深度/束宽/剪枝时可直接调用；融合后必须重新对抗验证（接口兼容 ≠ 性能兼容）。

---

## 9. 可复现命令

```bash
# 环境（一次性）
cd web-v1 && npm install && npm run build          # 引擎编译产物
python -m ai5.ppo.training.train_cli --smoke --out ai5/ppo/reports/smoke   # 冒烟（~1 分钟）

# 主训练（本报告 run-main-001 的复现）
python -m ai5.ppo.training.train_cli --config ai5/ppo/configs/default.json --out ai5/ppo/reports/run-main-001-repro

# 独立竞技评估（消耗新的验证种子块，账本自动续接）
python -m ai5.ppo.evaluation.arena --checkpoint ai5/ppo/reports/run-main-001/last.pt \
  --opponents champion,neutral,init --games-per-setup 40 --rotations 5 --seed-pool validation

# 导出 + TS 推理 + 性能
python -m ai5.ppo.evaluation.export_weights --checkpoint ai5/ppo/reports/run-main-001/last.pt
python -m ai5.ppo.evaluation.perf_report --checkpoint ai5/ppo/reports/run-main-001/last.pt

# 测试
node --test "ai5/ppo/tests/node/*.test.mjs"        # 17/17
python -m unittest discover -s ai5/ppo/tests/python -v   # 22/22
```

环境：Node v22.16.0 ｜ Python 3.13.2 + PyTorch 2.14.1（MPS）｜ macOS 26.6.2 / Mac mini M4（10 核/16GB）。软件环境随 `summary.json` 落盘（含 git SHA、runSeed、config 全文、modelHash）。

---

## 10. 已发现缺陷与待解决问题

| # | 缺陷/限制 | 状态 |
|---|---|---|
| 1 | 场景 B（1 learner + 4 冠军）纯终局奖励下优势恒 ≈ 0，无学习信号（均分 1.0） | 已确诊未修；需奖励消融/对手稀释实验 |
| 2 | `allocate_validation_block` 曾把验证块算进训练区（账本缺陷） | **已修复** + 错配块留痕 + 真验证种子重跑 |
| 3 | 候选 >512 的支付排列剪枝（实测 0.25% 触发率） | 已如实上报覆盖率；策略损失未单独量化 |
| 4 | 训练循环未记录逐迭代 learner 胜率（只有终局奖励相关代理指标） | 未修；arena 离线评估补位 |
| 5 | 快照 MLP 席位的决策不产生训练样本（设计使然），快照池只保留最新 4 个 | 设计约束，文档化 |
| 6 | 长期训练的策略退化检测目前仅靠人工比对 arena 结果 | 未自动化 |
| 7 | 遗留（任务书既有）：真人竞技优势验证、手机端实测、长期重复挑战误晋级控制 | 不在本任务范围 |

## 11. 未来工作（OpenEvolve 融合准备度：接口就绪，性能待训）

1. 融合形态：OpenEvolve 优化搜索（束宽/深度/剪枝），MLP 提供局面价值（替代 prospective 公式）或行动先验——三接口已实现并测试；
2. 训练侧优先项：辅助奖励消融（golemProgress/turnEfficiency 开关已内置）、对手池加权、更快迭代（worker 扩展与决策引擎提速属 AI 4.0 侧）；
3. 晋级纪律：任何"AI5 超越冠军"的宣称必须走独立验证种子 + Wilson CI 下界 > 0.5 + 异常率 ≤ 2% 的人工评审，禁止未验证自动晋级。

---

## 12. 纪律合规自查（任务书十七节逐条）

| 纪律 | 合规 |
|---|---|
| 不修改游戏规则 | ✅ 引擎零改动（只消费 dist 编译产物） |
| 不读取隐藏牌库顺序 | ✅ 静态扫描 + 不变性测试强制 |
| 不修改独立评估标准 | ✅ Wilson CI 判读标准与 AI 4.0 晋级语义一致；胜率 1.5% 如实报告 |
| 训练/验证数据隔离 | ✅ 验证块 [900M, 900M+40) 账本留痕、防重断言 |
| 不修改正式 AI 4.0 冠军 | ✅ `parameters.ts`/`champion.json` 未触碰 |
| 不允许未验证模型自动晋级 | ✅ 未晋级、未替换任何正式版本 |
| 不干扰 OpenEvolve 并行研发 | ✅ 独立 worktree；`ai5/openevolve/` 原样保留 |
| 不直接向 main 提交 | ✅ 全部提交在 `feat/ai5-mlp-ppo`，仅创建 Draft PR |
| 不用模拟数据冒充真实训练 | ✅ 全部指标来自真实运行，产物（metrics.jsonl/summary.json/arena-report.md）随分支入库 |
| 不以概念演示冒充完成 | ✅ 真实训练闭环 + 真实竞技数据 + 39 项自动化测试 |
