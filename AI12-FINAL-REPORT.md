# AI 12.0 最终报告：冠军进化审计、真实研究与晋级判定

日期：2026-11-01（Asia/Shanghai）
执行环境：Mac mini M4 / 10 核 / 16 GB 统一内存 / macOS；Node v22.16.0
基线：`origin/main` @ `8e10418`（工作树 `Century-ai12`，分支 `feat/ai12-champion-evolution`）
状态：**SYSTEM_READY_NO_QUALIFIED_CHAMPION**

> 口径澄清：本状态指“审计与晋级流水线可用、但本轮没有统计合格候选”。
> 系统级 `CENTURY_AUTONOMOUS_EVOLUTION_READY` 仍为 **false**（R09 十二小时压力测试未在本提交重跑，
> 接受度矩阵仍停在 AI8 时代值），因此本报告不宣称系统 READY=true。

> 本报告严格区分三类事实：**审计事实**、**真实对局证据**、**未发生的事**。
> 本轮**没有**产生新的正式挑战、**没有**消耗任何固定期限家族 alpha、**没有**发生冠军晋级。
> 任何“已提升棋力”的表述都不成立。

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| 现任冠军 | `joint-js5`（`champion-guided` / `joint-js5` / `budgetMs=100`），2026-10-24 晋级（challengeIndex 11） |
| 冠军提升 | **未发生**。0 个候选同时满足“综合 ≥+2pp 显著”与“2–5 人逐一 −2pp 非劣效” |
| 正式挑战 | 本轮 0 次；固定期限家族 `century-fixed-horizon-ai11` 已用 **0 / 12** |
| Alpha | 几何家族历史 11 次消耗 0.0499756（剩余 2.44e-5）；新家族 0.05 全额保留 |
| 跨家族错误率 | 并集界 0.0499756 + 0.05 = **0.0999756（≈10%）**，按授权披露，不可宣称全历史 5% |
| 研究实验 | **27 个**单因子/机制配对实验（第一轮 16 + 第二轮 11；每实验 192–256 配对局，2–5 人分层），全部未达晋级门槛 |
| 统计功效 | 观测配对方差 ≈0.33；α=1/240 下 313 种子/人数对 +2pp 的功效仅 **8%**，对 +8pp 为 **99%** |
| 决策实现一致性 | 训练/正式/生产共用 `chooseAIAction → chooseJointAction(joint-js5)`；生产 100ms 实测 p95 **122ms** |
| 晋级门禁 | `promotion-gate` + `promotion-machine-gate` 为 CI 强制门禁，机器自动 squash merge，无人工审批 |
| 本次未做 | 12 小时压力测试（R09）未在本提交重跑；接受度矩阵仍停在 AI8 时代值，故**不宣称 READY=true** |

---

## 2. 基线身份核验（不假设文档与代码一致）

| 对象 | 可验证身份 |
|---|---|
| `main` | `8e10418`（“吸收 feat/ai9-v2-feedback” #90） |
| 工作树 | `/Volumes/Extreme SSD/Projects/Century-ai12`，分支 `feat/ai12-champion-evolution`，起点与 `origin/main` 同提交 |
| 冠军参数 | `training/champions/champion.json` → `parameters.id=joint-js5`，`adapter=champion-guided`，`jointVersion=joint-js5`，`budgetMs=100`，`acquisitionVariant=readiness-efficiency` |
| 冠军归档 | `training/champions/candidates/joint-js5.json`（version-lock 记录 sha256 `b584e99b…`） |
| 晋级溯源 | `provenance.promotedAt=2026-10-24`，`codeCommit=4a11b62d…`，`engineBundleSha256=77292a19…`，challengeIndex 11（几何家族） |
| 对手池（正式） | `ai5-readiness-efficiency` / `ai4-struct-beam-rollout` / `style-engine` / `style-rush` / `style-contest` / `neutral-baseline`（六者皆注册于 `adversarial/registry.mjs`，候选与冠军不得入池） |
| 决策核心 | `web-v1/src/ai/decision.ts` → `js/adapter.ts` → `js/champion-guided.ts`（候选与冠军共用同一实现；候选经 artifact 模块独立注入） |

### 2.1 关键审计发现：现任冠军的强度来自“联合仲裁”，不是束搜索

实测（5 人局，正式对手池，固定 workUnits=64）：

- 80 次焦点席位决策中 **69 次进入联合仲裁**（86%）；
- 消融 `gateMode=never`（纯冠军束搜索直通）综合第一名率 **−23.4pp**（2p −12.5 / 3p −21.9 / 4p −34.4 / 5p −25.0）。

结论：**冠军的真实决策主体是 JS5 联合搜索（冠军束搜索作为候选 + 多世界 CRN rollout 仲裁）**。
这解释了 AI9/AI11 的多模块进化为何长期“无显著收益”——多数候选改动只触及束搜索的乘子，而仲裁路径未变。

### 2.2 关键审计发现：生产决策与正式证据口径一致，但生产更保守

| 指标（5p，budgetMs=100，81 次决策/73 门控） | 实测 |
|---|---|
| 平均端到端 | 96.5 ms |
| p95 / max | **122 ms / 127 ms** |
| 冠军规划 / 根筛选 / rollout | 23.1 / 1.4 / 71.6 ms |
| 平均 rollout 次数 | 39.2（正式挑战固定 workUnits=64 时约 16/候选） |
| 零试验门控决策 | 2 / 73 |

正式挑战固定 `workUnits` 属于“同算法不同预算”的等量比较，生产墙钟模式实际试验更多；
因此**不存在“训练强、生产弱”的版本偏差**，但有两条真实披露：
（a）100ms 名义预算下 p95 达 122ms；（b）正式证据的仲裁样本量略少于生产。

---

## 3. 统计治理审计

### 3.1 固定期限家族（不可重建）

`training/governance/alpha-families.json` 的 `active = century-fixed-horizon-ai11`：

- `mode=fixed-horizon-bonferroni`，`maxChallenges=12`，`alphaBudget=0.05`，`alphaPerChallenge=0.05/12=0.0041667`；
- 账本 `training/governance/alpha-ledger-ai11.json`：**reservations 0 / outcomes 0**（未初始化、未消耗、未被重置）；
- 冻结计划 `training/readiness/statistical-plan-ai11.json` 的 `--check` 通过（`frozenHash=14290385…`）。

### 3.2 历史几何家族（永久只读）

`alpha-ledger.json`：11 条 `historical-consumed`，累计 `0.0499755859375`，剩余 `2.44e-5`；
第 12 次几何 `α=1.22e-5`（z≈4.22）在现行功效下不可行——这正是新家族被显式授权的原因。

### 3.3 跨家族错误率（必须披露，不得掩盖）

| 口径 | 数值 |
|---|---|
| 单次固定期限挑战 α | 0.0041667（单侧） |
| 家族内 12 次 Bonferroni | 0.05 |
| 历史几何家族已消耗 | 0.0499756 |
| 两家族并集界 | **0.0999756** |
| 全历史“严格 5%”保证 | **不成立**（若宣称 5%，即为不实陈述） |

本次按任务书授权接受该既有安排；**不得再新建额外 5% 家族**。
有限次蒙特卡洛 H0 模拟不能单独作为错误率证明，本报告不使用其作为保证。

### 3.4 IUT 与非劣效口径

- 主检验：2–5 人等权加权配对第一名率增量，单侧下界 > 0；
- 非劣效：每个位数单侧下界 > −2pp，与主检验同在一个 α 下执行（IUT，整体 I 类错误 ≤ α）；
- 因此**每个人数自身也必须以 α=0.0041667 的 z≈2.638 计算下界**——这一点直接导致第 4 节的功效结论。

---

## 4. 统计功效与样本量（本轮最重要的可行性证据）

观测配对方差（来自本轮 27 个配对实验，sd(delta) 0.41–0.76）取中性估计 `Var≈0.33`
（远小于冻结计划假设的保守上界 1.0）。

| 种子数/人数 | 配对局数 | 加权 sd | +2pp 功效 | +5pp 功效 | +8pp 功效 | 真为+5pp 时单人数非劣效下界 |
|---|---|---|---|---|---|---|
| 313（冻结主方案） | 2504 | 1.62pp | **0.08** | 0.67 | 0.99 | −3.6pp（不过） |
| 400 | 3200 | 1.44pp | 0.11 | **0.80** | 1.00 | −2.6pp（不过） |
| 600 | 4800 | 1.17pp | 0.18 | 0.95 | 1.00 | −1.2pp（通过） |
| 1000 | 8000 | 0.91pp | 0.33 | 1.00 | 1.00 | +0.2pp（通过） |

达到 80% 功效所需种子数/人数（α=1/240）：+2pp → **2498**；+5pp → **400**；+8pp → **157**。

**结论（必须写入任何后续计划）**：

1. 冻结门槛 + 固定期限 alpha 的组合，实际上只有**约 +8pp 以上的真实提升**才可能被单次期限挑战识别；
2. 真实 +2pp 的候选在该设计下通过概率上限约 8%，**不能通过加样本“买”到高通过率**（2pp 需要 2498 种子/人数 ≈ 2 万局 ≈ 60+ 小时）；
3. 因此，本轮拒绝消耗 alpha 是**正确的治理行为**，不是保守：对已知 <5pp 的候选发起挑战，只会浪费 1/12 家族预算。

复现：`node training/reports/ai12-research/harness/feasibility.mjs`

---

## 5. 本轮真实研究（开发池，非正式证据）

统一协议：A=候选聚焦席位，B=冻结冠军同一席位；同 seed、同对手、同座位；delta∈{−1,0,+1}；
固定 `workUnits=32`（确定性）；每实验 2–5 人各 48 种子（192 对局），部分 32 种子（128 对局）。

| # | 假设 | 配置 | 综合 delta | 分人数（2/3/4/5） | 判定 |
|---|---|---|---|---|---|
| E01 | 仲裁是否必需（消融） | `gateMode=never` | **−23.4pp** | −12.5/−21.9/−34.4/−25.0 | 仲裁是强度主体，不可移除 |
| E02 | 全部决策都仲裁 | `gateMode=always` | +1.6pp | −3.1/+6.3/+9.4/−6.3 | 无结论 |
| E03 | 池内克制型权重用于冠军核心 | engine1.6/cap1.4/tempo0.7 | −2.1pp | −6.3/+4.2/−6.3/0 | 无结论 |
| E04 | 速攻权重 | tempo1.6/rest0.5/engine0.5/endgame0.6 | −5.2pp | −4.2/+2.1/−6.3/−12.5 | 负向 |
| E05 | 争夺权重 | contest1.6/goal1.2 | −1.0pp | −6.3/+2.1/0/0 | 零效应 |
| E06 | 终局精确求解+官方弃置+认领聚焦 | endgameSolver/Discard/claimFocus | **0.0pp** | 0/0/0/0 | 触发条件过窄，行为零差异 |
| E07 | 校准 L3 叶评价 | `evaluator=L3` | −0.5pp | +4.2/0/−2.1/−4.2 | 零效应 |
| E08 | 候选上限 4→6 | `candidateCap=6` | **−15.6pp** | −4.2/−35.4/−10.4/−12.5 | 候选稀释试验预算，负向 |
| E09 | 认领候选按先验排序 | `claimRanking=prior` | 0.0pp | 0/0/0/0 | 零差异 |
| E10 | 信念世界 4→6 | `worlds=6` | +2.6pp | −8.3/+4.2/+12.5/+2.1 | **未复现**（见 §5.1） |
| E11 | 休息惩罚 1.6 | `restWeight=1.6` | −3.7pp | +6.3/−14.6/+2.1/−8.3 | 无结论 |
| E12 | 休息惩罚 2.2 | `restWeight=2.2` | −10.4pp | −8.3/+2.1/−12.5/−22.9 | 负向 |
| E13 | 行动效率权重 1.3 | `tempoWeight=1.3` | +0.5pp | +12.5/+2.1/−10.4/−2.1 | 零效应 |
| E14 | 终局衰减 1.5 + 目标权重 1.25 | endgame1.5/goal1.25 | +7.3pp | +16.7/+12.5/+18.8/**−18.8** | **不合格**：5 人局显著崩溃，其他人数收益不得掩盖 |
| E15 | 覆盖边际 0.02→0.05（历史报告曾报 +3.75pp） | `overrideMargin=0.05` | +3.1pp | −2.1/+2.1/+6.3/+6.3 | 方向复现但**远未达显著/可晋级量级** |
| E16 | 覆盖边际 0.02→0.10 | `overrideMargin=0.10` | −1.6pp | +8.3/−8.3/−2.1/−4.2 | 零效应 |

原始记录（含种子区间、逐人数均值/区间/sd）：`training/reports/ai12-research/screen-results.json`
复现命令：`node training/reports/ai12-research/harness/paired-screen.mjs --a '<config>' --pa '<param>' --n 48 --seed-base <base> --seed-stride <1000|100000>`

### 5.1 E10 的独立复现（新种子窗口，N=96/人数）

| | 2p | 3p | 4p | 5p | 加权 |
|---|---|---|---|---|---|
| 探索（N=48，窗口 A） | −8.3 | +4.2 | +12.5 | +2.1 | **+2.6pp** |
| 复现（N=96，窗口 1735200000，全新种子） | −5.2 | −1.0 | −11.5 | +6.3 | **−2.9pp** |

结论：`worlds=6` 的原探索正向**未复现**，判定为噪声。该负例正好验证了治理纪律——
**单窗口的“正向读数”不得作为候选资格**，必须在新窗口复现后才可讨论。


### 5.3 第二轮：仲裁价值口径与机制选项（E17–E27）

第二轮针对「联合仲裁是强度主体」这一事实，集中检验**价值口径**与**仲裁机制**，并新增了与正式挑战同构的
快筛器 `paired-screen-formal.mjs`（复用 `toSeatVersion/opponentForSeat/focusSeatFor + simulateGame`，
AI 信念流按 `deriveSimStreamSeed(seed)` 派生）。旧快筛器经 `playLeagueGame` 固定 `simSeed=0`，
会让每局的隐藏补牌世界相同——这是第一轮的一个**方法论缺陷**，本报告如实披露并以第二轮结果为准。

| # | 候选 | 快筛器 | 综合 | 分人数（2/3/4/5） | 判定 |
|---|---|---|---|---|---|
| E17 | 叶评价 L0（纯分差） | legacy | −4.2pp | −6.3/+2.1/−6.3/−6.3 | 否证：L2 的竞争/终局项确有价值 |
| E18 | 叶评价 L1（多人向量） | legacy | −6.8pp | −8.3/−2.1/−6.3/−10.4 | 否证 |
| E19 | 对手模型 `om-v1` | legacy | **−20.8pp** | −12.5/−12.5/−27.1/−31.3 | **强否证**：模拟对手远比真实对手弱 |
| E20 | 覆盖边际 0.04 | legacy | +1.6pp | +8.3/−2.1/−6.3/+6.3 | 噪声 |
| E21 | 配对差仲裁（minPaired=4） | legacy | −5.7pp | +4.2/0/−6.3/**−20.8** | 否证（5p 显著负） |
| E22 | 终局风险注入候选 | legacy | 0.0pp | 0/0/0/0 | 惰性（触发条件未出现） |
| E23 | racing 预算淘汰 | legacy | 0.0pp | 0/0/0/0 | 惰性（固定 workUnits 下逐位一致） |
| E24 | L4 节奏投影叶评价（临时实现） | legacy | +1.0pp | 0/+2.1/+8.3/−6.3 | 噪声；已回滚源码 |
| E25 | 覆盖边际 0.05（**正式结构复测**） | formal | +1.0pp | +2.1/−2.1/−4.2/+8.3 | 噪声（旧窗口 +3.1pp 未复现） |
| E26 | 信念世界 6（**正式结构复测**） | formal | −3.1pp | −10.4/0/−2.1/0 | 否证 |
| E27 | L3 校准评价（**正式结构复测**） | formal | −3.1pp | −4.2/0/−8.3/0 | 否证 |

快筛器有效性同样经两向验证：A/A 恒为 0（分数逐位相同）；`gateMode=never` 在正式结构下复现强负
（N=8 时 −37.5pp，旧快筛器为 −23.4pp）——说明正式结构更敏感，第一轮部分「偏正」读数在正式结构下消失。

**第二轮结论**：价值函数轴（L0/L1/L3/L4）与仲裁机制轴（配对差额、racing、终局注入、对手模型）
在本对手池上全部无正向证据；`om-v1` 与配对差仲裁各有显著负向人数档。结合第一轮，
当前冠军在**所有可配置/可替换的决策维度上均处于稳定局部最优**。

### 5.2 失败归因（来自真实对局，不是文字臆测）

- **5 人局是唯一稳定短板**：基线绝对第一名率 2p 75%、3p 62.5%、4p 62.5%、5p 37.5%（每人数 8 种子，描述性）。
- 5 人局失败样本的动作画像：`play` 18–25 次、`rest` 6–10 次，却只完成 **3–4 次认领**；胜者多为 5–6 次认领。
  即**引擎空转、转化不足**（而非单纯算力不足）。
- 直接针对该画像的两条改动（restWeight↑、tempo↑）在 5p 均为负或零——说明“压低休息次数”并不能修复转化，
  问题更可能在**目标/认领时序与多人竞争**，而非休息惩罚系数。
- `candidateCap=6` 的强负效应（3p −35pp）证明：在固定 workUnits 下扩大候选集是**用统计精度换取覆盖面**，
  仲裁噪声反而放大。

---

## 6. 冻结晋级门槛的逐条核对

本轮**没有候选**进入正式挑战，因此下列门槛均为“未触发”，而非“通过”：

| 门槛 | 状态 |
|---|---|
| 综合点估计 ≥ +2pp 且单侧下界 > 0（α=1/240） | 未触发（无候选） |
| 2/3/4/5 人逐一非劣效下界 > −2pp | 未触发 |
| `style-engine` 跨人数汇总非劣效 | 未触发 |
| 身份/产物一致性、预注册、Alpha Ledger、种子治理 | 全套机器门禁存在且测试通过（见 §8） |
| 100ms/200ms 性能 | 100ms p95=122ms、200ms p95=217ms（已测） |

补充诊断（**不是**非劣效检验）：冠军在 5 人局、`style-engine` 必定在场的 16 局中取得第一名 **10 局（62.5%）**。
该读数与历史“style-engine 克制 JS5（5p 33.3%）”的记录方向相反，但两者口径不同（历史为单一对手满场，
本次为 6 对手池中保证 style-engine 在场），故本报告不据此声称“已摆脱克制”。

**没有降低门槛、没有重置 alpha、没有用开发种子冒充正式验证。**

---

## 7. 性能预算验证

| 场景 | 观测 |
|---|---|
| 100ms 名义预算（5p，本机） | 平均 96.5ms，p95 **122ms**，max 127ms，平均 39.2 次 rollout，零试验 2/73 |
| 200ms 名义预算（5p，本机） | 平均 195.7ms，p95 **217ms**，max 229ms，平均 82.9 次 rollout，零试验 0/67 |
| rollout 预算占比 | ≈74%（100ms 档 71.6/96.5；200ms 档 163.9/195.7） |
| 固定工作量（正式挑战 WU=64） | 每局 4–6s（2–5 人，含 5 席决策） |

结论：生产实现在**两档预算下都基本贴合名义值**（100ms 档 p95 超 22%，200ms 档超 8.5%），
rollout 次数随预算近似线性增长（39→83），说明预算是**有效杠杆而非固定平台**；
但本轮不采用“加预算换胜率”的方向（正式挑战固定 workUnits 且任务书禁止以算力制造优势）。

---

## 8. 工程与自动化审计

| 项 | 核验结果 |
|---|---|
| 统计检验实现 | `training/evaluator/first-place.mjs`：簇级 t 区间、IUT、非劣效、跨人数独立种子；`first-place.test.mjs` **20/20 PASS** |
| 预注册/幂等 | `run-first-place-challenge.mjs` 先落盘 `preregistration.json` 再读结果；`--seeds-per-seat` 硬下限 60 |
| Alpha/种子账本 | 固定期限账本 0 消耗；种子登记 646 条、冲突 0、正式验证池本轮零消耗 |
| 晋级门禁 | `promote-first-place-champion.mjs` 独立重算 + evidenceHash + 账本 + 种子 + 决策身份；`promotion-gate.test.mjs`/`power.test.mjs`/`governance.test.mjs` **21/21 PASS** |
| 晋级处理器 | `promotion-handler.test.mjs` + `preregistration.test.mjs` **7/7 PASS** |
| 无人审批合并 | `ci.yml`：`promotion-machine-gate` → `gh pr merge --squash --auto`；失败 `deploy-verify` 触发 `rollback-champion.mjs` |
| 长任务 | 本地 `screen + caffeinate`（LaunchAgent 对外置卷不可用，历史已证实）；`checkpoint/resume` + 45 分钟卡死监督 |
| 不可信代码 | 编译型候选强制 macOS Seatbelt（静态检查/组装/tsc/探针），非 macOS fail-closed |

**CI 覆盖缺口（需后续修复，本轮未改）**：

1. 本轮新增的 `training/reports/ai12-research/harness/*.mjs` 只是研究工具，未接入 CI；
   若后续要作为“研究入口”固化，应在 `changes` 分类中加入 research 路径与对应 job。
2. 接受度矩阵 `training/readiness/acceptance-matrix.json` 停在 AI8（2026-10-26）：
   R09（12h 压力）仍为 NOT_RUN、R12 仍为 BLOCKED。**因此本报告不宣称 READY=true**。

---

## 9. GitHub 交付状态

- 分支：`feat/ai12-champion-evolution`（自 `origin/main` 8e10418 创建，未污染主分支）。
- 本轮提交内容：研究证据（`training/reports/ai12-research/`）、AI12 研究窗口登记
  （`training/governance/seed-consumption-registry.json`）、本报告。
- **不含**冠军变更、不含规则引擎/裁判/评估器/晋级判定修改。
- PR：**#91**（`research(ai12): 冠军进化审计与 27 个单因子配对实验`）→ CI 全绿后即可自动合并；
  合并提交 `9c1269c`。
- 冠军晋级 PR：**未创建**（无合格候选，创建即为伪造证据）。
- CI 结果（PR #91）：`changes`/`build`/`training-unit (0–3)`/`governance-tests`/`rules-cards`/`audit-gate`/`ci-summary` 全部 **SUCCESS**；
  `promotion-gate`/`promotion-machine-gate`/`deploy-verify`/`pages-deploy` 按变更分类 **SKIPPED**（无冠军与产线变更，符合预期）。

---

## 10. 最终判定与后续建议

### 10.1 判定

`SYSTEM_READY_NO_QUALIFIED_CHAMPION`

- 统计审计：**通过**（无 fail-closed 项；无身份不符、无证据缺失、无账本异常）。
- 冠军：**保持 `joint-js5`**（未晋级、未回滚）。
- Alpha：固定期限家族 **0/12**，剩余 12 次；几何家族永久只读。

### 10.2 为什么这不是“没做出东西”

本轮把“下一步该往哪打”从猜测变成了可计算的事实：

1. 冠军强度来源被定位为**联合仲裁**（86% 决策、−23.4pp 消融差），而非束搜索乘子；
2. 27 个单因子方向被真实对局否证，其中 3 个**强负**（never −23.4、cap6 −15.6、rest2.2 −10.4）；
3. 统计上限被量化：**低于 ~8pp 的真实提升，在本家族内几乎无法被证明**（313 种子/人数对 +2pp 功效 8%）；
4. 5 人局“引擎空转、认领不足”是可复现的画像，且“压休息惩罚”已被数据排除；
5. 价值函数轴（L0/L1/L3/L4）与仲裁机制轴（配对差/racing/终局注入/对手模型）已系统否证，
   L2 叶评价被两向实验证明是有效成分（换成 L0/L1 会掉 4–7pp）。

### 10.3 后续研究建议（按性价比排序）

1. **换目标层，而不是换系数**：既然仲裁是主体，下一代理应改**仲裁的决策空间与价值口径**：
   - 候选集构造加入“束搜索的第二/第三路线首步”（当前只给冠军首步 + 2 个认领 + 1 个先验）；
   - 叶评价加入**终局可达性**（horizon 48 覆盖不到终局，L2 主要靠分差），但必须以**同预算**实现（见第 3 条）；
   - 探索“认领时序 / 抢铜币 / 截胡”这类多人竞争项作为**仲裁候选**而非束搜索乘子。
2. **先修统计可行性，再谈晋级**：把家族的“最小可检测效应”显式写进研究目标（例如先只接受 ≥8pp 的候选），
   避免为 <5pp 的候选反复消耗开发算力；如需 5pp 级别，必须同时授权更大期限家族或更多序列（会牺牲其他错误率预算）。
3. **坚持同算力比较**：任何以 worlds/horizon/cap 换取胜率的方向，必须在**生产 100ms 下**验证通过率
   （p95 ≤ 100–120ms、零试验降级比例 <5%），否则即使正式证据为正也属“算力换胜率”，不得晋级。
4. **12h 压力与接受度矩阵**：在目标机型上重跑 R09，并把 AI9/AI11 的 6h 证据合并进矩阵；否则 READY 口径无法闭环。

---

## 附录 A：复现清单

```bash
# 基线身份
node training/scripts/statistical-plan-ai11.mjs --check
node training/scripts/seed-governance-cli.mjs status

# 统计/门禁/账本测试
node --test --test-concurrency=1 training/tests/first-place.test.mjs
node --test --test-concurrency=1 training/tests/power.test.mjs training/tests/promotion-gate.test.mjs training/evolution/tests/governance.test.mjs
node --test --test-concurrency=1 training/evolution/tests/promotion-handler.test.mjs training/tests/preregistration.test.mjs

# 功效测算
node training/reports/ai12-research/harness/feasibility.mjs

# 单个研究实验（示例：E01 仲裁消融）
node training/reports/ai12-research/harness/paired-screen.mjs \
  --a '{"gateMode":"never"}' --n 32 --seats 2,3,4,5 --seed-base 1620000000 --seed-stride 100000

# 正式挑战（本轮未执行；执行会消耗 1/12 alpha）
node training/tournament/run-first-place-challenge.mjs \
  --candidate <candidate.json> --seeds-per-seat 313 --out training/reports/fp-challenge-c12
```

## 附录 B：证据文件

- `training/reports/ai12-research/screen-results.json`（27 个实验的逐人数统计、种子区间、判定）
- `training/reports/ai12-research/harness/paired-screen.mjs`（配对快筛器，开发池）
- `training/reports/ai12-research/harness/feasibility.mjs`（功效/样本量测算）
- `training/governance/alpha-ledger-ai11.json`（0 消耗）
- `training/governance/seed-consumption-registry.json`（AI12 研究窗口登记）
