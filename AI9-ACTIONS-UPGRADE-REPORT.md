# Century GitHub Actions 全面升级报告（AI9 架构同步）

- 分支：`feat/ai9-actions-upgrade`
- PR：https://github.com/Xike-yuhuofei/Century/pull/67
- 基线：`main @ 1905b3a`
- 证据运行：CI run `40322183056`（首跑，暴露 1 项真实缺口）、`40329160607`（全绿）
- 交付范围：`.github/workflows/*`、`scripts/ci/*`、`training/scripts/{automation-report,automation-state,rollback-gate-drill}.mjs`、`training/lib/code-version.mjs`、`training/evolution/autonomous-run.mjs`、`training/readiness/run-readiness.mjs`、`web-v1/tests/ai.test.mjs`（仅测试并行化，不改断言）、`docs/ai9/AUTOMATION.md`

---

## 一、验收结果（真实执行，未运行的明确标注）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 最新 AI 代码与 Actions 能力覆盖审查 | PASS | 见第三节缺口清单；`ai9` 变更范围 + `ai9-research` 作业落地 |
| 全部工作流通过语法/权限/安全/自动化元测试 | PASS | `verify-workflows.mjs` PASS；`node --test scripts/ci/tests/*.test.mjs` **85/85 PASS**；三份 YAML 可解析 |
| 训练断点恢复 | PASS | `automation-state` 在临时 bare 仓库真实执行 cold-start → push → 篡改本地 → pull 恢复（sha256 校验）；`ai9-endurance-audit` 的 stop/resume 判定保留 |
| 种子治理 | PASS | 中央登记随 `automation/state` 分支跨运行可见（此前云端每轮重新分配同一窗口）；queryInterval/reserveConsumption fail-closed 未改动 |
| 并发隔离 | PASS | `automation-state` push 冲突时 fetch+rebase 重放一次后失败关闭；campaign 文件锁与重复运行保护未改动 |
| 失败恢复 | PASS | 模拟评估 8 分片、状态 artifact `if-no-files-found: error`、训练有效性 `--validate` 失败关闭；9 类故障注入（既有）仍 PASS |
| 最新 AI9 算法进入受支持训练/评估入口 | PASS | `ai-training.yml` 新增 `coevolve`（真实 2–5 人开发池、single/pair/multi/crossover/ablation）；CI `ai9-research` 真实执行 12/12 接线与执行审计（run `40329160607` job 7m37s success） |
| 全部关键 CI 检查真实执行、无静默跳过 | PASS | `ci-summary` 独立复算变更范围；首跑即因 `ai9-research` 未出现在 `needs` 而失败（自证门禁有效），修复后全绿 |
| 自动冠军晋级端到端实测 | **BLOCKED（外部统计约束）** | 触发断层已修复并具备机器门禁；但没有统计合格候选：几何 alpha 已消耗 0.0499756，剩余 2.44e-5，功效门禁返回 `insufficient-statistical-power`（保留现冠军，属正确行为）。不伪造通过 |
| 线上部署身份验证 | PASS | `deploy-verify` 3 次重试 + `deployment-identity.json`；历史 run `40221527752` site=PASS；本次 PR 未触发 Pages（非 main） |
| 安全回滚演练 | PASS | `rollback-gate-drill.mjs` **8/8 PASS**（合法放行/手工改写拒绝/夹带拒绝/回滚循环拒绝/计划缺失关闭）；`rollback-drill.mjs`（既有）PASS |
| CI 耗时/吞吐可测量改善 | PASS | PR 墙钟 **21m29s → 9m34s（−55%）**；最长作业 **20m53s → 8m50s（−58%）** |
| 训练过程可复现/可审计/可追溯 | PASS | `automation-report`（时长/候选/淘汰原因/算法轨道/晋级 verdict/冠军与部署 identity/恢复与下一轮）+ `automation-state` manifest |
| 提交 PR + 运行证据 + 优化前后对比 | PASS | 本报告 + PR #67 |

未执行/阻塞项（不使用模拟通过）：

- `NOT_RUN`：真实冠军晋级（无统计合格候选；需新 alpha 家族的显式治理授权）。
- `BLOCKED`：Runner 上的 OpenEvolve LLM 提案（需本地 `ai5/openevolve/.venv` + codex 登录）；工作流写 `status=blocked` 并给出本地等价命令。
- `BLOCKED`（外部账户配置）：未配置 `AUTOMATION_TOKEN` 时，ruleset `require_extra_approval_for_unattributed_changes` 可能仍要求人工批准。代码不绕过规则集，仅 warning 提示。

---

## 二、优化前后对比（同一仓库、同样全量检查范围）

| 指标 | 基线（main push, run 40302123426） | 整改后（PR, run 40329160607） | 变化 |
|---|---|---|---|
| 墙钟 | 21m29s | 9m34s | **−55%** |
| 最长作业 | training-unit 20m53s | training-unit(0) 8m50s | **−58%** |
| 次长作业 | web-unit 13m04s | simulation 5m26s / ai9-research 7m37s（macOS，新增能力） | web 长尾消除 |
| 作业累计 | 56m33s | 59m54s | +6%（新增 ai9-research、web-long-tests 4 分片、回滚门禁、PPO/AI9 作业） |
| 覆盖率 | 全部 web/training 测试 | 完全相同 | **不变**（分片只重排执行位置） |

关键动作与量化依据：

1. **web 长尾拆分**：从 run `40322183056` 的 junit 产物定位到单一用例 `所有 1–4 AI 人数组合能持续合法行动并完成整局` 独占 844.7s（web-unit(3) 全部墙钟）。按人数拆到 4 个并行作业（种子仍 1–16 全量）后，最长 4m59s。
2. **training 分片实测权重**：`scripts/ci/test-runtime-weights.json` 修正纯字节代理的严重偏差；实测极端不均衡（848/360/166/165 秒）→ 300/232/230/232。
3. **模拟评估**：4 分片 9m20s → 8 分片 5m26s（100 局覆盖不变、种子连续不重叠）。
4. **晋级链路去重复构建**：promote 作业不再重复 promote→apply→build，统一由发布器在临时 worktree 完成。
5. **定时预算重排**：AI9 协同进化每日 25 分钟预算（原先无 AI9 云端轨道）、AI4 参数进化降为每周、新增每周 OpenEvolve 入口与 PPO 冒烟，避免同一预算内重复构建与空转。

---

## 三、缺口清单（审查发现的未接入能力）与处理

| # | 缺口（整改前） | 严重度 | 处理 |
|---|---|---|---|
| 1 | `GITHUB_TOKEN` 创建的晋级 PR 不触发 `pull_request`；dispatch 下 `promotion-machine-gate` 的 `if` 要求 PR 事件 → 被 skipped → `ci-summary` 必失败（本地已复现该判定） | P0 | 门禁支持 `pull_request`+`workflow_dispatch`；dispatch 必须绑定同 head SHA 的开放 PR；发布器创建 PR 后显式 dispatch（有 `AUTOMATION_TOKEN` 时走 App 身份自动触发） |
| 2 | 门禁即使运行也失败：用非 `--post-apply` 模式，而 PR 内 `champion.json` 已是候选本身 | P0 | 改为 `--post-apply --base-champion-ref origin/main`（新增 `git fetch origin main`） |
| 3 | `publish-promotion-pr.mjs` 创建 PR 后不触发 CI（AI9 处理器链路在 CI 中会永久挂起） | P0 | 新增 `--trigger dispatch|app|none`，默认 dispatch 并 fail-closed |
| 4 | 训练状态只从 `--status=success` 的运行恢复；artifact 30 天过期后断点与种子账本静默重置 | P0 | 新增 `automation/state` 分支持久化（manifest + sha256）；artifact 兜底不再按结论过滤；状态 artifact 缺失即失败 |
| 5 | 工作流成功 ≠ 训练有效（无候选/无产物都算成功） | P0 | `automation-report --validate`：无产物/未收尾/晋级请求无结果/PUBLISH_FAILED 一律失败；无候选显式披露 |
| 6 | 云端每轮重新分配同一开发种子窗口（中央登记不跨运行） | P0 | 训练前 `automation-state pull` 恢复中央登记，结束后 `push` |
| 7 | 训练启动即 `dirty=true`（恢复账本后），使 resume/R09 被误判代码不干净 | P0 | `computeCodeVersion` 排除 `training/{governance,state,reports}` 等运行时状态 |
| 8 | 回滚分支被当作晋级 → 永远无法合并；plain revert 会删除候选归档（与“历史归档不可覆盖”矛盾）；无回滚循环保护 | P0 | `rollback` 独立范围 + `verify-rollback` 从 git 事实验证 + 归档 append-only + 幂等 + 拒绝回滚回滚提交 |
| 9 | AI9 多模块协同进化/结构级候选**没有任何 Workflow 覆盖**（仅本地脚本） | P0 | 新增 `ai9` 变更范围与 `ai9-research` 作业（12/12 接线与执行审计，Seatbelt 真机）；`ai-training` 新增 `coevolve` 定时轨道 |
| 10 | MLP+PPO 只有单元测试，没有真实训练入口 | P0 | 新增 `ppo-smoke`（`train_cli` 真实训练 + 校验 `summary.json`/`last.pt`/迭代数） |
| 11 | OpenEvolve 无云端入口，能力边界未记录 | P1 | `ai9-openevolve` 作业 + 显式 `BLOCKED` 语义 + 本地等价命令 |
| 12 | 无统一运行报告；AI9 端无法定位“哪一环失败” | P2 | `automation-report.{json,md}` + 部署身份记录 |
| 13 | 部署核验单次失败即回滚（网络抖动可能误回滚） | P1 | 3 次重试后才判失败 |
| 14 | `champion-continuation` 在合并瞬间触发，部署尚未完成，且回滚也会重启训练 | P1 | 改为 `workflow_run`：CI 成功 + `deploy-verify=PASS` + 非回滚提交才触发 |
| 15 | 晋级处理器发布失败仍返回 `PROMOTE_EVIDENCE_READY`（会被误读为晋级成功） | P1 | 发布失败改为 `PUBLISH_FAILED`（新增单测） |
| 16 | `ai9-endurance-audit` 的 verdict 词表与处理器实际输出不匹配（真实 campaign 会被误判 FAIL） | P1 | 审核词表对齐真实 verdict |

---

## 四、可靠性防线（明确保留，未削弱）

- `ci-summary` 单一必需检查 + 变更范围独立复算 + 静默跳过失败关闭；
- 冠军机器门禁：预注册 planHash、固定样本、逐种子复算、alpha 账本、种子治理、构建身份；
- 几何 alpha 消耗账本（append-only，不可重置）与种子全局布局（`ai5/lib/seed_policy.mjs`）；
- 隐藏信息隔离、规则引擎不可进化、候选与冠军隔离运行、Seatbelt 沙箱；
- `--seeds-per-seat` 硬下限 60、`--post-apply` 基线校验、`origin/main` alpha 前缀防 last-write-wins；
- 规则集 `main-protection`（0 人工批准 + 必需检查 + 严格 up-to-date），代码不做绕过。

---

## 五、后续优化建议

1. **给冠军链路补一个“真实晋级”演练**：一旦治理层显式授权新的 alpha 家族（`initializeAlphaFamily(fixed-horizon-bonferroni)`），用小规模真实预注册挑战走完 PR→机器门禁→部署→下一轮，把 R12 从 `BLOCKED` 提升为 PASS。
2. **配置 `AUTOMATION_TOKEN`（GitHub App 优先）**：把 `unattributed-changes` 的人工批准要求彻底消除；工作流已支持自动切换身份。
3. **tournament.test.mjs 长尾**：单文件约 500s，是训练分片的剩余瓶颈。可对其中的真实对局用例按人数/种子参数化拆分（与本次 `ai.test.mjs` 同一模式），预计 PR 墙钟可再降 3–4 分钟。
4. **权重表自动刷新**：在 `governance-tests` 中定期从 junit artifact 生成新的 `test-runtime-weights.json` 并开 PR，避免手工维护漂移。
5. **AI9 云端预算校准**：观察每日 `coevolve` 的候选数与淘汰原因分布，据此调整 `quick-seeds/deep-seeds`，把 25 分钟预算更多投给深验。
