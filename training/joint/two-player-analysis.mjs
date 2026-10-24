/** 双人模式 A/B 相关配对合并分析（AI6 第六阶段·任务 A1，探索性）。
 *
 * 背景：第五阶段 confirm 协议方向 A（候选 1 席）与方向 B（候选 N−1 席）
 * 分开披露。2 人局下 A 与 B 都只有"单候选 vs 单对手"一种语义（B 的
 * N−1=1 席），且同种子的 A/B 两局共享洗牌序列（相关样本）。统一多人
 * 协议只把方向 A 作为单席位主判定，忽略了方向 B 的有效信息。
 *
 * 本工具在不修改历史证据的前提下：
 * 1. 逐方向重算 2p 统计（与 confirm-analysis.txt 对照）；
 * 2. 种子级合并：每种子贡献 A/B 两局（同洗牌、座位互补）——合并候选
 *    第一名率是"座位均衡的单候选估计量"（每候选每种子在两个座位各 1 局），
 *    种子为聚类单位做配对 bootstrap CI；
 * 3. 同种子关联性：候选 A 胜 ↔ 候选 B 胜的 phi 系数（共享洗牌的耦合强度）；
 * 4. 对手分布平衡检查：A/B 方向的对手席位版本分布（versionsIds）是否均衡；
 * 5. 显著性标注为探索性（事后合并），不得当作预注册确认结论。
 *
 * 用法：node training/joint/two-player-analysis.mjs --out <dir>
 * 默认读取第五阶段 confirm 2p 数据（js5 vs js0，classic + diverse）。
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mulberry32 } from '../lib/rng.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const CONFIRM_DIR = resolve(REPO_ROOT, 'training/reports/js5-phase5/confirm');
const FILES = {
  'js5-classic': 'js5-classic/ablation-confirm-js5-2_3_4_5-200s.json',
  'js0-classic': 'js0-classic/ablation-confirm-js0-2_3_4_5-200s.json',
  'js5-diverse': 'js5-diverse/ablation-confirm-js5-2_3_4_5-200s-div.json',
  'js0-diverse': 'js0-diverse/ablation-confirm-js0-2_3_4_5-200s-div.json',
};

function loadGames(rel) {
  const doc = JSON.parse(readFileSync(resolve(CONFIRM_DIR, rel), 'utf8'));
  const cell = doc.cells.find(c => c.seatCount === 2);
  if (!cell) throw new Error(`${rel} 缺少 2p cell`);
  const games = cell.games.filter(g => g.status === 'finished');
  if (games.length !== cell.games.length) throw new Error(`${rel} 含异常局（拒绝静默过滤）`);
  return games;
}

/** seed → {A: {candWon, baseWon, candSeat, oppId, cd, bd}, B: {...}} */
function mergePair(candGames, baseGames) {
  const byKey = (games) => {
    const m = new Map();
    for (const g of games) m.set(`${g.seed}:${g.direction}`, g);
    return m;
  };
  const c = byKey(candGames), b = byKey(baseGames);
  const keys = [...c.keys()].sort();
  if (keys.length !== c.size || keys.length !== b.size) throw new Error('键数不一致');
  const seeds = new Map();
  for (const k of keys) {
    const base = b.get(k);
    if (!base) throw new Error(`配对缺失：${k}`);
    const [seedStr, direction] = k.split(':');
    const seed = Number(seedStr);
    const g = seeds.get(seed) ?? {};
    g[direction] = {
      candWon: c.get(k).won === true ? 1 : 0,
      baseWon: base.won === true ? 1 : 0,
      candSeats: c.get(k).candidateSeats,
      baseSeats: base.candidateSeats,
      oppId: oppOf(c.get(k)),
      cd: c.get(k).scoreDiff, bd: base.scoreDiff,
    };
    seeds.set(seed, g);
  }
  return seeds;
}

/** 非候选席位的对手版本 id（对手配置校验：排除候选席位）。 */
function oppOf(g) {
  const seats = new Set(g.candidateSeats ?? []);
  return (g.versionsIds ?? []).filter((_, i) => !seats.has(i)).join('|');
}

function bootstrapMerged(seeds, { iterations = 5000, rngSeed = 0x6a11e6 } = {}) {
  const list = [...seeds.entries()].map(([seed, g]) => ({ seed, ...g })).sort((a, b) => a.seed - b.seed);
  const n = list.length;
  const point = {
    candWins: list.reduce((s, x) => s + x.A.candWon + x.B.candWon, 0),
    baseWins: list.reduce((s, x) => s + x.A.baseWon + x.B.baseWon, 0),
    games: 2 * n,
  };
  point.candRate = point.candWins / point.games;
  point.baseRate = point.baseWins / point.games;
  point.diff = point.candRate - point.baseRate;
  const rng = mulberry32(rngSeed);
  const diffs = [];
  const scoreDiffs = [];
  for (let i = 0; i < iterations; i++) {
    let cw = 0, bw = 0, sd = 0, g = 0;
    for (let k = 0; k < n; k++) {
      const x = list[Math.floor(rng() * n)];
      for (const d of ['A', 'B']) { cw += x[d].candWon; bw += x[d].baseWon; sd += x[d].cd - x[d].bd; g++; }
    }
    diffs.push((cw - bw) / g);
    scoreDiffs.push(sd / g);
  }
  diffs.sort((a, b) => a - b);
  scoreDiffs.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.floor((arr.length - 1) * p)];
  return { ...point, diffCI: [Number(pct(diffs, 0.025).toFixed(4)), Number(pct(diffs, 0.975).toFixed(4))], scoreDiffCI: [Number(pct(scoreDiffs, 0.025).toFixed(4)), Number(pct(scoreDiffs, 0.975).toFixed(4))], iterations, clusterUnit: 'seed（每种子 A/B 两局相关样本）' };
}

/** 方向内配对统计（与 compare.mjs 同口径，交叉核对用）。 */
function directional(seeds, direction, { iterations = 5000, rngSeed = 0x6a11e7 } = {}) {
  const list = [...seeds.values()].map(g => g[direction]);
  const n = list.length;
  const candWins = list.reduce((s, x) => s + x.candWon, 0);
  const baseWins = list.reduce((s, x) => s + x.baseWon, 0);
  const rng = mulberry32(rngSeed);
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    let cw = 0, bw = 0;
    for (let k = 0; k < n; k++) { const x = list[Math.floor(rng() * n)]; cw += x.candWon; bw += x.baseWon; }
    diffs.push((cw - bw) / n);
  }
  diffs.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.floor((arr.length - 1) * p)];
  return {
    games: n, candRate: candWins / n, baseRate: baseWins / n,
    diff: candWins / n - baseWins / n,
    diffCI: [Number(pct(diffs, 0.025).toFixed(4)), Number(pct(diffs, 0.975).toFixed(4))],
  };
}

/** 同种子关联性：候选 A 胜与候选 B 胜的 phi 系数（共享洗牌耦合）。 */
function phiCoefficient(seeds) {
  let n00 = 0, n01 = 0, n10 = 0, n11 = 0;
  for (const g of seeds.values()) {
    const a = g.A.candWon, b = g.B.candWon;
    if (a === 0 && b === 0) n00++;
    else if (a === 0 && b === 1) n01++;
    else if (a === 1 && b === 0) n10++;
    else n11++;
  }
  const n = n00 + n01 + n10 + n11;
  const num = n11 * n00 - n10 * n01;
  const den = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
  return { phi: den > 0 ? Number((num / den).toFixed(4)) : null, contingency: { bothWin: n11, aOnly: n10, bOnly: n01, bothLose: n00 } };
}

/** 座位与对手分布平衡。 */
function balance(seeds) {
  const seatCount = {};
  const oppCount = {};
  for (const g of seeds.values()) {
    for (const d of ['A', 'B']) {
      const seatKey = g[d].candSeats.join('+');
      seatCount[seatKey] = (seatCount[seatKey] ?? 0) + 1;
      oppCount[g[d].oppId] = (oppCount[g[d].oppId] ?? 0) + 1;
    }
  }
  const total = Object.values(oppCount).reduce((s, x) => s + x, 0);
  const shares = Object.fromEntries(Object.entries(oppCount).map(([k, v]) => [k, Number((v / total).toFixed(4))]));
  const maxShare = Math.max(...Object.values(shares));
  const expected = 1 / Object.keys(oppCount).length;
  return {
    candidateSeatCoverage: seatCount,
    opponentShare: shares,
    opponentBalanceMaxShare: Number(maxShare.toFixed(4)),
    opponentExpectedShare: Number(expected.toFixed(4)),
    balanced: maxShare <= expected + 0.10, // 池轮换公式的结构性偏差容忍（(M-1)k mod M 缺一个席位）
  };
}

function analyze(poolLabel) {
  const seeds = mergePair(loadGames(FILES[`js5-${poolLabel}`]), loadGames(FILES[`js0-${poolLabel}`]));
  const result = {
    pool: poolLabel,
    seeds: seeds.size,
    directionA: directional(seeds, 'A'),
    directionB: directional(seeds, 'B'),
    merged: bootstrapMerged(seeds),
    withinSeedAssociation: phiCoefficient(seeds),
    balance: balance(seeds),
    caveat: 'A/B 合并是事后探索性统计（同种子共享洗牌的相关样本、种子聚类 bootstrap）——不得当作预注册确认结论',
  };
  return result;
}

const results = { schema: 'century-2p-merged-analysis-v1', date: new Date().toISOString(), classic: analyze('classic'), diverse: analyze('diverse') };

for (const pool of ['classic', 'diverse']) {
  const r = results[pool];
  console.log(`\n=== 2p ${pool}（${r.seeds} 种子 × A/B 双向）===`);
  const fmt = x => `${(x * 100).toFixed(1)}pp`;
  console.log(`方向A: 候选 ${(r.directionA.candRate * 100).toFixed(1)}% vs 基线 ${(r.directionA.baseRate * 100).toFixed(1)}%｜差 ${fmt(r.directionA.diff)} CI [${r.directionA.diffCI.map(v => (v * 100).toFixed(1)).join(',')}]`);
  console.log(`方向B: 候选 ${(r.directionB.candRate * 100).toFixed(1)}% vs 基线 ${(r.directionB.baseRate * 100).toFixed(1)}%｜差 ${fmt(r.directionB.diff)} CI [${r.directionB.diffCI.map(v => (v * 100).toFixed(1)).join(',')}]`);
  console.log(`A+B 合并（座位均衡单候选估计量）: 候选 ${(r.merged.candRate * 100).toFixed(1)}% vs 基线 ${(r.merged.baseRate * 100).toFixed(1)}%｜差 ${fmt(r.merged.diff)} CI [${r.merged.diffCI.map(v => (v * 100).toFixed(1)).join(',')}]｜分差 CI [${r.merged.scoreDiffCI.join(',')}]`);
  console.log(`同种子关联 phi=${r.withinSeedAssociation.phi}（${JSON.stringify(r.withinSeedAssociation.contingency)}）`);
  console.log(`对手平衡: max share ${(r.balance.opponentBalanceMaxShare * 100).toFixed(1)}% vs 期望 ${(r.balance.opponentExpectedShare * 100).toFixed(1)}%｜${r.balance.balanced ? '均衡' : '不平衡'}`);
}

const outDir = resolve(REPO_ROOT, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'training/reports/phase6-task-a');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'two-player-merged-analysis.json'), JSON.stringify(results, null, 2));
console.log(`\n结果已写入：${resolve(outDir, 'two-player-merged-analysis.json')}`);
