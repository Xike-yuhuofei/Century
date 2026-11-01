// Power feasibility given observed paired-delta variance (research only).
const VAR = Number(process.env.VAR ?? 0.33);
const zAlpha = 2.6380; // one-sided alpha = 0.05/12 = 0.0041667
const zBeta = 0.8416;
const seats = 4;
const sdPerCount = (n) => Math.sqrt(VAR / n);
const sdWeighted = (n) => Math.sqrt(VAR / (seats * n));
const power = (effect, sd) => {
  const z = effect / sd - zAlpha;
  return 0.5 * (1 + erf(z / Math.SQRT2));
};
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const rows = [];
for (const n of [313, 400, 500, 600, 800, 1000]) {
  const p2 = power(0.02, sdWeighted(n));
  const p5 = power(0.05, sdWeighted(n));
  const p8 = power(0.08, sdWeighted(n));
  const p10 = power(0.10, sdWeighted(n));
  // non-inferiority per count: lower bound = delta - zAlpha*sdPerCount > -0.02
  const niMarginOf = (delta, n2) => delta - zAlpha * sdPerCount(n2);
  const niAt0p5 = niMarginOf(0.05, n);
  rows.push({ nPerSeatCount: n, gamesTotal: n * seats * 2, sdWeighted: +sdWeighted(n).toFixed(4), sdPerCount: +sdPerCount(n).toFixed(4),
    powerPlus2: +p2.toFixed(3), powerPlus5: +p5.toFixed(3), powerPlus8: +p8.toFixed(3), powerPlus10: +p10.toFixed(3),
    niLowerBoundIfTruePlus5: +niAt0p5.toFixed(4) });
}
console.table(rows);
console.log(JSON.stringify({ VAR, zAlpha, rows }));
