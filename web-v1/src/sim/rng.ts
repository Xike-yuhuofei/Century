/** 公共模拟器专用确定性随机源（mulberry32）。
 *
 * 与 ai/structures-rng.ts、training/lib/rng.mjs 是同名算法的独立实现，
 * 数值一致但互不引用——公共模拟器必须保持模块独立（AI6 第二阶段任务书 G），
 * 且模拟随机流必须与正式游戏的牌库随机数（engine.createGame 的 LCG 种子流）
 * 严格隔离（任务书 B：模拟随机数与真实牌库随机数零共享）。
 */

/** 确定性 32 位 PRNG。相同种子产生完全相同的均匀 [0,1) 随机流。 */
export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 无放回洗牌（与正式引擎 createGame 的 shuffled 同一算法族）。
 * 返回新数组，不修改输入；相同随机流 + 相同输入 ⇒ 相同输出（可重复性）。 */
export function shuffled<T>(array: readonly T[], random: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
