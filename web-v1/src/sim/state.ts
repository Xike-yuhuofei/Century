/** PublicSimState：公共世界模拟器的紧凑状态模型（AI6 第二阶段·任务 A）。
 *
 * 信息边界（不可妥协）：
 * - 输入只允许 AIObservation（合法公开观察），严禁使用完整 Game 作为模拟器入口；
 * - 不保存真实隐藏牌序；剩余未知卡只以"集合"形式存在（排序后的 id 列表），
 *   不含任何顺序语义；
 * - 手牌内容在本游戏中是由公开历史可推导的合法信息（商人卡进入手牌均来自
 *   公开观察到的获取事件，见 ai/observation.ts 的信息边界说明）。
 *
 * 状态转移保留字段：本阶段不开发对手历史模型，但 PublicSimState 的字段布局
 * 预留 historySummary 扩展位（任务书 A：支持后续公共历史摘要扩展）。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID, MERCHANT_DECK, GOLEM_DECK, type Stock } from '../data.js';
import type { AIObservation } from '../ai/observation.js';

const fail = (message: string): never => { throw new Error(message); };
const requireThat = (condition: unknown, message: string) => { if (!condition) fail(message); };

export type PublicSimPlayer = {
  id: number;
  name: string;
  isAI: boolean;
  /** 四色水晶库存 [黄, 绿, 蓝, 粉]。 */
  stock: Stock;
  /** 手牌（本游戏信息模型下为公开可推导内容）。 */
  hand: string[];
  played: string[];
  claimed: string[];
  copper: number;
  silver: number;
  turns: number;
};

export type PublicMarketSlot = { id: string; bonus: Stock };

/** 剩余未知商人/魔像卡的集合表示：排序后的 id 列表（无顺序语义）。
 * 由固定卡表扣除已公开卡牌推导，随翻牌事件收缩。 */
export type UnseenSet = string[];

/** 后续公共历史摘要扩展位（本阶段不填充、不参与任何状态转移）。 */
export type PublicHistorySummary = Record<string, never>;

export type PublicSimState = {
  readonly playerCount: number;
  players: PublicSimPlayer[];
  current: number;
  merchantMarket: PublicMarketSlot[];
  golemMarket: string[];
  copper: number;
  silver: number;
  phase: 'turn' | 'overflow' | 'finished';
  triggerPlayer: number | null;
  turnNumber: number;
  unseenMerchants: UnseenSet;
  unseenGolems: UnseenSet;
  /** 预留：后续对手模型 / 公共历史摘要扩展位。本阶段恒为 undefined。 */
  historySummary?: PublicHistorySummary;
};

/** 从公开观察推导剩余未知商人卡集合（只利用固定卡表构成，不猜测任何顺序）。
 * 商人卡不存在弃置/暗置规则，因此已见集合 = 市场 ∪ 全体玩家手牌 ∪ 已打出。 */
export function deriveUnseenMerchants(
  merchantMarket: readonly { id: string }[],
  players: readonly { hand: readonly string[]; played: readonly string[] }[],
): UnseenSet {
  const known = new Set<string>();
  for (const slot of merchantMarket) known.add(slot.id);
  for (const p of players) {
    for (const id of p.hand) known.add(id);
    for (const id of p.played) known.add(id);
  }
  return MERCHANT_DECK.map(c => c.id).filter(id => !known.has(id)).sort();
}

/** 剩余未知魔像卡集合 = 固定卡表 −（市场 ∪ 全体玩家已认领）。 */
export function deriveUnseenGolems(
  golemMarket: readonly string[],
  players: readonly { claimed: readonly string[] }[],
): UnseenSet {
  const known = new Set<string>(golemMarket);
  for (const p of players) for (const id of p.claimed) known.add(id);
  return GOLEM_DECK.map(c => c.id).filter(id => !known.has(id)).sort();
}

/** 校验输入是结构合法的公开观察（系统边界校验，拒绝非法/被污染的观察）。 */
function validateObservation(observation: AIObservation): void {
  requireThat(observation && typeof observation === 'object', '公开观察对象无效');
  const n = observation.players.length;
  requireThat(n >= 2 && n <= 6, '公开观察必须覆盖 2–6 名玩家');
  requireThat(Number.isInteger(observation.current) && observation.current >= 0 && observation.current < n, '当前行动席位无效');
  requireThat(Number.isInteger(observation.playerId) && observation.playerId >= 0 && observation.playerId < n, '观察席位无效');
  requireThat(observation.phase === 'turn' || observation.phase === 'overflow' || observation.phase === 'finished', '游戏阶段无效');
  requireThat(
    observation.triggerPlayer === null ||
    (Number.isInteger(observation.triggerPlayer) && observation.triggerPlayer! >= 0 && observation.triggerPlayer! < n),
    '终局触发者无效',
  );
  requireThat(Number.isInteger(observation.turnNumber) && observation.turnNumber >= 1, '回合计数无效');
  requireThat(Number.isInteger(observation.copper) && observation.copper >= 0, '公共铜币池无效');
  requireThat(Number.isInteger(observation.silver) && observation.silver >= 0, '公共银币池无效');
  for (const p of observation.players) {
    requireThat(!!p && typeof p === 'object', '玩家观察无效');
    requireThat(
      Array.isArray(p.stock) && p.stock.length === 4 && p.stock.every(v => Number.isInteger(v) && v >= 0),
      `玩家 ${p.id} 水晶库存无效`,
    );
    requireThat(Array.isArray(p.hand) && p.hand.every(id => typeof id === 'string' && !!MERCHANT_BY_ID[id]), `玩家 ${p.id} 手牌包含未知商人卡`);
    requireThat(Array.isArray(p.played) && p.played.every(id => typeof id === 'string' && !!MERCHANT_BY_ID[id]), `玩家 ${p.id} 已打出包含未知商人卡`);
    requireThat(Array.isArray(p.claimed) && p.claimed.every(id => typeof id === 'string' && !!GOLEM_BY_ID[id]), `玩家 ${p.id} 已认领包含未知魔像卡`);
    requireThat(Number.isInteger(p.copper) && p.copper >= 0 && Number.isInteger(p.silver) && p.silver >= 0, `玩家 ${p.id} 硬币无效`);
    requireThat(Number.isInteger(p.turns) && p.turns >= 0, `玩家 ${p.id} 行动次数无效`);
  }
  for (const m of observation.merchantMarket) {
    requireThat(
      !!m && typeof m.id === 'string' && !!MERCHANT_BY_ID[m.id] &&
      Array.isArray(m.bonus) && m.bonus.length === 4 && m.bonus.every(v => Number.isInteger(v) && v >= 0),
      '商人市场槽位无效',
    );
  }
  for (const id of observation.golemMarket) {
    requireThat(typeof id === 'string' && !!GOLEM_BY_ID[id], '魔像市场包含未知卡');
  }
}

/** PublicStateBuilder：从合法公开观察构造紧凑公共模拟状态。
 *
 * - 只接受 AIObservation；真实隐藏牌序在结构上无法进入本函数（观察中不存在）。
 * - 逐字段显式深拷贝，输出状态与输入观察不共享任何可变引用。
 * - 未公开卡集合按排序 id 列表表示（规范形），保证相同公开信息 ⇒ 相同状态。 */
export function buildPublicSimState(observation: AIObservation): PublicSimState {
  validateObservation(observation);
  const players: PublicSimPlayer[] = observation.players.map(p => ({
    id: p.id,
    name: p.name,
    isAI: p.isAI === true,
    stock: [...p.stock] as Stock,
    hand: [...p.hand],
    played: [...p.played],
    claimed: [...p.claimed],
    copper: p.copper,
    silver: p.silver,
    turns: p.turns,
  }));
  const state: PublicSimState = {
    playerCount: players.length,
    players,
    current: observation.current,
    merchantMarket: observation.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] as Stock })),
    golemMarket: [...observation.golemMarket],
    copper: observation.copper,
    silver: observation.silver,
    phase: observation.phase,
    triggerPlayer: observation.triggerPlayer,
    turnNumber: observation.turnNumber,
    unseenMerchants: deriveUnseenMerchants(observation.merchantMarket, players),
    unseenGolems: deriveUnseenGolems(observation.golemMarket, players),
  };
  return state;
}

/** 从未公开集合中移除一张刚翻开的卡（保持排序规范形）。
 * 二分定位 + 原地删除；集合语义要求 id 唯一存在。 */
export function removeFromUnseen(unseen: UnseenSet, id: string): void {
  let low = 0;
  let high = unseen.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cmp = unseen[mid] < id ? -1 : unseen[mid] > id ? 1 : 0;
    if (cmp === 0) { found = mid; break; }
    if (cmp < 0) low = mid + 1;
    else high = mid - 1;
  }
  if (found >= 0) unseen.splice(found, 1);
}
