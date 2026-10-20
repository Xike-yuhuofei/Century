/** AI 策略人格（任务书第三节）。
 * 四个 AI 共享同一基础决策引擎；人格只通过既有求值项的乘子制造偏好差异，
 * 绝不通过降低基础决策质量制造差异，也绝不依赖"人类/机器"身份采取特殊针对。
 * 人格由席位结构决定（第 n 个行动的 AI 对应第 n 种人格，循环取模）。
 */

import type { AIObservation } from './observation.js';

export type Profile = {
  readonly name: string;
  readonly engine: number;
  readonly tempo: number;
  readonly contest: number;
};

export const PROFILES: readonly Profile[] = [
  { name: '引擎大师', engine: 1.3, tempo: 0.8, contest: 0.9 },
  { name: '速攻专家', engine: 0.7, tempo: 1.3, contest: 1.0 },
  { name: '精算大师', engine: 1.0, tempo: 1.0, contest: 1.0 },
  { name: '战术大师', engine: 0.9, tempo: 1.0, contest: 1.5 },
];

/** 中立人格：全部乘子为 1.0，等价于"无人格偏好"。
 * 训练模拟器用它代理人类席位（正式游戏中人类席位的决策不走 profileFor，
 * 代理席位因此不应叠加任何人格乘子，保证 4 个真实 AI 席位与正式游戏逐席一致）。 */
export const NEUTRAL_PROFILE: Profile = { name: '中立代理', engine: 1.0, tempo: 1.0, contest: 1.0 };

/** 按公开席位结构推导当前行动者的人格。 */
export function profileFor(view: AIObservation): Profile {
  const aiIndex = view.players.slice(0, view.current + 1).filter(p => p.isAI).length - 1;
  return PROFILES[Math.max(0, aiIndex) % PROFILES.length];
}
