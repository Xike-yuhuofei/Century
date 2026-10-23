/** 基线评测统计工具（AI6 第一阶段任务 B/C）。
 *
 * 与 training/evaluator/stats.mjs 的分工：
 * - 那边：晋级判定（配对得分优势率 + Wilson + 几何 alpha 消耗），语义冻结；
 * - 这里：多人第一名率基准的描述性统计——延迟分位数、座位/对手分解、
 *   以及「按种子聚类的 bootstrap 置信区间」（同一种子的多局共享洗牌序列，
 *   是相关样本，独立样本 Wilson 区间会低估方差）。
 *
 * 第一名率（primary metric）的推断规则：
 * - 主区间 = seed 级 cluster bootstrap（重抽样单位是种子，不是局）；
 * - Wilson 区间仅作参考披露（标注"独立样本近似"）；
 * - bootstrap 用确定性 RNG（mulberry32），同输入同输出，可审计可复现。
 */

import { mulberry32 } from '../lib/rng.mjs';

/** 已排序样本的分位数（线性插值，与常见 p50/p95/p99 语义一致）。 */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) throw new Error('percentile 要求非空已排序数组');
  if (!(p >= 0) || !(p <= 1)) throw new Error(`p 必须在 [0,1]，实际：${p}`);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** 决策延迟摘要：p50/p95/p99 + 均值 + 最大值（毫秒）。 */
export function latencySummary(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { count: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, x) => s + x, 0);
  return {
    count: sorted.length,
    meanMs: Number((sum / sorted.length).toFixed(3)),
    p50Ms: Number(percentile(sorted, 0.50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

/** 按种子聚类的第一名率 bootstrap 区间。
 *
 * @param {Array<{seed:number, firstPlace:boolean}>} games 每局一条（相关局共享 seed）
 * @param {object} [options]
 * @param {number} [options.iterations] 重抽样次数（默认 2000）
 * @param {number} [options.rngSeed] bootstrap 自身 RNG 种子（确定性；与对局种子无关）
 * @returns {{point:number, lower:number, upper:number, seeds:number, iterations:number}}
 * 空样本或全部同值时退化为点估计（区间 = 点）。
 */
export function firstPlaceClusterCI(games, { iterations = 2000, rngSeed = 0x6a11e5 } = {}) {
  if (!Array.isArray(games) || games.length === 0) throw new Error('games 不能为空');
  for (const g of games) {
    if (!Number.isSafeInteger(g?.seed)) throw new Error(`games 条目缺少合法 seed：${JSON.stringify(g)?.slice(0, 120)}`);
    if (typeof g?.firstPlace !== 'boolean') throw new Error(`games 条目缺少 firstPlace 布尔值：${JSON.stringify(g)?.slice(0, 120)}`);
  }
  // 聚类：seed → [成功数, 总局数]。重抽样单位是种子。
  const clusters = new Map();
  for (const g of games) {
    const c = clusters.get(g.seed) ?? [0, 0];
    c[0] += g.firstPlace ? 1 : 0;
    c[1] += 1;
    clusters.set(g.seed, c);
  }
  const clusterList = [...clusters.values()];
  const totalWins = clusterList.reduce((s, [w]) => s + w, 0);
  const totalGames = clusterList.reduce((s, [, n]) => s + n, 0);
  const point = totalWins / totalGames;
  const rng = mulberry32(rngSeed);
  const rates = [];
  for (let i = 0; i < iterations; i++) {
    let wins = 0, gamesN = 0;
    for (let k = 0; k < clusterList.length; k++) {
      const [w, n] = clusterList[Math.floor(rng() * clusterList.length)];
      wins += w;
      gamesN += n;
    }
    rates.push(wins / gamesN);
  }
  rates.sort((a, b) => a - b);
  // 退化保护：全部重抽样同值（如每局都第一名）时 percentile 退化正常。
  return {
    point: Number(point.toFixed(4)),
    lower: Number(percentile(rates, 0.025).toFixed(4)),
    upper: Number(percentile(rates, 0.975).toFixed(4)),
    seeds: clusters.size,
    games: totalGames,
    iterations,
    method: 'seed-cluster-bootstrap-95',
  };
}

/** 把 bootstrap 区间格式化为带审计信息的对象（报告直接引用）。 */
export function firstPlaceMetric(games, options = {}) {
  const ci = firstPlaceClusterCI(games, options);
  return {
    definition: '第一名局占比（rank 1）；主区间为按种子聚类的 bootstrap（相关样本修正）',
    ...ci,
  };
}

/** 按键分组统计第一名率（座位 / 对手风格分解用）。 */
export function firstPlaceBy(games, keyOf) {
  const groups = new Map();
  for (const g of games) {
    const key = keyOf(g);
    const list = groups.get(key) ?? [];
    list.push(g);
    groups.set(key, list);
  }
  const out = {};
  for (const [key, list] of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'))) {
    const wins = list.filter(g => g.firstPlace).length;
    out[String(key)] = { games: list.length, wins, rate: Number((wins / list.length).toFixed(4)) };
  }
  return out;
}

/** 平均名次（值越小越好）；终局名次 1..seatCount。 */
export function meanRank(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return Number((values.reduce((s, x) => s + x, 0) / values.length).toFixed(4));
}

/** 配对分差摘要（辅助指标：保留既有"配对得分优势"语义，只是不再作主判定）。 */
export function pairedDiffSummary(seedPairs) {
  const finished = seedPairs.filter(p => p.status === 'finished');
  const diffs = finished.map(p => p.diff);
  if (diffs.length === 0) {
    return { seeds: 0, meanDiff: null, won: 0, lost: 0, tied: 0 };
  }
  const won = diffs.filter(d => d > 0).length;
  const lost = diffs.filter(d => d < 0).length;
  const tied = diffs.filter(d => d === 0).length;
  return {
    seeds: diffs.length,
    meanDiff: Number((diffs.reduce((s, x) => s + x, 0) / diffs.length).toFixed(4)),
    won, lost, tied,
    advantageRate: Number((won / diffs.length).toFixed(4)),
  };
}
