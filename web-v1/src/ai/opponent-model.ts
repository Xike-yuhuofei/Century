/** 对手市场竞争模型（任务书 AI 4 战术大师维度）。
 * 基于全部公开信息估计对手对某张市场商人卡的需求压力，
 * 用于抢牌竞争权重（contestWeight）的求值输入。
 *
 * V4.0 修订（审计整改）：单一"平均压力"会把唯一急需该卡的对手
 * 稀释进其余不感兴趣的对手里，导致 AI 低估被抢风险、错失关键商人卡。
 * 现同时输出 mean（平均需求）与 peak（最强对手需求）两个维度，
 * 求值端按"关键卡识别 + 被抢风险"组合使用。
 */

import { MERCHANT_BY_ID, type Stock } from '../data.js';
import type { AIObservation } from './observation.js';
import { VALUES, weighted } from './knowledge.js';

/** 单个对手对某张商人卡的契合度：0（无兴趣）– 1（高度契合）。 */
function opponentAffinity(view: AIObservation, cardId: string, opponent: AIObservation['players'][number]): number {
  const card = MERCHANT_BY_ID[cardId];
  if (!card) return 0;
  const engine = [...opponent.hand, ...opponent.played].map(id => MERCHANT_BY_ID[id]).filter(Boolean);
  const outputs = engine.reduce((tot, c) => {
    if (c.output) c.output.forEach((n, i) => { tot[i] += n; });
    return tot;
  }, [0, 0, 0, 0] as Stock);
  const affinity = card.kind === 'trade'
    ? card.input!.reduce((v, n, i) => v + Math.min(n, opponent.stock[i] + outputs[i]) * VALUES[i], 0) / (weighted(card.input!) + 1)
    : card.kind === 'create' ? weighted(card.output!) / 10 : card.steps! / 5;
  return Math.min(1, affinity);
}

/** 对手平均需求压力：0（无人感兴趣）– 1（所有人都高度契合）。 */
export function contestPressure(view: AIObservation, cardId: string): number {
  const opponents = view.players.filter(p => p.id !== view.current);
  if (!opponents.length) return 0;
  return opponents.reduce((sum, p) => sum + opponentAffinity(view, cardId, p), 0) / opponents.length;
}

/** 最强对手需求压力：取全部对手中的最高契合度。
 * 一名对手极度需要时该值逼近 1，不再被其余对手稀释——
 * 这正是"关键商人卡被下一家抢走"的公开信号。 */
export function peakPressure(view: AIObservation, cardId: string): number {
  const opponents = view.players.filter(p => p.id !== view.current);
  if (!opponents.length) return 0;
  return Math.max(...opponents.map(p => opponentAffinity(view, cardId, p)));
}

/** 全部市场卡的双维度竞争压力表。 */
export type PressureModel = {
  /** 平均需求压力（市场整体热度）。 */
  mean: Record<string, number>;
  /** 最强对手压力（被抢风险）。 */
  peak: Record<string, number>;
};

export function pressureModel(view: AIObservation): PressureModel {
  const mean: Record<string, number> = {};
  const peak: Record<string, number> = {};
  for (const m of view.merchantMarket) {
    mean[m.id] = contestPressure(view, m.id);
    peak[m.id] = peakPressure(view, m.id);
  }
  return { mean, peak };
}
