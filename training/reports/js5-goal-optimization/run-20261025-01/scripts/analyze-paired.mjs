/** 双报告种子级配对分析（主指标：方向 A 单席第一名）。
 *
 * 用法：
 *   node .../scripts/analyze-paired.mjs --baseline <a.json> --candidate <b.json> [--direction A] [--out <file>]
 * 也支持一次给多个 candidate：--candidate a.json --candidate b.json ...
 *
 * 统计纪律：
 * - 独立单位 = 完整种子（同一 seed 的 A/B 方向/多席不拆开当独立样本）；
 * - 本脚本主指标只用方向 A：d_i = 1[候选胜] - 1[基线胜]；
 * - 区间：种子级 bootstrap 10,000 次（百分位法），另报符号检验/精确二项供参考；
 * - 不把"区间跨 0"解释为"已证明无差异"。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');

const args = process.argv.slice(2);
const list = [];
let baselinePath = null;
let direction = 'A';
let outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline') baselinePath = args[++i];
  else if (args[i] === '--candidate') list.push(args[++i]);
  else if (args[i] === '--direction') direction = args[++i];
  else if (args[i] === '--out') outPath = resolve(args[++i]);
}
if (!baselinePath || !list.length) throw new Error('需要 --baseline 与至少一个 --candidate');

const load = p => JSON.parse(readFileSync(resolve(p), 'utf8'));
const cellOf = (report, players) => {
  const cell = report.cells.find(c => c.seatCount === players);
  if (!cell) throw new Error(`报告缺少 ${players} 人 cell`);
  return cell;
};
const gamesOf = (cell, dir) => new Map((cell.games ?? []).filter(g => g.direction === dir && g.status === 'finished').map(g => [g.seed, g]));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCI(values, reps = 10000) {
  const rng = mulberry32(0x5EED5EED);
  const n = values.length;
  const means = new Float64Array(reps);
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rng() * n)];
    means[r] = s / n;
  }
  means.sort();
  const q = p => means[Math.min(reps - 1, Math.floor(reps * p))];
  return { lower: q(0.025), upper: q(0.975), reps };
}

function exactBinomialTwoSided(wins, losses) {
  const n = wins + losses;
  if (!n) return 1;
  const k = Math.min(wins, losses);
  const logC = (n, k) => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
    return s;
  };
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logC(n, i) - n * Math.log(2));
  return Math.min(1, 2 * tail);
}

const baseline = load(baselinePath);
const playerCount = Number(process.env.PLAYERS ?? 5);
const baseCell = cellOf(baseline, playerCount);
const baseGames = gamesOf(baseCell, direction);
const results = [];

for (const candidatePath of list) {
  const candidate = load(candidatePath);
  const candCell = cellOf(candidate, playerCount);
  const candGames = gamesOf(candCell, direction);
  const seeds = [...baseGames.keys()].filter(s => candGames.has(s)).sort((a, b) => a - b);
  const d = [];
  const baseWins = [];
  const candWins = [];
  const baseScoreDiff = [];
  const candScoreDiff = [];
  const seats = [];
  const baseRollouts = [];
  const candRollouts = [];
  const baseLatency = [];
  const candLatency = [];
  for (const seed of seeds) {
    const a = baseGames.get(seed);
    const b = candGames.get(seed);
    if (JSON.stringify(a.candidateSeats) !== JSON.stringify(b.candidateSeats)) {
      throw new Error(`seed ${seed} 候选席位不一致：${a.candidateSeats} vs ${b.candidateSeats}`);
    }
    baseWins.push(a.won ? 1 : 0);
    candWins.push(b.won ? 1 : 0);
    d.push((b.won ? 1 : 0) - (a.won ? 1 : 0));
    baseScoreDiff.push(a.scoreDiff ?? 0);
    candScoreDiff.push(b.scoreDiff ?? 0);
    seats.push(a.candidateSeats.join('+'));
  }
  const mean = arr => arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length);
  const wins = d.filter(x => x > 0).length;
  const losses = d.filter(x => x < 0).length;
  const ties = d.filter(x => x === 0).length;
  const ci = bootstrapCI(d);
  const pDisc = (wins + losses) / Math.max(1, d.length);
  const nFor = effect => Math.ceil(7.85 * Math.max(0.01, pDisc) / (effect * effect));
  results.push({
    candidate: candidatePath,
    baseline: baselinePath,
    players: playerCount,
    direction,
    seeds: seeds.length,
    firstPlace: {
      baselineRate: mean(baseWins),
      candidateRate: mean(candWins),
      pointDiff: mean(d),
      bootstrap95: [ci.lower, ci.upper],
      wins, losses, ties,
      discordance: pDisc,
      exactMcNemarP: exactBinomialTwoSided(wins, losses),
      nFor8pp: nFor(0.08),
      nFor5pp: nFor(0.05),
      nFor3pp: nFor(0.03),
    },
    auxiliary: {
      baselineMeanScoreDiff: mean(baseScoreDiff),
      candidateMeanScoreDiff: mean(candScoreDiff),
      scoreDiffDelta: mean(candScoreDiff.map((x, i) => x - baseScoreDiff[i])),
      baselineAnomalies: baseCell.anomalies,
      candidateAnomalies: candCell.anomalies,
      baselineJoint: baseCell.jointSearch ?? null,
      candidateJoint: candCell.jointSearch ?? null,
      baselineLatency: baseCell.latency ?? null,
      candidateLatency: candCell.latency ?? null,
    },
    bySeat: [...new Set(seats)].sort().map(seat => {
      const idx = seats.map((s, i) => s === seat ? i : -1).filter(i => i >= 0);
      if (!idx.length) return null;
      return {
        seat,
        n: idx.length,
        baseWins: idx.reduce((s, i) => s + baseWins[i], 0),
        candWins: idx.reduce((s, i) => s + candWins[i], 0),
        pointDiff: idx.reduce((s, i) => s + d[i], 0) / idx.length,
      };
    }).filter(Boolean),
  });
}

const out = {
  schema: 'js5-goal-paired-analysis-v1',
  generatedAt: new Date().toISOString(),
  baselineReport: baselinePath,
  candidateReports: list,
  results,
};
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
process.stdout.write(JSON.stringify(results.map(r => ({
  candidate: r.candidate,
  seeds: r.seeds,
  baselineRate: r.firstPlace.baselineRate,
  candidateRate: r.firstPlace.candidateRate,
  pointDiff: r.firstPlace.pointDiff,
  ci95: r.firstPlace.bootstrap95,
  wins: r.firstPlace.wins, losses: r.firstPlace.losses, ties: r.firstPlace.ties,
  discordance: r.firstPlace.discordance,
  exactP: r.firstPlace.exactMcNemarP,
  nFor8pp: r.firstPlace.nFor8pp,
  scoreDiffDelta: r.auxiliary.scoreDiffDelta,
})), null, 2));
