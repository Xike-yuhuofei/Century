# AI6 JS5 冠军晋级协议草案（第一名率一级指标）v1

> 状态：**草案**。本文件随 `research/js5-robustness-and-promotion-readiness` 提出，供人工评审。
> **本 PR 不修改任何正式晋级门槛、不改 `pairedPromotionDecision` 判定逻辑、不动验证账本、
> 不运行 `run-formal-challenge-js5` 消费验证池种子。**
> 正式生效需单独 PR 修订 `training/evaluator/stats.mjs`、`training/tournament/challenge.mjs`
> 与 `training/scripts/promote-champion.mjs` 并通过人工评审。

关联文件：
- 既有协议：`docs/ai-training/AI6-BASELINE-PROTOCOL.md`（第一名率主判定的动机与设计）
- 正式管线（现状）：`training/tournament/challenge.mjs`（5 人参数型候选 + 配对得分优势率判定）
- 正式晋级：`training/scripts/promote-champion.mjs`（独立重算 + alpha 消耗 + 账本核验）
- 并行基础设施（未生效）：`training/tournament/run-formal-challenge-js5.mjs`
  （JS5 经 adapter 注入的正式挑战编排；250 种子预注册；**运行即消费验证池——本阶段禁止执行**）
- 本阶段审核工具：`training/joint/js5-promotion-dry-run.mjs`（dry-run，不写任何正式状态）

## 1. 两套目标的现状审计（任务 F.1）

| 维度 | 既有 AI4/AI5 正式机制 | AI6 研发目标 |
|---|---|---|
| 判定量 | 配对得分优势率（决定性种子双向平均分差>0 比例） | 第一名率（rank-1 占比） |
| 人数 | 固定 5 人（SEAT_COUNT） | 2–5 人 |
| 候选形态 | AIParameters（+structure） | 任意版本化决策函数（joint adapter） |
| 对手池 | 缺省 = 仅冠军 | 多样化对手池（评测维度） |
| 种子 | 验证池账本块（[900M,1.06e9)）+ 几何 alpha | 各阶段专用块（confirm 块为预筛，不晋级） |

**结论：二者不一致。** 既有机制的判定均分优势可能来自"经常第二但分高"；
AI6 的用户可感知目标是第一名率。桥接方案见 §4（双轨过渡），不改既有判定语义。

## 2. JS5 候选注入的工程现状（任务 F.3/F.4）

1. **模拟器/挑战管线注入（已落地，未消费）**：并行基础设施提交 5528d4e 使
   `simulate.mjs` 支持 `version.schema.adapter='champion-guided'` 分派
   （jointVersion/budgetMs/gateMode 透传），`challenge.mjs versionsFor` 把候选
   adapter 字段透传到 version 顶层——JS5 作为"一等公民候选"可与冠军在
   同一正式管线对局，冠军席位决策分派路径逐字节不变。
2. **其他席位策略不变性（F.4）**：注入仅影响候选席位分派；对手席位仍走
   `chooseAIAction` 正式入口（duel/audit 的 versionsIds 披露 + gate=never
   等价审计构成回归防线）。
3. **晋级脚本侧缺口**：`promote-champion.mjs` 目前要求候选携带
   `parameters.id` + `confirmation.seedPairs`（配对得分优势率语义）——
   JS5 证据（第一名率 + 分方向 CI）需要 §3 的新判定模式，未实现前 JS5
   无法（也不应）通过现有脚本晋级。

## 3. 第一名率主判定的可审计挑战协议（草案）

### 3.1 判定统计量（一级）

- **单席位第一名率（方向 A）为主判定口径**：候选占 1 席、席位随 seedIndex
  轮转覆盖全部座位；统计量 = 候选席位 rank-1 局占比，种子级配对 bootstrap
  95% CI（重抽样单位 = 种子；同 seed 双向共享洗牌序列）。
- **方向 B（候选 N−1 席阵营）单独披露，不与方向 A 合并**；
  A+B 合并值仅作历史对照，报告必须标注"阵营混合口径"。
- 非劣判定（如需"不退化"结论）：非劣界值 Δ（建议 Δ = 0，
  即"配对差 CI 下界 > −Δ 且点估计不劣"），**必须在预注册时固定**。

### 3.2 多重检验控制（沿用几何 alpha 消耗）

- 正式挑战序号 challengeIndex = 验证账本 challengeCount + 1；
- 显著性阈值 α_k = 5% / 2^k（bootstrap CI 分位按 α_k 调整）；
- 多人数/多对照的家族性修正：主判定 = 每人数一个方向 A 对照；
  探索性对照（方向 B、对手池分组）不参与晋级判定；
- `js5-promotion-dry-run.mjs --family N` 提供 Bonferroni 参考值（仅披露用）。

### 3.3 数据完整性核验（独立重算清单）

正式晋级前，晋级脚本必须重算并交叉核对（dry-run 工具已实现同款）：
1. 证据产物指纹（engineBundleSha256）= 当前编译产物；
2. 种子全部落在验证账本本次消费块、逐 (seed, direction, candidate) 唯一；
3. (seed, direction) 网格完整、座位分配协议一致、对手版本配置一致
   （`compare.mjs` 的五类拒绝性校验）；
4. 异常率 ≤ 2%（异常局绝不计入胜率）;
5. 从逐局记录独立重算方向 A/B 第一名率与 CI，不信任自报结论。

### 3.4 异常与极端样本

- 零胜场附 Clopper–Pearson 精确上界（1 − 0.025^(1/n)）；
- 全胜场对称附精确下界；
- "CI 跨 0"一律判为"证据不足"，**不得表述为"已证明无退化"**。

## 4. 与既有协议的兼容与迁移（任务 F.7）

1. **既有机制保持原样**：`challengeWithDecision`（配对得分优势率 +
   minSeeds + 几何 alpha）与 `promote-champion.mjs` 现行行为零改动；
2. **过渡期双轨披露**：JS5 正式挑战证据同时给出配对得分优势率（既有判定）
   与第一名率（新判定）两套结论，双轨观察 ≥ 2 个完整挑战后由人工评审
   决定是否切换主判定；
3. **正式管线扩展（需独立 PR + 人工审核）**：
   - `pairedPromotionDecision` 增加第一名率判定模式（输入升级为逐局
     {seed, direction, won} 记录；判定 = §3.1/3.2）；
   - `promote-champion.mjs` 同步独立重算逻辑 + 属性测试；
   - challenge.mjs 支持多人数（现固定 SEAT_COUNT=5）与 adapter 候选的
     逐局指标（candidateWon 按席位集合计算）；
4. **回滚机制**：champion.json 历史与归档机制不变，晋级失败/退化可回滚。

## 5. 本阶段的边界（再次声明）

- confirm 块 [1.36e9,1.37e9) 的独立确认证据 = **预筛**，不构成正式晋级依据；
- 正式晋级种子必须来自验证池账本块（`run-formal-challenge-js5.mjs` 编排；
  本阶段**禁止运行**）；
- 本阶段不得修改 champion.json / 正式门槛 / 验证账本。

## 6. 人工评审决策点

1. 是否接受"方向 A 单席位第一名率"为晋级主判定（§3.1）；
2. 非劣界值 Δ 是否取 0（或需更保守，如 −2pp）；
3. 双轨披露过渡期长度（建议 ≥ 2 个完整挑战）；
4. 多人数候选（如"仅 4–5 人启用 JS5"）的晋级形态：champion.json 需要
   支持 per-seatCount 路由（schema 扩展，独立 PR）。
