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
