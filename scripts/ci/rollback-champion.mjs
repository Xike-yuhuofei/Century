#!/usr/bin/env node
/** P4：冠军发布自动回滚（幂等 + 可验证 + 防循环）。
 *
 * 触发条件（任一）：
 * - 线上部署身份核验失败（verify-deploy.mjs 退出 1）；
 * - 正式游戏无法结束 / AI 决策停摆（由部署核验或浏览器冒烟判定）。
 *
 * 回滚方式：对最近一次改动 champion.json 的合并提交创建 revert PR，并启用
 * auto-merge。不直接 push main、不使用管理员强制合并、不绕过 CI——回滚本身
 * 仍必须通过全部机器检查，无人工批准。
 *
 * 治理约束（缺一不可，否则拒绝回滚）：
 * - 最近一次冠军变更必须是一次「已落地晋级」（champion.json 带 promotionEvidence）；
 *   否则任何人都能以回滚名义把任意参数写进 main；
 * - 回滚内容必须恰好等于该提交之前的已验证冠军（逐字节比对，使用归档快照）；
 * - 同一被回滚提交只允许一个回滚 PR（幂等），且不再回滚“回滚提交”本身，
 *   避免部署持续失败时的回滚循环。
 *
 * 用法：node scripts/ci/rollback-champion.mjs [--reason <text>] [--dry-run]
 *       [--json training/reports/rollback-plan.json]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const jsonPath = args.json ? resolve(String(args.json)) : null;

const championPath = 'training/champions/champion.json';

function git(argsList) {
  return run('git', argsList);
}

function writePlan(plan) {
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
}

function fail(message, detail = {}) {
  writePlan({ verdict: 'ROLLBACK_REFUSED', reason: message, ...detail });
  process.exit(1);
}

function pathExists(revPath) {
  try {
    git(['cat-file', '-e', revPath]);
    return true;
  } catch {
    return false;
  }
}

const target = git(['log', '-1', '--format=%H', '--', championPath]);
if (!/^[0-9a-f]{40}$/.test(target)) fail('无法定位最近一次冠军变更提交');

// 防循环：被回滚提交本身必须是晋级落地，不能是另一次回滚。
const targetMessage = git(['log', '-1', '--format=%s', target]);
if (/^revert\(/.test(targetMessage)) {
  fail('最近一次冠军变更本身就是回滚提交——已经回滚过，禁止再次回滚（防止回滚循环）', { target, targetMessage });
}

// 被回滚提交必须是一次「真实冠军切换的晋级落地」：回滚只能撤销晋级，不能
// 撤销任意改动（否则任何人改完 champion.json 再触发部署失败就能回滚掉它）。
// 判定同时接受两种历史形态，但都要求可独立复核的归档存在：
// - AI8+：provenance.promotionEvidence.planId（第一名率预注册挑战）；
// - AI5/6/7 legacy：promotionEvidence.challengeIndex + 候选归档文件。
const championJson = JSON.parse(git(['show', `${target}:${championPath}`]));
const promotionEvidence = championJson?.provenance?.promotionEvidence ?? null;
const targetChampionId = championJson?.parameters?.id ?? championJson?.id ?? null;
const parentChampionIdAtTarget = pathExists(`${target}^:${championPath}`)
  ? (JSON.parse(git(['show', `${target}^:${championPath}`]))?.parameters?.id ?? null)
  : null;
const isChampionSwitch = Boolean(targetChampionId) && targetChampionId !== parentChampionIdAtTarget;
const legacyArchive = `training/champions/candidates/${String(targetChampionId)}.json`;
const archiveAtTarget = targetChampionId ? pathExists(`${target}:${legacyArchive}`) : false;
const evidencePlanId = promotionEvidence?.planId ?? null;
const legacyPromotion = Boolean(promotionEvidence)
  && Number.isInteger(promotionEvidence?.challengeIndex)
  && archiveAtTarget;
if (!isChampionSwitch) {
  fail('被回滚提交没有切换冠军（id 与父提交相同）——只允许回滚一次真实冠军晋级', {
    target, targetMessage, targetChampionId, parentChampionIdAtTarget,
  });
}
if (!evidencePlanId && !legacyPromotion) {
  fail('被回滚提交缺少可复核的晋级证据（无 planId，且无 challengeIndex + 候选归档）——只允许回滚已落地晋级', {
    target, targetMessage, targetChampionId, archiveAtTarget,
    evidenceKeys: Object.keys(promotionEvidence ?? {}),
  });
}
const declaredBasedOn = championJson?.provenance?.basedOn ?? null;
if (declaredBasedOn && parentChampionIdAtTarget && declaredBasedOn !== parentChampionIdAtTarget) {
  fail('被回滚提交的 provenance.basedOn 与父提交冠军不一致——无法证明这是一次线性晋级', {
    target, targetMessage, declaredBasedOn, parentChampionIdAtTarget,
  });
}

const parents = git(['rev-list', '--parents', '-n', '1', target]).split(' ');
const isMerge = parents.length > 2;

// 恢复内容必须 == 该提交之前的已验证冠军（逐字节），否则回滚会引入未审计参数。
let previousChampionId = null;
let restoresPreviousChampion = false;
if (pathExists(`${target}^:${championPath}`)) {
  const previousText = git(['show', `${target}^:${championPath}`]);
  previousChampionId = JSON.parse(previousText)?.parameters?.id ?? null;
  const parentCommit = git(['rev-parse', `${target}^`]);
  const branch = `rollback/champion-${target.slice(0, 12)}-${Date.now()}`;
  const revertArgs = isMerge
    ? ['revert', '--no-commit', '-m', '1', target]
    : ['revert', '--no-commit', target];
  // 在隔离 worktree 中预演 revert，逐字节比对 champion.json 是否恢复。
  // 不在 CI 工作区执行 checkout/reset，避免回滚脚本破坏未提交的构建产物。
  const previewTree = mkdtempSync(join(tmpdir(), 'century-rollback-preview-'));
  let previewOk = true;
  try {
    git(['worktree', 'add', '--detach', previewTree, parentCommit]);
    run('git', revertArgs, { cwd: previewTree });
    const revertedText = readFileSync(join(previewTree, championPath), 'utf8');
    restoresPreviousChampion = revertedText.trim() === previousText.trim();
  } catch {
    previewOk = false;
  } finally {
    try { git(['worktree', 'remove', '--force', previewTree]); } catch { /* 已清理 */ }
    rmSync(previewTree, { recursive: true, force: true });
  }
  if (!previewOk) fail('revert 预演失败（无法生成干净的恢复内容）', { target, targetMessage, previousChampionId });
  if (!restoresPreviousChampion) {
    fail('回滚结果与上一版冠军不一致（可能被手工编辑或归档漂移）——拒绝回滚', {
      target, targetMessage, previousChampionId,
    });
  }

  // 幂等：同一被回滚提交只允许一个未完成的回滚 PR。
  let existingPr = '';
  try {
    existingPr = run('gh', ['pr', 'list', '--state', 'open', '--search', `${target.slice(0, 12)} in:title`,
      '--json', 'url', '--jq', '.[0].url // empty']);
  } catch { /* 无 gh 或无网络：按无既有 PR 处理，但真实创建步骤会失败关闭 */ }
  if (existingPr) {
    const plan = {
      verdict: 'ROLLBACK_ALREADY_OPEN',
      reason: '同一被回滚提交已有开放回滚 PR（幂等保护）',
      target, previousChampionId, prUrl: existingPr,
    };
    writePlan(plan);
    process.exit(0);
  }

  // changedFiles = 回滚实际会改动的路径（promotion diff 去掉 append-only 归档）。
  const promotionChanged = git(['diff', '--name-only', `${target}^`, target]).split('\n').filter(Boolean);
  const preservedArchives = promotionChanged.filter(path => path.startsWith('training/champions/candidates/'));
  const changedFiles = promotionChanged.filter(path => !path.startsWith('training/champions/candidates/'));
  const plan = {
    verdict: dryRun ? 'ROLLBACK_DRY_RUN' : 'ROLLBACK_PR_OPENED',
    target,
    targetMessage,
    isMerge,
    previousChampionId,
    isChampionPromotion: true,
    restoresPreviousChampion,
    promotionPlanId: evidencePlanId,
    promotionChallengeIndex: promotionEvidence?.challengeIndex ?? null,
    candidateArchive: archiveAtTarget ? legacyArchive : null,
    preservedArchives,
    changedFiles,
    branch,
    reason,
  };
  if (dryRun) {
    writePlan(plan);
    process.exit(0);
  }
  git(['config', 'user.name', 'century-ai-bot']);
  git(['config', 'user.email', 'actions@users.noreply.github.com']);
  git(['checkout', '-b', branch]);
  git(revertArgs);
  // 归档不可回退：候选归档是历史算法版本的唯一记录，plain revert 会把它删掉，
  // 与「历史归档与统计证据不被覆盖」的承诺矛盾。这里把归档恢复到被回滚提交
  // 的状态（append-only），只回退冠军参数与构建产物。
  if (archiveAtTarget) {
    git(['checkout', target, '--', 'training/champions/candidates']);
    console.log(`保留候选归档（append-only）：${preservedArchives.length} 个文件`);
  }
  const message = `revert(ai8): 自动回滚冠军提交 ${target.slice(0, 12)}（原因：${reason}）`;
  const body = [
    '## 冠军自动回滚',
    '',
    `- 触发原因：\`${reason}\``,
    `- 被回滚提交：\`${target}\`（${targetMessage}）`,
    `- 恢复到的冠军：\`${previousChampionId}\``,
    '- 回滚范围：champion.json / parameters.ts / dist（恢复上一已验证冠军版本）',
    '- 历史归档与统计证据未被覆盖（候选归档保持 append-only）',
    '- 本 PR 仍须通过全部机器检查后自动合并；无人工批准、无管理员强制合并',
  ].join('\n');
  // 回滚计划随 PR 提交：CI 的 verify-rollback 从 git 事实独立复核，
  // 不依赖 workflow 之间的产物传递（回滚 PR 由 dispatch 触发，没有上游 artifact）。
  const planWithFiles = { ...plan, branch, message };
  writeFileSync(resolve('training/reports/rollback-plan.json'), `${JSON.stringify(planWithFiles, null, 2)}\n`);
  git(['add', championPath, 'web-v1/src/ai/parameters.ts', 'training/reports/rollback-plan.json']);
  git(['commit', '-m', message]);
  git(['push', 'origin', branch]);
  const prUrl = run('gh', ['pr', 'create', '--title', message, '--body', body,
    '--base', 'main', '--head', branch]);
  run('gh', ['pr', 'merge', prUrl, '--squash', '--auto']);
  try {
    // 回滚 PR 同样由 GITHUB_TOKEN 创建，不会触发 pull_request：显式 dispatch，
    // 否则规则集的 ci-summary 永远不会出现，回滚也无法落地（部署持续不一致）。
    run('gh', ['workflow', 'run', 'ci.yml', '--ref', branch, '-f', 'promotion=false']);
  } catch (error) {
    fail(`回滚 PR 已创建但 dispatch ci.yml 失败：${String(error.stderr ?? error.message).slice(0, 300)}`, {
      target, prUrl, previousChampionId,
    });
  }
  plan.prUrl = prUrl;
  writePlan(plan);
} else {
  fail('无法读取被回滚提交之前的冠军内容——缺少可比对的基线，拒绝回滚', { target, targetMessage });
}
