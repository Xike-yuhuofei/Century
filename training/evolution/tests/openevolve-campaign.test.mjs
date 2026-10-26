/** P1：OpenEvolve → Campaign 双轨道生成器接线测试（不启动真实 LLM）。
 *
 * 覆盖：
 * - bounded 模式仍由确定性变异产出并打标签；
 * - OpenEvolve 不可用/失败时的 fallback 与 stop 两种配置；
 * - 成功时源码候选标记 generator='openevolve-llm' 并携带真实对局证据元数据；
 * - targetIds 不含 acquisitionValue 时跳过源码轨道；
 * - round evidence sidecar 落盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCandidateFromSpec, generateCandidateBatch } from '../candidate-generator.mjs';
import {
  createOpenEvolveCampaignGenerator, writeOpenEvolveEvidence, parseRunIterations,
} from '../openevolve-campaign.mjs';
import { sha256Canonical } from '../core.mjs';

function experiment() {
  return {
    configRef: 'test://openevolve-campaign',
    configHash: sha256Canonical({ test: 'openevolve-campaign' }),
    seedRefs: [
      { purpose: 'screen', windowId: 'ai7-screen-w000', base: 1_610_000_000, count: 2 },
      { purpose: 'deep', windowId: 'ai7-deep-w000', base: 1_620_000_000, count: 2 },
    ],
  };
}

const options = (extra = {}) => ({
  count: 2, round: 1, seed: 20261026, experiment: experiment(),
  parentArtifact: null, targetIds: null, hints: null, ...extra,
});

function fakeSourceArtifact(experimentRef, round = 1) {
  return createCandidateFromSpec({
    targetId: 'acquisitionValue',
    values: { template: 'linear-feature-v1', coefficients: { goalFit: 2.4 }, bias: 0 },
    round,
    index: 0,
    parentArtifact: null,
    experiment: experimentRef,
  }).artifact;
}

function fakeRunOk(dir, experimentRef, round = 1) {
  return {
    ok: true,
    status: 0,
    outputDir: dir,
    elapsedMs: 12,
    provenance: {
      bestProgramPath: join(dir, 'best/best_program.ts'),
      functionSha256: 'a'.repeat(64),
    },
    artifact: fakeSourceArtifact(experimentRef, round),
  };
}

const probeOk = () => ({ available: true, blocked: [], checks: [] });
const probeBlocked = () => ({ available: false, blocked: ['codex-login'], checks: [{ id: 'codex-login', status: 'BLOCKED' }] });

test('bounded 模式：确定性变异候选带标签，不触碰 OpenEvolve', () => {
  let probed = false;
  const generator = createOpenEvolveCampaignGenerator({
    mode: 'bounded',
    probeFn: () => { probed = true; return probeOk(); },
    boundedFn: opts => generateCandidateBatch({ ...opts, targetIds: ['candidateCap'], count: 2 }),
  });
  const batch = generator(options({ targetIds: ['candidateCap'] }));
  assert.equal(probed, false);
  assert.equal(batch.candidates.length, 2);
  for (const item of batch.candidates) {
    assert.equal(item.generator, 'deterministic-bounded-mutation');
    assert.equal(item.generatorMeta.sourceKind, 'bounded-mutation');
  }
});

test('OpenEvolve 不可用 + fallback：继续有界变异并明确标记失败原因', () => {
  const generator = createOpenEvolveCampaignGenerator({
    mode: 'openevolve-hybrid',
    probeFn: probeBlocked,
    runFn: () => { throw new Error('不应调用 runOpenEvolve'); },
    boundedFn: opts => generateCandidateBatch({ ...opts, targetIds: ['candidateCap'], count: opts.count }),
  });
  const batch = generator(options());
  assert.equal(batch.candidates.length, 2);
  for (const item of batch.candidates) {
    assert.equal(item.generator, 'deterministic-bounded-mutation');
  }
  assert.equal(batch.generatorMeta.fallback, 'deterministic-bounded-mutation');
  assert.equal(batch.generatorMeta.probe.available, false);
  assert.match(batch.rejectedAtGeneration[0].error, /OpenEvolve 不可用/);
});

test('OpenEvolve 不可用 + stop：安全失败，不产出伪候选', () => {
  const generator = createOpenEvolveCampaignGenerator({
    mode: 'openevolve-hybrid',
    probeFn: probeBlocked,
    onLlmUnavailable: 'stop',
    boundedFn: () => { throw new Error('stop 模式不应回退到有界变异'); },
  });
  assert.throws(() => generator(options()), err => err.code === 'LLM_UNAVAILABLE');
});

test('OpenEvolve 成功：源码候选标记 openevolve-llm，并保留真实对局证据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oe-campaign-'));
  mkdirSync(join(dir, 'best'), { recursive: true });
  writeFileSync(join(dir, 'best/best_program.ts'), [
    '/* EVOLVE-BLOCK-START */',
    'export function acquisitionValue() { return 2.4; }',
    '/* EVOLVE-BLOCK-END */',
  ].join('\n'));
  writeFileSync(join(dir, 'best/best_program_info.json'), JSON.stringify({
    id: 'p1', generation: 1, parent_id: null,
    metrics: {
      combined_score: 0.62, stage_passed: 2, games: 96, first_place_delta: 0.05,
      first_place_ci_lower: 0.01, candidate_first_rate: 0.38, champion_first_rate: 0.33,
      anomaly_rate: 0, identical_to_official: 0,
    },
  }));
  const generator = createOpenEvolveCampaignGenerator({
    mode: 'openevolve-only',
    probeFn: probeOk,
    runFn: ({ outputDir }) => ({ ...fakeRunOk(outputDir ?? dir, experiment()), outputDir: outputDir ?? dir }),
    createFromRunFn: ({ experiment: exp, round }) => fakeRunOk(dir, exp, round),
    boundedFn: () => { throw new Error('openevolve-only 不应调用有界变异'); },
  });
  const batch = generator(options({ count: 3, targetIds: ['acquisitionValue'] }));
  assert.equal(batch.candidates.length, 1);
  assert.equal(batch.candidates[0].generator, 'openevolve-llm');
  assert.equal(batch.candidates[0].generatorMeta.sourceKind, 'openevolve-llm');
  assert.equal(batch.generatorMeta.evidence.primaryMetric, 'first-place');
  assert.equal(batch.generatorMeta.evidence.firstPlaceDelta, 0.05);
  assert.equal(batch.generatorMeta.evidence.games, 96);
});

test('OpenEvolve 运行失败 + hybrid：回退有界变异且记录真实原因', () => {
  const generator = createOpenEvolveCampaignGenerator({
    mode: 'openevolve-hybrid',
    probeFn: probeOk,
    runFn: () => ({ ok: false, status: 1, signal: null, elapsedMs: 5, outputDir: '/tmp/nope' }),
    createFromRunFn: () => { throw new Error('失败时不应创建候选'); },
    boundedFn: opts => generateCandidateBatch({ ...opts, targetIds: ['candidateCap'], count: opts.count }),
  });
  const batch = generator(options({ count: 2 }));
  assert.equal(batch.candidates.length, 2);
  assert.equal(batch.generatorMeta.fallback, 'deterministic-bounded-mutation');
  assert.match(batch.rejectedAtGeneration[0].error, /未产出 best program/);
});

test('targetIds 不含 acquisitionValue：跳过源码轨道并标记', () => {
  const generator = createOpenEvolveCampaignGenerator({
    mode: 'openevolve-hybrid',
    probeFn: probeOk,
    runFn: () => { throw new Error('不应在目标范围外启动 LLM'); },
    boundedFn: opts => generateCandidateBatch({ ...opts, targetIds: ['candidateCap'], count: opts.count }),
  });
  const batch = generator(options({ count: 1, targetIds: ['candidateCap'] }));
  assert.equal(batch.candidates.length, 1);
  assert.match(batch.rejectedAtGeneration[0].error, /targetIds 不包含 acquisitionValue/);
  assert.equal(batch.generatorMeta.fallback, 'deterministic-bounded-mutation');
});

test('run.log 解析：未成为 best 的演化程序也有真实对局与行为变化证据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oe-log-'));
  writeFileSync(join(dir, 'run.log'), [
    '2026-10-26 10:00:42,590 - INFO - Iteration 1: Program 29962cce-f227-433c-b9d8-78b0d51c6b6f (parent: 8dffb3ab-fb53-4085-ba76-33c2401e64f9) completed in 577.29s | tokens: 26726 (prompt: 25038, completion: 1688)',
    '2026-10-26 10:00:42,590 - INFO - Metrics: combined_score=0.0000, stage_passed=0.0000, identical_to_official=0.0000, first_place_delta=-0.0625, first_place_ci_lower=-0.3139, candidate_first_rate=0.2500, champion_first_rate=0.3125, games=32.0000, anomaly_rate=0.0000',
  ].join('\n'));
  const iterations = parseRunIterations(dir);
  assert.equal(iterations.length, 1);
  assert.equal(iterations[0].programId, '29962cce-f227-433c-b9d8-78b0d51c6b6f');
  assert.equal(iterations[0].parentId, '8dffb3ab-fb53-4085-ba76-33c2401e64f9');
  assert.equal(iterations[0].behaviorChanged, true);
  assert.equal(iterations[0].games, 32);
  assert.equal(iterations[0].firstPlaceDelta, -0.0625);
  assert.equal(iterations[0].tokens.total, 26726);
});

test('sidecar：OpenEvolve 轮次证据可审计落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oe-sidecar-'));
  const meta = {
    mode: 'openevolve-hybrid', onLlmUnavailable: 'fallback', iterations: 1,
    probe: { available: true, blocked: [], checks: [] },
    run: { ok: true, status: 0, outputDir: '/tmp/run', elapsedMs: 10 },
    evidence: {
      bestProgramId: 'p1', generation: 2, parentId: 'p0', functionSha256: 'b'.repeat(64),
      identicalToOfficial: false, combinedScore: 0.7, stagePassed: 2, games: 96,
      firstPlaceDelta: 0.08, firstPlaceCiLower: 0.02, anomalyRate: 0, primaryMetric: 'first-place',
    },
    fallback: null,
  };
  const path = writeOpenEvolveEvidence({ dir, round: 2, generatorMeta: meta });
  assert.ok(existsSync(path));
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(doc.round, 2);
  assert.equal(doc.bestProgram.firstPlaceDelta, 0.08);
  assert.equal(doc.generatorMode, 'openevolve-hybrid');
});
