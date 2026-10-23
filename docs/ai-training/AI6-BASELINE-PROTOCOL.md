# AI6 冠军晋级与评测协议（草案 v1）

> 状态：**草案**。本文件随 `research/m4-baseline-freeze` 提出，供人工评审；
> **本 PR 不修改任何正式晋级门槛、不改 `pairedPromotionDecision` 判定逻辑、不动验证账本**。
> 正式生效需单独 PR 修订 `training/evaluator/stats.mjs` 与晋级脚本并通过评审。

冻结基线：冠军 `ai5-readiness-efficiency`（冻结清单 `training/baseline/champion-freeze.json`，
引擎产物 `c1dd8272ae15fb26d7724a9c1d1044bd2773bc13d898e3b937cd0c17d1acf8eb`，构建于 `b029567`）。

## 1. 动机

现行晋级统计量是「配对得分优势率」（决定性种子中双向平均分差 > 0 的比例），
真实第一名率仅作辅助披露。平均分优势可能来自"经常拿第二但分高"，而卡牌竞技的
用户可感知目标是**第一名率**。AI6 阶段建议把晋升主判定改为多人第一名率，
配对得分优势降为辅助指标（本 PR 已在基线报告中按此双轨披露）。

## 2. 冻结冠军基线

1. 冠军身份以 `training/champions/champion.json` 为唯一权威；
2. 冻结清单（`training/baseline/champion-freeze.json`）固化：
   参数快照、`championFingerprint`（id+结构+全参数）、引擎产物 sha256、
   晋级证据摘要、复现命令；
3. 引擎产物指纹必须与 `provenance.engineBundleSha256` 逐位一致；
   不一致时基线评测拒绝启动（`verifyChampionFreeze` 强制）；
4. 冠军时代产物可用 `championCodeCommit`（`b029567`）在独立 worktree 重建：
   `git worktree add <dir> b029567 && ln -s <repo>/web-v1/node_modules <dir>/web-v1/node_modules
   && cd <dir>/web-v1 && npm run build`（工具链由 package-lock 锁定，已验证逐字节复现）。

## 3. 多人第一名率评测设计（2-5 人）

对每个 N ∈ {2,3,4,5} 运行两种配置（`training/baseline/runner.mjs`）：

- **mirror（镜像）**：全部席位 = 冠军。用途：座位公平性标定（每席位第一名率
  期望 = 1/N）、延迟与吞吐标定。镜像配置不产生"冠军 vs 对手"语义的第一名率。
- **contest（对抗）**：双向配对设计（`challenge.mjs` 的 N=5 特例泛化到任意 N）：
  - 方向 A：冠军占 1 席（席位 = seedIndex mod N，覆盖全部座位）；
  - 方向 B：冠军占 N-1 席；同 seed 两方向共享洗牌序列（配对样本）；
  - 合并第一名率在无优势零假设下期望 = ((1/N) + (N-1)/N) / 2 = 0.5；
  - 对手池：前代冠军 + 中立基线 + tempo/contest/engine 风格变体（确定性轮换），
    **不含冠军本体**（冠军 vs 冠军属于 mirror 职责）。

### 3.1 指标定义

| 指标 | 定义 | 用途 |
|---|---|---|
| 第一名率（primary） | 冠军阵营 rank-1 局占比（contest 双方向合并） | 晋级主判定（本协议生效后） |
| 平均名次 | 冠军阵营终局名次均值（1..N） | 诊断 |
| 配对得分优势（辅助） | 每 seed 双方向平均分差 > 0 的比例 | 沿用现行语义，仅披露 |
| 座位胜率 | 方向 A 冠军席位逐座第一名率 | 座位偏差审计 |
| 对手风格胜率 | 冠军在各对手版本出现的对局中的第一名率 | 风格鲁棒性 |
| 决策延迟 p50/p95/p99 | 逐决策毫秒（`collectDecisions` 遥测） | 实时性验收 |
| 吞吐 | games/h（单核）、引擎 transitions/s（重放微基准） | 资源规划 |
| 异常局 | 非 finished 局数与原因 | 稳定性门槛 |

### 3.2 统计推断纪律

1. **同种子相关性**：同 seed 的双方向对局共享洗牌序列，是相关样本。
   第一名率主区间使用**按种子聚类的 bootstrap**（重抽样单位 = 种子，
   确定性 RNG，`training/baseline/stats.mjs#firstPlaceClusterCI`）；
   Wilson 区间仅作"独立样本近似"参考披露，不得单独触发晋级。
2. **种子唯一性**：每 seed 一个配对样本；重复种子一律抛错
   （复用 P0 整改的事故防御语义）。
3. **座位轮换**：方向 A 冠军席位 = seedIndex mod N，强制覆盖全部座位；
   报告逐座披露，座位间偏差 > 统计噪声时必须先修座位公平性再谈晋级。
4. **多重检验控制**：沿用几何 alpha 消耗（α_k = 预算/2^k，挑战序号来自
   验证账本 challengeCount）；若改为第一名率判定，z 分位数同样按 α_k 取
   bootstrap 区间对应分位（本协议生效时在 stats.mjs 落地并加属性测试）。
5. **异常率门槛**：沿用 2%（异常局绝不计入胜率）。

## 4. 种子隔离（评测纪律）

全局布局唯一权威 `ai5/lib/seed_policy.{mjs,py}`，本阶段新增：

- `AI6_BASELINE_BLOCK = [1.1e9, 1.2e9)`：冠军基线冻结评测专用；
  与 AI4 进化区 [0,300M)、AI5 专用块 [300M,400M)、AI4 基准区 [400M,900M)、
  验证池 [900M,1.06e9) 物理不相交；
- 子块布局与消费账本：`training/baseline/seed-ledger.json`（mirror-n2..n5 /
  contest-n2..n5 / repro-n5 / perf 各 1 万种子，顺序消费、绝不回退、绝不复用）；
- 训练 / 调参 / 正式验证 / 基线评测四类种子交集必须为零；
- 候选 AI 代码禁止触碰种子分配器、规则引擎、裁判与晋级脚本（沙箱 + 静态检查沿用）。

## 5. 公平性边界（不可协商）

1. 候选与冠军使用同一引擎编译产物、同一 AI 决策核心、同一合法行动枚举；
2. 候选只能通过席位版本注入（`versions`），不得修改公共编译产物
   （沿用"双轨席位隔离注入"的自动化测试验证）；
3. 禁止候选访问隐藏牌序等非公开信息（AIObservation 边界沿用）；
4. 晋级判定用种子必须来自验证池账本（若启用第一名率主判定，则基线/预筛
   不得消耗验证池种子，避免预筛过拟合正式验证集）。

## 6. 与现行晋级流程的关系

- 现行确认挑战（`challengeWithDecision` + `promote-champion.mjs` 独立重算）
  **保持原样**，本协议不改变其任何行为；
- 本协议生效路径（需单独 PR）：
  1. `pairedPromotionDecision` 增加第一名率判定模式（bootstrap CI 下界 > 0.5）；
  2. `promote-champion.mjs` 同步独立重算逻辑；
  3. 属性测试固化新语义；
  4. 过渡期双轨披露（两个统计量同时进证据），观察 ≥ 2 个完整挑战后再切主判定。
