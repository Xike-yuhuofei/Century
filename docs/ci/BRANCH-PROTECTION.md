# main 分支保护与晋级治理配置方案

> 审计时间：2026-10-25。仓库 `Xike-yuhuofei/Century` 为 public，当前账户具备 admin 权限。
>
> 实测现状：`GET /repos/Xike-yuhuofei/Century/branches/main/protection` 返回 **404 Branch not protected**；
> `GET /repos/Xike-yuhuofei/Century/rulesets` 返回 **[]**。即 main 目前可被直接 push / force push / 删除。
>
> 本文是配置方案。按任务约束，未在未经明确授权时修改仓库级设置；应用脚本默认 dry-run。

## 1. 推荐机制：Rulesets（而非旧 Branch Protection）

GitHub 当前的 Repository Rulesets 支持按分支模式生效、required status checks、禁止 force push/删除，
以及 bypass actors 与审计记录，比旧 Branch Protection 更适合本仓库。Branch Protection 仍可用，
但两套机制不要重复配置，避免状态检查名称漂移。

推荐规则集 `main-protection`（脚本：`scripts/ci/apply-main-protection.mjs`）：

| 规则 | 配置 | 目的 |
|---|---|---|
| 目标 | `refs/heads/main` | 仅保护 main |
| 合并方式 | 必须通过 PR | 禁止直接 push |
| 必需检查 | `ci-summary`、`rules-cards`、`governance-tests` | 关键检查不得静默跳过 |
| 分支新鲜度 | strict / 必须与 main 同步 | merge 前按最新基线跑过检查 |
| 强制推送 | `non_fast_forward` 禁止 | 保护历史 |
| 分支删除 | `deletion` 禁止 | 防误删 |
| 审批数 | 0（单维护者）；有第二名维护者后改为 1 | 避免本人无法批准自己的 PR |
| 合并方法 | squash / merge | 保留可追溯合并记录 |
| 会话解决 | 必须解决 review 评论 | 防未处理意见被合并 |
| bypass | 默认无；紧急流程见 §5 | 不给出日常绕过口 |

> 必需检查只写 **job 名**（`ci-summary` 等）。工作流名为 `CI`，UI 中显示为 `CI / ci-summary`。
> `ci-summary` 已聚合所有变更分组，`rules-cards` 与 `governance-tests` 永远运行，作为第二道保险。

### 应用步骤

```bash
# 1) 预览（不改设置）
node scripts/ci/apply-main-protection.mjs

# 2) 显式授权后应用 ruleset + 配置 promotion-approval 环境审核人
CONFIRM_APPLY_MAIN_PROTECTION=yes \
  node scripts/ci/apply-main-protection.mjs --apply --reviewer-login Xike-yuhuofei

# 3) 验证
gh api repos/Xike-yuhuofei/Century/rulesets --jq '.[] | {id,name,enforcement}'
gh api repos/Xike-yuhuofei/Century/rulesets/<id> --jq '.rules[].type'
```

等价的手工 UI 路径：Settings → Rules → Rulesets → New branch ruleset → target `main` →
勾选 Require a pull request、Require status checks（添加上述三项并勾选 strict）、
Block force pushes、Restrict deletions。

## 2. 必需检查与工作流关系

唯一 PR CI 入口是 `.github/workflows/ci.yml`：

- `changes`：变更分类；
- `build`：共享构建（`npm ci` + tsc/esbuild，产物 `web-v1-dist`）；
- `web-unit` / `training-unit` / `simulation`：并行复用共享产物；
- `rules-cards` + `governance-tests`：永远运行的快速门禁；
- `ui-smoke`：浏览器 UI 冒烟；
- `audit-gate`：dev/research 层可靠性审计；
- `research-node` / `research-worker` / `research-e2e` / `research-python` / `research-seatbelt`：AI5 研究检查（worker 协议按用例并发、端到端对战独立作业）；
- `promotion-gate` + `promotion-approval`：仅晋级 PR；
- `pages-deploy`：仅 main push 且 web/data 变更；
- `ci-summary`：唯一聚合必需检查，独立复算变更范围并拒绝 skipped/failure/cancelled。

`ai-training.yml` 仅保留 schedule / workflow_dispatch，不再是 PR 检查来源。

## 3. 冠军晋级特殊审核要求

晋级 PR 的识别（任一满足）：

1. 修改 `training/champions/**`；
2. 修改 `web-v1/src/ai/parameters.ts`；
3. PR 带 `promotion` 标签；
4. 自动晋级作业 dispatch `ci.yml` 时传 `promotion=true`。

晋级 PR 必须同时满足：

- `promotion-gate` 执行 `audit-gate --tier promotion`，产出结构化 verdict；
- `BLOCKED` / `FAIL` → 直接失败，人工批准不能绕过；
- `REQUIRES_APPROVAL` → **保持原状态**（作业红色 + Step Summary 明示），不得改写成 PASS；
- 维护者在 PR 上添加 `promotion-approved` 标签；
- 维护者在 `promotion-approval` Environment 中批准部署；
- `ci-summary` 仅在 `promotion-approval` 成功后才放行。

> 单人维护提示：Environment reviewer 设为维护者本人，`prevent_self_review=false`；
> 不使用全局 required reviewers（GitHub 不允许作者批准自己的 PR，会把所有 PR 永久卡死）。
> 晋级授权由“标签 + Environment”双因子完成，且两者都留痕。

### 配置 promotion-approval 环境

```bash
# 查看用户 id
gh api users/Xike-yuhuofei --jq .id

# 设置为必需审核人（脚本也可自动完成）
gh api --method PUT repos/Xike-yuhuofei/Century/environments/promotion-approval --input - <<'JSON'
{"wait_timer":0,"prevent_self_review":false,
 "reviewers":[{"type":"User","id":<USER_ID>}],
 "deployment_branch_policy":null}
JSON
```

注意：`deployment_branch_policy` 必须为 `null`，否则来自未受保护的晋级分支的作业无法进入环境。

### 标签

```bash
gh label create promotion --color 5319e7 --description "正式冠军晋级审核"
gh label create promotion-approved --color 0e8a16 --description "维护者已人工批准晋级"
```

- `promotion`：人工发起晋级 PR 时添加；自动晋级作业通过 `promotion=true` dispatch，无需标签。
- `promotion-approved`：人工批准信号；建议限制为具备 write 权限的维护者添加。

## 4. 自动晋级 PR 的 CI 触发

GitHub 使用 `GITHUB_TOKEN` 创建的 PR **不会**自动触发 `pull_request` 工作流（防递归）。
因此 `ai-training.yml` 的 promote 作业在创建 PR 后显式执行：

```bash
gh workflow run ci.yml --ref "$branch" -f promotion=true
```

若 dispatch 失败，作业直接失败并提示手动运行，避免“PR 已创建但没有检查”的静默状态。
人工晋级 PR 若在 CI 运行后才添加 `promotion` 标签，需要重新触发：

```bash
gh workflow run ci.yml --ref <branch> -f promotion=true
```

## 5. 回滚与紧急修复流程

### 冠军回滚

1. 新建 revert PR，恢复上一版 `training/champions/champion.json` 与 `web-v1/src/ai/parameters.ts`；
2. 该 PR 自动进入 promotion 门禁（路径命中），仍需 `promotion-approved` + Environment 批准；
3. 证据必须说明恢复后的冠军指纹与被撤销版本一致；`audit-gate` 的指纹检查会复核；
4. 禁止直接 force push main 或手工修改线上参数。

### 普通代码回滚

1. 使用 revert PR，不得 force push；
2. 仍然执行完整 `ci-summary`；回滚不降低测试覆盖；
3. 若回滚对象是共享核心模块（引擎/AI/卡牌/seed policy），CI 自动按 shared-core 跑全量。

### 紧急修复（生产/CI 基础设施故障）

1. 仍走 PR + 必需检查；优先修复 CI 而不是绕过；
2. 若 Ruleset 本身导致无法合并：由仓库 admin 在 Ruleset 中临时设置 `enforcement: disabled`
   （或从 bypass 列表临时放行），并在 PR 描述记录事件编号、原因、恢复时间；
3. 恢复后立即重新启用，并对被绕过提交补跑一次 `workflow_dispatch`（`scope=full`）；
4. 事后在 `docs/ci/` 追加事件记录。禁止把 bypass 当作日常流程。

## 6. 验证清单

- [ ] `GET /repos/.../rulesets` 返回 `main-protection` 且 `enforcement=active`
- [ ] 直接 push main 被拒绝
- [ ] `git push --force origin main` 被拒绝
- [ ] 普通 PR 只要求 `ci-summary` / `rules-cards` / `governance-tests`，不出现 promotion 阻断
- [ ] 普通 PR 的 `ci-summary` 明确列出“未触发（变更范围不适用）”，而非静默跳过
- [ ] 晋级 PR 的 `promotion-gate` 显示 `REQUIRES_APPROVAL` 红色状态
- [ ] 未添加 `promotion-approved` 时 `promotion-approval` 失败
- [ ] 添加标签并批准 Environment 后 `promotion-approval` 成功、`ci-summary` 成功
- [ ] 文档-only PR 在 1 分钟内完成且不运行 web/training 大测试

## 7. 参考

- GitHub Docs: Available rules for rulesets（required status checks / non-fast-forward / deletion）
- GitHub Docs: REST API endpoints for rules（rulesets / bypass_actors）
- GitHub Docs: Deployments and environments（required reviewers）
