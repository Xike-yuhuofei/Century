/**
 * AI12 可行性测算：在观测到的配对方差下，冻结口径（α=0.05/12、IUT 非劣效）需要多大样本、
 * 以及真实 +2pp 情形本身能否被该设计识别。
 *
 * 观测方差来源：training/reports/ai12-research/screen-results.json 中 14 个配对实验的
 * sd(delta) ≈ 0.41–0.76（按人数），综合加权 sd ≈ 0.55–0.65 → Var(delta) ≈ 0.30–0.42；
 * 本脚本缺省取 0.33 作为中性估计，并允许 --var 覆盖。
 *
 * 用法：node training/reports/ai12-research/harness/feasibility.mjs [--var 0.33]
 */
const VAR = Number((process.argv.find((a, i) => process.argv[i - 1] === '--var')) ?? 0.33);
const ALPHA_PER_CHALLENGE = 0.05 / 12; // 固定期限家族 Bonferroni
const SEATS = 4;
const Z_ALPHA = 2.6380; // 单侧 Φ⁻¹(1 − 1/240)
const Z_BETA = 0.8416; // 80% 功效

function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const power = (effect, sd) => normalCdf(effect / sd - Z_ALPHA);
const sdWeighted = (n) => Math.sqrt(VAR / (SEATS * n));
const sdPerCount = (n) => Math.sqrt(VAR / n);

const rows = [313, 400, 500, 600, 800, 1000].map(n => ({
  seedsPerSeatCount: n,
  totalPairedGames: n * SEATS * 2,
  sdWeighted: +sdWeighted(n).toFixed(4),
  sdPerCount: +sdPerCount(n).toFixed(4),
  powerEffect2pp: +power(0.02, sdWeighted(n)).toFixed(3),
  powerEffect5pp: +power(0.05, sdWeighted(n)).toFixed(3),
  powerEffect8pp: +power(0.08, sdWeighted(n)).toFixed(3),
  nonInferiorityLowerBoundIfTrueDelta5pp: +(0.05 - Z_ALPHA * sdPerCount(n)).toFixed(4),
}));

const requiredSeeds = (effect) => Math.ceil(VAR / SEATS * ((Z_ALPHA + Z_BETA) / effect) ** 2);
console.log(JSON.stringify({
  schema: 'century-ai12-feasibility-v1',
  varianceUsed: VAR,
  alphaPerChallenge: ALPHA_PER_CHALLENGE,
  zAlpha: Z_ALPHA,
  powerTarget: 0.8,
  seedsPerSeatCountRequired: {
    effect2pp: requiredSeeds(0.02),
    effect5pp: requiredSeeds(0.05),
    effect8pp: requiredSeeds(0.08),
    effect10pp: requiredSeeds(0.10),
  },
  table: rows,
  note: "非劣效逐人数检验与主检验均在 α=1/240 下执行（IUT），故每个人数自身的下界也必须以该 z 计算；+2pp 真实效应在单次期限挑战内基本不可识别",
}, null, 2));
