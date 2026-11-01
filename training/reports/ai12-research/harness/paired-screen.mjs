/**
 * AI12 研究用「配对第一名率」快筛器（开发池专用，不产生正式证据）。
 *
 * 设计（与正式挑战 first-place-challenge.mjs 同构，缩小到开发规模）：
 * - A 臂 = 候选（焦点席位），B 臂 = 冻结冠军 joint-js5（同一焦点席位）；
 * - 同一 seed、同一焦点席位、同一对手阵容（对手按 (seedIndex, seat) 轮换）；
 * - 主指标 = 焦点席位配对第一名率增量 delta ∈ {−1,0,+1}，按人数分层；
 * - 综合指标 = 2–5 人等权加权 delta（与冻结晋级口径一致）；
 * - 固定 workUnits（缺省 32）保证决策确定性，不依赖墙钟。
 *
 * 治理边界：
 * - 只允许开发池种子（AI7 [1.61e9,1.63e9) / AI9 [1.66e9,1.68e9) / 已登记的 AI12 研究窗口）；
 * - 绝不触碰正式验证池 [900M, 1.06e9)；
 * - 本工具不写 alpha 账本、不写正式证据，结果只能用于研究方向排序。
 *
 * 用法：
 *   node training/reports/ai12-research/harness/paired-screen.mjs \
 *     --a '{"gateMode":"never"}' --n 48 --seats 2,3,4,5 --seed-base 1735000000 --seed-stride 1000
 *   参数覆盖（候选参数乘子）：
 *     --pa '{"restWeight":1.6}'   （候选臂参数覆盖；缺省 = 冻结冠军参数）
 *     --pb '{"tempoWeight":1.2}'  （对照臂参数覆盖；缺省 = 冻结冠军参数）
 */
import { buildRegistry, toSeatVersion } from '../../../adversarial/registry.mjs';
import { playLeagueGame } from '../../../adversarial/league.mjs';
import { pathToFileURL } from 'node:url';

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

export function runPair({ seatCount, seed, seatIndex, overridesA, overridesB, paramsA, paramsB, workUnits }) {
  const focusSeat = seatIndex % seatCount;
  const build = (overrides, params) => Array.from({ length: seatCount }, (_, seat) => {
    if (seat === focusSeat) {
      return {
        ...toSeatVersion(registry.versions['js5-frozen-champion']),
        adapter: 'champion-guided',
        ...(params ? { parameters: { ...CHAMPION_PARAMS, ...params } } : {}),
        jointOptions: overrides,
      };
    }
    return toSeatVersion(registry.versions[OPPONENT_IDS[(seatIndex + seat) % OPPONENT_IDS.length]]);
  });
  const gameA = playLeagueGame({
    seed, seatCount, seatVersions: build(overridesA, paramsA),
    jointOverrides: { workUnits }, maxMoves: 1200, deadlineMs: 300_000,
  });
  const gameB = playLeagueGame({
    seed, seatCount, seatVersions: build(overridesB, paramsB),
    jointOverrides: { workUnits }, maxMoves: 1200, deadlineMs: 300_000,
  });
  if (gameA.status !== 'finished' || gameB.status !== 'finished') {
    return { anomaly: true, reason: gameA.reason ?? gameB.reason };
  }
  const fa = gameA.ranking.find(r => r.seat === focusSeat);
  const fb = gameB.ranking.find(r => r.seat === focusSeat);
  return {
    delta: (gameA.winnerSeat === focusSeat ? 1 : 0) - (gameB.winnerSeat === focusSeat ? 1 : 0),
    aFirst: gameA.winnerSeat === focusSeat ? 1 : 0,
    bFirst: gameB.winnerSeat === focusSeat ? 1 : 0,
    aScore: fa.score, bScore: fb.score, aGolems: fa.golems, bGolems: fb.golems,
  };
}

export function runScreen({ overridesA, overridesB, paramsA, paramsB, n, seats, seedBase, seedStride, workUnits }) {
  const byCount = {};
  let anomalies = 0;
  const started = Date.now();
  for (const seatCount of seats) {
    const deltas = [];
    const scores = { a: [], b: [] };
    const golems = { a: [], b: [] };
    for (let i = 0; i < n; i++) {
      const seed = seedBase + seatCount * seedStride + i;
      const r = runPair({ seatCount, seed, seatIndex: i, overridesA, overridesB, paramsA, paramsB, workUnits });
      if (r.anomaly) { anomalies++; continue; }
      deltas.push(r.delta);
      scores.a.push(r.aScore); scores.b.push(r.bScore);
      golems.a.push(r.aGolems); golems.b.push(r.bGolems);
    }
    const mean = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0);
    byCount[seatCount] = {
      ...stats(deltas),
      meanScoreA: mean(scores.a), meanScoreB: mean(scores.b),
      meanGolemsA: mean(golems.a), meanGolemsB: mean(golems.b),
      seedFirst: seedBase + seatCount * seedStride, seedLast: seedBase + seatCount * seedStride + n - 1,
    };
  }
  const weighted = seats.length
    ? seats.map(c => byCount[c].mean).reduce((a, b) => a + b, 0) / seats.length
    : 0;
  return {
    schema: 'century-ai12-paired-screen-v1',
    kind: 'development-screen (NOT formal evidence)',
    overridesA, overridesB, paramsA: paramsA ?? null, paramsB: paramsB ?? null,
    n, seats, seedBase, seedStride, workUnits,
    weighted, byCount, anomalies, wallMinutes: +((Date.now() - started) / 60000).toFixed(1),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const n = Number(args.n ?? 24);
  const seats = String(args.seats ?? '2,3,4,5').split(',').map(Number);
  const seedBase = Number(args['seed-base'] ?? 1735000000);
  const seedStride = Number(args['seed-stride'] ?? 1000);
  const workUnits = Number(args.wu ?? 32);
  const overridesA = JSON.parse(args.a ?? '{}');
  const overridesB = JSON.parse(args.b ?? '{}');
  const paramsA = args.pa ? JSON.parse(args.pa) : null;
  const paramsB = args.pb ? JSON.parse(args.pb) : null;
  const result = runScreen({ overridesA, overridesB, paramsA, paramsB, n, seats, seedBase, seedStride, workUnits });
  for (const c of seats) {
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
