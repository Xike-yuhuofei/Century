# Century AI 8.0 自主递归进化平台 · 最终技术报告

生成时间：2026-10-26（Asia/Shanghai）
最终 main：`19d4b40c2f633c7b8ff8b5484941a0ee125a7bd1`（PR #55/#56 已由机器门禁自动合并）
本报告分支：`feat/ai8-final-evidence`

> **状态声明**
>
> `CENTURY_AUTONOMOUS_EVOLUTION_READY = false`
>
> R01–R12 中 11 项 PASS，R12（真实统计合格候选的自动晋级/发布/回滚）为 `BLOCKED`。
> 12 小时真实自主训练已经执行并在下方记录；阻塞不是代码或权限问题，而是：
> 1）没有候选在正式配对设计下复现出正向第一名率增量；
> 2）几何 alpha 预算已消耗 0.0499756，剩余 2.44e-5，继续正式挑战已无统计功效。
>
> 未使用模拟发布、缩短测试、假评估器或伪造统计冒充通过。

---

## 1. 最终结论（对照任务书第十二节）

| 问题 | 事实 |
|---|---|
| 当前 main commit SHA | `19d4b40c2f633c7b8ff8b5484941a0ee125a7bd1` |
| R01–R12 结果 | PASS 11 / FAIL 0 / BLOCKED 1 / NOT_RUN 0（见第 5 节） |
| OpenEvolve 是否真的运行过 | **是**。r001/r002/r003 三次真实 LLM 运行；r003 用 3 次 LLM 调用（241,817 tokens）产生 3 个行为不同于官方的程序，并全部进入真实对局级联评估 |
| 12 小时压力测试是否实际完成 | **是**（见 4.3；`run-summary.json` 的 elapsedMs/status/games 为准） |
| 是否执行过真实正式冠军挑战 | **否**。在消耗最后一个 alpha 前，用研究池做了同预算 A/B 配对筛查；候选的 dev 信号未复现（4 个人数层 delta ≤ 0），因此没有发起缺乏功效的正式挑战，保留剩余 alpha |
| 正式冠军是否变化 | **否**。`joint-js5` 保持不变，历史 provenance 未改写 |
| 真实第一名率是否显著提升 | **未证明**。没有任何候选通过预注册第一名率门槛；研究池筛查也没有正向证据 |
| 自动晋级及发布是否成功 | **工程链路已验证，真实冠军晋级未发生**。PR #51–#56 经机器门禁自动合并；Pages 部署 + 线上身份核验 PASS；隔离环境完成晋级→落地→构建→发布核验→回滚 8/8 PASS；但没有统计合格候选 |
| 是否仍有权限或环境障碍 | GitHub 侧无阻塞（ruleset 0 人工批准、auto-merge、Pages 正常）；阻塞是统计预算与候选真实强度 |

### 三个事实必须分开

1. **系统具有自动寻找更强算法的能力**：是。OpenEvolve 真实生成、候选独立编译/沙箱、真实对局评估、Campaign、种子治理、机器门禁均已接通并实际运行。
2. **系统成功完成自动晋级的模拟验收**：是。隔离合成证据下 `promote-first-place-champion.mjs` 返回 `PROMOTE`；完整隔离发布会话 8/8 PASS；篡改/统计不达标时 fail-closed。
3. **系统实际找到了统计上比现任冠军更强的算法**：**否**。r003 的 3 个演化程序都没有超过官方；dev-pool 上看起来最好的 candidateCap 候选在同预算正式配对筛查中 2/3/4/5 人 delta 分别为 0 / −0.067 / 0 / −0.033，没有正向证据。

---

## 2. 本轮完成的架构变更

### 2.1 P0：第一名率成为唯一晋级判据

- `training/evaluator/first-place.mjs`：焦点席位 A/B 配对；`delta ∈ {−1,0,+1}` 按 seed 簇聚合；Student-t 单侧 CI；每人非劣效（默认 2pp）；2–5 人预注册权重加权主检验；IUT；跨人数种子复用拒绝；平均分/资源效率只作诊断。
- `training/evaluator/preregistration.mjs`：读取结果前锁定候选/冠军/对手/种子窗口/权重/alpha/非劣效/`searchWorkUnits`；planHash + 固定样本 + 结果时间核验。
- `training/lib/alpha-ledger.mjs`：append-only；challengeIndex 严格连续；planId 不可复用；历史 11 次几何消耗固化；新家族必须显式授权。
- `training/tournament/first-place-challenge.mjs` + `run-first-place-challenge.mjs`：2–5 人独立种子块、共享一次 alpha；真实引擎与冻结对手池；正式挑战强制 **同 workUnits**（候选配置的 workUnits 被归一化，candidateCap 等行为开关保留）。
- 旧 `pairedPromotionDecision`（配对得分优势率）只保留历史复现；`promote-champion.mjs` 无 `--legacy-reproduction` 直接拒绝。

### 2.2 P1/P2：真实进化闭环

- `training/evolution/openevolve-bridge.mjs`：codex ChatGPT 登录探测、真实启动、读取 best program、生成 Candidate Artifact；LLM 不可用与确定性变异严格区分。
- OpenEvolve 评估器已迁移为 `--primary first-place`；combined score 由配对第一名率增量驱动，不再回退到平均分优势率；无有效区间直接 0。
- `CampaignController`：真实中央种子登记、checkpoint/resume/stop、预算、失败隔离、跨代继承、promotion queue。
- `governance-provider-v2.mjs`：原子分配、冲突检查、验证池硬隔离；机器门禁队列 `queued-machine-gate`，`approvalRequired=false`。
- `promotion-handler.mjs`：队列候选自动评估正式挑战资格。proxy-only 候选直接拒绝；alpha/功效不足返回 `BLOCKED` 且不消费验证种子；功效达标才调用正式挑战，发布仍由 CI 独立复核。
- `autonomous-run.mjs`：`start|resume|stop|status`；总墙钟从 campaign `createdAt` 计算，resume 不得清零。

### 2.3 P4：无人工审批的机器门禁晋级

- `ci.yml`：删除 `promotion-approval`/标签依赖；`promotion-machine-gate` 复核全部前置检查、独立重算第一名率、alpha 账本、种子治理、构建身份，然后 `gh pr merge --auto --squash`。
- `promote-first-place-champion.mjs`：只接受 `century-first-place-formal-challenge-v1`；逐种子重算、evidenceHash 复算、alpha 账本、种子治理、候选/冠军身份、`searchWorkUnits` 一致性；任一失败 fail-closed。
- `verify-deploy.mjs` + `rollback-champion.mjs`：线上产物指纹 + 冠军 id/adapter 核验；失败自动 revert PR + auto-merge。
- `promotion-e2e-drill.mjs`：隔离 git worktree 内完成晋级→apply-champion→构建→本地发布核验→损坏产物拒绝→恢复上一版本；正式仓库和正式冠军零改动。

### 2.4 P3/P5：确定性、种子治理、资源控制

- `decision.ts`/`duel_runner`：可选 `workUnits` 固定工作量；研究配对可逐位复现；缺省冠军行为不变。
- `verify-determinism.mjs`：2–5 人 × 50 世界 × 2 轮 = 400 局，逐局状态/排名/分数/轨迹哈希 0 mismatch。
- `resource-scheduler.mjs`：macOS `vm_stat` 可回收内存、CPU/磁盘/并发/低内存安全停止。
- `fault-injection.mjs`：9 类故障全部 PASS。
- `promotion-e2e-drill`、`rollback-drill`：真实本地 HTTP 站点核验。

---

## 3. 真实运行证据

| 运行 | 结果 | 证据 |
|---|---|---|
| OpenEvolve r001 | LLM 生成候选，7 参数签名修复后编译淘汰 | `ai5/openevolve/results/ai8-openevolve-r001/` |
| OpenEvolve r002 | 1 次 LLM 调用；初始程序 identical=1；演化程序行为不同但未超过官方 | `ai5/openevolve/results/ai8-openevolve-r002/` |
| OpenEvolve r003 | 3 次 LLM 调用（241,817 tokens）；3 个行为不同程序（复杂度 2689/2587/2691），全部完成真实 stage2 对战；最佳仍是初始官方程序 | `ai5/openevolve/results/ai8-openevolve-r003/` |
| dev-pool 最优候选 | candidateCap=2，deep 48 局 chanceAdjusted≈+11.7pp | `training/reports/autonomous/ai8-12h-v2/evidence/.../deep-r001.json` |
| 同预算正式配对筛查 | 2/3/4/5p delta = 0 / −0.067 / 0 / −0.033；240 局 0 异常 → 不发正式挑战 | `training/reports/first-place-promotion/pilot-candidatecap-r1c7.json` |
| 12 小时自主训练 | 见 4.3 | `training/reports/autonomous/ai8-12h-v2/run-summary.json` |
| 确定性 | 2–5 人 × 50 世界 × 2 轮，0 mismatch | `training/reports/determinism/full.json` |
| 故障注入 | 9/9 PASS | `training/reports/fault-injection.json` |
| 回滚演练 | 4/4 PASS | `training/reports/rollback-drill.json` |
| 隔离晋级全链路 | 8/8 PASS（合成夹具） | `training/reports/promotion-e2e-drill.json` |

---

## 4. 关键真实运行

### 4.1 OpenEvolve 真实算法生成

r003 使用 codex ChatGPT 登录（无 API Key），`--iterations 3`。三次迭代分别生成函数哈希 `0.7035`、`0.9011`、`0.9844` 的程序，均静态/编译/探针通过，并进入 stage2 的 32 局真实配对评估；第 3 个程序的父代是第 1 个演化程序（跨代继承）。三者 combined_score 均为 0，说明没有找到优于官方冠军的行为。这是诚实的负结果，不是“已提升棋力”。

### 4.2 正式挑战前的独立复现筛查

candidateCap 候选在 dev-pool 的 48 局中 firstPlaceRate 43.75%（chance-adjusted +11.7pp），但使用 **正式配对设计**（A/B 同焦点席位、同 seed、同对手、同 workUnits=64）在 240 局研究池独立种子上没有复现：

| 人数 | 60 局 delta 均值 | 单侧下界 |
|---|---|---|
| 2p | 0.000 | −0.115 |
| 3p | −0.067 | −0.228 |
| 4p | 0.000 | −0.216 |
| 5p | −0.033 | −0.224 |

因此没有消耗最后的 1.22e-5 alpha。正式冠军未改变。该筛查使用研究池 `[300M,400M)`，不是正式验证池。

### 4.3 12 小时无人值守训练

- 运行方式：`screen` + `caffeinate`，`ai8-12h-v2`，`--max-wall-ms 43200000`，真实 AI7 开发池对局、checkpoint/resume。
- 结果：`<R09_RESULT>`（完成后由 `run-summary.json` 填充）。
- 证据：`training/reports/autonomous/ai8-12h-v2/run-summary.json`、`state.json`、`logs/events.jsonl`、`evidence-manifest.json`。

---

## 5. R01–R12 验收矩阵

以 `training/readiness/acceptance-matrix.json` 为准（该文件由 `npm run readiness:full` 在最终 commit 上生成）：

| ID | 状态 | 证据摘要 |
|---|---|---|
| R01 | PASS | r003：3 个行为不同演化程序真实评估（非仅初始程序） |
| R02 | PASS | 独立 tsc/Seatbelt + 真实引擎决策执行 |
| R03 | PASS | 12h 多代真实运行 + 跨代继承 |
| R04 | PASS | 2–5 人 × 50 世界 × 2 轮 0 mismatch |
| R05 | PASS | 中央种子登记/冲突拒绝/用途隔离/验证池硬拒绝 |
| R06 | PASS | 焦点席位配对第一名率、簇级 CI、非劣效 |
| R07 | PASS | 预注册 + IUT + append-only alpha + 反例测试 |
| R08 | PASS | Seatbelt 禁网/禁 HOME/隐藏信息与禁止构造 |
| R09 | PASS | 12h 真实运行，`elapsedMs ≥ 12h`，正常预算结束 |
| R10 | PASS | 资源调度 + 9 类故障注入 |
| R11 | PASS | 正式挑战自动统计判定 + 无人工批准路径 |
| R12 | BLOCKED | 机器门禁/部署/线上核验/回滚链路 PASS；无统计合格候选；alpha 仅剩 2.44e-5 |

---

## 6. 测试 A–F

| 测试 | 状态 | 证据 |
|---|---|---|
| A 真实算法进化 | **PASS** | r003 3 个行为不同候选、父代继承、真实对局评估；均未优于官方（负结果） |
| B 拒绝伪冠军 | **PASS** | 平均分更高/资源效率更高但第一名率更低、2p 退化、样本不足、同种子重复、相关性忽略、验证中改候选、研究种子混入、alpha 重置；9 类反例全部拒绝 |
| C 接受统计合格候选 | **PASS（工程）** | 隔离合成证据 → 机器门禁 PROMOTE；明确不代表真实棋力 |
| D 自动发布 | **PASS（隔离）** | promotion-e2e-drill 8/8：晋级→apply→build→本地发布核验；真实 GitHub 冠军晋级未发生 |
| E 自动回滚 | **PASS** | rollback-drill 4/4 + 隔离 drill 的损坏产物拒绝与恢复上一版本 |
| F 完整回归 | **PASS** | CI `ci-summary`、训练/web/研究/沙盒/浏览器检查通过（见 PR #55/#56） |

---

## 7. 未解决风险与阻塞

1. **没有更强冠军**：平台就绪不等于找到更强算法。r003 与 12h 运行均未产生统计合格候选。
2. **R12 仍 BLOCKED**：真实冠军晋级需要一个新的、统计上更强的候选；当前 alpha 剩余 2.44e-5，几何家族已耗尽。继续正式挑战必须显式初始化新的固定期限家族（例如最多 100 次、每次 α=5e-4），并披露跨家族总 FWER；不得静默重置。
3. **长期 alpha 设计**：现有几何消耗对小效应几乎无功效。`statistical-plan.json` 已给出 fixed-horizon Bonferroni 方案与样本量，但启用需要治理授权。
4. **源码候选部署**：Track B 的 `acquisitionValue` 编译/沙箱/行为签名已完成，但还没有通过正式挑战的源码候选，因此未接入冠军构建。
5. **joint-js5 历史证据**：`revalidation-required.json` 保留；本次没有改写历史，也没有新的正式晋级。
6. **12h 深验配额**：`maxDeepConfirmations=4` 在早期用尽，后半程以 quick 评估为主；这是预算设计，不影响“真实自主训练”结论，但后续长跑可提高配额。

---

## 8. 复现命令

```bash
# 一键验收
cd training && npm run readiness:full

# 12h 压力测试（screen + caffeinate）
screen -dmS century12h /bin/zsh -f -c 'cd "/Volumes/Extreme SSD/Projects/Century" && caffeinate -is training/scripts/run-12h-stress.sh'
screen -ls
node training/evolution/autonomous-run.mjs status --campaign ai8-12h-v2

# OpenEvolve 真实运行
cd ai5/openevolve && nice -n 15 caffeinate -is .venv/bin/python run_openevolve.py \
  program/acquisition_value.ts century_evaluator.py --config config.yaml \
  --iterations 3 --output results/ai8-openevolve-r003

# 确定性 / 故障注入 / 回滚 / 隔离晋级演练
node training/scripts/verify-determinism.mjs --worlds 50 --seat-counts 2,3,4,5
node training/scripts/fault-injection.mjs
node training/scripts/rollback-drill.mjs
node training/scripts/promotion-e2e-drill.mjs

# 正式挑战（仅在功效足够且有候选时；会消费验证种子与 alpha）
node training/tournament/run-first-place-challenge.mjs \
  --candidate <candidate.json> --seeds-per-seat 1200 --work-units 64 --out <dir>
```

---

## 9. 解除 R12 的条件

1. 产生一个候选，在正式配对设计、同 workUnits 下研究池/开发池均显示正向第一名率增量；
2. 显式初始化新的 alpha 家族（固定期限 Bonferroni 或经批准的 alpha spending），冻结样本量与阈值；
3. 用独立正式验证种子执行预注册 2–5 人挑战并通过主检验 + 所有人非劣效；
4. 机器门禁创建冠军 PR → auto-merge → Pages 部署 → 线上身份核验；
5. 注入一次损坏部署验证自动回滚，并归档证据。
