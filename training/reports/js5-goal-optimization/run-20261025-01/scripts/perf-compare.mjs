/** 修改前/后性能对照（100ms 墙钟；同一公开局面、同一硬件、单进程、随机交错）。
 *
 * 用法：
 *   node .../scripts/perf-compare.mjs \
 *     --baseline /tmp/century-js5-baseline-e2361ed/web-v1/dist/js \
 *     --candidate "web-v1/dist/js" \
 *     --positions 1000 --repeats 3 --budget 100
 *
 * 纪律：
 * - 性能局面由 goal-perf 种子块生成，固定工作量快速推进；不用于胜率结论；
 * - 预热后测量；每个局面每版本重复 3 次；版本顺序逐局面随机交错；
 * - 记录端到端耗时、rollouts/transitions、零试验原因、非法回退；
 * - 只比较同一进程、同一局面集；不把并行负载下的数字当部署分布。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

import { AI6_JS5_GOAL_PERF_SUBBLOCK } from '../../../../../ai5/lib/seed_policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');
const REPO = resolve(RUN, '../../../..');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const baselineDist = resolve(getArg('--baseline', '/tmp/century-js5-baseline-e2361ed/web-v1/dist/js'));
const candidateDist = resolve(REPO, getArg('--candidate', 'web-v1/dist/js'));
const targetPositions = Number(getArg('--positions', '1000'));
const repeats = Number(getArg('--repeats', '3'));
const budgetMs = Number(getArg('--budget', '100'));

const baseEngine = await import(pathToFileURL(join(baselineDist, 'engine.js')).href);
const baseAi = await import(pathToFileURL(join(baselineDist, 'ai.js')).href);
const baseAdapter = await import(pathToFileURL(join(baselineDist, 'js/adapter.js')).href);
const candEngine = await import(pathToFileURL(join(candidateDist, 'engine.js')).href);
const candAi = await import(pathToFileURL(join(candidateDist, 'ai.js')).href);
const candAdapter = await import(pathToFileURL(join(candidateDist, 'js/adapter.js')).href);

const CANDIDATE_OPTIONS = { nearTerminalCandidate: 'replace', screenGoalScope: 'preferred', batchAdmission: 'balanced' };
const BASE_OPTIONS = {};
const LEGACY = JSON.parse(readFileSync(join(REPO, 'web-v1/tests/fixtures/legacy-champion.json'), 'utf8'));

/** 固定工作量快速推进，采集覆盖开局/中局/后期/终局/溢出的公开 Game。 */
function collectPositions(count) {
  const picks = { opening: [], mid: [], late: [], endgame: [], overflow: [] };
  const caps = { opening: 100, mid: 450, late: 350, endgame: 100, overflow: 60 };
  let seed = AI6_JS5_GOAL_PERF_SUBBLOCK[0];
  let games = 0;
  while (Object.keys(picks).reduce((s, k) => s + picks[k].length, 0) < count && seed < AI6_JS5_GOAL_PERF_SUBBLOCK[1] && games < 120) {
    let g = baseEngine.createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    for (const p of g.players) p.isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 1200) {
      const phase = g.phase;
      const maxClaimed = Math.max(...g.players.map(p => p.claimed.length));
      const key = phase === 'overflow' ? 'overflow'
        : g.triggerPlayer !== null ? 'endgame'
        : g.turnNumber <= 15 ? 'opening'
        : (maxClaimed >= 3 || g.turnNumber > 110) ? 'late'
        : 'mid';
      if (picks[key].length < caps[key]) picks[key].push(JSON.parse(JSON.stringify(g)));
      let r;
      try {
        // 生成局面用廉价束搜索（不是被测对象）；决策分布由公开状态决定。
        r = baseAi.chooseAIAction(g, { parameters: LEGACY, profile: baseAi.NEUTRAL_PROFILE });
      } catch {
        break;
      }
      try { g = baseEngine.applyAction(g, r.action); } catch { break; }
      moves += 1;
    }
    games += 1;
    seed += 1;
  }
  // 按类别配额截断并交错，避免阶段聚集。
  const buckets = Object.values(picks).map(arr => arr.slice(0, Math.ceil(targetPositions * arr.length / Math.max(1, Object.values(picks).reduce((s, a) => s + a.length, 0)))));
  const combined = [];
  const maxLen = Math.max(...buckets.map(b => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of buckets) if (b[i]) combined.push({ phase: Object.keys(picks)[buckets.indexOf(b)], game: b[i] });
  return combined.slice(0, targetPositions);
}

function runDecision(mod, ai, game, options) {
  const g = JSON.parse(JSON.stringify(game));
  const current = g.current;
  const t0 = performance.now();
  let result;
  try {
    result = mod.chooseJointAction(g, {
      version: 'joint-js5', budgetMs, worlds: 4, horizon: 48, simSeed: 0,
      profile: ai.NEUTRAL_PROFILE, ...options,
    });
  } catch (error) {
    return { ms: performance.now() - t0, error: error.message, fallback: true };
  }
  const ms = performance.now() - t0;
  let illegal = false;
  try { baseEngine.applyAction(JSON.parse(JSON.stringify(game)), result.action); } catch { illegal = true; }
  return {
    ms, action: result.action, illegal,
    fallback: /非法|缺陷暴露/.test(result.reason ?? ''),
    stats: result.joint?.stats ?? null,
    gated: result.joint?.gated ?? null,
    championAction: result.joint?.championAction ?? null,
  };
}

const positions = collectPositions(targetPositions);
process.stdout.write(`positions=${positions.length}（目标 ${targetPositions}）\n`);
if (positions.length < targetPositions) process.stdout.write('警告：局面数不足，报告按实际样本披露\n');

// 预热（不记录）。
for (const p of positions.slice(0, Math.min(12, positions.length))) {
  runDecision(baseAdapter, baseAi, p.game, BASE_OPTIONS);
  runDecision(candAdapter, candAi, p.game, CANDIDATE_OPTIONS);
}

let rngState = 0x9E3779B9;
function rng() {
  rngState = (rngState + 0x6D2B79F5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const rows = [];
for (let rep = 0; rep < repeats; rep++) {
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const order = rng() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const version of order) {
      const r = version === 'baseline'
        ? runDecision(baseAdapter, baseAi, p.game, BASE_OPTIONS)
        : runDecision(candAdapter, candAi, p.game, CANDIDATE_OPTIONS);
      rows.push({ rep, index: i, phase: p.phase, version, ...r });
    }
  }
}

const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
function summarize(version) {
  const rs = rows.filter(r => r.version === version && !r.error);
  const ms = rs.map(r => r.ms).sort((a, b) => a - b);
  const byPhase = {};
  for (const phase of [...new Set(rs.map(r => r.phase))]) {
    const arr = rs.filter(r => r.phase === phase).map(r => r.ms).sort((a, b) => a - b);
    byPhase[phase] = { n: arr.length, p50: percentile(arr, .5), p95: percentile(arr, .95), p99: percentile(arr, .99), max: arr.at(-1) };
  }
  return {
    n: rs.length,
    errors: rows.filter(r => r.version === version && r.error).length,
    illegal: rs.filter(r => r.illegal).length,
    fallbacks: rs.filter(r => r.fallback).length,
    elapsed: { min: ms[0], p50: percentile(ms, .5), p95: percentile(ms, .95), p99: percentile(ms, .99), max: ms.at(-1), mean: ms.reduce((s, x) => s + x, 0) / ms.length },
    overBudget: rs.filter(r => r.ms > budgetMs).length,
    zeroTrials: rs.filter(r => (r.stats?.rollouts ?? 0) === 0).length,
    zeroTrialReasons: rs.reduce((acc, r) => { const k = r.stats?.zeroTrialReason ?? 'baseline-untracked'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    meanRollouts: rs.reduce((s, r) => s + (r.stats?.rollouts ?? 0), 0) / rs.length,
    perPhase: byPhase,
  };
}

const out = {
  schema: 'js5-goal-perf-compare-v1',
  generatedAt: new Date().toISOString(),
  baselineDist, candidateDist,
  budgetMs, repeats, positions: positions.length,
  loadavgAtStart: os.loadavg(), cpuCount: os.cpus().length,
  candidateOptions: CANDIDATE_OPTIONS,
  seedBlock: AI6_JS5_GOAL_PERF_SUBBLOCK,
  summary: { baseline: summarize('baseline'), candidate: summarize('candidate') },
  rows: rows.map(r => ({ rep: r.rep, index: r.index, phase: r.phase, version: r.version, ms: r.ms, rollouts: r.stats?.rollouts ?? 0, worlds: r.stats?.worldsUsed ?? null, zeroReason: r.stats?.zeroTrialReason ?? null, overBudget: r.stats?.overBudget ?? null, illegal: r.illegal, fallback: r.fallback })),
};
writeFileSync(join(RUN, 'evidence', 'perf-compare.json'), JSON.stringify(out, null, 2) + '\n');
process.stdout.write(JSON.stringify(out.summary, null, 2) + '\n');
