/** 自动化运行报告与状态清单的失败关闭测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildManifest, validateManifest } from '../../../training/scripts/automation-state.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const REPORT = resolve(ROOT, 'training/scripts/automation-report.mjs');

function campaignState(overrides = {}) {
  return {
    schema: 'century-evolution-campaign-v1',
    campaignId: 'ai9-test-campaign',
    runFingerprint: 'a'.repeat(64),
    codeVersion: { headCommit: 'b'.repeat(40), codeDigest: 'c'.repeat(64), headDirty: false },
    config: {
      rounds: 1,
      budget: { maxCandidates: 8, maxGames: 100, maxWallMs: 600000, maxConcurrent: 1, maxDeepConfirmations: 2 },
      generation: { mode: 'multi-module', generator: 'bounded', strategies: ['pair'], targetIds: ['M02', 'M05'] },
    },
    status: 'completed',
    phase: 'completed',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:10:00.000Z',
    rounds: [{
      round: 1,
      seedWindows: {},
      screenSeeds: [1, 2],
      deepSeeds: [3, 4],
      candidates: [
        {
          candidateId: 'cand-a', stage: 'not-selected', generator: 'bounded', strategy: 'pair',
          quick: { metrics: { firstPlaceRate: 0.4, chanceAdjustedRate: 0.1, minWilsonLower: 0.2, anomalyRate: 0 } },
          failure: { stage: 'selection', reason: 'below-retention-cutoff' },
        },
        {
          candidateId: 'cand-b', stage: 'promotion-queued', generator: 'bounded', strategy: 'pair',
          quick: { metrics: { firstPlaceRate: 0.6, chanceAdjustedRate: 0.2, minWilsonLower: 0.3, anomalyRate: 0 } },
          deep: { status: 'done', metrics: { firstPlaceRate: 0.55, chanceAdjustedRate: 0.15, minWilsonLower: 0.25, anomalyRate: 0 } },
        },
      ],
    }],
    budgetUsed: { candidates: 2, games: 24, wallMs: 120000, deepConfirmations: 1 },
    promotionQueue: [{ requestId: 'req-1' }],
    promotionOutcomes: [{ requestId: 'req-1', outcome: { verdict: 'BLOCKED', reason: 'insufficient-statistical-power' } }],
    guardrails: { validationPoolConsumed: false, promotionTriggered: false, championMutation: 'none' },
    lastError: null,
    ...overrides,
  };
}

function writeCampaign(dir, state = campaignState()) {
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  writeFileSync(join(dir, 'run-summary.json'), JSON.stringify({ elapsedMs: 600000, startedAt: state.createdAt }, null, 2));
  writeFileSync(join(dir, 'logs', 'events.jsonl'), [
    JSON.stringify({ seq: 1, type: 'campaign-started', at: state.createdAt }),
    JSON.stringify({ seq: 2, type: 'campaign-completed', at: state.updatedAt }),
  ].join('\n') + '\n');
}

function runReport(dir, out, args = []) {
  return execFileSync(process.execPath, [REPORT, '--run-dir', dir, '--out', out, '--validate', ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
  });
}

test('有效 campaign：报告 PASS 并披露候选/晋级 BLOCKED/冠军身份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-report-'));
  const out = mkdtempSync(join(tmpdir(), 'century-report-out-'));
  try {
    writeCampaign(dir);
    const result = JSON.parse(runReport(dir, out, ['--mode', 'ai9-coevolve', '--min-candidates', '1', '--min-games', '1']));
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.promotionCandidate, false);
    assert.equal(result.candidates, 2);
    assert.equal(result.games, 24);
    const report = JSON.parse(readFileSync(join(out, 'run-report.json'), 'utf8'));
    assert.equal(report.schema, 'century-automation-run-report-v1');
    assert.equal(report.promotion.blocked, 1);
    assert.match(report.nextRun.note, /保留现任冠军|下一轮/);
    assert.equal(report.champion === null || typeof report.champion.id === 'string', true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('训练成功但没有任何产物：报告失败关闭', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-report-'));
  const out = mkdtempSync(join(tmpdir(), 'century-report-out-'));
  try {
    assert.throws(() => runReport(dir, out, ['--mode', 'ai9-coevolve']),
      error => error.status === 1 && /缺少 state\.json/.test(String(error.stderr ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('晋级队列非空但没有任何 promotionOutcome：静默丢失晋级请求 → 失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-report-'));
  const out = mkdtempSync(join(tmpdir(), 'century-report-out-'));
  try {
    writeCampaign(dir, campaignState({ promotionOutcomes: [] }));
    assert.throws(() => runReport(dir, out, ['--mode', 'ai9-coevolve', '--min-candidates', '1', '--min-games', '1']),
      error => error.status === 1 && /晋级请求/.test(String(error.stderr ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('晋级处理器失败（PUBLISH_FAILED）：训练运行不得标记成功', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-report-'));
  const out = mkdtempSync(join(tmpdir(), 'century-report-out-'));
  try {
    writeCampaign(dir, campaignState({
      promotionOutcomes: [{ requestId: 'req-1', outcome: { verdict: 'PUBLISH_FAILED', reason: 'gh pr create failed' } }],
    }));
    assert.throws(() => runReport(dir, out, ['--mode', 'ai9-coevolve', '--min-candidates', '1', '--min-games', '1']),
      error => error.status === 1 && /PUBLISH_FAILED/.test(String(error.stderr ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('开发池 campaign 若消费验证池或改动冠军：报告失败关闭', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-report-'));
  const out = mkdtempSync(join(tmpdir(), 'century-report-out-'));
  try {
    writeCampaign(dir, campaignState({
      guardrails: { validationPoolConsumed: true, promotionTriggered: false, championMutation: 'none' },
    }));
    assert.throws(() => runReport(dir, out, ['--mode', 'ai9-coevolve', '--min-candidates', '1', '--min-games', '1']),
      error => error.status === 1 && /验证池/.test(String(error.stderr ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('AI4 evolve 运行：有 report/state 视为有效，不冒充 AI9 证据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-report-'));
  const out = mkdtempSync(join(tmpdir(), 'century-report-out-'));
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ generation: 1, interrupted: false, seedCursor: 1000, rngCursor: 1 }, null, 2));
    writeFileSync(join(dir, 'report.json'), JSON.stringify({
      champion: 'joint-js5', generations: 1, history: [{}], improved: true, bestCandidateId: 'cand-ai4',
      population: 4, wallMs: 120000, seedAllocation: { seedCursorAfter: 1000 }, confirmation: null,
    }, null, 2));
    const stdout = runReport(dir, out, ['--mode', 'ai4-evolve']);
    assert.equal(JSON.parse(stdout).verdict, 'PASS');
    const report = JSON.parse(readFileSync(join(out, 'run-report.json'), 'utf8'));
    assert.equal(report.kind, 'evolve');
    assert.match(report.firstPlace.note, /不构成本轮 AI9 晋级证据/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('状态清单：校验哈希与路径穿越，拒绝重复/越界条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-state-'));
  try {
    writeFileSync(join(dir, 'a.json'), '{"ok":true}');
    const manifest = buildManifest({ branch: 'automation/state', files: ['a.json'], root: dir });
    assert.equal(manifest.files.length, 1);
    assert.equal(validateManifest(manifest), true);
    assert.throws(() => validateManifest({ ...manifest, schema: 'bad' }), /schema/);
    assert.throws(() => validateManifest({
      ...manifest, files: [...manifest.files, { ...manifest.files[0] }],
    }), /重复/);
    assert.throws(() => validateManifest({
      ...manifest, files: [{ ...manifest.files[0], path: '../secret.json' }],
    }), /不安全/);
    assert.throws(() => validateManifest({
      ...manifest, files: [{ ...manifest.files[0], sha256: 'not-a-hash' }],
    }), /sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
