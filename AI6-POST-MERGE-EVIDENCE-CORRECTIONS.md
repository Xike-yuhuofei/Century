# AI6 合并后证据更正（AI6-POST-MERGE-EVIDENCE-CORRECTIONS）

- 日期：2026-10-25
- 分支：`fix/ai6-post-merge-reliability`（基于 main@2b74003）
- 性质：**历史证据勘误与统计口径更正**。所有原始数据文件保留未覆盖、未伪造、未补造；全部更正以「附录/勘误节 + 本文档」形式呈现。
- 触发整改：夜间并行任务 A–E 合并后的独立红队复核（P0-3 联赛统计分层、PR #29 计数复核）。

---

## 一、更正清单总览

| # | 对象 | 原声明 | 更正 | 严重度 |
|---|---|---|---|---|
| C1 | PR #29（第五阶段 confirm） | 总局数 25,600 | **12,800**（双计伪影） | 声明口径错误；结论不变 |
| C2 | PR #40（预注册联赛） | style-engine 把 JS5 压到「显著低于 50% 区间」（33.3%，CI [0.192, 0.512]，n=30） | **撤回**：跨人数/协议合并 + 5p 基准误用（1/5 而非 1/2）+ CI 上界 0.512>0.5 本就不显著；分层后两人数均不显著 | 结论性错误；「克制信号」降级为待验证假设 |
| C3 | PR #40 | 「6/8 对手 ≥50%」「JS5 对全部 8 对手 ≥33.3%」 | 跨人数合并值；分层数值见本文 §三 | 表述口径错误 |
| C4 | PR #40 | 「联合搜索对 style-balanced 70% 增量实证」 | 分层后**仍成立且更强**（2p 80%、5p 60% 均显著高于各自机会基准） | 更正后反而加强 |

---

## 二、C1：PR #29 confirm 总局数（25,600 → 12,800）

- **原陈述**：`AI6-PHASE5-REPORT.md` 摘要「独立确认（决定性结果，25,600 局全新种子零异常）」。
- **错误原因**：统计口径双计。每个 (候选 × 对手池) 落盘文件含 4 人数 × 200 种子 × 2 方向 = 1,600 局；8 个文件（js0/js1/js5/js5-opt × classic/diverse）合计 **12,800 局**。25,600 将维度重复计入一次。
- **修正陈述**：confirm 块实际 **12,800 局，零异常**。各候选的方向 A 显著性结论（3p classic +11.5pp [0.3, 22.0]、4p +26.5 [17.5, 35.0] / diverse +12.5 [5.0, 20.5]、5p +22.0 [13.5, 32.0] / +18.5 [10.5, 27.0]，Bonferroni family=4 存活）与 2p 趋势不显著的结论**均不变**——它们基于种子级配对统计，样本基数未被双计影响。
- **原始证据来源**：`training/reports/js5-phase5/confirm/*/ablation-confirm-*.json`（8 文件、逐局 games 数组在案）；复核实现 `training/redteam/audit-evidence-accounting.mjs`（本分支已并入 audit-gate 研究层门禁）。
- **对既有结论的影响**：无（判定与晋级不受影响）；样本量引用需改为 12,800。
- **是否需要新的独立验证**：不需要。
- **勘误落点**：`AI6-PHASE5-REPORT.md` 末尾「附录：独立复核勘误」。

---

## 三、C2/C3：PR #40 预注册联赛按人数分层重算

### 3.1 缺陷机理（P0-3）

原 `buildWinRateMatrix()` 以 `(焦点版本, 对手版本)` 为汇总键，未含对局人数与比赛协议：
同一对的 2p 头对头（h2h）与 5p 有向场（field）合并进同一单元格（如 JS5 vs style-engine 的 n=30 = 15 h2h + 15 field）。
不同人数下第一名机会基准不同（1/2 vs 1/5），合并 Wilson 区间不可作强度判据。

### 3.2 重算方法与对账

- 工具：`training/adversarial/stratify-league-report.mjs`（从逐局原始 games 数组重算；`(seatCount, protocol, focus, opponent)` 分层；Wilson 95% CI 按层独立）。
- 对账：**逐局数守恒**——每对全部协议层 finished 合计（含 h2h 互补计数）= 原 v1 合并单元格数；无任何数据增删。
- 原始数据：`training/reports/adversarial-league/prereg/prereg-15s-official/league-report.json`（1620 局、0 异常，保留未动）。
- 分层结果：同目录 `stratified-corrections.json`（108 个分层单元）。

### 3.3 style-engine 结论撤回（C2）

| 口径 | 原声明 | 分层更正 |
|---|---|---|
| 合并（v1） | 33.3%（10/30），CI [19.2%, 51.2%] | 合并值本身无意义（机会基准混合） |
| 2p h2h | — | 40.0%（6/15），CI [19.8%, 64.3%]，基准 50% → **不显著** |
| 5p field | — | 26.7%（4/15），CI [10.9%, 52.0%]，**基准 1/5=20%** → **不显著**（点估计反而略高于 1/5） |

- **错误原因**：① 跨人数/协议合并；② 5p 有向场的机会基准是 1/5，不是 50%（原报告以 50% 判「被压制」）；③ 合并 CI 上界 0.512 > 0.5——原声明「显著低于 50% 区间」与其自引 CI 自相矛盾。
- **修正陈述**：「style-engine 克制 JS5」**撤回**。按人数采用正确机会基准后，两人数分层均无显著偏离。允许保留「潜在克制方向」作为研究假设，但必须以人数分层设计与后续独立验证为前提——且 5p 点估计（26.7% > 20%）目前**不支持**该假设方向。
- **对既有结论的影响**：PR #40 提交信息与 RESULTS-SUMMARY.md 的「克制信号确立」「唯一把冠军压到显著低于 50% 的对手」「第六阶段对手池应优先纳入引擎型方向」三条推论需按本更正重新评估；对手池扩研决策不应基于被撤回的显著性读数。

### 3.4 JS5 视角完整分层矩阵（C3）

| 对手 | 2p h2h（基准 50%） | 5p field（基准 20%） |
|---|---|---|
| random-legal | 100% [79.6, 100] **显著高** | 100% [79.6, 100] **显著高** |
| style-balanced | 80.0% [54.8, 93.0] **显著高** | 60.0% [35.7, 80.2] **显著高** |
| ai5-readiness-efficiency | 80.0% [54.8, 93.0] **显著高** | 26.7% [10.9, 52.0] 不显著 |
| ai4-struct-beam-rollout | 73.3% [48.0, 89.1] 不显著 | 60.0% [35.7, 80.2] **显著高** |
| neutral-baseline | 73.3% [48.0, 89.1] 不显著 | 53.3% [30.1, 75.2] **显著高** |
| style-rush | 60.0% [35.7, 80.2] 不显著 | 40.0% [19.8, 64.3] 不显著 |
| style-contest | 60.0% [35.7, 80.2] 不显著 | 26.7% [10.9, 52.0] 不显著 |
| style-engine | 40.0% [19.8, 64.3] 不显著 | 26.7% [10.9, 52.0] 不显著 |

- 「显著高」= 该层 Wilson 95% CI 下界 > 该人数机会基准（未做多重建档校正，属探索性显著）。
- 「6/8 ≥50%」「对全部 8 对手 ≥33.3%」为跨人数合并读数，引用一律以上表为准。
- n=15/层：任何单层读数统计功效有限；扩样（30s 档方案已入库）必须按人数分层设计。

### 3.5 C4：联合搜索增量（对 style-balanced）

原读数 70.0% [52.1, 83.3]（n=30 合并）。分层后：2p 80% [54.8, 93.0]、5p 60% [35.7, 80.2]，两层均显著高于各自机会基准（50% / 20%）——**结论成立且证据结构更清晰**。

### 3.6 修复与防回归

- `training/adversarial/league.mjs` v2：矩阵按 `(seatCount, protocol)` 严格分层（schema `century-adversarial-league-v2`），分层单元披露 局数/第一名次数/第一名率/Wilson CI/座位分解/异常局/焦点版本指纹；
- `evaluate.mjs` / `run-league.mjs` 消费分层单元；CLI 按人数分节打印；
- 分层不变量回归测试：`training/tests/adversarial-league.test.mjs`（「相同版本、不同人数/协议绝不合并」等 4 项新测试）；
- 历史报告处理：v1 原始 JSON 保留；v2 重算仅对**新实验**生效。

---

## 四、其余关联勘误（本分支整改中发现并修正的口径问题）

| # | 位置 | 原状态 | 更正 |
|---|---|---|---|
| E1 | `training/joint/duel.mjs` js0/js1 候选路径 | 传 `CHAMPION_PARAMETERS`（晋级后=JS5）→ 晋级后的 js0/js1 消融与 `gate=never` 等价审计基线失真 | 不可变版本注册表（冻结归档身份）；等价审计已重跑（JS5 gate=never ≡ 冻结 JS0：8 局 305 决策零不一致）；**历史 confirm 数据不受影响**（生成于晋级前，指纹 9ed80290 在案） |
| E2 | `training/joint/confirm-replay-check.mjs` | 用活动冠军身份重放历史 confirm 对局（js0 24/24 → 1/12、2/12） | 历史重放全部身份来自冻结归档；修复后 js0 重放恢复逐位一致口径 |
| E3 | 正式挑战链路模拟随机流 | challenge-11 全 500 局共用联合模拟噪声流（simSeed 缺省 0）；duel 侧曾以对局种子直传（洗牌种子暴露面） | 独立模拟随机流域 `deriveSimStreamSeed`（单向、域分离、CRN 保持）；**已验证 challenge-11 判定独立可复现（188W/60L/2T，promote）**，噪声流缺陷不影响其种子级配对统计的有效性 |
| E4 | `champion.json` 晋级指纹 vs 当前产物 | 晋级 PR 改动 champion-guided.ts（+166/−50）→ 晋级产物 ≠ 受试产物（77292a19 vs 后续重建） | 如实保留为 `REQUIRES_APPROVAL` 治理阻断（audit-gate promotion 层）；证据链本身诚实（77292a19 可由 4a11b62 逐字节复现）；修复需人工授权的新独立挑战 |

---

## 五、尚未解除的治理阻断（如实保留，不自动消费验证池）

1. **晋级证据指纹漂移（E4）**：当前活动冠军 joint-js5 的正式晋级证据（challenge-11）受试于 77292a19 产物；当前代码已演化。正式晋级治理要求对当前冻结产物执行新一轮独立挑战——**等待人工授权**（audit-gate `--tier promotion` 阻断中）。
2. **晋级证据人数覆盖**：challenge-11 按 5 人协议执行；JS5 已全人数部署但 2/3/4 人无正式晋级证据。修复后的挑战协议已支持 `--seats 2..5` 按人数独立成次（跨人数不合并判定），执行仍需人工授权与验证池新块。
3. **联赛种子账本**：PR #40 消费 [1403000000, 1403001620) 已作为历史只读事实导入 `training/adversarial/seed-ledger.json`；扩样（30-seed 方案）必须从账本未消费区间分配（`nextSeedBase`），禁止复用该区间或把重叠样本相加宣称独立。

## 六、复核与验证入口

```bash
# 证据核算（C1/C3/E3 复算）
node training/redteam/audit-evidence-accounting.mjs

# PR #40 分层重算（从逐局原始数据，幂等）
node training/adversarial/stratify-league-report.mjs \
  --in training/reports/adversarial-league/prereg/prereg-15s-official/league-report.json

# 三层审计门禁（dev 放行 / research 放行 / promotion REQUIRES_APPROVAL）
node training/redteam/audit-gate.mjs --tier dev
node training/redteam/audit-gate.mjs --tier research
node training/redteam/audit-gate.mjs --tier promotion
```
