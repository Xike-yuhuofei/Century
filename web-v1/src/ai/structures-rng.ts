/** 结构模块专用确定性随机源（mulberry32）。
 * 独立文件以保持 structures.ts 零引擎依赖；训练侧 lib/rng.mjs 是同名算法的
 * 独立实现，二者数值一致但互不引用（AI 核心不得反向依赖训练目录）。
 */

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
