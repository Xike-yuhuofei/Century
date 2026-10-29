# Century AI9 自动化架构（GitHub Actions）

本文档描述本轮升级后的**唯一自动化入口、状态持久化、晋级门禁、回滚门禁与本地/云端分工**。所有实现以仓库最新代码为准；文档只解释边界，不替代代码与测试。

## 1. 工作流入口

| 工作流 | 触发 | 职责 |
|---|---|---|
| `ci.yml` | PR / main push / 手动 dispatch | 唯一 PR 门禁。变更分类、共享构建、web/training 单测分片、模拟、UI、研究、AI9 证据、晋级机器门禁、Pages 部署与线上核验、回滚 |
| `ai-training.yml` | 定时 / 手动 dispatch | AI9 每日协同进化、AI4 每周参数进化、AI9 OpenEvolve 入口、MLP+PPO 冒烟、统一晋级发布器 |
| `champion-continuation.yml` | `CI` 在 main 完成后（`workflow_run`） | 冠军变更且 `deploy-verify=PASS` 后，自动 dispatch 下一代 AI9 协同进化；跳过自动回滚提交 |

### 定时预算

| UTC | 北京时间 | 任务 | 预算 |
|---|---|---|---|
| 每日 02:30 | 10:30 | AI9 多模块协同进化（2–5 人真实开发池） | 25 分钟墙钟 / 600 局 / 200 候选上限 |
| 每周日 02:00 | 周日 10:00 | AI4 参数进化（legacy 回归轨道） | 40 分钟 |
| 每周日 04:00 | 周日 12:00 | AI9 OpenEvolve 多模块入口 | 45 分钟；无本地 LLM 时显式 `BLOCKED` |
| 每周日 06:00 | 周日 14:00 | MLP+PPO 冒烟训练 | 8 分钟训练预算 |
| 每周一 03:00 | 周一 11:00 | 大规模基线/周挑战 | 90 分钟 |

## 2. AI9 能力如何进入统一系统

- **生成**：`training/evolution/autonomous-run.mjs --coevolve` 走 `multi-module-generator`，支持
  `single / pair / multi / crossover / ablation` 策略、模块精英池与 MAP-Elites。
- **安全**：所有编译型候选经 macOS Seatbelt 隔离编译与静态检查；CI 的 `ai9-research`
  在 `macos-14` 上真实执行 12 模块接线审计与执行审计（12/12）后才放行。
- **评估**：真实 2–5 人对局、固定 `workUnits`、焦点席位配对；开发池种子在动用前原子登记。
- **候选进入正式挑战**：`promotion-handler` 在读取任何正式结果前判定 alpha/统计功效；
  不满足时明确 `BLOCKED`（保留冠军，不消费验证种子）。
- **正式挑战**：`run-first-place-challenge.mjs` 预注册 2–5 人种子窗口，独立验证池，
  几何 alpha 账本；证据逐种子可复算。
- **发布**：`publish-promotion-pr.mjs` 在干净的 `origin/main` worktree 重新执行
  promote/apply/build，校验并发 alpha 前缀，创建 PR，并按触发器 dispatch CI。
- **合并**：`promotion-machine-gate --post-apply --base-champion-ref origin/main`
  独立复核落地冠军、alpha、种子治理与构建身份，然后启用 auto-merge。
- **部署与下一轮**：Pages 部署 → `verify-deploy` 线上身份核验 → `champion-continuation`
  确认 `deploy-verify=PASS` 后 dispatch 下一轮 AI9 协同进化。

### 本地 / 云端分工

- 云端标准 Runner：有界 AI9 协同进化（**macOS Runner**：编译型候选依赖 Seatbelt）、AI4 回归（ubuntu）、PPO 冒烟（ubuntu）、全部 CI。
- 本地 Mac M4：真实 OpenEvolve LLM 提案（需要 `ai5/openevolve/.venv` 与 `codex` 登录）、
  12 小时长周期压力测试、需要 GPU/大内存的实验。
- 云端 `ai9-openevolve` 作业只做**可用性探测**：缺少本地 LLM/venv 时写 `status=blocked`
  并给出本地等价命令，绝不伪装成 OpenEvolve 成功。

## 3. 状态持久化与恢复

### `automation/state` 分支

`training/scripts/automation-state.mjs` 把以下小体积状态提交到独立分支（不写 main）：

- `training/governance/seed-consumption-registry.json`
- `training/governance/alpha-ledger.json`
- `training/governance/historical-seed-claims.json`
- `training/state/state.json`、`training/state/validation-ledger.json`（AI4）
- `state/ai9-latest.json`（AI9 campaign 指针）
- `state/manifest.json`（逐文件 sha256 + 运行身份）

每次训练先 `pull`，结束后 `if: always()` `push`；失败/取消的运行同样保存检查点。
`pull` 校验 manifest schema、路径安全与每个文件 sha256；任何缺失/损坏都失败关闭。

### artifact 兜底

AI9 campaign 的逐局证据与检查点仍上传 Actions artifact（30 天）。AI4 状态 artifact
不再按“成功运行”过滤，失败运行的更新状态也会被下一次运行采用；状态 artifact 缺失
直接失败（`if-no-files-found: error`），不会静默重置种子游标。

### 训练有效性判定

`training/scripts/automation-report.mjs` 生成统一 `run-report.json/md` 并执行
`--validate`：

- `status` 必须是 `completed` / `budget-exhausted`（或显式允许的 `stopped`）；
- 至少 1 个候选、至少 1 局真实对局；
- 有 `promotionQueue` 就必须有 `promotionOutcome`，否则判定晋级处理器被静默跳过；
- `CHALLENGE_ERROR` / `PUBLISH_FAILED` 等失败结果使训练运行失败；
- 开发池不得消费验证池、不得改动冠军、不得直接触发晋级；
- 无候选是**正常结果**：报告明确写“保留现任冠军，下一轮继续”，不会伪造成功。

## 4. 晋级与回滚的触发可靠性

### GITHUB_TOKEN 创建的 PR 不会触发 `pull_request`

这是 GitHub 的固有限制，不是配置问题。升级后：

1. `publish-promotion-pr.mjs` 创建 PR 后显式 `gh workflow run ci.yml --ref <branch> -f promotion=true`；
2. `ci.yml` 的 `promotion-machine-gate` 支持 `pull_request` 与 `workflow_dispatch`；
3. dispatch 运行必须找到该分支的开放 PR，并核对 `headRefOid == github.sha`，防止在任意分支伪造门禁通过；
4. `ci-summary` 在两种事件下都要求机器门禁真实 `success`，`skipped` 一律失败。

### Token / App 身份

- 默认使用 `GITHUB_TOKEN`（PR 由 bot 创建，走 dispatch 路径）。
- 推荐配置 `AUTOMATION_TOKEN`（GitHub App 或细粒度 PAT）到 Repository Secrets：
  - PR 由真实身份创建，`pull_request` 自动触发；
  - 规避 ruleset 的 `require_extra_approval_for_unattributed_changes`；
  - `ci.yml` 与 `ai-training.yml` 会自动优先使用该 secret。
- 未配置时不会伪造通过：机器门禁会给出 warning，若 ruleset 仍要求额外批准，
  晋级会停在 `BLOCKED`，直到配置 App/PAT。

### 回滚不是晋级

- `rollback/...` 分支或 `rollback` 标签：`changes` 分类为 `rollback` 而不是 `promotion`，
  不要求第一名率预注册证据。
- `rollback-gate` 从 git 事实独立验证：
  - revert 目标必须是一次真实冠军切换，且有可复核晋级证据（planId 或 legacy challengeIndex + 归档）；
  - 恢复内容与目标提交之前的冠军**逐字节一致**；
  - 只允许改 champion.json / parameters.ts / dist / 回滚计划，不夹带算法改动；
  - 候选归档 append-only，不得删除；
  - 最近 5 次冠军变更最多一个 rollback commit。
- `rollback-champion.mjs` 对同一提交幂等；如果最近一次冠军变更本身就是回滚，直接拒绝，
  避免部署持续失败时的“回滚→合并→再回滚”循环。
- 回滚 PR 同样显式 dispatch CI（GITHUB_TOKEN 限制），通过全量检查后 auto-merge。

## 5. CI 效率

- `web-unit` 固定 3 分片；`training-unit` 按文件数自适应 1–4 分片，覆盖不变。
- `simulation` 由 4 分片提升到 8 分片（100 局覆盖不变，种子连续不重叠）。
- 晋级链路不再在 promote 作业里重复执行 promote/apply/build，统一由发布器在临时 worktree
  完成；`web-v1-dist` 由 build 作业一次构建、所有高成本作业复用。
- 训练/晋级 artifact 只上传必要状态与报告；逐局原始证据按 retention 管理。

## 6. 可观测性

统一报告位于 `training/reports/automation/<campaign>/run-report.{json,md}`，包含：

- 训练时长、有效训练时间、资源快照；
- 候选数、快筛/深验/淘汰原因直方图；
- 算法轨道（generator / strategy / 模块）、OpenEvolve 候选计数；
- 第一名率与统计诊断（仅排序，不作为晋级判据）；
- 晋级队列、机器门禁 verdict、发布结果；
- 冠军 identity、部署 identity（commit/artifact/champion/url/verdict）；
- 失败原因、stop/resume 事件、下一轮状态。

线上部署核验额外生成 `training/reports/deployment-identity.json`，由 `deploy-verify`
artifact 保存 90 天。

## 7. 验收与阻塞

- 真实冠军晋级仍受 alpha 预算与统计功效约束：几何 alpha 已消耗 0.0499756，剩余 2.44e-5；
  新 alpha 家族必须显式治理授权，不能靠自动驾驶静默重置。
- 未配置 `AUTOMATION_TOKEN` 时，ruleset 的 unattributed-changes 规则可能要求人工批准；
  这是外部账户配置阻塞，代码不会绕过规则集。
- GitHub 标准 Runner 不执行 OpenEvolve LLM 提案；本地 M4 的等价命令见
  `training/evolution/run-ai9-openevolve.mjs`。
