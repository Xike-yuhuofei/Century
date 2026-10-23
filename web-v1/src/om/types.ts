/** Opponent Model V1 共享类型（AI6 第三阶段·任务 F）。
 *
 * 模块定位：src/om/ 是独立的对手行为与竞争风险预测组件，供后续 Joint Search
 * V1 与独立评测消费。不进入正式网页 AI（src/ai）决策路径，不改变冠军行为。
 *
 * 信息边界：全部输入为 PublicSimState + PublicHistorySummary（公开信息）；
 * 不接触隐藏牌序、不使用真实游戏 RNG；预测随机流来自显式 simSeed（mulberry32）。
 */

import type { Action } from '../engine.js';
import type { PublicHistorySummary, PublicSimState } from '../sim/index.js';

// === 风格分类（工程假设，非玩家真实心理类型） ===

export type StyleKey = 'rush' | 'engine' | 'coin' | 'contest' | 'balanced';

export const STYLE_KEYS: readonly StyleKey[] = ['rush', 'engine', 'coin', 'contest', 'balanced'];

/** 风格权重（Σ=1）。风格先验经公开行动历史的贝叶斯式证据更新得到。 */
export type StyleWeights = Record<StyleKey, number>;

/** 风格证据（对数域贡献量，可解释审计用）。 */
export type StyleEvidence = Record<StyleKey, number>;

// === 任务 B：行动分布 ===

export type ActionFamily = 'claim' | 'produce' | 'upgrade' | 'trade' | 'acquire' | 'rest' | 'discard';

/** 单个合法行动的打分与概率（含解释字段）。 */
export type ScoredAction = {
  action: Action;
  family: ActionFamily;
  /** 规则特征得分（softmax 前的 logit）。 */
  score: number;
  /** 概率（全体合法行动 Σ=1；非法行动不在列表中 = 概率严格为零）。 */
  p: number;
  /** 特征解释（主要贡献项）。 */
  explain: string;
};

export type ActionDistribution = {
  playerId: number;
  entries: ScoredAction[];
  temperature: number;
  /** 该行动者当前的风格混合（M4 启用时来自历史更新；否则先验）。 */
  style: StyleWeights;
  notes: string[];
};

// === 任务 C：意图分布 ===

export type IntentEntry = {
  golemId: string;
  p: number;
  /** 综合效用（softmax 前的 logit）。 */
  utility: number;
  explain: {
    coverage: number;
    engineAffinity: number;
    actionsNeeded: number;
    historyMatch: number;
    contested: number;
    styleFit: number;
  };
};

export type IntentDistribution = {
  playerId: number;
  /** 对当前公开魔像的目标概率（归一到 1−noSpecificTarget）。 */
  golems: IntentEntry[];
  /** 不针对当前任何具体魔像的战略质量（建引擎/资源准备/无明确目标）。 */
  noSpecificTarget: number;
  style: StyleWeights;
  styleEvidence: StyleEvidence;
  /** 不确定性 [0,1]：目标分布熵 + 数据量不足惩罚。 */
  uncertainty: number;
  notes: string[];
};

// === 任务 D：认领 ETA 分布 ===

export type ClaimETADistribution = {
  playerId: number;
  golemId: string;
  /** 预测窗口（该玩家未来第 k 次自身行动，k=1..horizon）。 */
  horizon: number;
  /** 最早规则可达时间（贪心直线规划的可达自身行动序数；1 = 下一次自身行动即可认领）。
   * null = 窗口内不可达（blockedBy 说明原因）。这是规则可达估计，不是对手实际选择。 */
  earliestRuleEstimate: number | null;
  earliestRuleBlockedBy: 'stolen' | 'ended' | 'unreachable' | null;
  /** P(第 k 次自身行动时认领)，下标 k-1，k=1..horizon。 */
  pClaimAt: number[];
  /** 累计认领概率 CDF（与 pClaimAt 一致前缀和）。 */
  cumulative: number[];
  /** 窗口内未认领概率（含被抢/终局/未认领）。 */
  pBeyond: number;
  /** 窗口内被其他玩家抢走的概率（竞争事件，与 pClaimAt 互斥）。 */
  pStolenBefore: number;
  /** 窗口内游戏结束（目标未认领）的概率。 */
  pGameEnded: number;
  samples: number;
  notes: string[];
};

// === 任务 E：目标存活预测 ===

export type SurvivalPrediction = {
  golemId: string;
  /** 观察席位（存活时点按该席位的未来决策点计）。 */
  viewerId: number;
  horizon: number;
  /** P(g 在观察席位第 k 次自身行动时点仍在公开市场)，下标 k，k=0..horizon
   * （k=0 = 当前时刻；条件于观察席位能到达该决策点的 rollout 子集，reachRate 披露）。 */
  pPresentAt: number[];
  /** 到达各决策点的 rollout 比例（终局提前结束会 <1）。 */
  reachRate: number[];
  /** 联合概率 P(到达第 k 决策点 ∧ g 仍在场) = reachRate[k] × pPresentAt[k]
   * （事件嵌套 ⇒ 数学上保证非增；Joint Search 的"我还能拿到它"口径）。 */
  jointReachPresent: number[];
  /** 各对手在窗口内抢走该目标的概率（按真实行动顺序模拟，非独立相乘）。 */
  perRival: { playerId: number; pClaimWithin: number }[];
  samples: number;
  notes: string[];
};

// === 模型配置 ===

export type OpponentModelOptions = {
  /** 预测随机流基础种子（默认 0；相同状态 + 相同种子 ⇒ 相同预测）。 */
  seed?: number;
  /** 竞争 rollout 采样数（默认 24）。 */
  rollouts?: number;
  /** 存活预测默认视野（观察席位未来自身行动数，默认 3）。 */
  horizon?: number;
  /** ETA 默认窗口（默认 4）。 */
  etaHorizon?: number;
  /** 行动 softmax 温度（默认 0.8）。 */
  temperature?: number;
  /** 启用公开历史特征（M3+；false = M0/M2 口径）。 */
  useHistory?: boolean;
  /** 启用风格贝叶斯混合更新（M4；false = 静态先验）。 */
  useHistoryStyle?: boolean;
  /** 单次预测时间预算毫秒（超时提前截断 rollout，samples 如实披露）。 */
  budgetMs?: number;
  /** 预测缓存容量（按状态键 LRU；0 = 禁用）。 */
  cacheSize?: number;
};

export type ResolvedModelConfig = {
  seed: number;
  rollouts: number;
  horizon: number;
  etaHorizon: number;
  temperature: number;
  useHistory: boolean;
  useHistoryStyle: boolean;
  budgetMs: number;
  cacheSize: number;
};

export function resolveConfig(options?: OpponentModelOptions): ResolvedModelConfig {
  return {
    seed: options?.seed ?? 0,
    rollouts: Math.max(1, options?.rollouts ?? 24),
    horizon: Math.max(1, options?.horizon ?? 3),
    etaHorizon: Math.max(1, options?.etaHorizon ?? 4),
    temperature: options?.temperature ?? 0.8,
    useHistory: options?.useHistory ?? true,
    useHistoryStyle: options?.useHistoryStyle ?? true,
    budgetMs: options?.budgetMs ?? 250,
    cacheSize: options?.cacheSize ?? 256,
  };
}

/** 预测上下文：状态 + 历史 + 配置（各子模型共用）。 */
export type PredictionContext = {
  state: Readonly<PublicSimState>;
  history: Readonly<PublicHistorySummary>;
  config: ResolvedModelConfig;
};
