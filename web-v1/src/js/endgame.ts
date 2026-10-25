/** 终局精确求解（AI7 任务 C1；只消费公开观察）。
 *
 * 动机（审计 §5.1 / §5.7，`TS-3P-FIN-003`）：
 * - 终局触发后，当前席位本局只剩**最后一次行动**（终局圈在本轮结束后结算），
 *   但冠军束搜索仍按"未来还能建设引擎/继续转换目标"的静态价值排序，
 *   把最后一手用于为下一次（不存在的）行动做准备；
 * - 官方计分 = 魔像分 + 铜币×3 + 银币×1 + **非黄水晶每颗 1 分**（黄 0 分），
 *   静态水晶价值（黄1/绿2/蓝3/粉4）不是终局残值；
 * - 容量溢出弃置在终局圈同样应按"最终得分最大"选择，而不是按中期目标缺口。
 *
 * 本模块做三件可精确证明的事（全部只用 AIObservation 公开信息）：
 * 1. `finalScoreOfAction`：对单个合法根行动计算**当前席位最终官方得分**
 *    （含认领得分/硬币、创造/升级/交易的净非黄变化、获取支付与卡面奖励、
 *    以及强制弃置的终局最优口径）；
 * 2. `opponentOneActionUpperBound`：对**尚未行动**的每个对手，计算其在本轮
 *    唯一一次行动中可能取得的得分增益上界（公开手牌/库存/市场），绝不假设
 *    对手不行动；
 * 3. `solveFinalAction`：按"保证名次优先、最终得分次之、乐观名次与目标封锁
 *    再次之"的字典序选择行动，并披露每个候选的精确得分与名次界。
 *
 * 名义边界：对手上界只使用**当前公开市场**（补牌顺序不可见，不用未翻开牌库
 * 猜测）；因此 `guaranteedRank` 是"公开信息 + 对手单动作上界"下的保守名次，
 * 不是含未知补牌的完整极小极大证明。该口径在返回值中显式披露。
 *
 * 禁止：硬编码具体对局/回合/卡 ID/席位；不读取隐藏牌库；不改变非终局决策。
 */

import type { Action, Color } from '../engine.js';
import { count, has, tradeLimit } from '../engine.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import type { AIObservation, ObservationPlayer } from '../ai/observation.js';

export type FinalScoreCandidate = {
  action: Action;
  /** 当前席位执行该行动后的最终官方得分（含终局弃置）。 */
  ownFinalScore: number;
  /** 执行后的库存（已弃置到 ≤10）。 */
  stockAfter: Stock;
  /** 终局口径下强制弃置的颜色。 */
  discarded: Color[];
};

export type OpponentBound = {
  seat: number;
  /** 当前公开得分。 */
  current: number;
  /** 本轮仍有一次行动时的得分上界；已行动席位等于当前得分。 */
  upper: number;
  /** 是否仍会在本轮行动（座位序在当前席位之后）。 */
  actsAfter: boolean;
  /** 其单次行动可取得的最大得分增益（已行动席位为 0）。 */
  maxGain: number;
};

export type EndgameAlternative = {
  action: Action;
  ownFinalScore: number;
  guaranteedRank: number;
  optimisticRank: number;
};

export type EndgameSolution = {
  action: Action;
  ownFinalScore: number;
  guaranteedRank: number;
  optimisticRank: number;
  discarded: Color[];
  stockAfter: Stock;
  opponents: OpponentBound[];
  /** 与未行动时相比，本行动从市场移除/保留的对手可认领分值（封锁价值）。 */
  denial: number;
  alternatives: EndgameAlternative[];
  /** 名次界的口径披露（不含未知补牌的极小极大）。 */
  rankModel: 'public-market-one-action-bound';
  evaluatedActions: number;
};

const color = (c: number): c is Color => Number.isInteger(c) && c >= 0 && c <= 3;

/** 终局触发后，当前席位的下一次行动就是本局最后一次（终局圈在本轮结束结算）。 */
export function isFinalOwnAction(view: AIObservation): boolean {
  return view.phase === 'turn' && view.triggerPlayer !== null;
}

/** 终局最优弃置：非黄每颗 1 分、黄 0 分 ⇒ 先弃黄，再按颜色升序弃非黄。
 * 只用于终局圈（此时该席位不会再有行动，任何非黄留存都严格优于黄）。 */
export function endgameDiscardColors(stock: readonly number[], excess: number): Color[] {
  if (!Number.isSafeInteger(excess) || excess < 0) throw new Error(`非法弃置数量：${String(excess)}`);
  const remaining = [...stock] as Stock;
  if (count(remaining) < excess) throw new Error(`库存不足以弃置 ${excess} 颗`);
  const colors: Color[] = [];
  for (let c = 0; c < 4 && colors.length < excess; c++) {
    while (remaining[c] > 0 && colors.length < excess) {
      remaining[c] -= 1;
      colors.push(c as Color);
    }
  }
  return colors;
}

function officialScoreOf(
  player: Pick<ObservationPlayer, 'claimed'> & { copper: number; silver: number },
  stock: readonly number[],
): number {
  const golemPoints = player.claimed.reduce((sum, id) => sum + (GOLEM_BY_ID[id]?.points ?? 0), 0);
  return golemPoints + player.copper * 3 + player.silver
    + stock.slice(1).reduce((sum, x) => sum + x, 0);
}

/** 认领 0/1 号位的硬币奖励（与 engine.applyClaim 逐条一致）。 */
function claimCoin(index: number, copperPool: number, silverPool: number): { coin: number; copper: number; silver: number } {
  if (index === 0 && copperPool > 0) return { coin: 3, copper: 1, silver: 0 };
  if (index === 0 && copperPool === 0 && silverPool > 0) return { coin: 1, copper: 0, silver: 1 };
  if (index === 1 && copperPool > 0 && silverPool > 0) return { coin: 1, copper: 0, silver: 1 };
  return { coin: 0, copper: 0, silver: 0 };
}

/** 单行动后的当前席位最终得分（精确、公开信息）。非法行动返回 null。 */
export function finalScoreOfAction(view: AIObservation, action: Action): FinalScoreCandidate | null {
  if (!isFinalOwnAction(view)) return null;
  const me = view.players[view.playerId];
  if (!me || view.current !== view.playerId) return null;
  let stock = [...me.stock] as Stock;
  const claimed = [...me.claimed];
  let copper = me.copper;
  let silver = me.silver;

  if (action.type === 'claim') {
    const id = view.golemMarket[action.index];
    const golem = id ? GOLEM_BY_ID[id] : null;
    if (!golem || !has(stock, golem.cost)) return null;
    for (let c = 0; c < 4; c++) stock[c] -= golem.cost[c];
    const reward = claimCoin(action.index, view.copper, view.silver);
    copper += reward.copper;
    silver += reward.silver;
    claimed.push(id);
  } else if (action.type === 'play') {
    const card = MERCHANT_BY_ID[action.cardId];
    if (!card || !me.hand.includes(action.cardId)) return null;
    if (card.kind === 'create') {
      if (action.steps?.length || action.repeats !== undefined) return null;
      const out = card.output!;
      for (let c = 0; c < 4; c++) stock[c] += out[c];
    } else if (card.kind === 'upgrade') {
      const steps = action.steps ?? [];
      if (action.repeats !== undefined || steps.length > card.steps!) return null;
      for (const source of steps) {
        if (!color(source) || source >= 3 || stock[source] <= 0) return null;
        stock[source] -= 1;
        stock[source + 1] += 1;
      }
    } else {
      const repeats = action.repeats ?? 1;
      const limit = tradeLimit(stock, action.cardId);
      if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > limit) return null;
      for (let i = 0; i < repeats; i++) {
        if (!has(stock, card.input!)) return null;
        for (let c = 0; c < 4; c++) stock[c] -= card.input![c];
        for (let c = 0; c < 4; c++) stock[c] += card.output![c];
      }
    }
  } else if (action.type === 'acquire') {
    const offer = view.merchantMarket[action.index];
    if (!offer) return null;
    if (!Array.isArray(action.payment) || action.payment.length !== action.index) return null;
    for (const c of action.payment) {
      if (!color(c) || stock[c] <= 0) return null;
      stock[c] -= 1;
    }
    for (let c = 0; c < 4; c++) stock[c] += offer.bonus[c];
  } else if (action.type === 'rest') {
    // 休息只收回已打出卡，不改库存与得分。
  } else {
    return null;
  }

  let discarded: Color[] = [];
  if (count(stock) > 10) {
    discarded = endgameDiscardColors(stock, count(stock) - 10);
    for (const c of discarded) stock[c] -= 1;
  }
  return {
    action,
    ownFinalScore: officialScoreOf({ claimed, copper, silver }, stock),
    stockAfter: stock,
    discarded,
  };
}

/** 单个对手在本轮唯一一次行动中的**得分增益上界**（公开信息）。
 * 口径说明：
 * - 认领：市场当前可支付魔像的（分值 + 硬币 − 非黄费用）；
 * - 创造：非黄产出（受 10 颗容量约束，溢出按终局弃黄口径不影响非黄）；
 * - 升级：最多把 min(步数, 黄水晶数) 颗黄升成绿（+1/颗）；
 * - 交易：重复到 tradeLimit 的净非黄增益（受容量约束）；
 * - 获取：卡面奖励非黄 − 最小非黄支付（先用黄支付；受容量约束）；
 * - 其余行动 0。
 * 只使用当前公开市场（对手认领后补牌未知，不猜测）。 */
export function opponentOneActionUpperBound(
  opponent: ObservationPlayer,
  view: AIObservation,
  golemMarket: readonly string[],
  copperPool: number,
  silverPool: number,
): number {
  const stock = [...opponent.stock] as Stock;
  const room = Math.max(0, 10 - count(stock));
  let best = 0;
  for (let index = 0; index < golemMarket.length; index++) {
    const golem = GOLEM_BY_ID[golemMarket[index]];
    if (!golem || !has(stock, golem.cost)) continue;
    const reward = claimCoin(index, copperPool, silverPool);
    const gain = golem.points + reward.coin
      - golem.cost.slice(1).reduce((sum, x) => sum + x, 0);
    if (gain > best) best = gain;
  }
  const yellow = stock[0];
  for (const id of opponent.hand) {
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') {
      const gain = Math.min(room, card.output!.slice(1).reduce((sum, x) => sum + x, 0));
      if (gain > best) best = gain;
    } else if (card.kind === 'upgrade') {
      const gain = Math.min(room, Math.min(card.steps!, yellow));
      if (gain > best) best = gain;
    } else {
      const limit = tradeLimit(stock, id);
      const net = card.output!.slice(1).reduce((sum, x) => sum + x, 0)
        - card.input!.slice(1).reduce((sum, x) => sum + x, 0);
      if (net > 0) {
        const gain = Math.min(room, limit * net);
        if (gain > best) best = gain;
      }
    }
  }
  for (let index = 0; index < view.merchantMarket.length; index++) {
    if (count(stock) < index) continue;
    const bonus = view.merchantMarket[index].bonus;
    const nonYellowPayment = Math.max(0, index - yellow);
    const gain = Math.min(room, bonus.slice(1).reduce((sum, x) => sum + x, 0) - nonYellowPayment);
    if (gain > best) best = gain;
  }
  return Math.max(0, best);
}

/** 官方名次比较：分数高者优先；平分时座位号大者（终局圈最后行动者）优先，
 * 与 engine.ranking 的 `score(b) − score(a) || b.id − a.id` 逐条一致。 */
function beatsUs(opponentSeat: number, opponentScore: number, mySeat: number, myScore: number): boolean {
  if (opponentScore !== myScore) return opponentScore > myScore;
  return opponentSeat > mySeat;
}

/** 市场封锁值：本行动移除的、对手（本轮仍会行动且上界超过我们）可立即认领的最高分值。
 * 只在同等名次/得分时作为确定性次级偏好，不改变主要目标。 */
function denialOf(
  beforeMarket: readonly string[],
  afterMarket: readonly string[],
  opponents: readonly OpponentBound[],
  myScore: number,
  view: AIObservation,
): number {
  const threats = opponents.filter(o => o.actsAfter && o.upper > myScore);
  let denied = 0;
  for (const id of beforeMarket) {
    if (afterMarket.includes(id)) continue;
    if (!GOLEM_BY_ID[id]) continue;
    for (const o of threats) {
      const p = view.players[o.seat];
      if (p && has(p.stock as Stock, GOLEM_BY_ID[id].cost)) {
        denied = Math.max(denied, GOLEM_BY_ID[id].points);
        break;
      }
    }
  }
  return denied;
}

/** 终局行动求解：枚举全部合法根行动，按字典序选择。
 *
 * 排序（确定性）：
 * 1. 保证名次升序（对手单动作上界下的最差名次）；
 * 2. 最终官方得分降序；
 * 3. 乐观名次升序（对手不行动时的名次，作为更接近实际的次级偏好）；
 * 4. 市场封锁值降序（同等条件下拿走对手可用的高分魔像）；
 * 5. 行动键升序（稳定）。
 *
 * 严格优于"静态目标价值"：得分是精确规则结算，名次按官方平分规则，
 * 且对仍会行动的对手使用上界而不是假设其不行动。 */
export function solveFinalAction(view: AIObservation, legalActions: readonly Action[]): EndgameSolution | null {
  if (!isFinalOwnAction(view)) return null;
  const candidates: Array<FinalScoreCandidate & {
    guaranteedRank: number;
    optimisticRank: number;
    denial: number;
  }> = [];

  for (const action of legalActions) {
    const scored = finalScoreOfAction(view, action);
    if (!scored) continue;
    const afterMarket = action.type === 'claim'
      ? view.golemMarket.filter((_, i) => i !== action.index)
      : view.golemMarket;
    // 我方认领会消耗公开硬币池：对手上界必须使用更新后的池。
    let copperPool = view.copper;
    let silverPool = view.silver;
    if (action.type === 'claim') {
      const reward = claimCoin(action.index, view.copper, view.silver);
      copperPool -= reward.copper;
      silverPool -= reward.silver;
    }
    const opponents: OpponentBound[] = view.players.map(p => {
      if (p.id === view.playerId) {
        return { seat: p.id, current: scored.ownFinalScore, upper: scored.ownFinalScore, actsAfter: false, maxGain: 0 };
      }
      const current = officialScoreOf(p, p.stock);
      const actsAfter = p.id > view.playerId;
      const maxGain = actsAfter
        ? opponentOneActionUpperBound(p, view, afterMarket, copperPool, silverPool)
        : 0;
      return { seat: p.id, current, upper: current + maxGain, actsAfter, maxGain };
    });
    let guaranteedRank = 1;
    let optimisticRank = 1;
    for (const o of opponents) {
      if (o.seat === view.playerId) continue;
      if (beatsUs(o.seat, o.upper, view.playerId, scored.ownFinalScore)) guaranteedRank += 1;
      if (beatsUs(o.seat, o.current, view.playerId, scored.ownFinalScore)) optimisticRank += 1;
    }
    candidates.push({
      ...scored,
      guaranteedRank,
      optimisticRank,
      denial: denialOf(view.golemMarket, afterMarket, opponents, scored.ownFinalScore, view),
    });
  }
  if (!candidates.length) return null;

  const rankKey = (a: EndgameAlternative) => JSON.stringify(a.action);
  candidates.sort((a, b) =>
    a.guaranteedRank - b.guaranteedRank
    || b.ownFinalScore - a.ownFinalScore
    || a.optimisticRank - b.optimisticRank
    || b.denial - a.denial
    || rankKey(a).localeCompare(rankKey(b)),
  );
  const best = candidates[0];
  const alternatives = candidates.slice(0, 5).map(c => ({
    action: c.action,
    ownFinalScore: c.ownFinalScore,
    guaranteedRank: c.guaranteedRank,
    optimisticRank: c.optimisticRank,
  }));
  // 对手界按座位序稳定输出（同分同 id 时保证可复现）。
  const bestAction = best.action;
  const bestClaimIndex = bestAction.type === 'claim' ? bestAction.index : null;
  const afterBestMarket = bestClaimIndex !== null
    ? view.golemMarket.filter((_, i) => i !== bestClaimIndex)
    : view.golemMarket;
  const finalOpponents = view.players.map(p => {
    if (p.id === view.playerId) {
      return { seat: p.id, current: best.ownFinalScore, upper: best.ownFinalScore, actsAfter: false, maxGain: 0 };
    }
    const current = officialScoreOf(p, p.stock);
    const actsAfter = p.id > view.playerId;
    let copperPool = view.copper;
    let silverPool = view.silver;
    if (bestClaimIndex !== null) {
      const reward = claimCoin(bestClaimIndex, view.copper, view.silver);
      copperPool -= reward.copper;
      silverPool -= reward.silver;
    }
    const maxGain = actsAfter
      ? opponentOneActionUpperBound(p, view, afterBestMarket, copperPool, silverPool)
      : 0;
    return { seat: p.id, current, upper: current + maxGain, actsAfter, maxGain };
  });

  return {
    action: best.action,
    ownFinalScore: best.ownFinalScore,
    guaranteedRank: best.guaranteedRank,
    optimisticRank: best.optimisticRank,
    discarded: best.discarded,
    stockAfter: best.stockAfter,
    opponents: finalOpponents,
    denial: best.denial,
    alternatives,
    rankModel: 'public-market-one-action-bound',
    evaluatedActions: candidates.length,
  };
}

/** 供测试/诊断使用：终局行动的精确最终得分表（无选择）。 */
export function finalScoreTable(view: AIObservation, legalActions: readonly Action[]): FinalScoreCandidate[] {
  const out: FinalScoreCandidate[] = [];
  for (const action of legalActions) {
    const scored = finalScoreOfAction(view, action);
    if (scored) out.push(scored);
  }
  return out;
}

