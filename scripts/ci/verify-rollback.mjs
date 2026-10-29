#!/usr/bin/env node
/** 回滚 PR 独立验证（失败关闭）。
 *
 * 回滚不是一次晋级，因此不能复用 promotion-gate。但它同样不能成为绕过晋级
 * 的任意写入口：本脚本从 git 事实（而不是 PR 自报字段）验证：
 * 1. HEAD 是 revert 提交，且 revert 目标是一次已落地冠军晋级；
 * 2. 回滚后的 champion.json 与目标提交之前的冠军逐字节一致；
 * 3. 回滚只改动冠军参数/构建产物/回滚计划，不夹带其他算法或规则变更；
 * 4. 连续回滚被拒绝（防止部署持续失败时的回滚循环）。
 *
 * 用法：node scripts/ci/verify-rollback.mjs [--plan training/reports/rollback-plan.json]
 * 退出码：0=PASS；1=拒绝。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`无法识别的参数：${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function jsonFromGit(rev) {
  return JSON.parse(git(['show', `${rev}:training/champions/champion.json`]));
}

const args = parseArgs(process.argv.slice(2));
const planPath = resolve(String(args.plan ?? 'training/reports/rollback-plan.json'));
const outPath = resolve(String(args.out ?? 'training/reports/rollback-verification.json'));
// 仅限隔离演练夹具：合成仓库没有 apply-champion/构建产物，无法复核参数区；
// CI 一律不得传该开关（由 verify-workflows 不变量强制）。
const skipParametersCheck = args['no-parameters-check'] === true;
const checks = [];
function check(id, pass, evidence) {
  checks.push({ id, status: pass ? 'PASS' : 'FAIL', evidence: String(evidence).slice(0, 500) });
  return pass;
}

const head = git(['rev-parse', 'HEAD']);
const subject = git(['log', '-1', '--format=%s', head]);
const messageMatch = /^revert\(ai8\): 自动回滚冠军提交 ([0-9a-f]{12,40})/.exec(subject);
check('head-is-automatic-rollback', Boolean(messageMatch), subject);

let target = null;
let plan = null;
if (existsSync(planPath)) {
  try { plan = JSON.parse(readFileSync(planPath, 'utf8')); } catch { plan = null; }
}
if (messageMatch) {
  const prefix = messageMatch[1];
  try {
    const candidates = git(['rev-list', '--all', '--format=%H %s', '--', 'training/champions/champion.json'])
      .split('\n').filter(line => line.startsWith(prefix));
    target = candidates[0]?.split(' ')[0] ?? null;
  } catch { target = null; }
}
if (!target && plan?.target) target = String(plan.target);
check('target-resolved', Boolean(target && /^[0-9a-f]{40}$/.test(target)), String(target));

if (target) {
  const targetSubject = git(['log', '-1', '--format=%s', target]);
  check('target-not-a-rollback', !/^revert\(/.test(targetSubject), targetSubject);
  let targetChampion = null;
  try { targetChampion = jsonFromGit(target); } catch { targetChampion = null; }
  const evidence = targetChampion?.provenance?.promotionEvidence ?? null;
  check('target-is-promotion', Boolean(evidence?.planId),
    `planId=${String(evidence?.planId ?? 'missing')}`);

  let headChampion = null;
  try { headChampion = JSON.parse(readFileSync(resolve('training/champions/champion.json'), 'utf8')); } catch { headChampion = null; }
  let parentText = null;
  try { parentText = git(['show', `${target}^:training/champions/champion.json`]); } catch { parentText = null; }
  check('previous-champion-readable', Boolean(parentText), target);
  if (parentText && headChampion) {
    check('restores-previous-byte-exact', headChampion.parameters?.id !== targetChampion?.parameters?.id
      && git(['show', 'HEAD:training/champions/champion.json']).trim() === parentText.trim(),
    `head=${String(headChampion.parameters?.id)} parent=${String(JSON.parse(parentText).parameters?.id)}`);
  }

  const changed = git(['diff', '--name-only', `${target}^`, 'HEAD']).split('\n').filter(Boolean);
  const allowed = [
    'training/champions/champion.json',
    'web-v1/src/ai/parameters.ts',
    'training/reports/rollback-plan.json',
    'training/reports/rollback-verification.json',
  ];
  const unexpected = changed.filter(path => !path.startsWith('web-v1/dist/')
    && !path.startsWith('training/champions/candidates/')
    && !allowed.includes(path));
  check('no-unrelated-changes', unexpected.length === 0, unexpected.join(', ') || 'none');

  // 归档 append-only：允许把回滚掉的晋级归档“加回来”，但禁止删除/改写，
  // 也禁止借回滚加入目标提交中不存在的新归档。
  const archiveStatus = git(['diff', '--name-status', `${target}^`, 'HEAD', '--', 'training/champions/candidates'])
    .split('\n').filter(Boolean);
  const archiveProblems = [];
  for (const line of archiveStatus) {
    const [status, ...paths] = line.split('\t');
    const path = paths.at(-1);
    if (status.startsWith('D') || status.startsWith('M') || status.startsWith('R')) {
      archiveProblems.push(`${status} ${path}`);
      continue;
    }
    if (status.startsWith('A')) {
      try {
        const headText = git(['show', `HEAD:${path}`]);
        const targetText = git(['show', `${target}:${path}`]);
        if (headText !== targetText) archiveProblems.push(`A(modified) ${path}`);
      } catch {
        archiveProblems.push(`A(not-in-target) ${path}`);
      }
    }
  }
  check('candidate-archives-preserved', archiveProblems.length === 0,
    archiveProblems.join(', ') || '归档 append-only 保持');

  // 防循环：最近 5 个改冠军的提交最多只有一个 rollback commit（本次 HEAD）。
  const recent = git(['log', '-5', '--format=%s', '--', 'training/champions/champion.json'])
    .split('\n').filter(Boolean);
  const rollbacks = recent.filter(line => /^revert\(ai8\): 自动回滚/.test(line));
  check('no-rollback-loop', rollbacks.length <= 1, recent.join(' | '));
}

// 落地参数区必须与 champion.json 一致；需要已构建的 dist。
if (skipParametersCheck) {
  checks.push({ id: 'parameters-match-champion', status: 'SKIPPED-FIXTURE', evidence: '隔离演练夹具：--no-parameters-check' });
} else {
  try {
    const applyCheck = execFileSync(process.execPath, ['training/scripts/apply-champion.mjs', '--check'], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    check('parameters-match-champion', true, applyCheck.slice(-300));
  } catch (error) {
    check('parameters-match-champion', false, String(error.stderr ?? error.message).slice(-500));
  }
}

const failed = checks.filter(c => c.status === 'FAIL');
const report = {
  schema: 'century-rollback-verification-v1',
  generatedAt: new Date().toISOString(),
  head,
  subject,
  target,
  planVerdict: plan?.verdict ?? null,
  verdict: failed.length ? 'FAIL' : 'PASS',
  checks,
};
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, verdict: report.verdict, failed: failed.map(c => c.id) }, null, 2));
if (failed.length) process.exit(1);
