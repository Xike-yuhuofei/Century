# 进度（run-20261025-01）

更新时间：2026-10-25
分支：`codex/js5-evidence-optimization`，基线 `e2361ed`

## 当前阶段

阶段 2：机制已实现，正在做固定工作量消融与独立确认；性能验证待跑。

## 已完成

### 证据/计量
- `BASELINE-MANIFEST.json`：27 个源码/构建/配置哈希、29 局输入哈希、实际分派探针。
- `training/human-analytics/metrics.mjs` v2：
  - 弃置颗数 = `colors.length`（29 局：26 次弃置 / **47 颗**；旧颜色编号和 = 4）。
  - 死卡 = acquired-never-played（**179**；旧"终局非起始手牌"= 472；293 张为使用后休息收回）。
  - 错过认领区分自领/他领：150 条中自领 **69**、他领 **76**、始终无人 5；
    去重后唯一流失目标 **52**，重复记录 51。
  - contestedLosses 标注 opportunity-only + claimEventId（199 席事件 / 157 唯一 claim 事件）。
  - maxEngineSize = hand+played；rest 间隔用个人回合；lateAcquire 用触发后索引；
    新增触发时点公开分数/排名。
- 新测试：human-analytics 18 项通过（含 v2 口径 4 项）。
- 证据：`evidence/metrics-v2-summary.json`。

### 配置身份
- `duel.mjs` js0/js1 不再传活动冠军参数：js0=归档 ai5-readiness-efficiency（剥离 adapter），
  js1=同参数+beam-contest，新增 `beam-pure`=struct-beam-rollout。
- `joint-js5-opt` 真正注入 `claimRanking='prior'`；新增共享 `js/config.ts` 解析
  version preset + overrides + 缺省，返回有效配置哈希。
- Worker 协议新增 `search` 白名单（gate/threshold/cap/margin/claimRanking/nearTerminal/
  screenScope/batchAdmission），决策核心返回 config/hash。
- 测试：`js5-config-identity`（9）、`js5-worker-config`（4）、`duel-identity`（4）通过。

### P1-C 临近终局候选
- `web-v1/src/js/near-terminal.ts`：公开风险 + 当步正式净分 argmax（含铜银币/非黄水晶/
  升级产色/强制弃置），与正式引擎逐动作差分一致。
- `nearTerminalCandidate ∈ {off, replace, add}`；缺省 off。
- C10：基线冠军 `[1,1,2]`、候选无 `[0,0,0]`；replace 后 `[0,0,0]` 8/8 第一、即时 +3（60 分）、
  决策改为 `[0,0,0]`；add 后同样选中（候选 5、每候选 4 试验）。
- 结构泛化 fixture：game4 turn187 seat1（冠军 rest、最大 M03×2）、game22 turn148 seat2
  （冠军 S01、最大 M03×1），基线均遗漏、注入后均参与评估。
- 29 局公开观察扫描：176 个 risky、116 个可计算、18 个基线候选遗漏；已记录于
  `evidence/near-terminal-scan.json`（这些多为 +1/+2，注入不必然改变选择）。

### P1-D 预算
- 分相互斥：`rootSimMs` 不再包含 `legalGenMs`；新增 accounting/unaccounted。
- 零试验原因/预算耗尽/overBudget/批次计数/实际世界数/最低覆盖试验数全部显式。
- `batchAdmission='balanced'`：W×M 成本预检 + 全候选缩减批次 + 缩减批次 ≥3 试验覆盖；
  缺省 `legacy` 保持冻结行为。
- `screenGoalScope='preferred'` 接线（此前注释声称但实现落 all）；C12 screen 15.5→4.8ms。
- 本机 100ms 实测（C04/C09/C12，8 次）：
  - legacy：C12 8/8 零试验（本次运行 plan+screen 吃满窗口）；C04 2/8 零试验；
  - balanced+preferred：C04 0/8、C09 0/8、C12 0/8 零试验；C12 16 试验、稳定选 claim@3；
    p95 91–96ms。
- 测试：`js5-budget`（5）通过。

## 失败/排除路线

- 严格 W×M×5ms 准入（仅改计时）会让 C12 几乎总是零试验或只跑 1–2 世界，2 试验覆盖
  会把 claim@3 翻成噪声 claim@2 → 已排除。
- 5ms 保底下 reduced batch 仅 1–2 世界 → C12 选 claim@2（错误方向）→ 已排除。
- add 策略在 C10 需 5 候选 × 1 轮 = 4 试验/候选，弱于 replace 的 8 试验/候选；保留为
  独立消融臂，不作为缺省。

## Pilot（goal-dev，40 种子，work 16，5p，方向 A，classic）

| 臂 | 第一名率 | 配对差 vs A0 | 95% bootstrap | W/L/T | 不一致率 | 8pp 所需 N |
|---|---|---|---|---|---|---|
| A0 基线 | 22.5% [10,35] | — | — | — | — | — |
| A1 replace | 27.5% [15,42.5] | +5.0pp | [−7.5,+17.5] | 4/2/34 | 0.15 | 184 |
| A4 组合 | 22.5% [10,35] | 0.0pp | [−15,+15] | 4/4/32 | 0.20 | 246 |

结论：pilot 效应小且区间跨 0；不据此选择主候选。主候选已在 PLAN 预注册为 A4（组合）。

## 独立确认（goal-confirm，200 种子，work 16，5p，方向 A，classic）

| 指标 | A0 基线 | A4 主候选 |
|---|---:|---:|
| 第一名率 [Wilson] | 30.0% [24.0,36.5] | 35.0% [29.0,42.0] |
| 种子级配对差 [bootstrap] | — | **+5.0pp [−2.0,+12.5]** |
| W/L/T | — | 32 / 22 / 146 |
| 不一致率 / 精确 p | — | 0.27 / 0.220 |
| 异常局 | 0 | 0 |
| 对对手平均分差变化 | — | −0.51 分 |

**判定：区间跨 0，证据不足，不能声称整体棋力提高或非劣。** 200 种子对 8pp
（按本次不一致率需 ~332）功效不足。只保留工程/局部决策改善结论。

## 性能（1000 局面 × 3 次，基线 e2361ed vs 候选 A4）

| 指标 | 基线 | 候选 A4 |
|---|---:|---:|
| p50 | 90.3ms | 90.8ms |
| p95 | 128.9ms | **100.1ms** |
| p99 | 140.7ms | **104.8ms** |
| max | 247.7ms | 440.6ms（late 零试验规划尾部） |
| 超 100ms | 1038/3000 | 151/3000 |
| 非法/错误/回退 | 0 | 0 |

配对差 p50 −1.29ms、p95 +15.84ms；候选更快 1590、慢 >10ms 532。
绝对 p95/p99 满足参考线，但逐局面增量门槛未过；不宣称全局面更快/可部署。
负载：开始 [9.08,13.06,16.74]，结束 [7.67,8.67,12.58]（10 核，外部任务并行）。

## 下一步

1. 更新 FINAL-REPORT / EXPERIMENTS / 证据并提交。
2. 目标完成判定（不替换冠军、不推送）。

## 恢复命令

```sh
# 构建
node web-v1/node_modules/typescript/bin/tsc -p web-v1/tsconfig.json

# 计量对账
node training/reports/js5-goal-optimization/run-20261025-01/scripts/verify-metrics-v2.mjs

# C10 探针
node training/reports/js5-goal-optimization/run-20261025-01/scripts/probe-c10.mjs --policy replace

# 预算探针
node training/reports/js5-goal-optimization/run-20261025-01/scripts/probe-budget.mjs --repeats 8 --label balanced --batch-admission balanced --screen-scope preferred

# 消融（示例）
node training/joint/duel.mjs --candidates js5 --players 5 --seeds 40 --block goal-dev --work 16 --directions A \
  --near-terminal replace --screen-scope preferred --batch-admission balanced \
  --out training/reports/js5-goal-optimization/run-20261025-01/evidence/ablation
```
