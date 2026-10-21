# Century AI 4.0 冠军晋级任务复查摘要

- 日期：2026-10-21
- 范围：结构变体挑战扩样 → beam-rollout 冠军晋级全链路 → PR #11 合并与仓库清理
- 基线：Century AI 4.0 训练系统（PR #5–#10 已入库），首轮 100 种子结构挑战为 inconclusive
- 交付状态：main @ `54dcdf3`，工作区干净，CI 全绿

---

## 1. 任务目标

在既有自动进化训练系统上，解决结构变体挑战首轮样本量不足（每变体 100 种子）导致判定不确定的问题：加大种子量提高统计分辨力，并严格按证据执行冠军晋级全链路（不确定即保留冠军）。

## 2. 执行过程与证据

### 2.1 探索轮挑战（各 300 种子 = 600 局，seed 800100–800399，延续首轮 800000–800099 序列，不复用）

| 候选 | 先名率 | 配对均分差 95% CI | 配对先名率（判定用） | 结论 |
|---|---|---|---|---|
| beam-rollout | 0.540 | [0.90, 2.32]（显著为正） | 0.588，CI 下界 0.531 | **promote** |
| beam-adaptive | 0.465 | [−1.06, 0.46] | 0.468，CI [0.412, 0.525] | inconclusive，保留落选 |

- 实验设计：双向混战（候选 1 席 / 4 席合并期望 0.5）、同 seed 配对洗牌、席位轮换、对手池 = 仅冠军
- 两变体共 1200 局，0 异常

### 2.2 正式确认挑战（晋级门槛）

- 按验证种子账本协议取**新块 924142000**（上次消费块 924140000；账本真值从远端 artifact `evolve-state-latest` 下载核实，非本地臆测）
- 300 种子、600 局、0 异常
- 配对先名率 **0.634**（298 决定性种子，平局率 0.0067），95% CI **[0.578, 0.687]**，下界 > 0.5 → **promote**
- 挑战后立即记账 `validation-ledger.json`，块 924142000 永不复用

### 2.3 晋级链路执行（按既定协议顺序）

1. 组装候选文件（内嵌 `confirmation` 证据：seeds/games/seedBase/winRate/paired/ci/decision）
2. `promote-champion.mjs`：校验 promote=true 判定 → 归档候选至 `candidates/struct-beam-rollout.json` → 同步 `champion.json`（含溯源）
3. `apply-champion.mjs`：写入 web-v1 `CHAMPION_PARAMETERS` 生成区
4. `apply-champion.mjs --check` 终检通过

## 3. 代码变更清单（PR #11，squash 合并）

| 文件 | 变更 | 性质 |
|---|---|---|
| `training/scripts/apply-champion.mjs` | 生成区补透传 `structure`（此前缺失会导致网页端静默回落 beam-lineage，破坏"训练与实战同参"约束） | **缺陷修复** |
| `training/tests/cli.e2e.test.mjs` | 冠军基准 id 从硬编码 `v4.0-baseline` 改为动态读取 champion.json（晋级后基准演进，测试不得写死） | **缺陷修复** |
| `training/champions/champion.json` | 新冠军 `struct-beam-rollout`（含完整晋级证据 provenance） | 晋级落地 |
| `training/champions/candidates/struct-beam-rollout.json` | 候选归档 | 晋级落地 |
| `web-v1/src/ai/parameters.ts` | CHAMPION_PARAMETERS：`id: "struct-beam-rollout", structure: "beam-rollout"`，8 参数全 1.0 | 晋级落地 |
| `training/reports/structure-challenge-{rollout,adaptive}-r2/`、`-rollout-confirm/` | 三轮挑战全量数据（games/seed-pairs/summary + validation-ledger + candidate.json） | 证据入库 |
| `web-v1/dist/standalone.html` | 重建，已内嵌新冠军参数（mobile 端构建时自动取新冠军） | 产物同步 |

## 4. 验证结果

- web-v1 测试 **63/63**：含 ai-v2 血统救援 curated 用例在 rollout 结构下逐位复现、随机化牌库不变性、观察纯度、静态扫描、决策确定性
- training 测试 **26/26**：含 evolve-cli 端到端（修复后）、晋级链路、种子账本语义
- GitHub Actions CI 全绿后合并：test ×2、test-and-build、validate 全部 pass

## 5. 复查建议关注点（给第三方 AI）

1. **晋级判定标准**：配对统计（同 seed 双向对局为配对样本，非独立样本）、配对 CI 下界 > 0.5、min-seeds 门槛、证据不足时保留冠军——判定逻辑见 `training/evaluator/stats.mjs`（pairedPromotionDecision / wilsonCI / meanCI）与 `training/tournament/challenge.mjs`
2. **种子账本协议**：块间隔 VALIDATION_STRIDE=2000；本次块 924142000 与已消费块 924140000 无重叠、无历史复用；实现见 `training/lib/seeds.mjs`
3. **structure 透传修复正确性**：`training/scripts/apply-champion.mjs`（新增条件行写入）与 champion.json → parameters.ts → 构建产物的一致性（`--check` 已验证）
4. **决策确定性未被破坏**：beam-rollout 的 rollout 随机源由局面哈希派生（FNV-1a → mulberry32，`web-v1/src/ai/structures-rng.ts`），同局面决策逐位可复现、完全离线；确定性测试见 `web-v1/tests/ai-structures.test.mjs`
5. **信息公平性**：AI 决策仅经 AIObservation 消费公开信息；`web-v1/src/ai/**` 对 merchantDeck/golemDeck 零引用由静态扫描测试强制

## 6. 当前状态与后续

- main @ `54dcdf3`；13 条已合并远端分支已清理（PR #1–#11 均已入库），仓库仅剩 main
- 下一轮每日自动进化将以 struct-beam-rollout 为基准（对手池含冠军 + 风格变体 + 历史冠军归档）
- 可选后续（未获指令不执行）：CI 每周 challenge 集成结构挑战；对 beam-adaptive 加大种子再判；对胜出结构做参数深挖（evolve 已支持继承 structure）
