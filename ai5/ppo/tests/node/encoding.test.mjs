/** 编码协议测试（ai5-state-v1 / ai5-action-v1）：
 * - 维度恒定且与文档一致；
 * - 同一观察编码逐位确定；
 * - 行动后库存预测与正式引擎一致（逐字段）；
 * - 弃置（溢出）编码正确；
 * - 同组合不同支付顺序编码不同（顺序信息不丢失）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../../../../web-v1/dist/js/engine.js';
import { buildObservation, chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { enumerateCandidates, descriptorToEngineAction } from '../../bridge/action_enum.mjs';
import { encodeState, encodeAction, encodeDecision, STATE_DIM, ACTION_DIM, STATE_ENCODING_VERSION, ACTION_ENCODING_VERSION } from '../../bridge/encode.mjs';

function gameAt(seed, moves, mlpPolicy = true) {
  let game = createGame(Array.from({ length: 5 }, (_, i) => `席位${i}`), seed, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  for (let i = 0; i < moves && game.phase !== 'finished'; i++) {
    if (mlpPolicy && game.current === 0) {
      const view = buildObservation(game);
      const { candidates } = enumerateCandidates(view, {});
      game = applyAction(game, descriptorToEngineAction(candidates[(i * 5 + 1) % candidates.length]));
    } else {
      const profile = game.current === 0 ? NEUTRAL_PROFILE : PROFILES[(game.current - 1) % PROFILES.length];
      game = applyAction(game, chooseAIAction(game, { profile }).action);
    }
  }
  return game;
}

test('编码版本与维度恒定', () => {
  assert.equal(STATE_ENCODING_VERSION, 'ai5-state-v1');
  assert.equal(ACTION_ENCODING_VERSION, 'ai5-action-v1');
  assert.equal(STATE_DIM, 1419);
  assert.equal(ACTION_DIM, 84);
});

test('状态编码确定性 + 视角差异', () => {
  const game = gameAt(31337, 40);
  const v1 = encodeState(buildObservation(game));
  const v2 = encodeState(buildObservation(game));
  assert.deepEqual([...v1], [...v2]);
  // 换视角（席位 2）：编码不同但维度相同。
  const v3 = encodeState(buildObservation(game), 2);
  assert.equal(v3.length, STATE_DIM);
  assert.notDeepEqual([...v1], [...v3]);
  // 全部有限数值。
  assert.ok([...v1].every(Number.isFinite));
});

test('行动后库存预测与正式引擎一致（全部候选 × 多局面）', () => {
  const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
  for (const seed of [5, 5555, 99001]) {
    const game = gameAt(seed, 30 + seed % 20);
    const view = buildObservation(game);
    const { candidates } = enumerateCandidates(view, {});
    for (const d of candidates) {
      const predicted = encodeAction(view, d); // 只要不抛错即含预测段
      const after = applyAction(game, descriptorToEngineAction(d));
      const actualStock = after.players[view.current].stock;
      // 预测段位于 [72,76)；向量是 Float32，用 1e-6 容差比较。
      for (let c = 0; c < 4; c++) {
        assert.ok(close(predicted[72 + c], actualStock[c] / 10), `候选 ${JSON.stringify(d)} 颜色${c} 预测库存不符`);
      }
      assert.ok(close(predicted[76], actualStock.reduce((x, y) => x + y, 0) / 10));
    }
  }
});

test('溢出弃置编码：计数段与引擎弃置结果一致', () => {
  // 手工构造溢出局面：席位 0 库存 12 颗。
  let game = createGame(['a', 'b', 'c', 'd', 'e'], 8, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  game.players[0].stock = [6, 4, 2, 0];
  game = applyAction(game, { type: 'play', cardId: 'S01' }); // +2 黄 → 12+2=14？实际 13（用 1 黄）
  // S01 创造 +2 黄 → [8,4,2,0] = 14 颗？S01 output [2,0,0,0]，原 [6,4,2,0] → [8,4,2,0] 共 14 → 溢出 4。
  assert.equal(game.phase, 'overflow');
  const view = buildObservation(game);
  const { candidates } = enumerateCandidates(view, {});
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(d => d[0] === 'D'), '溢出阶段只允许弃置');
  const excess = view.players[0].stock.reduce((x, y) => x + y, 0) - 10;
  for (const d of candidates) {
    const sum = d[1].reduce((x, y) => x + y, 0);
    assert.equal(sum, excess, `弃置总数必须等于超出量 ${excess}`);
    const vec = encodeAction(view, d);
    for (let c = 0; c < 4; c++) {
      assert.ok(Math.abs(vec[68 + c] - d[1][c] / 6) <= 1e-6, `弃置计数段不符（颜色${c}）`);
    }
    const after = applyAction(game, descriptorToEngineAction(d));
    assert.equal(after.players[0].stock.reduce((x, y) => x + y, 0), 10);
  }
});

test('支付顺序在行动编码中可区分', () => {
  let game = createGame(['a', 'b'], 7, [1]);
  game.players[0].isAI = true;
  game = applyAction(game, { type: 'play', cardId: 'S02', steps: [0, 0] });
  const view = buildObservation(game);
  const v1 = encodeAction(view, ['A', 1, [0, 0, 1]]);
  const v2 = encodeAction(view, ['A', 1, [0, 1, 0]]);
  assert.notDeepEqual([...v1], [...v2], '不同支付顺序必须产生不同编码');
});

test('encodeDecision 输出矩阵行数与候选一致', () => {
  const game = gameAt(2026, 55);
  const view = buildObservation(game);
  const { candidates } = enumerateCandidates(view, {});
  const { obs, candMat } = encodeDecision(view, candidates);
  assert.equal(obs.length, STATE_DIM);
  assert.equal(candMat.length, candidates.length * ACTION_DIM);
});
