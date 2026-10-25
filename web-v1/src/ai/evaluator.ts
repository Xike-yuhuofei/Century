/** 参数化求值器：引擎价值、目标差距、水晶保留价值与获取价值。
 * 全部公式与 V3.0 基线一致，8 个任务参数以"默认 1.0 的乘子"形式接入，
 * 保证默认参数下决策与基线逐位一致，且每个参数真实影响决策。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID, type Golem, type Stock } from '../data.js';
import type { AIParameters } from './parameters.js';
import type { PressureModel } from './opponent-model.js';
import { VALUES, weighted, stockCount, cloneStock, engineValue } from './knowledge.js';
import { acquisitionRepeatDelta, type EngineModelContext } from './engine-model.js';

/** 距目标魔像的费用差距（按水晶价值加权）。 */
export function goalGap(stock: readonly number[], goal: Golem | null): number {
  if (!goal) return 0;
  return goal.cost.reduce((sum, needed, color) => sum + Math.max(0, needed - stock[color]) * VALUES[color], 0);
}

/** 库存对候选魔像的最大实现概率近似。 */
export function stockPotential(stock: readonly number[], goals: readonly string[]): number {
  if (!goals.length) return weighted(stock) * .13;
  return Math.max(...goals.map(id => {
    const card = GOLEM_BY_ID[id];
    const total = weighted(card.cost);
    return card.points * Math.max(0, 1 - goalGap(stock, card) / (total + 2));
  }));
}

/** 水晶保留价值：支付选择与超额弃置决策共用（capacityWeight 作用点）。 */
export function keepValue(
  stock: readonly number[],
  goals: readonly string[],
  preferred: string | null,
  params: AIParameters,
): number {
  const target: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  const coverage = target
    ? target.cost.reduce((sum, amount, c) => sum + Math.min(amount, stock[c]) * VALUES[c], 0)
    : 0;
  return coverage * 3 + stockPotential(stock, goals) * 1.2 + weighted(stock) * .16 * params.capacityWeight;
}

/** 超额水晶迭代弃置：每颗都选择弃置后保留价值最高的颜色。 */
export function trimStock(
  source: readonly number[],
  goals: readonly string[],
  preferred: string | null,
  params: AIParameters,
): { stock: Stock; discarded: number[] } {
  const stock = cloneStock(source);
  const discarded: number[] = [];
  while (stockCount(stock) > 10) {
    let color = -1, best = -Infinity;
    for (let c = 0; c < 4; c++) {
      if (stock[c] === 0) continue;
      stock[c]--;
      const rating = keepValue(stock, goals, preferred, params);
      stock[c]++;
      if (rating > best) { best = rating; color = c; }
    }
    if (color < 0) throw new Error('超额水晶弃置失败');
    stock[color]--;
    discarded.push(color);
  }
  return { stock, discarded };
}

/** AI5 进化变体实现：goalFit 只统计目标魔像还缺的水晶（max(0, cost−stock)）。
 * 来源：OpenEvolve 候选 66f6a296aa72（AI5 POC 冒烟与受控两轮独立进化重复收敛），
 * 函数体与归档证据 ai5/openevolve/results/evaluations/66f6a296aa72/function.ts
 * 逐字一致（除本注释外）；与基线的唯一差异即 goalFit 一行。
 * 经静态安全检查、3000 用例探针、Seatbelt 沙箱对战与 100 新种子深度验证
 * （验证结论：不显著优于冠军，作为可挑战变体保留），按 AI 4.0 流程参赛。 */
export function acquisitionValueGoalRemaining(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
): number {
  const card = MERCHANT_BY_ID[cardId];
  if (!card) return 0;
  const current = engineValue(state, preferred);
  const added = { ...state, hand: [...state.hand, cardId] };
  const raw = Math.max(0, engineValue(added, preferred) - current);
  const target: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  const engine = [...state.hand, ...state.played].map(id => MERCHANT_BY_ID[id]).filter(Boolean);
  const supplied = engine.reduce((a, c) => {
    if (c.output) c.output.forEach((n, i) => { a[i] += n; });
    return a;
  }, [0, 0, 0, 0] as Stock);
  const synergy = card.kind === 'trade'
    ? card.input!.reduce((n, amount, i) => n + Math.min(amount, supplied[i]) * VALUES[i], 0) / (weighted(card.input!) + 1)
    : card.kind === 'create'
      ? engine.filter(c => c.kind === 'trade').reduce((n, c) =>
          n + c.input!.reduce((v, amount, i) => v + Math.min(amount, card.output![i]), 0), 0) * .18
      : .5;
  const goalFit = target && card.output
    ? card.output.reduce((n, amount, i) =>
        n + Math.min(amount, Math.max(0, target.cost[i] - state.stock[i])) * VALUES[i], 0
      ) / (weighted(target.cost) + 1)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  // 被抢风险与目标契合叠加为紧迫度：越关键且越可能被抢，越值得立刻出手。
  const urgency = 1 + (risk > 0 && goalFit > 0 ? goalFit : 0);
  return profile.engine * (raw * .6 * params.engineWeight + synergy * 2 * params.synergyWeight + goalFit * 2 * params.goalWeight)
    + profile.contest * params.contestWeight * (demand * .45 + risk * urgency * .55) * .9;
}

/** AI5 多样性轮演化变体（div20 最优 17c6e43cae24）：以 readiness（可负担度）为核心的多因子估值。
 * 特征：missing→readiness 折减协同项、input/output 转换效率（tempoWeight 接线）、
 * 水晶容量空间修正（capacityWeight）、引擎深度成本（restWeight）、终局项
 * （endgameWeight）、竞赛项重塑（demand .3 / risk .7 + readiness/goalFit 增益）。
 * 函数体与归档证据 ai5/openevolve/results/div20-candidates/iterx-17c6e43cae24.fn.ts
 * 逐字一致；静态检查、3000 用例探针、沙箱对战、100 唯一新种子深验（+1.53/种子，
 * inconclusive）后按 AI 4.0 流程参赛（challengeIndex=8，500 种子）。 */
export function acquisitionValueReadinessEfficiency(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
): number {
  const card = MERCHANT_BY_ID[cardId];
  if (!card) return 0;
  const current = engineValue(state, preferred);
  const added = { ...state, hand: [...state.hand, cardId] };
  const raw = Math.max(0, engineValue(added, preferred) - current);
  const target: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  const engine = [...state.hand, ...state.played].map(id => MERCHANT_BY_ID[id]).filter(Boolean);
  const supplied = engine.reduce((a, c) => {
    if (c.output) c.output.forEach((n, i) => { a[i] += n; });
    return a;
  }, [0, 0, 0, 0] as Stock);
  const synergy = card.kind === 'trade'
    ? card.input!.reduce((n, amount, i) => n + Math.min(amount, supplied[i]) * VALUES[i], 0) / (weighted(card.input!) + 1)
    : card.kind === 'create'
      ? engine.filter(c => c.kind === 'trade').reduce((n, c) =>
          n + c.input!.reduce((v, amount, i) => v + Math.min(amount, card.output![i]), 0), 0) * .18
      : .5;
  const input = card.input;
  const output = card.output;
  const missing = input
    ? input.reduce((n, amount, i) =>
        n + Math.max(0, amount - state.stock[i]) * VALUES[i], 0)
    : 0;
  const readiness = 1 / (1 + missing);
  const gain = output ? weighted(output) - (input ? weighted(input) : 0) : 2;
  const efficiency = Math.max(0, gain) / ((input ? stockCount(input) : 0) + 1);
  const goalFit = target && output
    ? output.reduce((n, amount, i) =>
        n + Math.min(amount, Math.max(0, target.cost[i] - state.stock[i])) * VALUES[i], 0
      ) / (weighted(target.cost) + 1)
    : 0;
  const room = Math.max(0, 10 - stockCount(state.stock));
  const growth = output
    ? Math.max(0, stockCount(output) - (input ? stockCount(input) : 0))
    : 0;
  const capacity = output
    ? growth === 0 ? 1 : Math.min(room, growth) / (growth + 1)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  const depth = state.hand.length + state.played.length;
  return profile.engine * (
      raw * .7 * params.engineWeight
      + synergy * readiness * 1.6 * params.synergyWeight
      + goalFit * .65 * params.goalWeight
      + efficiency * readiness * .45 * params.tempoWeight
      + capacity * .3 * params.capacityWeight
      + (goalFit + efficiency) / (depth + 2) * params.endgameWeight
      - Math.max(0, depth - 7) * .045 * params.restWeight
    )
    + profile.contest * params.contestWeight *
      (demand * .3 + risk * .7) *
      (1 + readiness * .12 + goalFit * .2);
}

/** 商人卡获取价值：引擎增量 + 组合协同 + 目标契合 + 抢牌竞争。
 * engineWeight / synergyWeight / goalWeight / contestWeight 全部在此接入。
 * 抢牌竞争项（审计整改）：mean 为平均需求热度，peak 为最强对手需求——
 * 唯一急需该卡的对手不再被另外三名对手稀释；peak 高且高度契合当前
 * 目标的卡按"关键商人卡"加急处理，抢牌价值随紧迫度放大。
 * 获取估值变体按 params.acquisitionVariant 分派（缺省 baseline = 本函数体）。 */
export function acquisitionValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
  model: EngineModelContext | null = null,
): number {
  // AI7 C2：v2 只追加"重复使用增量"（创造卡可反复产出/升级卡长期作用/
  // 交易卡循环），叠加在冻结的获取估值血统之上——不替换、不放大其他项。
  const withV2 = (value: number): number =>
    params.engineModel === 'v2' && model
      ? value + acquisitionRepeatDelta(cardId, state, preferred, model)
      : value;
  if (params.acquisitionVariant === 'goal-remaining') {
    return withV2(acquisitionValueGoalRemaining(state, cardId, preferred, profile, pressure, params));
  }
  if (params.acquisitionVariant === 'readiness-efficiency') {
    return withV2(acquisitionValueReadinessEfficiency(state, cardId, preferred, profile, pressure, params));
  }
  const card = MERCHANT_BY_ID[cardId];
  if (!card) return 0;
  const current = engineValue(state, preferred);
  const added = { ...state, hand: [...state.hand, cardId] };
  const raw = Math.max(0, engineValue(added, preferred) - current);
  const target: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  const engine = [...state.hand, ...state.played].map(id => MERCHANT_BY_ID[id]).filter(Boolean);
  const supplied = engine.reduce((a, c) => {
    if (c.output) c.output.forEach((n, i) => { a[i] += n; });
    return a;
  }, [0, 0, 0, 0] as Stock);
  const synergy = card.kind === 'trade'
    ? card.input!.reduce((n, amount, i) => n + Math.min(amount, supplied[i]) * VALUES[i], 0) / (weighted(card.input!) + 1)
    : card.kind === 'create'
      ? engine.filter(c => c.kind === 'trade').reduce((n, c) =>
          n + c.input!.reduce((v, amount, i) => v + Math.min(amount, card.output![i]), 0), 0) * .18
      : .5;
  const goalFit = target && card.output
    ? card.output.reduce((n, amount, i) => n + Math.min(amount, target.cost[i]) * VALUES[i], 0) / (weighted(target.cost) + 1)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  // 被抢风险与目标契合叠加为紧迫度：越关键且越可能被抢，越值得立刻出手。
  const urgency = 1 + (risk > 0 && goalFit > 0 ? goalFit : 0);
  return withV2(profile.engine * (raw * .6 * params.engineWeight + synergy * 2 * params.synergyWeight + goalFit * 2 * params.goalWeight)
    + profile.contest * params.contestWeight * (demand * .45 + risk * urgency * .55) * .9);
}
