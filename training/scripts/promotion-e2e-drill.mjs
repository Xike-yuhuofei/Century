#!/usr/bin/env node
/** P4/P6 Test D：隔离环境中的冠军晋级→落地→构建→发布核验→回滚全链路演练。
 *
 * 目的：证明「机器晋级管线」在没有真人审批时可以完整执行，同时绝不改变正式
 * 冠军。所有写入都发生在临时 git worktree（/tmp），正式仓库的
 * training/champions/champion.json 与 web-v1/src 保持零改动。
 *
 * 覆盖：
 * 1. promote-first-place-champion（预注册证据 + alpha 账本 + 种子治理 + 身份）
 * 2. apply-champion 把新冠军参数写入隔离源码树
 * 3. web-v1 独立构建
 * 4. 本地静态站点 + verify-deploy 身份核验（新冠军）
 * 5. 损坏产物检测（verify-deploy 必须拒绝）
 * 6. 恢复上一已验证版本并重新构建/核验（回滚链路）
 *
 * 证据明确标注：候选与统计证据为隔离夹具，不代表真实棋力，也不构成正式晋级。
 */

import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT, buildProvenance, requireBuiltEngine } from '../lib/paths.mjs';
import { readJSON, writeJSON } from '../lib/io.mjs';
import { createPreregistration, lockPreregistration, REQUIRED_SEAT_COUNTS } from '../evaluator/preregistration.mjs';
import { firstPlacePromotionDecision } from '../evaluator/first-place.mjs';
import { sha256Canonical } from '../evolution/core.mjs';
import { reserveAlpha, completeAlpha } from '../lib/alpha-ledger.mjs';
import { loadSeedGovernance, formalChallengeCount, nextFormalValidationBase } from '../lib/seed-governance.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { championParametersSha256 } from '../../web-v1/scripts/build-hash.mjs';

const PROMOTE = resolve(REPO_ROOT, 'training/scripts/promote-first-place-champion.mjs');
const APPLY = resolve(REPO_ROOT, 'training/scripts/apply-champion.mjs');
const PUBLISH = resolve(REPO_ROOT, 'training/scripts/publish-promotion-pr.mjs');
const VERIFY = resolve(REPO_ROOT, 'scripts/ci/verify-deploy.mjs');
const SEEDS_PER_SEAT = 250;

const checks = [];
function check(id, status, evidence) {
  checks.push({ id, status: status ? 'PASS' : 'FAIL', evidence: String(evidence).slice(0, 500) });
  return status;
}

function mustRun(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024, ...options });
}

function startStaticServer(siteDir) {
  const server = createServer((req, res) => {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const body = readFileSync(join(siteDir, path.replace(/^\//, '')));
      res.writeHead(200, {
        'content-type': path.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise(resolveServer => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: server.address().port }));
  });
}

function runVerify(url, expectedArtifact, expectedChampion) {
  return new Promise(resolveVerify => {
    execFile(process.execPath, [
      VERIFY, '--url', url, '--expected-artifact', expectedArtifact,
      '--expected-champion', expectedChampion,
    ], { encoding: 'utf8', cwd: REPO_ROOT }, (error, stdout, stderr) => {
      resolveVerify({
        ok: !error,
        report: (() => { try { return JSON.parse(stdout); } catch { return null; } })(),
        detail: String(error ? (stderr || error.message) : '').slice(0, 300),
      });
    });
  });
}

function makeSite(worktree, siteDir) {
  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(siteDir, { recursive: true });
  copyFileSync(join(worktree, 'web-v1/dist/standalone.html'), join(siteDir, 'index.html'));
  copyFileSync(join(worktree, 'web-v1/dist/build-manifest.json'), join(siteDir, 'build-manifest.json'));
  const index = readFileSync(join(siteDir, 'index.html'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(siteDir, 'build-manifest.json'), 'utf8'));
  return { index, artifact: manifest.artifact?.sha256 ?? null };
}

function buildWorktree(worktree) {
  execFileSync('npm', ['run', 'build'], {
    cwd: join(worktree, 'web-v1'), encoding: 'utf8', stdio: 'pipe', timeout: 300_000,
  });
}

function fixtureCandidate(championParameters) {
  const id = `drill-candidate-${Date.now().toString(36)}`;
  const parameters = { ...championParameters, id, tempoWeight: 1.05 };
  const validated = validateAIParameters(parameters);
  return {
    id,
    parameters: validated,
    sourceHash: sha256Canonical(validated),
    artifactHash: sha256Canonical({ id, parameters: validated, drill: true }),
  };
}

function makeEvidence({ plan, candidate, champion, alpha, seedsBySeatCount }) {
  const strata = REQUIRED_SEAT_COUNTS.map(seatCount => ({
    seatCount,
    pairs: Array.from({ length: SEEDS_PER_SEAT }, (_, i) => ({
      seed: seedsBySeatCount[seatCount][i],
      focusSeat: i % seatCount,
      candidateFirst: i % 10 < 8 ? 1 : 0,
      championFirst: i % 10 < 2 ? 1 : 0,
      anomalies: 0,
    })),
  }));
  const decision = firstPlacePromotionDecision({
    strata,
    weights: plan.weights,
    alpha,
    margin: plan.nonInferiorityMargin,
    minSeeds: plan.minSeedsPerSeatCount,
  });
  if (!decision.promote) throw new Error(`隔离统计夹具未通过：${decision.reasons.join('；')}`);
  const runs = strata.map(s => ({ seatCount: s.seatCount, seatOffset: 0, pairs: s.pairs }));
  const evidenceHash = sha256Canonical({
    planHash: plan.planHash,
    searchWorkUnits: plan.searchWorkUnits,
    runs: runs.map(r => ({ seatCount: r.seatCount, pairs: r.pairs })),
    decision,
  });
  return {
    schema: 'century-first-place-formal-challenge-v1',
    planId: plan.planId,
    planHash: plan.planHash,
    challengeIndex: plan.challengeIndex,
    alpha,
    alphaBudget: plan.alphaBudget,
    searchWorkUnits: plan.searchWorkUnits,
    candidateId: candidate.id,
    championId: champion.id,
    opponents: plan.opponents,
    engine: plan.engine,
    producedAt: new Date().toISOString(),
    decision,
    runs,
    evidenceHash,
    note: '隔离演练夹具：合成配对结果，仅验证机器管线，不代表真实棋力',
  };
}

async function main() {
  requireBuiltEngine();
  const provenance = buildProvenance();
  const base = mkdtempSync(join(tmpdir(), 'century-promotion-e2e-'));
  const worktree = join(base, 'repo');
  const fixtures = join(base, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  const siteNew = join(base, 'site-new');
  const siteCorrupt = join(base, 'site-corrupt');
  const siteRestored = join(base, 'site-restored');

  try {
    mustRun('git', ['worktree', 'add', '--detach', worktree, 'HEAD']);
    for (const rel of ['web-v1/node_modules', 'node_modules']) {
      const source = join(REPO_ROOT, rel);
      if (existsSync(source)) symlinkSync(source, join(worktree, rel), 'dir');
    }

    const mainChampionDoc = JSON.parse(readFileSync(join(worktree, 'training/champions/champion.json'), 'utf8'));
    const championParameters = validateAIParameters(mainChampionDoc.parameters);
    const candidate = fixtureCandidate(championParameters);

    const registryCopy = join(fixtures, 'seed-consumption-registry.json');
    copyFileSync(join(REPO_ROOT, 'training/governance/seed-consumption-registry.json'), registryCopy);
    const governance = loadSeedGovernance({ strict: true, centralRegistryPath: registryCopy });
    const challengeIndex = formalChallengeCount(governance) + 1;
    const alpha = 0.05 / 2 ** challengeIndex;

    // 种子窗口：从验证池内下一个未占用起点开始，避免与任何已登记区间重叠。
    const seedBase = nextFormalValidationBase(governance);
    const seatWindows = Object.fromEntries(REQUIRED_SEAT_COUNTS.map((seatCount, i) => [
      String(seatCount), { base: seedBase + i * SEEDS_PER_SEAT, count: SEEDS_PER_SEAT },
    ]));
    const plan = createPreregistration({
      planId: `drill-plan-c${challengeIndex}`,
      candidate: {
        id: candidate.id,
        parametersSha256: championParametersSha256(candidate.parameters),
        sourceHash: candidate.sourceHash,
        artifactHash: candidate.artifactHash,
      },
      champion: {
        id: championParameters.id,
        parametersSha256: championParametersSha256(championParameters),
        artifactHash: provenance.decisionArtifactSha256,
      },
      opponents: [
        { id: 'style-engine', fingerprint: 'a'.repeat(64) },
        { id: 'neutral-baseline', fingerprint: 'b'.repeat(64) },
      ],
      seatWindows,
      challengeIndex,
      minSeedsPerSeatCount: 60,
      engine: {
        engineBundleSha256: provenance.engineBundleSha256,
        sourceClosureSha256: provenance.sourceClosureSha256,
        decisionSourceSha256: provenance.decisionSourceSha256,
        decisionArtifactSha256: provenance.decisionArtifactSha256,
        codeCommit: provenance.buildGitCommit,
      },
    });
    const locked = lockPreregistration({
      plan, dir: fixtures, writeJSON: (path, value) => writeFileSync(path, JSON.stringify(value, null, 2)),
    });
    // 与真实挑战 runner 一致：门禁/发布器读取固定名 preregistration.json。
    writeFileSync(join(fixtures, 'preregistration.json'), readFileSync(locked.path, 'utf8'));
    const seedsBySeatCount = Object.fromEntries(REQUIRED_SEAT_COUNTS.map(seatCount => [
      seatCount,
      Array.from({ length: SEEDS_PER_SEAT }, (_, i) => seatWindows[String(seatCount)].base + i),
    ]));
    const evidence = makeEvidence({ plan, candidate, champion: { id: championParameters.id }, alpha, seedsBySeatCount });
    const evidencePath = join(fixtures, 'challenge-evidence.json');
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    const candidatePath = join(fixtures, 'candidate.json');
    writeFileSync(candidatePath, JSON.stringify({ ...candidate, parameters: candidate.parameters }, null, 2));

    const ledgerCopy = join(fixtures, 'alpha-ledger.json');
    copyFileSync(join(REPO_ROOT, 'training/governance/alpha-ledger.json'), ledgerCopy);
    reserveAlpha({ challengeIndex, planId: plan.planId, candidateId: candidate.id, ledgerPath: ledgerCopy });
    completeAlpha({
      challengeIndex, planId: plan.planId, decision: 'promote',
      evidenceHash: evidence.evidenceHash, ledgerPath: ledgerCopy,
    });

    const registry = JSON.parse(readFileSync(registryCopy, 'utf8'));
    registry.entries.push({
      experimentId: `drill-formal-${candidate.id}`,
      base: seatBase(seatWindows),
      size: SEEDS_PER_SEAT * REQUIRED_SEAT_COUNTS.length,
      purposeClass: 'formal-challenge',
      purpose: 'first-place-formal-challenge@2-5p',
      status: 'completed',
      challengeIndex,
      countsTowardChallengeIndex: true,
      evidencePath: fixtures,
      codeCommit: provenance.buildGitCommit,
      crnGroup: null,
      reservedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      note: 'promotion-e2e-drill isolated fixture',
    });
    writeFileSync(registryCopy, JSON.stringify(registry, null, 2));

    const championTarget = join(worktree, 'training/champions/champion.json');
    const baseChampionSnapshot = join(base, 'base-champion.json');
    copyFileSync(championTarget, baseChampionSnapshot);
    const promoteArgs = [
      PROMOTE,
      '--evidence', evidencePath,
      '--plan', locked.path,
      '--candidate', candidatePath,
      '--champion', championTarget,
      '--base-champion', baseChampionSnapshot,
      '--alpha-ledger', ledgerCopy,
      '--governance-central', registryCopy,
    ];
    const dry = execFileSync(process.execPath, [...promoteArgs, '--dry-run'], { encoding: 'utf8', cwd: REPO_ROOT });
    check('promotion-gate-dry-run', /"verdict":\s*"PROMOTE"/.test(dry), dry.slice(0, 300));

    const promoted = execFileSync(process.execPath, promoteArgs, { encoding: 'utf8', cwd: REPO_ROOT });
    check('promotion-gate-applied', /"verdict":\s*"PROMOTE"/.test(promoted)
      && JSON.parse(readFileSync(championTarget, 'utf8')).parameters.id === candidate.id,
      promoted.slice(0, 300));

    // 冠军 PR 复核模式：PR 里 champion.json 已是候选本身，CI 必须能用
    // --post-apply 复核并通过（否则真实晋级 PR 永远无法自动合并）。
    const post = execFileSync(process.execPath, [...promoteArgs, '--post-apply'], { encoding: 'utf8', cwd: REPO_ROOT });
    check('promotion-gate-post-apply', /"verdict":\s*"VERIFY_APPLIED"/.test(post), post.slice(0, 300));

    // 自动发布器 dry-run：在干净的 origin/main worktree 内完成 promote→apply→commit，
    // 不 push、不建 PR；证明 campaign→冠军 PR 的交接代码可执行且不改正式仓库。
    const publishOut = execFileSync(process.execPath, [
      PUBLISH, '--dry-run', '--evidence-dir', fixtures,
      '--alpha-ledger', ledgerCopy, '--governance-central', registryCopy,
      '--base-commit', mustRun('git', ['rev-parse', 'HEAD']).trim(),
    ], { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 });
    const publishDry = JSON.parse(publishOut);
    check('publish-pr-dry-run', publishDry.verdict === 'DRY_RUN'
      && publishDry.candidateId === candidate.id
      && publishDry.files.some(f => f.endsWith('champion.json'))
      && publishDry.files.some(f => f.endsWith('parameters.ts')),
      `commit=${publishDry.commit?.slice(0, 12)} files=${publishDry.files?.length}`);

    execFileSync(process.execPath, [
      APPLY, '--champion', championTarget, '--target', join(worktree, 'web-v1/src/ai/parameters.ts'),
    ], { encoding: 'utf8', cwd: REPO_ROOT });
    const appliedSource = readFileSync(join(worktree, 'web-v1/src/ai/parameters.ts'), 'utf8');
    check('apply-champion', appliedSource.includes(candidate.id), `parameters.ts 含 ${candidate.id}`);

    buildWorktree(worktree);
    // 构建后回写冠军构建身份，并跑 promotion 层审计（CI 的真实门禁）。
    execFileSync(process.execPath, [join(worktree, 'training/scripts/refresh-champion-provenance.mjs')], {
      encoding: 'utf8', cwd: worktree,
    });
    execFileSync(process.execPath, [
      join(worktree, 'training/scripts/version-lock.mjs'), '--write', '--note', 'promotion-e2e-drill 合成冠军',
    ], { encoding: 'utf8', cwd: worktree });
    let auditOk = false;
    let auditDetail = '';
    try {
      const auditJsonPath = join(worktree, 'training/reports/audit-gate-promote-drill.json');
      execFileSync(process.execPath, [
        join(worktree, 'training/redteam/audit-gate.mjs'), '--tier', 'promotion',
        '--json', auditJsonPath,
      ], { encoding: 'utf8', cwd: worktree, maxBuffer: 32 * 1024 * 1024 });
      const audit = JSON.parse(readFileSync(auditJsonPath, 'utf8'));
      auditOk = audit.verdict === 'PASS';
      auditDetail = `${audit.verdict}；${audit.checks.filter(c => c.status !== 'PASS').map(c => `${c.id}:${c.status}`).join(' ')}`.slice(0, 600);
    } catch (error) {
      auditDetail = String(error.stdout ?? error.message).slice(0, 600);
    }
    check('audit-gate-promotion', auditOk, auditDetail);

    const built = makeSite(worktree, siteNew);
    check('build-embeds-champion', built.index.includes(candidate.id) && built.index.includes('champion-guided'),
      `index.html 含新冠军 id/adapter；artifact=${String(built.artifact).slice(0, 12)}`);

    {
      const { server, port } = await startStaticServer(siteNew);
      try {
        const verified = await runVerify(`http://127.0.0.1:${port}/`, built.artifact, candidate.id);
        check('deploy-verify-new-champion', verified.ok, verified.detail || JSON.stringify(verified.report?.checks?.slice(-3)));
      } finally {
        await new Promise(close => server.close(close));
      }
    }

    // 损坏产物：篡改 index.html，必须被拒绝。
    cpSync(siteNew, siteCorrupt, { recursive: true });
    writeFileSync(join(siteCorrupt, 'index.html'), '<!doctype html><html><body>corrupt</body></html>');
    {
      const { server, port } = await startStaticServer(siteCorrupt);
      try {
        const verified = await runVerify(`http://127.0.0.1:${port}/`, built.artifact, candidate.id);
        check('corrupt-deploy-rejected', !verified.ok, verified.detail || '损坏产物被 verify-deploy 拒绝');
      } finally {
        await new Promise(close => server.close(close));
      }
    }

    // 回滚：恢复上一已验证冠军源码与参数，重建并核验旧身份。
    mustRun('git', ['-C', worktree, 'checkout', '--', 'training/champions/champion.json', 'web-v1/src/ai/parameters.ts']);
    buildWorktree(worktree);
    const restored = makeSite(worktree, siteRestored);
    check('rollback-restores-previous', restored.index.includes(championParameters.id) && !restored.index.includes(candidate.id),
      `恢复后 index.html 冠军=${championParameters.id}`);
    {
      const { server, port } = await startStaticServer(siteRestored);
      try {
        const verified = await runVerify(`http://127.0.0.1:${port}/`, restored.artifact, championParameters.id);
        check('rollback-deploy-verified', verified.ok, verified.detail || '回滚版本 verify-deploy 放行');
      } finally {
        await new Promise(close => server.close(close));
      }
    }

    let cleaned = false;
    try {
      mustRun('git', ['worktree', 'remove', '--force', worktree]);
      cleaned = true;
    } catch { /* 由 finally 兜底清理 */ }
    rmSync(base, { recursive: true, force: true });

    const failed = checks.filter(c => c.status === 'FAIL');
    const report = {
      schema: 'century-promotion-e2e-drill-v1',
      generatedAt: new Date().toISOString(),
      verdict: failed.length ? 'FAIL' : 'PASS',
      checks,
      candidateId: candidate.id,
      previousChampion: championParameters.id,
      challengeIndex,
      alpha,
      worktreeCleaned: cleaned,
      note: '隔离 git worktree 内执行完整机器晋级/落地/构建/发布核验/回滚；候选与统计证据为合成夹具，正式冠军与正式仓库文件未被修改',
    };
    writeJSON(resolve(REPO_ROOT, 'training/reports/promotion-e2e-drill.json'), report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    if (existsSync(worktree)) {
      try { mustRun('git', ['worktree', 'remove', '--force', worktree]); } catch { /* best effort */ }
    }
    rmSync(base, { recursive: true, force: true });
  }
}

function seatBase(seatWindows) {
  const bases = REQUIRED_SEAT_COUNTS.map(seatCount => seatWindows[String(seatCount)].base);
  return Math.min(...bases);
}

main().catch(error => {
  console.error(`晋级 E2E 演练失败：${error.stack ?? error.message}`);
  process.exit(1);
});
