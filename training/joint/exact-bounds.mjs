/** Clopper–Pearson 精确界（第五阶段 A2：零胜/全胜场的正确不确定性披露）。
 *
 * 与 training/baseline/stats.mjs 的 firstPlaceClusterCI 内联公式同源
 * （0/n 胜 95% 单侧上界 = 1 − 0.025^(1/n)；n/n 胜对称下界 = 0.025^(1/n)），
 * 抽出共享实现供 compare.mjs 配对比较使用。
 */

/** @param {number} n 样本局数 @param {'upper'|'lower'} side */
export function clopperPearsonBound(n, side) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`n 必须为正整数，实际：${n}`);
  return side === 'upper'
    ? Number((1 - Math.pow(0.025, 1 / n)).toFixed(4))
    : Number(Math.pow(0.025, 1 / n).toFixed(4));
}
