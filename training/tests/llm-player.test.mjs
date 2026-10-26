/** LLM 实验基础设施测试：存储/恢复/配对运行器/分析导出/种子治理（全部 Mock，确定性）。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '../llm/store.mjs';
import { runGame } from '../llm/game-runner.mjs';
import { createMockProvider } from '../../web-v1/dist/js/ai/llm/index.js';
import {
  loadChampion, stageSeeds, focusSeatFor, frozenVersions, REPO_ROOT, modeBlock,
} from '../llm/config.mjs';
import { createCodexProvider } from '../llm/provider-codex.mjs';
import { migrateSchema } from '../llm/schema.mjs';

const provider = createMockProvider();
const champion = loadChampion();
const context = { experimentId: 'test-llm', channel: 'experiment' };

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'century-llm-test-'));
}

function makeStore(root, runId, providerInfo = provider.info()) {
  return RunStore.create({
    root, runId,
    runConfig: { experimentId: 'test-llm', stage: 'smoke', modes: [2, 5] },
    providerInfo,
  });
}

function gameOptions(store, { mode, seed, focusSeat = 0, arm = 'llm', extra = {} }) {
  return {
    store, gameId: `test-${mode}p-${seed}-${arm}-f${focusSeat}`,
    seed, seatCount: mode, focusSeat, arm,
    llmProvider: arm === 'llm' ? provider : undefined,
    llmConfig: { maxCalls: 120, tokenBudget: 2_500_000, maxRetries: 0, timeoutMs: 5000, shadowChampion: true },
    versions: frozenVersions(champion, mode),
    championParameters: champion.parameters,
    pairId: `test-${mode}p-${seed}`,
    ...context, ...extra,
  };
}

test('Mock 2 人完整对局：决策/回合/重放/SQLite/导出', async () => {
  const root = tempRoot();
  try {
    const store = makeStore(root, 'two');
    const result = await runGame(gameOptions(store, { mode: 2, seed: 1700000000, focusSeat: 0 }));
    assert.equal(result.status, 'finished');
    assert.equal(result.replayConsistency.ok, true);
    assert.ok(result.llmDecisionCount > 0);
    assert.equal(result.fallbackCount, 0);
    assert.ok(result.decisionIds.length > 0);
    const manifest = store.finalize();
    assert.equal(manifest.counts.finishedGames, 1);
    assert.equal(manifest.integrity.errors.length, 0);
    assert.equal(manifest.counts.orphanDecisions, 0);
    const db = new DatabaseSync(join(store.path, 'index.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n > 0);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM decision_tags').get().n > 0);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE mode = 2 AND source = 'llm'").get().n > 0);
    db.close();
    const exported = store.exportJson();
    const payload = JSON.parse(readFileSync(exported, 'utf8'));
    assert.equal(payload.schema, 'century-llm-dataset-v1');
    assert.equal(payload.games.length, 1);
    assert.ok(payload.games[0].decisions.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Mock 5 人对局与中断恢复（异常后重跑续接已完成回合）', async () => {
  const root = tempRoot();
  try {
    const store = makeStore(root, 'five');
    const seed = 1700000300;
    const first = await runGame(gameOptions(store, { mode: 5, seed, focusSeat: 2, extra: { maxMoves: 20 } }));
    assert.equal(first.status, 'anomaly');
    const second = await runGame(gameOptions(store, { mode: 5, seed, focusSeat: 2, extra: { maxMoves: 1200, retryAnomaly: true } }));
    assert.equal(second.status, 'finished');
    assert.ok(second.resumedFromTurns >= 20, `应恢复至少 20 回合，实际 ${second.resumedFromTurns}`);
    assert.equal(second.replayConsistency.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('存储完整性：篡改记录哈希被 finalize 检出', async () => {
  const root = tempRoot();
  try {
    const store = makeStore(root, 'tamper');
    await runGame(gameOptions(store, { mode: 2, seed: 1700000001, focusSeat: 1 }));
    const gameId = store.listGames()[0];
    const path = join(store.gameDir(gameId), 'decisions.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]);
    first.record.parsed.reason = 'tampered';
    lines[0] = JSON.stringify(first);
    writeFileSync(path, lines.join('\n') + '\n');
    const manifest = store.finalize();
    assert.ok(manifest.integrity.errors.some(e => e.includes('recordHash 不匹配')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('配对实验 CLI（Mock）与 summary 标记 evidenceClass=mock', () => {
  const root = tempRoot();
  try {
    execFileSync(process.execPath, [
      'training/llm/pair-experiment.mjs', '--stage', 'smoke', '--modes', '2',
      '--provider', 'mock', '--root', root, '--run-id', 'pair-test', '--no-export',
      '--run-token-budget', '5000000',
    ], { cwd: REPO_ROOT, stdio: 'pipe', timeout: 300_000 });
    const summary = JSON.parse(readFileSync(join(root, 'pair-test', 'summary.json'), 'utf8'));
    assert.equal(summary.evidenceClass, 'mock');
    assert.equal(summary.plannedPairs, 1);
    assert.equal(summary.completedPairs, 1);
    assert.equal(summary.validPairs, 1);
    assert.equal(summary.provider.mode, 'mock');
    const manifest = JSON.parse(readFileSync(join(root, 'pair-test', 'manifest.json'), 'utf8'));
    assert.equal(manifest.counts.games, 2);
    assert.equal(manifest.counts.finishedGames, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('分析与蒸馏导出：训练候选/OpenEvolve 模块矩阵/质量检查', async () => {
  const root = tempRoot();
  try {
    const store = makeStore(root, 'analysis');
    const seed = 1700000002;
    const result = await runGame(gameOptions(store, { mode: 2, seed, focusSeat: 0 }));
    assert.equal(result.status, 'finished');
    store.finalize();
    const out = join(store.path, 'analysis-test');
    execFileSync(process.execPath, [
      'training/llm/analyze.mjs', '--run', store.path, '--out', out, '--top', '3',
    ], { cwd: REPO_ROOT, stdio: 'pipe', timeout: 120_000 });
    for (const name of ['analysis.json', 'quality.json', 'disagreements.jsonl', 'training-candidates.jsonl', 'openevolve-diagnosis.jsonl', 'module-signal-matrix.json', 'analysis.md']) {
      assert.equal(existsSync(join(out, name)), true, `缺少 ${name}`);
    }
    const analysis = JSON.parse(readFileSync(join(out, 'analysis.json'), 'utf8'));
    assert.equal(analysis.schema, 'century-llm-analysis-v1');
    assert.equal(analysis.quality.rates.hiddenLeakFree, true);
    assert.equal(analysis.quality.rates.illegalSuggestedRate, 0);
    const candidate = JSON.parse(readFileSync(join(out, 'training-candidates.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(candidate.schema, 'century-llm-training-candidate-v1');
    assert.equal(candidate.trainingPolicy.offlineOnly, true);
    assert.equal(candidate.trainingPolicy.notOnPolicyRollout, true);
    assert.equal(candidate.quality.goldStandard, false);
    assert.ok(candidate.stateEncoding.length > 100);
    assert.ok(candidate.candidateActionEncodings.length > 0);
    const matrix = JSON.parse(readFileSync(join(out, 'module-signal-matrix.json'), 'utf8'));
    assert.deepEqual(Object.keys(matrix.modules).sort(), Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
    assert.equal(analysis.quality.rates.replayConsistencyRate, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('种子分区、席位轮换与冠军身份一致性', () => {
  const smoke2 = stageSeeds('smoke', 2, 3, 0);
  const explore2 = stageSeeds('exploratory', 2, 3, 0);
  const confirm2 = stageSeeds('confirm', 2, 3, 0);
  assert.equal(new Set([...smoke2, ...explore2, ...confirm2]).size, 9);
  assert.ok(smoke2.every(s => s >= modeBlock('smoke', 2).block[0] && s < modeBlock('smoke', 2).block[1]));
  assert.ok(explore2.every(s => s >= modeBlock('exploratory', 2).block[0] && s < modeBlock('exploratory', 2).block[1]));
  assert.ok(confirm2.every(s => s >= modeBlock('confirm', 2).block[0] && s < modeBlock('confirm', 2).block[1]));
  const seats = Array.from({ length: 8 }, (_, i) => focusSeatFor(i, 4));
  assert.deepEqual(seats, [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.equal(champion.id, champion.parameters.id);
  assert.equal(champion.record.id, champion.id);
});

test('阶段 C 预注册计划可复核且明确标记预算阻塞', () => {
  const path = join(REPO_ROOT, 'training/llm/preregistrations/ai10-llm-confirm-v1.json');
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const { planHash, ...rest } = plan;
  const recomputed = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  assert.equal(planHash, recomputed, '预注册 planHash 必须可复算');
  assert.equal(plan.schema, 'century-llm-preregistration-v1');
  assert.equal(plan.stage, 'confirm');
  assert.equal(plan.statistics.requiredSeedsPerMode, 106);
  assert.equal(plan.execution.status, 'not-started');
  assert.match(plan.execution.blockedReason, /预算|配额|墙钟/);
  for (const mode of ['2', '3', '4', '5']) {
    const stratum = plan.strata[mode];
    assert.equal(stratum.seeds.length, 106);
    assert.equal(new Set(stratum.seeds).size, 106);
    assert.ok(stratum.seeds.every(seed => seed >= 1_710_000_000 && seed < 1_720_000_000));
    assert.deepEqual(stratum.focusSeats.slice(0, mode), Array.from({ length: mode }, (_, i) => i));
  }
  assert.equal(plan.provider.kind, 'codex-cli');
  assert.equal(JSON.stringify(plan).includes('ZHIPU'), false);
});

test('Schema 迁移入口对未知版本 fail-closed', () => {
  assert.throws(() => migrateSchema('run', { schema: 'century-llm-run-v0' }), /不支持/);
  assert.throws(() => migrateSchema('run', {}), /缺少 schema/);
  assert.equal(migrateSchema('run', { schema: 'century-llm-run-v1' }).schema, 'century-llm-run-v1');
});

test('Codex Provider 身份不含任何密钥', () => {
  const codex = createCodexProvider({ model: 'gpt-5.6-sol', reasoningEffort: 'low' });
  const info = codex.info();
  assert.equal(info.kind, 'codex-cli');
  assert.equal(info.mode, 'real');
  assert.equal(info.endpointHost, null);
  const text = JSON.stringify(info);
  assert.equal(/sk-|Bearer|api[_-]?key/i.test(text), false);
});
