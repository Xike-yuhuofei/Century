# Century AI 6.0：第六阶段 P0 审计报告——冠军版本与评测身份污染

> 分支 `research/ai6-phase6-winrate-scaling`（基于 main@e7d3bfa，含 PR #26/#29/#30 全部成果）
> 报告日期：2026-10-24 · 环境：macOS Apple Silicon（目标环境 Mac mini M4 16GB）
> 状态：**P0 全部缺陷已修复并有「修复前失败 / 修复后通过」实证；实验前置门禁 PASS**

---

## 0. 结论速览

1. **P0 污染实锤（修复前实证）**：PR #30 晋级后 `CHAMPION_PARAMETERS` 携带
   `adapter: 'champion-guided'`，所有把该常量当作"历史冻结冠军"的评测路径
   从此静默运行 JS5。决定性证据：`confirm-replay-check.mjs`（第五阶段 js0
   24/24 逐位重放）在晋级后代码上跌至 **js0 classic 1/12、js0 diverse 2/12**；
   js5 重放从历史 4–6/12 跌至 1/12（对手池风格变体全部退化为冠军本体所致）。
2. **修复后实证**：同一工具重放恢复 **js0 classic 12/12、js0 diverse 12/12**；
   js5 5/12（回到历史墙钟截断区间 4–6/12）。
3. **修复内容**：①不可变版本注册表 `web-v1/src/ai/version-registry.ts`
   （legacy-js0 / legacy-js1 / joint-js5-frozen / joint-js6-experimental，
   参数逐字快照 + 指纹钉定 + 来源 commit）；②`decision.ts` 适配器分支
   championParameters 透传（冠军本体行为逐位不变，风格变体权重修改真实生效）；
   ③`adapter.ts` JS1 路径改用注册表 legacy-js0（不再被适配器分派劫持为 JS5）；
   ④duel/equivalence-audit/confirm-replay-check 全部经注册表解析历史版本；
   ⑤对手池单一事实来源 `training/joint/pools.mjs`。
4. **实验前置门禁**：`training/joint/version-gate.mjs` 六项检查全部 PASS
   （部署一致性 / 冻结指纹 / 10 版本决策金丝雀 / 8 组跨身份不等式 /
   gate=never ≡ legacy-js0 等价 / 历史证据抽查）。
5. **第五阶段证据审计**：25,600 局应为 **12,800 局**（摘要口径双计）；
   classic 池 12,800 应为 6,400。原始 JSON 重算一致，全部胜率结论不受影响；
   已在原报告追加勘误（原文保留）。

---

## 1. 污染路径审计（任务书 §3.1 逐项）

### 1.1 历史 JS0 经当前 CHAMPION_PARAMETERS 调用（实锤）

- `training/joint/duel.mjs` 候选分派：`kind === 'champion'`（js0/js1）路径
  硬编码 `chooseAIAction(game, { parameters: CHAMPION_PARAMETERS, ... })`。
  晋级前 CHAMPION_PARAMETERS 无 adapter 字段 → 走束搜索；晋级后携带
  `adapter: 'champion-guided'` → [decision.ts](web-v1/src/ai/decision.ts#L38)
  适配器分支优先命中 → **"js0" 静默运行 JS5**。
- `training/joint/equivalence-audit.mjs`：js0 候选与对手席均引用
  CHAMPION_PARAMETERS → gate=never 审计退化为 **JS5 vs JS5 自比**
  （形式上恒等价，失去鉴别力）。
- `training/joint/confirm-replay-check.mjs`：js0 重放分支同上。

**修复前失败证据**（本分支首次运行，dist 已重建至 HEAD）：

```
js0 classic: 1/12 逐位一致     （第五阶段记录：24/24）
js5 classic: 1/12 逐位一致     （第五阶段记录：4–6/12，墙钟截断负载敏感）
js0 diverse: 2/12 逐位一致     （第五阶段记录：24/24）
```

**修复后证据**（同一工具、同一历史数据、仅身份解析修复）：

```
js0 classic: 12/12 逐位一致
js5 classic: 5/12 逐位一致     （回到历史 4–6/12 区间——池构成恢复历史语义）
js0 diverse: 12/12 逐位一致
```

### 1.2 JS1 分派优先级（实锤）

`web-v1/src/js/adapter.ts` JS1（champion-contest）路径委托
`chooseAIAction(game, { parameters: CHAMPION_PARAMETERS, structure: 'beam-contest' })`。
晋级后适配器分支先于 structure 生效 → **JS1 静默运行 JS5**（beam-contest
被忽略）。修复：JS1 委托注册表 `legacy-js0`（冻结历史冠军参数）+ beam-contest，
与 JS1 冻结定义（PR #26 时代 = 当时冠军参数 + beam-contest）逐字一致。
测试：js1 决策序列 ≡ 显式 beam-contest（逐决策），且与 js5 存在差异。

### 1.3 对手池风格变体失效（实锤）

修复前 classicPool/diversePool 以 CHAMPION_PARAMETERS 为基座展开权重变体：
`{ ...c, tempoWeight: ... }` 保留 adapter/jointVersion 字段 → 适配器分派 →
权重修改被静默忽略 → **@tempo/@contest/@engine/style-rush/style-engine 全部
≡ 冠军本体**。classic 池 5 个身份实际仅 2 种行为，diverse 池仅 3 种。

修复（`training/joint/pools.mjs` 单一事实来源）：
- 冠军席 = `joint-js5-frozen`（当前正式冠军，适配器分派）；
- 风格变体基座 = `legacy-js0`（束搜索路径真实消费权重修改），修改幅度与
  第五阶段池逐字一致（当时冠军 = ai5-readiness-efficiency = legacy-js0，
  故变体数值与第五阶段完全相同，池语义连续）；
- `decision.ts` 适配器分支增加 **championParameters 透传**：任何 js5 血统
  变体的权重修改从此真实影响冠军基座规划（冠军本体传自身，行为逐位不变，
  由「透传自身 ≡ 默认」测试锚定）。

**行为差异证明**：金丝雀自对局显示 style-tempo/style-contest/style-engine/
style-rush 与基座均存在决策级差异（version-gate identity-inequality 8 组
不等式 + web-v1 测试逐变体断言）。

### 1.4 JS5 内部血统核查（无缺陷）

- JS5 冠军基座：`choosePlan(observation, championParameters ?? CHAMPION_PARAMETERS,
  profile, 'beam-rollout')`——晋级前后权重同为全 1.0 +
  `acquisitionVariant: 'readiness-efficiency'`（readiness-efficiency 变体是
  evaluator.ts 代码分派，非权重），**晋级前后 JS5 行为一致**；
- 轨迹镜像策略（joint-rollout.ts）硬编码 CHAMPION_PARAMETERS，同理不变；
- 等价审计（修复后）js5(gate=never) ≡ legacy-js0：4 局 195 决策零不一致。

### 1.5 gate=never 审计对照对象（已修复）

修复后审计的 js0 与对手席一律经注册表解析 legacy-js0——审计重新对照
"真正的历史束搜索冠军"，恢复鉴别力（本阶段金丝雀与 mini 等价审计均可证）。

## 2. 不可变版本注册（任务书 §3.2）

`web-v1/src/ai/version-registry.ts`（网页与 Node 经同一 dist 消费）：

| 版本 id | 算法族 | 参数快照 | 结构 | 来源 |
|---|---|---|---|---|
| `legacy-js0` | beam-search | ai5-readiness-efficiency（challengeIndex=9 晋级，全 1.0 权重 + readiness-efficiency 变体）逐字快照 = a69956a^ 的 CHAMPION_PARAMETERS = fixtures/legacy-champion.json | beam-rollout | a69956a^ / PR #19 |
| `legacy-js1` | beam-search | 同上（参数逐字相同） | beam-contest | PR #26/27 JS1 冻结定义 |
| `joint-js5-frozen` | champion-guided-joint-search | PR #30 champion.json parameters 逐字快照（adapter/jointVersion/budgetMs=100） | —（适配器） | a69956a / PR #30 |
| `joint-js6-experimental` | experimental | 占位（未注册算法实现前 `frozenVersion()` 抛错，拒绝参与对局） | — | 本阶段填充 |

纪律实现：
- 参数快照为独立对象（非 CHAMPION_PARAMETERS 引用），指纹（canonical JSON
  FNV 双通道）钉定于测试；金丝雀账本 `version-canary.json` 记录指纹 +
  10 个版本的决策序列 sha256（2p/3p × 2 种子自对局）；
- 算法身份由参数 + 结构 + 适配器 + 版本 id + 来源 commit 共同决定；
  adapter 版本金丝雀用 workUnits 固定工作量（确定性）；
- 实验报告（duel.mjs）逐 cell 记录 `versionRegistry` 快照与启动时
  `codeCommit`（证据时间戳纪律：进程启动时捕获）。

## 3. 历史数据证据审计（任务书 §3.4 / §十二.20）

对 `training/reports/js5-phase5/confirm/` 8 个 ablation JSON 逐文件重算：

| 项 | 报告声称 | 实际（重算） | 判定 |
|---|---|---|---|
| confirm 总局数（§0.2） | 25,600 | **12,800**（8 文件 × 1,600） | 口径双计，需更正 |
| classic 池局数（§5.1） | 12,800 | **6,400**（4 候选 × 4 人数 × 400） | 口径双计，需更正 |
| 每文件局数 | — | 1,600（4 人数 × 200 种子 × 2 方向） | 与协议一致 |
| 唯一种子 | — | 1,600（分区公式无重叠） | 与协议一致 |
| 异常局 | 0 | 0（8 文件全部 finished） | 一致 |

公式：4 候选 × 2 池 × 4 人数 × 200 种子 × 2 方向 = 12,800。
报告正文 §5 表格与 confirm-analysis.txt 的全部胜率/CI 数字与原始 JSON
一致（本审计用 compare.mjs 五类拒绝性校验口径复核抽样无误）——**错误仅在
总数陈述，不影响任何结论**。已在 `AI6-PHASE5-REPORT.md` 末尾追加勘误节
（原文保留不改）。

## 4. 随机流与信息公平性检查（任务书 §十二.4/.5）

- 公共观察与隐藏牌序隔离：既有 joint-fairness 静态扫描继续覆盖新增模块
  （version-registry.ts 仅含参数常量与纯函数，不接触引擎状态）；
- 模拟随机流：js5 决策 `simSeed = 对局种子`（第五阶段修复延续）；金丝雀
  与审计均不接触隐藏洗牌状态；random-legal 对手 RNG 流只依赖 (seed, seat)；
- 新增金丝雀摘要全部为公开决策序列哈希，无隐藏信息通道。

## 5. 实验前置门禁（任务书 §3.3）

`node training/joint/version-gate.mjs`（任何新胜率实验运行前强制执行）：

```
✓ deployment-coherence：champion.json ↔ CHAMPION_PARAMETERS 一致（joint-js5）
✓ frozen-fingerprints：4 个冻结版本指纹一致
✓ canary-digests：10 个版本决策摘要一致
✓ identity-inequality：8 组跨身份不等式全部成立
✓ gate-never-equivalence：js5(gate=never) ≡ legacy-js0（4 局 195 决策零不一致）
✓ historical-replay-spot：js0 历史对局重放 3/3 逐位一致
门禁结论：PASS（允许实验）
```

失败语义：任何一项失败 exit 1（拒绝实验）；金丝雀账本缺失 exit 2
（先 --bootstrap 并人工审查）。金丝雀漂移 = 身份或实现被改动 → 必须查明
原因并留痕后才能重新登记。

## 6. 测试与证据清单

| 测试 | 数量 | 覆盖 |
|---|---|---|
| web-v1/tests/version-registry.test.mjs | 11 | 冻结快照逐字钉定 / 指纹 / 分派身份 / js1 ≠ JS5 / 变体决策级差异 / 透传修复 / 占位拒绝 |
| training/tests/version-identity.test.mjs | 5 | 金丝雀账本一致性 / 池结构 / 历史池 / 决策级不等式 |
| version-gate.mjs（CLI） | 6 项 | §5 全部门禁 |

修复前失败证据存档：本报告 §1.1（confirm-replay-check 1/12、2/12）；
修复后通过证据：§1.1（12/12、12/12）+ §5 门禁全绿。
