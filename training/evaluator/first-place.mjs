/** P0：第一名率（first-place rate）优先的冠军竞技评价核心。
 *
 * 为什么替换旧判据：
 * - 旧晋级判据是「配对得分优势率」（决定性种子中双向平均分差 > 0 的比例），
 *   它衡量相对得分，不是取得第一名的概率；
 * - 2–5 人真实对局的第一名由官方规则唯一裁定（engine.ranking：分数降序、
 *   同分时席位号大者优先），这是唯一主优化目标；
 * - 方向 B（候选占 N−1 席）的「阵营第一名率」不能当作单个 AI 玩家的第一名率，
 *   因此本模块只接受「单焦点席位」配对设计：
 *     实验 A：候选控制焦点席位，其余席位为冻结对手；
 *     实验 B：冻结冠军控制同一焦点席位，其余席位与 A 完全相同（同种子同对手）。
 *   同一 seed 的 A/B 两局构成一个配对样本，delta = candidateFirst − championFirst ∈ {−1,0,+1}。
 *
 * 统计口径（全部预注册，读取正式验证结果前锁定）：
 * - 统计单位 = 种子（cluster）。同一种子派生的多个座位/方向/对手组合先在簇内取均值，
 *   再以簇为独立样本计算区间，禁止把相关观测伪装成独立样本；
 * - 主检验：2–5 人按预注册权重（默认等权 0.25）汇总的第一名率增量，单侧置信下界 > 0；
 * - 非劣效：每个人数单独检验，单侧下界 ≥ −margin（默认 0.02，即最多退化 2 个百分点）；
 * - 联合条件用交集-并集检验（IUT）：主检验与每个人数非劣效各自在 alpha 水平上执行，
 *   全部通过才判定晋级，整体 I 类错误 ≤ alpha，无需再对 IUT 本身做 Bonferroni；
 * - 跨人数样本必须来自互不重叠的独立验证种子块（同一种子不得跨人数复用），
 *   否则拒绝判定（相关观测会再次低估方差）。
 *
 * 本模块不做「中途显著就提前晋级」：默认固定样本，可选停止必须先预注册且由
 * alpha 账本提供有效保证。
 */

import { probit } from './stats.mjs';

export const FIRST_PLACE_SCHEMA = 'century-first-place-evidence-v1';
export const DEFAULT_NON_INFERIORITY_MARGIN = 0.02;
export const DEFAULT_ALPHA = 0.05;

// ---------------------------------------------------------------------------
// Student t 分布（小样本簇级区间；种子数 ≥ 60 时与正态几乎一致，但小样本测试
// 仍需要正确分位数，不能用 z 冒充 t）。
// ---------------------------------------------------------------------------

function logGamma(x) {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of coefficients) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const MAX_ITER = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全 Beta 函数 I_x(a,b)。 */
export function incompleteBeta(x, a, b) {
  if (!(x >= 0 && x <= 1)) throw new Error(`incompleteBeta 要求 x ∈ [0,1]，实际：${x}`);
  if (x === 0) return 0;
  if (x === 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student t 累积分布（单尾，t ≥ 0 时返回 P(T ≤ t)）。 */
export function studentTCdf(t, df) {
  if (!Number.isFinite(t)) throw new Error(`t 必须为有限数，实际：${t}`);
  if (!Number.isSafeInteger(df) || df < 1) throw new Error(`df 必须为 ≥1 整数，实际：${df}`);
  if (t === 0) return 0.5;
  const x = df / (df + t * t);
  const ib = incompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/** Student t 分位数（bisection，精度 1e-10）。 */
export function studentTQuantile(p, df) {
  if (!(p > 0 && p < 1)) throw new Error(`studentTQuantile 要求 p ∈ (0,1)，实际：${p}`);
  if (!Number.isSafeInteger(df) || df < 1) throw new Error(`df 必须为 ≥1 整数，实际：${df}`);
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  let low = 0;
  let high = 1;
  while (studentTCdf(high, df) < p) {
    high *= 2;
    if (high > 1e12) throw new Error('studentTQuantile 数值失稳');
  }
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, df) < p) low = mid;
    else high = mid;
    if (high - low < 1e-10) break;
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// 簇级配对样本
// ---------------------------------------------------------------------------

function assertFiniteProbability(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须是 [0,1] 内的有限数，实际：${String(value)}`);
  }
  return value;
}

/**
 * 把逐局或逐座位观测聚成「每种子一个配对 delta」。
 *
 * @param {Array<{seed:number, candidateFirst:boolean|number, championFirst:boolean|number, anomalies?:number}>} pairs
 * @returns {{clusters:Array<{seed:number, delta:number, candidateFirst:number, championFirst:number, observations:number}>, anomalyGames:number, totalGames:number, anomalyRate:number, duplicateSeeds:boolean}}
 */
export function clusterFirstPlacePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('pairs 不能为空');
  const groups = new Map();
  const seenMeasurements = new Set();
  let anomalyGames = 0;
  let totalGames = 0;
  for (const pair of pairs) {
    if (!pair || !Number.isSafeInteger(pair.seed) || pair.seed < 0) {
      throw new Error(`配对样本缺少合法 seed：${JSON.stringify(pair)?.slice(0, 120)}`);
    }
    // 同一 (seed, focusSeat) 的重复测量不是新样本，而是重复统计/复制粘贴事故。
    if (pair.focusSeat !== undefined) {
      const key = `${pair.seed}:${pair.focusSeat}`;
      if (seenMeasurements.has(key)) {
        throw new Error(`同一种子 ${pair.seed} 的同一焦点席位 ${pair.focusSeat} 出现重复测量——禁止把重复记录当独立样本`);
      }
      seenMeasurements.add(key);
    }
    const anomalies = Number(pair.anomalies ?? 0);
    if (!Number.isInteger(anomalies) || anomalies < 0) {
      throw new Error(`配对样本 anomalies 非法：${JSON.stringify(pair)?.slice(0, 120)}`);
    }
    anomalyGames += anomalies;
    totalGames += 2;
    if (anomalies > 0) continue;
    const candidateFirst = pair.candidateFirst === true ? 1 : pair.candidateFirst === false ? 0 : Number(pair.candidateFirst);
    const championFirst = pair.championFirst === true ? 1 : pair.championFirst === false ? 0 : Number(pair.championFirst);
    assertFiniteProbability(candidateFirst, 'candidateFirst');
    assertFiniteProbability(championFirst, 'championFirst');
    const delta = candidateFirst - championFirst;
    if (delta < -1 || delta > 1) throw new Error(`delta 越界：${delta}（必须在 [−1,1]）`);
    const list = groups.get(pair.seed) ?? [];
    list.push({ delta, candidateFirst, championFirst });
    groups.set(pair.seed, list);
  }
  const clusters = [];
  for (const [seed, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const n = list.length;
    const mean = (key) => list.reduce((s, x) => s + x[key], 0) / n;
    clusters.push({
      seed,
      delta: mean('delta'),
      candidateFirst: mean('candidateFirst'),
      championFirst: mean('championFirst'),
      observations: n,
    });
  }
  return {
    clusters,
    anomalyGames,
    totalGames,
    anomalyRate: totalGames ? anomalyGames / totalGames : 0,
    uniqueSeeds: clusters.length,
  };
}

/**
 * 簇级均值单侧置信区间（种子为独立统计单位）。
 *
 * @param {{clusters:Array<{delta:number}>}} clustered
 * @param {{alpha?:number}} [options]
 */
export function clusterMeanCI(clustered, { alpha = DEFAULT_ALPHA } = {}) {
  const values = clustered.clusters.map(c => c.delta);
  const n = values.length;
  if (n < 2) throw new Error(`簇级区间至少需要 2 个独立种子，实际：${n}`);
  if (!(alpha > 0 && alpha < 0.5)) throw new Error(`alpha 必须在 (0,0.5)，实际：${alpha}`);
  const mean = values.reduce((s, x) => s + x, 0) / n;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const df = n - 1;
  const tCritical = studentTQuantile(1 - alpha, df);
  const lower = mean - tCritical * se;
  const upper = mean + tCritical * se;
  return {
    mean,
    variance,
    se,
    df,
    tCritical,
    alpha,
    lower,
    upper,
    oneSidedLower: lower,
    n,
    candidateFirstRate: values.length
      ? clustered.clusters.reduce((s, c) => s + c.candidateFirst, 0) / n
      : null,
    championFirstRate: values.length
      ? clustered.clusters.reduce((s, c) => s + c.championFirst, 0) / n
      : null,
  };
}

/**
 * 单个人数的第一名率增量分析。
 *
 * @param {object} options
 * @param {Array<object>} options.pairs 配对观测（同 seed 可多条，簇内平均）
 * @param {number} [options.alpha]
 * @param {number} [options.minSeeds]
 * @param {number} [options.maxAnomalyRate]
 * @param {number} [options.seatCount]
 */
export function analyzeSeatStratum({
  pairs, alpha = DEFAULT_ALPHA, minSeeds = 60, maxAnomalyRate = 0.02, seatCount = null,
}) {
  const clustered = clusterFirstPlacePairs(pairs);
  if (clustered.anomalyRate > maxAnomalyRate) {
    return {
      schema: FIRST_PLACE_SCHEMA,
      seatCount,
      status: 'rejected',
      reason: `异常率 ${clustered.anomalyRate.toFixed(4)} 超过上限 ${maxAnomalyRate}`,
      anomalyRate: clustered.anomalyRate,
      uniqueSeeds: clustered.uniqueSeeds,
      ci: null,
    };
  }
  if (clustered.uniqueSeeds < minSeeds) {
    return {
      schema: FIRST_PLACE_SCHEMA,
      seatCount,
      status: 'insufficient',
      reason: `独立种子 ${clustered.uniqueSeeds} 少于下限 ${minSeeds}`,
      anomalyRate: clustered.anomalyRate,
      uniqueSeeds: clustered.uniqueSeeds,
      ci: null,
    };
  }
  const ci = clusterMeanCI(clustered, { alpha });
  return {
    schema: FIRST_PLACE_SCHEMA,
    seatCount,
    status: 'analyzed',
    uniqueSeeds: clustered.uniqueSeeds,
    totalGames: clustered.totalGames,
    anomalyGames: clustered.anomalyGames,
    anomalyRate: clustered.anomalyRate,
    ci,
  };
}

/** 非劣效检验：H0: delta ≤ −margin；单侧下界 ≥ −margin 才通过。 */
export function nonInferiorityDecision({ stratum, margin = DEFAULT_NON_INFERIORITY_MARGIN }) {
  if (!(margin >= 0 && margin < 1)) throw new Error(`margin 必须在 [0,1)，实际：${margin}`);
  if (!stratum?.ci) {
    return { seatCount: stratum?.seatCount ?? null, pass: false, reason: stratum?.reason ?? '缺少区间' };
  }
  return {
    seatCount: stratum.seatCount,
    pass: stratum.ci.oneSidedLower >= -margin,
    margin,
    lower: stratum.ci.oneSidedLower,
    mean: stratum.ci.mean,
    reason: stratum.ci.oneSidedLower >= -margin
      ? `下界 ${stratum.ci.oneSidedLower.toFixed(4)} ≥ −${margin}`
      : `下界 ${stratum.ci.oneSidedLower.toFixed(4)} < −${margin}（超出最大退化幅度）`,
  };
}

/** 跨人数加权汇总：权重预注册、各层样本独立。 */
export function pooledWeightedDelta({ strata, weights, alpha = DEFAULT_ALPHA }) {
  const usable = strata.filter(s => s.ci);
  if (usable.length === 0) return { status: 'insufficient', reason: '没有可用人数层' };
  const seats = usable.map(s => s.seatCount);
  if (!weights) throw new Error('必须提供预注册人数权重');
  const weightSum = seats.reduce((s, n) => s + (weights[String(n)] ?? weights[n] ?? 0), 0);
  if (Math.abs(weightSum - 1) > 1e-9) throw new Error(`人数权重之和必须为 1，实际：${weightSum}`);

  let mean = 0;
  let variance = 0;
  const components = [];
  for (const stratum of usable) {
    const w = weights[String(stratum.seatCount)] ?? weights[stratum.seatCount];
    const v = (w ** 2) * (stratum.ci.variance / stratum.ci.n);
    mean += w * stratum.ci.mean;
    variance += v;
    components.push({ seatCount: stratum.seatCount, weight: w, mean: stratum.ci.mean, n: stratum.ci.n, varianceContribution: v });
  }
  const se = Math.sqrt(variance);
  const numerator = variance ** 2;
  const denominator = components.reduce((s, c) => s + (c.varianceContribution ** 2) / Math.max(1, c.n - 1), 0);
  const df = denominator > 0 ? Math.max(1, Math.floor(numerator / denominator)) : 1;
  const tCritical = studentTQuantile(1 - alpha, df);
  const lower = mean - tCritical * se;
  return {
    status: 'analyzed',
    metric: 'weightedPairedFirstPlaceRateDelta',
    mean,
    se,
    df,
    tCritical,
    alpha,
    lower,
    upper: mean + tCritical * se,
    weights: Object.fromEntries(usable.map(s => [String(s.seatCount), weights[String(s.seatCount)] ?? weights[s.seatCount]])),
    components,
    superiority: lower > 0,
  };
}

function assertIndependentSeedBlocks(strata) {
  const seen = new Map();
  for (const stratum of strata) {
    for (const cluster of stratum.clusters) {
      const previous = seen.get(cluster.seed);
      if (previous !== undefined && previous !== stratum.seatCount) {
        throw new Error(
          `同一种子 ${cluster.seed} 同时出现在 ${previous} 人与 ${stratum.seatCount} 人层——` +
          '跨人数观测相关，禁止合并判定；请使用独立验证种子块',
        );
      }
      seen.set(cluster.seed, stratum.seatCount);
    }
  }
  return true;
}

/**
 * 冠军晋级判定（唯一主目标：2–5 人第一名率）。
 *
 * 通过条件（全部满足）：
 * 1. 每层异常率 ≤ 上限，独立种子数 ≥ 下限；
 * 2. 每层非劣效：单侧下界 ≥ −margin（默认 2pp）；
 * 3. 加权汇总主检验：单侧下界 > 0；
 * 4. 跨人数种子块互不重叠。
 *
 * 任一不满足 → 不晋级（保留冠军），并披露具体原因，便于自动诊断。
 *
 * @param {object} options
 * @param {Array<{seatCount:number, pairs:Array<object>}>} options.strata
 * @param {object} [options.weights] 形如 {2:0.25,3:0.25,4:0.25,5:0.25}
 * @param {number} [options.alpha] 已按 alpha 消耗方案收紧后的单次水平
 * @param {number} [options.margin]
 * @param {number} [options.minSeeds]
 * @param {number} [options.maxAnomalyRate]
 * @param {number[]} [options.requiredSeatCounts]
 */
export function firstPlacePromotionDecision({
  strata,
  weights = null,
  alpha = DEFAULT_ALPHA,
  margin = DEFAULT_NON_INFERIORITY_MARGIN,
  minSeeds = 60,
  maxAnomalyRate = 0.02,
  requiredSeatCounts = [2, 3, 4, 5],
}) {
  if (!Array.isArray(strata) || strata.length === 0) throw new Error('strata 不能为空');
  const seatSet = new Set();
  for (const stratum of strata) {
    if (!requiredSeatCounts.includes(stratum.seatCount)) {
      throw new Error(`非法人数层：${stratum.seatCount}`);
    }
    if (seatSet.has(stratum.seatCount)) {
      throw new Error(`人数层 ${stratum.seatCount} 重复——每个人数只能有一份独立成次证据`);
    }
    seatSet.add(stratum.seatCount);
  }
  const normalized = strata.map(s => analyzeSeatStratum({
    pairs: s.pairs, alpha, minSeeds, maxAnomalyRate, seatCount: s.seatCount,
  }));
  // 独立种子块检查在聚类后执行（同 seed 跨人数即拒绝）。
  const clustered = normalized.map(s => {
    const c = clusterFirstPlacePairs(strata.find(x => x.seatCount === s.seatCount).pairs);
    return { seatCount: s.seatCount, clusters: c.clusters };
  });
  const duplicatesAcrossStrata = (() => {
    try { return assertIndependentSeedBlocks(clustered); } catch (error) { return error.message; }
  })();

  const missing = requiredSeatCounts.filter(n => !normalized.some(s => s.seatCount === n));
  const finalWeights = weights ?? Object.fromEntries(requiredSeatCounts.map(n => [String(n), 1 / requiredSeatCounts.length]));
  const nonInferiority = normalized.map(s => nonInferiorityDecision({ stratum: s, margin }));
  const pooled = normalized.every(s => s.ci) ? pooledWeightedDelta({ strata: normalized, weights: finalWeights, alpha }) : null;

  const reasons = [];
  if (duplicatesAcrossStrata !== true) reasons.push(`跨人数种子复用：${duplicatesAcrossStrata}`);
  if (missing.length) reasons.push(`缺少人数层：${missing.join('/')}`);
  for (const s of normalized) {
    if (s.status === 'rejected') reasons.push(`${s.seatCount} 人层：${s.reason}`);
    if (s.status === 'insufficient') reasons.push(`${s.seatCount} 人层：${s.reason}`);
  }
  for (const ni of nonInferiority) {
    if (!ni.pass) reasons.push(`${ni.seatCount} 人非劣效失败：${ni.reason}`);
  }
  if (!pooled || pooled.status !== 'analyzed') {
    reasons.push('加权汇总主检验不可执行');
  } else if (!pooled.superiority) {
    reasons.push(`加权第一名率增量 ${pooled.mean.toFixed(4)} 的单侧下界 ${pooled.lower.toFixed(4)} ≤ 0（未显著为正）`);
  }

  const promote = reasons.length === 0;
  return {
    schema: 'century-first-place-promotion-decision-v1',
    metric: 'pairedFirstPlaceRateDelta',
    primaryObjective: 'firstPlaceWinRate',
    decisionMetric: 'weightedPairedFirstPlaceRateDelta',
    alpha,
    margin,
    minSeeds,
    maxAnomalyRate,
    requiredSeatCounts,
    weights: finalWeights,
    pooled,
    nonInferiority,
    strata: normalized,
    promote,
    verdict: promote ? 'promote' : (pooled && pooled.status === 'analyzed' && pooled.mean > 0 ? 'inconclusive-or-violated' : 'rejected'),
    reasons,
    multipleTestingControl: 'IUT：主检验与各人数非劣效均在 alpha 水平执行，全部通过才晋级（整体 I 类错误 ≤ alpha）；跨挑战 alpha 由几何消耗账本覆盖',
    note: '平均得分、资源效率、搜索深度仅诊断，不参与晋级判定',
  };
}

/** 双人核对工具：把逐局 A/B 列表转成 pairs（供挑战运行器使用）。 */
export function toPairs({ seed, candidateFirstSeats, championFirstSeats, anomalies = 0 }) {
  if (!Array.isArray(candidateFirstSeats) || !Array.isArray(championFirstSeats)) {
    throw new Error('candidateFirstSeats/championFirstSeats 必须为数组');
  }
  return candidateFirstSeats.map((candidateFirst, index) => ({
    seed,
    candidateFirst: candidateFirst === true ? 1 : 0,
    championFirst: championFirstSeats[index] === true ? 1 : 0,
    anomalies: index === 0 ? anomalies : 0,
  }));
}

export { probit };
