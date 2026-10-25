# Century 真人竞技复盘与失败诊断系统（training/human-analytics）

从真实对局记录中发现战略弱点的离线工具链。数据输入为 PR #28 网页自动导出的
`century-replay` JSON 格式；游戏规则与公开局面重建一律复用 web-v1 正式引擎
（`tsc` 编译产物），本目录不实现第二套规则。

## 前置构建（一次性）

引擎加载器会在缺失时自动尝试编译；也可手动执行：

```bash
cd web-v1 && npm install && npx tsc -p tsconfig.json   # 产出 dist/js/engine.js 等
```

## 命令

全部命令完全离线：不上传数据、不调用在线 API。

```bash
# 0) 生成 AI 模拟测试对局（正式引擎 + 脚本化策略，带 simulated-scripted 来源戳）
node training/human-analytics/cli.mjs fixtures --out training/human-analytics/fixtures

# 1) 只校验导入（schema / 合法性 / 完成状态 / 重复 / 元数据 / 异常清单）
node training/human-analytics/cli.mjs check 对局1.json 对局2.json

# 2) 完整分析：导入 → 指标 → 失败诊断 → 战术案例 → 报告
node training/human-analytics/cli.mjs analyze 对局1.json 对局2.json --out 报告目录 \
     [--max-cases 60] [--no-cases]

# 3) 跨局聚合（读取 analyze 输出目录里的 *.metrics.json / *.failures.json）
node training/human-analytics/cli.mjs aggregate --out 报告目录 --dir 报告目录 \
     [--js5 training/reports/js5-phase5/diagnostics-2p.jsonl]
```

退出码：0 成功；1 有记录被拒绝；2 用法错误。

analyze 对每个输入文件产出 4 个文件：

| 文件 | 内容 |
|---|---|
| `<名>.metrics.json` | 结构化指标（可观察事实 / 算法计算 / 战略推测三级标注） |
| `<名>.failures.json` | 失败诊断（8 类候选失败 + 证据 + 阈值；证据不足输出「无法判断」） |
| `<名>.cases.json` | 关键公开局面（供第六阶段 JS5/JS6 反事实分析；已剔除隐藏信息） |
| `<名>.report.md` | 人读 Markdown 复盘报告 |

聚合产出 `aggregate.md` + `aggregate.json`。

### 指标口径 v2（2026-10-25）

`metrics.json` 的 schema 从 `century-human-analytics-metrics-v1` 升为 `-v2`。
旧产物保留为 v1 研究结果，不重写历史；v2 修正以下已确认口径错误（详见
`js5-goal-optimization/run-20261025-01/evidence/metrics-v2-summary.json`）：

- `deadCards`：保持上游 P1-2 的**终局手牌快照**语义（兼容字段，本批 472）。
  v2 新增 `deadCardDetails` 与 `merchantUsage.neverPlayed`（按 acquire/play 时间线的
  "取后从未打出"，本批 179）；`usedThenRecovered` 记录终局在手但打出过的卡（293）。
  `failures.mjs` 使用 `neverPlayedAcquiredCount`，不再用快照数字判"死卡"。
- `discards.count` / `crystalsDiscarded`：v1 = 颜色编号求和（黄色编号 0 计 0 颗）；
  v2 = `colors.length`。本批旧累计 4 → 26 次弃置 / 47 颗。
- `missedClaims`：新增 `claimedLaterBySelf` / `claimedLaterByOther` /
  `firstLossOfTarget` / `repeatOfEarlierMiss` / `lossEventId`；本人稍后认领不再算被抢，
  同一 (席位,目标) 的跨回合重复只计首次流失。本批 150 条中自领 69、他领 76、
  始终无人 5；去重后唯一流失目标 52。
- `contestedLosses`：明确为 opportunity-only（他人认领时我也付得起），附
  `claimEventId`；不是"实际被抢次数"。本批 199 个席位机会事件 / 157 个唯一 claim 事件。
- `maxEngineSize` = hand+played；rest 间隔 = 个人回合差；`lateAcquires` = 触发手之后；
  新增 `meta.triggerScores/triggerRanking/triggerRankBySeat`（不拿终态回填）。

`failures.mjs` 同步停止把 contestedLosses 与自领事件相加；`cases.mjs` 的
missed-claim 案例只取 `claimedLaterByOther`。

## 输入格式

唯一权威来源：`web-v1/src/replay.ts` 的 `replayJSON()`（PR #28 自动导出）。
顶层：`{format:'century-replay', version:1, coverage, replay:{initial, turns[]}, current}`。
本工具另接受一个可选扩展字段 `provenance`（`{kind, generator, note}`）用于数据来源
标注——fixtures 生成器会给模拟对局盖 `simulated-scripted` 戳；真实网页导出没有该字段，
缺省按真人处理（若席位带 `isAI` 则标 `mixed-human-ai`）。

## 验证层次（任务 A）

1. **结构校验**：镜像 web-v1 `validateReplay` 判据（人数、牌目、回合序、行动形状、
   续手约束、playerTurn 一致性等），支持 2–5 人（6 人非官方扩展明确拒绝）。
2. **引擎重放验证**：从 `initial` 用正式引擎逐手重放，逐回合比对 before/after 玩家状态、
   cardId 与重放市场、completed 标志；终态与 `current` 全量比对——可检出牌库序篡改与拼接记录。
3. **完成状态**：未完成对局通过校验但带 `unfinished` 警告；终局相关诊断输出「无法判断」。
4. **重复检测**：对 `{initial, turns}` 的规范化 SHA-256 批内去重。
5. **异常报告**：错误（拒绝）与警告（放行）分级，全部写入报告。

## 失败诊断（任务 C）—— 8 类

`goal-competition` 目标竞争判断不足 · `engine-overbuild` 引擎建设过度 ·
`merchant-efficiency` 商人卡获取效率低 · `resource-mismatch` 资源结构与魔像目标不匹配 ·
`capacity-waste` 商队容量浪费 · `rest-cost-high` 休息成本过高 ·
`missed-claims` 错过关键认领 · `endgame-pacing` 终局节奏判断错误

纪律：每个标签必须附可检测证据与阈值常量；信号未达阈值输出「无法判断」（附原因）；
不以输赢判定单步对错。未完成对局的终局类诊断一律「无法判断」。

## 隐藏信息纪律（任务 D）

- 案例仅含决策时点**公开信息**（市场、钱币池、各席位公开区）+ 决策席位本人手牌 `ownHand`；
- 其他席位手牌、`merchantDeck`/`golemDeck` 牌库序不进入任何输出；
- 对局结束后存档中的完整牌库只用于内部引擎重放以重建「当时公开可见的市场」，
  绝不重新编码为决策输入特征；
- `assertNoHiddenInfo` 键级泄漏检查在每次 analyze 时强制执行（违规即抛错）。

## 测试

```bash
node --test training/human-analytics/tests/run-tests.mjs
```

覆盖：2–5 人导入、非法记录拒绝（坏 JSON / 错 format / 负库存 / 手数断裂 / 非法行动 /
状态篡改 / 牌库篡改 / 6 人）、重复检测、未完成与旧存档处理、指标与引擎一致性、
隐藏信息剔除与泄漏注入检测、案例优先级、CLI 端到端、输出确定性（重复运行逐字节一致）。

**数据来源声明**：本目录 fixtures 全部为 AI 模拟对局（正式引擎 + 脚本化合法策略，
带来源戳），不代表真人对局；接入真实人类对局后请直接用 `analyze` 处理网页导出文件。
