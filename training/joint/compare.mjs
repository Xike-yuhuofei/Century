/** JS0–JS5 配对比较工具（PR #26 第三阶段）。
 *
 * 输入：多个 ablation JSON（duel.mjs 产物，同 block/同 seeds/同 players）。
 * 输出：候选 vs 基准的按种子聚类配对第一名率差 + bootstrap CI + 逐座位分解。
 *
 * 统计口径（任务书 §三.7）：
 * - 一级指标 = 候选席位第一名率，方向 A/B 分开；
 * - 配对单位 = 种子（同一 seed 的 A/B 双局共享洗牌序列，是相关样本）；
 * - 区间 = 种子级 cluster bootstrap（重抽样单位 = 种子）；
 * - 胜率差 CI：对每个 bootstrap 重抽样，同时抽同一批种子索引，计算
 *   候选与基准的第一名率差（配对差分，方差随相关而降）。
 */

import { readFileSync } from 'node:fs';
import { mulberry32 } from '../lib/rng.mjs';

function loadGames(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const games = [];
  for (const cell of report.cells) {
    for (const g of cell.games ?? []) games.push(g);
  }
  return { report, games };
}

/** 从 ablation JSON 提取按 (seed, direction) 的胜局表。 */
function winMap(path, seatCount) {
  const { report, games } = loadGames(path);
  const map = new Map();
  for (const g of games) {
    if (g.status !== 'finished' || g.seatCount !== seatCount) continue;
    map.set(`${g.seed}:${g.direction}`, { won: g.won, scoreDiff: g.scoreDiff });
  }
  return map;
}

/** 配对比较：candidatePath 与 baselinePath 必须来自同一批 (seed, direction) 对局。 */
export function pairedComparison(candidatePath, baselinePath, { seatCount = 2, iterations = 2000, rngSeed = 0x6a11e5 } = {}) {
  const cand = winMap(candidatePath, seatCount);
  const base = winMap(baselinePath, seatCount);
  const seeds = [...new Set([...cand.keys()].filter(k => base.has(k)).map(k => k.split(':')[0]))].map(Number).sort((a, b) => a - b);
  if (!seeds.length) throw new Error('无配对种子（两侧 ablation JSON 的 block/seeds/players 必须一致）');
  // 聚类：seed → [{direction, candWon, baseWon, candDiff, baseDiff}]（A/B 各一条）。
  const clusters = seeds.map(seed => (['A', 'B'].map(direction => {
    const c = cand.get(`${seed}:${direction}`);
    const b = base.get(`${seed}:${direction}`);
    return c && b ? { direction, c: c.won ? 1 : 0, b: b.won ? 1 : 0, cd: c.scoreDiff, bd: b.scoreDiff } : null;
  })).filter(Boolean));
  const games = clusters.flat();
  const rate = (pick) => games.reduce((s, g) => s + (pick(g) ? 1 : 0), 0) / games.length;
  const point = {
    candidateFirstPlace: rate(g => g.c === 1),
    baselineFirstPlace: rate(g => g.b === 1),
    firstPlaceDiff: rate(g => g.c === 1) - rate(g => g.b === 1),
    meanScoreDiff: games.reduce((s, g) => s + (g.cd - g.bd), 0) / games.length,
    games: games.length,
    seeds: clusters.length,
  };
  // 种子级配对 bootstrap。
  const rng = mulberry32(rngSeed);
  const diffs = [];
  const scoreDiffs = [];
  for (let i = 0; i < iterations; i++) {
    let cWins = 0, bWins = 0, n = 0, sd = 0;
    for (let k = 0; k < clusters.length; k++) {
      const cluster = clusters[Math.floor(rng() * clusters.length)];
      for (const g of cluster) {
        cWins += g.c; bWins += g.b; n += 1; sd += g.cd - g.bd;
      }
    }
    diffs.push((cWins - bWins) / n);
    scoreDiffs.push(sd / n);
  }
  diffs.sort((a, b) => a - b);
  scoreDiffs.sort((a, b) => a - b);
  const percentile = (sorted, p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return {
    ...point,
    firstPlaceDiffCI: [Number(percentile(diffs, 0.025).toFixed(4)), Number(percentile(diffs, 0.975).toFixed(4))],
    meanScoreDiffCI: [Number(percentile(scoreDiffs, 0.025).toFixed(4)), Number(percentile(scoreDiffs, 0.975).toFixed(4))],
    method: 'seed-cluster-paired-bootstrap-95',
    significance: percentile(diffs, 0.025) > 0 ? 'candidate>baseline (95%)'
      : percentile(diffs, 0.975) < 0 ? 'candidate<baseline (95%)' : 'inconclusive',
  };
}

// CLI：node training/joint/compare.mjs <candidate.json> <baseline.json> [--players 2] [--seat 5]
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('compare.mjs')) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const seatCount = Number(process.argv.find(a => a.startsWith('--players'))?.split('=')[1] ?? 2);
  if (args.length < 2) {
    console.error('用法：node training/joint/compare.mjs <candidate-ablation.json> <baseline-ablation.json> [--players=N]');
    process.exit(1);
  }
  for (const n of [2, 3, 4, 5]) {
    try {
      const r = pairedComparison(args[0], args[1], { seatCount: n });
      if (r.games > 0) {
        console.log(`[${n}人] 配对 ${r.seeds} 种子 × ${r.games} 局：候选 ${(r.candidateFirstPlace * 100).toFixed(1)}% vs 基准 ${(r.baselineFirstPlace * 100).toFixed(1)}%｜差 ${(r.firstPlaceDiff * 100).toFixed(1)}pp CI [${(r.firstPlaceDiffCI[0] * 100).toFixed(1)},${(r.firstPlaceDiffCI[1] * 100).toFixed(1)}]｜分差 ${r.meanScoreDiff.toFixed(2)} CI [${r.meanScoreDiffCI[0].toFixed(2)},${r.meanScoreDiffCI[1].toFixed(2)}]｜${r.significance}`);
      }
    } catch { /* 该人数无数据则跳过 */ }
  }
}
