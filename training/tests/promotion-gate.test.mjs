/** P0/P4：第一名率晋级机器门禁（隔离合成证据，不消费验证池、不改正式冠军）。
 *
 * 该测试只证明「当候选满足预注册统计与安全门槛时，机器门禁可以完整执行」，
 * 不代表候选真实棋力，也不触发任何线上发布。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, buildProvenance, requireBuiltEngine } from '../lib/paths.mjs';
import { createPreregistration, lockPreregistration } from '../evaluator/preregistration.mjs';
import { firstPlacePromotionDecision } from '../evaluator/first-place.mjs';
import { sha256Canonical } from '../evolution/core.mjs';
import { reserveAlpha, completeAlpha } from '../lib/alpha-ledger.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { championParametersSha256 } from '../../web-v1/scripts/build-hash.mjs';

requireBuiltEngine();

const SCRIPT = resolve(REPO_ROOT, 'training/scripts/promote-first-place-champion.mjs');
const PROVENANCE = buildProvenance();
const CHALLENGE_INDEX = 12;
const ALPHA = 0.05 / 2 ** CHALLENGE_INDEX;
const SEED_BASE = 1_050_000_000;
const SEEDS_PER_SEAT = 250;

function candidateDoc() {
  const champion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
  return {
    id: 'fp-gate-test-candidate',
    parameters: { ...champion.parameters, id: 'fp-gate-test-candidate', tempoWeight: 1.05 },
    sourceHash: null,
    artifactHash: null,
  };
}

function makeFixture(dir) {
  const candidate = candidateDoc();
  const champion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
  const validatedCandidate = validateAIParameters(candidate.parameters);
  const validatedChampion = validateAIParameters(champion.parameters);
  const candidateIdentity = {
    id: candidate.id,
    parametersSha256: championParametersSha256(validatedCandidate),
    sourceHash: sha256Canonical(validatedCandidate),
    artifactHash: sha256Canonical(candidate),
  };
  const championIdentity = {
    id: champion.parameters.id,
    parametersSha256: championParametersSha256(validatedChampion),
    artifactHash: PROVENANCE.decisionArtifactSha256,
  };
  const seatWindows = Object.fromEntries([2, 3, 4, 5].map((n, i) => [
    String(n),
    { base: SEED_BASE + i * SEEDS_PER_SEAT, count: SEEDS_PER_SEAT },
  ]));
  const plan = createPreregistration({
    planId: 'fp-gate-test-plan',
    candidate: candidateIdentity,
    champion: championIdentity,
    opponents: [
      { id: 'style-engine', fingerprint: 'a'.repeat(64) },
      { id: 'neutral-baseline', fingerprint: 'b'.repeat(64) },
    ],
    seatWindows,
    challengeIndex: CHALLENGE_INDEX,
    minSeedsPerSeatCount: 60,
    engine: {
      engineBundleSha256: PROVENANCE.engineBundleSha256,
      sourceClosureSha256: PROVENANCE.sourceClosureSha256,
      decisionSourceSha256: PROVENANCE.decisionSourceSha256,
      decisionArtifactSha256: PROVENANCE.decisionArtifactSha256,
      codeCommit: PROVENANCE.buildGitCommit,
    },
  });
  const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
  const locked = lockPreregistration({ plan, dir, writeJSON });

  const strata = plan.seatCounts.map(seatCount => ({
    seatCount,
    pairs: Array.from({ length: SEEDS_PER_SEAT }, (_, i) => ({
      seed: plan.seatWindows[String(seatCount)].base + i,
      focusSeat: 0,
      candidateFirst: i % 10 < 8 ? 1 : 0,
      championFirst: i % 10 < 2 ? 1 : 0,
      anomalies: 0,
    })),
  }));
  const decision = firstPlacePromotionDecision({
    strata,
    weights: plan.weights,
    alpha: ALPHA,
    margin: plan.nonInferiorityMargin,
    minSeeds: plan.minSeedsPerSeatCount,
  });
  if (!decision.promote) throw new Error(`夹具判定未通过：${decision.reasons.join('；')}`);
  const runs = strata.map(s => ({ seatCount: s.seatCount, seatOffset: 0, pairs: s.pairs }));
  const evidenceHash = sha256Canonical({
    planHash: plan.planHash,
    runs: runs.map(r => ({ seatCount: r.seatCount, pairs: r.pairs })),
    decision,
  });
  const evidence = {
    schema: 'century-first-place-formal-challenge-v1',
    planId: plan.planId,
    planHash: plan.planHash,
    challengeIndex: CHALLENGE_INDEX,
    alpha: ALPHA,
    alphaBudget: 0.05,
    candidateId: candidate.id,
    championId: champion.parameters.id,
    opponents: plan.opponents,
    engine: plan.engine,
    producedAt: new Date().toISOString(),
    decision,
    runs,
    evidenceHash,
  };
  const evidencePath = join(dir, 'challenge-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  const candidatePath = join(dir, 'candidate.json');
  writeFileSync(candidatePath, JSON.stringify(candidate, null, 2));

  // alpha 账本：复制历史 11 次消耗，追加第 12 次预留/结果。
  const ledgerPath = join(dir, 'alpha-ledger.json');
  copyFileSync(resolve(REPO_ROOT, 'training/governance/alpha-ledger.json'), ledgerPath);
  reserveAlpha({
    challengeIndex: CHALLENGE_INDEX,
    planId: plan.planId,
    candidateId: candidate.id,
    ledgerPath,
  });
  completeAlpha({
    challengeIndex: CHALLENGE_INDEX,
    planId: plan.planId,
    decision: 'promote',
    evidenceHash,
    ledgerPath,
  });

  // 中央种子登记：为 4 个窗口登记一个合并的正式挑战区间。
  const registryPath = join(dir, 'seed-consumption-registry.json');
  copyFileSync(resolve(REPO_ROOT, 'training/governance/seed-consumption-registry.json'), registryPath);
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.entries.push({
    experimentId: 'fp-gate-test-formal',
    base: SEED_BASE,
    size: SEEDS_PER_SEAT * 4,
    purposeClass: 'formal-challenge',
    purpose: 'first-place-formal-challenge@2-5p',
    status: 'completed',
    challengeIndex: CHALLENGE_INDEX,
    countsTowardChallengeIndex: true,
    evidencePath: dir,
    codeCommit: PROVENANCE.buildGitCommit,
    crnGroup: null,
    reservedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    note: 'isolated gate test',
  });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  return { dir, planPath: locked.path, evidencePath, candidatePath, ledgerPath, registryPath, evidence, plan };
}

function runGate(fixture, extraArgs = []) {
  return execFileSync(process.execPath, [
    SCRIPT,
    '--evidence', fixture.evidencePath,
    '--plan', fixture.planPath,
    '--candidate', fixture.candidatePath,
    '--champion', resolve(REPO_ROOT, 'training/champions/champion.json'),
    '--alpha-ledger', fixture.ledgerPath,
    '--governance-central', fixture.registryPath,
    '--dry-run',
    ...extraArgs,
  ], { encoding: 'utf8', cwd: REPO_ROOT });
}

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'century-gate-'));
  try {
    const fixture = makeFixture(dir);
    return fn(fixture);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('机器门禁正向：预注册证据 + alpha 账本 + 种子治理全部一致 → PROMOTE', () => {
  withFixture(fixture => {
    const out = runGate(fixture);
    assert.match(out, /"verdict":\s*"PROMOTE"/);
    assert.match(out, /"candidateId":\s*"fp-gate-test-candidate"/);
    assert.match(out, new RegExp(`"challengeIndex":\\s*${CHALLENGE_INDEX}`));
  });
});

test('机器门禁反向：证据内容被篡改 → 拒绝', () => {
  withFixture(fixture => {
    const doc = JSON.parse(readFileSync(fixture.evidencePath, 'utf8'));
    doc.decision.pooled.mean += 0.01;
    writeFileSync(fixture.evidencePath, JSON.stringify(doc, null, 2));
    assert.throws(() => runGate(fixture), /evidenceHash|篡改|不一致/);
  });
});

test('机器门禁反向：相关统计不达标 → 拒绝晋级', () => {
  withFixture(fixture => {
    const doc = JSON.parse(readFileSync(fixture.evidencePath, 'utf8'));
    // 让候选第一名率与冠军接近（delta≈0），并重算自报判定与哈希。
    for (const run of doc.runs) {
      run.pairs = run.pairs.map((p, i) => ({
        ...p, candidateFirst: i % 2, championFirst: i % 3 === 0 ? 1 : 0,
      }));
    }
    // 该用例只验证 fail-closed：即使伪造 promote，独立重算也必须拒绝。
    doc.evidenceHash = sha256Canonical({
      planHash: doc.planHash,
      runs: doc.runs.map(r => ({ seatCount: r.seatCount, pairs: r.pairs })),
      decision: doc.decision,
    });
    writeFileSync(fixture.evidencePath, JSON.stringify(doc, null, 2));
    const r = (() => {
      try { return { ok: true, out: runGate(fixture) }; } catch (e) { return { ok: false, out: e.stdout ?? e.message }; }
    })();
    assert.equal(r.ok, false, '统计不达标时门禁必须拒绝');
  });
});
