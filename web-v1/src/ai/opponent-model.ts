/** 对手市场竞争模型（任务书 AI 4 战术大师维度）。
 * 基于全部公开信息估计对手对某张市场商人卡的需求压力，
 * 用于抢牌竞争权重（contestWeight）的求值输入。
 */

import { MERCHANT_BY_ID, type Stock } from '../data.js';
import type { AIObservation } from './observation.js';
import { VALUES, weighted } from './knowledge.js';

/** 对手平均需求压力：0（无人感兴趣）– 1（所有人都高度契合）。 */
export function contestPressure(view: AIObservation, cardId: string): number {
  const card = MERCHANT_BY_ID[cardId];
  if (!card) return 0;
  const opponents = view.players.filter(p => p.id !== view.current);
  return opponents.reduce((sum, p) => {
    const engine = [...p.hand, ...p.played].map(id => MERCHANT_BY_ID[id]).filter(Boolean);
    const outputs = engine.reduce((tot, c) => {
      if (c.output) c.output.forEach((n, i) => { tot[i] += n; });
      return tot;
    }, [0, 0, 0, 0] as Stock);
    const affinity = card.kind === 'trade'
      ? card.input!.reduce((v, n, i) => v + Math.min(n, p.stock[i] + outputs[i]) * VALUES[i], 0) / (weighted(card.input!) + 1)
      : card.kind === 'create' ? weighted(card.output!) / 10 : card.steps! / 5;
    return sum + Math.min(1, affinity);
  }, 0) / Math.max(1, opponents.length);
}

/** 全部市场卡的竞争压力表。 */
export function pressureMap(view: AIObservation): Record<string, number> {
  return Object.fromEntries(view.merchantMarket.map(m => [m.id, contestPressure(view, m.id)]));
}
