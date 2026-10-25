#!/usr/bin/env node
/** 生成/应用 main 分支保护规则（默认 dry-run；必须显式授权才修改仓库设置）。
 *
 * 用法：
 *   node scripts/ci/apply-main-protection.mjs                        # 只打印
 *   CONFIRM_APPLY_MAIN_PROTECTION=yes node scripts/ci/apply-main-protection.mjs --apply
 *   ... --reviewer-login Xike-yuhuofei                               # 同时配置 promotion-approval 环境必需审核人
 *
 * 说明：本仓库当前（2026-10-25）无 Branch Protection、无 Ruleset。脚本不会自动运行。
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CHECKS = ['ci-summary', 'rules-cards', 'governance-tests'];

export function buildRuleset() {
  return {
    name: 'main-protection',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: ['refs/heads/main'], exclude: [] },
    },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: REQUIRED_CHECKS.map(context => ({ context })),
        },
      },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['squash', 'merge'],
        },
      },
    ],
    bypass_actors: [],
  };
}

export function buildEnvironmentPayload(reviewerId) {
  return {
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: reviewerId ? [{ type: 'User', id: reviewerId }] : [],
    deployment_branch_policy: null,
  };
}

function gh(args, { input } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', input });
}

function main() {
  const apply = process.argv.includes('--apply');
  const reviewerIndex = process.argv.indexOf('--reviewer-login');
  const reviewerLogin = reviewerIndex >= 0 ? process.argv[reviewerIndex + 1] : null;
  const repo = process.env.GITHUB_REPOSITORY ||
    gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();

  const ruleset = buildRuleset();
  console.log(`目标仓库：${repo}`);
  console.log('Ruleset payload:');
  console.log(JSON.stringify(ruleset, null, 2));

  let reviewerId = null;
  if (reviewerLogin) {
    reviewerId = Number(gh(['api', `users/${reviewerLogin}`, '--jq', '.id']).trim());
    console.log(`promotion-approval 环境审核人：${reviewerLogin} (id=${reviewerId})`);
    console.log(JSON.stringify(buildEnvironmentPayload(reviewerId), null, 2));
  }

  if (!apply) {
    console.log('\n[dry-run] 未修改仓库设置。确认方案后使用：');
    console.log('  CONFIRM_APPLY_MAIN_PROTECTION=yes node scripts/ci/apply-main-protection.mjs --apply');
    return;
  }
  if (process.env.CONFIRM_APPLY_MAIN_PROTECTION !== 'yes') {
    console.error('拒绝执行：--apply 需要显式环境变量 CONFIRM_APPLY_MAIN_PROTECTION=yes');
    process.exit(1);
  }

  const existing = JSON.parse(gh(['api', `repos/${repo}/rulesets`]));
  const current = existing.find(r => r.name === ruleset.name);
  if (current) {
    gh(['api', '--method', 'PUT', `repos/${repo}/rulesets/${current.id}`, '--input', '-'], { input: JSON.stringify(ruleset) });
    console.log(`已更新 ruleset：${ruleset.name} (id=${current.id})`);
  } else {
    const created = JSON.parse(gh(['api', '--method', 'POST', `repos/${repo}/rulesets`, '--input', '-'], { input: JSON.stringify(ruleset) }));
    console.log(`已创建 ruleset：${ruleset.name} (id=${created.id})`);
  }

  if (reviewerLogin) {
    gh(['api', '--method', 'PUT', `repos/${repo}/environments/promotion-approval`, '--input', '-'], {
      input: JSON.stringify(buildEnvironmentPayload(reviewerId)),
    });
    console.log('已配置 promotion-approval 环境必需审核人');
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`应用分支保护失败：${error.stderr ?? error.message}`);
    process.exit(1);
  }
}
