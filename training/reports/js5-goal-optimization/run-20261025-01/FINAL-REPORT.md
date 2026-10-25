# JS5 证据优化与决策改进：最终报告（run-20261025-01）

日期：2026-10-25（Asia/Shanghai）
分支：`codex/js5-evidence-optimization`
基线：`e2361edc28b95c03ee5ccdd461c9afe0086dfe84`（main）
本地提交：`ffeb6d0`（代码/测试/计划）、`80ff202`（证据/最终报告）
研究目录：`training/reports/js5-goal-optimization/run-20261025-01/`

## 0. 结论摘要

本次完成了三件已落地并可显式选择的事，而不是一份建议书：

1. **计量修复**：human-analytics 指标升 v2。29 局复算与三份报告预期逐项一致：
   26 次弃置 / **47 颗**（旧颜色编号和 = 4）；取后从未打出 **179** 张
   （`deadCardDetails`/`merchantUsage.neverPlayed`；终局快照 `deadCards` 472，
   293 张为使用后休息收回）；150 条"付得起未认领"中本人稍后自领 **69**、
   他人拿走 **76**、始终无人 5；去重后唯一流失目标 **52**。
2. **对照身份修复**：`duel.mjs` 的 js0/js1 不再被活动冠军 adapter 吞掉；
   `joint-js5-opt` 真正注入 `claimRanking='prior'`；新增共享 resolved config + 哈希；
   Worker 协议补齐 gate/margin/cap/claimRanking/新选项白名单。
3. **两项 JS5 决策/工程改动**（opt-in，冻结冠军缺省不变）：
   - **临近终局候选保留**：公开风险成立时，把"当步正式净分最大"的合法行动注入候选
     （`replace` 预算中性 / `add` 追加）。C10 从"候选遗漏"变为"8/8 轨迹第一、决策选择
     `[0,0,0]`、当步 +3 分至 60"；另有 2 个不同席位/牌面/库存的结构回归证明机制泛化。
   - **墙钟预算有效性**：`batchAdmission='balanced'` 按 W×M 预检、允许全候选缩减批次、
     缩减批次最低 3 试验；`screenGoalScope='preferred'` 真正接线。C04/C09/C12 在
     100ms 下零试验从 2/8、0/8、8/8 降到 **0/8、0/8、0/8**，C12 保留 claim@3
     有效仲裁，p95 91–96ms。
4. **验证**：相关规则/JS5/配置/Worker/公平性/研究 runner 测试 59 通过 0 失败；
   另一组适配器/AI 模块/Worker/引擎/牌表 53 通过 0 失败；human-analytics + duel
   22 通过 0 失败。测试通过只说明正确性/配置一致，不说明棋力提高。
5. **独立确认与性能**：
   - 独立确认（200 种子，5p，方向 A）：基线 30.0% → 候选 35.0%，种子级配对差
     **+5.0pp，95% bootstrap [−2.0,+12.5]pp**，32W/22L/146T，异常 0。
     **区间跨 0，证据不足；不声明整体棋力提高或非劣。** 辅指标平均名次
     2.46→2.59、对对手分差 +4.27→+3.76，方向亦不支持"整体更强"。
   - 性能（1000 局面 × 3 次）：候选 p95 **100.1ms**、p99 **104.8ms**（基线
     128.9/140.7ms），超预算 151 vs 1038；但逐局面配对 p95 **+15.8ms**，
     未达本轮 ≤10ms 增量门槛，max 440.6ms 为规划尾部。**不宣称可部署尾延迟。**
   - 结论范围：**已证实的工程/局部决策改善 + 候选覆盖修复**；整体棋力提高与
     线上部署均**未证实**。

## 1. 报告采纳与驳回

| 报告建议 | 处理 | 理由 |
|---|---|---|
| c83f P0-A 计量修复 | **采纳** | 已复现 never-played 179 vs 快照 472、4→47、69 自领；v2 schema + 迁移说明 + 测试 |
| c83f P0-B 配置身份 | **采纳** | js0/js1/opt/Worker 均落地；resolved config + hash |
| c83f P1-C 临近终局候选 | **采纳（replace/add 两方案）** | C10 回归 + 2 个结构泛化 + 29 局扫描 |
| c83f P1-D 预算与遥测 | **采纳（balanced/preferred 显式）** | C04/C09/C12 零试验消除；固定工作量逐位不变 |
| crest R1 恢复网页人格注入 | **驳回（本轮）** | 会改变生产默认行为；报告自身只有 ~0.6% 行动差异且无棋力证据；未做独立消融 |
| agent-a P0 配对 CRN + min trials + claim guard | **部分采纳** | 仅实现缩减批次 ≥3 试验的防噪声保护；完整配对统计/claim guard 未实施（P2，本次不预置） |
| c83f/crest P2 门控阈值校准 | **未实施** | 无独立证据表明收窄门控不丢真实抢牌；不在本轮范围 |
| crest R4 Worker 接线/延迟治理 | **未实施** | 桌面 app 未接 Worker；本轮只补协议白名单，不改 UI |
| crest R5 根候选支付去重 | **未实施** | 不同支付顺序后继非等价（报告亦警告）；不做未验证合并 |
| crest R6 / c83f P2-F L3 校准 | **未实施** | 需独立校准数据管线；本轮优先局部可证机制 |
| "72% 覆盖在 2SE 内 = 覆盖错误" | **驳回该表述** | 只有点估计近似，无 CRN 配对差；本文不据此改覆盖规则 |
| "高分必须认领/低张数禁止休息/开局必买创造卡" | **全部驳回** | 与 C05/C06/C07/C11 反例冲突 |
| "铜币再加 3 分" | **驳回** | 正式计分与局部转移已计入；重复加分会破坏规则一致性 |
| B2 批次 = JS5 版本 | **不作为事实** | 报告本身标注行为学推断；本文不使用该归属做结论 |

## 2. 基线身份与冻结

- 修改前源码/构建/配置/输入哈希：`BASELINE-MANIFEST.json`（27 个源码/构建/配置 +
  29 局输入清单）。
- 基线可重建工作树：`/tmp/century-js5-baseline-e2361ed`（同提交 tsc；node_modules
  为主仓符号链接）。
- 实际分派探针（seed 1,500,000,000，24 步后）：
  - 活动冠军参数 → `js5 联合仲裁：保持冠军行动`（**确实进入 JS5**）；
  - 显式 legacy fixture → `AI 4.0 ... beam-rollout`（束搜索）。
- 因此：基线比较分两种，绝不混用：
  1. **纯束搜索/历史冠军**：显式 `legacy-champion.json` 或归档参数（剥离 adapter）；
  2. **JS5 冻结配置**：`joint-js5`, 100ms, NEUTRAL, simSeed 0, gate auto/.85,
     cap 4, margin .02, enumeration, worlds 4, horizon 48, rule/L2,
     nearTerminal=off, screenScope=all, batchAdmission=legacy（hash `d726fa3c`）。
- 主候选 A4 的固定工作量配置哈希 `202074e5`，墙钟哈希 `c09a8c5c`；
  完整 arms/hash/source hash 见 `evidence/frozen-config.json`。

## 3. 计量 v2：确认了什么、修正了什么

证据：`evidence/metrics-v2-summary.json`，测试：`training/human-analytics/tests/run-tests.mjs`（18 项）。

| 指标 | v1 旧值/口径 | v2 复算 | 说明 |
|---|---|---|---|
| 弃置事件 / 颗数 | 累计 4 颗（颜色编号和） | **26 次 / 47 颗** | 黄色编号 0 被旧口径计 0 颗 |
| 终局"死卡" | 快照 472（非起始手牌） | **never-played 179** | 快照字段 `deadCards` 保留 472；293 张为曾打出后休息收回 |
| 付得起未认领 | 150 条，claimedLaterBy 不分自他 | 150 条：自领 **69** / 他领 **76** / 无人 5 | 唯一流失目标 **52**；重复 51 |
| 被抢机会集合 | 199 席事件 | 199 席事件 / 157 唯一 claim 事件 | opportunity-only，不是 199 次实际被抢 |
| 最大引擎 | 已打出区最大值 | hand + played | 与"拥有卡总数"一致 |
| 休息间隔 | 首次个人回合、后续全局手数 | 个人回合差 | `before.turns+1` |
| 终局节奏 | 用最终末名反推 | 触发时点公开分数/排名 | 不拿终态回填 |

旧 analytics 产物保留为 v1 研究结果；README 与 `metrics.json.metricSemantics` 写明迁移语义。
`failures.mjs` 不再把 contestedLosses 与自领事件相加；`cases.mjs` 的 missed 案例只取
`claimedLaterByOther`。

## 4. P1-C：临近终局候选保留

实现：`web-v1/src/js/near-terminal.ts` + `champion-guided.ts`。
- **风险只用公开信息**：已触发，或任一席位（含自己）已领 threshold−1 且当前付得起
  市场任一魔像；threshold = 5（≥4 人）/6（<4 人），与正式引擎一致。
- **argmax 当步正式净分**：含魔像分、铜币×3、银币、非黄颜色、升级产色、交易净色、
  获取奖励、强制弃置；与正式引擎逐动作差分一致（3 个 fixture 全部合法动作）。
- **不硬编码**对局/回合/M43/目标 ID/人类席位；只在 risk=true 且显式 opt-in 时注入。
- `replace` 替换最后一个"先验填充"候选（无助者则退回 claim 槽），候选数不变；
  `add` 追加一个候选并披露 cap+1 的额外轨迹成本。

证据：
- 基线 C10：冠军 `M43 [1,1,2]`，候选 = `[1,1,2]/rest/[0,1,2]/[0,1,1]`，
  `[0,0,0]` 遗漏；32 workUnits、8 试验/候选。
- `replace`：注入 `M43 [0,0,0]`（当步 +3、60 分），8/8 第一，决策改为 `[0,0,0]`；
  候选数仍 4、轨迹仍 32。
- `add`：候选 5、每候选 4 试验，同样选中；相同 32 workUnits 下证据更薄。
- 结构泛化：game4/turn187/seat1（冠军 rest、最大 M03×2）与 game22/turn148/seat2
  （冠军 S01、最大 M03×1）基线均遗漏，注入后均参与评估；这两个局面最终行动未变
  （不宣称局部收益）。
- 29 局扫描：176 个 risky、116 个可计算、**18 个基线候选遗漏**；注入后 0 个改变选择。
  说明遗漏不是 C10 独有，但多数是 +1/+2 的末轮小分，机制价值主要是"让模拟有机会看到"。

## 5. P1-D：预算有效性与遥测

实现：`web-v1/src/js/budget.ts` + `champion-guided.ts` + Worker 协议。
- 分相互斥：`rootSimMs` 不再包含 `legalGenMs`；新增 `accountingMs/unaccountedMs`。
- 零试验原因：`plan-and-screen-exhausted` / `batch-floor-not-met` / `no-window` /
  `no-batch-started`；`budgetExhausted` 在零试验且窗口不足时不再漏报；`overBudget` 单列。
- `batchAdmission='legacy'`（缺省）保持冻结行为：M×5ms 门槛、只跑完整 W×M 批次。
- `batchAdmission='balanced'`：W×M×2.5ms 预检 + **全候选缩减批次**（只减 world，
  不减候选；各候选 (world,replica) 键集严格相同）+ 缩减批次最低 3 试验覆盖。
- `screenGoalScope='preferred'` 真正接线（此前注释称 preferred、实现落 all）；
  C12 screen 15.5→4.8ms，C09 7.7→2.7ms。

本机 100ms 实测（C04/C09/C12，8 次；`evidence/budget-*.json`）：

| fixture | legacy 零试验 | balanced+preferred 零试验 | balanced 平均轨迹 | balanced p95 |
|---|---:|---:|---:|---:|
| C04 | 2/8 | **0/8** | 16.5 | 96.3ms |
| C09 | 0/8 | **0/8** | 26.5 | 92.3ms |
| C12 | 8/8（本次运行 plan+screen 吃满窗口；早先同代码曾跑 16 试验） | **0/8** | 16 | 91.7ms |

C12 在 balanced+preferred 的 8 次运行全部选择 claim@3（固定工作量 32 也选 claim@3），
未被 1–2 试验噪声翻到 claim@2。墙钟结果依赖本机负载，本文单列披露，不当部署分布。
固定工作量模式不受 admission 影响，逐位可复现。

## 6. 回归、反误修与测试

- C10 回归：`web-v1/tests/js5-near-terminal.test.mjs`（3 项）——基线遗漏、replace/add
  注入与选中、2 个结构泛化 fixture、全合法行动净分差分。
- 反误修：C06 单卡休息、C07 即时奖励取卡、C11 后手平分触发在现有回归/语义中保留；
  本轮未加入"能领必领/少休息/开局必买"规则。
- 配置/Worker：`js5-config-identity`（9）、`js5-worker-config`（4）、`duel-identity`（4）。
- 预算：`js5-budget`（6，含非法选项拒绝）。
- 公平性：`ai-fairness` / `joint-fairness` / `public-sim.fairness` /
  `public-sim.differential` 等 59 项通过 0 失败（96.5s）。
- 另一组适配器/AI 模块/Worker/引擎/牌表 53 项通过 0 失败。
- human-analytics + duel identity 22 项通过 0 失败。
- 未跑：`ai.test.mjs`、`human-ai.test.mjs` 在默认 JS5 100ms 下需 >15min；其分派/公平
  语义由上述套件覆盖。该排除在 `EXPERIMENTS.jsonl` T-001 披露。

## 7. 消融与独立确认

### 7.1 Pilot（goal-dev，40 种子，work 16，5p，方向 A，classic）

| 臂 | 第一名率 | 配对差 vs A0 | 95% bootstrap | W/L/T | 不一致率 | 8pp 所需 N |
|---|---|---|---:|---:|---:|---:|
| A0 基线 | 22.5% [10,35] | — | — | — | — | — |
| A1 replace | 27.5% [15,42.5] | +5.0pp | [−7.5,+17.5] | 4/2/34 | 0.15 | 184 |
| A4 组合 | 22.5% [10,35] | 0.0pp | [−15,+15] | 4/4/32 | 0.20 | 246 |

Pilot 效应小、区间跨 0；未据此改主候选（A4 在运行前预注册）。A2/A3 因与 A1/A4
共享机制且 CPU 争用被停止，未进入本轮结论（保留为未完成消融）。

### 7.2 独立确认（goal-confirm `[1.38e9,1.39e9)`，200 种子，work 16，5p，方向 A）

主候选 A4（hash `202074e5`）与基线 A0（hash `5242a695`）同种子、同席位轮换、同对手池：

| 指标 | 基线 A0 | 候选 A4 |
|---|---:|---:|
| 单席第一名率 | 30.0% | 35.0% |
| 95% Wilson | [24.0, 36.5] | [29.0, 42.0] |
| 种子级配对差 | — | **+5.0pp** |
| 配对差 95% bootstrap | — | **[−2.0, +12.5]pp** |
| W/L/T | — | **32 / 22 / 146** |
| 不一致率 | — | 0.27 |
| 精确 McNemar p | — | 0.220 |
| 异常局 | 0 | 0 |
| 平均名次 | 2.46 | 2.59 |
| 平均对对手分差 | +4.27 | +3.76 |
| 平均对对手分差变化 | — | **−0.51 分**（辅指标略负） |
| 门控率 / 覆盖冠军率 | 92.1% / 35.7% | 92.4% / 34.8% |
| 门控后零试验回退 | 0 | 0 |

**判定：证据不足，不能声称整体棋力提高。** 区间跨 0；按 pilot 不一致率 0.20、
目标 8pp 计算需要约 246 种子，本次确认集实际不一致率 0.27 → 约需 332 种子；
200 种子对 8pp 效应功效不足。区间上界 +12.5pp 与下界 −2.0pp 同时意味着
既不能证明提高，也不能证明非劣。辅指标（对对手平均分差）方向略负，进一步
支持"不宣称整体变强"。本轮只声明：候选覆盖/预算工程改善在固定工作量下可复现，
C10 局部决策修复；不声明线上或真人棋力提高。

完整逐局数据：`evidence/confirm/`；配对分析：`evidence/confirm-paired.json`。

## 8. 性能验证

配置：1,000 个新公开局面（goal-perf，覆盖开局/中局/后期/终局/溢出）× 每例 3 次，
单进程、预热、每局面随机交错版本；基线 = e2361ed 的 dist，候选 = A4。
**负载披露**：外部并行训练任务仍在运行，开始 loadavg = [9.08, 13.06, 16.74]，
结束 = [7.67, 8.67, 12.58]（10 核）。绝对延迟含共同负载，不能当作线上 SLA；
配对差是同一局面/同一重复的版本差，对共同负载更稳健。

| 指标 | 基线 e2361ed | 候选 A4 |
|---|---:|---:|
| 样本 | 3,000 | 3,000 |
| 错误 / 非法 / 回退 | 0 / 0 / 0 | 0 / 0 / 0 |
| p50 | 90.3ms | 90.8ms |
| **p95** | **128.9ms** | **100.1ms** |
| **p99** | **140.7ms** | **104.8ms** |
| max | 247.7ms | 440.6ms |
| 超 100ms 名义预算 | 1,038/3,000 | 151/3,000 |
| 零试验 | 254/3,000 | 240/3,000（其中 225 为非门控直通） |
| 平均轨迹数/决策 | 403.2 | 497.9 |

配对延迟差（同局面同重复，n=3,000）：p50 **−1.29ms**、p95 **+15.84ms**、
候选更快 1,590 次、候选慢 >10ms 532 次、min −121.2ms、max +296.5ms。

**判定**：候选绝对 p95/p99 满足预注册的 110/150ms 参考线；但**逐局面配对 p95
增量为 +15.8ms，未满足"相对基线 p95 增量 ≤10ms"的本轮门槛**，且候选 max 440.6ms
是一个 late 局面、零试验、plan-and-screen-exhausted 的规划尾部（基线同类为 247.7ms）。
因此：本轮不宣称候选在所有局面上更快或达到可部署尾延迟；只声明它把
超预算比例从 34.6% 降到 5.0%、p95/p99 绝对尾延迟下降，且无非法/异常。
部署前需在安静机器上复测，并单独处理冠军规划尾部。

## 9. 风险与未验证项

- 29 局真人记录全部是发现集；代理对手实验不能证明对真人更强。
- Pilot/确认的效应量很小，若区间跨 0 只能声明"工程/局部决策改善"，不能声明整体棋力提高。
- 墙钟 100ms 受机器负载影响；balanced 的零试验消除是在本机样本上的结果，
  不能外推为线上 SLA。
- `screenGoalScope='preferred'` 改变根先验；本轮只做了机制/预算证据与独立确认，
  未验证它在所有对手风格/人数下的稳健性（2/3/4 人未跑）。
- 人格注入、门控阈值、L3 校准、配对 CRN 仲裁、Worker 桌面接线均未实施。
- `replace`/`add` 只保证"候选可见"，不保证"必然选中"；C10 是唯一在本次证据中
  由注入直接改变选择的案例。
- `cloneMs` 仍未测量（固定 0，已用 `cloneMsMeasured=false` 显式披露），不能宣称零克隆开销。
- 未推送、未创建远端 PR、未合并 main、未替换冠军、未消费正式验证池/账本。

## 10. 交付与复现

- 代码/测试/配置/计划：提交 `ffeb6d0`；证据/最终报告：提交 `80ff202`（不推送）。
- 计划与进度：`PLAN.md`、`PROGRESS.md`。
- 基线：`BASELINE-MANIFEST.json`、`evidence/frozen-config.json`。
- 实验记录：`EXPERIMENTS.jsonl`。
- 证据：`evidence/metrics-v2-summary.json`、`near-terminal-scan.json`、
  `probe-c10-*.json`、`budget-*.json`、`pilot-paired.json`、`confirm/`、`perf-compare.json`。
- 日志：`logs/`。
- 复现脚本：`scripts/freeze-baseline.mjs`、`verify-metrics-v2.mjs`、`probe-c10.mjs`、
  `probe-budget.mjs`、`scan-near-terminal.mjs`、`analyze-paired.mjs`、`perf-compare.mjs`、
  `run-relevant-tests.sh`。

```sh
# 构建
node web-v1/node_modules/typescript/bin/tsc -p web-v1/tsconfig.json
# 计量 v2
node training/reports/js5-goal-optimization/run-20261025-01/scripts/verify-metrics-v2.mjs
# C10
node training/reports/js5-goal-optimization/run-20261025-01/scripts/probe-c10.mjs --policy replace
# 预算
node training/reports/js5-goal-optimization/run-20261025-01/scripts/probe-budget.mjs --repeats 8 --label balanced --batch-admission balanced --screen-scope preferred
# 确认（示例；需提前冻结主候选）
node training/joint/duel.mjs --candidates js5 --players 5 --seeds 200 --block goal-confirm --work 16 --directions A --out training/reports/js5-goal-optimization/run-20261025-01/evidence/confirm
```
