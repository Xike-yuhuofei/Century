/** Selective Joint Tree：关键己方决策点的选择性分支展开（AI6 第四阶段·任务 C）。
 *
 * 与 Joint Rollout 的差异：轨迹中"轮到我"的决策点不再一律走启发式贪心，
 * 而是在关键节点（前 treeDepth 层己方决策点）展开 top-M 候选分支，
 * 对手节点保持概率模型采样（不对手分支——成本纪律，任务 E）。
 *
 * 结构：
 *   expandMyNode(sim, depthLeft):
 *     finished            → 正式规则终局值
 *     depthLeft == 0      → 启发式联合 rollout 续推至叶子（单条）
 *     否则                 → top-M 候选各开分支，推进到我的下一个决策点，递归 max
 *   根行动价值 = K 条独立 trial（对手重采样）的均值
 *
 * 我方节点取 max（行动由我控制）；对手不确定性由 trial 间均值吸收。
 */

import type { Action } from '../engine.js';
import { ranking } from '../engine.js';
import type { PublicSimulation } from '../sim/session.js';
import { mulberry32 } from '../sim/rng.js';
import { heuristicContext, myRankedActions, discardDecision } from './rollout-policy.js';
import { createOpponentContext, sampleOpponentAction } from './opponents.js';
import { firstPlaceOf } from './joint-rollout.js';
import { evaluateLeaf } from './evaluators.js';
import { PressureCache, profileByName } from './simview.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';
import type { RolloutContext } from './joint-rollout.js';

/** 树搜索上下文（复用 RolloutContext + 树参数）。 */
export type TreeContext = RolloutContext & {
  treeBranching: number;
  treeDepth: number;
};

/** 推进到我的下一个决策点（对手节点采样）或终局。返回是否到达我的决策点。 */
function advanceUntilMyTurn(sim: PublicSimulation, rng: () => number, ctx: TreeContext, budget: { transitions: number; reachedTerminal: boolean }): boolean {
  const opponentCtx = createOpponentContext(ctx.mode, ctx.om);
  while (!sim.finished && sim.view.current !== ctx.mySeat) {
    if (budget.transitions >= ctx.horizon) return false;
    if (ctx.deadline !== undefined && performance.now() > ctx.deadline) return false;
    const state = sim.view;
    let action: Action | null = null;
    if (state.phase === 'overflow') {
      action = { type: 'discard', colors: discardDecision(state.players[state.current].stock, state.golemMarket, CHAMPION_PARAMETERS) };
    } else {
      const sample = sampleOpponentAction(state, rng, opponentCtx, ms => { ctx.omTimeMs && (ctx.omTimeMs.value += ms); });
      action = sample?.action ?? { type: 'rest' };
    }
    try {
      sim.step(action);
    } catch {
      return false;
    }
    budget.transitions += 1;
  }
  if (sim.finished) budget.reachedTerminal = true;
  return !sim.finished && sim.view.current === ctx.mySeat;
}

/** 己方决策节点展开（选择性分支 + 递归 max）。 */
function expandMyNode(sim: PublicSimulation, depthLeft: number, rng: () => number, ctx: TreeContext, budget: { transitions: number; reachedTerminal: boolean }): number {
  if (sim.finished) { budget.reachedTerminal = true; return firstPlaceOf(sim.view, ctx.mySeat) ? 1 : 0; }
  if (budget.transitions >= ctx.horizon || (ctx.deadline !== undefined && performance.now() > ctx.deadline)) {
    return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  }
  if (depthLeft <= 0) {
    // 叶子：启发式联合 rollout 续推（单条；对手继续采样）。
    const outcome = playTrajectoryFrom(sim, rng, ctx, budget);
    return outcome;
  }
  const state = sim.view;
  // 溢出：强制弃置（单分支）。
  if (state.phase === 'overflow') {
    const action: Action = { type: 'discard', colors: discardDecision(state.players[state.current].stock, state.golemMarket, CHAMPION_PARAMETERS) };
    const branch = sim.fork();
    try { branch.step(action); } catch { return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf); }
    budget.transitions += 1;
    return expandMyNode(branch, depthLeft, rng, ctx, budget);
  }
  const ctxH = heuristicContext(state, CHAMPION_PARAMETERS, profileByName(ctx.profileName), new PressureCache());
  const ranked = myRankedActions(state, ctx.mySeat, ctxH).ranked;
  if (!ranked.length) return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  const topM = ranked.slice(0, Math.max(1, ctx.treeBranching));
  let best = -Infinity;
  for (const candidate of topM) {
    const branch = sim.fork();
    try { branch.step(candidate.action); } catch { continue; }
    budget.transitions += 1;
    if (branch.finished) {
      const v = firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0;
      if (v > best) best = v;
      continue;
    }
    // 推进到我的下一个决策点（对手采样），再展开。
    if (!advanceUntilMyTurn(branch, rng, ctx, budget)) {
      const v = branch.finished
        ? (firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0)
        : evaluateLeaf(branch.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
      if (v > best) best = v;
      continue;
    }
    const v = expandMyNode(branch, depthLeft - 1, rng, ctx, budget);
    if (v > best) best = v;
  }
  if (best === -Infinity) return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  return best;
}

/** 从当前状态续推启发式轨迹（tree 叶子；与 joint-rollout 同一循环语义）。 */
function playTrajectoryFrom(sim: PublicSimulation, rng: () => number, ctx: TreeContext, budget: { transitions: number; reachedTerminal: boolean }): number {
  const opponentCtx = createOpponentContext(ctx.mode, ctx.om);
  const pressureCache = new PressureCache();
  while (!sim.finished && budget.transitions < ctx.horizon) {
    if (ctx.deadline !== undefined && performance.now() > ctx.deadline) break;
    const state = sim.view;
    const actor = state.current;
    let action: Action | null = null;
    if (actor === ctx.mySeat) {
      if (state.phase === 'overflow') {
        action = { type: 'discard', colors: discardDecision(state.players[actor].stock, state.golemMarket, CHAMPION_PARAMETERS) };
      } else {
        const ctxH = heuristicContext(state, CHAMPION_PARAMETERS, profileByName(ctx.profileName), pressureCache);
        const ranked = myRankedActions(state, actor, ctxH).ranked;
        action = ranked[0]?.action ?? { type: 'rest' };
      }
    } else {
      const sample = sampleOpponentAction(state, rng, opponentCtx, ms => { ctx.omTimeMs && (ctx.omTimeMs.value += ms); });
      action = sample?.action ?? { type: 'rest' };
    }
    if (!action) break;
    try { sim.step(action); } catch { break; }
    budget.transitions += 1;
  }
  if (sim.finished) budget.reachedTerminal = true;
  return evaluateLeaf(sim.view, sim.finished, ctx.mySeat, ctx.evaluator, firstPlaceOf);
}

/** 根行动树评估：fork → 根行动 → expandMyNode（treeDepth 层己方分支）。 */
export function runJointTreeTrial(
  root: PublicSimulation,
  rootAction: Action,
  trialIndex: number,
  simSeed: number,
  ctx: TreeContext,
): { value: number; transitions: number; finished: boolean; finalRank: number | null } {
  const branch = root.fork();
  branch.step(rootAction);
  const rng = mulberry32((simSeed ^ (trialIndex * 0x9E3779B9)) >>> 0);
  const budget = { transitions: 1, reachedTerminal: false };
  const value = expandMyNode(branch, Math.max(1, ctx.treeDepth), rng, ctx, budget);
  return { value, transitions: budget.transitions, finished: budget.reachedTerminal, finalRank: budget.reachedTerminal ? (value >= 0.5 ? 1 : null) : null };
}
