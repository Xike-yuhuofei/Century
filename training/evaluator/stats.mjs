/** 竞技评估统计工具：置信区间与晋级判定（任务书第七节）。
 * 晋级判断以胜率置信区间为主；平均分等指标仅作诊断，不得单独触发晋级。
 */

const Z_95 = 1.959963984540054;

/** Wilson 分数区间：小样本下比正态近似更稳健。 */
export function wilsonCI(wins, n, z = Z_95) {
  if (!Number.isInteger(n) || n <= 0) throw new Error('样本数 n 必须为正整数');
  if (wins < 0 || wins > n) throw new Error('wins 必须在 [0, n] 内');
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { point: p, lower: center - spread, upper: center + spread };
}

/** 均值的正态近似区间（大样本诊断用）。 */
export function meanCI(values, z = Z_95) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('values 不能为空');
  const n = values.length;
  const mean = values.reduce((s, x) => s + x, 0) / n;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);
  return { mean, se, lower: mean - z * se, upper: mean + z * se };
}

/** 晋级判定：
 * - 候选与冠军在双向混战（各占 1 席与 4 席）中的合并先名率期望为 0.5；
 * - 仅当先名率 Wilson 95% 区间下界 > 0.5 时晋级；
 * - 区间跨越 0.5 → 不确定，保留冠军并建议增加样本；
 * - 异常率超限直接拒绝（异常局从不计入胜率，但异常率高说明实现不稳定）。
 * 注意：本函数把每局视为独立样本；正式晋级判定请使用 pairedPromotionDecision
 * （同种子双向对局是配对样本，不能当独立样本计数）。
 */
export function promotionDecision({ wins, games, anomalyRate, minGames = 100, maxAnomalyRate = 0.02 }) {
  if (!Number.isInteger(games) || games <= 0) throw new Error('games 必须为正整数');
  if (anomalyRate > maxAnomalyRate) {
    return { promote: false, verdict: 'rejected', reason: `异常率 ${anomalyRate} 超过上限 ${maxAnomalyRate}，先修复稳定性再挑战` };
  }
  if (games < minGames) {
    const ci = wilsonCI(wins, games);
    return { promote: false, verdict: 'insufficient', reason: `样本 ${games} 不足（最少 ${minGames}）`, ci };
  }
  const ci = wilsonCI(wins, games);
  if (ci.lower > 0.5) {
    return { promote: true, verdict: 'promote', reason: `先名率 ${ci.point.toFixed(3)}，95% CI 下界 ${ci.lower.toFixed(3)} > 0.5`, ci };
  }
  if (ci.upper > 0.5) {
    return { promote: false, verdict: 'inconclusive', reason: `区间 [${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}] 跨越 0.5，结果不确定，保留冠军并建议增加样本`, ci };
  }
  return { promote: false, verdict: 'rejected', reason: `先名率区间上界 ${ci.upper.toFixed(3)} ≤ 0.5，候选劣势`, ci };
}

/** 按种子配对的晋级判定（审计整改：P1 统计可信度）。
 *
 * 同一 seed 的双向对局共享洗牌序列与座位结构，是配对样本而非独立样本；
 * 把 2×seeds 局当独立样本计算 Wilson 区间会低估方差、放大显著性。
 * 规则：
 * - 以 seed 为统计单位，每 seed 一个配对分差（双向平均：候选均分 − 对手均分）；
 * - 异常率仍按局计算，超限直接拒绝；
 * - 仅在分差非零的"决定性种子"上做先名率 Wilson 95% 检验（分差 > 0 记胜）；
 * - 决定性种子数不足 minSeeds → 样本不足；
 * - 平局种子不计入二项分母，但披露平局率（平局率过高说明两版无法区分）。
 */
export function pairedPromotionDecision({ seedPairs, minSeeds = 60, maxAnomalyRate = 0.02 }) {
  if (!Array.isArray(seedPairs) || seedPairs.length === 0) throw new Error('seedPairs 不能为空');
  const totalGames = seedPairs.length * 2;
  const anomalyGames = seedPairs.reduce((sum, p) => sum + (p.anomalies ?? 0), 0);
  const anomalyRate = totalGames ? anomalyGames / totalGames : 0;
  if (anomalyRate > maxAnomalyRate) {
    return { promote: false, verdict: 'rejected', reason: `异常率 ${anomalyRate.toFixed(3)} 超过上限 ${maxAnomalyRate}，先修复稳定性再挑战`, anomalyRate };
  }
  const finished = seedPairs.filter(p => p.status === 'finished');
  const decisive = finished.filter(p => p.diff !== 0);
  const wins = decisive.filter(p => p.diff > 0).length;
  const ties = finished.length - decisive.length;
  const tieRate = finished.length ? Number((ties / finished.length).toFixed(4)) : 0;
  if (decisive.length < minSeeds) {
    const ci = decisive.length ? wilsonCI(wins, decisive.length) : null;
    return { promote: false, verdict: 'insufficient', reason: `决定性种子 ${decisive.length} 不足（最少 ${minSeeds}）`, ci, tieRate, anomalyRate };
  }
  const ci = wilsonCI(wins, decisive.length);
  if (ci.lower > 0.5) {
    return {
      promote: true, verdict: 'promote',
      reason: `配对先名率 ${ci.point.toFixed(3)}（决定性种子 ${decisive.length}，平局率 ${tieRate}），95% CI 下界 ${ci.lower.toFixed(3)} > 0.5`,
      ci, tieRate, anomalyRate,
    };
  }
  if (ci.upper > 0.5) {
    return {
      promote: false, verdict: 'inconclusive',
      reason: `配对区间 [${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}] 跨越 0.5，结果不确定，保留冠军并建议增加种子`,
      ci, tieRate, anomalyRate,
    };
  }
  return { promote: false, verdict: 'rejected', reason: `配对先名率区间上界 ${ci.upper.toFixed(3)} ≤ 0.5，候选劣势`, ci, tieRate, anomalyRate };
}
