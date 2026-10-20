/** 训练系统可复现随机源（mulberry32）。仅供候选生成与实验抽样使用；
 * 对局内部的洗牌随机性完全由正式引擎的种子发生器承担。 */
export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 高斯扰动（Box–Muller），用于进化候选生成。 */
export function gaussian(random) {
  let u = 0, v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
