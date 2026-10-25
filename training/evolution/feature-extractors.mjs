/** D2：候选插件特征提取（只读公开信息）。
 *
 * 全部特征来自公开状态（自己的手牌/已打出、市场、对手公开需求压力模型、
 * 目标魔像公开费用）与正式规则知识（卡牌总表）。绝不读取：
 * - merchantDeck / golemDeck / 未来翻牌顺序；
 * - 其它席位手牌；
 * - 真实洗牌种子。
 *
 * 这些特征只服务于"候选插件接口"的离线回归与代理评分；本轮不替换正式
 * 评价函数实现（Agent C 负责的 web-v1/src/ai/evaluator.ts 保持零改动）。
 */

import { MERCHANT_BY_ID, GOLEM_BY_ID } from '../../web-v1/dist/js/data.js';
import {
  VALUES, weighted, stockCount, engineValue, cardEngineValue,
} from '../../web-v1/dist/js/ai/knowledge.js';

function requireCard(cardId) {
  const card = MERCHANT_BY_ID[cardId];
  if (!card) throw new Error(`未知商人卡：${cardId}`);
  return card;
}

function requireGolem(goalId) {
  if (goalId === null || goalId === undefined) return null;
  const golem = GOLEM_BY_ID[goalId];
  if (!golem) throw new Error(`未知魔像：${goalId}`);
  return golem;
}

/** 获取估值特征（acquisitionValue 候选插件）。 */
export function acquisitionFeatures(input) {
  const card = requireCard(input.cardId);
  const target = requireGolem(input.preferred);
  const state = { stock: input.stock, hand: input.hand, played: input.played };
  const current = engineValue(state, input.preferred);
  const added = { ...state, hand: [...state.hand, input.cardId] };
  const raw = Math.max(0, engineValue(added, input.preferred) - current);

  const engine = [...input.hand, ...input.played].map(id => MERCHANT_BY_ID[id]).filter(Boolean);
  const supplied = engine.reduce((acc, c) => {
    if (c.output) c.output.forEach((n, i) => { acc[i] += n; });
    return acc;
  }, [0, 0, 0, 0]);
  const synergy = card.kind === 'trade'
    ? card.input.reduce((n, amount, i) => n + Math.min(amount, supplied[i]) * VALUES[i], 0) / (weighted(card.input) + 1)
    : card.kind === 'create'
      ? engine.filter(c => c.kind === 'trade').reduce((n, c) =>
          n + c.input.reduce((v, amount, i) => v + Math.min(amount, card.output[i]), 0), 0) * 0.18
      : 0.5;
  const goalFit = target && card.output
    ? card.output.reduce((n, amount, i) => n + Math.min(amount, target.cost[i]) * VALUES[i], 0) / (weighted(target.cost) + 1)
    : 0;
  const missing = card.input
    ? card.input.reduce((n, amount, i) => n + Math.max(0, amount - input.stock[i]) * VALUES[i], 0)
    : 0;
  const readiness = 1 / (1 + missing);
  const gain = card.output ? weighted(card.output) - (card.input ? weighted(card.input) : 0) : 2;
  const efficiency = Math.max(0, gain) / ((card.input ? stockCount(card.input) : 0) + 1);
  const room = Math.max(0, 10 - stockCount(input.stock));
  const growth = card.output ? Math.max(0, stockCount(card.output) - (card.input ? stockCount(card.input) : 0)) : 0;
  const capacityRoom = card.output ? (growth === 0 ? 1 : Math.min(room, growth) / (growth + 1)) : 0;
  const depth = input.hand.length + input.played.length;
  const demand = input.pressure?.mean?.[input.cardId] ?? 0;
  const risk = input.pressure?.peak?.[input.cardId] ?? 0;
  return {
    engineDelta: raw,
    synergy,
    goalFit,
    demand,
    risk,
    readiness,
    efficiency,
    capacityRoom,
    depthPenalty: Math.max(0, depth - 7),
  };
}

/** 引擎价值特征（engineValue 候选插件）。 */
export function engineFeatures(input) {
  const card = input.card;
  const goal = requireGolem(input.goalId);
  if (!card || typeof card !== 'object') throw new Error('engineValue 输入缺少 card');
  const output = card.output ?? [];
  const inp = card.input ?? [];
  return {
    outputWeight: weighted(output),
    goalUseful: goal && card.output
      ? card.output.reduce((s, n, c) => s + Math.min(n, Math.max(0, goal.cost[c] - input.stock[c])) * VALUES[c], 0)
      : 0,
    reachable: card.input ? (inp.reduce((s, n, c) => s + Math.max(0, n - input.stock[c]), 0) === 0 ? 1 : 0.35) : 0.35,
    inputCost: weighted(inp),
    steps: card.steps ?? 0,
    baseline: cardEngineValue(card, input.stock, goal),
  };
}

/** 目标价值特征（goalValue 候选插件）。 */
export function goalFeatures(input) {
  const goal = requireGolem(input.goalId);
  if (!goal) throw new Error('goalValue 输入缺少 goalId');
  const gap = goal.cost.reduce((s, n, c) => s + Math.max(0, n - input.stock[c]) * VALUES[c], 0);
  const total = weighted(goal.cost);
  const potential = input.goalIds?.length
    ? Math.max(...input.goalIds.map(id => {
        const g = requireGolem(id);
        return g.points * Math.max(0, 1 - g.cost.reduce((s, n, c) => s + Math.max(0, n - input.stock[c]) * VALUES[c], 0) / (weighted(g.cost) + 2));
      }))
    : 0;
  return {
    remainingCost: gap,
    goalFit: Math.max(0, 1 - gap / (total + 2)),
    stockPotential: potential,
    points: goal.points,
  };
}

/** 保留价值特征（keepValue 候选插件）。 */
export function keepFeatures(input) {
  const goal = requireGolem(input.preferred);
  const coverage = goal
    ? goal.cost.reduce((sum, amount, c) => sum + Math.min(amount, input.stock[c]) * VALUES[c], 0)
    : 0;
  const potential = input.goalIds?.length
    ? Math.max(...input.goalIds.map(id => {
        const g = requireGolem(id);
        return g.points * Math.max(0, 1 - g.cost.reduce((s, n, c) => s + Math.max(0, n - input.stock[c]) * VALUES[c], 0) / (weighted(g.cost) + 2));
      }))
    : weighted(input.stock) * 0.13;
  return {
    coverage,
    stockPotential: potential,
    weightedStock: weighted(input.stock),
    capacityPressure: stockCount(input.stock) / 10,
  };
}

/** 休息价值特征（restValue 候选插件）。 */
export function restFeatures(input) {
  const engine = [...input.hand, ...input.played]
    .map(id => MERCHANT_BY_ID[id]).filter(Boolean);
  const recovered = engine.reduce((s, card) => s + cardEngineValue(card, input.stock, requireGolem(input.preferred)), 0);
  return {
    playedCount: input.played.length,
    handDepth: input.hand.length,
    recycleGain: recovered / Math.max(1, engine.length),
    tempoLoss: input.played.length * 0.5,
  };
}

export const FEATURE_EXTRACTORS = Object.freeze({
  acquisitionValue: acquisitionFeatures,
  engineValue: engineFeatures,
  goalValue: goalFeatures,
  keepValue: keepFeatures,
  restValue: restFeatures,
});
