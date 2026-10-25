/** 经过验证的合法回退路径（主线程执行，零搜索、确定性强）。
 *
 * 用途：Worker 故障/看门狗超时/协议错误时的安全兜底——宁可退回廉价合法行动，
 * 绝不阻塞界面、绝不提交未经正式引擎校验的行动。
 *
 * "经过验证"的含义：
 * - 行动来自公开模拟合法枚举（sim/legal.ts enumerateLegalActions）或冠军
 *   trimStock 溢出口径——与正式冠军代码同源；
 * - tests/ai-runtime.test.mjs 在多局面 × 多座位上把本函数输出逐一喂给正式
 *   引擎 applyAction 验证合法性（见测试"回退路径合法性"）。
 */

import type { AIObservation } from '../ai/observation.js';
import type { Action } from '../engine.js';
import { createSimulation } from '../sim/session.js';
import { enumerateLegalActions } from '../sim/legal.js';
import { championOverflowDiscard } from './decision-core.js';

export type FallbackDecision = {
  action: Action;
  reason: string;
  /** 回退来源（诊断披露）。 */
  source: 'overflow-champion' | 'first-legal';
};

export function chooseVerifiedFallback(observation: AIObservation): FallbackDecision {
  if (observation.phase === 'finished') {
    throw new Error('游戏已结束，无需回退决策');
  }
  if (observation.phase === 'overflow') {
    return {
      action: championOverflowDiscard(observation),
      reason: '回退：溢出弃置（冠军 trimStock 口径）',
      source: 'overflow-champion',
    };
  }
  const seat = observation.playerId;
  if (observation.current !== seat) {
    throw new Error(`回退决策席位 ${seat} 不是当前行动者 ${observation.current}`);
  }
  const sim = createSimulation(observation, { simSeed: 0 });
  const legal = enumerateLegalActions(sim.view, { dedupe: true });
  if (legal.length === 0) {
    throw new Error('回退路径：公开合法行动集为空');
  }
  return {
    action: legal[0],
    reason: '回退：首个公开合法行动（零搜索确定性兜底）',
    source: 'first-legal',
  };
}
