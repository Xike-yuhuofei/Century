/** 联合搜索的己方启发式策略与根行动筛选（AI6 第四阶段·任务 C 第 3 步）。
 *
 * 复用正式冠军的已验证组件：
 * - ai/planner.initialState / actions：搜索状态构造与候选行动枚举（冠军同源代码）；
 * - ai/evaluator.acquisitionValue / trimStock / goalGap：获取估值（含冠军
 *   readiness-efficiency 变体）、超额弃置、费用缺口；
 * - ai/knowledge.engineValue / weighted：引擎价值与水晶权重；
 * - ai/opponent-model.pressureModel / golemSurvivalModel：竞争压力与座位感知存活。
 *
 * 局部转移镜像（localStep）：ai/planner.step 未导出（保持冠军源文件字节不变），
 * 本模块按冠军 step 的语义逐条镜像一份 SearchState 级 1-ply 转移，专用于
 * 轨迹内 1-ply 评分。正确性由 differential 测试锚定：随机状态 × 全部合法行动
 * 下，localStep 的公开后继必须与 PublicSimulation.fork().step() 逐字段一致
 * （tests/joint-sim.test.mjs）。
 *
 * 求值公式按冠军 searchGrade/routeGrade 权重逐项浅层重表达（保证"使用现有
 * 强冠军启发式进行候选排序"，任务 C.3）。本模块只服务联合搜索的轨迹内策略
 * 与根筛选，不是正式决策路径。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import type { Action, Color } from '../engine.js';
import { has } from '../engine.js';
import type { AIParameters } from '../ai/parameters.js';
import type { AIObservation } from '../ai/observation.js';
import { initialState, actions as championActions, type SearchState } from '../ai/planner.js';
import { acquisitionValue, goalGap, trimStock, keepValue } from '../ai/evaluator.js';
import { weighted, engineValue } from '../ai/knowledge.js';
import { pressureModel, golemSurvivalModel, type PressureModel } from '../ai/opponent-model.js';
import type { Profile } from '../ai/profiles.js';
import { simViewToObservation, type PressureCache } from './simview.js';

/** 轨迹内求值上下文（一次 decide() 共享）。 */
export type HeuristicContext = {
  params: AIParameters;
  profile: Profile;
  pressure: PressureModel;
  /** 终局紧迫度 stage（冠军口径：(1 − mostClaimed/threshold)^endgameWeight）。 */
  stage: number;
  allowAcquire: boolean;
};

/** 从模拟状态构造求值上下文（每次己方/对手决策点调用；pressure 允许缓存复用）。 */
export function heuristicContext(
  state: Parameters<typeof simViewToObservation>[0],
  params: AIParameters,
  profile: Profile,
  pressureCache?: PressureCache,
): HeuristicContext {
  const view = simViewToObservation(state, state.current);
  const mostClaimed = Math.max(...state.players.map(p => p.claimed.length));
  const rawStage = state.triggerPlayer !== null ? 0 : Math.max(.12, 1 - mostClaimed / (state.players.length >= 4 ? 5 : 6));
  return {
    params, profile,
    pressure: pressureCache ? pressureCache.get(state, state.current) : pressureModel(view),
    stage: Math.pow(rawStage, params.endgameWeight),
    allowAcquire: state.triggerPlayer === null,
  };
}

/** 冠军 searchGrade 公式的浅层镜像（1-ply 用；权重与 ai/planner.searchGrade 一致）。
 * futureSupport 在轨迹内省略（成本；根筛选经 screenRootActions 的目标无关项补偿）。 */
function searchGradeLite(
  next: SearchState,
  preferred: string | null,
  ctx: HeuristicContext,
): number {
  const goal = preferred ? GOLEM_BY_ID[preferred] : null;
  const gap = goal ? goalGap(next.stock, goal) : 0;
  return -gap * 2.6 + weighted(next.stock) * .13 * ctx.params.capacityWeight
    + engineValue(next, preferred) * ctx.stage * .22 * ctx.profile.engine * ctx.params.engineWeight
    + next.newCards.reduce((sum, id) => sum + acquisitionValue(next, id, preferred, ctx.profile, ctx.pressure, ctx.params), 0) * ctx.stage * .35
    - next.steps * .35 * ctx.profile.tempo * ctx.params.tempoWeight
    - next.acquired * .15;
}

/** 冠军 routeGrade 公式的浅层镜像（完成目标路线的单位行动得分效率）。 */
function routeGradeLite(next: SearchState, preferred: string | null, ctx: HeuristicContext): number {
  return next.gained * ctx.profile.tempo * ctx.params.tempoWeight / Math.pow(next.steps + .65, .90)
    + weighted(next.stock) * .055 * ctx.params.capacityWeight
    + engineValue(next, preferred) * ctx.stage * .085 * ctx.profile.engine * ctx.params.engineWeight;
}

/** 局部 1-ply 转移镜像（冠军 ai/planner.step 的逐条镜像；differential 锚定）。
 * 与冠军版本唯一的语义差异：不建模市场补牌（未知翻牌，冠军束搜索同样不建模）。 */
export function localStep(
  state: SearchState,
  action: Action,
  preferred: string | null,
  params: AIParameters,
): SearchState | null {
  if (state.terminal) return null;
  const next: SearchState = {
    ...state, stock: [...state.stock] as Stock, hand: [...state.hand], played: [...state.played],
    merchantMarket: state.merchantMarket, golemMarket: state.golemMarket,
    steps: state.steps + 1, first: state.first ?? action, path: [...state.path, action],
  };
  if (action.type === 'play') {
    const card = MERCHANT_BY_ID[action.cardId];
    if (!card) return null;
    const i = next.hand.indexOf(action.cardId);
    if (i < 0) return null;
    if (card.kind === 'create') card.output!.forEach((n, c) => { next.stock[c] += n; });
    else if (card.kind === 'upgrade') {
      for (const c of action.steps ?? []) {
        if (!next.stock[c]) return null;
        next.stock[c]--; next.stock[c + 1]++;
      }
    } else {
      for (let i = 0; i < (action.repeats ?? 1); i++) {
        if (!has(next.stock, card.input!)) return null;
        card.input!.forEach((n, c) => { next.stock[c] -= n; });
        card.output!.forEach((n, c) => { next.stock[c] += n; });
      }
    }
    next.hand.splice(i, 1);
    next.played.push(action.cardId);
  } else if (action.type === 'rest') {
    next.hand.push(...next.played);
    next.played = [];
  } else if (action.type === 'acquire') {
    const offer = state.merchantMarket[action.index];
    if (!offer) return null;
    for (const color of action.payment) {
      if (!next.stock[color]) return null;
      next.stock[color]--;
    }
    offer.bonus.forEach((n, c) => { next.stock[c] += n; });
    next.hand.push(offer.id);
    next.newCards = [...state.newCards, offer.id];
    next.merchantMarket = state.merchantMarket.filter((_, i) => i !== action.index);
    next.acquired++;
  } else if (action.type === 'claim') {
    const id = state.golemMarket[action.index];
    if (!id) return null;
    const golem = GOLEM_BY_ID[id];
    if (!golem || !has(next.stock, golem.cost)) return null;
    golem.cost.forEach((n, c) => { next.stock[c] -= n; });
    let coin = 0;
    if (action.index === 0) {
      if (next.copper) { next.copper--; coin = 3; }
      else if (next.silver) { next.silver--; coin = 1; }
    } else if (action.index === 1 && next.copper && next.silver) {
      next.silver--; coin = 1;
    }
    next.gained += golem.points + coin;
    next.golemMarket = state.golemMarket.filter((_, i) => i !== action.index);
    next.claimed++;
    next.terminal = next.claimed >= next.remainingClaims;
  } else {
    return null; // discard 在联合搜索根层由 trimStock 口径直接处理。
  }
  next.stock = trimStock(next.stock, next.golemMarket, preferred, params).stock;
  return next;
}

/** 1-ply 行动价值。认领行动走 routeGrade 语义（即时得分效率：联合搜索中
 * 每个可负担认领都是真实得分机会，与冠军"仅完成偏好目标才计 gained"的束内
 * 语义不同——束搜索的目标内嵌性不适用于根层全量行动筛选，否则会系统性屏蔽
 * 高分认领，正是任务书 §三 警告的屏蔽缺陷）。其余行动走 searchGrade。
 *
 * 休息回收激励：冠军束搜索用血统救援（restFallback）逐层保留"休息→再转换"
 * 路线席位（V4.0 修复的"休息饿死"缺陷）；贪心 1-ply 策略没有等价机制，
 * 实测会把对局打成了 23 次 acquire / 1 次 rest / 1 次 claim 的囤卡开局
 * （84 步仅得 12 分）。这里为 rest 加回收激励：已打出卡越多、手牌越空，
 * rest 的回收价值越高（restWeight 参数接入，与冠军语义一致）。 */
export function actionValue(
  state: SearchState,
  action: Action,
  preferred: string | null,
  ctx: HeuristicContext,
): number {
  const next = localStep(state, action, preferred, ctx.params);
  if (!next) return -Infinity;
  if (action.type === 'claim') return routeGradeLite(next, preferred, ctx);
  const base = next.terminal ? routeGradeLite(next, preferred, ctx) : searchGradeLite(next, preferred, ctx);
  if (action.type === 'rest' && state.played.length > 0) {
    // 回收激励 = 已打出卡数 × restWeight；手牌为空时额外加成（无牌可打，必须回收）。
    const relief = 0.55 * state.played.length + (state.hand.length === 0 ? 1.2 : 0);
    return base + relief * ctx.params.restWeight;
  }
  return base;
}

/** 己方启发式决策（轨迹内"轮到我"时调用；state.current 必须等于 mySeat）。
 * 返回按价值降序的候选行动（首个 = 贪心选择；列表供 joint-tree 分支复用）。 */
export function myRankedActions(
  state: Parameters<typeof simViewToObservation>[0],
  mySeat: number,
  ctx: HeuristicContext,
): { search: SearchState; preferred: string | null; ranked: { action: Action; value: number }[] } {
  const view = simViewToObservation(state, mySeat);
  const search = initialState(view);
  // 目标偏好：市场魔像按分值潜力选优（轨迹内市场真实变化，逐决策点重选——
  // 这正是 Issue #20 修复点：市场变化后目标立即重新计算）。
  let preferred: string | null = null;
  let bestGoal = -Infinity;
  for (const id of search.golemMarket) {
    const goal = GOLEM_BY_ID[id];
    if (!goal) continue;
    const score = goal.points - 2.6 * goalGap(search.stock, goal);
    if (score > bestGoal) { bestGoal = score; preferred = id; }
  }
  const variants = championActions(search, preferred, ctx.allowAcquire, ctx.params);
  const ranked = variants
    .map(action => ({ action, value: actionValue(search, action, preferred, ctx) }))
    .filter(x => Number.isFinite(x.value))
    .sort((a, b) => b.value - a.value);
  return { search, preferred, ranked };
}

/** 根行动先验筛选分（任务 C.3：冠军启发式候选排序）。
 * claim 分两种情形（PR #26 P0-2 修复）：
 * - 立即认领（本回合即可执行）：对手没有插足机会，存活系数 = 1——绝不以
 *   "未来被抢概率"惩罚当步可完成的认领（v1 缺陷：立即认领被 golemSurvivalModel
 *   的未来存活折扣压低，S1/S5b 类盘面下高价值认领在先验中被系统性推迟）；
 * - 未来目标规划（非 claim 行动）：按 0.6 + 0.4×survival 弱折扣保持路线相关性，
 *   把"目标可能被截胡"的风险计入长线 acquire/转配决策。 */
export function screenRootActions(
  view: AIObservation,
  rootActions: readonly Action[],
  ctx: HeuristicContext,
  survival: Record<string, number>,
): { action: Action; prior: number }[] {
  const search = initialState(view);
  // 立即认领判定：观察者是当前行动者且库存足额（合法枚举保证 claim 均可支付）。
  const iAmCurrent = view.current === view.playerId;
  const myStock = iAmCurrent ? view.players[view.playerId].stock : null;
  // 根筛选逐行动对其最相关目标取最好值。
  const scored = rootActions.map(action => {
    let best = -Infinity;
    const goals: (string | null)[] = action.type === 'claim' ? [view.golemMarket[action.index]] : [null, ...view.golemMarket];
    for (const preferred of goals) {
      const value = actionValue(search, action, preferred, ctx);
      if (!Number.isFinite(value)) continue;
      let adjusted = value;
      if (action.type === 'claim' && preferred) {
        const immediate = !!myStock && payableClaim(myStock, preferred);
        adjusted *= immediate ? 1 : (survival[preferred] ?? 1);
      } else if (preferred) {
        adjusted *= 0.6 + 0.4 * (survival[preferred] ?? 1);
      }
      if (adjusted > best) best = adjusted;
    }
    return { action, prior: Number.isFinite(best) ? best : -Infinity };
  });
  return scored.sort((a, b) => b.prior - a.prior);
}

/** 根目标存活表（冠军 golemSurvivalModel 包装：公开信息，成本 O(玩家×市场)）。 */
export function rootSurvival(view: AIObservation, depthRounds: number): Record<string, number> {
  return golemSurvivalModel(view, depthRounds >= 2 ? 6 : depthRounds === 1 ? 3 : 1);
}

/** 溢出弃置决策（冠军 trimStock 同一口径；overflow 阶段唯一合法行动族）。 */
export function discardDecision(
  stock: readonly number[],
  golemMarket: readonly string[],
  params: AIParameters,
): Color[] {
  return trimStock([...stock] as Stock, golemMarket, null, params).discarded as Color[];
}

/** 1-ply 局部镜像与模拟器转移的一致性检查入口（differential 测试用）：
 * 给定 SearchState 与行动，返回局部镜像的公开后继摘要；测试侧与
 * PublicSimulation.fork().step() 的结果逐字段比对。 */
export function localSuccessorSummary(
  state: SearchState,
  action: Action,
  preferred: string | null,
  params: AIParameters,
): { stock: string; hand: string; played: string; merchant: string; golem: string; gained: number } | null {
  const next = localStep(state, action, preferred, params);
  if (!next) return null;
  return {
    stock: next.stock.join(','),
    hand: [...next.hand].sort().join(','),
    played: [...next.played].sort().join(','),
    merchant: next.merchantMarket.map((m: { id: string; bonus: Stock }) => `${m.id}:${m.bonus.join(',')}`).join(';'),
    golem: next.golemMarket.join(','),
    gained: next.gained,
  };
}

/** 支付候选（keepValue top-K；冠军 payments 口径的显式复用入口）。
 * K=3 与冠军一致；根层全量合法集不受此影响（根层用 enumerateLegalActions）。 */
export function topPayments(
  stock: readonly number[],
  index: number,
  goals: readonly string[],
  preferred: string | null,
  params: AIParameters,
  k = 3,
): Color[][] {
  if (index === 0) return [[]];
  const result: Array<{ payment: number[]; value: number }> = [];
  function walk(color: number, left: number, selected: number[], rest: Stock) {
    if (color === 4) {
      if (left === 0) result.push({ payment: selected, value: keepValue(rest, goals, preferred, params) });
      return;
    }
    for (let n = 0; n <= Math.min(stock[color], left); n++) {
      const next = [...rest] as Stock;
      next[color] -= n;
      walk(color + 1, left - n, [...selected, ...Array(n).fill(color)], next);
    }
  }
  walk(0, index, [], [...stock] as Stock);
  result.sort((a, b) => b.value - a.value || a.payment.join('').localeCompare(b.payment.join('')));
  return result.slice(0, k).map(x => x.payment as Color[]);
}

/** 检查魔像是否可支付（防御性）。 */
export function payableClaim(stock: readonly number[], golemId: string): boolean {
  const goal = GOLEM_BY_ID[golemId];
  return !!goal && has([...stock] as Stock, goal.cost);
}
