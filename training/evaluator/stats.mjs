/** 竞技评估统计工具：置信区间与晋级判定（任务书第七节）。
 * 晋级判断以胜率置信区间为主；平均分等指标仅作诊断，不得单独触发晋级。
 *
 * P0 可靠性整改（长期多重检验控制）：
 * 单次挑战的 95% 检验在长期反复挑战下必然累积误晋级（零假设下单次单侧误报 ≈ 2.5%，
 * 30 次独立挑战至少一次误报的概率 ≈ 53%，120 次 ≈ 95%，蒙特卡洛实测一致）。
 * 因此晋级检验采用「几何 alpha 消耗」：第 k 次确认挑战的单侧显著性取
 * α_k = ALPHA_BUDGET / 2^k（Σ_{k≥1} α_k = ALPHA_BUDGET），无论系统终身挑战多少次，
 * 家族误晋级率上界恒为 ALPHA_BUDGET（默认 5%）。挑战序号 k 来自验证种子账本的
 * challengeCount（每次确认挑战必记账，种子块互不重叠保证各次挑战统计独立）。
 */

const Z_95 = 1.959963984540054;
export { Z_95 };

/** 终身家族误晋级率预算（单侧）。第 k 次挑战单侧 α_k = 预算 / 2^k。 */
export const PROMOTION_ALPHA_BUDGET = 0.05;

/** 标准正态分布分位数函数（Acklam 算法，相对误差 < 1.2e-9）。
 * 用于按 alpha 消耗方案计算每次挑战的检验阈值 z_k = Φ⁻¹(1 − α_k)。 */
export function probit(p) {
  if (!(p > 0) || !(p < 1)) throw new Error(`probit 要求 p ∈ (0, 1)，实际：${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** 第 challengeIndex 次确认挑战的检验阈值（几何 alpha 消耗）。
 * @returns {{challengeIndex:number, alpha:number, z:number, alphaBudget:number}}
 * - alpha：本次挑战的单侧显著性水平 α_k = alphaBudget / 2^k；
 * - z：配对优势率 Wilson 区间应使用的分位数 z_k = Φ⁻¹(1 − α_k)。
 * k=1 时 α=0.025、z≈1.96，与旧制单次挑战完全一致；k 越大越严格。
 * 双精度极限：α < 1e-15 时 1−α 在浮点下等于 1，z 饱和于 Φ⁻¹(1−1e-15)≈7.94——
 * 对终身预算的影响 ≤ 1e-15/次（可忽略），账本挑战数达到该量级前阈值始终单调收紧。 */
export function alphaSpendingThreshold(challengeIndex, { alphaBudget = PROMOTION_ALPHA_BUDGET } = {}) {
  if (!Number.isSafeInteger(challengeIndex) || challengeIndex < 1) {
    throw new Error(`challengeIndex 必须为 ≥ 1 的整数（来自验证账本 challengeCount + 1），实际：${challengeIndex}`);
  }
  if (!Number.isFinite(alphaBudget) || alphaBudget <= 0 || alphaBudget >= 1) {
    throw new Error(`alphaBudget 必须为 (0, 1) 内的正数，实际：${alphaBudget}`);
  }
  const alpha = alphaBudget / 2 ** challengeIndex;
  return { challengeIndex, alpha, z: probit(1 - Math.max(alpha, 1e-15)), alphaBudget };
}

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
 * - 仅在分差非零的"决定性种子"上做配对得分优势率的 Wilson 检验（分差 > 0 记胜），
 *   分位数 z 由调用方按 alpha 消耗方案传入（缺省 95%，见 alphaSpendingThreshold）；
 * - 决定性种子数不足 minSeeds → 样本不足；
 * - 平局种子不计入二项分母，但披露平局率（平局率过高说明两版无法区分）。
 */
export function pairedPromotionDecision({ seedPairs, minSeeds = 60, maxAnomalyRate = 0.02, z = Z_95 }) {
  if (!Array.isArray(seedPairs) || seedPairs.length === 0) throw new Error('seedPairs 不能为空');
  const totalGames = seedPairs.length * 2;
  const anomalyGames = seedPairs.reduce((sum, p) => sum + (p.anomalies ?? 0), 0);
  const anomalyRate = totalGames ? anomalyGames / totalGames : 0;
  if (anomalyRate > maxAnomalyRate) {
    return { promote: false, verdict: 'rejected', reason: `异常率 ${anomalyRate.toFixed(3)} 超过上限 ${maxAnomalyRate}，先修复稳定性再挑战`, anomalyRate, z };
  }
  const finished = seedPairs.filter(p => p.status === 'finished');
  const decisive = finished.filter(p => p.diff !== 0);
  const wins = decisive.filter(p => p.diff > 0).length;
  const ties = finished.length - decisive.length;
  const tieRate = finished.length ? Number((ties / finished.length).toFixed(4)) : 0;
  if (decisive.length < minSeeds) {
    const ci = decisive.length ? wilsonCI(wins, decisive.length, z) : null;
    return { promote: false, verdict: 'insufficient', reason: `决定性种子 ${decisive.length} 不足（最少 ${minSeeds}）`, ci, tieRate, anomalyRate, z };
  }
  const ci = wilsonCI(wins, decisive.length, z);
  if (ci.lower > 0.5) {
    return {
      promote: true, verdict: 'promote',
      reason: `配对得分优势率 ${ci.point.toFixed(3)}（决定性种子 ${decisive.length}，平局率 ${tieRate}），CI 下界 ${ci.lower.toFixed(3)} > 0.5`,
      scoreAdvantageRate: ci.point,
      ci, tieRate, anomalyRate, z,
    };
  }
  if (ci.upper > 0.5) {
    return {
      promote: false, verdict: 'inconclusive',
      reason: `配对得分优势率区间 [${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}] 跨越 0.5，结果不确定，保留冠军并建议增加种子`,
      scoreAdvantageRate: ci.point,
      ci, tieRate, anomalyRate, z,
    };
  }
  return { promote: false, verdict: 'rejected', reason: `配对得分优势率区间上界 ${ci.upper.toFixed(3)} ≤ 0.5，候选劣势`, scoreAdvantageRate: ci.point, ci, tieRate, anomalyRate, z };
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
