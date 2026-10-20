/** AIObservation：AI 决策的唯一合法输入（任务书第四节·信息公平性）。
 *
 * 信息边界：
 * - 只包含当前公开可知信息：翻开的商人卡/魔像卡、全部玩家的水晶与已打出/已认领卡、
 *   公开资源池、游戏阶段与终局触发者。
 * - 关于其他玩家手牌：本游戏中每张商人卡进入手牌都来自公开观察到的获取事件
 *   （起始配置或市场获取，商人卡不存在弃置/暗置规则），因此手牌内容是
 *   由公开历史可推导的合法信息，不属于隐藏牌库顺序。
 * - 严禁包含：merchantDeck / golemDeck（两类未翻开牌库的顺序）。
 *   本文件及 src/ai/ 下其他模块对这两个字段的引用为零，
 *   由 tests/ai-fairness.test.mjs 的静态扫描与纯度测试强制保证。
 */

import type { Game, MarketMerchant } from '../engine.js';
import type { Stock } from '../data.js';

export type ObservationPlayer = {
  readonly id: number;
  readonly name: string;
  readonly isAI: boolean;
  readonly stock: Stock;
  readonly hand: readonly string[];
  readonly played: readonly string[];
  readonly claimed: readonly string[];
  readonly copper: number;
  readonly silver: number;
  readonly turns: number;
};

export type AIObservation = {
  readonly playerId: number;
  readonly players: readonly ObservationPlayer[];
  readonly current: number;
  readonly merchantMarket: readonly MarketMerchant[];
  readonly golemMarket: readonly string[];
  readonly copper: number;
  readonly silver: number;
  readonly phase: 'turn' | 'overflow' | 'finished';
  readonly triggerPlayer: number | null;
  readonly turnNumber: number;
};

const clonePlayerStock = (stock: Stock): Stock => [...stock] as Stock;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** 从完整游戏状态中构造只读公开观察。
 * 本函数是信息边界的唯一入口：逐字段显式复制公开信息，
 * 隐藏牌库顺序在结构上不可能进入观察对象。 */
export function buildObservation(game: Game, playerId: number = game.current): AIObservation {
  const player = game.players[playerId];
  if (!player) throw new Error(`观察席位不存在：${playerId}`);
  return deepFreeze({
    playerId,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI === true,
      stock: clonePlayerStock(p.stock),
      hand: [...p.hand],
      played: [...p.played],
      claimed: [...p.claimed],
      copper: p.copper,
      silver: p.silver,
      turns: p.turns,
    })),
    current: game.current,
    merchantMarket: game.merchantMarket.map(m => ({ id: m.id, bonus: clonePlayerStock(m.bonus) })),
    golemMarket: [...game.golemMarket],
    copper: game.copper,
    silver: game.silver,
    phase: game.phase,
    triggerPlayer: game.triggerPlayer,
    turnNumber: game.turnNumber,
  }) as AIObservation;
}
