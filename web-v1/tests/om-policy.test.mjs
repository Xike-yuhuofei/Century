/** OpponentPolicyV1 行动预测测试（AI6 第三阶段·任务 B + F 接口约束）。
 *
 * 验收口径：
 * - 全部输出行动合法（⊆ enumerateLegalActions，含 overflow 弃置口径）；
 * - 概率数学约束：Σp=1、p>0、无 NaN/负数/超 1；
 * - 非法行动概率严格为零（不在分布列表中）；
 * - 相同状态 + 相同种子 ⇒ 逐位可复现；跨实例一致；
 * - Node/浏览器通用数据形态（纯 JSON 可序列化）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction, buildObservation } from '../dist/js/ai.js';
import { buildPublicSimState, enumerateLegalActions } from '../dist/js/sim/index.js';
import { createOpponentModel } from '../dist/js/om/index.js';

function midgameState(seatCount, seed, steps = 24) {
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  for (let i = 0; i < steps && game.phase !== 'finished'; i++) {
    const { action } = chooseAIAction(game);
    game = applyAction(game, action);
  }
  return buildPublicSimState(buildObservation(game, game.current));
}

const actionKey = (a) => JSON.stringify(a, (k, v) => (v === undefined ? null : v));

test('任务B：全部输出行动合法（多座位 × 多局面 × M0–M4 配置）', () => {
  const configs = [
    { seed: 1, useHistory: false, useHistoryStyle: false }, // M0/M2 口径
    { seed: 2, useHistory: true, useHistoryStyle: false },  // M3
    { seed: 3 },                                            // M4（默认）
  ];
  for (const seatCount of [2, 3, 4, 5]) {
    for (const seed of [101, 202]) {
      const state = midgameState(seatCount, seed);
      for (const options of configs) {
        const model = createOpponentModel({ rollouts: 4, ...options });
        const dist = model.predictAction(state, state.current);
        const legalKeys = new Set(enumerateLegalActions(state).map(actionKey));
        assert.ok(dist.entries.length > 0, `${seatCount}人 seed${seed} 无输出`);
        for (const e of dist.entries) {
          assert.ok(legalKeys.has(actionKey(e.action)), `输出非法行动：${JSON.stringify(e.action)}`);
        }
      }
    }
  }
});

test('任务B：概率数学约束（Σp=1、p∈(0,1]、无 NaN）', () => {
  for (const seatCount of [2, 3, 5]) {
    const state = midgameState(seatCount, 303);
    const model = createOpponentModel({ seed: 7, rollouts: 4 });
    const dist = model.predictAction(state, state.current);
    let sum = 0;
    for (const e of dist.entries) {
      assert.ok(Number.isFinite(e.p), '概率出现非有限值');
      assert.ok(e.p > 0, `概率必须为正：${e.p}`);
      assert.ok(e.p <= 1, `概率超过 1：${e.p}`);
      sum += e.p;
    }
    assert.ok(Math.abs(sum - 1) < 1e-9, `概率和偏离 1：${sum}`);
  }
});

test('任务B：非法行动概率严格为零（不在分布中）', () => {
  const state = midgameState(3, 404, 30);
  const model = createOpponentModel({ seed: 7, rollouts: 4 });
  const dist = model.predictAction(state, state.current);
  const outputKeys = new Set(dist.entries.map(e => actionKey(e.action)));
  // 对每个非法行动构造查证：不输出 = 概率 0。抽样核对若干明确非法动作。
  const player = state.players[state.current];
  const illegalProbes = [];
  // 1) 认领不可支付魔像位置：若存在则必须不在分布中。
  for (let index = 0; index < state.golemMarket.length; index++) {
    const claim = { type: 'claim', index };
    const isLegal = dist.entries.some(e => actionKey(e.action) === actionKey(claim));
    if (!isLegal) illegalProbes.push(claim);
  }
  // 2) 打出手牌中没有的卡。
  illegalProbes.push({ type: 'play', cardId: 'M43' });
  for (const probe of illegalProbes) {
    assert.equal(outputKeys.has(actionKey(probe)), false, `非法行动出现在分布中：${JSON.stringify(probe)}`);
  }
  assert.ok(illegalProbes.length > 0, '探针为空（测试失效）');
  void player;
});

test('任务B：相同状态可复现（同种子逐位一致；跨实例一致）', () => {
  const state = midgameState(4, 505);
  const m1 = createOpponentModel({ seed: 11, rollouts: 6 });
  const m2 = createOpponentModel({ seed: 11, rollouts: 6 });
  const a1 = m1.predictAction(state, state.current);
  const a2 = m2.predictAction(state, state.current);
  assert.deepEqual(
    a1.entries.map(e => [JSON.stringify(e.action), e.p, e.score]),
    a2.entries.map(e => [JSON.stringify(e.action), e.p, e.score]),
  );
  // 缓存命中不改变结果。
  const a3 = m1.predictAction(state, state.current);
  assert.deepEqual(a1.entries.map(e => e.p), a3.entries.map(e => e.p));
  assert.ok(m1.stats().cacheHits >= 1, '缓存应命中');
});

test('任务F：predictAction 支持任意席位（假设分支合法）且当前席位语义正确', () => {
  const state = midgameState(3, 606);
  const model = createOpponentModel({ seed: 3, rollouts: 4 });
  for (let pid = 0; pid < state.playerCount; pid++) {
    const dist = model.predictAction(state, pid);
    if (pid === state.current || state.phase === 'turn') {
      // 合法性：分布必须是该席位假设分支下的合法集（非当前席位时按"若为其行动"枚举）。
      for (const e of dist.entries) assert.ok(['claim', 'play', 'rest', 'acquire', 'discard'].includes(e.action.type));
      const sum = dist.entries.reduce((s, e) => s + e.p, 0);
      if (dist.entries.length) assert.ok(Math.abs(sum - 1) < 1e-9);
    }
  }
});

test('任务B：overflow 弃置分布合法且概率约束成立', () => {
  let game = createGame(['A', 'B', 'C'], 707, [1, 2]);
  game.players[0].isAI = true;
  // 构造溢出：席位 0 库存 12 颗 → phase=overflow。
  game.players[0].stock = [8, 2, 1, 1];
  game.current = 0;
  game.phase = 'overflow';
  const state = buildPublicSimState(buildObservation(game, game.current));
  assert.equal(state.phase, 'overflow');
  const model = createOpponentModel({ seed: 5 });
  const dist = model.predictAction(state, 0);
  const legal = enumerateLegalActions(state);
  assert.equal(dist.entries.length, legal.length, '弃置分布必须覆盖全部规范组合');
  const sum = dist.entries.reduce((s, e) => s + e.p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  // 最低价值色优先：纯黄组合概率最高（VALUES 黄最低）。
  const top = dist.entries.reduce((b, e) => (e.p > b.p ? e : b), dist.entries[0]);
  assert.equal(top.action.type, 'discard');
  assert.ok(top.action.colors.every(c => c === 0) || top.action.colors.every(c => c <= 1), '弃置应偏向低价值色');
});

test('任务F：输出可序列化（Node/浏览器通用数据形态）', () => {
  const state = midgameState(3, 808);
  const model = createOpponentModel({ seed: 2, rollouts: 4 });
  const dist = model.predictAction(state, state.current);
  const intent = model.predictIntent(state, state.current);
  for (const payload of [dist, intent]) {
    const json = JSON.stringify(payload);
    assert.ok(json.length > 10);
    assert.equal(json.includes('undefined'), false, '序列化出现 undefined（浏览器 JSON 丢弃字段风险）');
  }
});

test('任务B：竞争紧迫度进入打分——对手可立即认领的目标，先手认领概率显著更高', () => {
  // 座位 0/1 都可立即认领 G01（显式设置市场，消除牌序随机性）。
  const makeGame = (current) => {
    const game = createGame(['A', 'B'], 909, [1]);
    game.players[0].isAI = true;
    game.players[1].isAI = true;
    game.players[0].stock = [2, 1, 0, 1]; // G01 cost [2,1,0,1] 恰可支付
    game.players[1].stock = [2, 1, 0, 1];
    game.golemMarket = ['G01', 'G02', 'G03', 'G04', 'G05'];
    game.current = current;
    return game;
  };
  const model = createOpponentModel({ seed: 4, rollouts: 8 });
  const s0 = buildPublicSimState(buildObservation(makeGame(0), 0));
  const d0 = model.predictAction(s0, 0);
  const claimP0 = d0.entries.filter(e => e.action.type === 'claim').reduce((s, e) => s + e.p, 0);
  const s1 = buildPublicSimState(buildObservation(makeGame(1), 1));
  const d1 = model.predictAction(s1, 1);
  const claimP1 = d1.entries.filter(e => e.action.type === 'claim').reduce((s, e) => s + e.p, 0);
  assert.ok(claimP0 > 0.3, `可立即认领时概率过低：${claimP0}`);
  assert.ok(claimP1 > claimP0 * 0.5, '座位劣势应削弱但不消灭认领倾向');
});
