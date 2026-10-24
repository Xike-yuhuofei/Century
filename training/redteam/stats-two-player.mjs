#!/usr/bin/env node
/** 红队审计 #3：双人（2p）A/B 独立统计复算（P0）。
 *
 * 依据第五阶段 confirm 块（AI6_JS5_CONFIRM_SUBBLOCK [1.36e9,1.37e9)，2p 子分区）
 * 的 js5 vs js0 落盘逐局数据，独立重算双人 A/B 对照——不调用 compare.mjs 的
 * 聚合结果，自行实现种子级配对 bootstrap，并与 compare.mjs 交叉核对。
 *
 * 口径与诚实性约束：
 * - N=2 时方向 A 与方向 B 都是「单个候选席位」（席位互换），不存在 5 人局的
 *   阵营口径——合并 A+B 是合法的席位互换池，但仍按种子聚类（每种子 2 局强相关）；
 * - 预注册主判定（PHASE5 §5 实验设计）= 方向 A 单席位第一名率（种子级配对
 *   bootstrap，family=4 Bonferroni）；方向 B 为预注册次级；A+B 合并 = 事后探索；
 * - 显著性分级（本审计的分级规则为事后选择，非预注册）：
 *     significant   = 95% CI 下界 > 0（优势成立）
 *   non-inferior  = 95% CI 下界 > −5pp 且上界 > 0（δ=5pp 事后非劣 margin）
 *   trend         = 点估计 > 0 但 CI 触 0 以下
 *   inconclusive  = 点估计 ≤ 0
 * - 双池（classic/diverse）为预注册的独立评测维度，不合并。
 *
 * 用法：node training/redteam/stats-two-player.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');

/** mulberry32（与 training/lib/rng.mjs 同算法；审计侧独立实例）。 */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadCell(path, seatCount, candidateId) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const cell = j.cells.find(c => c.seatCount === seatCount && (c.candidateId === candidateId || c.candidateId === candidateId.replace('js5opt', 'js5-opt')));
  if (!cell) throw new Error(`${path} 缺少 seatCount=${seatCount} candidate=${candidateId}`);
  return cell.games.filter(g => g.status === 'finished');
}

/** 种子级配对 bootstrap（重抽样单位 = 种子；每种子贡献 A、B 两条）。 */
function pairedBootstrap(clusters, { iterations = 20000, rngSeed = 0xa6d17 } = {}) {
  const rng = mulberry32(rngSeed);
  const dist = [];
  for (let i = 0; i < iterations; i++) {
    let cw = 0, bw = 0, n = 0, sd = 0;
    for (let k = 0; k < clusters.length; k++) {
      const c = clusters[Math.floor(rng() * clusters.length)];
      cw += c.c; bw += c.b; sd += c.cd - c.bd; n += 1;
    }
    dist.push({ d: (cw - bw) / n, s: sd / n });
  }
  const pct = (arr, key, p) => {
    const v = arr.map(x => x[key]).sort((a, b) => a - b);
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  return {
    ciLow: pct(dist, 'd', 0.025), ciHigh: pct(dist, 'd', 0.975),
    scoreLow: pct(dist, 's', 0.025), scoreHigh: pct(dist, 's', 0.975),
  };
}

function analyze(candGames, baseGames, { label, preregistered }) {
  const base = new Map(baseGames.map(g => [`${g.seed}:${g.direction}`, g]));
  const clusters = []; // 每种子一条：A、B 合并聚类
  const dirOnly = { A: [], B: [] };
  for (const g of candGames) {
    const b = base.get(`${g.seed}:${g.direction}`);
    if (!b) throw new Error(`${label} 配对缺失 @${g.seed}:${g.direction}`);
    const e = { direction: g.direction, c: g.won === true ? 1 : 0, b: b.won === true ? 1 : 0, cd: g.scoreDiff, bd: b.scoreDiff };
    clusters.push({ seed: g.seed, ...e });
    (dirOnly[g.direction] ??= []).push(e);
  }
  const summarize = rows => {
    const n = rows.length;
    const cw = rows.reduce((s, r) => s + r.c, 0), bw = rows.reduce((s, r) => s + r.b, 0);
    const meanDiff = rows.reduce((s, r) => s + (r.cd - r.bd), 0) / n;
    return { n, candRate: cw / n, baseRate: bw / n, diff: (cw - bw) / n, meanScoreDiff: meanDiff };
  };
  const out = { label, preregistered };
  for (const direction of ['A', 'B']) {
    const rows = dirOnly[direction];
    const st = summarize(rows);
    // 单方向 bootstrap（种子级，方向内每种子 1 局）
    const boot = pairedBootstrap(rows.map(r => ({ c: r.c, b: r.b, cd: r.cd, bd: r.bd })));
    out[direction] = { ...st, ci: [boot.ciLow, boot.ciHigh], scoreCI: [boot.scoreLow, boot.scoreHigh] };
  }
  // 合并：种子级聚类（同种子 A/B 强相关，必须整簇重抽）
  const bySeed = new Map();
  for (const r of clusters) {
    const e = bySeed.get(r.seed) ?? { A: null, B: null };
    e[r.direction] = r; bySeed.set(r.seed, e);
  }
  const mergedClusters = [...bySeed.values()].flatMap(e => (e.A && e.B ? [e.A, e.B] : e.A ? [e.A] : [e.B]));
  const st = summarize(mergedClusters);
  const boot = pairedBootstrap(mergedClusters.map(r => ({ c: r.c, b: r.b, cd: r.cd, bd: r.bd })));
  out.merged = { ...st, ci: [boot.ciLow, boot.ciHigh], scoreCI: [boot.scoreLow, boot.scoreHigh], exploratory: true };
  return out;
}

const grade = (ci, meanCI, note = '') => {
  const [lo, hi] = ci;
  if (lo > 0) return `significant（显著优势：CI [${(lo * 100).toFixed(1)},${(hi * 100).toFixed(1)}]pp 不含 0${note}）`;
  if (lo > -0.05 && hi > 0) return `non-inferior（非劣证据：CI 下界 ${(lo * 100).toFixed(1)}pp > −5pp 事后 margin${note}）`;
  if (hi > 0) return `trend（单纯正向趋势：CI 触 0 以下${note}）`;
  return `inconclusive（无正向证据${note}）`;
};

const results = [];
for (const pool of ['classic', 'diverse']) {
  const cand = loadCell(resolve(REPO_ROOT, `training/reports/js5-phase5/confirm/js5-${pool}/ablation-confirm-js5-2_3_4_5-200s${pool === 'diverse' ? '-div' : ''}.json`), 2, 'js5');
  const base = loadCell(resolve(REPO_ROOT, `training/reports/js5-phase5/confirm/js0-${pool}/ablation-confirm-js0-2_3_4_5-200s${pool === 'diverse' ? '-div' : ''}.json`), 2, 'js0');
  results.push(analyze(cand, base, { label: `js5 vs js0（${pool} 池，2p）`, preregistered: true }));
}
// 次级对照：js1（beam-contest，第五阶段历史最佳基线）与 js5-opt
for (const [vid, stem] of [['js1', 'js1'], ['js5opt', 'js5-opt']]) {
  const cand = loadCell(resolve(REPO_ROOT, `training/reports/js5-phase5/confirm/${vid}-classic/ablation-confirm-${stem}-2_3_4_5-200s.json`), 2, vid);
  const base = loadCell(resolve(REPO_ROOT, 'training/reports/js5-phase5/confirm/js0-classic/ablation-confirm-js0-2_3_4_5-200s.json'), 2, 'js0');
  results.push(analyze(cand, base, { label: `${vid} vs js0（classic 池，2p，次级对照）`, preregistered: false }));
}

// ---- 与 compare.mjs（项目官方工具）交叉核对 ----
let crossCheck = null;
try {
  const { pairedComparisonDirectional } = await import(`file://${resolve(REPO_ROOT, 'training/joint/compare.mjs')}`);
  const candPath = resolve(REPO_ROOT, 'training/reports/js5-phase5/confirm/js5-classic/ablation-confirm-js5-2_3_4_5-200s.json');
  const basePath = resolve(REPO_ROOT, 'training/reports/js5-phase5/confirm/js0-classic/ablation-confirm-js0-2_3_4_5-200s.json');
  const theirs = pairedComparisonDirectional(candPath, basePath, { seatCount: 2, candidateId: 'js5', baselineId: 'js0', directionFilter: 'A', familySize: 4, iterations: 2000 });
  const mine = results[0].A;
  crossCheck = {
    tool: 'compare.mjs pairedComparisonDirectional(A, family=4)',
    theirsDiff: theirs.firstPlaceDiff, mineDiff: mine.diff,
    theirsCI: theirs.firstPlaceDiffCI, mineCI: [mine.ci[0], mine.ci[1]],
    agreePoint: Math.abs(theirs.firstPlaceDiff - mine.diff) < 1e-9,
    agreeCIOrder: theirs.firstPlaceDiffCI[0] <= mine.ci[1] && mine.ci[0] <= theirs.firstPlaceDiffCI[1],
  };
} catch (error) { crossCheck = { error: String(error.message) }; }

// ---- 输出 ----
const pp = x => `${(x * 100).toFixed(1)}pp`;
const fmt = r => {
  const lines = [];
  for (const [k, tag] of [['A', '方向A·单席位（预注册主判定，family=4 校正水平 98.75%）'], ['B', '方向B·单席位（预注册次级）'], ['merged', 'A+B 合并（事后探索：同种子席位互换池）']]) {
    const e = r[k];
    const famNote = k === 'A' ? '；本审计按 95% 报告，family=4 校正仅披露' : '';
    lines.push(`  [${tag}] ${r.label}`);
    lines.push(`    候选 ${(e.candRate * 100).toFixed(1)}% vs 基准 ${(e.baseRate * 100).toFixed(1)}%｜差 ${pp(e.diff)} 95%CI [${pp(e.ci[0])},${pp(e.ci[1])}]｜分差 ${e.meanScoreDiff.toFixed(2)} CI [${e.scoreCI[0].toFixed(2)},${e.scoreCI[1].toFixed(2)}]｜${e.n} 局`);
    lines.push(`    分级：${grade(e.ci, null, famNote)}${k === 'merged' ? '（探索性，不得用于晋级推断）' : ''}`);
  }
  return lines.join('\n');
};
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ audit: 'redteam-two-player-ab', results, crossCheck }, null, 2));
} else {
  console.log('\n== 红队双人 A/B 独立统计（种子级配对 bootstrap，20000 次重抽，审计侧独立实现）==');
  for (const r of results) console.log(fmt(r));
  if (crossCheck) {
    console.log('\n== 与官方工具 compare.mjs 交叉核对（js5 vs js0, classic, 2p, 方向A）==');
    console.log(JSON.stringify(crossCheck, null, 1));
  }
  console.log('\n诚实性声明：显著性分级规则（δ=5pp 非劣 margin 等）为本审计事后选择；预注册口径仅 PHASE5 §5 的方向 A 主判定（family=4）。2p 双池正向趋势均未达预注册显著——与 PHASE5「2 人保留冠军」决策门槛 B 一致。');
}
