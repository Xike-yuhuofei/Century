/** 局面分类与客观约束推导（战术基准专用）。
 *
 * 原则：分类只使用公开可观察事实（AIObservation 同源字段），启发式阈值全部
 * 写明并随语料披露；"客观约束"是规则层可直接验证的事实，"战略假设"是需要
 * 模拟才能验证的命题——两者严格分离，不编造唯一正确答案。
 */

import { tradeLimit } from '../../../web-v1/dist/js/engine.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../../../web-v1/dist/js/data.js';

/** 行动稳定键：同一行动的不同等价写法归一到同一键（engine 接受条件口径：
 * play 的 steps 缺省 ≡ []、trade 的 repeats 缺省 ≡ 1）。 */
export function actionKey(action) {
  switch (action.type) {
    case 'play': {
      const steps = action.steps?.length ? `:s${action.steps.join('')}` : '';
      const repeats = action.repeats !== undefined ? `:r${action.repeats}` : '';
      return `play:${action.cardId}${repeats}${steps}`;
    }
    case 'acquire':
      return `acq:${action.index}:p${action.payment.join('')}`;
    case 'claim':
      return `claim:${action.index}`;
    case 'rest':
      return 'rest';
    case 'discard':
      return `disc:${action.colors.join('')}`;
    default:
      throw new Error(`未知行动类型：${JSON.stringify(action)}`);
  }
}

/** 终局触发所需认领数（engine.applyClaim 口径：≥4 人 5 张，否则 6 张）。 */
export const targetClaims = (playerCount) => (playerCount >= 4 ? 5 : 6);

/** 当前席位之后的行动次序（本圈后手 → 下圈先手；终局已触发则仅剩本圈后手）。
 * engine.finishAction 口径：触发终局后 next===0 即结束，席位 0..current-1 不再行动。 */
export function laterSeatOrder(current, playerCount, triggerPlayer) {
  const rest = [];
  const last = (current + playerCount - 1) % playerCount;
  for (let s = (current + 1) % playerCount; ; s = (s + 1) % playerCount) {
    if (s === 0 && triggerPlayer !== null) break;
    rest.push(s);
    if (s === last) break;
  }
  return rest;
}

/** 对公开观察做全量客观分析（分类、竞争、约束推导共用）。 */
export function analyzePosition(view, legalActions) {
  const n = view.players.length;
  const target = targetClaims(n);
  const me = view.players[view.current];
  const stockCount = me.stock.reduce((a, b) => a + b, 0);

  // 魔像市场可负担性矩阵（规则层事实）。
  const golems = view.golemMarket.map((id, index) => {
    const cost = GOLEM_BY_ID[id].cost;
    const affordSeats = [];
    const nearSeats = [];
    for (const p of view.players) {
      const missing = cost.reduce((s, c, i) => s + Math.max(0, c - p.stock[i]), 0);
      if (missing === 0) affordSeats.push(p.id);
      else if (missing <= 2) nearSeats.push({ seat: p.id, missing });
    }
    return {
      index, id, points: GOLEM_BY_ID[id].points, cost: [...cost],
      affordableByCurrent: affordSeats.includes(view.current),
      affordSeats, nearSeats,
      claimActionCount: affordSeats.length,
    };
  });
  const claimable = golems.filter(g => g.affordableByCurrent);

  // 商人市场：当前席位可支付位置（规则层事实：费用 = 市场位置序号）。
  const affordableAcquires = [];
  for (let index = 0; index < view.merchantMarket.length; index++) {
    if (stockCount >= index) {
      affordableAcquires.push({
        index, id: view.merchantMarket[index].id,
        bonus: [...view.merchantMarket[index].bonus],
        slotsAbove: view.merchantMarket.length - 1 - index,
      });
    }
  }
  const highAcquires = affordableAcquires.filter(a => a.index >= 2);

  const playedCount = me.played.length;
  const handTradeCards = me.hand.filter(id => MERCHANT_BY_ID[id]?.kind === 'trade');
  const maxClaims = Math.max(...view.players.map(p => p.claimed.length));
  const triggerSet = view.triggerPlayer !== null;
  const opponentOneAway = view.players.some(p => p.id !== view.current && p.claimed.length === target - 1);
  const laterSeats = laterSeatOrder(view.current, n, view.triggerPlayer);
  const contestedGolems = golems.filter(g => g.claimActionCount >= 2);
  const seatRaceGolems = claimable.filter(g => laterSeats.some(s => g.affordSeats.includes(s)));
  const canTriggerNow = claimable.some(g => me.claimed.length + 1 >= target);

  // —— 十类目标标签（全部为公开事实上的启发式，阈值在此声明）——
  const tags = [];
  if (triggerSet) tags.push('final-round');
  if (!triggerSet && opponentOneAway) tags.push('opponent-ending');
  if (contestedGolems.length > 0 && (golems.some(g => g.claimActionCount >= 2) || golems.some(g => g.affordSeats.length >= 1 && g.nearSeats.length >= 2))) tags.push('contested-claim');
  if (claimable.length >= 2) tags.push('multi-claim');
  if (seatRaceGolems.length > 0) tags.push('seat-race');
  if (claimable.length >= 1 && highAcquires.length > 0) tags.push('acquire-vs-score');
  if (stockCount >= 7) tags.push('caravan-pressure');
  if (playedCount >= 2 && handTradeCards.some(id => tradeLimit(me.stock, id) >= 1)) tags.push('trade-chain-rest');
  if (me.hand.length + playedCount >= 7 && me.claimed.length <= 1) tags.push('engine-overinvest');
  if (me.stock[2] >= 2 || me.stock[3] >= 2 || (me.stock[2] >= 1 && me.stock[3] >= 1)) tags.push('conversion-efficiency');

  // 主分类：按叙事强度排序取第一个命中（语料配额键 = 主分类 × 人数）。
  const priority = ['final-round', 'opponent-ending', 'contested-claim', 'multi-claim', 'seat-race', 'acquire-vs-score', 'caravan-pressure', 'trade-chain-rest', 'conversion-efficiency', 'engine-overinvest'];
  const primaryCategory = priority.find(t => tags.includes(t)) ?? 'general-position';

  // 阶段 / 竞争强度 / 搜索难度（口径见 README）。
  const stage = triggerSet || maxClaims >= target - 1 ? 'endgame' : view.turnNumber <= 2 * n ? 'opening' : 'midgame';
  const competition = contestedGolems.length >= 2 ? 'high' : contestedGolems.length === 1 ? 'medium' : 'low';
  const difficulty = legalActions.length >= 200 ? 'XL' : legalActions.length >= 60 ? 'L' : legalActions.length >= 15 ? 'M' : 'S';

  return {
    tags, primaryCategory, stage, competition, difficulty,
    stockCount, target, maxClaims, triggerSet, canTriggerNow, opponentOneAway,
    golems, claimable, affordableAcquires, highAcquires,
    contestedGolems: contestedGolems.map(g => g.index),
    seatRaceGolems: seatRaceGolems.map(g => g.index),
    laterSeats, handTradeCards: [...handTradeCards], playedCount,
  };
}

const readableStock = (stock) => ['黄', '绿', '蓝', '粉'].map((c, i) => stock[i] ? `${c}×${stock[i]}` : '').filter(Boolean).join('') || '无';

/** 客观规则约束（可由正式引擎逐条机械验证的事实）。 */
export function objectiveConstraints(view, analysis) {
  const list = [];
  const me = view.players[view.current];
  const target = analysis.target;
  if (analysis.claimable.length > 0) {
    for (const g of analysis.claimable) {
      list.push(`当前席位 ${view.current} 可立即认领 ${view.golemMarket[g.index]}（${g.points} 分，成本 ${readableStock(g.cost)}），认领后 ${me.claimed.length + 1}/${target} 张`);
    }
  } else {
    list.push('当前席位无法立即认领任何魔像（费用不可支付）');
  }
  for (const g of analysis.golems) {
    if (g.affordSeats.some(s => s !== view.current)) {
      list.push(`魔像 ${g.id} 亦可被席位 ${g.affordSeats.filter(s => s !== view.current).join('、')} 支付认领`);
    }
  }
  if (view.triggerPlayer !== null) list.push(`终局已由席位 ${view.triggerPlayer} 触发，本圈结束即结算`);
  else list.push(`终局未触发；任一席位认领至 ${target} 张即触发`);
  if (analysis.opponentOneAway) {
    const seats = view.players.filter(p => p.id !== view.current && p.claimed.length === target - 1).map(p => p.id);
    list.push(`席位 ${seats.join('、')} 再认领 1 张魔像即触发终局`);
  }
  list.push(`当前席位库存 ${analysis.stockCount}/10 颗（${readableStock(me.stock)}）；超额将进入弃置阶段`);
  list.push(`公共币池：铜 ${view.copper}、银 ${view.silver}（0 号位认领得铜币 3 分，0 号位无铜且 1 号位有银时 1 号位得银币 1 分）`);
  if (analysis.playedCount > 0) list.push(`当前席位已打出 ${analysis.playedCount} 张商人卡，休息可收回但需重新打出`);
  if (analysis.highAcquires.length > 0) {
    const ids = analysis.highAcquires.map(a => `位置${a.index}(${a.id})`).join('、');
    list.push(`当前席位可支付获取市场位置：${ids}（越深费用越高、奖励越多）`);
  }
  list.push(`当前合法行动共 ${analysis.legalActionCount} 种（正式引擎全量口径）`);
  return list;
}

/** 战略假设（必须经模拟才能验证，不得作为事实断言）。 */
export function strategicHypotheses(view, analysis) {
  const list = [];
  const me = view.players[view.current];
  if (analysis.claimable.length > 0 && analysis.seatRaceGolems.length > 0) {
    list.push(`若当前席位本回合不认领 ${analysis.seatRaceGolems.map(i => view.golemMarket[i]).join('、')}，后续行动席位（${analysis.laterSeats.join('、')}）可能在其下次行动前夺走——存活率需模拟验证`);
  }
  if (analysis.tags.includes('acquire-vs-score')) {
    list.push('立即认领得分与获取关键商人卡的取舍：取决于剩余回合数、牌库未知卡分布与对手竞争强度，需多世界模拟验证期望分差');
  }
  if (analysis.tags.includes('caravan-pressure')) {
    list.push('商队接近上限时的获取决策需权衡弃置损失与卡面奖励，最优弃置颜色取决于后续目标费用（需模拟）');
  }
  if (analysis.tags.includes('engine-overinvest')) {
    list.push('继续投资引擎（获取/打出商人卡）与转向认领得分的收益交叉点随剩余回合数变化，需模拟验证');
  }
  if (analysis.tags.includes('conversion-efficiency')) {
    list.push('高阶水晶（蓝/粉）用于当前认领还是保留给后续高费魔像，取决于魔像牌库剩余构成（公开集合层面可部分推断，顺序未知）');
  }
  if (analysis.tags.includes('trade-chain-rest')) {
    list.push('交易链再打一张 vs 提前休息收回手牌的节奏取舍，需按剩余回合数模拟验证');
  }
  if (view.triggerPlayer === null && !analysis.opponentOneAway && analysis.stage === 'endgame') {
    list.push('临近终局时的认领节奏（先抢触发权还是后发制人）与座位次序交互，需模拟验证');
  }
  list.push('各冻结版本建议行动的分歧本身即研究素材：分歧不判定对错，需以对局模拟（胜率/名次分布）评估');
  return list;
}
