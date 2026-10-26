/** 多回合束搜索规划器（V3.0 结构 + V4.0 参数化 + 结构变体框架）。
 *
 * 规划只使用 AIObservation 公开信息；未来对手回合和未知翻牌保持不确定，
 * 以当前公开市场作保守近似（beam-contest 结构例外：目标魔像的截胡风险经
 * golemSurvivalModel 进入目标定价，仍只用公开信息）。搜索深度/宽度沿用基线结构：
 * 触发终局后仅看当步，接近终局 3 层，其余 6 层；宽度 14/10。
 *
 * V4.0 变更：
 * - 全部求值项经 parameters.ts 的 8 个乘子接入（默认 1.0 = 基线行为）。
 * - 修复束搜索"休息饿死"缺陷：血统救援（restFallback）逐层保留席位。
 * - 结构变体（structures.ts）：beam-lineage（冠军基线）/
 *   beam-adaptive（束宽度自适应：前置宽后置窄）/
 *   beam-rollout（蒙特卡洛 rollout 替代 prospective 期望公式）/
 *   beam-contest（Issue #20：beam-rollout + 座位感知目标存活折扣——golemSurvivalModel
 *   依据座位顺序与对手可达费用估计目标魔像在我认领前的存活概率，乘进该目标的
 *   路线期望，使后手不再与必被截胡的目标死磕；其余结构行为逐位不变）。
 *   全部结构共用同一求值器与合法性核验，仅探索/评估策略不同。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import { has, tradeLimit, type Action, type Color, type MarketMerchant } from '../engine.js';
import type { AIParameters } from './parameters.js';
import type { AIObservation, ObservationPlayer } from './observation.js';
import { weighted, stockCount, cloneStock, publicKnowledge, futureDeckSupport } from './knowledge.js';
import { goalGap, keepValue, trimStock, acquisitionValue } from './evaluator.js';
import { engineValueFor, engineModelContext, type EngineModelContext } from './engine-model.js';
import { profileFor, type Profile } from './profiles.js';
import { pressureModel, golemSurvivalModel, type PressureModel } from './opponent-model.js';
import { adaptiveWidth, structureRng, ROLLOUT_DEFAULTS, type AIStructure } from './structures.js';
import {
  goalPriority, restMultiplier, endgameBonus, opponentPressureDelta,
  seatContestFactor, unknownSupportFactor,
} from './evolve/modules.js';

const clampFactor = (value: number, low: number, high: number): number =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : 1;

/** M07：把可进化的对手压力增量合并进公开压力模型（缺省 delta=0，逐位不变）。 */
function evolvePressure(view: AIObservation, params: AIParameters): PressureModel {
  const pressure = pressureModel(view);
  for (const id of Object.keys(pressure.mean)) {
    pressure.mean[id] = Math.min(1, Math.max(0, pressure.mean[id] + opponentPressureDelta(view, id, 'mean', params)));
    pressure.peak[id] = Math.min(1, Math.max(0, pressure.peak[id] + opponentPressureDelta(view, id, 'peak', params)));
  }
  return pressure;
}

/** 公开记分快照：只由观察中的已认领魔像、硬币与库存推导，不含隐藏牌库。 */
export type StandingEntry = {
  seat: number;
  score: number;
  claimed: number;
  turns: number;
};

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
  /** 焦点席位（公开）。 */
  seat: number;
  /** 当前公开得分（与 engine.score 同口径）。 */
  baseScore: number;
  /** baseScore 中来自非黄水晶库存的分值，用于把模拟路线后的库存变化折算回总分。 */
  baseStockPoints: number;
  /** 本局认领阈值（公开规则：2–3 人 6，4–5 人 5）。 */
  claimThreshold: number;
  /** 全部席位的公开名次快照（M06 胜率模型的合法输入）。 */
  standings: StandingEntry[];
};

type ScoredState = SearchState & { quality: number; preferred?: string };

const stockPoints = (stock: readonly number[]): number =>
  stock.slice(1).reduce((sum, n) => sum + n, 0);

/** 与 engine.score 相同的公开口径：已认领魔像 + 铜币 3 + 银币 1 + 非黄库存。 */
function publicScore(player: ObservationPlayer): number {
  return player.claimed.reduce((sum, id) => sum + GOLEM_BY_ID[id].points, 0)
    + player.copper * 3 + player.silver + stockPoints(player.stock);
}

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
    seat: view.current,
    baseScore: publicScore(player),
    baseStockPoints: stockPoints(player.stock),
    claimThreshold: threshold,
    standings: view.players.map(p => ({
      seat: p.id, score: publicScore(p), claimed: p.claimed.length, turns: p.turns,
    })),
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

/** 中间层评分：向目标推进的势头（restWeight 作用于含休息的路线）。
 * futureSupport：未翻开牌库对该目标的期望支持度（公共知识），
 * 让目标选择考虑"未来能否补足费用缺口"，而非只看当下统计数量。 */
function searchGrade(
  state: SearchState,
  preferred: string,
  stage: number,
  profile: Profile,
  pressure: PressureModel,
  params: AIParameters,
  futureSupport: number,
  model: EngineModelContext | null,
): number {
  const goal = GOLEM_BY_ID[preferred];
  const gap = goalGap(state.stock, goal);
  // M05：休息调度乘子（缺省 1 = 冻结 restWeight 口径）。
  const restFactor = state.path.at(-1)?.type === 'rest'
    ? params.restWeight * clampFactor(restMultiplier(state, preferred, params), 0.2, 3)
    : 1;
  // AI7 C2：获取支付机会成本（v2）——付出的非黄水晶终局各值 1 分，
  // 黄水晶按 0.5 分的转换机会成本计。v1 不启用（逐位不变）。
  const lastAction = state.path.at(-1);
  const paymentCost = params.engineModel === 'v2' && lastAction?.type === 'acquire'
    ? lastAction.payment.reduce<number>((sum, c) => sum + (c === 0 ? 0.5 : 1), 0)
    : 0;
  return -gap * 2.6 + weighted(state.stock) * .13 * params.capacityWeight
    + engineValueFor(state, preferred, params, model) * stage * .22 * profile.engine * params.engineWeight
    + futureSupport * stage * .45 * profile.engine * params.engineWeight
    + state.newCards.reduce((sum, id) => sum + acquisitionValue(state, id, preferred, profile, pressure, params, model), 0) * stage * .35
    - state.steps * .35 * profile.tempo * params.tempoWeight * restFactor
    - state.acquired * .15
    - paymentCost * .55;
}

/** 完成路线评分：单位行动得分效率。 */
function routeGrade(
  state: SearchState,
  preferred: string | null,
  stage: number,
  profile: Profile,
  params: AIParameters,
  model: EngineModelContext | null,
): number {
  // gained 可能包括同一路径上先认领其他公开魔像取得的得分。
  // M06：终局路线增量（缺省 0；只在路线完成最后一次认领时参与）。
  const rawTerminalBonus = state.terminal ? endgameBonus(state, params) : 0;
  const terminalBonus = Number.isFinite(rawTerminalBonus)
    ? Math.min(20, Math.max(-20, rawTerminalBonus))
    : 0;
  return state.gained * profile.tempo * params.tempoWeight / Math.pow(state.steps + .65, .90)
    + weighted(state.stock) * .055 * params.capacityWeight
    + engineValueFor(state, preferred, params, model) * stage * .085 * profile.engine * params.engineWeight
    + terminalBonus;
}

function completedFirstGoal(state: SearchState, preferred: string): boolean {
  return !state.golemMarket.includes(preferred);
}

/** prospective 期望公式（多回合目标推进的解析先验）。 */
function prospectiveFormula(
  state: SearchState,
  preferred: string,
  stage: number,
  profile: Profile,
  pressure: PressureModel,
  params: AIParameters,
  depth: number,
  futureSupport: number,
  model: EngineModelContext | null,
): number {
  return GOLEM_BY_ID[preferred].points / (depth + .65 + goalGap(state.stock, GOLEM_BY_ID[preferred]) / 3)
    + engineValueFor(state, preferred, params, model) * stage * .12 * profile.engine * params.engineWeight
    + state.newCards.reduce((sum, id) => sum + acquisitionValue(state, id, preferred, profile, pressure, params, model), 0) * stage * .32
    + futureSupport * stage * .25 * profile.engine * params.engineWeight
    - state.steps * .09 * profile.tempo * params.tempoWeight;
}

/** 主规划入口：只依赖 AIObservation 与参数集，不接触任何隐藏信息。
 * profileOverride：显式人格（训练模拟器按正式游戏席位映射注入）；
 * 缺省时沿用 profileFor 的席位推导，正式游戏行为不变。
 * structure：结构变体分派（缺省 beam-lineage = 冠军基线）。 */
export function choosePlan(
  view: AIObservation,
  params: AIParameters,
  profileOverride?: Profile,
  structureInput?: AIStructure,
  modelInput?: EngineModelContext | null,
): (ScoredState & { profile: string; unseenCounts: number[] }) | null {
  const structure = structureInput ?? 'beam-lineage';
  const profile = profileOverride ?? profileFor(view);
  // AI7 C2/C4：v2 引擎模型上下文（剩余回合/人数竞争）。v1 保持 null，
  // 全部求值路径调用冻结口径，行为逐位不变。
  const model = params.engineModel === 'v2' ? (modelInput ?? engineModelContext(view, params)) : null;
  const knowledge = publicKnowledge(view);
  // M07：对手压力模型经可进化增量修正（缺省 delta=0，冻结口径逐位不变）。
  const pressure = evolvePressure(view, params);
  const initial = initialState(view);
  const threshold = view.players.length >= 4 ? 5 : 6;
  const mostClaimed = Math.max(...view.players.map(p => p.claimed.length));
  const nearEnd = view.triggerPlayer !== null || mostClaimed >= threshold - 1;
  const depth = view.triggerPlayer !== null ? 1 : nearEnd ? 3 : 6;
  const baseWidth = nearEnd ? 10 : 14;
  // beam-adaptive：宽度随层号自适应（前置宽、后置窄）；其余结构用固定宽度。
  const widthFor = (layer: number) =>
    structure === 'beam-adaptive' ? adaptiveWidth(layer, depth, baseWidth) : baseWidth;
  const rawStage = view.triggerPlayer !== null ? 0 : Math.max(.12, 1 - mostClaimed / threshold);
  // endgameWeight：越接近终局，引擎/新卡项衰减越快（stage 的指数）。
  const stage = Math.pow(rawStage, params.endgameWeight);
  const allowAcquire = view.triggerPlayer === null;
  // beam-contest（Issue #20）：座位感知目标存活折扣。仅该结构启用，其余结构逐位不变。
  const survival = structure === 'beam-contest' ? golemSurvivalModel(view, depth) : null;
  // M08：座位/竞争乘子（缺省 1 = 冻结 golemSurvivalModel 口径）。
  const survivalOf = (preferred: string) =>
    (survival?.[preferred] ?? 1) * clampFactor(seatContestFactor(view, preferred, params), 0, 2);
  let solved: ScoredState | null = null, prospective: ScoredState | null = null;
  const finalBeams: Array<{ preferred: string; futureSupport: number; goalFactor: number; beam: ScoredState[] }> = [];
  for (const preferred of initial.golemMarket) {
    // M01：目标选择优先级乘子（缺省 1 = 冻结路线期望）。
    const goalFactor = clampFactor(goalPriority(view, preferred, params), 0.25, 4);
    // 每个目标只算一次未来牌库支持度（纯公共知识，成本可控）。
    // M09：未知牌支持度乘子（缺省 1 = 冻结 futureDeckSupport 口径）。
    const futureSupport = futureDeckSupport(initial.stock, preferred, knowledge.unseenMerchants)
      * clampFactor(unknownSupportFactor(view, preferred, knowledge.unseenMerchants, params), 0, 3);
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
        const variants = actions(position, preferred, allowAcquire, params);
        for (const action of variants) {
          const next = step(position, action, preferred, params);
          if (!next) continue;
          if (next.terminal && !completedFirstGoal(next, preferred)) continue;
          if (completedFirstGoal(next, preferred)) {
            const quality = routeGrade(next, preferred, stage, profile, params, model)
              * survivalOf(preferred) * goalFactor;
            if (!solved || quality > solved.quality) solved = { ...next, preferred, quality };
            continue;
          }
          const quality = searchGrade(next, preferred, stage, profile, pressure, params, futureSupport, model);
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
      beam = [...successors.values()].sort((a, b) => b.quality - a.quality).slice(0, widthFor(layer));
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
        const expected = prospectiveFormula(candidate, preferred, stage, profile, pressure, params, depth, futureSupport, model)
          * survivalOf(preferred) * goalFactor;
        if (!prospective || expected > prospective.quality) prospective = { ...candidate, preferred, quality: expected };
      }
    }
    finalBeams.push({ preferred, futureSupport, goalFactor, beam: [...beam] });
  }
  // beam-rollout / beam-contest：用确定性蒙特卡洛 rollout 评估最终束候选的"未来期望得分"，
  // 与公式先验按权重混合后取代解析 prospective（solved 路线仍优先）。
  // beam-contest 下公式先验与混合分都乘座位感知存活系数（截胡风险进入候选排序与选优）。
  if ((structure === 'beam-rollout' || structure === 'beam-contest') && !solved && finalBeams.length) {
    const ranked = finalBeams.flatMap(({ preferred, futureSupport, goalFactor, beam }) => beam.map(state => ({
      preferred, state, goalFactor,
      formula: prospectiveFormula(state, preferred, stage, profile, pressure, params, depth, futureSupport, model)
        * survivalOf(preferred) * goalFactor,
    }))).sort((a, b) => b.formula - a.formula).slice(0, ROLLOUT_DEFAULTS.topK);
    let rolloutBest: ScoredState | null = null;
    for (const { preferred, state, formula, goalFactor } of ranked) {
      let total = 0;
      for (let r = 0; r < ROLLOUT_DEFAULTS.rollouts; r++) {
        const rng = structureRng(stateKey(state), preferred, view.turnNumber, r);
        let cursor: SearchState = state;
        let taken = 0;
        while (!cursor.terminal && taken < ROLLOUT_DEFAULTS.stepCap) {
          const variants = actions(cursor, preferred, allowAcquire, params);
          const pick = variants[Math.floor(rng() * variants.length)];
          const next = step(cursor, pick, preferred, params);
          if (!next) break;
          cursor = next;
          taken += 1;
        }
        total += cursor.gained;
      }
      const meanGained = total / ROLLOUT_DEFAULTS.rollouts;
      const quality = (ROLLOUT_DEFAULTS.blend * meanGained + (1 - ROLLOUT_DEFAULTS.blend) * formula)
        * survivalOf(preferred) * goalFactor;
      if (!rolloutBest || quality > rolloutBest.quality) rolloutBest = { ...state, preferred, quality };
    }
    if (rolloutBest) prospective = rolloutBest;
  }
  // 有可信的实际认领路线时优先执行；未找到时采用多回合目标推进的最佳前缀。
  const plan = solved ?? prospective;
  return plan
    ? { ...plan, profile: profile.name, unseenCounts: [knowledge.unseenMerchants.length, knowledge.unseenGolems.length] }
    : null;
}
