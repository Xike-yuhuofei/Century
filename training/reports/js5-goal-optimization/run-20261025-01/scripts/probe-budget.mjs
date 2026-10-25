/** C04/C09/C12 预算有效性诊断（100ms 墙钟 + 固定工作量对照）。
 *
 * 用法：node .../scripts/probe-budget.mjs [--repeats 10] [--budget 100] [--label current] [--dist ../dist]
 * 输出：evidence/budget-<label>.json
 *
 * 每次决策前深拷贝 fixture；同进程顺序运行，记录端到端耗时与分相统计。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');
const REPO = resolve(RUN, '../../../..');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const repeats = Number(getArg('--repeats', '10'));
const budgetMs = Number(getArg('--budget', '100'));
const label = getArg('--label', 'current');
const screenScope = getArg('--screen-scope', 'all');
const nearTerminal = getArg('--near-terminal', 'off');
const batchAdmission = getArg('--batch-admission', 'legacy');
const distRoot = resolve(REPO, getArg('--dist', 'web-v1/dist/js'));

const { chooseJointAction } = await import(pathToFileURL(join(distRoot, 'js/adapter.js')).href);
const { NEUTRAL_PROFILE } = await import(pathToFileURL(join(distRoot, 'ai.js')).href);

const FIXTURES = [
  { id: 'C04', file: 'js5-budget-c04.json', note: '可付 3 目标时休息；100ms 曾零试验' },
  { id: 'C09', file: 'js5-budget-c09.json', note: '0 vs 16 rollout 动作翻转（agent-a）' },
  { id: 'C12', file: 'js5-budget-c12.json', note: '固定工作可仲裁，100ms 曾零试验' },
];

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const summarize = values => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, min: s[0], p50: percentile(s, 0.5), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: s.at(-1), mean: Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(3)) };
};

const rows = [];
for (const fixture of FIXTURES) {
  const base = load(fixture.file);
  for (let r = 0; r < repeats; r++) {
    const game = clone(base);
    const t0 = performance.now();
    const result = chooseJointAction(game, {
      version: 'joint-js5', budgetMs, worlds: 4, horizon: 48, simSeed: 0,
      gateMode: 'always', profile: NEUTRAL_PROFILE,
      ...(screenScope !== 'all' ? { screenGoalScope: screenScope } : {}),
      ...(nearTerminal !== 'off' ? { nearTerminalCandidate: nearTerminal } : {}),
      ...(batchAdmission !== 'legacy' ? { batchAdmission } : {}),
    });
    const totalMs = performance.now() - t0;
    rows.push({
      kind: 'wall-clock', fixture: fixture.id, repeat: r, totalMs,
      action: result.action, championAction: result.joint?.championAction ?? null,
      stats: result.joint?.stats ?? null,
      configHash: result.config?.hash ?? null,
      candidateSources: result.joint?.stats?.nearTerminal?.candidateSources ?? null,
    });
  }
  // 固定工作量对照（确定性；同一 fixture 两次决策一致）。
  for (const workUnits of [32, 64]) {
    const a = clone(base), b = clone(base);
    const ra = chooseJointAction(a, { version: 'joint-js5', workUnits, worlds: 4, horizon: 48, simSeed: 0, gateMode: 'always', profile: NEUTRAL_PROFILE, ...(screenScope !== 'all' ? { screenGoalScope: screenScope } : {}) });
    const rb = chooseJointAction(b, { version: 'joint-js5', workUnits, worlds: 4, horizon: 48, simSeed: 0, gateMode: 'always', profile: NEUTRAL_PROFILE, ...(screenScope !== 'all' ? { screenGoalScope: screenScope } : {}) });
    rows.push({
      kind: 'fixed-work', fixture: fixture.id, workUnits,
      action: ra.action, championAction: ra.joint?.championAction ?? null,
      deterministic: JSON.stringify(ra.action) === JSON.stringify(rb.action),
      stats: ra.joint?.stats ?? null,
      trials: ra.joint?.trials ?? null,
    });
  }
}

const byFixture = {};
for (const fixture of FIXTURES) {
  const wall = rows.filter(r => r.kind === 'wall-clock' && r.fixture === fixture.id);
  const fixed = rows.filter(r => r.kind === 'fixed-work' && r.fixture === fixture.id);
  byFixture[fixture.id] = {
    note: fixture.note,
    wallClock: {
      repeats: wall.length,
      elapsed: summarize(wall.map(r => r.totalMs)),
      overBudget: wall.filter(r => r.totalMs > budgetMs).length,
      zeroTrials: wall.filter(r => (r.stats?.rollouts ?? 0) === 0).length,
      budgetExhaustedFlagged: wall.filter(r => r.stats?.budgetExhausted === true).length,
      zeroTrialReasons: wall.reduce((acc, r) => { const k = r.stats?.zeroTrialReason ?? 'none'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
      meanRollouts: Number((wall.reduce((s, r) => s + (r.stats?.rollouts ?? 0), 0) / wall.length).toFixed(2)),
      phaseMedians: {
        planMs: summarize(wall.map(r => r.stats?.planMs ?? 0)).p50,
        rootSimMs: summarize(wall.map(r => r.stats?.rootSimMs ?? 0)).p50,
        legalGenMs: summarize(wall.map(r => r.stats?.legalGenMs ?? 0)).p50,
        gateMs: summarize(wall.map(r => r.stats?.gateMs ?? 0)).p50,
        screenMs: summarize(wall.map(r => r.stats?.screenMs ?? 0)).p50,
        rolloutMs: summarize(wall.map(r => r.stats?.rolloutMs ?? 0)).p50,
      },
      trialWindowP50: summarize(wall.map(r => r.stats?.trialWindowMs ?? 0)).p50,
      accountingCheck: wall.map(r => ({ elapsed: Number(r.totalMs.toFixed(3)), sum: Number((r.stats?.accountingMs ?? 0).toFixed(3)), unaccounted: Number((r.stats?.unaccountedMs ?? 0).toFixed(3)) })),
      actions: wall.map(r => ({ action: r.action, champion: r.championAction, trials: r.stats?.rollouts, worlds: r.stats?.worldsUsed, batches: r.stats?.batchesStarted, zeroReason: r.stats?.zeroTrialReason })),
    },
    fixedWork: fixed.map(r => ({ workUnits: r.workUnits, action: r.action, champion: r.championAction, deterministic: r.deterministic, rollouts: r.stats?.rollouts, worlds: r.stats?.worldsUsed, candidateCount: r.stats?.candidateCount, trialsPerCandidate: r.trials ? Object.values(r.trials.reduce((acc, t) => { acc[t.actionIndex] = (acc[t.actionIndex] ?? 0) + 1; return acc; }, {})) : null })),
  };
}

const out = {
  schema: 'js5-goal-budget-probe-v1',
  label, budgetMs, repeats, screenScope, nearTerminal, batchAdmission, distRoot,
  fixtures: byFixture,
  raw: rows,
  summary: Object.fromEntries(Object.entries(byFixture).map(([k, v]) => [k, {
    elapsed: v.wallClock.elapsed, zeroTrials: v.wallClock.zeroTrials, budgetExhaustedFlagged: v.wallClock.budgetExhaustedFlagged,
    meanRollouts: v.wallClock.meanRollouts, zeroTrialReasons: v.wallClock.zeroTrialReasons,
    fixedWork: v.fixedWork.map(x => ({ workUnits: x.workUnits, rollouts: x.rollouts, deterministic: x.deterministic, action: x.action })),
  }])),
};
writeFileSync(join(RUN, 'evidence', `budget-${label}.json`), JSON.stringify(out, null, 2) + '\n');
process.stdout.write(JSON.stringify(out.summary, null, 2) + '\n');

function load(file) {
  return JSON.parse(readFileSync(join(REPO, 'web-v1/tests/fixtures', file), 'utf8')).game;
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
