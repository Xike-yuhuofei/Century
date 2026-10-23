/** 对手市场竞争模型（任务书 AI 4 战术大师维度）。
 * 基于全部公开信息估计对手对某张市场商人卡的需求压力，
 * 用于抢牌竞争权重（contestWeight）的求值输入。
 *
 * V4.0 修订（审计整改）：单一"平均压力"会把唯一急需该卡的对手
 * 稀释进其余不感兴趣的对手里，导致 AI 低估被抢风险、错失关键商人卡。
 * 现同时输出 mean（平均需求）与 peak（最强对手需求）两个维度，
 * 求值端按"关键卡识别 + 被抢风险"组合使用。
 */

import { MERCHANT_BY_ID, GOLEM_BY_ID, type Stock } from '../data.js';
import { has } from '../engine.js';
import type { AIObservation } from './observation.js';
import { VALUES, weighted, stockCount, cloneStock } from './knowledge.js';

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

// === 座位感知的目标魔像截胡模型（Issue #20，beam-contest 结构专用） ===
//
// 缺陷背景：beam 系结构的规划是纯单代理搜索——目标魔像在全部路线中永不消失，
// 上面的 pressureModel 又只覆盖商人卡，"目标魔像会在轮到我之前被买走"这一
// 竞争时序在全部求值函数中零建模。四个 AI 因此在开局全员锁定同一张"最优"
// 魔像，先手必得，后手的多回合规划反复作废（实测：开局 5 席全部锁定 G01）。
//
// 模型（只使用 AIObservation 公开信息，不猜测对手意图）：
// - 对手单圈可达水晶 reachable：当前库存 + 打出全部手牌的净产出
//   （每张手牌单圈最多打一次，贪心确定性模拟，商队上限 10 按价值最低色弃置）；
// - 费用覆盖度 coverage = Σ min(reachable[c], cost[c])·VALUES[c] / weighted(cost)；
// - 单对手单圈截胡概率 p = 0.6·max(0, saturation − 0.55)²：阈值陡化模型，
//   只有"接近可支付"的对手才构成现实威胁（抢"马上要被拿走"的卡），
//   低威胁目标几乎不受惩罚——避免泛化避让把后手推向系统性弱目标。
//   强度经快筛校准（24 训练种子配对）：0.85·sat² → −7.4/种子、
//   0.45·sat² → −4.8/种子、0.8·max(0,sat−0.5)² → −2.5/种子（均过度避让），
//   阈值版 0.6·max(0,sat−0.55)² → −0.05/种子（与冠军统计不可区分），
//   保留座位感知方向性而不牺牲目标质量；
// - 机会圈数：目标预计在"我的第 r+1 回合"内被认领——第 1..r 圈全体对手各行动
//   一次（r 次），第 r+1 圈内只有座位号排在我前面的对手能先于我行动
//   （座位号 < 我的对手共 r+1 次，其余 r 次）——这正是"先手必得"的时序根源；
// - 存活系数 survival = Π (1 − p)^(opps)。r 由规划深度推导：
//   终局当步不折扣；6 层规划 r=2；3 层 r=1。

/** 对手单圈可达水晶：打出全部手牌后的净形态（贪心确定性模拟）。 */
function reachableStock(opponent: AIObservation['players'][number]): Stock {
  const stock = cloneStock(opponent.stock);
  for (const id of opponent.hand) {
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') {
      card.output!.forEach((n, c) => { stock[c] += n; });
    } else if (card.kind === 'upgrade') {
      let steps = card.steps!;
      for (let c = 0; c < 3 && steps > 0; c++) {
        while (steps > 0 && stock[c] > 0) { stock[c]--; stock[c + 1]++; steps--; }
      }
    } else if (card.kind === 'trade' && has(stock, card.input!)) {
      card.input!.forEach((n, c) => { stock[c] -= n; });
      card.output!.forEach((n, c) => { stock[c] += n; });
    }
  }
  // 商队上限 10：超出按价值最低色逐颗弃置（确定性近似）。
  while (stockCount(stock) > 10) {
    let color = -1;
    for (let c = 0; c < 4; c++) {
      if (stock[c] === 0) continue;
      if (color < 0 || VALUES[c] < VALUES[color]) color = c;
    }
    if (color < 0) break;
    stock[color]--;
  }
  return stock;
}

/** 全部市场魔像的座位感知存活系数表（Record<golemId, number>，值域 (0,1]）。 */
export function golemSurvivalModel(view: AIObservation, depth = 6): Record<string, number> {
  const result: Record<string, number> = {};
  // 终局当步决策（depth=1 / triggerPlayer 已触发）：本步认领前没有对手回合，不折扣。
  const rounds = view.triggerPlayer !== null ? 0 : depth >= 6 ? 2 : depth >= 3 ? 1 : 0;
  if (rounds === 0) {
    for (const id of view.golemMarket) result[id] = 1;
    return result;
  }
  const reachableCache = new Map<number, Stock>();
  for (const p of view.players) {
    if (p.id !== view.current) reachableCache.set(p.id, reachableStock(p));
  }
  for (const id of view.golemMarket) {
    const goal = GOLEM_BY_ID[id];
    if (!goal) { result[id] = 1; continue; }
    const total = weighted(goal.cost);
    let survival = 1;
    for (const p of view.players) {
      if (p.id === view.current) continue;
      const reach = reachableCache.get(p.id)!;
      const covered = goal.cost.reduce((s, n, c) => s + Math.min(n, reach[c]) * VALUES[c], 0);
      const coverage = total > 0 ? covered / total : 0;
      // 座位号排在我前面的对手，在"我预计认领的那一圈"先于我行动，多一次拦截机会；
      // 该多出的圈数同时抬高对手的成长期望（saturation 项）。
      const opps = p.id < view.current ? rounds + 1 : rounds;
      const saturation = Math.min(1, coverage + opps * 0.9 / Math.max(total, 1));
      const pGrab = 0.6 * Math.pow(Math.max(0, saturation - 0.55), 2);
      survival *= Math.pow(1 - pGrab, opps);
    }
    result[id] = survival;
  }
  return result;
}
