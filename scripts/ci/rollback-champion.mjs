#!/usr/bin/env node
/** P4：冠军发布自动回滚。
 *
 * 触发条件（任一）：
 * - 线上部署身份核验失败（verify-deploy.mjs 退出 1）；
 * - 正式游戏无法结束 / AI 决策停摆（由部署核验或浏览器冒烟判定）。
 *
 * 回滚方式：对最近一次改动 champion.json 的合并提交创建 revert PR，并启用
 * auto-merge。不直接 push main、不使用管理员强制合并、不绕过 CI——回滚本身
 * 仍必须通过全部机器检查，只是无需人工批准。
 *
 * 历史冠军与统计证据不被覆盖：revert 只恢复上一版 champion.json / parameters.ts /
 * dist，历史归档与报告保持原样。
 *
 * 用法：node scripts/ci/rollback-champion.mjs [--reason <text>] [--dry-run]
 */

import { execFileSync } from 'node:child_process';

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const reason = String(args.reason ?? 'deploy-verification-failed');
const dryRun = args['dry-run'] === true;

const championPath = 'training/champions/champion.json';
const target = run('git', ['log', '-1', '--format=%H', '--', championPath]);
if (!/^[0-9a-f]{40}$/.test(target)) throw new Error('无法定位最近一次冠军变更提交');

const parents = run('git', ['rev-list', '--parents', '-n', '1', target]).split(' ');
const isMerge = parents.length > 2;
const branch = `rollback/champion-${target.slice(0, 12)}-${Date.now()}`;
const message = `revert(ai8): 自动回滚冠军提交 ${target.slice(0, 12)}（原因：${reason}）`;

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, target, isMerge, branch, message }, null, 2));
  process.exit(0);
}

run('git', ['config', 'user.name', 'century-ai-bot']);
run('git', ['config', 'user.email', 'actions@users.noreply.github.com']);
run('git', ['checkout', '-b', branch]);
if (isMerge) run('git', ['revert', '--no-edit', '-m', '1', target]);
else run('git', ['revert', '--no-edit', target]);
run('git', ['push', 'origin', branch]);

const body = [
  '## 冠军自动回滚',
  '',
  `- 触发原因：\`${reason}\``,
  `- 被回滚提交：\`${target}\``,
  '- 回滚范围：champion.json / parameters.ts / dist（恢复上一已验证冠军版本）',
  '- 历史归档与统计证据未被覆盖',
  '- 本 PR 仍须通过全部机器检查后自动合并；无人工批准、无管理员强制合并',
].join('\n');
const prUrl = run('gh', ['pr', 'create', '--title', message, '--body', body, '--base', 'main', '--head', branch]);
run('gh', ['pr', 'merge', prUrl, '--squash', '--auto']);
console.log(JSON.stringify({ verdict: 'ROLLBACK_PR_OPENED', prUrl, target, reason }, null, 2));
