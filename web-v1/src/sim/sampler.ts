/** BeliefDeckSampler：未知牌库信念采样（AI6 第二阶段·任务 B）。
 *
 * 目标：在不知道真实牌库顺序的前提下，为搜索模拟提供符合公开信息约束的
 * 未来翻牌序列。采样只依赖"剩余未知卡集合"（公开可推导），与正式游戏的
 * 真实隐藏牌序、正式游戏随机种子彻底隔离。
 *
 * 契约：
 * - 输入 unseen 为剩余未知卡集合（无顺序语义）；输出为该集合的一个全排列
 *   （模拟队列，队首 = 下一次翻牌），多重集必须与输入一致（session 创建时强制校验）。
 * - 相同集合 + 相同采样随机流 ⇒ 相同输出（可重复）。
 * - 不同随机流 ⇒ 不同未来牌序（轨迹多样性）。
 * - Common Random Numbers：采样在 session 创建时执行一次，fork 复制队列，
 *   因此同一 root 的所有分支共享同一随机世界（对照方差降低）。
 * - 采样队列属于模拟器内部状态，对 AI 决策函数物理不可见（ES #private 封装）。
 *
 * 测试注入：differential harness 通过传入自定义 sampler 实现对象
 * （返回测试预设的翻牌序列）来注入真实剩余牌序作为预设条件；
 * 生产代码路径永远使用 randomBeliefSampler。
 */

import { mulberry32, shuffled } from './rng.js';

export interface BeliefDeckSampler {
  /** 为剩余未知商人卡集合采样一个模拟翻牌队列（队首 = 下一次翻开）。 */
  sampleMerchantDeck(unseen: readonly string[]): string[];
  /** 为剩余未知魔像卡集合采样一个模拟翻牌队列（队首 = 下一次翻开）。 */
  sampleGolemDeck(unseen: readonly string[]): string[];
}

/** 生产默认采样器：以 mulberry32(seed) 为独立随机流，对未知集合做均匀无放回洗牌。
 * 与正式游戏牌库随机数（engine LCG）零共享。缺省 seed = 0（确定性优先，
 * 可复现性由显式 simSeed 控制）。 */
export function randomBeliefSampler(seed: number): BeliefDeckSampler {
  const random = mulberry32(seed >>> 0);
  return {
    sampleMerchantDeck: (unseen: readonly string[]): string[] => shuffled(unseen, random),
    sampleGolemDeck: (unseen: readonly string[]): string[] => shuffled(unseen, random),
  };
}
