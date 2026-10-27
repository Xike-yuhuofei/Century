# AI 10.0 — LLM 实时决策玩家与策略数据采集实验报告

- 日期：2026-10-27（Asia/Shanghai）
- 分支：`feat/ai10-llm-player`
- PR：https://github.com/Xike-yuhuofei/Century/pull/70
- 合并：squash commit `830b9aea6f0aa870df6964382c0159d5c262acb6`（2026-10-26T18:43:58Z）
- 部署：https://xike-yuhuofei.github.io/Century/（Pages deploy + deploy-verify PASS，artifact `b105a2e56d246bb6`，冠军 `joint-js5`）
- 正式冠军：`joint-js5`（未修改）
- 真实 Provider：Codex CLI 0.149.1（ChatGPT 登录，`gpt-5.6-sol` / `gpt-5.6-luna`）
- 状态：P1/P2/P3-A/P4/P5/P6 完成；P3-B 完成但为**探索性/统计功效不足**；P3-C **BLOCKED（Codex 配额与墙钟预算不足，未运行）**

## 0. 结论先行

1. **真实 LLM 玩家已跑通**：Codex `gpt-5.6-sol` 在 2、3、4、5 人各完成一局从开局到终局的真实对局；随后 `gpt-5.6-sol` 触发 ChatGPT/Codex 用量上限，阶段 B 改用同账户 `gpt-5.6-luna` 完成 16 个配对（每人数 4 个预定义种子）。
2. **所有 LLM 行动均经正式引擎复核**：804 条决策（803 条 LLM 原始行动、1 条回退）中，非法建议 0 条；仅 1 条 Schema 失败触发离线冠军回退，已如实标记。
3. **数据系统可用**：逐局 JSONL 哈希链、SQLite 索引、断点恢复、完整导出、训练候选（MLP/PPO 编码）与 OpenEvolve M01–M12 诊断均已落盘并可复算。
4. **竞技结论**：阶段 B（n=4/人数）LLM 第一名率 4/16=25.0%，冻结冠军 2/16=12.5%，配对增量 +12.5pp；95% CI **−19.6pp 至 +44.6pp**，跨越 0。**不能宣称显著优势**；观察功效约 12.6%，需要约 99 个有效种子/人数才能对 25pp 效应达到 80% 功效。
5. **阶段 C BLOCKED**：预注册要求 106 个有效种子/人数（424 对，约 3.816 亿 Token、约 106 小时串行），当前 Codex 配额与墙钟预算不足；未开始确认阶段，未用阶段 B 小样本冒充正式确认。

## 1. 架构审查与复用边界

开发前已同步 `origin/main`，并在独立 worktree `/Volumes/Extreme SSD/Projects/Century-ai10` 中工作，避免影响并行 OpenEvolve/PPO 训练。

直接复用、未复制规则：

| 能力 | 权威实现 | 复用方式 |
|---|---|---|
| 游戏规则与合法行动 | [engine.ts](web-v1/src/engine.ts) | 所有行动最终由 `applyAction` 执行/复核 |
| 公开观察 | [observation.ts](web-v1/src/ai/observation.ts) | LLM 提示词与候选只消费 `AIObservation` |
| 合法行动全集 | [legal.ts](web-v1/src/sim/legal.ts) | 候选生成的上游枚举；未另写规则 |
| 离线冠军入口 | [decision.ts](web-v1/src/ai/decision.ts) | 回退与冠军影子决策复用 `chooseAIAction` |
| 对局/复盘 | [simulate.mjs](training/simulator/simulate.mjs)、[replay.ts](web-v1/src/replay.ts) | 复用回放格式与引擎终局语义 |
| 配对统计 | [first-place.mjs](training/evaluator/first-place.mjs)、[power.mjs](training/evaluator/power.mjs) | 种子簇配对 delta、t 区间、功效/MDE |
| PPO 编码 | [encode.mjs](ai5/ppo/bridge/encode.mjs) | `ai5-state-v1`/`ai5-action-v1` 直接用于训练候选 |
| 种子治理 | [seed_policy.mjs](ai5/lib/seed_policy.mjs) | 新增 AI10 独立研究种子块并登记 |

新增模块：

- `web-v1/src/ai/llm/`：共享决策层（候选、提示词、Schema、Provider、LLMPlayer、Mock）。
- `training/llm/`：Codex Provider、对局运行器、配对实验、存储、分析、预注册、本地代理。
- `web-v1/src/app.ts`：LLM 席位、思考状态、折叠决策详情、导出。
- `web-v1/scripts/smoke_llm_ui.py`：CI 确定性 Mock 代理 UI 冒烟。

## 2. LLM 玩家实现

### 2.1 Provider

- 真实 Provider：`training/llm/provider-codex.mjs`，调用 `codex exec --json`，`--ephemeral --ignore-user-config --ignore-rules --sandbox read-only`，`--output-schema` 约束最终 JSON，独立临时工作目录，超时/取消会终止子进程。
- 认证由本机 `codex login`（ChatGPT）管理；代码、日志、数据、前端与构建产物均不含 API Key。
- 模型与推理强度可配置：默认 `gpt-5.6-sol`、`reasoningEffort=low`；阶段 B 因 sol 配额耗尽切换为 `gpt-5.6-luna`。
- Mock Provider：`web-v1/src/ai/llm/mock.ts`，仅用于 CI/确定性自测；结果标记 `provider.mode=mock`、`evidenceClass=mock`。
- OpenAI-compatible 适配器与本地代理：`openai-compatible.ts`、`training/llm/proxy.mjs`；浏览器只访问 `http://127.0.0.1:8787/v1`，代理端持有 Codex 登录。

### 2.2 决策输入与公平性

每回合输入：

- 当前玩家公开库存、手牌、已打出、已认领、硬币、回合数；
- 所有玩家公开状态与公开估分；
- 6 张商人市场（含卡上奖励水晶、获取成本）与 5 张魔像市场（分值、费用、硬币奖励）；
- 全局铜/银池、阶段、终局触发者、人数、认领阈值；
- 公开卡牌全集与未翻开卡牌**集合**（不是顺序）；
- 合法行动候选与候选生成版本/裁剪统计；
- 本 AI 自己最近 4 条公开决策理由（用于策略连续性，不含隐藏信息）。

公平性测试：

- 隐藏牌库顺序随机化后，`AIObservation`、候选 ID/行动、系统/用户提示词与 promptHash 完全一致；
- 提示词/候选静态扫描不含 `merchantDeck`/`golemDeck`/`deckOrder`；
- 每个候选在多个局面 × 2/3/5 人上逐一喂给正式引擎，全部接受。

### 2.3 候选生成

- 使用 `enumerateLegalActions(dedupe=true)` 全量枚举；
- 认领/打出/休息/弃置全保留；
- 获取支付排列超过上限（64）时按公开状态派生种子确定性抽样，记录 `fullLegalCount/keptCount/pruned`；
- 候选 ID 由行动规范键哈希生成；同局面可复现；支付顺序被视为不同行动。

阶段 A/B 候选统计：阶段 A 平均全量 46.9、保留 26.5，34/155 决策裁剪；阶段 B 平均全量 54.7、保留 29.3，139/649 决策裁剪。

### 2.4 结构化输出与回退

严格 JSON 字段：`selectedActionId`、`reason`、`primaryGoal`、`alternativeActions`、`expectedBenefits`、`risks`、`strategyTags`。未知字段、未知行动 ID、空理由、超长字段均被拒绝；只保存可复盘字段，不保存隐藏思维链。

- 模型建议必须落在当前候选集，并由 `applyAction` 在深拷贝上复核；
- 超时、接口失败、非法 JSON、Schema 失败、非法行动、调用上限、Token 预算均记录真实原因；
- 回退顺序：冻结冠军 `joint-js5` → 首个公开合法候选；
- 数据区分 `source=llm` 与 `source=fallback`，绝不把回退伪装为 LLM 成功。

## 3. 决策数据系统

### 3.1 Schema 与存储

| 对象 | Schema |
|---|---|
| 运行 | `century-llm-run-v1` |
| 对局 | `century-llm-game-v1` |
| 决策信封 | `century-llm-decision-envelope-v1` |
| 回合信封 | `century-llm-turn-envelope-v1` |
| 数据集 manifest | `century-llm-dataset-manifest-v1` |
| 训练候选 | `century-llm-training-candidate-v1` |
| OpenEvolve 诊断 | `century-openevolve-diagnostic-case-v1` |

存储：

- `games/<gameId>/decisions.jsonl`：逐决策流式追加，SHA-256 记录哈希 + prevHash 链；
- `games/<gameId>/turns.jsonl`：逐回合行动、公开哈希、前后分数、合法性/来源；
- `games/<gameId>/result.json`：完整 replay、终局排名、焦点是否第一、回退统计、重放一致性；
- `pairs.jsonl`：配对结果哈希链；
- `index.sqlite`：games/decisions/decision_tags 索引，支持按人数、模型、来源、策略标签查询；
- `manifest.json`：文件级完整性、重复 ID、孤儿决策、计数、模型/代码版本；
- `analysis/`：仅派生数据，不覆盖原始 JSONL。

Schema 迁移入口 `training/llm/schema.mjs` 对未知旧版本 fail-closed；未来版本必须注册显式迁移函数。

### 3.2 中断恢复与完整性

- 对局运行器逐回合落盘；重启时重放 `turns.jsonl` 中已应用行动，恢复 LLM 调用/Token 预算与最近决策历史；
- 无法恢复的半局会改名归档（`*.partial-<timestamp>`），再从干净状态重开；原始文件不删除；
- `finalize` 逐记录复算哈希，发现篡改即写入 manifest integrity errors；
- 测试覆盖 5 人中断恢复：异常局重跑后从第 20 回合续接并正常终局。

### 3.3 训练候选与 OpenEvolve 诊断

- 训练候选 JSONL：`ai5-state-v1` 状态向量、`ai5-action-v1` 所选/实际/全部候选行动编码、候选排序、质量标签、终局第一名奖励、pairDelta、模型/promptHash/recordHash；阶段 A 全量 155 条已入库，阶段 B 全量 649 条约 18MB，可由 `analyze.mjs` 从原始决策重新生成（仓库提交 4 种人数各 10 条的 `training-candidates.sample.jsonl`，编码版本与字段完全一致）；
- 明确标记 `offlineOnly=true`、`notOnPolicyRollout=true`：历史 LLM 数据可用于离线模仿/诊断，不能当作新鲜 PPO on-policy rollout；
- OpenEvolve 诊断 JSONL：LLM 与冠军影子分歧、结果类别、涉及 M01–M12 模块、可复现 caseId、优化方向；只作诊断，不把 LLM 文字理由当奖励真值；
- 12 模块信号矩阵全部覆盖（阶段 B 分歧计数：M01 325、M02 400、M03 392、M04 410、M05 437、M06 434、M07 240、M08 240、M09 308、M10 439、M11 112、M12 400）。

## 4. 实验设计

### 4.1 配对设计

- 同一 seed、同人数、同焦点席位、同冻结对手（所有非焦点席位 = `joint-js5`）；
- A 局焦点席位由 LLM 控制，B 局焦点席位由冻结冠军控制；
- 焦点席位轮换：`pairIndex % seatCount`；
- 每个种子产生一个配对 delta ∈ {−1,0,+1}；主指标为焦点席位第一名率；
- 辅助指标：平均分、平均名次、魔像数、决策延迟、Token、回退率，不替代第一名率。

### 4.2 种子

| 阶段 | 种子块 | 每人数种子 |
|---|---|---|
| A 功能验证 | 1,700,000,000 起，按人数 1000 宽子块 | 1 |
| B 探索 | 1,700,010,000 起，按人数 10 万宽子块 | 4（预定义） |
| C 预注册确认 | 1,710,000,000 起，按人数 250 万宽子块 | 106（未运行） |

AI10 全部种子块与既有 AI4/AI5/AI6/AI9、正式验证池 `[900M,1.06e9)` 物理隔离；已写入 `training/governance/seed-consumption-registry.json`。

## 5. 真实运行证据

### 5.1 阶段 A：四种人数完整对局

| 人数 | 种子 | 焦点席 | LLM 名次 | 冠军名次 | delta | LLM 决策 | 回退 |
|---|---|---:|---:|---:|---:|---:|---:|
| 2 | 1,700,000,000 | 0 | 1 | 1 | 0 | 45 | 0 |
| 3 | 1,700,001,000 | 0 | 3 | 1 | −1 | 43 | 0 |
| 4 | 1,700,002,000 | 0 | 4 | 2 | 0 | 33 | 0 |
| 5 | 1,700,003,000 | 0 | 1 | 2 | +1 | 34 | 0 |

- 模型：`gpt-5.6-sol`；Provider：Codex CLI 0.149.1；`reasoningEffort=low`。
- 8 局全部正常终局；155 条决策；0 回退；1 次 120s 超时后重试成功（保留 `apiFailure=true`，标记 `interface-recovered`）。
- 重放一致性 8/8；隐藏信息泄露 0；解析成功率 100%；非法建议 0。
- Token 3,099,253；调用 156；决策延迟 mean 22.05s、median 20.19s、p95 38.08s。
- 证据：
  - `training/reports/llm-player/codex-smoke-2p-r1/`
  - `training/reports/llm-player/codex-smoke-345-r1/`
  - 汇总分析：`training/reports/llm-player/analysis-stage-a/analysis.json`

### 5.2 阶段 B：探索性配对

预注册/预定义计划：`training/llm/preregistrations/ai10-llm-exploratory-v1-luna.json`（每人数 4 个种子，共 16 对）。

- Provider：Codex CLI 0.149.1，`gpt-5.6-luna`，`reasoningEffort=low`。
- 16 对 / 32 局全部正常终局；649 条决策；1 条 Schema 失败回退（`selectedActionId` 不在候选集，2 次尝试后回退）；0 异常局。
- 回放一致性 32/32；隐藏信息泄露 0；解析成功率 99.85%；非法建议 0。
- Token 11,866,647；调用 650；决策延迟 mean 10.71s、median 10.26s、p95 15.16s；总墙钟约 120.9 分钟。
- 证据：`training/reports/llm-player/ai10-explore-luna-r1/`。

**无效 sol 运行**：同一预定义种子在 `gpt-5.6-sol` 上触发 ChatGPT/Codex 用量上限，128/153 决策回退（83.7%），被标记为无效证据，不计入 LLM 成绩；原始记录保留在 `training/reports/llm-player/ai10-explore-r1/INVALID-RUN.json`。

### 5.3 第一名率结果（阶段 B）

| 人数 | 有效配对 | LLM 第一 | 冠军第一 | LLM 率 | 冠军率 | 配对 delta | 配对 delta 95% CI | 观察功效 |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| 2 | 4 | 2 | 1 | 50.0% | 25.0% | +25.0pp | −87.7pp 至 +137.7pp | 12.6% |
| 3 | 4 | 1 | 1 | 25.0% | 25.0% | 0.0pp | −96.1pp 至 +96.1pp | — |
| 4 | 4 | 0 | 0 | 0.0% | 0.0% | 0.0pp | 0.0pp 至 0.0pp | — |
| 5 | 4 | 1 | 0 | 25.0% | 0.0% | +25.0pp | −33.8pp 至 +83.8pp | 12.6% |
| **等权汇总** | **16** | **4** | **2** | **25.0%** | **12.5%** | **+12.5pp** | **−19.6pp 至 +44.6pp** | — |

Wilson 区间（LLM/冠军）：2p 15.0–85.0% / 4.6–69.9%；3p 4.6–69.9% / 4.6–69.9%；4p 0–49.0% / 0–49.0%；5p 4.6–69.9% / 0–49.0%。

配对 delta 分布：+1 共 4 对、0 共 10 对、−1 共 2 对。

统计判断：

- 等权汇总增量为 +12.5pp，但 95% CI 跨越 0；**不显著**。
- n=4/人数时 MDE（保守方差 1）约 124pp，远大于任何现实效应；观察功效约 12.6%。
- 若观察到的 25pp 效应为真，约需 99 个有效种子/人数才能达到 80% 功效（单层 α=0.05）。
- 排除唯一受回退影响的 3p 配对后：15 对中 LLM 第一 3 对、冠军第一 2 对，delta +6.7pp；更无法支持优势结论。
- 4p 的 4 对 delta 全为 0、双方均未取得第一，区间退化；不代表“无差异已证明”。

### 5.4 辅助指标

| 人数 | LLM 平均分 | 冠军平均分 | LLM 平均名次 | 冠军平均名次 | LLM 魔像 | 冠军魔像 |
|---|---:|---:|---:|---:|---:|---:|
| 2 | 63.00 | 72.75 | 1.50 | 1.75 | 5.00 | 5.50 |
| 3 | 53.50 | 65.00 | 2.50 | 2.50 | 4.50 | 4.50 |
| 4 | 49.00 | 55.25 | 3.25 | 3.25 | 3.75 | 3.75 |
| 5 | 54.75 | 52.25 | 3.50 | 3.25 | 4.25 | 3.75 |

平均分/名次仅诊断，不作为竞技优势依据。

### 5.5 Token、延迟与费用

| 阶段 | 模型 | 决策 | 调用 | Token | 延迟 median / p95 | 边际 API 费用 |
|---|---|---:|---:|---:|---|---:|
| A | gpt-5.6-sol | 155 | 156 | 3,099,253 | 20.19s / 38.08s | $0 |
| B | gpt-5.6-luna | 649 | 650 | 11,866,647 | 10.26s / 15.16s | $0 |
| **合计** | Codex | **804** | **806** | **14,965,900** | — | **$0** |

Codex 使用本机 ChatGPT 订阅登录，无逐 Token API 账单；真实约束是订阅配额（sol 已耗尽、luna 可用）与墙钟。若改为付费 OpenAI-compatible Provider，必须按实际账单另计。

## 6. 数据质量

| 指标 | 阶段 A | 阶段 B | 合计 |
|---|---:|---:|---:|
| 决策数 | 155 | 649 | 804 |
| LLM 原始行动 | 155 | 648 | 803 |
| 回退行动 | 0 | 1 | 1 |
| 解析成功率 | 100% | 99.85% | 99.88% |
| 非法建议率 | 0% | 0% | 0% |
| 缺失理由率 | 0% | 0.154% | 0.124% |
| 重复记录率 | 0% | 0% | 0% |
| 完整对局率 | 100% | 100% | 100% |
| 重放一致率 | 100% | 100% | 100% |
| 隐藏信息泄露 | 0 | 0 | 0 |
| 教师候选样本 | 154 | 648 | 802 |
| 接口恢复样本 | 1 | 0 | 1 |
| 接口异常样本 | 0 | 1 | 1 |

质量标签严格区分：

- **teacher-candidate**：结构有效、理由/目标/替代方案完整、引擎接受、对局完整、重放一致；仍标记 `goldStandard=false`，需要离线验证，不默认正确；
- **interface-recovered**：曾发生超时但重试成功，最终为 LLM 行动；
- **interface-error**：最终使用回退，原因为 Schema/接口失败；
- 非法行动与“输掉对局”不混为一谈；没有因结果不利倒推单步决策错误。

唯一回退样本：3p、seed 1,700,110,001、turn 50，模型两次返回候选集外的 `selectedActionId`，触发离线冠军回退；该失败真实写入 `attempts/fallbackCause=schema-invalid`。

## 7. 策略分歧与 OpenEvolve 诊断

阶段 B：649 条决策中 439 条与同状态冠军影子不同，一致率 32.36%；阶段 A 一致率 49.03%。分歧只代表行动不同，不代表谁正确。

典型分歧：

1. **2p turn 1（LLM 最终第 2，冠军第 1）**：LLM 免费获取 M14，理由是建立蓝→绿/粉引擎并阻止对手拿牌；冠军影子选择 S02 连升两次（目标 G19）。后续 LLM 排名落后。
2. **5p turn 6（同结果）**：LLM 免费获取 M09，理由是先锁定高效率转换入口；冠军影子打出 M36 创造粉晶（目标 G16）。两者终局名次相同。
3. **3p turn 1（LLM 最终第 3，冠军第 1）**：LLM 免费获取 M09；冠军影子 S02 双升黄→绿。后续 LLM 落败。
4. **5p turn 51（阶段 A，LLM 第一 / 冠军未第一）**：LLM 免费获取 M07；冠军影子选择休息。该分歧后 LLM 最终第一。

这些案例已输出为 `openevolve-diagnosis.jsonl`，包含 involvedModules、结果类别、可复现 caseId 与优化方向；模块矩阵覆盖 M01–M12。它们用于提出候选搜索方向，**不是因果证明，也不是奖励真值**。

## 8. 网页集成与本地代理

- 设置页新增 `LLM 玩家` 席位选择（最后 N 个 AI）与本地代理设置；API Key 不进入浏览器。
- LLM 回合显示 `LLM 思考中…` 状态；决策完成后 AI 轨道/双人玩家区出现默认折叠的 `LLM 决策记录`，含行动、理由、目标、替代、收益、风险、标签、模型、延迟、Token。
- 顶栏提供 `LLM 记录` 导出按钮；导出 JSON 包含完整 game/replay 与所有结构化决策。
- 未配置/不可达代理时 LLM 席位自动回退离线冠军并显示真实原因；原离线游戏完全可玩。
- 本地代理 `training/llm/proxy.mjs`：仅监听 127.0.0.1，CORS 允许 localhost 与 GitHub Pages 源，处理 Private Network Access 预检，并发上限 2，不记录提示词/响应/凭证。

浏览器验证：

- 真实 Codex（sol）2p UI：1 次 LLM 决策，14.5s、17,565 Token，决策面板与导出成功；
- Mock 代理 UI：桌面 1440、移动 390×844 无横向溢出；思考状态、折叠详情、导出、不可达代理回退均 PASS；
- 现有 Focus / 五人对局 / 复盘 UI 冒烟 PASS。

GitHub Pages 为静态站点，必须在本机启动 Codex 代理。合并部署后已用 Playwright Chromium 从 `https://xike-yuhuofei.github.io/Century/` 实测：

- Pages 源跨域 `fetch` 本地代理 `/health` 返回 200，CORS/Private Network Access 预检通过；
- 1 真人 + 1 LLM 席位真实对局：`gpt-5.6-luna` 决策 11.1s、20,360 Token、回退 0，面板正常显示；
- console error 0、pageerror 0；
- 证据：`docs/ai10/pages-llm-browser-verification.json`、`docs/ai10/pages-llm-decision.png`、`docs/ai10/deployment-identity.json`、`docs/ai10/deploy-verification.json`。

## 9. GitHub Actions 与验收

CI 改动：

- `.github/workflows/ci.yml` 的 `ui-smoke` 增加 `python scripts/smoke_llm_ui.py`，并上传 `web-v1/dist/llm-ui-*.png` 证据；
- `scripts/ci/tests/scope.test.mjs` 增加 AI10 变更路径覆盖：`web-v1/src/ai/llm/`、`training/llm/`、LLM UI 冒烟、Web/Training 测试；
- 新测试：
  - `web-v1/tests/llm-player.test.mjs`：候选合法性、隐藏牌堆公平性、Schema、Mock Provider、超时/非法 JSON/接口失败/调用上限/Token 预算回退、引擎拒绝、行动键稳定、恢复接口（9/9 PASS）；
  - `training/tests/llm-player.test.mjs`：存储/恢复/哈希篡改/SQLite 标签索引/配对 CLI/分析+训练候选+M01–M12/种子分区/预注册/Schema 迁移/Codex 身份无密钥（9/9 PASS）；
  - `web-v1/scripts/smoke_llm_ui.py`：Mock 代理浏览器端到端 PASS（本地与 GitHub Actions 均通过）。
- CI 全部使用 Mock Provider；真实 Codex E2E 在受控本地环境执行，并保留原始 JSONL/replay/报告，CI 不依赖付费 API 或 ChatGPT 登录。

CI 结果：

- 首轮 PR CI：https://github.com/Xike-yuhuofei/Century/actions/runs/40364123477（14m13s，全绿，`ui-smoke` 首次通过）；
- 第二轮首跑在 Playwright 安装步骤 12 分钟网络超时；第 1 次重跑安装成功，但 WebKit 3440×1440 单帧 623ms>400ms 触发已知时序抖动（LLM UI Mock 冒烟本身 PASS）；本地 `smoke_desktop_runtime.py` 的 WebKit 3440 帧隙 21ms 全部通过；第 2 次重跑后通过（https://github.com/Xike-yuhuofei/Century/actions/runs/40366453562）；
- 合并前最终 PR CI：https://github.com/Xike-yuhuofei/Century/actions/runs/40377148554（18m43s，全绿，`ci-summary` PASS；training-unit 4/4、web-unit 4/4、ui-smoke、simulation、research 全部 PASS）；
- 合并后 main CI：https://github.com/Xike-yuhuofei/Century/actions/runs/40380347597（success；`pages-deploy` success、`deploy-verify` success、`ci-summary` success）；
- 部署身份：verdict PASS，artifact `b105a2e56d246bb6`，冠军 `joint-js5`，页面 `https://xike-yuhuofei.github.io/Century/`。
- 未通过项：无代码/测试失败；早期两次失败均为共享 Runner 安装网络与 WebKit 单帧时序抖动，已保留重跑记录。

## 10. 阶段 C 预注册与 BLOCKED

预注册文件：`training/llm/preregistrations/ai10-llm-confirm-v1.json`

- 目标效应 30pp、每人层 α=0.0125（Bonferroni 0.05/4）、功效 0.8、方差上界 1；
- 每人层需 106 个独立种子，共 424 对；
- 估算 424 局 LLM 对局 × 45 决策 × 20k Token ≈ 3.816 亿 Token；串行约 106 小时（未含冠军局与失败重试）；
- 当前 Codex 配额/墙钟预算不足，`execution.status=not-started`，未消费确认种子；
- 未用阶段 B 的 n=4/人数数据冒充确认；阶段 B 明确标记 `exploratory`。

BLOCKED 清单：

1. 阶段 C 正式确认未运行（Codex 订阅配额 + 墙钟预算）。
2. `gpt-5.6-sol` 在阶段 B 触发用量上限；阶段 B 改用 `gpt-5.6-luna`，结果只对 luna 模型成立；无效 sol 运行保留但不计入成绩。
3. 真实 Codex E2E 不在 GitHub Actions 中自动执行（无 CI 侧 ChatGPT 授权；CI 仅 Mock）。
4. 浏览器端 GitHub Pages → 本地代理的最终线上验证需在合并部署后执行。
5. 小样本（n=4/人数）不足以证明任何第一名率优势；需按预注册扩大样本。

## 11. 可复现运行说明

```bash
# 1) 真实 Codex Provider 探针
codex login status
codex exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules \
  --sandbox read-only -C /tmp -m gpt-5.6-luna \
  -c 'model_reasoning_effort="low"' --output-schema <schema.json> --json "只返回 JSON"

# 2) 阶段 A 冒烟（真实 Codex）
node training/llm/pair-experiment.mjs --stage smoke --modes 2,3,4,5 \
  --provider codex --run-id ai10-smoke-r1 --concurrency 2

# 3) 阶段 B 探索（预定义 4 种子/人数）
node training/llm/pair-experiment.mjs --stage exploratory --modes 2,3,4,5 \
  --seeds-per-mode 4 --provider codex --model gpt-5.6-luna \
  --run-id ai10-explore-luna-r1 --concurrency 2

# 4) 分析 + 训练候选 + OpenEvolve 诊断
node training/llm/analyze.mjs --run training/reports/llm-player/ai10-explore-luna-r1 \
  --out training/reports/llm-player/ai10-explore-luna-r1/analysis

# 5) 本地 Codex 代理 + 网页
node training/llm/proxy.mjs
cd web-v1 && npm run build && node scripts/serve.mjs
# 浏览器打开 http://localhost:4173，设置页填写代理地址 http://127.0.0.1:8787/v1
```

所有种子、模型、PromptHash、代码提交、Provider 参数、每局 replay、每条决策观察/候选/用量均落盘；分析程序只写 `analysis/`，不修改原始数据。

## 12. 下一阶段建议

1. **离线蒸馏**：优先用 802 条 `teacher-candidate` 做行为克隆预训练，再用冠军/模拟器做离线验证；严格按 `offlineOnly=true` 使用，不混入 PPO on-policy buffer。
2. **OpenEvolve**：以 439 条阶段 B 分歧为候选搜索信号，围绕 M01/M02/M05/M06/M10 等高信号模块做单模块/多模块变异，最终仍以真实 2–5 人第一名率验证，不以 LLM 文字理由作奖励。
3. **统计**：按预注册 n=106/人数准备独立确认；当前 n=4 只能作探索性读数；在配额允许时优先完成 2p/5p 层（当前方向性信号所在），但不得中途看结果加样本制造显著。
4. **Provider 稳定性**：增加按模型的配额探测、失败前置告警与自动切换策略（仍限 Codex 家族）；记录模型 slug/CLI 版本，控制版本漂移。
5. **Schema 重试修复**：对“候选 ID 不在集合”增加一次带合法 ID 列表的修复提示，降低 1/649 回退率。
6. **UI 线上验证**：合并部署后用 Chromium/WebKit 实测 GitHub Pages → 本地代理的 CORS/PNA 行为，并保留截图/日志。

## 13. 交付物索引

- 实现：`web-v1/src/ai/llm/`、`training/llm/`、`web-v1/src/app.ts`、`training/tests/llm-player.test.mjs`、`web-v1/tests/llm-player.test.mjs`
- 阶段 A 证据：`training/reports/llm-player/codex-smoke-2p-r1/`、`training/reports/llm-player/codex-smoke-345-r1/`、`training/reports/llm-player/analysis-stage-a/`
- 阶段 B 证据：`training/reports/llm-player/ai10-explore-luna-r1/`
- 无效 sol 运行：`training/reports/llm-player/ai10-explore-r1/INVALID-RUN.json`
- 预注册：`training/llm/preregistrations/ai10-llm-confirm-v1.json`、`ai10-llm-exploratory-v1-luna.json`
- 训练候选：`training/reports/llm-player/analysis-stage-a/training-candidates.jsonl`（全量 155 条）；`training/reports/llm-player/ai10-explore-luna-r1/analysis/training-candidates.sample.jsonl`（4 人数 × 10 条；全量 649 条由分析命令重新生成）
- OpenEvolve 诊断：`training/reports/llm-player/*/analysis/openevolve-diagnosis.jsonl`、`module-signal-matrix.json`
- PR：https://github.com/Xike-yuhuofei/Century/pull/70（MERGED，squash commit `830b9aea6f0aa870df6964382c0159d5c262acb6`）
- 合并前最终 CI：https://github.com/Xike-yuhuofei/Century/actions/runs/40377148554
- 合并后 main CI / Pages：https://github.com/Xike-yuhuofei/Century/actions/runs/40380347597
- 线上页面：https://xike-yuhuofei.github.io/Century/（deploy-verify PASS，artifact `b105a2e56d246bb6`，冠军 `joint-js5`）
- 部署证据：`docs/ai10/deployment-identity.json`、`docs/ai10/deploy-verification.json`
- 线上 LLM 浏览器证据：`docs/ai10/pages-llm-browser-verification.json`、`docs/ai10/pages-llm-decision.png`

## 附录 B：免费备用 Provider（2026-10-27 增补）

为缓解 Codex 配额瓶颈，新增两个**独立备用** Provider；它们未参与本报告阶段 A/B 的任何成绩，若用于阶段 C 必须单独预注册、单独报告模型。

| Provider | 模型 | 并发/间隔 | 真实验证 | 状态 |
|---|---|---|---:|---|
| GLM 4.7 Flash | `glm-4.7-flash`（thinking disabled） | 1 / 3s | 单决策 5.9s、4,224 Token、Schema 合法；2 人完整对局 44 决策、1 次 120s 超时回退 | 可用，偶发上游超时 |
| OpenRouter Free | `xingchen-agi/xing4.0-29b-a4b:free` | 1 / 4s | 单决策 9.7s（含间隔 16.2s）、5,559 Token、Schema 合法；代理 `/health` PASS、无密钥泄露 | 可用，受免费池 429/404 限制 |

共同安全与并发策略：

- 密钥仅在本机 `~/.century-llm/env`（chmod 600）或受控后端环境变量；仓库、日志、ProviderInfo、浏览器与构建产物均不含密钥；
- 免费接口默认串行；GLM 对 1305/429 退避最多 8 次、OpenRouter 429 退避最多 6 次；
- 浏览器通过 `LLM_PROXY_PROVIDER=glm|openrouter` 启动本地代理接入，前端仍只配置代理地址；
- 不使用 `openrouter/free` 路由器作为实验模型（实测会路由到不同模型，复现性不足）；
- 免费池存在严格 RPM/日额度与上游 429/404，**不适合作为阶段 C 的大样本主 Provider**，只作为 Codex 配额耗尽时的备用与探索通道。

证据：`docs/ai10/backup-provider-verification.json`、`training/reports/llm-player/glm-backup-smoke-r1/`。

运行示例：

```bash
set -a; source ~/.century-llm/env; set +a
LLM_PROXY_PROVIDER=openrouter node training/llm/proxy.mjs
# 或
LLM_PROXY_PROVIDER=glm node training/llm/proxy.mjs
```
