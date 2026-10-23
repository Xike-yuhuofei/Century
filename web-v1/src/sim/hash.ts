/** PublicStateHasher：公共状态规范化键与 FNV-1a 哈希（AI6 第二阶段·任务 G，可选件）。
 *
 * 规范化原则：
 * - 只纳入有规则意义的公开字段（不含名字等装饰字段）；
 * - 顺序敏感字段（golemMarket / merchantMarket 的槽位次序影响认领与获取
 *   语义）按原顺序纳入；顺序无关集合（hand / played / claimed / 未知卡集合）
 *   排序后纳入，保证集合语义等价 ⇒ 键相同；
 * - 不含任何隐藏信息（状态中本就不存在）。
 */

import type { PublicSimState } from './state.js';

/** 规范化状态键（确定性字符串，可直接用于 Map 去重 / 轨迹比对）。 */
export function publicStateKey(state: Readonly<PublicSimState>): string {
  const parts: string[] = [
    state.phase,
    String(state.current),
    String(state.turnNumber),
    state.triggerPlayer === null ? '-' : String(state.triggerPlayer),
    String(state.copper),
    String(state.silver),
  ];
  for (const p of state.players) {
    parts.push(
      `${p.id}:${p.stock.join(',')}|${[...p.hand].sort().join(',')}|${[...p.played].sort().join(',')}|${[...p.claimed].sort().join(',')}|${p.copper}/${p.silver}/${p.turns}`,
    );
  }
  parts.push(state.merchantMarket.map(m => `${m.id}(${m.bonus.join(',')})`).join(';'));
  parts.push(state.golemMarket.join(';'));
  parts.push(`u:${state.unseenMerchants.length}/${state.unseenGolems.length}`);
  return parts.join('#');
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32 位哈希（确定性、跨平台一致，Node/浏览器均可复现）。 */
export function hashPublicState(state: Readonly<PublicSimState>): number {
  const key = publicStateKey(state);
  let hash = FNV_OFFSET;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}
