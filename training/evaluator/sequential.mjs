/** P0.4：顺序检验（group sequential）的功效/边界校准（先模拟，后替换门禁）。
 *
 * 背景：几何 alpha 消耗把第 12 次挑战压到 α=1.22e-5，功效在现实样本量下永远是
 * 0.6 以下——正式挑战被"统计功效死锁"永久阻塞。可持续方案是预注册**固定期限
 * Bonferroni 家族**（最多 K 次挑战，每次 α=α_budget/K），并在单次挑战内使用
 * 预先校准的分组顺序检验（interim + final 两次查看），在效应大时提前停止、
 * 效应小时走满样本，同时严格控制整体 I 类错误。
 *
 * 纪律：
 * - 所有边界都由**模拟校准**得到，并记录校准种子与 H0 模拟 FWER；
 * - 计划在读取任何正式结果之前冻结；不得看结果后放宽；
 * - 这里只做规划/校准，不接触正式验证种子。
 *
 * 统计模型（与 first-place.mjs 一致）：统计单位 = 种子簇；每簇一个配对 delta，
 * delta 的方差按保守上界 1 或典型独立上界 0.5 规划；单侧检验。
 */

/** 确定性 PRNG（mulberry32），保证模拟可复现。 */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态。 */
function normal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 单侧正态分位数（用 evaluator/stats.mjs 的 probit 保持同一口径）。 */
import { probit } from './stats.mjs';

/**
 * 模拟一次顺序检验（多元正态等价实现）。
 *
 * 规划模型：Z(t) = mean(t)/SE(t)，look 之间相关 ρ_ij = sqrt(t_min/t_max)，
 * 在 H1 下第 k 个 look 的非中心参数 λ_k = effect·sqrt(nMax·t_k/variance)。
 * 该模型与"按增量累加"的逐样本模拟在分布上等价，但计算量小两个数量级，
 * 足以做 5 万次以上的校准与功效搜索。
 *
 * @param {object} options
 * @param {number[]} options.lookFractions 信息比例，如 [0.5, 1.0]
 * @param {number[]} options.boundaries 每个 look 的单侧临界 z 值（递增放宽）
 * @param {number} options.nMax 每个种子的最大样本量（簇数）
 * @param {number} options.effect 真实效应（H1）或 0（H0）
 * @param {number} options.variance 单簇 delta 方差
 * @param {number} options.trials 模拟次数
 * @param {number} options.seed 模拟种子
 * @returns {{rejectRate:number, expectedN:number, stopAtLook:number[]}}
 */
export function simulateSequential({
  lookFractions, boundaries, nMax, effect, variance, trials = 20000, seed = 20261101,
}) {
  if (!Array.isArray(lookFractions) || lookFractions.length !== boundaries.length) {
    throw new Error('lookFractions 与 boundaries 长度必须一致');
  }
  for (let i = 1; i < lookFractions.length; i++) {
    if (!(lookFractions[i] > lookFractions[i - 1])) throw new Error('lookFractions 必须严格递增');
  }
  if (!(lookFractions.at(-1) <= 1)) throw new Error('lookFractions 最后一项必须 ≤ 1');
  const k = lookFractions.length;
  // 相关矩阵 ρ_ij = sqrt(t_min/t_max)；标准 Cholesky 下三角分解。
  const corr = lookFractions.map((ti) => lookFractions.map((tj) =>
    Math.sqrt(Math.min(ti, tj) / Math.max(ti, tj))));
  const chol = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = corr[i][j];
      for (let m = 0; m < j; m++) sum -= chol[i][m] * chol[j][m];
      chol[i][j] = i === j ? Math.sqrt(Math.max(1e-12, sum)) : sum / chol[j][j];
    }
  }
  const lambda = lookFractions.map(t => effect * Math.sqrt((nMax * t) / variance));
  const rng = createRng(seed);
  let rejected = 0;
  let totalN = 0;
  const stopAtLook = new Array(k).fill(0);
  for (let trial = 0; trial < trials; trial++) {
    const z = [];
    for (let i = 0; i < k; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += chol[i][j] * normal(rng);
      z.push(lambda[i] + sum);
    }
    let decided = false;
    for (let i = 0; i < k; i++) {
      if (z[i] >= boundaries[i]) {
        rejected += 1;
        const n = Math.max(1, Math.round(nMax * lookFractions[i]));
        totalN += n;
        stopAtLook[i] += 1;
        decided = true;
        break;
      }
    }
    if (!decided) totalN += Math.max(1, Math.round(nMax * lookFractions[k - 1]));
  }
  return {
    rejectRate: rejected / trials,
    expectedN: totalN / trials,
    stopAtLook,
    trials, seed, nMax, effect, variance, lookFractions, boundaries,
  };
}

/**
 * 校准顺序边界：在 H0 下模拟 FWER ≤ alpha（留 5% 相对余量），并尽量保持功效。
 *
 * 采用 Pocock 型等临界值族再加最终 look 的 Bonferroni 收紧：
 * 先取 b_k = probit(1 − alpha) 作为起点，若 H0 FWER 超限则整体抬升 b；
 * 允许 interim 与 final 不同（interim 更严，final 最松）。
 *
 * @param {object} options
 * @param {number} options.alpha 单次挑战总 alpha
 * @param {number[]} [options.lookFractions]
 * @param {number} options.variance
 * @param {number} [options.trials]
 * @param {number} [options.seed]
 */
export function calibrateSequentialBoundaries({
  alpha, lookFractions = [0.5, 1.0], variance = 0.5, trials = 50000, seed = 20261101,
}) {
  if (!(alpha > 0 && alpha < 0.5)) throw new Error(`alpha 必须在 (0,0.5)，实际：${alpha}`);
  const base = probit(1 - alpha);
  if (lookFractions.length === 1) {
    // 单次查看：名义临界值即边界；用两个独立模拟种子复核 H0（留 2% 相对余量吸收蒙特卡洛噪声）。
    let final = base;
    let sim = null;
    let recheck = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      sim = simulateSequential({
        lookFractions, boundaries: [final], nMax: 1000, effect: 0, variance, trials, seed,
      });
      recheck = simulateSequential({
        lookFractions, boundaries: [final], nMax: 1000, effect: 0, variance, trials, seed: seed + 1,
      });
      if (sim.rejectRate <= alpha * 0.98 && recheck.rejectRate <= alpha * 0.98) break;
      final += 0.05;
    }
    if (sim.rejectRate > alpha || recheck.rejectRate > alpha) {
      throw new Error(`单次查看边界校准失败：H0 ${sim.rejectRate}/${recheck.rejectRate} > alpha ${alpha}`);
    }
    return {
      boundaries: [final],
      lookFractions: [...lookFractions],
      alpha,
      alphaSpentNominal: [1 - normalCdf(final)],
      h0Fwer: recheck.rejectRate,
      h0FwerCalibration: sim.rejectRate,
      trials, seed, recheckSeed: seed + 1, variance,
    };
  }
  // 初值：interim 比 final 更严（OBF 风格），final 保持 alpha 名义水平。
  let interim = base + 0.6;
  let final = base;
  let sim = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    sim = simulateSequential({
      lookFractions, boundaries: [interim, final], nMax: 1000, effect: 0, variance,
      trials, seed,
    });
    if (sim.rejectRate <= alpha * 0.95) break;
    // 超限：整体收紧（final 优先，interim 跟随）。
    final += 0.25;
    interim = Math.max(interim, final + 0.2);
  }
  const h0 = sim;
  const h0Recheck = simulateSequential({
    lookFractions, boundaries: [interim, final], nMax: 1000, effect: 0, variance,
    trials, seed: seed + 1,
  });
  if (h0Recheck.rejectRate > alpha) {
    throw new Error(
      `顺序边界校准失败：复算 H0 FWER ${h0Recheck.rejectRate} > alpha ${alpha}——拒绝使用该计划`,
    );
  }
  return {
    boundaries: [interim, final],
    lookFractions: [...lookFractions],
    alpha,
    alphaSpentNominal: [1 - normalCdf(interim), 1 - normalCdf(final)],
    h0Fwer: h0Recheck.rejectRate,
    h0FwerCalibration: h0.rejectRate,
    trials, seed, recheckSeed: seed + 1, variance,
  };
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x) {
  // Abramowitz–Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * abs);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs);
  return sign * y;
}

/**
 * 求达到目标功效的最小 nMax（簇数），用模拟而非正态近似（顺序检验无闭式解）。
 *
 * @param {object} options
 * @param {number[]} options.boundaries
 * @param {number[]} options.lookFractions
 * @param {number} options.effect
 * @param {number} options.variance
 * @param {number} [options.targetPower]
 * @param {number} [options.trials]
 * @param {number} [options.seed]
 */
export function requiredSequentialSeeds({
  boundaries, lookFractions = [0.5, 1.0], effect, variance,
  targetPower = 0.8, trials = 20000, seed = 20261101, maxN = 4000,
}) {
  if (!(effect > 0)) throw new Error(`effect 必须 > 0，实际：${effect}`);
  let low = 10;
  let high = maxN;
  const powerAt = n => simulateSequential({
    lookFractions, boundaries, nMax: n, effect, variance, trials, seed,
  });
  if (powerAt(high).rejectRate < targetPower) {
    return { feasible: false, nMax: null, targetPower, achievedPower: powerAt(high).rejectRate, maxN };
  }
  let best = high;
  while (high - low > 2) {
    const mid = Math.floor((low + high) / 2);
    const result = powerAt(mid);
    if (result.rejectRate >= targetPower) { best = mid; high = mid; } else { low = mid; }
  }
  const final = powerAt(best);
  return {
    feasible: true, nMax: best, targetPower,
    achievedPower: final.rejectRate, expectedN: final.expectedN,
    stopAtLook: final.stopAtLook,
  };
}
