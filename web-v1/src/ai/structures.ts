/** AI 结构变体框架（任务书第六节延伸：结构级挑战，而非仅参数扰动）。
 *
 * 冠军结构 'beam-lineage' = 束搜索 + 血统救援（基线）。
 * 变体通过 choosePlan 的 structure 入口参与冠军挑战，全部：
 * - 只消费 AIObservation 公开信息（信息公平性与主结构一致，静态扫描强制）；
 * - 完全确定性：rollout 随机性来自状态哈希派生的种子，无 Math.random，
 *   同一种子与配置下决策逐位可复现；
 * - 行动合法性由 decision.ts 的正式引擎核验兜底，与主结构一致。
 *
 * 'beam-contest'（Issue #20）：beam-rollout + 座位感知目标存活折扣——
 * 在 rollout 评估之外，用 golemSurvivalModel 依据座位顺序与对手可达费用
 * 对每个目标的路线期望乘以存活系数，使后手 AI 不再与必被截胡的目标死磕。
 */

import { mulberry32 } from './structures-rng.js';

export type AIStructure = 'beam-lineage' | 'beam-adaptive' | 'beam-rollout' | 'beam-contest';

export const AI_STRUCTURES: readonly AIStructure[] = ['beam-lineage', 'beam-adaptive', 'beam-rollout', 'beam-contest'];

export const DEFAULT_STRUCTURE: AIStructure = 'beam-lineage';

/** 归一化结构标识：undefined/缺省 → 冠军结构；未知值抛错。 */
export function normalizeStructure(input?: string | null): AIStructure {
  if (input === undefined || input === null || input === '') return DEFAULT_STRUCTURE;
  if (AI_STRUCTURES.includes(input as AIStructure)) return input as AIStructure;
  throw new Error(`未知 AI 结构：${String(input)}（可选：${AI_STRUCTURES.join(' / ')}）`);
}

/** 束宽度自适应（beam-adaptive 变体）：
 * 前置宽、后置窄——浅层扩大探索（更多转换路线进入束），深层收窄聚焦。
 * 纯层号/深度/基准宽的确定性函数，无任何时间或随机因素。
 * depth=6、base=14 时约为 22/20/18/15/13/10；depth=3、base=10 时为 16/10/4。 */
export function adaptiveWidth(layer: number, depth: number, base: number): number {
  const t = depth <= 1 ? 0 : (layer - 1) / (depth - 1);
  return Math.max(4, Math.round(base * (1.6 - 1.2 * t)));
}

/** 确定性 rollout 随机源：由状态键 + 目标 + 回合 + 序号派生种子。
 * 同一局面同一序号必然同一随机序列——可复现性不因结构变体而破坏。 */
export function structureRng(stateKey: string, preferred: string, turnNumber: number, rolloutIndex: number): () => number {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  mix(stateKey);
  mix(preferred);
  mix(String(turnNumber));
  mix(String(rolloutIndex));
  return mulberry32(hash >>> 0);
}

/** rollout 求值默认配置（成本上界：候选数 × 次数 × 步数）。 */
export const ROLLOUT_DEFAULTS = {
  /** 每个 preferred 的最终束中参与 rollout 的候选数（按公式分预排序）。 */
  topK: 10,
  /** 每候选 rollout 次数。 */
  rollouts: 5,
  /** 每次 rollout 最大行动步数。 */
  stepCap: 8,
  /** rollout 与公式先验的混合权重（rollout 占比）。 */
  blend: 0.7,
} as const;
