/** 对抗性联赛·独立策略实现（random-legal 决策核心）。
 *
 * 与冠军算法结构完全不同的多样性锚点：逐决策对全量合法行动做确定性均匀
 * 采样。合法集合经正式引擎 sim/legal 枚举（与规则引擎逐条对齐的正确性口径），
 * 只消费公开视野（隐藏牌库顺序不存在于视图中）。
 * RNG 流只依赖 (seed, seat)——同种子同席位可复现、跨席位独立、不接触隐藏信息。
 */

import { enumerateLegalActions } from '../../web-v1/dist/js/sim/legal.js';
import { mulberry32 } from '../lib/rng.mjs';

/** 引擎 Game → sim/legal 兼容公开视图（只复制公开字段；与 joint/duel.mjs 同口径）。
 * 弃置由 enumerateLegalActions 的规范组合枚举处理，无需自行实现。 */
export function buildPublicView(game) {
  return {
    current: game.current,
    phase: game.phase,
    turnNumber: game.turnNumber,
    players: game.players.map(p => ({
      id: p.id, stock: [...p.stock], hand: [...p.hand], played: [...p.played], claimed: [...p.claimed],
    })),
    golemMarket: [...game.golemMarket],
    merchantMarket: game.merchantMarket.map(m => ({ id: m.id })),
  };
}

/** 席位 RNG 流（确定性：同 (seed, seat) 同流；跨席位独立）。 */
export function seatRng(seed, seat) {
  return mulberry32(((seed >>> 0) ^ Math.imul(seat + 1, 0x9E3779B9)) >>> 0);
}

/** 随机合法决策：全量合法行动均匀采样；空集回退 rest（引擎会裁决其合法性）。 */
export function randomLegalAction(game, rng) {
  const legal = enumerateLegalActions(buildPublicView(game), { dedupe: false });
  if (!legal.length) return { type: 'rest' };
  return legal[Math.floor(rng() * legal.length)];
}
