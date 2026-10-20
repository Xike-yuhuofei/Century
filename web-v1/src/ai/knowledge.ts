/** AI 公共卡牌知识：水晶价值标尺、卡牌引擎价值与未知牌集合推断。
 * 全部函数只接受 AIObservation 或纯卡牌数据，绝不接触隐藏牌库顺序。
 */

import { MERCHANT_BY_ID, GOLEM_BY_ID, GOLEM_DECK, MERCHANT_DECK, type Golem, type Merchant, type Stock } from '../data.js';
import { has } from '../engine.js';
import type { AIObservation } from './observation.js';

/** 四色水晶价值标尺（黄/绿/蓝/粉），为全体 AI 共享的规则知识。 */
export const VALUES = [1, 1.7, 2.5, 3.4] as const;

export const weighted = (stock: readonly number[]) =>
  stock.reduce((sum, n, color) => sum + n * VALUES[color], 0);

export const stockCount = (stock: readonly number[]) => stock[0] + stock[1] + stock[2] + stock[3];

export const cloneStock = (stock: readonly number[]): Stock => [...stock] as Stock;

/** 单张商人卡在当前库存与目标魔像下的引擎价值。 */
export function cardEngineValue(card: Merchant, stock: readonly number[], goal: Golem | null): number {
  if (card.kind === 'create') {
    const useful = goal
      ? card.output!.reduce((s, n, c) => s + Math.min(n, Math.max(0, goal.cost[c] - stock[c])) * VALUES[c], 0)
      : 0;
    return weighted(card.output!) * .32 + useful * .22;
  }
  if (card.kind === 'upgrade') return card.steps! * .7;
  const gain = weighted(card.output!) - weighted(card.input!);
  const reachable = has(stock as Stock, card.input!) ? 1 : .35;
  const targetMatch = goal
    ? card.output!.reduce((s, n, c) => s + Math.min(n, goal.cost[c]) * VALUES[c], 0)
    : 0;
  return Math.max(0, gain) * .30 + reachable * .45 + targetMatch * .17;
}

/** 玩家整套引擎（手牌 + 已打出）对目标魔像的综合引擎价值。 */
export function engineValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  preferred: string | null,
): number {
  const goal: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  return [...state.hand, ...state.played].reduce((sum, id) => {
    const card = MERCHANT_BY_ID[id];
    return sum + (card ? cardEngineValue(card, state.stock, goal) : 0);
  }, 0);
}

/** 公开知识推断：未翻开牌库中还剩哪些卡（只利用卡牌全集构成，不猜测任何顺序）。 */
export function publicKnowledge(view: AIObservation) {
  const knownMerchants = new Set(view.merchantMarket.map(x => x.id));
  const knownGolems = new Set(view.golemMarket);
  for (const p of view.players) {
    for (const id of [...p.hand, ...p.played]) knownMerchants.add(id);
    for (const id of p.claimed) knownGolems.add(id);
  }
  // 魔像累计公开认领完整；商人卡被弃置的规则不存在。
  return {
    unseenMerchants: MERCHANT_DECK.filter(c => !knownMerchants.has(c.id)).map(c => c.id),
    unseenGolems: GOLEM_DECK.filter(c => !knownGolems.has(c.id)).map(c => c.id),
  };
}

/** 未来牌库对目标路线的期望支持度（纯公共知识，审计整改：让全局卡牌知识
 * 真正参与战略规划）。对未翻开商人卡全集按当前库存与目标魔像求平均引擎价值：
 * 一个目标若能被未来大概率出现的卡补足费用缺口，其长期可行性更高。
 * 只使用卡牌全集构成，绝不推断翻牌顺序。 */
export function futureDeckSupport(
  stock: readonly number[],
  preferred: string,
  unseenMerchants: readonly string[],
): number {
  if (!unseenMerchants.length) return 0;
  const goal: Golem | null = GOLEM_BY_ID[preferred] ?? null;
  let sum = 0;
  for (const id of unseenMerchants) {
    const card = MERCHANT_BY_ID[id];
    if (card) sum += cardEngineValue(card, stock, goal);
  }
  return sum / unseenMerchants.length;
}
