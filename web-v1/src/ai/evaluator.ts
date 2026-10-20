/** 参数化求值器：引擎价值、目标差距、水晶保留价值与获取价值。
 * 全部公式与 V3.0 基线一致，8 个任务参数以"默认 1.0 的乘子"形式接入，
 * 保证默认参数下决策与基线逐位一致，且每个参数真实影响决策。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID, type Golem, type Stock } from '../data.js';
import type { AIParameters } from './parameters.js';
import { VALUES, weighted, stockCount, cloneStock, engineValue } from './knowledge.js';

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

/** 商人卡获取价值：引擎增量 + 组合协同 + 目标契合 + 抢牌竞争。
 * engineWeight / synergyWeight / goalWeight / contestWeight 全部在此接入。 */
export function acquisitionValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: Record<string, number>,
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
    ? card.output.reduce((n, amount, i) => n + Math.min(amount, target.cost[i]) * VALUES[i], 0) / (weighted(target.cost) + 1)
    : 0;
  return profile.engine * (raw * .6 * params.engineWeight + synergy * 2 * params.synergyWeight + goalFit * 2 * params.goalWeight)
    + profile.contest * (pressure[cardId] ?? 0) * .9 * params.contestWeight;
}
