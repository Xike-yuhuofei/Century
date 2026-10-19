/**
 * 本地启发式 AI：穷举有限的合法行动候选，用完整规则引擎模拟结果并评分。
 * 无作弊、无隐藏牌库读取、无随机浏览器依赖；所有动作均须经过 applyAction。
 */
import { GOLEM_BY_ID, MERCHANT_BY_ID, type Merchant, type Stock } from './data.js';
import { add, applyAction, count, has, score, tradeLimit, type Action, type Color, type Game } from './engine.js';

export type AIChoice = { action: Action; reason: string };
const COLORS = [0, 1, 2, 3] as Color[];
const UNIT = [1, 1.5, 2.05, 2.6];
const total = (s: Stock) => s.reduce((v, n, i) => v + n * UNIT[i], 0);
const copy = (s: Stock): Stock => [...s] as Stock;

function targets(g: Game, s: Stock): number {
  if (!g.golemMarket.length) return 0;
  return Math.max(...g.golemMarket.map((id, i) => {
    const card = GOLEM_BY_ID[id];
    const miss = card.cost.reduce((v, need, color) => v + Math.max(0, need - s[color]) * UNIT[color], 0);
    const usable = card.cost.reduce((v, need, color) => v + Math.min(need, s[color]) * UNIT[color], 0);
    const bonus = i === 0 && g.copper ? 1.6 : i === 1 && g.silver && g.copper ? 0.5 : 0;
    return card.points * 0.22 + usable * 0.12 + bonus - 1.34 * miss;
  }));
}

function stockFitness(g: Game, s: Stock): number {
  return targets(g, s) + total(s) * 0.11 - Math.max(0, count(s) - 10) * 3;
}

/** 超过 10 颗时保留最有用的组合（逐颗抛弃）。 */
export function chooseAIDiscard(g: Game): Color[] {
  const s = copy(g.players[g.current].stock);
  const colors: Color[] = [];
  while (count(s) > 10) {
    let selected: Color = 0;
    let best = -Infinity;
    for (const color of COLORS) {
      if (!s[color]) continue;
      s[color]--;
      const fitness = stockFitness(g, s);
      s[color]++;
      if (fitness > best) { best = fitness; selected = color; }
    }
    s[selected]--;
    colors.push(selected);
  }
  return colors;
}

function paymentVariants(s: Stock, qty: number): Color[][] {
  if (qty === 0) return [[]];
  const result: Color[][] = [];
  const step = (i: number, left: number, payment: Color[]) => {
    if (i === 4) { if (!left) result.push([...payment]); return; }
    for (let n = 0; n <= Math.min(s[i], left); n++) {
      step(i + 1, left - n, [...payment, ...Array<Color>(n).fill(i as Color)]);
    }
  };
  step(0, qty, []);
  return result;
}

function upgradeVariants(s: Stock, steps: number): Color[][] {
  const results: Color[][] = [];
  const walk = (stock: Stock, sequence: Color[]) => {
    if (sequence.length > 0) results.push(sequence);
    if (sequence.length === steps) return;
    for (const color of [0, 1, 2] as Color[]) {
      if (!stock[color]) continue;
      const next = copy(stock);
      next[color]--; next[color + 1]++;
      walk(next, [...sequence, color]);
    }
  };
  walk(s, []);
  return results;
}

function engineStrength(card: Merchant, s: Stock): number {
  if (card.kind === 'create') return total(card.output!) * 0.67;
  if (card.kind === 'upgrade') return (card.steps ?? 0) * 1.23;
  const material = Math.max(0, total(card.output!) - total(card.input!));
  const accessible = has(s, card.input!) ? 0.42 : 0;
  return material * 0.62 + 0.82 + accessible;
}

export function chooseAIAction(g: Game): AIChoice {
  if (g.phase === 'finished') throw new Error('对局已结束，AI 不应行动');
  const player = g.players[g.current];
  if (!player?.isAI) throw new Error('当前不是 AI 回合');
  if (g.phase === 'overflow') return {action:{type:'discard', colors:chooseAIDiscard(g)},reason:'弃置超额水晶'};
  const claims = g.golemMarket.flatMap((id, index) => has(player.stock, GOLEM_BY_ID[id].cost)
    ? [{ index, points:GOLEM_BY_ID[id].points, coin:index === 0 && (g.copper || g.silver) ? (g.copper ? 3 : 1) : index === 1 && g.silver && g.copper ? 1 : 0 }]
    : []);
  if (claims.length) {
    claims.sort((a,b) => (b.points + b.coin * 1.7) - (a.points + a.coin * 1.7));
    return {action:{type:'claim',index:claims[0].index},reason:'认领可支付的魔像'};
  }
  type Candidate = {action: Action; value: number; reason: string};
  const candidates: Candidate[] = [];
  const before = stockFitness(g, player.stock);
  const plan = (action: Action, bonus: number, reason: string) => {
    try {
      let simulated = applyAction(g, action);
      if (simulated.phase === 'overflow') simulated = applyAction(simulated, {type:'discard',colors:chooseAIDiscard(simulated)});
      const gained = stockFitness(g, simulated.players[g.current].stock) - before;
      const after = simulated.players[g.current];
      let utility = gained + bonus;
      // 避免把所有水晶变成无用的单一颜色，或过度扩张商人卡。
      if (action.type === 'acquire') utility -= Math.max(0, after.hand.length + after.played.length - 6) * 0.55;
      candidates.push({action,value:utility,reason});
    } catch { /* 不合法的候选由引擎拦截 */ }
  };
  for (const id of player.hand) {
    const card = MERCHANT_BY_ID[id];
    if (card.kind === 'create') {
      plan({type:'play',cardId:id}, 0.38, '创造水晶');
    } else if (card.kind === 'upgrade') {
      for (const steps of upgradeVariants(player.stock, card.steps!)) {
        plan({type:'play',cardId:id,steps}, 0.35 + steps.length * 0.17, '升级水晶');
      }
    } else {
      for (let repeats = 1; repeats <= tradeLimit(player.stock, id); repeats++) {
        plan({type:'play',cardId:id,repeats}, 0.48, '交易水晶');
      }
    }
  }
  // 中前期购买优质引擎卡；越接近终局越重视立即转换与认领。
  const gameProgress = Math.max(0.02, 1 - player.turns / 18);
  if (player.hand.length + player.played.length < 9 && g.triggerPlayer === null) {
    g.merchantMarket.forEach((m, index) => {
      if (index > count(player.stock)) return;
      const card = MERCHANT_BY_ID[m.id];
      for (const payment of paymentVariants(player.stock, index)) {
        const gain = engineStrength(card, player.stock) * gameProgress;
        plan({type:'acquire',index,payment}, gain + 0.04 - index * 0.05, '获取商人卡');
      }
    });
  }
  // 休息重新激活旧引擎，需要消费完整一回合，先与其他选择公平比较。
  const goodPlayed = player.played.reduce((v,id) => v + engineStrength(MERCHANT_BY_ID[id], player.stock), 0);
  plan({type:'rest'}, player.played.length ? 0.25 + Math.min(2.5,goodPlayed * 0.22) : -2.5, '休息并回收商人卡');
  candidates.sort((a,b) => b.value - a.value);
  const best = candidates[0];
  if (!best) throw new Error('AI 没有可执行行动');
  return {action:best.action, reason:best.reason};
}
