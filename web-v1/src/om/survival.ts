/** TargetSurvivalModel：公开魔像目标存活概率与截胡风险（AI6 第三阶段·任务 E）。
 *
 * 输出：对当前公开魔像 g 与观察席位 v 的未来决策点 τ_k（v 的第 k 次自身行动），
 * 估计 P(g 在 τ_k 时仍位于公开市场)。
 *
 * 估计方式：与 ClaimETA 共享同一批按座位顺序推进的规则式随机 rollout。
 * 公共目标被唯一认领、先抢走者改变其余玩家的后续行为（目标重定向）、
 * 终局提前结束——全部由同一模拟轨迹内生地处理，绝不把各对手的独立
 * 抢牌概率相乘后冒充真实存活概率（任务书 E 纪律）。
 *
 * 与既有 golemSurvivalModel（M1，座位感知启发式公式）的关系：
 * 本模型是独立实现，二者在评测系统中做对照（Brier/ECE 校准比较）。
 */

import type { PublicSimState } from '../sim/index.js';
import { runRaceRollouts, type RaceRolloutBatch } from './rollout.js';
import type { PredictionContext, SurvivalPrediction } from './types.js';

/** 目标存活预测主入口。 */
export function predictSurvival(
  ctx: PredictionContext,
  golemId: string,
  horizon: number,
  viewerId?: number,
  batch?: RaceRolloutBatch,
  deadline?: number,
): SurvivalPrediction {
  const { state } = ctx;
  const viewer = viewerId ?? state.current;
  const notes: string[] = [];
  const H = Math.max(0, Math.floor(horizon));

  const pPresentAt = new Array<number>(H + 1).fill(0);
  const reachRate = new Array<number>(H + 1).fill(0);

  if (!state.golemMarket.includes(golemId)) {
    notes.push('目标魔像已不在公开市场');
    return {
      golemId, viewerId: viewer, horizon: H,
      pPresentAt: new Array<number>(H + 1).fill(0),
      reachRate: new Array<number>(H + 1).fill(0),
      jointReachPresent: new Array<number>(H + 1).fill(0),
      perRival: state.players.filter(p => p.id !== viewer).map(p => ({ playerId: p.id, pClaimWithin: 0 })),
      samples: 0, notes,
    };
  }

  // k=0：当前时刻（决定性：魔像在场即为 1，不经 rollout）。
  pPresentAt[0] = 1;
  reachRate[0] = 1;

  if (state.phase === 'finished') {
    notes.push('对局已结束：未来决策点不存在');
    for (let k = 1; k <= H; k++) { pPresentAt[k] = 0; reachRate[k] = 0; }
    return {
      golemId, viewerId: viewer, horizon: H, pPresentAt, reachRate,
      jointReachPresent: pPresentAt.map((p, k) => p * reachRate[k]),
      perRival: state.players.filter(p => p.id !== viewer).map(p => ({ playerId: p.id, pClaimWithin: 0 })),
      samples: 0, notes,
    };
  }

  const records = (batch ?? runRaceRollouts(state, ctx.history, golemId, ctx, ctx.config.rollouts, deadline)).records;
  const samples = records.length || 1;
  const rivalClaim = new Map<number, number>();
  for (const p of state.players) if (p.id !== viewer) rivalClaim.set(p.id, 0);

  for (const rec of records) {
    // 决策点 τ_k 的存活性与到达率（条件于观察席位到达该决策点的口径见 reachRate）。
    for (let k = 1; k <= H; k++) {
      const reached = rec.presence[viewer]?.length >= k;
      if (reached) {
        reachRate[k] += 1;
        if (rec.presence[viewer][k - 1]) pPresentAt[k] += 1;
      }
      // 未到达（对局提前结束）：决策点不存在，不计入条件样本。
    }
    const claim = rec.claims[0];
    if (claim && claim.playerId !== viewer) {
      rivalClaim.set(claim.playerId, (rivalClaim.get(claim.playerId) ?? 0) + 1);
    }
  }
  for (let k = 1; k <= H; k++) {
    pPresentAt[k] = reachRate[k] > 0 ? pPresentAt[k] / reachRate[k] : 0;
    reachRate[k] /= samples;
  }
  const jointReachPresent = pPresentAt.map((p, k) => p * reachRate[k]);
  const perRival = [...rivalClaim.entries()]
    .map(([pid, c]) => ({ playerId: pid, pClaimWithin: c / samples }))
    .sort((a, b) => b.pClaimWithin - a.pClaimWithin);

  return { golemId, viewerId: viewer, horizon: H, pPresentAt, reachRate, jointReachPresent, perRival, samples: records.length, notes };
}

/** 批量便捷入口：全部公开魔像的存活预测（Joint Search 消费形态）。 */
export function predictAllSurvivals(
  ctx: PredictionContext,
  horizon?: number,
  deadline?: number,
): SurvivalPrediction[] {
  const { state, config } = ctx;
  const H = horizon ?? config.horizon;
  const out: SurvivalPrediction[] = [];
  for (const golemId of state.golemMarket) {
    const batch = runRaceRollouts(state, ctx.history, golemId, ctx, config.rollouts, deadline);
    out.push(predictSurvival(ctx, golemId, H, state.current, batch, deadline));
  }
  return out;
}
