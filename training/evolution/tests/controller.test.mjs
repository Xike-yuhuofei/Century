/** D4 Campaign Controller：检查点/恢复/安全停止/预算/失败隔离/重复运行保护/人工审批。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampaignController } from '../campaign-controller.mjs';
import { createTestDoubleGovernance, createGovernanceAdapter } from '../governance-adapter.mjs';
import { scriptedCandidates } from '../candidate-generator.mjs';
import { sha256Canonical } from '../core.mjs';
import { readJSON } from '../../lib/io.mjs';

function baseConfig(overrides = {}) {
  return {
    configRef: 'test://controller',
    rounds: 1,
    playerCounts: [2],
    quickSeeds: 2,
    deepSeeds: 2,
    maxMoves: 100,
    deadlineMs: 5_000,
    retainTopK: 2,
    deepConfirmations: 1,
    generation: { count: 4, seed: 11 },
    budget: { maxCandidates: 8, maxGames: 20, maxWallMs: 60_000, maxConcurrent: 1, maxDeepConfirmations: 2 },
    diagnosticsPath: 'training/reports/diagnostics-latest/analysis.json',
    humanAnalyticsFailuresPath: null,
    ...overrides,
  };
}

function fakeEvaluator({ artifact, seeds, purpose }) {
  const mode = artifact.algorithmStructure.evaluationMode;
  const n = artifact.candidateId.length % 3;
  const behaviorSignature = mode === 'game'
    ? {
        kind: 'game-behavior-v1',
        actions: { acquire: 0.15 + n * 0.05, claim: 0.15, rest: 0.2, play: 0.4, discard: 0.1 },
        meanRank: 2 + n * 0.2, meanScore: 50 + n * 3, meanMoves: 120, seatCounts: [2],
      }
    : { kind: 'proxy-coefficients-v1', targetId: artifact.algorithmStructure.targetIds[0], coefficients: { goalFit: 0.4 + n * 0.1 }, bias: 0 };
  const metrics = mode === 'game'
    ? {
        evidenceType: 'dev-game', totalGames: seeds.length, finishedGames: seeds.length,
        anomalies: 0, anomalyRate: 0, wins: n + 1,
        firstPlaceRate: (n + 1) / seeds.length, chanceAdjustedRate: 0.1 + n * 0.05,
        minWilsonLower: 0.1 + n * 0.03, p95WallMs: 800 + n * 50, meanWallMs: 700,
        byPlayerCount: {},
      }
    : { evidenceType: 'offline-proxy', fixtures: 2, fallbackCount: 0, fallbackRate: 0, proxyDelta: 0.02 + n * 0.02 };
  return {
    schema: 'test-evidence', candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest, evaluationMode: mode, purpose,
    metrics, behaviorSignature, behaviorHash: sha256Canonical(behaviorSignature),
  };
}

function makeController({ root, config = {}, evaluator = fakeEvaluator, generator = null }) {
  const provider = createTestDoubleGovernance();
  const governance = createGovernanceAdapter({ provider });
  const defaultGenerator = (opts) => scriptedCandidates({ experiment: opts.experiment, round: opts.round });
  const controller = new CampaignController({
    campaignId: 'controller-test', rootDir: root, governance, config: baseConfig(config),
    generator: generator ?? defaultGenerator, evaluator,
  });
  return { controller, provider, governance };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'ai7-controller-'));
}

test('检查点/停止/恢复/完成：同一次 campaign 可跨进程继续', async () => {
  const root = tempRoot();
  const { controller } = makeController({ root });
  const first = await controller.run({ maxSteps: 5 });
  assert.equal(first.status, 'stopped');
  assert.ok(existsSync(join(root, 'state.json')));
  assert.ok(existsSync(join(root, 'checkpoints')));
  assert.ok(readdirSync(join(root, 'checkpoints')).length > 0);
  assert.ok(existsSync(join(root, 'logs', 'events.jsonl')));

  const resumed = await controller.run({ resume: true });
  assert.equal(resumed.status, 'completed');
  assert.ok(resumed.pendingApprovals.length >= 1);
  for (const approval of resumed.pendingApprovals) {
    assert.equal(approval.status, 'pending-human-approval');
    assert.equal(approval.approvalRequired, true);
    assert.equal(approval.promotionTriggered, false);
    assert.ok(existsSync(approval.requestPath));
  }
  assert.equal(resumed.guardrails.promotionTriggered, false);
  assert.equal(resumed.guardrails.validationPoolConsumed, false);
  assert.ok(resumed.budgetUsed.games > 0);

  await assert.rejects(() => controller.run({ resume: true }), /已完成|重复运行/);
});

test('失败隔离：安全检查失败与评估异常不会阻断其他候选', async () => {
  const root = tempRoot();
  let calls = 0;
  const evaluator = options => {
    calls += 1;
    if (options.artifact.algorithmStructure.targetIds[0] === 'acquisitionValue') {
      throw new Error('simulated evaluator failure');
    }
    return fakeEvaluator(options);
  };
  const { controller } = makeController({ root, evaluator });
  const results = await controller.run();
  assert.equal(results.status, 'completed');
  const candidates = results.rounds[0].candidates;
  assert.ok(candidates.some(c => c.stage === 'safety-failed'), '应存在安全失败候选');
  assert.ok(candidates.some(c => c.stage === 'quick-failed'), '应存在评估失败候选');
  assert.ok(candidates.some(c => ['selected', 'deep-done', 'pending-approval'].includes(c.stage)), '其他候选应继续');
  assert.ok(calls > 0);
});

test('快筛优秀但深验不稳定：判 deep-unstable，不生成正式挑战待审批请求', async () => {
  const root = tempRoot();
  const evaluator = options => {
    const evidence = fakeEvaluator(options);
    if (options.purpose === 'deep' && evidence.evaluationMode === 'game') {
      evidence.metrics = {
        ...evidence.metrics,
        anomalies: 3, anomalyRate: 0.75, finishedGames: 1,
        chanceAdjustedRate: -0.5, minWilsonLower: 0,
      };
    }
    return evidence;
  };
  const { controller } = makeController({ root, evaluator });
  const results = await controller.run();
  assert.equal(results.status, 'completed');
  const unstable = results.rounds[0].candidates.filter(c => c.stage === 'deep-unstable');
  assert.ok(unstable.length >= 1, '深验不稳定候选必须被标记');
  assert.equal(results.pendingApprovals.length, 0, '不稳定候选不得生成待审批请求');
  assert.equal(results.guardrails.promotionTriggered, false);
});

test('预算上限：game 预算耗尽时安全停止，不越界消费', async () => {
  const root = tempRoot();
  const { controller } = makeController({
    root,
    config: { budget: { maxCandidates: 8, maxGames: 1, maxWallMs: 60_000, maxConcurrent: 1, maxDeepConfirmations: 1 } },
  });
  const results = await controller.run();
  assert.ok(['budget-exhausted', 'completed'].includes(results.status));
  assert.ok(results.budgetUsed.games <= 1, `games=${results.budgetUsed.games} 超过预算`);
});

test('两轮 campaign：第二轮使用轮换窗口，并消费上一轮失败研究提示', async () => {
  const root = tempRoot();
  const seen = [];
  const generator = opts => {
    seen.push({ round: opts.round, hints: opts.hints, experiment: opts.experiment });
    return scriptedCandidates({ experiment: opts.experiment, round: opts.round });
  };
  const { controller } = makeController({
    root,
    config: {
      rounds: 2, quickSeeds: 1, deepSeeds: 1, retainTopK: 2,
      generation: { count: 4, seed: 12 },
      budget: { maxCandidates: 12, maxGames: 24, maxWallMs: 60_000, maxConcurrent: 1, maxDeepConfirmations: 2 },
    },
    generator,
  });
  const results = await controller.run();
  assert.equal(results.status, 'completed');
  assert.equal(results.rounds.length, 2);
  assert.notEqual(results.rounds[0].seedWindows.screen.windowId, results.rounds[1].seedWindows.screen.windowId);
  assert.notEqual(results.rounds[0].seedWindows.deep.windowId, results.rounds[1].seedWindows.deep.windowId);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].hints?.discipline?.advisoryOnly, true);
  assert.ok(results.rounds[0].diagnostics.labels.length > 0);
});

test('安全停止（外部 requestStop）后可恢复', async () => {
  const root = tempRoot();
  const { controller } = makeController({ root });
  controller.requestStop('unit-test-stop');
  const stopped = await controller.run();
  assert.equal(stopped.status, 'stopped');
  const resumed = await controller.run({ resume: true });
  assert.equal(resumed.status, 'completed');
});

test('重复运行保护：活动锁存在时拒绝第二个进程', async () => {
  const root = tempRoot();
  const { controller } = makeController({ root });
  writeFileSync(join(root, '.campaign.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(() => controller.run(), /已有活动进程|重复运行/);
});

test('正式挑战请求文件包含待审核语义与证据引用，且不含晋级动作', async () => {
  const root = tempRoot();
  const { controller } = makeController({ root });
  const results = await controller.run();
  assert.ok(results.pendingApprovals.length >= 1);
  const approval = readJSON(results.pendingApprovals[0].requestPath);
  assert.equal(approval.status, 'pending-human-approval');
  assert.equal(approval.approvalRequired, true);
  assert.equal(approval.promotionTriggered, false);
  assert.equal(approval.validationPoolConsumed, false);
  assert.ok(approval.evidenceDir);
  assert.equal(approval.summary.validationPoolConsumed, false);
  assert.equal(approval.summary.promotionTriggered, false);
});
