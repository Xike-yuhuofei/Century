/** 引擎价值 V2（AI7 任务 C2/C4；只消费公开观察）。
 *
 * 审计问题（§4.5 / §5.6）：冠军与联合搜索的引擎/商人卡估值来自静态卡面，
 * 没有回答"这张卡还能被真正使用几次"：
 * - 创造卡可反复产出，但需要休息回收、受 10 颗商队容量约束、终局前剩余
 *   自己回合数有限——静态估值把创造卡当成一次性收益，系统性低估；
 * - 升级卡的收益随剩余回合线性增长（每回合可把黄升绿 +1 终局分），晚期
 *   仍按满额估值；
 * - 休息与循环成本没有进入卡的边际价值（回收 N 张卡的收益按张数而非价值）；
 * - 获取商人卡的支付机会成本（付出的非黄水晶终局各值 1 分）未计入；
 * - 不同人数的竞争时序（5 人局目标被抢更快）没有进入引擎折扣。
 *
 * V2 的纪律（避免"简单偏向所有创造卡"）：
 * - 只在 `engineModel='v2'` 时启用；缺省 v1 逐位不变；
 * - 创造卡的重复收益必须同时满足：剩余自己回合 ≥2、容量还能容纳产出、
 *   回收循环可摊薄（engineSize 越大，单卡休息摊销越低）；
 * - 重复次数上限 3，且按人数竞争折扣缩放；
 * - 升级卡收益按剩余回合衰减；交易卡重复收益按净非黄产出与循环摊销；
 * - 支付机会成本只在实际获取估值中扣除，不改变卡牌本身价值。
 *
 * 本模块不读取隐藏牌库；`engineModelContext` 只用公开的回合数/认领数/人数。
 */

import type { Merchant, Golem, Stock } from '../data.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../data.js';
import type { AIObservation } from './observation.js';
import type { AIParameters } from './parameters.js';
import { cardEngineValue, engineValue as engineValueV1 } from './knowledge.js';
import { count } from '../engine.js';

export type EngineModelContext = {
  /** 按公开节奏估计的当前席位剩余自己回合数。 */
  remainingTurns: number;
  playerCount: number;
  /** 全局每张魔像所需的平均自己回合数（公开回合数/认领数）。 */
  turnsPerClaim: number;
  /** 竞争折扣（≥1；5 人局目标被抢更快，重复收益按此缩小）。 */
  competition: number;
  seatPolicy: 'flat' | 'stratified';
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** 由公开观察估计剩余回合与竞争强度。
 * 缺省 v1 调用方不构造本上下文（零额外成本）。 */
export function engineModelContext(view: AIObservation, params: AIParameters): EngineModelContext {
  const me = view.players[view.playerId];
  const threshold = view.players.length >= 4 ? 5 : 6;
  const remainingClaims = Math.max(0, threshold - (me?.claimed.length ?? 0));
  const totalTurns = view.players.reduce((sum, p) => sum + p.turns, 0);
  const totalClaims = view.players.reduce((sum, p) => sum + p.claimed.length, 0);
  // 早期无认领时按 5 回合/张的先验；随后用公开节奏自我修正。
  const turnsPerClaim = totalClaims > 0
    ? clamp(totalTurns / totalClaims, 2, 14)
    : 5;
  const seatPolicy = params.seatPolicy ?? 'flat';
  const competition = seatPolicy === 'stratified'
    ? 1 + 0.10 * Math.max(0, view.players.length - 2)
    : 1;
  return {
    remainingTurns: clamp(remainingClaims * turnsPerClaim, 0, 30),
    playerCount: view.players.length,
    turnsPerClaim,
    competition,
    seatPolicy,
  };
}

/** 创造卡重复收益：容量 + 剩余回合 + 回收循环三重约束。 */
function createRepeatBonus(card: Merchant, stock: readonly number[], ctx: EngineModelContext, engineSize: number): number {
  const output = card.output!;
  const growth = count(output);
  const room = Math.max(0, 10 - count(stock as Stock));
  // 每次打出都占用容量；容量不足以完成第一次产出时没有重复价值。
  const playsByRoom = growth > 0 ? Math.floor(room / growth) : 0;
  const cycle = 1 / (1 + 1 / Math.max(1, engineSize));
  const plays = Math.min(3, ctx.remainingTurns, playsByRoom);
  if (plays < 2) return 0;
  // 非黄产出直接计 1 分/颗；黄产出需要后续转换，按 0.35 折价。
  const perPlay = output.slice(1).reduce((s, x) => s + x, 0) + output[0] * 0.35;
  return perPlay * plays * cycle * 0.35 / ctx.competition;
}

/** 升级卡长期作用：剩余回合越多，逐回合黄→绿的 +1 分兑现越多。 */
function upgradeLongevityBonus(card: Merchant, stock: readonly number[], ctx: EngineModelContext): number {
  const yellow = stock[0];
  if (yellow <= 0) return 0;
  const usableSteps = Math.min(card.steps!, yellow);
  const horizon = clamp(ctx.remainingTurns / 10, 0, 1);
  return usableSteps * horizon * 0.20 / ctx.competition;
}

/** 交易卡重复使用：净非黄产出 × 循环摊销（黄输入按 0.5 机会成本折价）。
 * 只有当前库存付得起输入时才计入重复收益（真实可用性，不做纸面加成）。 */
function tradeRepeatBonus(card: Merchant, stock: readonly number[], ctx: EngineModelContext, engineSize: number): number {
  const input = card.input!;
  const output = card.output!;
  const netNonYellow = output.slice(1).reduce((s, x) => s + x, 0)
    - input.slice(1).reduce((s, x) => s + x, 0);
  if (netNonYellow <= 0) return 0;
  const yellowInputCost = input[0] * 0.5;
  const cycle = 1 / (1 + 1 / Math.max(1, engineSize));
  const repeats = Math.min(2, ctx.remainingTurns / 4);
  const payable = input.every((n, c) => stock[c] >= n);
  const reachFactor = payable ? 1 : 0.35;
  return Math.max(0, netNonYellow - yellowInputCost) * repeats * cycle * reachFactor * 0.20 / ctx.competition;
}

/** 单卡引擎价值 V2 = 冻结 V1 价值 + 显式的重复/长期/循环项。 */
export function cardEngineValueV2(
  card: Merchant,
  stock: readonly number[],
  goal: Golem | null,
  ctx: EngineModelContext,
  engineSize: number,
): number {
  const base = cardEngineValue(card, stock, goal);
  if (card.kind === 'create') return base + createRepeatBonus(card, stock, ctx, engineSize);
  if (card.kind === 'upgrade') return base + upgradeLongevityBonus(card, stock, ctx);
  return base + tradeRepeatBonus(card, stock, ctx, engineSize);
}

/** 整套引擎价值 V2。 */
export function engineValueV2(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  preferred: string | null,
  ctx: EngineModelContext,
): number {
  const goal: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  const engineSize = state.hand.length + state.played.length;
  return [...state.hand, ...state.played].reduce((sum, id) => {
    const card = MERCHANT_BY_ID[id];
    return sum + (card ? cardEngineValueV2(card, state.stock, goal, ctx, engineSize) : 0);
  }, 0);
}

/** 引擎价值分派：v1（冻结冠军口径）或 v2（显式模型上下文）。
 * 缺省参数/缺上下文一律走 v1，保证生产行为逐位不变。 */
export function engineValueFor(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  preferred: string | null,
  params: AIParameters,
  model: EngineModelContext | null,
): number {
  if (params.engineModel === 'v2' && model) return engineValueV2(state, preferred, model);
  return engineValueV1(state, preferred);
}

/** 获取商人卡的支付机会成本（终局口径）：付出 i 颗水晶时先用黄支付；
 * 每颗非黄支付损失 1 分，每颗黄支付按 0.5 分的机会成本计。 */
export function acquisitionPaymentOpportunityCost(stock: readonly number[], index: number): number {
  if (index <= 0) return 0;
  const yellowUsed = Math.min(stock[0], index);
  const nonYellowUsed = Math.max(0, index - yellowUsed);
  return yellowUsed * 0.5 + nonYellowUsed * 1;
}

/** 获取后新卡进入引擎的重复价值增量（只计 V2 相对 V1 的显式增量）。 */
export function acquisitionRepeatDelta(
  cardId: string,
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  preferred: string | null,
  ctx: EngineModelContext,
): number {
  const card = MERCHANT_BY_ID[cardId];
  if (!card) return 0;
  const goal: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  const engineSize = state.hand.length + state.played.length + 1;
  return cardEngineValueV2(card, state.stock, goal, ctx, engineSize) - cardEngineValue(card, state.stock, goal);
}

