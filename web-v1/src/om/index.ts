/** OpponentModel：对手行为与竞争风险预测的统一接口（AI6 第三阶段·任务 F）。
 *
 * 为 Joint Search V1 提供结构化概率输出：
 * - predictAction    下一步行动分布（任务 B）
 * - predictIntent    战略意图分布（任务 C）
 * - predictClaimETA  认领时间分布（任务 D）
 * - predictSurvival  目标存活概率（任务 E）
 *
 * 工程约束：
 * - 完全本地离线；Node 与浏览器通用（纯 TS，无 DOM/Node API）；
 * - 不依赖 LLM API；不暴露隐藏牌序；不使用真实游戏 RNG；
 * - 相同公开状态 + 相同预测种子 ⇒ 逐位可复现（种子显式传入）；
 * - 按状态键 + 历史摘要指纹的 LRU 预测缓存；明确的预测时间预算；
 * - 输出携带解释字段（explain / notes / styleEvidence / samples）；
 * - 现有冠军默认不调用本模块（正式对局行为不变）。
 *
 * M0–M4 评测口径（经 OpponentModelOptions 配置）：
 * - M0：无历史规则先验（useHistory=false, useHistoryStyle=false）；
 * - M2：规则式行动与 ETA（rollout 驱动，无历史特征）；
 * - M3：M2 + 公开历史特征（useHistory=true, useHistoryStyle=false）；
 * - M4：M3 + 风格贝叶斯混合（全量配置）。
 * - M1（既有 golemSurvivalModel / pressureModel 启发式）为独立对照，
 *   见评测脚本 scripts/om-eval.mjs，不在本模块内。
 */

import {
  hashPublicState, historyDigest, type PublicHistorySummary, type PublicSimState,
} from '../sim/index.js';
import { featurePack } from './features.js';
import { predictIntent as computeIntent } from './intent.js';
import { predictActionDistribution as computeActionDistribution } from './policy.js';
import { predictClaimETA as computeClaimETA } from './eta.js';
import { predictSurvival as computeSurvival } from './survival.js';
import { runRaceRollouts, type RaceRolloutBatch } from './rollout.js';
import {
  resolveConfig,
  type ActionDistribution, type ClaimETADistribution, type IntentDistribution,
  type OpponentModelOptions, type PredictionContext, type ResolvedModelConfig,
  type SurvivalPrediction,
} from './types.js';

export type { OpponentModelOptions } from './types.js';

/** 统一对手模型接口（任务 F 建议接口的落地形态）。 */
export interface OpponentModel {
  readonly version: string;
  predictAction(
    state: Readonly<PublicSimState>,
    playerId: number,
    history?: Readonly<PublicHistorySummary>,
  ): ActionDistribution;
  predictIntent(
    state: Readonly<PublicSimState>,
    playerId: number,
    history?: Readonly<PublicHistorySummary>,
  ): IntentDistribution;
  predictClaimETA(
    state: Readonly<PublicSimState>,
    playerId: number,
    golemId: string,
    horizon?: number,
  ): ClaimETADistribution;
  predictSurvival(
    state: Readonly<PublicSimState>,
    golemId: string,
    horizon?: number,
  ): SurvivalPrediction;
  /** 显式观察席位版本：非当前席位决策时使用（viewerId 缺省 = state.current）。 */
  predictSurvivalFor(
    state: Readonly<PublicSimState>,
    golemId: string,
    horizon: number | undefined,
    viewerId: number,
  ): SurvivalPrediction;
  /** 调试与性能审计：缓存命中 / rollout 执行数 / 累计耗时。 */
  stats(): Readonly<ModelStats>;
}

export type ModelStats = {
  cacheHits: number;
  cacheMisses: number;
  rolloutsRun: number;
  totalMs: number;
};

const MODEL_VERSION = 'om-v1.0.0';

/** 假设分支：把行动者切到指定席位（overflow 归属其他席位时回到 turn 阶段）。 */
function hypotheticalCurrent(state: Readonly<PublicSimState>, playerId: number): PublicSimState {
  const cloned = structuredClone(state) as PublicSimState;
  cloned.current = playerId;
  if (cloned.phase === 'overflow' && cloned.current !== state.current) cloned.phase = 'turn';
  return cloned;
}

/** 创建 OpponentModel 实例（无全局状态；多实例互不干扰）。 */
export function createOpponentModel(options?: OpponentModelOptions): OpponentModel {
  const config: ResolvedModelConfig = resolveConfig(options);
  const cache = new Map<string, unknown>();
  const stats: ModelStats = { cacheHits: 0, cacheMisses: 0, rolloutsRun: 0, totalMs: 0 };

  function cacheGet<T>(key: string): T | undefined {
    if (config.cacheSize <= 0) return undefined;
    const hit = cache.get(key);
    if (hit !== undefined) {
      // LRU 触碰：删除后重插保持新鲜度序。
      cache.delete(key);
      cache.set(key, hit);
      stats.cacheHits += 1;
      return hit as T;
    }
    stats.cacheMisses += 1;
    return undefined;
  }

  function cachePut<T>(key: string, value: T): void {
    if (config.cacheSize <= 0) return;
    cache.set(key, value);
    while (cache.size > config.cacheSize) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  }

  function ctxOf(state: Readonly<PublicSimState>, history?: Readonly<PublicHistorySummary>): PredictionContext {
    return { state, history: history ?? state.historySummary, config };
  }

  const model: OpponentModel = {
    version: MODEL_VERSION,

    predictAction(state, playerId, history) {
      const t0 = performance.now();
      // 非当前席位：克隆状态并把行动者切到目标席位（"若为其行动"的假设分支），
      // 使合法行动枚举与特征评分都以目标席位为行动者。
      const targetState = playerId === state.current
        ? state
        : hypotheticalCurrent(state, playerId);
      const ctx = ctxOf(targetState, history);
      const key = `A|${hashPublicState(targetState)}|${historyDigest(ctx.history)}|${playerId}|${config.temperature}|${config.useHistory}|${config.useHistoryStyle}`;
      const cached = cacheGet<ActionDistribution>(key);
      if (cached) { stats.totalMs += performance.now() - t0; return cached; }
      const pack = featurePack(targetState);
      // 行动者风格/意图（predictAction 关注该席位的行动倾向）。
      const style = config.useHistoryStyle
        ? computeIntent(ctx, playerId, pack).style
        : computeIntent({ ...ctx, config: { ...config, useHistoryStyle: false } }, playerId, pack).style;
      const intent = computeIntent(ctx, playerId, pack);
      const dist = computeActionDistribution({
        state: targetState, history: ctx.history, temperature: config.temperature, style, intent, pack,
      });
      cachePut(key, dist);
      stats.totalMs += performance.now() - t0;
      return dist;
    },

    predictIntent(state, playerId, history) {
      const t0 = performance.now();
      const ctx = ctxOf(state, history);
      const key = `I|${hashPublicState(state)}|${historyDigest(ctx.history)}|${playerId}|${config.useHistory}|${config.useHistoryStyle}`;
      const cached = cacheGet<IntentDistribution>(key);
      if (cached) { stats.totalMs += performance.now() - t0; return cached; }
      const pack = featurePack(state);
      const intent = computeIntent(ctx, playerId, pack);
      cachePut(key, intent);
      stats.totalMs += performance.now() - t0;
      return intent;
    },

    predictClaimETA(state, playerId, golemId, horizon) {
      const t0 = performance.now();
      const ctx = ctxOf(state);
      const H = Math.max(1, Math.floor(horizon ?? config.etaHorizon));
      const key = `E|${hashPublicState(state)}|${historyDigest(ctx.history)}|${playerId}|${golemId}|${H}|${config.rollouts}|${config.seed}`;
      const cached = cacheGet<ClaimETADistribution>(key);
      if (cached) { stats.totalMs += performance.now() - t0; return cached; }
      // 与 survival 共享同一批 rollout（同状态同目标一次模拟）。
      const shared = getRaceBatch(state, golemId);
      const result = computeClaimETA(ctx, playerId, golemId, H, shared, t0 + config.budgetMs);
      cachePut(key, result);
      stats.totalMs += performance.now() - t0;
      return result;
    },

    predictSurvival(state, golemId, horizon) {
      const t0 = performance.now();
      const ctx = ctxOf(state);
      const H = Math.max(0, Math.floor(horizon ?? config.horizon));
      const key = `S|${hashPublicState(state)}|${historyDigest(ctx.history)}|${state.current}|${golemId}|${H}|${config.rollouts}|${config.seed}`;
      const cached = cacheGet<SurvivalPrediction>(key);
      if (cached) { stats.totalMs += performance.now() - t0; return cached; }
      const shared = getRaceBatch(state, golemId);
      const result = computeSurvival(ctx, golemId, H, state.current, shared, t0 + config.budgetMs);
      cachePut(key, result);
      stats.totalMs += performance.now() - t0;
      return result;
    },

    /** 观察席位显式指定的存活预测（Joint Search 在任意席位决策时使用）。 */
    predictSurvivalFor(state, golemId, horizon, viewerId) {
      const t0 = performance.now();
      const ctx = ctxOf(state);
      const H = Math.max(0, Math.floor(horizon ?? config.horizon));
      const key = `S|${hashPublicState(state)}|${historyDigest(ctx.history)}|${viewerId}|${golemId}|${H}|${config.rollouts}|${config.seed}`;
      const cached = cacheGet<SurvivalPrediction>(key);
      if (cached) { stats.totalMs += performance.now() - t0; return cached; }
      const shared = getRaceBatch(state, golemId);
      const result = computeSurvival(ctx, golemId, H, viewerId, shared, t0 + config.budgetMs);
      cachePut(key, result);
      stats.totalMs += performance.now() - t0;
      return result;
    },

    stats: () => ({ ...stats }),
  };

  /** race batch 缓存（rollout 批次跨 ETA/Survival 与席位共享；随 LRU 管理）。 */
  function getRaceBatch(state: Readonly<PublicSimState>, golemId: string): RaceRolloutBatch {
    const ctx = ctxOf(state);
    const key = `R|${hashPublicState(state)}|${historyDigest(ctx.history)}|${golemId}|${config.rollouts}|${config.seed}|${config.temperature}|${config.useHistory}|${config.useHistoryStyle}`;
    const cached = cacheGet<RaceRolloutBatch>(key);
    if (cached) return cached;
    const deadline = performance.now() + config.budgetMs;
    const batch = runRaceRollouts(state, ctx.history, golemId, ctx, config.rollouts, deadline);
    stats.rolloutsRun += batch.records.length;
    cachePut(key, batch);
    return batch;
  }

  return model;
}

export { resolveConfig };
export type {
  ActionDistribution, ClaimETADistribution, IntentDistribution, SurvivalPrediction,
  ScoredAction, IntentEntry, StyleKey, StyleWeights, StyleEvidence,
} from './types.js';
export { STYLE_KEYS } from './types.js';
