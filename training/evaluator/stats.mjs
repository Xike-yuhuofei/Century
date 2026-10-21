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

/** 按种子配对的晋级判定（审计整改：P1 统计可信度；P1 复审：指标命名修正）。
 *
 * 同一 seed 的双向对局共享洗牌序列与座位结构，是配对样本而非独立样本；
 * 把 2×seeds 局当独立样本计算 Wilson 区间会低估方差、放大显著性。
 *
 * 指标定义（重要，不得混称）：
 * - 本判定的统计量是「配对得分优势率」：决定性种子中，候选双向平均分差 > 0 的比例。
 *   它衡量相对得分优势，**不是**取得第一名的概率，任何报告不得称之为"先名率/第一名率"。
 * - 真实的第一名率（候选阵营 rank-1 局占比）由 challenge.mjs 的 summary.firstPlace
 *   单独计算并随证据披露，作为晋级判定的解释性辅助指标（局级 Wilson 区间为配对近似）。
 *
 * 规则：
 * - 以 seed 为统计单位，每 seed 一个配对分差（双向平均：候选均分 − 对手均分）；
 * - 异常率仍按局计算，超限直接拒绝；
 * - 仅在分差非零的"决定性种子"上做配对得分优势率的 Wilson 95% 检验（分差 > 0 记胜）；
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
      reason: `配对得分优势率 ${ci.point.toFixed(3)}（决定性种子 ${decisive.length}，平局率 ${tieRate}），95% CI 下界 ${ci.lower.toFixed(3)} > 0.5`,
      scoreAdvantageRate: ci.point,
      ci, tieRate, anomalyRate,
    };
  }
  if (ci.upper > 0.5) {
    return {
      promote: false, verdict: 'inconclusive',
      reason: `配对得分优势率区间 [${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}] 跨越 0.5，结果不确定，保留冠军并建议增加种子`,
      scoreAdvantageRate: ci.point,
      ci, tieRate, anomalyRate,
    };
  }
  return { promote: false, verdict: 'rejected', reason: `配对得分优势率区间上界 ${ci.upper.toFixed(3)} ≤ 0.5，候选劣势`, scoreAdvantageRate: ci.point, ci, tieRate, anomalyRate };
}

/** 真实第一名率统计（P1 复审新增：与配对得分优势率严格区分）。
 *
 * 输入为 challenge.mjs 的 finished 局列表（含 direction 与 candidateWon）：
 * - 方向 A：候选占 1 席，candidateWon = 候选本人取得第一名；
 * - 方向 B：候选占 4 席，candidateWon = 候选阵营取得第一名；
 * - 合并：双向合并第一名率，无优势零假设下期望恰为 0.5。
 * 注意：合并区间的二项检验把 2×seeds 局当独立样本（同种子两局相关），
 * 属于配对近似，只作诊断披露，不得单独触发晋级。
 */
export function firstPlaceStats(games, { z = Z_95 } = {}) {
  const finished = games.filter(g => g.status === 'finished');
  const pick = direction => finished.filter(g => g.direction === direction);
  const block = list => {
    const wins = list.filter(g => g.candidateWon).length;
    return { wins, games: list.length, rate: list.length ? wins / list.length : null };
  };
  const merged = block(finished);
  const result = {
    definition: '候选阵营取得第一名（rank 1）的局占比；方向 A=候选 1 席，方向 B=候选 4 席；合并后零优势期望 0.5',
    directionA: block(pick('A')),
    directionB: block(pick('B')),
    merged: { ...merged },
  };
  if (merged.games > 0) {
    result.merged.wilsonCI = wilsonCI(merged.wins, merged.games, z);
    result.merged.note = '局级 Wilson 区间把配对局当独立样本，属近似，仅诊断用；晋级判定以 pairedPromotionDecision 为准';
  }
  return result;
}
