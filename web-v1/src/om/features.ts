/** Opponent Model V1 共享特征（AI6 第三阶段）。
 *
 * 全部特征只消费 PublicSimState / PublicHistorySummary / 公开卡表，
 * 不接触隐藏牌序，不使用真实游戏 RNG。
 * 部分特征与 ai/knowledge.ts、ai/opponent-model.ts 同源（水晶价值标尺、
 * 单圈可达库存的贪心口径），便于 M0–M4 对照在同一特征语言下比较；
 * 但 V1 的概率模型本身不把旧启发式公式当作已验证的真实概率（任务书约束）。
 */

import { count, has, type Action, type Color } from '../engine.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import { VALUES, weighted, stockCount } from '../ai/knowledge.js';
import type { AIObservation, ObservationPlayer } from '../ai/observation.js';
import type { PublicSimPlayer, PublicSimState } from '../sim/index.js';
import type { StyleKey, StyleWeights } from './types.js';

/** 风格先验（工程假设：balanced 为主锚，其余均分）。 */
export const STYLE_PRIOR: StyleWeights = {
  rush: 0.1375, engine: 0.1375, coin: 0.1375, contest: 0.1375, balanced: 0.45,
};

/** 终局认领门槛（2–3 人 6 张、4–5 人 5 张；与 engine/transition 镜像）。 */
export function endgameThreshold(playerCount: number): number {
  return playerCount >= 4 ? 5 : 6;
}

/** 单圈可达库存：当前库存 + 打出全部手牌的净产出（贪心确定性模拟），
 * 超过商队上限 10 按价值最低色逐颗弃置（与 ai/opponent-model.ts reachableStock 同口径）。
 * restReactivate：同时叠加"休息收回已打出卡再打一轮"的引擎产出（上限近似）。 */
export function reachableStock(p: {
  stock: readonly number[]; hand: readonly string[]; played: readonly string[];
}, options?: { includeRest?: boolean }): Stock {
  const stock = [...p.stock] as Stock;
  const handOutput = productionOfHand(p.hand, stock);
  for (let c = 0; c < 4; c++) stock[c] += handOutput[c];
  if (options?.includeRest) {
    const engineOutput = productionOfPlayed(p.played, stock);
    for (let c = 0; c < 4; c++) stock[c] += engineOutput[c];
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

/** 打出全部手牌一次的净产出（贪心：创造→交易按净增值→升级贪心低转高）。 */
export function productionOfHand(hand: readonly string[], stock: readonly number[]): Stock {
  const s = [...stock] as Stock;
  for (const id of hand) {
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') {
      card.output!.forEach((n, c) => { s[c] += n; });
    } else if (card.kind === 'trade' && has(s, card.input!)) {
      card.input!.forEach((n, c) => { s[c] -= n; });
      card.output!.forEach((n, c) => { s[c] += n; });
    }
    // 升级卡的产出依赖执行顺序，贪心放到最后统一处理。
  }
  // 升级卡贪心：低色充足时逐卡逐步低转高。
  for (const id of hand) {
    const card = MERCHANT_BY_ID[id];
    if (!card || card.kind !== 'upgrade') continue;
    let steps = card.steps!;
    for (let c = 0; c < 3 && steps > 0; c++) {
      while (steps > 0 && s[c] > 0) { s[c]--; s[c + 1]++; steps--; }
    }
  }
  const delta = s.map((v, c) => v - stock[c]);
  return delta as Stock;
}

/** 已打出引擎（休息后可再打一轮）的单圈产出。 */
export function productionOfPlayed(played: readonly string[], stock: readonly number[]): Stock {
  return productionOfHand(played, stock);
}

/** 费用覆盖度 [0,1]：加权 min(有, 需) / 加权费用。 */
export function coverageOf(cost: readonly number[], have: readonly number[]): number {
  const total = weighted(cost);
  if (total <= 0) return 1;
  const covered = cost.reduce((s, n, c) => s + Math.min(n, have[c]) * VALUES[c], 0);
  return Math.min(1, covered / total);
}

/** 费用缺口。 */
export function gapOf(cost: readonly number[], have: readonly number[]): Stock {
  return cost.map((n, c) => Math.max(0, n - have[c])) as Stock;
}

/** 乐观可达轮数估计：缺口按每轮生产补齐（向上取整，逐色独立乐观口径）。 */
export function turnsToAfford(gap: readonly number[], production: readonly number[]): number {
  let rounds = 0;
  for (let c = 0; c < 4; c++) {
    if (gap[c] <= 0) continue;
    const per = Math.max(0, production[c]);
    rounds = Math.max(rounds, per > 0 ? Math.ceil(gap[c] / per) : 99);
  }
  return rounds;
}

/** 认领位置硬币奖励的期望分值（0 号位铜→银回退；1 号位铜银双全给银）。 */
export function coinValueOf(index: number, pools: { copper: number; silver: number }): number {
  if (index === 0) return pools.copper > 0 ? 3 : pools.silver > 0 ? 1 : 0;
  if (index === 1) return pools.copper > 0 && pools.silver > 0 ? 1 : 0;
  return 0;
}

/** 玩家静态特征包（每个预测调用对每席位计算一次）。 */
export type PlayerFeatures = {
  id: number;
  stock: Stock;
  hand: readonly string[];
  played: readonly string[];
  claimed: readonly string[];
  copper: number;
  silver: number;
  turns: number;
  handCount: number;
  playedCount: number;
  score: number;
  /** 距终局门槛还需认领数。 */
  golemsToGo: number;
  /** 单圈可达（含休息引擎）。 */
  reachable: Stock;
  /** 手牌单圈净产出。 */
  handProduction: Stock;
  /** 已打出引擎单圈产出。 */
  engineProduction: Stock;
};

export function playerFeatures(p: PublicSimPlayer, threshold: number): PlayerFeatures {
  const handProduction = productionOfHand(p.hand, p.stock);
  const engineProduction = productionOfPlayed(p.played, p.stock);
  const reachable = reachableStock(p, { includeRest: true });
  const score = p.claimed.reduce((s, id) => s + (GOLEM_BY_ID[id]?.points ?? 0), 0)
    + p.copper * 3 + p.silver
    + p.stock.slice(1).reduce((s, x) => s + x, 0);
  return {
    id: p.id,
    stock: [...p.stock] as Stock,
    hand: [...p.hand],
    played: [...p.played],
    claimed: [...p.claimed],
    copper: p.copper,
    silver: p.silver,
    turns: p.turns,
    handCount: p.hand.length,
    playedCount: p.played.length,
    score,
    golemsToGo: Math.max(0, threshold - p.claimed.length),
    reachable,
    handProduction,
    engineProduction,
  };
}

/** 全席位特征包（一次计算，多次复用）。 */
export type FeaturePack = {
  state: Readonly<PublicSimState>;
  threshold: number;
  players: PlayerFeatures[];
  byId: Map<number, PlayerFeatures>;
  /** 观察者视角：行动顺序在我之前的对手（下一圈内先行动）。 */
  rivalsAhead(viewerId: number): number[];
};

export function featurePack(state: Readonly<PublicSimState>): FeaturePack {
  const threshold = endgameThreshold(state.playerCount);
  const players = state.players.map(p => playerFeatures(p, threshold));
  const byId = new Map(players.map(p => [p.id, p]));
  return {
    state,
    threshold,
    players,
    byId,
    rivalsAhead(viewerId: number) {
      return state.players
        .map(p => p.id)
        .filter(id => id !== viewerId && aheadInSeatOrder(viewerId, id, state.current, state.playerCount));
    },
  };
}

/** 座位顺序：从 current 开始轮转，a 是否先于 b 行动。 */
export function aheadInSeatOrder(a: number, b: number, current: number, n: number): boolean {
  const da = (a - current + n) % n;
  const db = (b - current + n) % n;
  return da < db;
}

// === 状态适配器 ===

/** PublicSimState → AIObservation 兼容对象（只读投影；不冻结、不外泄隐藏信息——
 * 状态本身只含公开信息）。用于复用 ai/knowledge / ai/opponent-model 的公开特征函数
 * （M1 对照口径），以及 createSimulation 的入口参数。 */
export function stateToObservation(state: Readonly<PublicSimState>, viewerId = state.current): AIObservation {
  const players: ObservationPlayer[] = state.players.map(p => ({
    id: p.id,
    name: p.name,
    isAI: p.isAI,
    stock: [...p.stock] as Stock,
    hand: [...p.hand],
    played: [...p.played],
    claimed: [...p.claimed],
    copper: p.copper,
    silver: p.silver,
    turns: p.turns,
  }));
  return {
    playerId: viewerId,
    players,
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

/** PublicSimState 深拷贝（预测内假设分支用；字段与 state.ts 布局一致）。 */
export function cloneState(state: Readonly<PublicSimState>): PublicSimState {
  return {
    playerCount: state.playerCount,
    players: state.players.map(p => ({
      ...p,
      stock: [...p.stock] as Stock,
      hand: [...p.hand],
      played: [...p.played],
      claimed: [...p.claimed],
    })),
    current: state.current,
    merchantMarket: state.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] as Stock })),
    golemMarket: [...state.golemMarket],
    copper: state.copper,
    silver: state.silver,
    phase: state.phase,
    triggerPlayer: state.triggerPlayer,
    turnNumber: state.turnNumber,
    unseenMerchants: [...state.unseenMerchants],
    unseenGolems: [...state.unseenGolems],
    historySummary: structuredClone(state.historySummary),
  };
}

/** 行动族归类（策略与解释共用）。 */
export function familyOf(action: Action): 'claim' | 'produce' | 'upgrade' | 'trade' | 'acquire' | 'rest' | 'discard' {
  switch (action.type) {
    case 'claim': return 'claim';
    case 'acquire': return 'acquire';
    case 'rest': return 'rest';
    case 'discard': return 'discard';
    case 'play': {
      const card = MERCHANT_BY_ID[action.cardId];
      if (card?.kind === 'create') return 'produce';
      if (card?.kind === 'upgrade') return 'upgrade';
      return 'trade';
    }
  }
}

/** 魔像目标被多少对手"接近"（竞争度 [0,1]）：全体对手覆盖度的 softmax-ish 聚合。 */
export function contestedOf(cost: readonly number[], rivals: readonly PlayerFeatures[]): number {
  if (!rivals.length) return 0;
  const coverages = rivals.map(r => coverageOf(cost, r.reachable));
  return Math.min(1, Math.max(...coverages));
}

/** 玩家手牌+引擎对费用的产出契合度 [0,1]：产出与缺口的加权交集 / 缺口。 */
export function engineAffinityOf(cost: readonly number[], feats: PlayerFeatures): number {
  const gap = gapOf(cost, feats.reachable);
  const gapTotal = weighted(gap);
  if (gapTotal <= 0) return 1;
  const supply = feats.handProduction.map((n, c) => n + feats.engineProduction[c] * 0.5);
  const useful = gap.reduce((s, n, c) => s + Math.min(n, Math.max(0, supply[c])) * VALUES[c], 0);
  return Math.min(1, useful / gapTotal);
}

// === 数值工具 ===

/** 数值安全化：非有限值归零（概率约束防线的最后兜底）。 */
export function safeNumber(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

/** softmax（带温度；输入 logits；输出与输入等长、Σ=1、全部 > 0）。 */
export function softmax(logits: readonly number[], temperature: number): number[] {
  const t = temperature > 1e-9 ? temperature : 1e-9;
  const max = Math.max(...logits.map(l => safeNumber(l, -1e9)));
  const exps = logits.map(l => Math.exp((safeNumber(l, -1e9) - max) / t));
  const sum = exps.reduce((s, e) => s + e, 0) || 1;
  return exps.map(e => e / sum);
}

/** 归一化（Σ=1；全零输入均匀分布）。 */
export function normalize(values: readonly number[]): number[] {
  const sum = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (sum <= 0 || !Number.isFinite(sum)) return values.map(() => 1 / values.length);
  return values.map(v => Math.max(0, v) / sum);
}

/** 席位数（防御性约束；正式游戏 2–6）。 */
export function clampSeat(x: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(x)));
}

export { count, VALUES, weighted, stockCount, has };
export type { Color, StyleKey, StyleWeights };
