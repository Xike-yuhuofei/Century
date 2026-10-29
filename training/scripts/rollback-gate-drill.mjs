#!/usr/bin/env node
/** P4/P6：安全回滚门禁隔离演练。
 *
 * 目的：证明新的回滚门禁「既能真实回滚，也无法被滥用」。所有操作发生在
 * 临时 git 仓库（/tmp），正式仓库的 champion.json 与 git 历史零改动。
 *
 * 覆盖：
 * 1. 合法晋级落地（切换冠军 + 候选归档）→ 允许回滚，revert 后 champion.json
 *    与上一版逐字节一致，verify-rollback PASS，ci-summary 放行；
 * 2. champion.json 被手工改写（没有切换冠军 / 无晋级证据）→ 回滚拒绝；
 * 3. 回滚夹带无关改动 → verify-rollback FAIL，ci-summary 拒绝；
 * 4. 连续回滚（回滚提交本身再被回滚）→ 拒绝，防止部署持续失败时的回滚循环。
 *
 * 用法：node training/scripts/rollback-gate-drill.mjs
 * 输出：training/reports/rollback-gate-drill.json
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';

const ROLLBACK = resolve(REPO_ROOT, 'scripts/ci/rollback-champion.mjs');
const VERIFY = resolve(REPO_ROOT, 'scripts/ci/verify-rollback.mjs');
const SUMMARIZE = resolve(REPO_ROOT, 'scripts/ci/summarize.mjs');
const CHANGE_SCOPE = resolve(REPO_ROOT, 'scripts/ci/change-scope.mjs');
const OUTPUT = resolve(REPO_ROOT, 'training/reports/rollback-gate-drill.json');

const checks = [];
function check(id, pass, evidence) {
  checks.push({ id, status: pass ? 'PASS' : 'FAIL', evidence: String(evidence).slice(0, 600) });
  return pass;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
  });
}

function runAllowingFailure(command, args, options = {}) {
  try {
    return { ok: true, stdout: run(command, args, options), stderr: '' };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) };
  }
}

function git(cwd, args) {
  return run('git', args, { cwd }).trim();
}

function championDoc(id, { planId = null, challengeIndex = null } = {}) {
  return {
    id,
    parameters: {
      id, engineWeight: 1, tempoWeight: 1, contestWeight: 1, synergyWeight: 1,
      goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
      adapter: 'champion-guided', jointVersion: 'joint-js5', budgetMs: 100,
    },
    provenance: {
      basedOn: null,
      promotedAt: '2026-10-26',
      promotionEvidence: planId !== null || challengeIndex !== null
        ? { ...(planId ? { planId } : {}), ...(challengeIndex !== null ? { challengeIndex } : {}) }
        : undefined,
    },
  };
}

/** 构造临时仓库：commit A（旧冠军）→ commit B（晋级切换）。 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'century-rollback-drill-'));
  mkdirSync(join(root, 'training/champions/candidates'), { recursive: true });
  mkdirSync(join(root, 'training/reports'), { recursive: true });
  mkdirSync(join(root, 'web-v1/src/ai'), { recursive: true });
  mkdirSync(join(root, 'web-v1/dist'), { recursive: true });
  mkdirSync(join(root, 'scripts/ci/lib'), { recursive: true });
  mkdirSync(join(root, 'training/scripts'), { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'drill']);
  git(root, ['config', 'user.email', 'drill@local']);
  writeFileSync(join(root, 'training/champions/champion.json'), `${JSON.stringify(championDoc('champ-a'), null, 2)}\n`);
  writeFileSync(join(root, 'web-v1/src/ai/parameters.ts'), 'export const CHAMPION_PARAMETERS = { id: "champ-a" };\n');
  writeFileSync(join(root, 'web-v1/dist/standalone.html'), '<html>champ-a</html>\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'chore: baseline champion champ-a']);
  const base = git(root, ['rev-parse', 'HEAD']);
  return { root, base };
}

function commitPromotion(root, { id, planId, challengeIndex }) {
  writeFileSync(join(root, 'training/champions/champion.json'), `${JSON.stringify(championDoc(id, { planId, challengeIndex }), null, 2)}\n`);
  writeFileSync(join(root, 'training/champions/candidates', `${id}.json`), `${JSON.stringify(championDoc(id, { planId, challengeIndex }), null, 2)}\n`);
  writeFileSync(join(root, 'web-v1/src/ai/parameters.ts'), `export const CHAMPION_PARAMETERS = { id: "${id}" };\n`);
  writeFileSync(join(root, 'web-v1/dist/standalone.html'), `<html>${id}</html>\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', `feat(ai8): 第一名率冠军晋级 ${id}（机器门禁）`]);
  return git(root, ['rev-parse', 'HEAD']);
}

function rollbackDryRun(root, planPath) {
  const result = runAllowingFailure(process.execPath, [ROLLBACK, '--dry-run', '--json', planPath], { cwd: root });
  let plan = null;
  try { plan = JSON.parse(readFileSync(planPath, 'utf8')); } catch { plan = null; }
  return { result, plan };
}

/** 在临时仓库里真实执行 revert（模拟回滚 PR 的 HEAD）。 */
function applyRevert(root, target, { extraFiles = [], preserveArchives = true } = {}) {
  git(root, ['revert', '--no-commit', target]);
  if (preserveArchives && existsSync(join(root, 'training/champions/candidates'))) {
    // 与 rollback-champion.mjs 一致：候选归档 append-only，不随回滚删除。
    git(root, ['checkout', target, '--', 'training/champions/candidates']);
  }
  for (const rel of extraFiles) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), '夹带的无关改动\n');
  }
  const message = `revert(ai8): 自动回滚冠军提交 ${target.slice(0, 12)}（原因：drill）`;
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** 用真实 change-scope 在隔离仓库中复算范围，再据此构造 ci-summary 的输入。 */
function summarizeEnv(root, { base, head, planExists }) {
  const scopeFile = join(root, 'ci-scope.json');
  const baseEnv = { ...process.env };
  delete baseEnv.GITHUB_STEP_SUMMARY;
  run(process.execPath, [CHANGE_SCOPE], {
    cwd: root,
    env: {
      ...baseEnv,
      EVENT_NAME: 'push',
      BASE_SHA: base,
      HEAD_SHA: head,
      HEAD_REF: 'rollback/champion-drill',
      PR_LABELS: '[]',
      FORCE_SCOPE: 'auto',
      FORCE_PROMOTION: 'false',
      CI_REPO_ROOT: root,
      CI_SCOPE_JSON: scopeFile,
    },
  });
  const scope = JSON.parse(readFileSync(scopeFile, 'utf8'));
  const needs = {
    changes: { result: 'success' },
    'governance-tests': { result: 'success' },
    'rules-cards': { result: 'success' },
  };
  if (scope.build) needs.build = { result: 'success' };
  if (scope.web) needs['web-unit'] = { result: 'success' };
  if (scope.training) needs['training-unit'] = { result: 'success' };
  if (scope.ai9) needs['ai9-research'] = { result: 'success' };
  if (scope.simulation) needs.simulation = { result: 'success' };
  if (scope.ui) needs['ui-smoke'] = { result: 'success' };
  if (scope.audit && !scope.promotion) needs['audit-gate'] = { result: 'success' };
  if (scope.rollback) needs['rollback-gate'] = { result: planExists ? 'success' : 'skipped' };
  const bool = value => (value ? 'true' : 'false');
  return {
    ...baseEnv,
    NEEDS_JSON: JSON.stringify(needs),
    EVENT_NAME: 'push',
    REF: 'refs/heads/rollback/champion-drill',
    HEAD_REF: 'rollback/champion-drill',
    BASE_SHA: base,
    HEAD_SHA: head,
    FORCE_SCOPE: 'auto',
    FORCE_PROMOTION: 'false',
    SCOPE_BUILD: bool(scope.build),
    SCOPE_WEB: bool(scope.web),
    SCOPE_TRAINING: bool(scope.training),
    SCOPE_AI5: bool(scope.ai5),
    SCOPE_AI9: bool(scope.ai9),
    SCOPE_UI: bool(scope.ui),
    SCOPE_SIMULATION: bool(scope.simulation),
    SCOPE_AUDIT: bool(scope.audit),
    SCOPE_RESEARCH: bool(scope.research),
    SCOPE_PROMOTION: bool(scope.promotion),
    SCOPE_ROLLBACK: bool(scope.rollback),
    SCOPE_PAGES: bool(scope.pages),
    SCOPE_RULES: 'true',
    SCOPE_GOVERNANCE: 'true',
    SCOPE_DOCS_ONLY: bool(scope.docsOnly),
    SCOPE_AUDIT_TIER: scope.audit ? 'research' : 'dev',
    SCOPE_CHANGED_COUNT: String(scope.changedCount ?? 0),
    SCOPE_REASONS: (scope.reasons ?? []).join(', '),
    // change-scope/summarize 必须在隔离仓库中复算 diff，而不是正式仓库。
    CI_REPO_ROOT: root,
    ROLLBACK_PLAN_FILE: join(root, 'training/reports/rollback-plan.json'),
    ROLLBACK_VERIFICATION_FILE: join(root, 'training/reports/rollback-verification.json'),
    CI_SUMMARY_JSON: join(root, 'training/reports/ci-summary.json'),
  };
}

function main() {
  // ---- 场景 1：合法晋级 → 允许回滚 → 恢复逐字节一致 → ci-summary 放行 ----
  const legal = makeRepo();
  const planPath = join(legal.root, 'training/reports/rollback-plan.json');
  try {
    const target = commitPromotion(legal.root, { id: 'champ-b', planId: 'plan-drill-1', challengeIndex: 12 });
    const { result, plan } = rollbackDryRun(legal.root, planPath);
    check('legal-promotion-allows-rollback',
      result.ok && plan?.verdict === 'ROLLBACK_DRY_RUN' && plan?.restoresPreviousChampion === true
        && plan?.isChampionPromotion === true,
      JSON.stringify({ ok: result.ok, plan: plan && { verdict: plan.verdict, prev: plan.previousChampionId, restores: plan.restoresPreviousChampion } }));

    // 真实执行回滚（revert）并让 verify-rollback + summarize 在隔离仓库中判定。
    writeFileSync(planPath, `${JSON.stringify({ ...plan, verdict: 'ROLLBACK_PR_OPENED' }, null, 2)}\n`);
    const head = applyRevert(legal.root, target);
    const verify = runAllowingFailure(process.execPath, [
      VERIFY, '--plan', 'training/reports/rollback-plan.json',
      '--out', 'training/reports/rollback-verification.json', '--no-parameters-check',
    ], { cwd: legal.root });
    let verification = null;
    try { verification = JSON.parse(readFileSync(join(legal.root, 'training/reports/rollback-verification.json'), 'utf8')); } catch { verification = null; }
    check('legal-rollback-verification-passes',
      verification?.verdict === 'PASS',
      JSON.stringify({ exit: verify.ok, verdict: verification?.verdict, failed: (verification?.checks ?? []).filter(c => c.status === 'FAIL').map(c => c.id) }));

    const summary = runAllowingFailure(process.execPath, [SUMMARIZE], {
      cwd: legal.root, env: summarizeEnv(legal.root, { base: legal.base, head, planExists: true }),
    });
    check('legal-rollback-summary-passes', summary.ok && summary.stdout.includes('回滚验证通过'),
      `${summary.ok ? 'exit=0' : 'exit≠0'} ${summary.stdout.slice(-200)}`);

    // 场景 4：连续回滚必须被拒绝（回滚提交本身不能再被回滚）。
    const loopPlan = join(legal.root, 'training/reports/loop-plan.json');
    const loop = rollbackDryRun(legal.root, loopPlan);
    check('rollback-loop-refused',
      !loop.result.ok && loop.plan?.verdict === 'ROLLBACK_REFUSED' && /回滚提交/.test(String(loop.plan?.reason)),
      JSON.stringify(loop.plan ?? {}).slice(0, 300));
  } finally {
    rmSync(legal.root, { recursive: true, force: true });
  }

  // ---- 场景 2：champion.json 被手工改写（不是晋级切换）→ 拒绝回滚 ----
  const tampered = makeRepo();
  try {
    const doc = championDoc('champ-a');
    doc.parameters.tempoWeight = 9.9;
    writeFileSync(join(tampered.root, 'training/champions/champion.json'), `${JSON.stringify(doc, null, 2)}\n`);
    git(tampered.root, ['add', '.']);
    git(tampered.root, ['commit', '-qm', 'chore: 手工调整冠军权重（非晋级）']);
    const { result, plan } = rollbackDryRun(tampered.root, join(tampered.root, 'training/reports/tamper-plan.json'));
    check('tampered-champion-refused',
      !result.ok && plan?.verdict === 'ROLLBACK_REFUSED' && /没有切换冠军|缺少可复核的晋级证据/.test(String(plan?.reason)),
      JSON.stringify(plan ?? {}).slice(0, 300));
  } finally {
    rmSync(tampered.root, { recursive: true, force: true });
  }

  // ---- 场景 3：回滚夹带无关改动 → verify-rollback FAIL → ci-summary 拒绝 ----
  const sneaky = makeRepo();
  const sneakyPlan = join(sneaky.root, 'training/reports/rollback-plan.json');
  try {
    const target = commitPromotion(sneaky.root, { id: 'champ-c', planId: 'plan-drill-3', challengeIndex: 13 });
    const { plan } = rollbackDryRun(sneaky.root, sneakyPlan);
    writeFileSync(sneakyPlan, `${JSON.stringify({ ...plan, verdict: 'ROLLBACK_PR_OPENED' }, null, 2)}\n`);
    // 回滚提交夹带一个与本冠军无关的源码改动。
    const head = applyRevert(sneaky.root, target, { extraFiles: ['training/evolution/EVIL.mjs'] });
    const verify = runAllowingFailure(process.execPath, [
      VERIFY, '--plan', 'training/reports/rollback-plan.json',
      '--out', 'training/reports/rollback-verification.json', '--no-parameters-check',
    ], { cwd: sneaky.root });
    let verification = null;
    try { verification = JSON.parse(readFileSync(join(sneaky.root, 'training/reports/rollback-verification.json'), 'utf8')); } catch { verification = null; }
    const failedIds = (verification?.checks ?? []).filter(c => c.status === 'FAIL').map(c => c.id);
    check('sneaky-rollback-refused-by-verifier',
      !verify.ok && verification?.verdict === 'FAIL' && failedIds.includes('no-unrelated-changes'),
      JSON.stringify({ exit: verify.ok, verdict: verification?.verdict, failed: failedIds }));

    const summary = runAllowingFailure(process.execPath, [SUMMARIZE], {
      cwd: sneaky.root, env: summarizeEnv(sneaky.root, { base: sneaky.base, head, planExists: true }),
    });
    check('sneaky-rollback-blocked-by-summary',
      !summary.ok && /回滚独立验证未通过|回滚/.test(summary.stdout + summary.stderr),
      `${summary.ok ? 'exit=0（异常放行）' : 'exit≠0'} ${(summary.stdout + summary.stderr).slice(-260)}`);
  } finally {
    rmSync(sneaky.root, { recursive: true, force: true });
  }

  // ---- 场景 5：回滚计划缺失 → ci-summary 失败关闭 ----
  const noPlan = makeRepo();
  try {
    writeFileSync(join(noPlan.root, 'UNRELATED.md'), '无关改动\n');
    git(noPlan.root, ['add', '.']);
    git(noPlan.root, ['commit', '-qm', 'chore: 无关改动']);
    const head = git(noPlan.root, ['rev-parse', 'HEAD']);
    const summary = runAllowingFailure(process.execPath, [SUMMARIZE], {
      cwd: noPlan.root, env: summarizeEnv(noPlan.root, { base: noPlan.base, head, planExists: false }),
    });
    check('missing-rollback-plan-fails-closed',
      !summary.ok && /回滚计划产物缺失|rollback-gate/.test(summary.stdout + summary.stderr),
      `${summary.ok ? 'exit=0（异常放行）' : 'exit≠0'} ${(summary.stdout + summary.stderr).slice(-260)}`);
  } finally {
    rmSync(noPlan.root, { recursive: true, force: true });
  }

  const failed = checks.filter(c => c.status === 'FAIL');
  const report = {
    schema: 'century-rollback-gate-drill-v1',
    generatedAt: new Date().toISOString(),
    verdict: failed.length ? 'FAIL' : 'PASS',
    checks,
    isolation: '全部场景在 /tmp 临时 git 仓库执行；正式仓库的 champion.json、git 历史与线上部署零改动',
    note: '本演练证明回滚门禁既允许合法回滚，也拒绝手工改写/夹带/回滚循环；真实回滚 PR 仍需 CI 全量检查后自动合并',
  };
  writeJSON(OUTPUT, report);
  console.log(JSON.stringify({ output: OUTPUT, verdict: report.verdict, checks: checks.map(c => `${c.id}=${c.status}`) }, null, 2));
  if (failed.length) {
    console.error(`回滚门禁演练失败：${failed.map(c => `${c.id}（${c.evidence}）`).join('；')}`);
    process.exit(1);
  }
}

main();
