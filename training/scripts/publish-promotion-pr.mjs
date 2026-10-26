#!/usr/bin/env node
/** P4：把已通过第一名率正式挑战的机器门禁证据发布为冠军 PR。
 *
 * 职责边界：
 * - 只处理 promotion-handler 已发布到 first-place-promotion/latest 的证据；
 * - 在干净的 origin/main worktree 中重新执行 promote（写入冠军/归档/参数区）；
 * - 不本地构建、不直接合并：PR 由 CI 的 promotion-machine-gate 独立复核后
 *   auto-merge，Pages 部署与线上核验由现有工作流完成；
 * - --dry-run 只在临时 worktree 内提交（detached HEAD），不 push、不建 PR。
 *
 * 用法：
 *   node training/scripts/publish-promotion-pr.mjs [--dry-run]
 *     [--evidence-dir training/reports/first-place-promotion/latest]
 *     [--base main] [--repo-root <path>] [--alpha-ledger <path>] [--governance-central <path>]
 *     [--base-commit <sha>]   # 仅测试/演练：从指定本地 commit 派生，生产不得使用
 *
 * 退出码：0=已创建 PR（或 dry-run 成功）；1=任一前置/发布步骤失败（fail-closed）。
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';

function parseArgs(argv) {
  const values = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { values._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8', cwd: options.cwd ?? REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024, timeout: options.timeout ?? 1_800_000,
  });
}

/** promote 等脚本会先打印构建一致性警告、后打印人类可读行；取其中第一个
 * 括号配平且可解析的 JSON 对象（不能假设 JSON 一直延伸到输出末尾）。 */
function parseJSONWithWarnings(text) {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0; let inString = false; let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { /* 下一个候选 */ }
          break;
        }
      }
    }
  }
  throw new Error(`输出中没有可解析 JSON：${String(text).slice(0, 300)}`);
}

const args = parseArgs(process.argv.slice(2));
const dryRun = args['dry-run'] === true;
const repoRoot = resolve(args['repo-root'] !== undefined ? process.cwd() : REPO_ROOT, args['repo-root'] ?? '.');
const base = String(args.base ?? 'main');
const evidenceArg = args['evidence-dir'] ?? 'training/reports/first-place-promotion/latest';
const evidenceDir = resolve(repoRoot, String(evidenceArg));
const alphaLedgerSource = resolve(repoRoot, String(args['alpha-ledger'] ?? 'training/governance/alpha-ledger.json'));
const registrySource = resolve(repoRoot, String(args['governance-central'] ?? 'training/governance/seed-consumption-registry.json'));
const REQUIRED_EVIDENCE = ['preregistration.json', 'challenge-evidence.json', 'candidate.json'];

for (const name of REQUIRED_EVIDENCE) {
  if (!existsSync(join(evidenceDir, name))) {
    console.error(`缺少晋级证据：${join(evidenceDir, name)}`);
    process.exit(1);
  }
}
if (!existsSync(alphaLedgerSource)) { console.error(`缺少 alpha 账本：${alphaLedgerSource}`); process.exit(1); }
if (!existsSync(registrySource)) { console.error(`缺少种子登记：${registrySource}`); process.exit(1); }

const candidateDoc = JSON.parse(readFileSync(join(evidenceDir, 'candidate.json'), 'utf8'));
const candidateId = candidateDoc.parameters?.id ?? candidateDoc.id;
if (typeof candidateId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,95}$/i.test(candidateId)) {
  console.error(`候选 id 非法：${String(candidateId)}`);
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY
  || sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const branch = String(args.branch ?? `ai-champion/${candidateId}-${stamp}`);
const baseCommit = args['base-commit'] !== undefined ? String(args['base-commit']) : null;

const workRoot = mkdtempSync(join(tmpdir(), 'century-promote-pr-'));
const tree = join(workRoot, 'repo');
let registered = false;
try {
  if (baseCommit) {
    // 测试/演练专用：从指定 commit 派生，验证当前源码上的发布链路。
    sh('git', ['worktree', 'add', '--detach', tree, baseCommit], { cwd: repoRoot });
  } else {
    sh('git', ['fetch', '--no-tags', 'origin', base], { cwd: repoRoot });
    sh('git', ['worktree', 'add', '--detach', tree, `origin/${base}`], { cwd: repoRoot });
  }
  registered = true;

  // 证据与治理账本随 PR 一起提交，CI 才能在 PR 内复核同一份数据。
  const targetEvidence = join(tree, 'training/reports/first-place-promotion/latest');
  mkdirSync(targetEvidence, { recursive: true });
  for (const name of REQUIRED_EVIDENCE) {
    copyFileSync(join(evidenceDir, name), join(targetEvidence, name));
  }
  // 并发治理保护：若 origin/main 在挑战开始后新增/改写了 alpha 历史，禁止
  // 用本地账本整文件覆盖（last-write-wins 会静默回退别人的挑战）。
  if (!baseCommit) {
    const baseLedger = parseJSONWithWarnings(sh('git', [
      'show', `origin/${base}:training/governance/alpha-ledger.json`,
    ], { cwd: repoRoot }));
    const localLedger = JSON.parse(readFileSync(alphaLedgerSource, 'utf8'));
    for (const entry of baseLedger.reservations ?? []) {
      const mine = (localLedger.reservations ?? []).find(r => r.challengeIndex === entry.challengeIndex);
      if (!mine || mine.planId !== entry.planId || Math.abs(mine.alpha - entry.alpha) > 1e-15) {
        throw new Error(`origin/${base} 的 alpha 历史与本地不一致（challengeIndex=${entry.challengeIndex}）——请先 rebase，禁止覆盖并发挑战`);
      }
    }
    for (const entry of baseLedger.outcomes ?? []) {
      const mine = (localLedger.outcomes ?? []).find(o => o.challengeIndex === entry.challengeIndex);
      if (!mine || mine.evidenceHash !== entry.evidenceHash || mine.decision !== entry.decision) {
        throw new Error(`origin/${base} 的 alpha 结果与本地不一致（challengeIndex=${entry.challengeIndex}）——请先 rebase`);
      }
    }
  }
  copyFileSync(alphaLedgerSource, join(tree, 'training/governance/alpha-ledger.json'));
  copyFileSync(registrySource, join(tree, 'training/governance/seed-consumption-registry.json'));

  // promote/apply 需要已构建引擎做身份核验；复用当前已验证的 dist，不在这里重建。
  cpSync(join(repoRoot, 'web-v1/dist'), join(tree, 'web-v1/dist'), { recursive: true });
  if (existsSync(join(repoRoot, 'web-v1/node_modules'))) {
    symlinkSync(join(repoRoot, 'web-v1/node_modules'), join(tree, 'web-v1/node_modules'), 'dir');
  }
  // 保存基线冠军快照：post-apply/CI 复核必须能验证 plan.champion 不是伪造的。
  const baseChampionSnapshot = join(workRoot, 'base-champion.json');
  copyFileSync(join(tree, 'training/champions/champion.json'), baseChampionSnapshot);

  const promoteArgs = [
    join(tree, 'training/scripts/promote-first-place-champion.mjs'),
    '--evidence', join(targetEvidence, 'challenge-evidence.json'),
    '--plan', join(targetEvidence, 'preregistration.json'),
    '--candidate', join(targetEvidence, 'candidate.json'),
    '--champion', join(tree, 'training/champions/champion.json'),
    '--base-champion', baseChampionSnapshot,
    '--alpha-ledger', join(tree, 'training/governance/alpha-ledger.json'),
    '--governance-central', join(tree, 'training/governance/seed-consumption-registry.json'),
  ];
  const promoted = parseJSONWithWarnings(sh(process.execPath, promoteArgs, { cwd: tree }));
  if (promoted.verdict !== 'PROMOTE') {
    throw new Error(`promote 未返回 PROMOTE：${JSON.stringify(promoted).slice(0, 300)}`);
  }
  sh(process.execPath, [join(tree, 'training/scripts/apply-champion.mjs'),
    '--champion', join(tree, 'training/champions/champion.json')], { cwd: tree });
  // apply 之后必须重建并回写构建身份；否则 audit-gate V7 会判定
  // “晋级证据身份 ≠ 当前产物”，真实冠军 PR 无法通过 promotion 门禁。
  sh('npm', ['run', 'build'], { cwd: join(tree, 'web-v1'), timeout: 1_800_000 });
  sh(process.execPath, [join(tree, 'training/scripts/refresh-champion-provenance.mjs')], { cwd: tree });
  // 冠军参数区变化属于经审计的有意变更：显式刷新版本锁并留 note。
  sh(process.execPath, [
    join(tree, 'training/scripts/version-lock.mjs'), '--write',
    '--note', `第一名率冠军晋级 ${candidateId}（机器门禁 + 预注册证据）`,
  ], { cwd: tree });

  sh('git', ['add',
    'training/champions/',
    'training/governance/alpha-ledger.json',
    'training/governance/seed-consumption-registry.json',
    'training/reports/first-place-promotion/latest/',
    'web-v1/src/ai/parameters.ts',
    'web-v1/dist/',
  ], { cwd: tree });
  sh('git', ['-c', 'user.name=century-ai-bot', '-c', 'user.email=actions@users.noreply.github.com',
    'commit', '-m', `feat(ai8): 第一名率冠军晋级 ${candidateId}（机器门禁）`], { cwd: tree });
  const commit = sh('git', ['rev-parse', 'HEAD'], { cwd: tree }).trim();
  const files = sh('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: tree }).trim().split('\n').filter(Boolean);

  if (dryRun) {
    console.log(JSON.stringify({
      verdict: 'DRY_RUN', repo, base, branch, commit, candidateId, files,
      note: '临时 worktree 内已完成 promote/apply/commit；未 push、未创建 PR',
    }, null, 2));
    process.exit(0);
  }

  sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: tree, timeout: 300_000 });
  const body = [
    `## 第一名率冠军晋级：${candidateId}`,
    '',
    '由 `publish-promotion-pr.mjs` 自动创建；冠军落地与合并由 CI `promotion-machine-gate` 独立复核后 auto-merge。',
    '',
    '### 证据',
    '`training/reports/first-place-promotion/latest/`（预注册计划 + 逐种子配对证据 + 候选文档）',
    '',
    '### 机器门禁',
    '- `promotion-gate`：结构化审计 verdict 必须 PASS',
    '- `promotion-machine-gate --post-apply`：重算第一名率、alpha 账本、种子治理、落地冠军身份',
    '- 全部必需检查通过后自动 squash merge；无人工批准、无管理员强制合并',
  ].join('\n');
  const pr = sh('gh', ['pr', 'create', '--repo', repo, '--base', base, '--head', branch,
    '--title', `第一名率冠军晋级：${candidateId}`, '--body', body], { cwd: tree, timeout: 300_000 }).trim();
  sh('gh', ['pr', 'merge', pr, '--squash', '--auto'], { cwd: tree, timeout: 300_000 });
  console.log(JSON.stringify({
    verdict: 'PR_OPENED', repo, base, branch, commit, candidateId, pr,
    note: 'PR 已创建并启用 auto-merge；CI 机器门禁通过后自动合并',
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    verdict: 'PUBLISH_FAILED',
    error: String(error?.stderr || error?.message || error).slice(0, 2000),
    branch,
  }, null, 2));
  process.exit(1);
} finally {
  if (registered) {
    try { sh('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot }); } catch {}
  }
  rmSync(workRoot, { recursive: true, force: true });
}
