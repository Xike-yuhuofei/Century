/** P0：冠军晋级的统计功效与样本量分析（预注册前冻结）。
 *
 * 背景：几何 alpha 消耗在第 12 次挑战时 α≈1.22e-5（z≈4.38）。若仍按 250 种子/
 * 人数，最小可检测效应（MDE）会大到只有极强候选才可能通过；继续挑战会消耗
 * 验证种子却几乎无统计功效。本模块把「样本量—效应—功效」变成可计算、可审计
 * 的冻结参数，禁止在看到正式结果后临时放宽。
 *
 * 统计模型：
 * - 每个种子给出配对 delta ∈ {−1,0,+1}；
 * - Var(delta) = pA(1−pA) + pB(1−pB) − 2(p11 − pA·pB)；
 * - 未知 p11 时使用保守上界 variance=1；典型独立情形约 0.5；
 * - 单侧检验：n ≥ (z_{1−α} + z_{power})² · Var / effect²。
 */

import { probit } from './stats.mjs';

/** 标准正态 CDF（Abramowitz–Stegun 7.1.26，误差 < 1.5e-7）。 */
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export function pairedDeltaVariance({ pA, pB, p11 }) {
  for (const [name, value] of Object.entries({ pA, pB, p11 })) {
    if (!(value >= 0 && value <= 1)) throw new Error(`${name} 必须在 [0,1]，实际：${value}`);
  }
  const variance = pA * (1 - pA) + pB * (1 - pB) - 2 * (p11 - pA * pB);
  return Math.max(0, variance);
}

/** 单侧检验所需独立种子数（每个种子一个配对 delta）。 */
export function requiredSeeds({ effect, alpha, power = 0.8, variance = 1 }) {
  if (!(effect > 0)) throw new Error(`effect 必须 > 0，实际：${effect}`);
  if (!(alpha > 0 && alpha < 0.5)) throw new Error(`alpha 必须在 (0,0.5)，实际：${alpha}`);
  if (!(power > 0.5 && power < 1)) throw new Error(`power 必须在 (0.5,1)，实际：${power}`);
  if (!(variance > 0 && variance <= 1)) throw new Error(`variance 必须在 (0,1]，实际：${variance}`);
  const zAlpha = probit(1 - alpha);
  const zPower = probit(power);
  return Math.ceil(((zAlpha + zPower) ** 2) * variance / (effect ** 2));
}

/** 给定样本量下的单侧功效。 */
export function powerAt({ n, effect, alpha, variance = 1 }) {
  if (!Number.isSafeInteger(n) || n < 2) throw new Error(`n 必须为 ≥2 整数，实际：${n}`);
  if (!(effect > 0)) throw new Error(`effect 必须 > 0，实际：${effect}`);
  const se = Math.sqrt(variance / n);
  return normalCdf(effect / se - probit(1 - alpha));
}

/** 给定样本量与目标功效下的最小可检测效应（MDE）。 */
export function minimumDetectableEffect({ n, alpha, power = 0.8, variance = 1 }) {
  if (!Number.isSafeInteger(n) || n < 2) throw new Error(`n 必须为 ≥2 整数，实际：${n}`);
  return (probit(1 - alpha) + probit(power)) * Math.sqrt(variance / n);
}

/** 非劣效检验样本量：H0: delta ≤ −margin，真实 delta 取 0（最保守）。 */
export function requiredSeedsNonInferiority({ margin, alpha, power = 0.8, variance = 1 }) {
  if (!(margin > 0 && margin < 1)) throw new Error(`margin 必须在 (0,1)，实际：${margin}`);
  return requiredSeeds({ effect: margin, alpha, power, variance });
}

/**
 * 生成冻结的样本量/功效表。
 *
 * @param {object} options
 * @param {number} options.alpha 当前可用单侧 α
 * @param {number} [options.power]
 * @param {number[]} [options.effects]
 * @param {number[]} [options.variances]
 */
export function buildPowerTable({ alpha, power = 0.8, effects = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4], variances = [0.5, 1] }) {
  const rows = [];
  for (const variance of variances) {
    for (const effect of effects) {
      const n = requiredSeeds({ effect, alpha, power, variance });
      rows.push({
        variance,
        effect,
        requiredSeeds: n,
        powerAt250: Number(powerAt({ n: 250, effect, alpha, variance }).toFixed(4)),
        powerAt500: Number(powerAt({ n: 500, effect, alpha, variance }).toFixed(4)),
      });
    }
  }
  return {
    alpha,
    power,
    zAlpha: probit(1 - alpha),
    rows,
    mdeAt250: Object.fromEntries(variances.map(v => [String(v), Number(minimumDetectableEffect({ n: 250, alpha, power, variance: v }).toFixed(4))])),
    mdeAt500: Object.fromEntries(variances.map(v => [String(v), Number(minimumDetectableEffect({ n: 500, alpha, power, variance: v }).toFixed(4))])),
  };
}
