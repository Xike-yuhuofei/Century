// @ts-nocheck
/** V2.0：离线目标规划 + 多回合束搜索。
 * 规划只使用公开市场、自身牌/水晶与公开比分，不读取两类隐藏牌库顺序。
 * 未来对手回合和未知翻牌保持不确定；使用当前公开市场作保守近似。
 */
import { GOLEM_BY_ID, MERCHANT_BY_ID } from './data.js';
import { applyAction, count, has, tradeLimit } from './engine.js';

const VALUES = [1, 1.7, 2.5, 3.4];
const weighted = stock => stock.reduce((sum, n, color) => sum + n * VALUES[color], 0);
const stockCount = stock => stock[0] + stock[1] + stock[2] + stock[3];
const cloneStock = stock => [...stock];

function goalGap(stock, goal) {
  return goal.cost.reduce((sum, needed, color) => sum + Math.max(0, needed - stock[color]) * VALUES[color], 0);
}
function stockPotential(stock, goals) {
  if (!goals.length) return weighted(stock) * .13;
  return Math.max(...goals.map(id => {
    const card = GOLEM_BY_ID[id];
    const total = weighted(card.cost);
    return card.points * Math.max(0, 1 - goalGap(stock, card) / (total + 2));
  }));
}
function keepValue(stock, goals, preferred) {
  const target = preferred ? GOLEM_BY_ID[preferred] : null;
  const coverage = target ? target.cost.reduce((sum, amount, c) => sum + Math.min(amount, stock[c]) * VALUES[c], 0) : 0;
  return coverage * 3 + stockPotential(stock, goals) * 1.2 + weighted(stock) * .16;
}
function trimStock(source, goals, preferred) {
  const stock = cloneStock(source), discarded = [];
  while (stockCount(stock) > 10) {
    let color = -1, best = -Infinity;
    for (let c = 0; c < 4; c++) {
      if (stock[c] === 0) continue;
      stock[c]--;
      const rating = keepValue(stock, goals, preferred);
      stock[c]++;
      if (rating > best) { best = rating; color = c; }
    }
    if (color < 0) throw Error('超额水晶弃置失败');
    stock[color]--;
    discarded.push(color);
  }
  return { stock, discarded };
}

function upgradeVariants(stock, max) {
  const variants = new Map();
  function search(s, steps) {
    if (steps.length) {
      const key = s.join(',');
      if (!variants.has(key) || variants.get(key).length > steps.length) variants.set(key, steps);
    }
    if (steps.length === max) return;
    for (let c = 0; c < 3; c++) {
      if (!s[c]) continue;
      const next = cloneStock(s);
      next[c]--; next[c + 1]++;
      search(next, [...steps, c]);
    }
  }
  search(stock, []);
  return [...variants.values()];
}

// 压晶只枚举不同颜色组合；同色组合排序后对应唯一的合法实际支付顺序。
function payments(stock, index, goals, preferred) {
  if (index === 0) return [[]];
  if (stockCount(stock) < index) return [];
  const result = [];
  function walk(color, left, selected, rest) {
    if (color === 4) {
      if (left === 0) result.push({ payment: selected, value: keepValue(rest, goals, preferred) });
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

function cardEngineValue(card, stock, goal) {
  if (card.kind === 'create') {
    const useful = goal ? card.output.reduce((s, n, c) => s + Math.min(n, Math.max(0, goal.cost[c] - stock[c])) * VALUES[c], 0) : 0;
    return weighted(card.output) * .32 + useful * .22;
  }
  if (card.kind === 'upgrade') return card.steps * .7;
  const gain = weighted(card.output) - weighted(card.input);
  const reachable = has(stock, card.input) ? 1 : .35;
  const targetMatch = goal ? card.output.reduce((s, n, c) => s + Math.min(n, goal.cost[c]) * VALUES[c], 0) : 0;
  return Math.max(0, gain) * .30 + reachable * .45 + targetMatch * .17;
}
function engineValue(state, preferred) {
  const goal = preferred ? GOLEM_BY_ID[preferred] : null;
  return [...state.hand, ...state.played].reduce((sum, id) => {
    const card = MERCHANT_BY_ID[id];
    return sum + (card ? cardEngineValue(card, state.stock, goal) : 0);
  }, 0);
}
function publicState(game) {
  const player = game.players[game.current];
  return {
    stock: cloneStock(player.stock), hand: [...player.hand], played: [...player.played],
    merchantMarket: game.merchantMarket.map(m => ({ id: m.id, bonus: cloneStock(m.bonus) })),
    golemMarket: [...game.golemMarket], copper: game.copper, silver: game.silver,
    gained: 0, claimed: 0, acquired: 0, steps: 0, first: null, path: [],
  };
}
function actions(state, preferred, allowAcquire) {
  const result = [];
  for (let i = 0; i < state.golemMarket.length; i++) {
    if (has(state.stock, GOLEM_BY_ID[state.golemMarket[i]].cost)) result.push({ type: 'claim', index: i });
  }
  for (const id of state.hand) {
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') result.push({ type: 'play', cardId: id });
    else if (card.kind === 'upgrade') {
      for (const steps of upgradeVariants(state.stock, card.steps)) result.push({ type: 'play', cardId: id, steps });
    } else {
      const limit = tradeLimit(state.stock, id);
      for (let repeats = 1; repeats <= limit; repeats++) result.push({ type: 'play', cardId: id, repeats });
    }
  }
  if (state.played.length) result.push({ type: 'rest' });
  if (allowAcquire && state.acquired === 0 && state.hand.length + state.played.length < 10) {
    state.merchantMarket.forEach((m, index) => {
      for (const payment of payments(state.stock, index, state.golemMarket, preferred)) {
        result.push({ type: 'acquire', index, payment });
      }
    });
  }
  if (!result.length) result.push({ type: 'rest' });
  return result;
}
function step(state, action, preferred) {
  const next = {
    ...state, stock: cloneStock(state.stock), hand: [...state.hand], played: [...state.played],
    merchantMarket: state.merchantMarket, golemMarket: state.golemMarket,
    steps: state.steps + 1, first: state.first ?? action, path: [...state.path, action],
  };
  if (action.type === 'play') {
    const card = MERCHANT_BY_ID[action.cardId];
    if (!card) return null;
    const i = next.hand.indexOf(action.cardId);
    if (i < 0) return null;
    if (card.kind === 'create') card.output.forEach((n, c) => { next.stock[c] += n; });
    else if (card.kind === 'upgrade') {
      for (const c of action.steps) {
        if (!next.stock[c]) return null;
        next.stock[c]--; next.stock[c + 1]++;
      }
    } else {
      for (let i = 0; i < action.repeats; i++) {
        if (!has(next.stock, card.input)) return null;
        card.input.forEach((n, c) => { next.stock[c] -= n; });
        card.output.forEach((n, c) => { next.stock[c] += n; });
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
  }
  next.stock = trimStock(next.stock, next.golemMarket, preferred).stock;
  return next;
}
function stateKey(state) {
  return [state.stock.join(','), [...state.hand].sort().join(','), [...state.played].sort().join(','),
    state.merchantMarket.map(x => x.id).join(','), state.golemMarket.join(','), state.acquired].join('|');
}
function searchGrade(state, preferred, stage) {
  const goal = GOLEM_BY_ID[preferred];
  const gap = goalGap(state.stock, goal);
  return -gap * 2.6 + weighted(state.stock) * .13
    + (engineValue(state, preferred) * stage * .22)
    - state.steps * .35 - state.acquired * .15;
}
function routeGrade(state, preferred, stage) {
  // gained 可能包括同一路径上先认领其他公开魔像取得的得分。
  return state.gained / Math.pow(state.steps + .65, .90)
    + weighted(state.stock) * .055 + engineValue(state, preferred) * stage * .085;
}
function completedFirstGoal(state, preferred) {
  return !state.golemMarket.includes(preferred);
}
function choosePlan(game) {
  const initial = publicState(game);
  const threshold = game.players.length >= 4 ? 5 : 6;
  const mostClaimed = Math.max(...game.players.map(p => p.claimed.length));
  const nearEnd = game.triggerPlayer !== null || mostClaimed >= threshold - 1;
  const depth = game.triggerPlayer !== null ? 1 : nearEnd ? 3 : 6;
  const width = nearEnd ? 12 : 18;
  const stage = game.triggerPlayer !== null ? 0 : Math.max(.12, 1 - mostClaimed / threshold);
  let solved = null, prospective = null;
  for (const preferred of initial.golemMarket) {
    let beam = [initial];
    for (let layer = 1; layer <= depth; layer++) {
      const successors = new Map();
      for (const position of beam) {
        const variants = actions(position, preferred, game.triggerPlayer === null);
        for (const action of variants) {
          const next = step(position, action, preferred);
          if (!next) continue;
          if (completedFirstGoal(next, preferred)) {
            const quality = routeGrade(next, preferred, stage);
            if (!solved || quality > solved.quality) solved = { ...next, preferred, quality };
            continue;
          }
          const quality = searchGrade(next, preferred, stage);
          const key = stateKey(next);
          if (!successors.has(key) || successors.get(key).quality < quality) successors.set(key, { ...next, quality });
        }
      }
      if (!successors.size) break;
      beam = [...successors.values()].sort((a, b) => b.quality - a.quality).slice(0, width);
      for (const candidate of beam) {
        const expected = GOLEM_BY_ID[preferred].points / (depth + .65 + goalGap(candidate.stock, GOLEM_BY_ID[preferred]) / 3)
          + engineValue(candidate, preferred) * stage * .12 - candidate.steps * .09;
        if (!prospective || expected > prospective.quality) prospective = { ...candidate, preferred, quality: expected };
      }
    }
  }
  // 有可信的实际认领路线时优先执行；未找到时采用多回合目标推进的最佳前缀。
  return solved ?? prospective;
}
export function chooseAIAction(game) {
  if (game.phase === 'finished') throw Error('游戏结束，AI 无法行动');
  const p = game.players[game.current];
  if (!p?.isAI) throw Error('当前行动者不是 AI');
  if (game.phase === 'overflow') {
    const discarded = trimStock(p.stock, game.golemMarket).discarded;
    return { action: { type: 'discard', colors: discarded }, reason: '保留目标水晶，弃置超额水晶' };
  }
  const plan = choosePlan(game);
  const action = plan?.first ?? { type: 'rest' };
  // 搜索转移为快速本地模型；真正的第一步必须由正式规则引擎再次核实。
  try { applyAction(game, action); }
  catch (error) {
    const fallback = actions(publicState(game), null, false).find(a => {
      try { applyAction(game, a); return true; } catch { return false; }
    });
    if (!fallback) throw error;
    return { action: fallback, reason: '合法动作保底选择' };
  }
  const goal = plan?.preferred;
  return {
    action,
    reason: goal ? `V2.0 规划 ${goal}：预计${plan.steps}次行动形成认领路线` : '公开市场暂无可规划目标',
    plan: plan ? { goal, steps: plan.steps, actions: plan.path } : undefined,
  };
}
