# AI12 保真度蒸馏实验：证据审计与纠正协议

日期：2026-11-02
审计对象：AI12 `fidelity-distillation.json` 及其采集/训练脚本
原则：**保留原始负例，不覆盖历史证据**；所有复算都基于原始 `/tmp` 数据与原始权重，只读。

---

## 0. 一句话结论

AI12 报告的 **62.7% 首步一致率**可以逐位复现（复算 62.81%），但它是一个
**跨人数、世界簇高度重复、且与贪心基线差异不显著**的读数；同一个模型在
**同分布独立测试集**上为 **63.2%**（显著高于贪心约 +3pp，但距 85% 门槛差 21.8pp）。
把标签换成 **JS5 实际行动**后，同一模型只有 **49.4%**。
因此 AI12 的“未部署”决定正确，但其“只差一点 / 特征不够”的解释必须修正：
**不是特征维度问题，而是标签与目标错配 + 规划器首步本身不可由单步可加模型复现。**

---

## 1. 源码事实（可逐行核对）

### 1.1 分片复用了同一批种子

[collect-plan-data.mjs](file:///Volumes/Extreme%20SSD/Projects/Century-ai12/training/reports/ai12-research/harness/collect-plan-data.mjs#L180-L184)
中：

```js
const seatCount = 2 + (g % 4);
const seed = seedBase + seatCount * 1000 + g;
const focusSeat = (g + shard) % seatCount;
```

种子公式**不含 `shard`**。因此 `--shards 4` 的四个分片用同一 seed-base 时，
每个 `g` 复现同一个世界，只是焦点席位随分片轮转。原始数据实测：

| 项 | 值 |
|---|---|
| 决策记录（行） | 7,936 |
| 唯一世界（seed） | **50** |
| 每个种子被记录的决策数 | 126–203（均值 158.7） |
| 游戏运行次数 | 200（4 分片 × 50 局） |
| 验证集世界簇 | **25** |

“200 局”在统计意义上只有 **50 个独立世界**；同一种子的 4 次运行共享同一副牌序，
只是焦点席位不同，不能当作独立样本。原始 group-softmax 训练与验证都按“决策行”
计数，实际把 25 个世界当成了 3,727 个独立验证样本。

### 1.2 “按种子奇偶切分”等于“按人数切分”

`seedBase = 1739000000` 为偶数，`seatCount * 1000` 也为偶数，所以
`seed % 2 == g % 2`；而 `seatCount = 2 + (g % 4)`：

- `g` 偶 → 2 或 4 人；
- `g` 奇 → 3 或 5 人。

实测原始数据：

| 切分 | 决策数 | 出现的人数 |
|---|---|---|
| “train”（seed 偶） | 3,972 | **2, 4** |
| “val”（seed 奇） | 3,964 | **3, 5** |

因此 AI12 的 62.7% **不是同分布泛化**，而是“训练 2/4 人 → 测试 3/5 人”的跨人数泛化；
模型在训练中从未见过 5 人局状态。

### 1.3 标签是 `choosePlan` 首步，不是 JS5 行动

[collect-plan-data.mjs](file:///Volumes/Extreme%20SSD/Projects/Century-ai12/training/reports/ai12-research/harness/collect-plan-data.mjs#L211-L212)
的标签为 `plan.first`。而部署目标（替换 rollout 内 1-ply 贪心）应当逼近的是
**真实 JS5 策略**（冠军束搜索 + 联合仲裁），不是束搜索的首步。AI12 自己的保真度诊断
[rollout-fidelity.mjs](file:///Volumes/Extreme%20SSD/Projects/Century-ai12/training/reports/ai12-research/harness/rollout-fidelity.mjs)
已测得：

| 一致性 | 值 |
|---|---|
| rollout 贪心 vs 冠军计划首步 | 56.5% |
| JS5 实际 vs 冠军计划首步 | **76.0%** |
| JS5 实际 vs rollout 贪心 | 47.7% |

即使模型 100% 复现计划首步，对 JS5 的保真上限也受 76% 的“计划—实际行动”差距约束；
85% 的“计划一致率”门槛与“提高 JS5 模拟保真度”并不是同一个量。

### 1.4 54 维特征遗漏了规划器实际消费的关键状态

原特征只含**长度/汇总**，不含：

- 己方手牌与已打出卡牌的**具体身份**（`engineValueFor` 逐卡计算）；
- 商人市场槽位的具体卡牌、bonus 与可支付性；
- 逐对手的水晶库存、已认领数、手牌数、座位顺序（`seatContestFactor`/存活模型输入）；
- 魔像逐色费用、我的/对手的可达覆盖、剩余认领槽。

因此“54 维模型上限低”并不能推出“结构化特征也上限低”。本次纠正实验加入了
333 维结构化公开特征（54 维 legacy 逐名保留 + 279 维新特征），直接检验该解释。

### 1.5 原始 `typeAcc = 1.0` 是度量缺陷

原始 [train-plan-policy.py](file:///Volumes/Extreme%20SSD/Projects/Century-ai12/training/reports/ai12-research/harness/train-plan-policy.py#L174-L188)
的类型判定接收的是**已归一化**的特征行，却用 `row[19] == 1` 判定行动类型。
归一化后的二元特征几乎不可能等于 1，预测与标签都被判为 `'?'`，于是类型一致率恒为 1.0。
用未归一化原始特征复算：MLP 类型一致率 **83.7%**（不是 100%）。线性模型同理（82.6%）。

---

## 2. 原始 62.7% 的直接复算

使用原始 `/tmp` 数据与原始 MLP 权重（SHA256 已记录在
[ai12-distillation-audit.json](file:///Volumes/Extreme%20SSD/Projects/Century-ai13/training/reports/ai13/ai12-distillation-audit.json)）：

| 模型 | 可选中决策数 | 准确率 | 贪心基线 | 差值 | 世界簇 bootstrap 95% |
|---|---|---|---|---|---|
| 线性 54 | 3,727 | 60.45% | 61.07% | −0.62pp | [−2.46, +1.12]pp |
| MLP-16 54 | 3,727 | **62.81%**（报告 62.73%） | 61.07% | **+1.74pp** | **[−0.35, +3.78]pp** |

- 62.7% 的数值可复现；但验证集只有 **25 个世界簇**，按世界重采样后 +1.74pp 的区间跨 0。
- 因此该读数**不能支持“模型优于贪心”的结论**，更不能支持“接近 85% 门槛”。
- 原始 `valAccAllDecisions = 58.98%` 才是部署口径（含不可选中的标签）。

---

## 3. 纠正协议（AI13）

### 3.1 协议

| 项 | AI12 | AI13 纠正 |
|---|---|---|
| 种子 | 4 分片复用同一世界 | `seed = base + shard*20000 + seatCount*4000 + g`，分片互斥 |
| 世界数 | 50 | train 240 / dev 80 / test 80（每 split 内 2–5 人等量） |
| 切分 | 种子奇偶（= 人数切分） | 世界整组隔离 + 独立 train/dev/test 窗口 |
| 特征 | 54 维 | 333 维（54 legacy + 279 结构化公开特征） |
| 标签 | plan.first | 同时记录 plan.first 与 JS5 实际行动 |
| 评估 | 同一 val 选 epoch 并报告 | dev 早停 + 独立 test；世界簇 bootstrap |
| typeAcc | 归一化行判类型（恒 1.0） | 原始行判类型 |

种子窗口：`[1.800e9,1.8003e9)` train、`[1.8003e9,1.8004e9)` dev、
`[1.8004e9,1.8005e9)` test；均登记于
[seed-consumption-registry.json](file:///Volumes/Extreme%20SSD/Projects/Century-ai13/training/governance/seed-consumption-registry.json)。

### 3.2 结果

| 实验 | 测试决策 | 准确率 | 贪心 | 差值 | 世界簇 95% | 训练/测试 |
|---|---|---|---|---|---|---|
| 同分布 · legacy 54 · MLP16 | 2,997 | **63.23%** | 60.23% | **+3.01pp** | **[+1.15, +4.84]pp** | 80/80 世界 |
| 同分布 · rich 333 · MLP16 | 2,997 | 63.16% | 60.23% | +2.95pp | [+1.18, +4.70]pp | 80/80 |
| 跨人数 · legacy 54 · MLP16（2/4→3/5） | 1,475 | 61.97% | 60.54% | +1.41pp | [−1.28, +4.25]pp | 40 簇 |
| 跨人数 · rich 333 · MLP16（2/4→3/5） | 1,475 | 60.47% | 60.54% | −0.07pp | — | 训练 79.3% / 测试 60.5%（过拟合） |
| 同分布 · rich · MLP16 · **JS5 标签** | 2,976 | **49.43%** | 48.79% | +0.68pp | [−1.14, +2.52]pp | — |

补充上限：

- 同分布、plan 标签的“类型 oracle”（已知正确行动类型、类型内取贪心最高值）= **74.74%**；
- JS5 标签的类型 oracle = **69.49%**；
- 两者都低于 85% 的预注册门槛。

---

## 4. 结论修正（严格区分事实/观察/统计/推测）

### 4.1 事实

1. 原始数据的唯一世界数 = 50，验证簇 = 25；“200 局”不是 200 个独立世界。
2. 原始“奇偶切分”实际是“2/4 人训练 → 3/5 人测试”。
3. 原始 62.73% 可复现为 62.81%；其世界簇 bootstrap 区间包含 0。
4. 原始 `typeAcc=1.0` 是归一化度量缺陷，正确值约 83.7%。

### 4.2 观察

1. 同分布纠正后为 63.2%，跨人数为 62.0%；**特征扩充没有带来提升**。
2. 以 JS5 实际行动为标签时，同一模型仅 49.4%，与贪心 48.8% 基本无差异。
3. 55 个实验（AI12 46 + 本轮 9 个蒸馏变体）中，首步一致率从未接近 85%。

### 4.3 统计结论

1. **AI12 的 +1.6pp 不能宣称优于贪心**：世界簇区间跨 0。
2. 同分布的 +3.0pp 显著（区间 [+1.15, +4.84]），但距 85% 门槛差 21.8pp，
   不构成“接近门槛”的证据。
3. 跨人数与 JS5 标签的差值均不显著。

### 4.4 未经验证的推测（不进入结论）

- 单步可加模型无法表达“束搜索首步”的多步未来；提高模型容量或序列模型可能有帮助，
  但本轮没有证据。
- 在当前 100ms 预算内，用廉价模型替换 rollout 自身策略的收益上限可能低于 3–5pp；
  需要以端到端配对实验验证，不能由离线一致率推断。

---

## 5. 对 AI12 结论的处理

| AI12 表述 | 处理 |
|---|---|
| “200 局 / 7936 决策” | 保留数字，追加“唯一世界 50”勘误 |
| “按种子奇偶切分” | 修正为“跨人数切分” |
| “MLP-16 62.7%，仅 +1.6pp” | 数值可复现；补充“不显著”“同分布 63.2%”“JS5 标签 49.4%” |
| “类型 oracle 上限 67.5%” | 保留为旧特征口径的参考；新特征同分布 oracle 74.7%，仍低于 85% |
| “未部署、不产候选” | **正确，保留** |
| “问题在 54 维特征不足” | 修正为“标签/目标错配 + 规划器首步不可由单步模型复现；加特征无效” |

原始证据文件未被修改；审计脚本、原始文件 SHA256 与复算结果保存在
[audit-ai12-distill.py](file:///Volumes/Extreme%20SSD/Projects/Century-ai13/training/reports/ai13/harness/audit-ai12-distill.py)
与 [ai12-distillation-audit.json](file:///Volumes/Extreme%20SSD/Projects/Century-ai13/training/reports/ai13/ai12-distillation-audit.json)。

## 6. 复现命令

```bash
# 原始证据审计（只读 /tmp 历史数据与权重）
python3 training/reports/ai13/harness/audit-ai12-distill.py

# 纠正数据采集（4 分片并行；种子已登记）
for s in 0 1 2 3; do
  node training/reports/ai13/harness/collect-plan-data-v2.mjs \
    --split train --shard $s --shards 4 --games-per-count 15 \
    --seed-base 1800000000 --shard-stride 20000 --count-stride 4000 \
    --wu 32 --out /tmp/ai13-train-$s.jsonl
done
# dev/test 同法，seed-base 1800300000 / 1800400000，games-per-count 5

# 同分布 / 跨人数训练
python3 training/reports/ai13/harness/train-plan-policy-v2.py \
  --train '/tmp/ai13-train-*.jsonl' --dev '/tmp/ai13-dev-*.jsonl' --test '/tmp/ai13-test-*.jsonl' \
  --mode same --features rich --hidden 16 \
  --out training/reports/ai13/model-same-rich-mlp16.json
```

---

## 7. 对后续研究的直接约束

1. 任何蒸馏/模仿实验必须报告**唯一世界数、世界簇 bootstrap、独立 test**；
   不得再用决策行数冒充样本量。
2. 标签必须是部署目标本身（JS5 实际决策），不能以 `choosePlan` 首步替代。
3. 保真度门槛必须按“端到端配对胜率”验证，离线一致率只能作为筛选，不得作为晋级证据。
