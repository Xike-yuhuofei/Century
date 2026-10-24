/** Selective Joint Tree：关键己方决策点的选择性分支展开（AI6 第四阶段·任务 C）。
 *
 * PR #26 修复（P0-1 搜索树时序）后的结构：
 *
 *   根行动（我）→ [对手行动：概率模型采样，合法多人状态转移]
 *   → 轮到我 → expandMyNode（top-M 分支 max，仅当 current === mySeat）
 *   → 每个分支推进到我的下一个决策点 → 递归 / 启发式联合 rollout 续推
 *
 * 严格时序不变量（回归测试 tests/joint-pr26-regression.test.mjs 强制）：
 * 1. 己方分支展开只发生在 current === mySeat 的节点（v1 缺陷：根行动后未推进
 *    对手回合就直接展开"己方"分支——initialState 按 view.current 取行动者，
 *    实际展开的是对手的候选集，并以我方 leaf 价值取 max ⇒ 对手被最优化为我方行动）；
 * 2. 对手行动一律经 sampleOpponentAction 合法采样 + sim.step 精确转移；
 * 3. 溢出弃置按正式引擎语义（溢出回合不推进座位，弃置后 finishAction）；
 * 4. 兄弟分支持有独立预算计数（v1 缺陷：共享 transitions 计数使先探索的分支
 *    吃掉后续分支的视野，值依赖兄弟求值顺序）；
 * 5. 终局价值一律取正式规则 ranking（绝不用启发式替代）。
 */

import type { Action } from '../engine.js';
import { ranking } from '../engine.js';
import type { PublicSimulation } from '../sim/session.js';
import { mulberry32 } from '../sim/rng.js';
import { heuristicContext, myRankedActions, discardDecision } from './rollout-policy.js';
import { createOpponentContext, sampleOpponentAction } from './opponents.js';
import { firstPlaceOf, trialRngSeed, type RolloutContext } from './joint-rollout.js';
import { evaluateLeaf } from './evaluators.js';
import { PressureCache, profileByName } from './simview.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';

/** 树搜索上下文（复用 RolloutContext + 树参数）。 */
export type TreeContext = RolloutContext & {
  treeBranching: number;
  treeDepth: number;
};

/** 树内预算计数（P0-1 修复：兄弟分支各自持有，不再共享可变状态）。 */
type TreeBudget = { transitions: number; reachedTerminal: boolean; totalTransitions: number };

/** 推进到我的下一个决策点（对手节点采样）或终局。返回是否到达我的决策点。 */
function advanceUntilMyTurn(sim: PublicSimulation, rng: () => number, ctx: TreeContext, budget: TreeBudget): boolean {
  const opponentCtx = createOpponentContext(ctx.mode, ctx.om);
  while (!sim.finished && sim.view.current !== ctx.mySeat) {
    if (budget.transitions >= ctx.horizon) return false;
    if (ctx.deadline !== undefined && performance.now() > ctx.deadline) return false;
    const state = sim.view;
    const actor = state.current;
    let action: Action | null = null;
    if (state.phase === 'overflow') {
      // 溢出回合不推进座位（正式引擎 finishAction 语义）：弃置仍属当前玩家。
      action = { type: 'discard', colors: discardDecision(state.players[actor].stock, state.golemMarket, CHAMPION_PARAMETERS) };
    } else {
      const sample = sampleOpponentAction(state, rng, opponentCtx, ms => { ctx.omTimeMs && (ctx.omTimeMs.value += ms); });
      action = sample?.action ?? { type: 'rest' };
    }
    try {
      sim.step(action);
    } catch {
      return false;
    }
    ctx.stepLog?.push({ seat: actor, action });
    budget.transitions += 1;
    budget.totalTransitions += 1;
  }
  if (sim.finished) budget.reachedTerminal = true;
  return !sim.finished && sim.view.current === ctx.mySeat;
}

/** 己方决策节点展开（选择性分支 + 递归 max）。
 * 前置不变量：current === mySeat（内部防御性推进，违背即缺陷）。 */
function expandMyNode(sim: PublicSimulation, depthLeft: number, rng: () => number, ctx: TreeContext, budget: TreeBudget): number {
  if (sim.finished) { budget.reachedTerminal = true; return firstPlaceOf(sim.view, ctx.mySeat) ? 1 : 0; }
  if (budget.transitions >= ctx.horizon || (ctx.deadline !== undefined && performance.now() > ctx.deadline)) {
    return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  }
  // P0-1 时序不变量的防御性自愈：未轮到我时先推进对手回合（正常路径由
  // advanceUntilMyTurn 保证；此分支仅捕获根调用/溢出后的遗漏情形）。
  if (sim.view.current !== ctx.mySeat) {
    if (!advanceUntilMyTurn(sim, rng, ctx, budget)) {
      return sim.finished
        ? (firstPlaceOf(sim.view, ctx.mySeat) ? 1 : 0)
        : evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
    }
  }
  if (depthLeft <= 0) {
    // 叶子：启发式联合 rollout 续推（单条；对手继续采样）。
    return playTrajectoryFrom(sim, rng, ctx, budget);
  }
  const state = sim.view;
  // 溢出：强制弃置（单分支；弃置后座位推进，须先回到我的决策点再展开）。
  if (state.phase === 'overflow') {
    const action: Action = { type: 'discard', colors: discardDecision(state.players[state.current].stock, state.golemMarket, CHAMPION_PARAMETERS) };
    const branch = sim.fork();
    try { branch.step(action); } catch { return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf); }
    ctx.stepLog?.push({ seat: state.current, action });
    budget.transitions += 1;
    budget.totalTransitions += 1;
    if (branch.finished) { budget.reachedTerminal = true; return firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0; }
    if (!advanceUntilMyTurn(branch, rng, ctx, budget)) {
      return branch.finished
        ? (firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0)
        : evaluateLeaf(branch.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
    }
    return expandMyNode(branch, depthLeft, rng, ctx, budget);
  }
  const ctxH = heuristicContext(state, CHAMPION_PARAMETERS, profileByName(ctx.profileName), new PressureCache());
  const ranked = myRankedActions(state, ctx.mySeat, ctxH).ranked;
  if (!ranked.length) return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  const topM = ranked.slice(0, Math.max(1, ctx.treeBranching));
  let best = -Infinity;
  for (const candidate of topM) {
    // P0-1 修复：兄弟分支独立预算（共享计数会让先探索的分支吃掉后续分支视野，
    // 返回值依赖兄弟求值顺序）；totalTransitions 只作统计聚合。
    const siblingBudget: TreeBudget = { transitions: 0, reachedTerminal: false, totalTransitions: budget.totalTransitions };
    const branch = sim.fork();
    try { branch.step(candidate.action); } catch { continue; }
    ctx.stepLog?.push({ seat: state.current, action: candidate.action });
    siblingBudget.transitions += 1;
    siblingBudget.totalTransitions += 1;
    let v: number;
    if (branch.finished) {
      siblingBudget.reachedTerminal = true;
      v = firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0;
    } else if (!advanceUntilMyTurn(branch, rng, ctx, siblingBudget)) {
      v = branch.finished
        ? (firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0)
        : evaluateLeaf(branch.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
    } else {
      v = expandMyNode(branch, depthLeft - 1, rng, ctx, siblingBudget);
    }
    budget.totalTransitions = Math.max(budget.totalTransitions, siblingBudget.totalTransitions);
    budget.reachedTerminal ||= siblingBudget.reachedTerminal;
    if (v > best) best = v;
  }
  if (best === -Infinity) return evaluateLeaf(sim.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  return best;
}

/** 从当前状态续推启发式轨迹（tree 叶子；与 joint-rollout 同一循环语义）。 */
function playTrajectoryFrom(sim: PublicSimulation, rng: () => number, ctx: TreeContext, budget: TreeBudget): number {
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
    ctx.stepLog?.push({ seat: actor, action });
    budget.transitions += 1;
    budget.totalTransitions += 1;
  }
  if (sim.finished) budget.reachedTerminal = true;
  return evaluateLeaf(sim.view, sim.finished, ctx.mySeat, ctx.evaluator, firstPlaceOf);
}

/** 根行动树评估（PR #26 修复后）：fork → 根行动 → 推进对手回合到我的决策点
 * → expandMyNode（treeDepth 层己方分支）。world/replica 语义同 runJointRollout。 */
export function runJointTreeTrial(
  root: PublicSimulation,
  rootAction: Action,
  world: number,
  replica: number,
  simSeed: number,
  ctx: TreeContext,
): { value: number; transitions: number; finished: boolean; finalRank: number | null } {
  const branch = root.fork();
  branch.step(rootAction);
  ctx.stepLog?.push({ seat: root.view.current, action: rootAction });
  const rng = mulberry32(trialRngSeed(simSeed, world, replica));
  const budget: TreeBudget = { transitions: 1, reachedTerminal: false, totalTransitions: 1 };
  let value: number;
  if (branch.finished) {
    budget.reachedTerminal = true;
    value = firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0;
  } else if (!advanceUntilMyTurn(branch, rng, ctx, budget)) {
    // 未能在视野内回到我的决策点：终局取正式规则值，否则叶子估值。
    value = branch.finished
      ? (firstPlaceOf(branch.view, ctx.mySeat) ? 1 : 0)
      : evaluateLeaf(branch.view, false, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  } else {
    value = expandMyNode(branch, Math.max(1, ctx.treeDepth), rng, ctx, budget);
  }
  // 终局名次用正式规则 ranking（P0-1 要求：绝不用启发式近似替代）。
  const finalRank = branch.finished
    ? ranking({ players: branch.view.players } as unknown as Parameters<typeof ranking>[0]).findIndex(r => r.id === ctx.mySeat) + 1
    : null;
  return { value, transitions: budget.totalTransitions, finished: budget.reachedTerminal, finalRank };
}
