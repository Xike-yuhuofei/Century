/** ClaimETAModel：魔像认领时间预测（AI6 第三阶段·任务 D）。
 *
 * 输出（对每名对手 j、每张公开魔像 g）：
 * - P(对手 j 在未来第 k 次自身行动时认领 g)——按自身行动序数的概率分布；
 * - 最早规则可达时间（贪心直线规划，独立于概率分布——两者严格区分）；
 * - 指定窗口内的累计认领概率与窗口外质量（未认领/被抢/终局）。
 *
 * 估计方式：固定策略的浅层概率 rollout（OpponentPolicyV1 驱动全部席位，
 * 信念采样未来翻牌，按真实行动顺序推进）。不假设对手以最短路径行动，
 * 不实现完整 Joint MCTS（任务书约束）。
 *
 * 删失与竞争事件的正确处理：目标被他人抢走、游戏结束、窗口内未认领
 * 三类结果显式分离（pStolenBefore / pGameEnded / pBeyond），绝不在
 * "成功认领样本"子集上单独计算误差口径。
 */

import type { PublicSimState } from '../sim/index.js';
import { featurePack } from './features.js';
import { greedyBeelineEstimate, runRaceRollouts, type RaceRolloutBatch } from './rollout.js';
import type { ClaimETADistribution, PredictionContext } from './types.js';

/** 认领 ETA 预测主入口。 */
export function predictClaimETA(
  ctx: PredictionContext,
  playerId: number,
  golemId: string,
  horizon: number,
  batch?: RaceRolloutBatch,
  deadline?: number,
): ClaimETADistribution {
  const { state } = ctx;
  const notes: string[] = [];
  const H = Math.max(1, Math.floor(horizon));
  const pClaimAt = new Array<number>(H).fill(0);

  if (!state.golemMarket.includes(golemId)) {
    notes.push('目标魔像已不在公开市场（已被认领/不存在）：全部质量归入窗口外');
    return zeroETA(ctx, playerId, golemId, H, 'golem-not-in-market', notes);
  }
  if (state.phase === 'finished') {
    notes.push('对局已结束');
    return zeroETA(ctx, playerId, golemId, H, 'finished', notes);
  }

  const records = (batch ?? runRaceRollouts(state, ctx.history, golemId, ctx, ctx.config.rollouts, deadline)).records;
  const samples = records.length || 1;
  let stolen = 0;
  let ended = 0;
  for (const rec of records) {
    const claim = rec.claims.find(c => c.playerId === playerId);
    if (claim) {
      // 本人在 k≤H 认领 → 计入分布；k>H → 落入 pBeyond（本人认领但晚于窗口）。
      if (claim.k <= H) pClaimAt[claim.k - 1] += 1;
    } else if (rec.claims.length > 0) {
      stolen += 1;
    } else if (rec.finished) {
      ended += 1;
    }
  }
  const cumulative: number[] = [];
  let acc = 0;
  for (let k = 0; k < H; k++) {
    acc += pClaimAt[k];
    cumulative.push(acc / samples);
  }
  for (let k = 0; k < H; k++) pClaimAt[k] /= samples;
  const pStolenBefore = stolen / samples;
  const pGameEnded = ended / samples;
  const pBeyond = Math.max(0, 1 - cumulative[H - 1]);

  // 最早规则可达时间（贪心直线规划，与概率分布严格分离）。
  const beeline = greedyBeelineEstimate(state, ctx.history, playerId, golemId, ctx);
  if (beeline.k !== null && beeline.k > H) {
    notes.push(`贪心可达时间 k=${beeline.k} 超出预测窗口 ${H}`);
  }

  return {
    playerId, golemId, horizon: H,
    earliestRuleEstimate: beeline.k,
    earliestRuleBlockedBy: beeline.blockedBy,
    pClaimAt, cumulative, pBeyond,
    pStolenBefore, pGameEnded,
    samples: records.length,
    notes,
  };
}

function zeroETA(
  ctx: PredictionContext,
  playerId: number,
  golemId: string,
  horizon: number,
  reason: string,
  notes: string[],
): ClaimETADistribution {
  void ctx;
  return {
    playerId, golemId, horizon,
    earliestRuleEstimate: null,
    earliestRuleBlockedBy: reason === 'finished' ? 'ended' : 'stolen',
    pClaimAt: new Array<number>(horizon).fill(0),
    cumulative: new Array<number>(horizon).fill(0),
    pBeyond: 1, pStolenBefore: 0, pGameEnded: 0,
    samples: 0,
    notes: [...notes, `reason:${reason}`],
  };
}

/** 批量便捷入口：全部对手 × 全部公开魔像（Joint Search 消费形态）。 */
export function predictAllClaimETAs(
  ctx: PredictionContext,
  horizon?: number,
  deadline?: number,
): ClaimETADistribution[] {
  const { state, config } = ctx;
  const pack = featurePack(state);
  void pack;
  const H = horizon ?? config.etaHorizon;
  const out: ClaimETADistribution[] = [];
  for (const golemId of state.golemMarket) {
    const batch = runRaceRollouts(state, ctx.history, golemId, ctx, config.rollouts, deadline);
    for (const p of state.players) {
      if (p.id === state.current) continue; // 对手口径；当前席位由决策器自评
      out.push(predictClaimETA(ctx, p.id, golemId, H, batch, deadline));
    }
  }
  return out;
}
