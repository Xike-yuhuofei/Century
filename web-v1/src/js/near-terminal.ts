/** 临近终局候选覆盖（P1-C；只消费公开观察）。
 *
 * 动机（c83f C10）：临近终局时冠军束搜索可能继续走"高色后续潜力"路线，
 * 而正式得分（魔像分 + 铜币×3 + 银币 + 非黄水晶）当步最优的合法行动
 * 落在根先验第 6/48，未进入 candidateCap=4 —— 联合模拟根本没有机会评估它。
 *
 * 本模块只做两件可证伪的小事：
 * 1. risk：公开信息判断"下一手是否可能被任何席位（含自己）凑满第 5/6 张
 *    魔像而触发终局"——已触发，或任一席位已领 threshold−1 且当前付得起
 *    市场任一魔像；
 * 2. argmaxImmediate：对全部合法根行动计算**当步正式净分**（含铜银币、
 *    非黄水晶、升级产色、强制弃置），返回最大者。
 *
 * 禁止：硬编码具体对局/回合/卡 ID/人类席位；不把中局改成即时分贪心
 * （调用方只在 risk=true 且显式 nearTerminalCandidate≠off 时注入一个候选）。
 * 后继价值的最终裁决仍由联合模拟 + 保守覆盖完成，本模块不直接改选行动。
 */

import type { AIObservation } from '../ai/observation.js';
import type { Action } from '../engine.js';
import { count, has, tradeLimit } from '../engine.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import { trimStock } from '../ai/evaluator.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';

export type NearTerminalRisk = {
  risky: boolean;
  reason: 'already-triggered' | 'player-can-trigger' | null;
  threshold: number;
  /** 已领 threshold−1 且当前付得起市场任一魔像的席位（公开信息）。 */
  threatenedSeats: number[];
  /** 其中是否包含自己。 */
  selfThreatened: boolean;
};

export type ImmediateScoreCandidate = {
  action: Action;
  /** 当步正式净分变化（已计入铜银币、非黄水晶、升级产色与强制弃置）。 */
  delta: number;
  scoreAfter: number;
  /** 强制弃置的水晶颗数（0 表示无溢出）。 */
  discarded: number;
};

/** 终局触发张数（与 engine.applyClaim 一致：>=4 人第 5 张，否则第 6 张）。 */
export function claimThreshold(playerCount: number): number {
  return playerCount >= 4 ? 5 : 6;
}

function officialScoreOf(player: { claimed: readonly string[]; copper: number; silver: number }, stock: readonly number[]): number {
  const golemPoints = player.claimed.reduce((sum, id) => sum + (GOLEM_BY_ID[id]?.points ?? 0), 0);
  return golemPoints + player.copper * 3 + player.silver + stock.slice(1).reduce((sum, x) => sum + x, 0);
}

/** 公开信息下的临近终局风险。 */
export function nearTerminalRisk(view: AIObservation): NearTerminalRisk {
  const threshold = claimThreshold(view.players.length);
  if (view.triggerPlayer !== null) {
    return {
      risky: true, reason: 'already-triggered', threshold,
      threatenedSeats: view.players.map(p => p.id), selfThreatened: true,
    };
  }
  const threatenedSeats: number[] = [];
  for (const p of view.players) {
    if (p.claimed.length < threshold - 1) continue;
    const canPay = view.golemMarket.some(id => {
      const goal = GOLEM_BY_ID[id];
      return !!goal && has(p.stock as Stock, goal.cost);
    });
    if (canPay) threatenedSeats.push(p.id);
  }
  return {
    risky: threatenedSeats.length > 0,
    reason: threatenedSeats.length > 0 ? 'player-can-trigger' : null,
    threshold,
    threatenedSeats,
    selfThreatened: threatenedSeats.includes(view.playerId),
  };
}

/** 单个合法根行动的当步正式净分（等价于正式引擎该步 score 变化）。
 * 非法/不可确定（overflow 阶段 discard 等）返回 null。 */
export function immediateOfficialScoreDelta(view: AIObservation, action: Action): ImmediateScoreCandidate | null {
  if (view.playerId !== view.current) return null;
  const me = view.players[view.playerId];
  if (!me) return null;
  let stock = [...me.stock] as Stock;
  let copper = me.copper;
  let silver = me.silver;
  let delta = 0;
  let golemMarket: string[] | null = null;

  if (action.type === 'claim') {
    const id = view.golemMarket[action.index];
    const goal = id ? GOLEM_BY_ID[id] : null;
    if (!goal || !has(stock, goal.cost)) return null;
    // 硬币奖励由**公开资源池**支付（engine.applyClaim 语义），不是玩家已持硬币。
    // 修复前本函数误用玩家自己的 copper/silver 判断资格：当玩家 0 铜但池中
    // 有铜时，认领净分会少算 3 分，直接影响认领保护门槛。
    let copperPool = view.copper;
    let silverPool = view.silver;
    let coin = 0;
    if (action.index === 0 && copperPool > 0) { copperPool -= 1; copper += 1; coin = 3; }
    else if (action.index === 0 && copperPool === 0 && silverPool > 0) { silverPool -= 1; silver += 1; coin = 1; }
    else if (action.index === 1 && copperPool > 0 && silverPool > 0) { silverPool -= 1; silver += 1; coin = 1; }
    delta += goal.points + coin;
    delta -= goal.cost.slice(1).reduce((sum, x) => sum + x, 0);
    for (let c = 0; c < 4; c++) stock[c] -= goal.cost[c];
    golemMarket = view.golemMarket.filter((_, i) => i !== action.index);
  } else if (action.type === 'play') {
    const card = MERCHANT_BY_ID[action.cardId];
    if (!card || !me.hand.includes(action.cardId)) return null;
    if (card.kind === 'create') {
      if (action.steps?.length || action.repeats !== undefined) return null;
      const out = card.output!;
      for (let c = 0; c < 4; c++) stock[c] += out[c];
      delta += out.slice(1).reduce((sum, x) => sum + x, 0);
    } else if (card.kind === 'upgrade') {
      const steps = action.steps ?? [];
      if (action.repeats !== undefined || steps.length > card.steps!) return null;
      for (const source of steps) {
        if (!Number.isInteger(source) || source < 0 || source >= 3) return null;
        if (stock[source] <= 0) return null;
        stock[source] -= 1;
        stock[source + 1] += 1;
        // 黄→绿 +1 分；非黄→非黄净 0；黄最多 3 步（引擎限制）。
        if (source === 0) delta += 1;
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
      delta += repeats * (card.output!.slice(1).reduce((sum, x) => sum + x, 0)
        - card.input!.slice(1).reduce((sum, x) => sum + x, 0));
    }
  } else if (action.type === 'acquire') {
    const offer = view.merchantMarket[action.index];
    if (!offer) return null;
    if (!Array.isArray(action.payment) || action.payment.length !== action.index) return null;
    for (const color of action.payment) {
      if (!Number.isInteger(color) || color < 0 || color >= 4 || stock[color] <= 0) return null;
      stock[color] -= 1;
      if (color > 0) delta -= 1; // 非黄水晶离手 → 正式分 −1
    }
    for (let c = 0; c < 4; c++) stock[c] += offer.bonus[c];
    delta += offer.bonus.slice(1).reduce((sum, x) => sum + x, 0);
  } else if (action.type === 'rest') {
    // 休息只收回已打出卡，不改库存与得分。
  } else {
    return null;
  }

  let discarded = 0;
  if (count(stock) > 10) {
    // 溢出必须弃置；用冠军 trimStock 口径估算（公开信息 + 冻结参数）。
    const trimmed = trimStock(stock, golemMarket ?? view.golemMarket, null, CHAMPION_PARAMETERS);
    discarded = trimmed.discarded.length;
    delta -= trimmed.discarded.filter(c => c > 0).length;
    stock = trimmed.stock as Stock;
  }
  return { action, delta, scoreAfter: officialScoreOf({ ...me, copper, silver }, stock), discarded };
}

/** 全部合法根行动中当步正式净分最大者；仅在 delta>0 时返回（否则没有任何
 * "保留分"价值可保护）。平局按枚举顺序（认领先于打出/休息/获取）稳定取首个。 */
export function maxImmediateScoreAction(view: AIObservation, actions: readonly Action[]): ImmediateScoreCandidate | null {
  let best: ImmediateScoreCandidate | null = null;
  for (const action of actions) {
    const candidate = immediateOfficialScoreDelta(view, action);
    if (!candidate || candidate.delta <= 0) continue;
    if (!best || candidate.delta > best.delta) best = candidate;
  }
  return best;
}
