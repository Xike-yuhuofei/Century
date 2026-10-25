# 夜间自主任务 D 报告：Century 真人竞技复盘与失败诊断系统

日期：2026-10-24 · 分支：`feat/overnight-human-replay-analytics`（独立 worktree，基于 origin/main e7d3bfa）· 目标：草稿 PR，不自动合并

## 1. 结论

交付了一套离线复盘工具链 `training/human-analytics/`，从 PR #28 网页导出的
`century-replay` JSON 导入真实对局，产出结构化战略指标、证据驱动的失败诊断、
可供第六阶段 JS5/JS6 反事实分析的公开战术案例、单局 Markdown 复盘报告与跨局聚合报告。
游戏规则零重复实现——合法性验证与公开局面重建全部复用 web-v1 正式引擎的编译产物。

14 项验收测试全部通过（`node --test tests/run-tests.mjs`）。

## 2. 关键设计决策

| 决策 | 理由 |
|---|---|
| 引擎复用而非移植 | web-v1 `tsc` 产物 `dist/js/engine.js`/`data.js`/`replay.js` 是纯 ESM，Node 可直接 import。重放验证、score/ranking 一致性、发币规则全部与正式游戏同源，杜绝「第二套规则」分歧。工具在 dist 缺失时自动调用本地 typescript 编译一次，失败则给出明确构建指引。 |
| schema 从真实代码读取，不臆测字段 | 通读 `web-v1/src/replay.ts`（replayJSON/validateReplay）与 `engine.ts`（Game/Player/ReplayTurn/Action），判据逐条镜像 `validateReplay`。 |
| 两层验证 | 结构校验（镜像判据，独立只读）+ 引擎重放校验（逐手 applyAction，比对 before/after/cardId/终态 current 全量）。牌库序被篡改会被 cardId-vs-market 或 final-state 比对捕获。 |
| 公开局面重建 | recorded turn 不含市场状态；用 initial（含牌库）重放以重建「每个决策时点公开可见的市场」。牌库序仅作内部模拟，输出经键级泄漏检查强制剥离。 |
| provenance 来源戳 | 导出格式无来源字段。定义可选扩展字段 `provenance`：fixtures 生成器给模拟对局盖 `simulated-scripted` 戳并全程标注；真实网页导出缺省按真人（席位 isAI 则 `mixed-human-ai`）。杜绝模拟数据冒充真人数据。 |
| 诊断证据化 | 8 类失败各设阈值常量并写入输出（`thresholds` 字段）；信号不足输出「无法判断」附原因；未完成对局终局类一律「无法判断」；不依据输赢判定单步对错。 |
| 确定性 | 输出不含时间戳/随机数；规范化序列化（键排序）+ 稳定排序；测试断言两次运行输出逐字节一致。 |

## 3. 模块清单（training/human-analytics/）

| 文件 | 任务 | 职责 |
|---|---|---|
| `engine-link.mjs` | 复用 | 定位/自动构建正式引擎，加载 engine/data/replay 三模块 |
| `import-games.mjs` | A | 结构校验、引擎重放验证、完成状态、批内去重（SHA-256）、版本元数据、异常分级报告 |
| `metrics.mjs` | B | 逐席位特征（行动分布/取卡节奏/引擎规模曲线/容量利用/休息/认领效率/被抢目标/错过认领/大商队无目标/终态资源结构），三级语义标注 |
| `failures.mjs` | C | 8 类失败诊断，证据 + 阈值 +「无法判断」机制 |
| `cases.mjs` | D | 关键公开局面提取（trigger > contested > missed-claim > overflow > endgame > claim > final-action 优先级截断）+ `assertNoHiddenInfo` 泄漏检查 |
| `report.mjs` | E | 单局 Markdown/JSON ×3、跨局聚合（失败类型统计/逐玩家聚合/来源标注）、js5 诊断 JSONL 摘要整合 |
| `cli.mjs` | E | check / analyze / aggregate / fixtures 四命令，退出码 0/1/2 |
| `fixtures-gen.mjs` | 测试管线 | 正式引擎 + 脚本化合法策略 + 正式 replayJSON 导出，盖 `simulated-scripted` 来源戳 |
| `tests/run-tests.mjs` | 验收 | 14 项测试 |
| `fixtures/`（6 个） | 样例 | 2/3/4/5 人完整局、未完成局、旧存档（replay=null） |

## 4. 验收对照

| 验收项 | 结果 |
|---|---|
| 使用真实格式测试样例 | fixtures 由正式引擎 + 正式导出函数生成，格式与网页 PR #28 导出逐字段同构（含 coverage 字符串、current 快照）；判据来源为真实 schema 代码 |
| 支持 2–5 人对局 | 2/3/4/5 人 fixtures 全部通过（认领目标 6/6/5/5 按 <4 人规则自动判定）；6 人明确拒绝（`unsupported-players`） |
| 非法记录拒绝 | 坏 JSON、错 format/version、负库存、手数断裂、非法行动（引擎重放拒绝）、行动后状态篡改、牌库序篡改、current 篡改、6 人、旧存档 replay=null → 全部拒绝且给出分类错误码 |
| 隐藏信息剔除检查 | 案例只含公开信息 + 决策者 ownHand；键级泄漏检查（merchantDeck/golemDeck/deck/hands/hand）在 analyze 内强制执行；测试含泄漏注入反向用例 |
| 同一记录可重复生成一致战术指标 | 确定性测试：CLI 两次 analyze 全部输出 SHA-256 逐字节一致；fixtures 同种子两次生成一致 |
| 完整操作说明 | [README.md](README.md)：前置构建、四命令用法、输出清单、验证层次、纪律说明 |
| 数据来源诚实性 | 全部 fixtures 标注 `simulated-scripted`；导入器识别 provenance 扩展字段并发警告；报告与聚合均显著标注「AI 模拟，非真人数据」 |

## 5. 演示运行（AI 模拟数据）

`analyze` 5 个模拟对局（2p/3p/4p/5p 完整 + 3p 未完成）：全部通过重放验证；
跨局聚合检出（模拟脚本策略的真实习惯，非真人结论）：
`merchant-efficiency` 13 席次（脚本策略常深位取卡）、`resource-mismatch` 12 席次、
被抢目标 14 次、超额弃置 46 次。js5 决策诊断整合演示（`--js5 diagnostics-2p.jsonl`）：
169 条决策、门控 89、覆盖冠军建议 30，单独成节并标注「AI 模拟数据，非真人」。

无真实人类对局文件（`century-replays/` 为空）；本阶段全部演示数据为 AI 模拟，
已按纪律标注。等真实对局积累后，直接 `analyze` 网页导出 JSON 即可复用同一管线。

## 6. 边界与后续

- **未做**：不改游戏规则/搜索算法/正式冠军；不改网页默认 UI；导出格式零改动（provenance 为可选扩展字段，旧导出不受影响）。
- **失败阈值**：初版阈值（如被抢 ≥2 次、深位取卡占比 ≥40%）偏保守且全部显式写入输出，便于后续用真实对局校准——阈值本身是可审计的假设，不是隐藏魔法。
- **js5 诊断整合**为决策级摘要（gated/overridden/胜负关联计数）；把 js5 决策日志与逐手重放深度联接（哪些决策落在被抢目标局面上）留给第六阶段。
- **单人维度聚合**按玩家名跨局（真人场景建议配合座位无关化）；未做任何身份/隐私字段处理——工具本地离线运行，不采集、不上传。

## 7. 提交内容

- 新增 `training/human-analytics/`（9 个模块 + 测试 + 6 fixtures + README + 本报告）
- 不修改任何既有文件；草稿 PR：`feat/overnight-human-replay-analytics` → main
