/** P2/P4：自动正式挑战处理器的预算/功效门禁与失败隔离。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPromotionHandler, assessChallengeReadiness } from '../promotion-handler.mjs';
import { initializeAlphaFamily, readAlphaLedger, ALPHA_LEDGER_PATH } from '../../lib/alpha-ledger.mjs';

function gameArtifact(overrides = {}) {
  return {
    candidateId: 'cand-handler-test',
    sourceHash: 'a'.repeat(64),
    artifactHash: 'b'.repeat(64),
    parameters: {
      id: 'cand-handler-test',
      values: {
        id: 'cand-handler-test', engineWeight: 1, tempoWeight: 1, contestWeight: 1,
        synergyWeight: 1, goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
        adapter: 'champion-guided', jointVersion: 'joint-js5', budgetMs: 100,
      },
    },
    algorithmStructure: {
      targetIds: ['acquisitionValue'], decisionCore: 'compiled-plugin', evaluationMode: 'game',
    },
    ...overrides,
  };
}

test('真实账本预算耗尽/功效不足：明确 BLOCKED，不调用挑战运行器', async () => {
  let calls = 0;
  const handler = createPromotionHandler({
    ledgerPath: ALPHA_LEDGER_PATH,
    challengeRunner: async () => { calls += 1; return { evidence: {} }; },
  });
  const outcome = await handler({ artifact: gameArtifact(), request: { requestId: 'r1' }, requestPath: '/tmp/r1.json' });
  assert.equal(outcome.verdict, 'BLOCKED');
  assert.equal(outcome.reason, 'insufficient-statistical-power');
  assert.equal(outcome.promotionTriggered, false);
  assert.equal(calls, 0, '预算/功效不足时绝不能消费验证种子');
  const readiness = assessChallengeReadiness({
    ledger: readAlphaLedger(ALPHA_LEDGER_PATH),
    seedsPerSeat: 250, targetEffect: 0.05, variance: 1, minPower: 0.8,
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.requiredSeeds > 250, `需要更多种子：${readiness.requiredSeeds}`);
  assert.ok(readiness.alpha > 0 && readiness.alpha < 0.001);
});

test('proxy-only 候选没有真实对局行为：拒绝进入正式挑战', async () => {
  const handler = createPromotionHandler({ challengeRunner: async () => assert.fail('不得调用') });
  const artifact = gameArtifact({
    algorithmStructure: { targetIds: ['goalValue'], decisionCore: 'plugin-only', evaluationMode: 'proxy' },
  });
  const outcome = await handler({ artifact, request: {}, requestPath: null });
  assert.equal(outcome.verdict, 'BLOCKED');
  assert.equal(outcome.reason, 'not-game-evaluable');
});

test('新 alpha 家族功效达标：自动发起挑战；不晋级时记录 NOT_PROMOTED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-handler-'));
  const ledgerPath = join(dir, 'alpha.json');
  try {
    initializeAlphaFamily({
      mode: 'fixed-horizon-bonferroni', maxChallenges: 10, alphaBudget: 0.05,
      authorization: 'unit-test', authorizedBy: 'unit-test', ledgerPath,
    });
    let observed = null;
    const handler = createPromotionHandler({
      ledgerPath,
      policy: { seedsPerSeat: 500, targetEffect: 0.2, variance: 1, minPower: 0.8, workUnits: 32 },
      challengeRunner: async args => {
        observed = args;
        return {
          evidence: { evidenceHash: 'e'.repeat(64) },
          decision: { promote: false, verdict: 'NOT_PROMOTED', reasons: ['ci-lower<=0'] },
        };
      },
    });
    const outcome = await handler({ artifact: gameArtifact(), request: {}, requestPath: null });
    assert.equal(outcome.verdict, 'NOT_PROMOTED');
    assert.equal(outcome.promotionTriggered, false);
    assert.equal(observed.policy.seedsPerSeat, 500);
    assert.equal(observed.policy.workUnits, 32);
    assert.match(observed.evidenceDir, /first-place-promotion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('统计合格证据就绪：不自行合并，交由 CI 机器门禁复核', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-handler-'));
  const ledgerPath = join(dir, 'alpha.json');
  try {
    initializeAlphaFamily({
      mode: 'fixed-horizon-bonferroni', maxChallenges: 10, alphaBudget: 0.05,
      authorization: 'unit-test', authorizedBy: 'unit-test', ledgerPath,
    });
    let published = null;
    const handler = createPromotionHandler({
      ledgerPath,
      policy: { seedsPerSeat: 500, targetEffect: 0.2, variance: 1, minPower: 0.8 },
      challengeRunner: async () => ({
        evidence: { evidenceHash: 'f'.repeat(64) },
        decision: { promote: true, verdict: 'PROMOTE', reasons: [] },
      }),
      publish: evidenceDir => { published = evidenceDir; return '/tmp/latest'; },
    });
    const outcome = await handler({ artifact: gameArtifact(), request: {}, requestPath: null });
    assert.equal(outcome.verdict, 'PROMOTE_EVIDENCE_READY');
    assert.equal(published, outcome.evidenceDir);
    assert.equal(outcome.promotionTriggered, false, '处理器不得直接改冠军');
    assert.match(outcome.note, /CI promotion-machine-gate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('挑战运行器失败：记录 CHALLENGE_ERROR，不中断 campaign', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-handler-'));
  const ledgerPath = join(dir, 'alpha.json');
  try {
    initializeAlphaFamily({
      mode: 'geometric', alphaBudget: 0.05,
      authorization: 'unit-test', authorizedBy: 'unit-test', ledgerPath,
    });
    const handler = createPromotionHandler({
      ledgerPath,
      policy: { seedsPerSeat: 500, targetEffect: 0.2, variance: 1, minPower: 0.8 },
      challengeRunner: async () => ({ evidence: null, exitCode: 1, stderr: 'boom' }),
    });
    const outcome = await handler({ artifact: gameArtifact(), request: {}, requestPath: null });
    assert.equal(outcome.verdict, 'CHALLENGE_ERROR');
    assert.equal(outcome.reason, 'no-evidence-produced');
    assert.equal(outcome.promotionTriggered, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
