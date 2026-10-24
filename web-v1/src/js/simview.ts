/** 模拟状态视图工具：PublicSimState → 冠军求值函数所需的轻量视图。
 *
 * 冠军求值器（ai/evaluator、ai/knowledge、ai/opponent-model）的入参是
 * AIObservation 或其子字段。联合搜索在模拟轨迹内复用这些已验证公式，
 * 需要把 PublicSimState 映射为结构兼容的只读视图。映射是纯字段投影，
 * 不引入任何隐藏信息（PublicSimState 本身只含公开可推导内容）。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import { has } from '../engine.js';
import type { AIObservation, ObservationPlayer } from '../ai/observation.js';
import type { PublicSimState } from '../sim/state.js';
import { NEUTRAL_PROFILE, PROFILES, type Profile } from '../ai/profiles.js';
import { pressureModel, type PressureModel } from '../ai/opponent-model.js';

/** PublicSimState 玩家 → ObservationPlayer 结构投影（同一字段子集）。 */
function playerView(p: PublicSimState['players'][number]): ObservationPlayer {
  return {
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
  };
}

/** PublicSimState → AIObservation 结构兼容视图（字段投影；viewer 指定观察席位）。
 * 仅用于调用冠军求值公式；不参与正式决策路径。 */
export function simViewToObservation(state: Readonly<PublicSimState>, viewer: number): AIObservation {
  return {
    playerId: viewer,
    players: state.players.map(playerView),
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

/** 按显式人格名解析（NEUTRAL_PROFILE / PROFILES 名称匹配）；未知名回落中立。
 * 与训练模拟器 seatProfile 的显式注入语义一致：人格只影响求值乘子。 */
export function profileByName(name: string | undefined): Profile {
  if (!name) return NEUTRAL_PROFILE;
  if (name === NEUTRAL_PROFILE.name) return NEUTRAL_PROFILE;
  return PROFILES.find(p => p.name === name) ?? NEUTRAL_PROFILE;
}

/** 决策者人格的席位推导（与正式游戏 profileFor 语义一致，供缺省路径使用）。 */
export function profileForSeat(view: AIObservation): Profile {
  const aiIndex = view.players.slice(0, view.current + 1).filter(p => p.isAI).length - 1;
  return PROFILES[Math.max(0, aiIndex) % PROFILES.length] ?? NEUTRAL_PROFILE;
}

/** 玩家单圈可达水晶：当前库存 + 打出全部手牌的净产出（与
 * ai/opponent-model.reachableStock 同口径的紧凑实现，供 L2 竞争项使用）。 */
export function reachableStockOf(stock: readonly number[], hand: readonly string[]): Stock {
  const out = [...stock] as Stock;
  for (const id of hand) {
    // 卡牌表查询内联（避免循环依赖 data 模块逐卡判断）。
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') {
      card.output!.forEach((n, c) => { out[c] += n; });
    } else if (card.kind === 'upgrade') {
      let steps = card.steps!;
      for (let c = 0; c < 3 && steps > 0; c++) {
        while (steps > 0 && out[c] > 0) { out[c]--; out[c + 1]++; steps--; }
      }
    } else if (card.kind === 'trade' && has(out, card.input!)) {
      card.input!.forEach((n, c) => { out[c] -= n; });
      card.output!.forEach((n, c) => { out[c] += n; });
    }
  }
  return out;
}

/** 轨迹内压力模型缓存：同一模拟状态键只计算一次（任务 E：状态相关缓存）。
 * 压力模型输入是市场 + 全体玩家引擎，随市场变化必须失效——以
 * turnNumber + current + 市场 id 序列 + current 玩家手牌数为键的近似失效
 * 在轨迹内足够安全（键碰撞只会命中同一局面的等价缓存）。 */
export class PressureCache {
  private cache = new Map<string, PressureModel>();

  get(state: Readonly<PublicSimState>, viewer: number): PressureModel {
    const key = `${state.turnNumber}|${state.current}|${state.merchantMarket.map(m => `${m.id}:${m.bonus.join(',')}`).join(';')}|${
      state.players.map(p => p.hand.length + p.played.length).join(',')}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const model = pressureModel(simViewToObservation(state, viewer));
    this.cache.set(key, model);
    return model;
  }
}

/** 当前决策者的目标偏好：市场魔像按（分值潜力 − 费用缺口）选最优，
 * 供轨迹内己方启发式与根筛选共用。 */
export function preferredGoalOf(
  stock: readonly number[],
  golemMarket: readonly string[],
  gapOf: (stock: readonly number[], goalId: string) => number,
): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const id of golemMarket) {
    const goal = GOLEM_BY_ID[id];
    if (!goal) continue;
    const score = goal.points - 2.6 * gapOf(stock, id);
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}
