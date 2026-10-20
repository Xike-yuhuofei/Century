/** 多回合束搜索规划器（V3.0 结构 + V4.0 参数化）。
 *
 * 规划只使用 AIObservation 公开信息；未来对手回合和未知翻牌保持不确定，
 * 以当前公开市场作保守近似。搜索深度/宽度沿用基线结构：
 * 触发终局后仅看当步，接近终局 3 层，其余 6 层；宽度 14/10。
 *
 * V4.0 变更：
 * - 全部求值项经 parameters.ts 的 8 个乘子接入（默认 1.0 = 基线行为）。
 * - 修复束搜索"休息饿死"缺陷：休息分支的收益延迟 2+ 层才体现，
 *   纯即时质量剪枝会系统性淘汰唯一能收回已打出卡的路线；
 *   现为每层最佳休息后继保留一个束席位（main 分支预置失败测试的根因）。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import { has, tradeLimit, type Action, type Color, type MarketMerchant } from '../engine.js';
import type { AIParameters } from './parameters.js';
import type { AIObservation } from './observation.js';
import { weighted, stockCount, cloneStock, engineValue } from './knowledge.js';
import { goalGap, keepValue, trimStock, acquisitionValue } from './evaluator.js';
import { profileFor, type Profile } from './profiles.js';
import { publicKnowledge } from './knowledge.js';
import { pressureMap } from './opponent-model.js';

export type SearchState = {
  stock: Stock;
  hand: string[];
  played: string[];
  merchantMarket: MarketMerchant[];
  golemMarket: string[];
  copper: number;
  silver: number;
  gained: number;
  claimed: number;
  acquired: number;
  newCards: string[];
  steps: number;
  first: Action | null;
  path: Action[];
  remainingClaims: number;
  terminal: boolean;
};

type ScoredState = SearchState & { quality: number; preferred?: string };

/** 从公开观察构造搜索根状态。 */
export function initialState(view: AIObservation): SearchState {
  const player = view.players[view.current];
  const threshold = view.players.length >= 4 ? 5 : 6;
  return {
    stock: cloneStock(player.stock),
    hand: [...player.hand],
    played: [...player.played],
    merchantMarket: view.merchantMarket.map(m => ({ id: m.id, bonus: cloneStock(m.bonus) })),
    golemMarket: [...view.golemMarket],
    copper: view.copper,
    silver: view.silver,
    gained: 0, claimed: 0, acquired: 0, newCards: [], steps: 0,
    first: null, path: [], remainingClaims: threshold - player.claimed.length,
    terminal: false,
  };
}

function upgradeVariants(stock: readonly number[], max: number): number[][] {
  const variants = new Map<string, number[]>();
  function search(s: Stock, steps: number[]) {
    if (steps.length) {
      const key = s.join(',');
      if (!variants.has(key) || variants.get(key)!.length > steps.length) variants.set(key, steps);
    }
    if (steps.length === max) return;
    for (let c = 0; c < 3; c++) {
      if (!s[c]) continue;
      const next = cloneStock(s);
      next[c]--; next[c + 1]++;
      search(next, [...steps, c]);
    }
  }
  search(cloneStock(stock), []);
  return [...variants.values()];
}

/** 压晶只枚举不同颜色组合；同色组合排序后对应唯一的合法实际支付顺序。 */
function payments(
  stock: readonly number[],
  index: number,
  goals: readonly string[],
  preferred: string | null,
  params: AIParameters,
): number[][] {
  if (index === 0) return [[]];
  if (stockCount(stock) < index) return [];
  const result: Array<{ payment: number[]; value: number }> = [];
  function walk(color: number, left: number, selected: number[], rest: Stock) {
    if (color === 4) {
      if (left === 0) result.push({ payment: selected, value: keepValue(rest, goals, preferred, params) });
      return;
    }
    for (let n = 0; n <= Math.min(stock[color], left); n++) {
      const next = cloneStock(rest);
      next[color] -= n;
      walk(color + 1, left - n, [...selected, ...Array(n).fill(color)], next);
    }
  }
  walk(0, index, [], cloneStock(stock));
  result.sort((a, b) => b.value - a.value || a.payment.join('').localeCompare(b.payment.join('')));
  return result.slice(0, 3).map(x => x.payment);
}

export function actions(state: SearchState, preferred: string | null, allowAcquire: boolean, params: AIParameters): Action[] {
  const result: Action[] = [];
  for (let i = 0; i < state.golemMarket.length; i++) {
    if (has(state.stock, GOLEM_BY_ID[state.golemMarket[i]].cost)) result.push({ type: 'claim', index: i });
  }
  for (const id of state.hand) {
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') result.push({ type: 'play', cardId: id });
    else if (card.kind === 'upgrade') {
      for (const steps of upgradeVariants(state.stock, card.steps!)) {
        result.push({ type: 'play', cardId: id, steps: steps as Color[] });
      }
    } else {
      const limit = tradeLimit(state.stock, id);
      for (let repeats = 1; repeats <= limit; repeats++) result.push({ type: 'play', cardId: id, repeats });
    }
  }
  if (state.played.length) result.push({ type: 'rest' });
  if (allowAcquire && state.acquired < 2) {
    state.merchantMarket.forEach((m, index) => {
      for (const payment of payments(state.stock, index, state.golemMarket, preferred, params)) {
        result.push({ type: 'acquire', index, payment: payment as Color[] });
      }
    });
  }
  if (!result.length) result.push({ type: 'rest' });
  return result;
}

function step(state: SearchState, action: Action, preferred: string | null, params: AIParameters): SearchState | null {
  if (state.terminal) return null;
  const next: SearchState = {
    ...state, stock: cloneStock(state.stock), hand: [...state.hand], played: [...state.played],
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
    if (!has(next.stock, golem.cost)) return null;
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
  }
  next.stock = trimStock(next.stock, next.golemMarket, preferred, params).stock;
  return next;
}

function stateKey(state: SearchState): string {
  return [state.stock.join(','), [...state.hand].sort().join(','), [...state.played].sort().join(','),
    state.merchantMarket.map(x => x.id).join(','), state.golemMarket.join(','), state.acquired].join('|');
}

/** 中间层评分：向目标推进的势头（restWeight 作用于含休息的路线）。 */
function searchGrade(
  state: SearchState,
  preferred: string,
  stage: number,
  profile: Profile,
  pressure: Record<string, number>,
  params: AIParameters,
): number {
  const goal = GOLEM_BY_ID[preferred];
  const gap = goalGap(state.stock, goal);
  const restFactor = state.path.at(-1)?.type === 'rest' ? params.restWeight : 1;
  return -gap * 2.6 + weighted(state.stock) * .13 * params.capacityWeight
    + engineValue(state, preferred) * stage * .22 * profile.engine * params.engineWeight
    + state.newCards.reduce((sum, id) => sum + acquisitionValue(state, id, preferred, profile, pressure, params), 0) * stage * .35
    - state.steps * .35 * profile.tempo * params.tempoWeight * restFactor
    - state.acquired * .15;
}

/** 完成路线评分：单位行动得分效率。 */
function routeGrade(
  state: SearchState,
  preferred: string | null,
  stage: number,
  profile: Profile,
  params: AIParameters,
): number {
  // gained 可能包括同一路径上先认领其他公开魔像取得的得分。
  return state.gained * profile.tempo * params.tempoWeight / Math.pow(state.steps + .65, .90)
    + weighted(state.stock) * .055 * params.capacityWeight
    + engineValue(state, preferred) * stage * .085 * profile.engine * params.engineWeight;
}

function completedFirstGoal(state: SearchState, preferred: string): boolean {
  return !state.golemMarket.includes(preferred);
}

/** 主规划入口：只依赖 AIObservation 与参数集，不接触任何隐藏信息。 */
export function choosePlan(view: AIObservation, params: AIParameters): (ScoredState & { profile: string; unseenCounts: number[] }) | null {
  const profile = profileFor(view);
  const knowledge = publicKnowledge(view);
  const pressure = pressureMap(view);
  const initial = initialState(view);
  const threshold = view.players.length >= 4 ? 5 : 6;
  const mostClaimed = Math.max(...view.players.map(p => p.claimed.length));
  const nearEnd = view.triggerPlayer !== null || mostClaimed >= threshold - 1;
  const depth = view.triggerPlayer !== null ? 1 : nearEnd ? 3 : 6;
  const width = nearEnd ? 10 : 14;
  const rawStage = view.triggerPlayer !== null ? 0 : Math.max(.12, 1 - mostClaimed / threshold);
  // endgameWeight：越接近终局，引擎/新卡项衰减越快（stage 的指数）。
  const stage = Math.pow(rawStage, params.endgameWeight);
  let solved: ScoredState | null = null, prospective: ScoredState | null = null;
  for (const preferred of initial.golemMarket) {
    let beam: ScoredState[] = [{ ...initial, quality: 0 }];
    // 血统救援：休息及其后续推进状态共同构成"唯一可行的收卡路线"，
    // 每层为该血统的最佳后继保留一个束席位，防止即时质量剪枝饿死整条路线。
    const rescuedKeys = new Set<string>();
    for (let layer = 1; layer <= depth; layer++) {
      const successors = new Map<string, ScoredState>();
      let restFallback: ScoredState | null = null;
      let lineagePlay: ScoredState | null = null;
      let lineageRest: ScoredState | null = null;
      let lineageOther: ScoredState | null = null;
      for (const position of beam) {
        const parentKey = stateKey(position);
        const variants = actions(position, preferred, view.triggerPlayer === null, params);
        for (const action of variants) {
          const next = step(position, action, preferred, params);
          if (!next) continue;
          if (next.terminal && !completedFirstGoal(next, preferred)) continue;
          if (completedFirstGoal(next, preferred)) {
            const quality = routeGrade(next, preferred, stage, profile, params);
            if (!solved || quality > solved.quality) solved = { ...next, preferred, quality };
            continue;
          }
          const quality = searchGrade(next, preferred, stage, profile, pressure, params);
          const scored: ScoredState = { ...next, quality };
          const key = stateKey(next);
          if (!successors.has(key) || successors.get(key)!.quality < quality) successors.set(key, scored);
          if (action.type === 'rest' && (!restFallback || quality > restFallback.quality)) restFallback = scored;
          if (rescuedKeys.has(parentKey)) {
            // 血统延续按"路线相关性"而非纯即时质量选择：打牌/认领直接推进目标转换，
            // 休息用于回收卡牌；引擎扩张（acquire）应让位于已在进行的转换路线。
            const isRouteAction = action.type === 'play' || action.type === 'claim';
            if (isRouteAction && (!lineagePlay || quality > lineagePlay.quality)) lineagePlay = scored;
            else if (action.type === 'rest' && (!lineageRest || quality > lineageRest.quality)) lineageRest = scored;
            else if (!isRouteAction && action.type !== 'rest' && (!lineageOther || quality > lineageOther.quality)) lineageOther = scored;
          }
        }
      }
      if (!successors.size) break;
      beam = [...successors.values()].sort((a, b) => b.quality - a.quality).slice(0, width);
      const rescue = (candidate: ScoredState | null) => {
        if (!candidate) return;
        const key = stateKey(candidate);
        // 无论是否已按质量进入束，都要登记血统键：休息路线可能天然排在束内，
        // 但它的后续推进仍需要逐层救援，否则血统在下一层断链。
        if (!beam.some(b => stateKey(b) === key)) beam.push(candidate);
        rescuedKeys.add(key);
      };
      rescue(lineagePlay ?? lineageRest ?? lineageOther);
      rescue(restFallback);
      for (const candidate of beam) {
        const expected = GOLEM_BY_ID[preferred].points / (depth + .65 + goalGap(candidate.stock, GOLEM_BY_ID[preferred]) / 3)
          + engineValue(candidate, preferred) * stage * .12 * profile.engine * params.engineWeight
          + candidate.newCards.reduce((sum, id) => sum + acquisitionValue(candidate, id, preferred, profile, pressure, params), 0) * stage * .32
          - candidate.steps * .09 * profile.tempo * params.tempoWeight;
        if (!prospective || expected > prospective.quality) prospective = { ...candidate, preferred, quality: expected };
      }
    }
  }
  // 有可信的实际认领路线时优先执行；未找到时采用多回合目标推进的最佳前缀。
  const plan = solved ?? prospective;
  return plan
    ? { ...plan, profile: profile.name, unseenCounts: [knowledge.unseenMerchants.length, knowledge.unseenGolems.length] }
    : null;
}
