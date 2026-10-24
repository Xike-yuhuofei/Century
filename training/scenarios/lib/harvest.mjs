/** 引擎对局回放与局面采集（战术基准专用）。
 *
 * 使命：用正式引擎从头回放固定种子的完整对局（训练口径：席位 0 人类代理由 AI
 * 版本代打），在每个决策点把"行动前的完整合法位置"交给调用方筛选采集。
 * 局面全部来自正式引擎自然演化的合法状态——不手工构造商人卡/魔像卡/资源。
 */

import { createGame, applyAction } from '../../../web-v1/dist/js/engine.js';
import { decideWithVersion, seatProfile } from './versions.mjs';

export const MAX_MOVES = 1200;       // 与训练模拟器同口径的死循环护栏
export const DEADLINE_MS = 60_000;   // 单局墙钟护栏

/** 完整位置快照（Game 去掉 replay；engine.gamePosition 的本地等价实现）。 */
export function snapshotPosition(game) {
  const { replay, ...position } = game;
  return structuredClone(position);
}

/**
 * 回放一局并逐决策点回调。
 * @param {number} seed 引擎种子（必须在 AI6_SCENARIO_BLOCK 内，由调用方经 scenarioSeed 分配）
 * @param {number} seatCount 席位数 2–5
 * @param {object} driverVersion frozenVersions() 中的一员（驱动对局的 AI 版本）
 * @param {(point: {game: Game, decisionIndex: number}) => void} onDecisionPoint
 *   回调在"行动前"触发；回调若返回 true 则终止回放（提前收工）。
 * @returns {{status: 'finished'|'anomaly', reason: string|null, moves: number, wallMs: number}}
 */
export function playGame(seed, seatCount, driverVersion, onDecisionPoint) {
  const t0 = performance.now();
  let game;
  try {
    game = createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
    game.players[0].isAI = true; // 训练口径：人类代理席位
  } catch (error) {
    return { status: 'anomaly', reason: `createGame 失败：${error.message}`, moves: 0, wallMs: 0 };
  }
  let moves = 0;
  try {
    while (game.phase !== 'finished') {
      if (moves >= MAX_MOVES) return { status: 'anomaly', reason: `达到行动步数上限 ${MAX_MOVES}`, moves, wallMs: performance.now() - t0 };
      if (performance.now() - t0 > DEADLINE_MS) return { status: 'anomaly', reason: `超出单局时间预算 ${DEADLINE_MS}ms`, moves, wallMs: performance.now() - t0 };
      if (game.phase === 'turn') {
        if (onDecisionPoint({ game, decisionIndex: moves }) === true) {
          return { status: 'finished', reason: '采集方提前收工', moves, wallMs: performance.now() - t0 };
        }
      }
      const seat = game.current;
      const { action } = decideWithVersion(game, driverVersion, seatProfile(seat));
      game = applyAction(game, action);
      moves++;
    }
  } catch (error) {
    return { status: 'anomaly', reason: `对局异常：${error.message}`, moves, wallMs: performance.now() - t0 };
  }
  return { status: 'finished', reason: null, moves, wallMs: performance.now() - t0 };
}
