/** PublicHistory：公开行为历史系统（AI6 第三阶段·任务 A）。
 *
 * 职责：
 * - 定义 PublicEvent（单次公开行动事件）与 PublicHistorySummary（增量维护的
 *   公开历史摘要：固定容量事件窗口 + 每席位聚合特征）；
 * - 事件推导：只由"行动前后的合法公开观察 + 公开行动"生成——同一推导函数
 *   同时服务两条路径：
 *   · 真实对局路径：buildObservation 产出的 AIObservation 前后对（公开字段白名单
 *     已由 observation.ts 结构性保证；Game.replay 永不进入本模块——replay.initial
 *     含完整牌库，属于禁止输入）；
 *   · 模拟路径：PublicSimState 前后对（状态本身只含公开信息）。
 * - 增量更新：appendEvent 为 O(1)（窗口滑动 + 聚合计数），从不重扫全部历史；
 * - 降级：中途接入/旧存档没有历史时，以 origin='empty' 的空摘要启动，
 *   下游模型据此回退到先验（见 src/om/）。
 *
 * 信息边界（不可妥协）：
 * - 事件内容 = 公开状态差分 + 公开行动参数；真实隐藏牌序在两条输入路径中
 *   结构性不存在；tests/om-history.test.mjs 以"隐藏牌序扰动不变性"强制验证；
 * - 正式对局历史与模拟分支历史严格隔离：buildPublicSimState / cloneCore 对
 *   摘要深拷贝，模拟分支的事件追加绝不回写真实对局的摘要对象。
 *
 * Node / 浏览器兼容：纯 TypeScript，无平台专属 API。
 */

import type { Action, Color } from '../engine.js';
import { GOLEM_BY_ID, type Stock } from '../data.js';
import type { AIObservation } from '../ai/observation.js';
import type { PublicSimState } from './state.js';

// === 事件类型 ===

/** 水晶快照对（行动前 / 行动后）。 */
export type StockDelta = { before: Stock; after: Stock };

/** 公开列表差分（多重集语义：removed/added 为无序 id 列表）。 */
export type ListDelta = { removed: string[]; added: string[] };

/** 全部事件共享的公开字段。 */
type PublicEventCommon = {
  /** 行动者席位。 */
  actor: number;
  /** 行动开始时的回合计数（与 engine.turnNumber 同口径）。 */
  turn: number;
  /** 1 起始轮次 = floor((turn-1)/playerCount)+1（与 engine.replay.round 同口径）。 */
  round: number;
  /** 行动开始时的阶段（'finished' 不可能：终局后无行动）。 */
  phase: 'turn' | 'overflow';
  /** 行动开始时终局是否已触发（终局整轮内）。 */
  endgame: boolean;
};

/** 打出商人卡（创造/升级/交易；公开参数 = 卡 id + 升级步序或交易次数）。 */
export type PlayEvent = PublicEventCommon & {
  kind: 'play';
  cardId: string;
  steps: Color[];
  repeats: number | null;
  stock: StockDelta;
  hand: ListDelta;
  played: ListDelta;
};

/** 获取商人卡（支付结构公开：支付色序决定前序槽位奖励归属）。 */
export type AcquireEvent = PublicEventCommon & {
  kind: 'acquire';
  index: number;
  cardId: string;
  payment: Color[];
  /** 支付注入前序槽位的奖励（slot, color）序列。 */
  bonusPaid: { slot: number; color: Color }[];
  /** 随卡收回的奖励水晶（目标槽位行动前 bonus）。 */
  bonusTaken: Stock;
  stock: StockDelta;
  hand: ListDelta;
  played: ListDelta;
  /** 被拿走的槽位（行动前形态）。 */
  marketRemoved: { id: string; bonus: Stock } | null;
  /** 补牌翻开的商人卡（牌库耗尽时为 null）。 */
  marketAdded: string | null;
};

/** 休息（收回全部已打出卡）。 */
export type RestEvent = PublicEventCommon & {
  kind: 'rest';
  hand: ListDelta;
  played: ListDelta;
};

/** 认领魔像（含 0/1 号位硬币奖励与终局触发标记）。 */
export type ClaimEvent = PublicEventCommon & {
  kind: 'claim';
  index: number;
  golemId: string;
  points: number;
  cost: Stock;
  coin: 'copper' | 'silver' | null;
  stock: StockDelta;
  hand: ListDelta;
  played: ListDelta;
  golemRemoved: string;
  /** 补牌翻开的魔像（牌库耗尽时为 null）。 */
  golemAdded: string | null;
  /** 本行动是否触发终局。 */
  triggersEnd: boolean;
  copperBefore: number;
  copperAfter: number;
  silverBefore: number;
  silverAfter: number;
};

/** 溢出弃置（同一玩家当前行动的收尾，不推进回合）。 */
export type DiscardEvent = PublicEventCommon & {
  kind: 'discard';
  colors: Color[];
  stock: StockDelta;
};

export type PublicEvent = PlayEvent | AcquireEvent | RestEvent | ClaimEvent | DiscardEvent;

export type PublicEventKind = PublicEvent['kind'];

// === 摘要类型 ===

/** 单席位聚合特征（增量维护；从窗口事件与全量计数两个口径推导）。 */
export type PublicPlayerHistory = {
  plays: number;
  acquires: number;
  claims: number;
  rests: number;
  discards: number;
  /** 获取支付水晶总颗数。 */
  crystalsPaid: number;
  /** 弃置水晶总颗数。 */
  crystalsDiscarded: number;
  copperGained: number;
  silverGained: number;
  /** 已认领魔像 id（认领顺序）。 */
  claimedGolems: string[];
  firstClaimTurn: number | null;
  /** 最近一次行动的回合（0 = 无记录）。 */
  lastActionTurn: number;
  lastEventKind: PublicEventKind | null;
};

/** 公开历史摘要：固定容量事件窗口 + 每席位聚合。
 * `window` 为旧→新顺序的保留事件（容量有限，滑动丢弃最旧）；
 * `perPlayer` 聚合计数覆盖全部已记录事件（不随窗口滑动收缩）。 */
export type PublicHistorySummary = {
  version: 1;
  /** 'empty'：无早期历史（中途接入/旧存档）——下游模型回退先验；
   * 'recorded'：包含记录方观察到的全部事件。 */
  origin: 'empty' | 'recorded';
  window: PublicEvent[];
  capacity: number;
  totalEvents: number;
  /** 窗口曾发生滑动丢弃（更早事件不可用）。 */
  truncated: boolean;
  fromTurn: number | null;
  toTurn: number | null;
  perPlayer: PublicPlayerHistory[];
};

/** 事件窗口缺省容量：紧凑特征口径，超长对局自动滑动。 */
export const HISTORY_WINDOW_CAPACITY = 48;

/** 空摘要（origin 缺省 'empty'：中途接入降级标记）。 */
export function createEmptyHistory(
  playerCount: number,
  options?: { capacity?: number; origin?: 'empty' | 'recorded' },
): PublicHistorySummary {
  const capacity = options?.capacity ?? HISTORY_WINDOW_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`历史窗口容量无效：${capacity}`);
  if (!Number.isInteger(playerCount) || playerCount < 2) throw new Error(`席位数量无效：${playerCount}`);
  return {
    version: 1,
    origin: options?.origin ?? 'empty',
    window: [],
    capacity,
    totalEvents: 0,
    truncated: false,
    fromTurn: null,
    toTurn: null,
    perPlayer: Array.from({ length: playerCount }, () => ({
      plays: 0, acquires: 0, claims: 0, rests: 0, discards: 0,
      crystalsPaid: 0, crystalsDiscarded: 0, copperGained: 0, silverGained: 0,
      claimedGolems: [], firstClaimTurn: null, lastActionTurn: 0, lastEventKind: null,
    })),
  };
}

/** 深拷贝摘要（正式对局历史 ⇄ 模拟分支历史的隔离边界）。 */
export function cloneHistory(summary: Readonly<PublicHistorySummary>): PublicHistorySummary {
  return {
    version: 1,
    origin: summary.origin,
    capacity: summary.capacity,
    totalEvents: summary.totalEvents,
    truncated: summary.truncated,
    fromTurn: summary.fromTurn,
    toTurn: summary.toTurn,
    window: summary.window.map(e => cloneEvent(e)),
    perPlayer: summary.perPlayer.map(p => ({
      ...p,
      claimedGolems: [...p.claimedGolems],
    })),
  };
}

function cloneEvent(e: PublicEvent): PublicEvent {
  const common = { actor: e.actor, turn: e.turn, round: e.round, phase: e.phase, endgame: e.endgame };
  switch (e.kind) {
    case 'play':
      return { ...common, kind: 'play', cardId: e.cardId, steps: [...e.steps], repeats: e.repeats,
        stock: { before: [...e.stock.before] as Stock, after: [...e.stock.after] as Stock },
        hand: { removed: [...e.hand.removed], added: [...e.hand.added] },
        played: { removed: [...e.played.removed], added: [...e.played.added] } };
    case 'acquire':
      return { ...common, kind: 'acquire', index: e.index, cardId: e.cardId, payment: [...e.payment],
        bonusPaid: e.bonusPaid.map(b => ({ slot: b.slot, color: b.color })),
        bonusTaken: [...e.bonusTaken] as Stock,
        stock: { before: [...e.stock.before] as Stock, after: [...e.stock.after] as Stock },
        hand: { removed: [...e.hand.removed], added: [...e.hand.added] },
        played: { removed: [...e.played.removed], added: [...e.played.added] },
        marketRemoved: e.marketRemoved ? { id: e.marketRemoved.id, bonus: [...e.marketRemoved.bonus] as Stock } : null,
        marketAdded: e.marketAdded };
    case 'rest':
      return { ...common, kind: 'rest',
        hand: { removed: [...e.hand.removed], added: [...e.hand.added] },
        played: { removed: [...e.played.removed], added: [...e.played.added] } };
    case 'claim':
      return { ...common, kind: 'claim', index: e.index, golemId: e.golemId, points: e.points,
        cost: [...e.cost] as Stock, coin: e.coin,
        stock: { before: [...e.stock.before] as Stock, after: [...e.stock.after] as Stock },
        hand: { removed: [...e.hand.removed], added: [...e.hand.added] },
        played: { removed: [...e.played.removed], added: [...e.played.added] },
        golemRemoved: e.golemRemoved, golemAdded: e.golemAdded, triggersEnd: e.triggersEnd,
        copperBefore: e.copperBefore, copperAfter: e.copperAfter,
        silverBefore: e.silverBefore, silverAfter: e.silverAfter };
    case 'discard':
      return { ...common, kind: 'discard', colors: [...e.colors],
        stock: { before: [...e.stock.before] as Stock, after: [...e.stock.after] as Stock } };
  }
}

/** O(1) 增量追加：窗口滑动 + 聚合更新。绝不重扫历史。 */
export function appendEvent(summary: PublicHistorySummary, event: PublicEvent): void {
  if (summary.window.length >= summary.capacity) {
    summary.window.shift();
    summary.truncated = true;
  }
  summary.window.push(event);
  summary.totalEvents += 1;
  summary.fromTurn = summary.fromTurn ?? event.turn;
  summary.toTurn = event.turn;
  const agg = summary.perPlayer[event.actor];
  if (!agg) throw new Error(`公开历史聚合缺少席位 ${event.actor}`);
  agg.lastActionTurn = event.turn;
  agg.lastEventKind = event.kind;
  switch (event.kind) {
    case 'play': agg.plays += 1; break;
    case 'acquire':
      agg.acquires += 1;
      agg.crystalsPaid += event.payment.length;
      break;
    case 'rest': agg.rests += 1; break;
    case 'claim':
      agg.claims += 1;
      agg.claimedGolems.push(event.golemId);
      if (agg.firstClaimTurn === null) agg.firstClaimTurn = event.turn;
      if (event.coin === 'copper') agg.copperGained += 1;
      else if (event.coin === 'silver') agg.silverGained += 1;
      break;
    case 'discard':
      agg.discards += 1;
      agg.crystalsDiscarded += event.colors.length;
      break;
  }
}

// === 公开快照投影与事件推导 ===

/** 最小公开快照：事件推导所需的全部公开字段（观察/模拟状态共用形态）。 */
export type PublicSnapshot = {
  players: { stock: Stock; hand: string[]; played: string[]; claimed: string[]; copper: number; silver: number }[];
  current: number;
  merchantMarket: { id: string; bonus: Stock }[];
  golemMarket: string[];
  copper: number;
  silver: number;
  phase: 'turn' | 'overflow' | 'finished';
  triggerPlayer: number | null;
  turnNumber: number;
};

/** AIObservation → 公开快照（观察的公开字段白名单由 observation.ts 保证）。 */
export function snapshotFromObservation(obs: Readonly<AIObservation>): PublicSnapshot {
  return {
    players: obs.players.map(p => ({
      stock: [...p.stock] as Stock,
      hand: [...p.hand],
      played: [...p.played],
      claimed: [...p.claimed],
      copper: p.copper,
      silver: p.silver,
    })),
    current: obs.current,
    merchantMarket: obs.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] as Stock })),
    golemMarket: [...obs.golemMarket],
    copper: obs.copper,
    silver: obs.silver,
    phase: obs.phase,
    triggerPlayer: obs.triggerPlayer,
    turnNumber: obs.turnNumber,
  };
}

/** PublicSimState → 公开快照（模拟状态本身只含公开信息）。 */
export function snapshotFromSimState(state: Readonly<PublicSimState>): PublicSnapshot {
  return {
    players: state.players.map(p => ({
      stock: [...p.stock] as Stock,
      hand: [...p.hand],
      played: [...p.played],
      claimed: [...p.claimed],
      copper: p.copper,
      silver: p.silver,
    })),
    current: state.current,
    merchantMarket: state.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] as Stock })),
    golemMarket: [...state.golemMarket],
    copper: state.copper,
    silver: state.silver,
    phase: state.phase,
    triggerPlayer: state.triggerPlayer,
    turnNumber: state.turnNumber,
  };
}

const requireThat = (condition: unknown, message: string) => { if (!condition) throw new Error(`公开历史事件推导失败：${message}`); };

/** 多重集差分：after 相对 before 新增的元素。 */
function multisetAdded(after: readonly string[], before: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of before) counts.set(id, (counts.get(id) ?? 0) + 1);
  const added: string[] = [];
  for (const id of after) {
    const c = counts.get(id) ?? 0;
    if (c > 0) counts.set(id, c - 1);
    else added.push(id);
  }
  return added;
}

const stockEqual = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);

/** 由"行动前快照 + 公开行动 + 行动后快照"推导单次公开事件。
 * 行动合法性由调用方保证（sim 路径 stepCore 已校验；真实路径 applyAction 已校验）；
 * 本函数只做公开差分一致性核验，差分与行动类型矛盾时抛错（立即暴露规则层缺陷）。 */
export function derivePublicEvent(before: PublicSnapshot, action: Action, after: PublicSnapshot): PublicEvent {
  requireThat(before.phase !== 'finished', '终局后不应存在行动');
  // after.phase === 'finished' 仅在终局触发的整轮结束时出现（engine.finishAction 语义；
  // 最后一次认领同时触发终局并收整轮时 before.triggerPlayer 可为 null）。
  requireThat(
    after.phase !== 'finished' || before.triggerPlayer !== null || after.triggerPlayer !== null,
    '终局状态出现在无终局触发的转移后',
  );
  const actor = before.current;
  requireThat(actor >= 0 && actor < before.players.length, `行动席位无效：${actor}`);
  const round = Math.floor((before.turnNumber - 1) / before.players.length) + 1;
  const common = {
    actor,
    turn: before.turnNumber,
    round,
    phase: before.phase === 'overflow' ? 'overflow' as const : 'turn' as const,
    endgame: before.triggerPlayer !== null,
  };
  const pb = before.players[actor];
  const pa = after.players[actor];
  const hand: ListDelta = { removed: multisetAdded(pb.hand, pa.hand), added: multisetAdded(pa.hand, pb.hand) };
  const played: ListDelta = { removed: multisetAdded(pb.played, pa.played), added: multisetAdded(pa.played, pb.played) };
  const stockDelta = (): StockDelta => ({ before: [...pb.stock] as Stock, after: [...pa.stock] as Stock });

  if (action.type === 'play') {
    requireThat(hand.removed.length === 1 && hand.removed[0] === action.cardId, '打出事件的公开手牌差分与行动不一致');
    requireThat(played.added.length === 1 && played.added[0] === action.cardId, '打出事件的公开已打出差分与行动不一致');
    return {
      ...common, kind: 'play', cardId: action.cardId,
      steps: action.steps ? [...action.steps] : [],
      repeats: action.repeats ?? null,
      stock: stockDelta(), hand, played,
    };
  }
  if (action.type === 'acquire') {
    requireThat(hand.added.length === 1, '获取事件的公开手牌差分与行动不一致');
    const cardId = hand.added[0];
    requireThat(before.merchantMarket[action.index]?.id === cardId, '获取事件的市场位置与公开差分不一致');
    const bonusPaid = action.payment.map((color, slot) => ({ slot, color }));
    const marketAdded = multisetAdded(after.merchantMarket.map(m => m.id), before.merchantMarket.map(m => m.id));
    requireThat(marketAdded.length <= 1, '获取事件的补牌差分异常');
    return {
      ...common, kind: 'acquire', index: action.index, cardId,
      payment: [...action.payment], bonusPaid,
      bonusTaken: [...(before.merchantMarket[action.index]?.bonus ?? [0, 0, 0, 0])] as Stock,
      stock: stockDelta(), hand, played,
      marketRemoved: before.merchantMarket[action.index]
        ? { id: before.merchantMarket[action.index].id, bonus: [...before.merchantMarket[action.index].bonus] as Stock }
        : null,
      marketAdded: marketAdded[0] ?? null,
    };
  }
  if (action.type === 'rest') {
    requireThat(pa.played.length === 0, '休息后已打出区应为空');
    requireThat(played.removed.length === pb.played.length, '休息事件的公开已打出差分与行动不一致');
    return { ...common, kind: 'rest', hand, played };
  }
  if (action.type === 'claim') {
    requireThat(before.golemMarket[action.index] !== undefined, '认领事件的市场位置无效');
    const golemRemoved = before.golemMarket[action.index];
    const golemAdded = multisetAdded(after.golemMarket, before.golemMarket);
    requireThat(golemAdded.length <= 1, '认领事件的补牌差分异常');
    const coin: 'copper' | 'silver' | null =
      pa.copper === pb.copper + 1 ? 'copper' : pa.silver === pb.silver + 1 ? 'silver' : null;
    const golemCard = GOLEM_BY_ID[golemRemoved];
    requireThat(!!golemCard, `认领事件引用未知魔像：${golemRemoved}`);
    return {
      ...common, kind: 'claim', index: action.index, golemId: golemRemoved,
      points: golemCard.points,
      cost: [...golemCard.cost] as Stock,
      coin,
      stock: stockDelta(), hand, played,
      golemRemoved, golemAdded: golemAdded[0] ?? null,
      triggersEnd: before.triggerPlayer === null && after.triggerPlayer !== null && after.triggerPlayer === actor,
      copperBefore: before.copper, copperAfter: after.copper,
      silverBefore: before.silver, silverAfter: after.silver,
    };
  }
  // discard
  const colors = [...action.colors] as Color[];
  requireThat(pa.stock.every((v, i) => v === pb.stock[i] - colors.filter(c => c === i).length),
    '弃置事件的公开库存差分与行动不一致');
  return { ...common, kind: 'discard', colors, stock: stockDelta() };
}

/** 历史摘要规范化键（预测缓存键组件；只含公开事件内容，FNV-1a 32 位）。 */
export function historyDigest(summary: Readonly<PublicHistorySummary>): number {
  let hash = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  feed(`v${summary.version}|o:${summary.origin}|n:${summary.totalEvents}|t:${summary.fromTurn}-${summary.toTurn}`);
  for (const e of summary.window) feed('|' + JSON.stringify(e));
  for (let i = 0; i < summary.perPlayer.length; i++) {
    const p = summary.perPlayer[i];
    feed(`|p${i}:${p.plays},${p.acquires},${p.claims},${p.rests},${p.discards},${p.crystalsPaid},${p.copperGained},${p.silverGained},${p.claimedGolems.join('+')}`);
  }
  return hash >>> 0;
}
