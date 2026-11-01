/**
 * AI12 研究用「正式结构」配对快筛器（开发池；不产生正式证据）。
 *
 * 与 paired-screen.mjs 的差别（重要）：
 * - 本文件复用正式挑战 first-place-challenge.mjs 的座位接线
 *   （toSeatVersion / opponentForSeat / focusSeatFor）与 simulateGame；
 * - 因此 AI 信念采样流按 simulate.mjs 的 deriveSimStreamSeed(seed) 派生，
 *   与正式挑战逐位一致；旧 harness 经 playLeagueGame 固定 simSeed=0，
 *   会让每局的隐藏补牌世界完全相同（研究保真度不足）。
 * - 默认 workUnits=64（正式挑战口径），可显式降档以加速。
 *
 * 用法：
 *   node ... --a '{"overrideMargin":0.05}' --n 48 --seats 2,3,4,5 \
 *     --seed-base 1736000000 --seed-stride 1000 --out /tmp/out.json
 *   编译型候选：
 *   node ... --artifact <candidate.json> --pa '{}' --n 48 ...
 *
 * 治理：只允许开发池种子；不写 alpha/正式证据。
 */
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildRegistry } from '../../../adversarial/registry.mjs';
import { simulateGame } from '../../../simulator/simulate.mjs';
import { toSeatVersion, opponentForSeat, focusSeatFor } from '../../../tournament/first-place-challenge.mjs';
import { loadCompiledCandidateModules } from '../../../evolution/multi-module-candidate.mjs';

const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const registry = buildRegistry();
const CHAMPION_PARAMS = registry.versions['js5-frozen-champion'].parameters;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function stats(values) {
  const n = values.length;
  if (!n) return { n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n);
  const df = Math.max(1, n - 1);
  const t = df >= 120 ? 1.645 : (df >= 60 ? 1.671 : (df >= 30 ? 1.697 : 1.72));
  return { n, mean, lo: mean - t * se, hi: mean + t * se, sd: Math.sqrt(variance) };
}

function armVersion({ overrides, params, workUnits, seatCount, executor }) {
  const descriptor = { ...CHAMPION_PARAMS, ...(params ?? {}) };
  const version = toSeatVersion(descriptor, { seatCount, workUnits });
  if (overrides && Object.keys(overrides).length) {
    version.jointOptions = { ...(version.jointOptions ?? {}), ...overrides };
  }
  if (executor) {
    version.aiModule = executor.aiModule;
    version.jointModule = executor.jointModule;
  }
  return version;
}

export async function runFormalScreen({ overridesA, overridesB, paramsA, paramsB, n, seats, seedBase, seedStride, workUnits, artifactPath, maxMoves = 1200, deadlineMs = 300_000 }) {
  let executorA = null;
  if (artifactPath) {
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    const loaded = await loadCompiledCandidateModules(artifact);
    executorA = { aiModule: loaded.aiModule, jointModule: loaded.jointModule };
  }
  const byCount = {};
  let anomalies = 0;
  const started = Date.now();
  const play = (versions, seatCount, seed) => simulateGame({ seed, versions, seatCount, maxMoves, deadlineMs });
  for (const seatCount of seats) {
    const deltas = [];
    const scores = { a: [], b: [] };
    const golems = { a: [], b: [] };
    for (let i = 0; i < n; i++) {
      const seed = seedBase + seatCount * seedStride + i;
      const focusSeat = focusSeatFor({ seedIndex: i, seatCount });
      const vA = armVersion({ overrides: overridesA, params: paramsA, workUnits, seatCount, executor: executorA });
      const vB = armVersion({ overrides: overridesB, params: paramsB, workUnits, seatCount, executor: null });
      const baseVersions = Array.from({ length: seatCount }, (_, seat) => (seat === focusSeat
        ? null
        : toSeatVersion(registry.versions[opponentForSeat({ seedIndex: i, seat, opponents: OPPONENT_IDS })].parameters, { seatCount, workUnits })));
      const rA = play(baseVersions.map(v => (v === null ? vA : v)), seatCount, seed);
      const rB = play(baseVersions.map(v => (v === null ? vB : v)), seatCount, seed);
      if (rA.status !== 'finished' || rB.status !== 'finished') { anomalies++; continue; }
      deltas.push((rA.ranking[0]?.seat === focusSeat ? 1 : 0) - (rB.ranking[0]?.seat === focusSeat ? 1 : 0));
      scores.a.push(rA.ranking.find(r => r.seat === focusSeat).score);
      scores.b.push(rB.ranking.find(r => r.seat === focusSeat).score);
      golems.a.push(rA.ranking.find(r => r.seat === focusSeat).golems);
      golems.b.push(rB.ranking.find(r => r.seat === focusSeat).golems);
    }
    const mean = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0);
    byCount[seatCount] = {
      ...stats(deltas),
      meanScoreA: mean(scores.a), meanScoreB: mean(scores.b),
      meanGolemsA: mean(golems.a), meanGolemsB: mean(golems.b),
      seedFirst: seedBase + seatCount * seedStride, seedLast: seedBase + seatCount * seedStride + n - 1,
    };
  }
  const weighted = seats.map(c => byCount[c].mean).reduce((a, b) => a + b, 0) / seats.length;
  return {
    schema: 'century-ai12-paired-screen-formal-v1',
    kind: 'development-screen (NOT formal evidence)',
    overridesA, overridesB, paramsA: paramsA ?? null, paramsB: paramsB ?? null,
    artifactPath: artifactPath ?? null,
    n, seats, seedBase, seedStride, workUnits, weighted, byCount, anomalies,
    wallMinutes: +((Date.now() - started) / 60000).toFixed(1),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runFormalScreen({
    overridesA: JSON.parse(args.a ?? '{}'),
    overridesB: JSON.parse(args.b ?? '{}'),
    paramsA: args.pa ? JSON.parse(args.pa) : null,
    paramsB: args.pb ? JSON.parse(args.pb) : null,
    n: Number(args.n ?? 24),
    seats: String(args.seats ?? '2,3,4,5').split(',').map(Number),
    seedBase: Number(args['seed-base'] ?? 1736000000),
    seedStride: Number(args['seed-stride'] ?? 1000),
    workUnits: Number(args.wu ?? 64),
    artifactPath: args.artifact ?? null,
  });
  for (const c of result.seats) {
    const r = result.byCount[c];
    console.log(`${c}p n=${r.n} delta=${(r.mean * 100).toFixed(2)}pp CI[${(r.lo * 100).toFixed(2)},${(r.hi * 100).toFixed(2)}] sd=${(r.sd * 100).toFixed(1)}pp 分A=${r.meanScoreA.toFixed(1)} 分B=${r.meanScoreB.toFixed(1)} 魔像A=${r.meanGolemsA.toFixed(2)} 魔像B=${r.meanGolemsB.toFixed(2)}`);
  }
  console.log(`WEIGHTED=${(result.weighted * 100).toFixed(2)}pp anomalies=${result.anomalies} wall=${result.wallMinutes}min`);
  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.log(`已写出：${args.out}`);
  }
}
