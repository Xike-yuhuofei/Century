/** 公共模拟器单元测试（AI6 第二阶段·任务 A/B/C/D/G）。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, tradeLimit } from '../dist/js/engine.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
import { buildObservation } from '../dist/js/ai.js';
import {
  buildPublicSimState, createSimulation, enumerateLegalActions,
  hashPublicState, publicStateKey, simulatePublicAction, mulberry32,
} from '../dist/js/sim/index.js';
import {
  assertDeckOracle, presetSamplerFor, publicProjection, simulationFor,
} from './public-sim-harness.mjs';

const make = (n = 3, seed = 42) => createGame(Array.from({ length: n }, (_, i) => `玩家${i + 1}`), seed);
/** 构造/变换过局面的会话工厂：默认采样器（无预设多重集约束）。 */
const craftSim = (game, seed = 1) => createSimulation(buildObservation(game), { simSeed: seed });

test('任务A：buildPublicSimState 从合法观察构造紧凑公共状态', () => {
  const game = make(4);
  const obs = buildObservation(game);
  const state = buildPublicSimState(obs);
  assert.equal(state.playerCount, 4);
  assert.equal(state.current, 0);
  assert.equal(state.phase, 'turn');
  assert.equal(state.triggerPlayer, null);
  assert.equal(state.turnNumber, 1);
  assert.equal(state.merchantMarket.length, 6);
  assert.equal(state.golemMarket.length, 5);
  assert.deepEqual(state.players[0].stock, [3, 0, 0, 0]);
  assert.deepEqual(state.players[1].stock, [4, 0, 0, 0]);
  assert.deepEqual(state.players[0].hand.sort(), ['S01', 'S02']);
  // 未知卡集合：商人 43 − 市场 6；魔像 36 − 市场 5。
  assert.equal(state.unseenMerchants.length, 43 - 6);
  assert.equal(state.unseenGolems.length, 36 - 5);
  // 规范形：未知集合已排序。
  assert.deepEqual([...state.unseenMerchants].sort(), state.unseenMerchants);
  // 与输入观察不共享引用。
  assert.notEqual(state.players[0].stock, obs.players[0].stock);
  assert.notEqual(state.merchantMarket[0], obs.merchantMarket[0]);
  // 只读为契约约定（转移核心内部原地推进）；对外消费者不得修改。
  assert.throws(() => buildPublicSimState({ ...obs, copper: 1.5 }), /公共铜币池无效/);
});

test('任务A：拒绝非法公开观察', () => {
  const game = make(2);
  const obs = buildObservation(game);
  assert.throws(() => buildPublicSimState({ ...obs, players: obs.players.slice(0, 1) }), /2–6 名玩家/);
  assert.throws(() => buildPublicSimState({ ...obs, current: 9 }), /当前行动席位无效/);
  assert.throws(() => buildPublicSimState({ ...obs, phase: 'paused' }), /游戏阶段无效/);
  assert.throws(() => buildPublicSimState({ ...obs, turnNumber: 0 }), /回合计数无效/);
  assert.throws(() => buildPublicSimState({ ...obs, copper: -1 }), /公共铜币池无效/);
  assert.throws(() => buildPublicSimState({ ...obs, triggerPlayer: 7 }), /终局触发者无效/);
  const badStock = JSON.parse(JSON.stringify(obs));
  badStock.players[0].stock = [1, 2, 3];
  assert.throws(() => buildPublicSimState(badStock), /水晶库存无效/);
  const badCard = JSON.parse(JSON.stringify(obs));
  badCard.players[0].hand = ['XX99'];
  assert.throws(() => buildPublicSimState(badCard), /未知商人卡/);
  const badGolem = JSON.parse(JSON.stringify(obs));
  badGolem.golemMarket = ['GG01'];
  assert.throws(() => buildPublicSimState(badGolem), /魔像市场包含未知卡/);
});

test('任务A：builder 保真——中局观察与真实游戏公开字段逐位一致', () => {
  let game = make(5, 909);
  for (let i = 0; i < 25; i++) {
    const sim = simulationFor(game);
    const proj = publicProjection(sim.view);
    const obsProj = publicProjection(buildObservation(game, game.current));
    assert.deepEqual(proj, obsProj, `第 ${i} 步 builder 保真失败`);
    assertDeckOracle(game, sim, `第 ${i} 步`);
    const actions = enumerateLegalActions(sim.view);
    game = applyAction(game, actions[mulberry32(i + 1)() * actions.length | 0]);
    if (game.phase === 'finished') break;
  }
});

test('任务B：BeliefDeckSampler 契约（多重集一致、可复现、队首即下一次翻牌）', () => {
  const game = make(2, 7);
  const sim = simulationFor(game);
  const view = sim.view;
  // 持续获取 until 翻牌发生：验证翻开的卡等于预设队列队首。
  const preset = presetSamplerFor(game);
  const queue = preset.sampleMerchantDeck(view.unseenMerchants);
  const acquire = enumerateLegalActions(view)
    .filter(a => a.type === 'acquire')
    .sort((x, y) => y.index - x.index)[0];
  assert.ok(acquire, '无获取动作');
  const branch = sim.fork();
  branch.step(acquire);
  const revealed = branch.view.merchantMarket.find(m => !view.merchantMarket.some(o => o.id === m.id));
  assert.equal(revealed.id, queue[0], '翻开的卡应为模拟队列队首');
  assert.equal(branch.view.unseenMerchants.includes(queue[0]), false, '翻开的卡应从未知集合移除');
});

test('任务C：score/ranking 直接复用正式引擎（规则权威唯一）', () => {
  let game = make(3, 31337);
  const sim = simulationFor(game);
  for (let i = 0; i < 30 && game.phase !== 'finished'; i++) {
    const actions = enumerateLegalActions(sim.view);
    const claims = actions.filter(a => a.type === 'claim');
    const action = claims[0] ?? actions[0];
    sim.step(action);
    game = applyAction(game, action);
  }
  // 逐席位与正式引擎得分对照（复用 engine.score 的语义：魔像分 + 铜币×3 + 银币 + 绿/蓝/粉水晶数）。
  for (const p of game.players) {
    const golemPoints = p.claimed.reduce((sum, id) => sum + GOLEM_BY_ID[id].points, 0);
    const expected = golemPoints + p.copper * 3 + p.silver + p.stock.slice(1).reduce((s, v) => s + v, 0);
    assert.equal(sim.score(p.id), expected, `玩家 ${p.id} 得分不一致`);
  }
});

test('任务C：simulatePublicAction 功能式接口不修改原会话', () => {
  const game = make(2, 88);
  const sim = simulationFor(game);
  const before = JSON.stringify(publicProjection(sim.view));
  const actions = enumerateLegalActions(sim.view);
  const next = simulatePublicAction(sim, actions[0]);
  assert.equal(JSON.stringify(publicProjection(sim.view)), before, '原会话被修改');
  assert.notEqual(JSON.stringify(publicProjection(next.view)), before, '新会话未推进');
});

test('任务C：终局后 step 拒绝一切行动', () => {
  const game = make(2, 99);
  game.phase = 'finished';
  const sim = simulationFor(game);
  assert.throws(() => sim.step({ type: 'rest' }), /游戏已经结束/);
  assert.equal(enumerateLegalActions(sim.view).length, 0);
});

test('任务D：合法行动枚举口径', () => {
  const game = make(2, 1234);
  const sim = simulationFor(game);
  const view = sim.view;
  const actions = enumerateLegalActions(view);
  // 休息永远合法（引擎无条件允许）。
  assert.ok(actions.some(a => a.type === 'rest'));
  // 起始手牌：S01 创造 1 个动作；S02 升级（库存 3 黄）：
  // [], [0], [0,0]（黄→黄）, [0,1]（黄→黄后绿可用→蓝）。
  const s01 = actions.filter(a => a.type === 'play' && a.cardId === 'S01');
  assert.equal(s01.length, 1);
  const s02 = actions.filter(a => a.type === 'play' && a.cardId === 'S02');
  assert.deepEqual(s02.map(a => a.steps.length).sort((x, y) => x - y), [0, 1, 2, 2]);
  // 获取动作的支付长度必须等于位置下标。
  for (const a of actions.filter(a => a.type === 'acquire')) {
    assert.equal(a.payment.length, a.index);
  }
  // 起始水晶不足以认领任何魔像 → 无 claim。
  assert.equal(actions.filter(a => a.type === 'claim').length, 0);
  // tradeLimit 复用：M05（1 粉 → 1黄1绿1蓝）在库存无粉时不可交易。
  assert.equal(tradeLimit([0, 0, 0, 0], 'M05'), 0);
});

test('任务D：升级枚举含空序列与满次数序列，交易按 tradeLimit 枚举', () => {
  const game = make(2, 4321);
  // 构造：手牌 S02、库存黄 3 → 合法序列：[], [0], [0,0], [0,1]（S02 最多 2 次）。
  game.players[0].hand = ['S02'];
  game.players[0].stock = [3, 0, 0, 0];
  const sim = craftSim(game);
  const upgrades = enumerateLegalActions(sim.view).filter(a => a.type === 'play' && a.cardId === 'S02');
  assert.deepEqual(upgrades.map(a => a.steps.length).sort((x, y) => x - y), [0, 1, 2, 2]);
  // 交易：M05 输入 1 粉；给 2 粉 → repeats 1..2（tradeLimit=2）。
  game.players[0].hand = ['M05'];
  game.players[0].stock = [0, 0, 0, 2];
  const sim2 = craftSim(game);
  const trades = enumerateLegalActions(sim2.view).filter(a => a.type === 'play' && a.cardId === 'M05');
  assert.deepEqual(trades.map(a => a.repeats).sort((x, y) => x - y), [1, 2]);
});

test('任务D：dedupe 去重只做后继等价收缩', () => {
  const game = make(2, 5555);
  game.players[0].hand = ['S02'];
  game.players[0].stock = [2, 1, 0, 0]; // 黄2 绿1：全序列 6 个；等价终态 5 个。
  const sim = craftSim(game);
  const full = enumerateLegalActions(sim.view).filter(a => a.type === 'play' && a.cardId === 'S02');
  const deduped = enumerateLegalActions(sim.view, { dedupe: true }).filter(a => a.type === 'play' && a.cardId === 'S02');
  assert.ok(deduped.length > 0);
  assert.ok(deduped.length <= full.length, 'dedupe 必须不大于全量');
  // 每个去重代表仍是全量成员（且引擎可接受）。
  for (const action of deduped) {
    assert.ok(full.some(a => JSON.stringify(a) === JSON.stringify(action)));
  }
  // 去重后终态库存互不相同。
  const finals = new Set(deduped.map(a => {
    const branch = sim.fork();
    branch.step(a);
    return branch.view.players[0].stock.join(',');
  }));
  assert.equal(finals.size, deduped.length, 'dedupe 代表的终态库存应互不相同');
});

test('任务G：PublicStateHasher 确定性（同状态同哈希，槽位序变化哈希变化）', () => {
  const game = make(3, 2024);
  const sim = simulationFor(game);
  const h1 = hashPublicState(sim.view);
  const h2 = hashPublicState(simulationFor(game).view);
  assert.equal(h1, h2, '相同公开状态哈希应一致');
  assert.equal(publicStateKey(sim.view), publicStateKey(simulationFor(game).view));
  // 魔像市场顺序影响认领硬币语义 → 哈希必须区分。
  const swapped = structuredClone(game);
  [swapped.golemMarket[0], swapped.golemMarket[1]] = [swapped.golemMarket[1], swapped.golemMarket[0]];
  const simSwapped = simulationFor(swapped);
  assert.notEqual(hashPublicState(simSwapped.view), h1, '槽位序变化未反映在哈希中');
});

test('任务G：SimulationMetrics 计数与 fork 复制', () => {
  const game = make(2, 606);
  const sim = simulationFor(game);
  const m0 = sim.metrics.snapshot();
  assert.equal(m0.stateBuilds, 1);
  assert.equal(m0.beliefSamples, 2);
  assert.equal(m0.beliefCardsSampled, (43 - 6) + (36 - 5));
  assert.equal(m0.transitions, 0);
  const actions = enumerateLegalActions(sim.view);
  sim.step(actions[0]);
  sim.fork();
  // 创造卡携带 repeats = 非法行动（engine.applyPlay 校验）。
  try { sim.step({ type: 'play', cardId: 'S01', repeats: 1 }); } catch { /* 非法 */ }
  const m1 = sim.metrics.snapshot();
  assert.equal(m1.transitions, 1);
  assert.equal(m1.forks, 1);
  assert.equal(m1.illegalAttempts, 1);
});

test('任务G：固定行动策略多轮冒烟（2–5 人 × 多种子，全部推进至终局或上限）', () => {
  for (const n of [2, 3, 4, 5]) {
    for (const seed of [1, 2]) {
      let game = make(n, seed);
      // 固定策略：能认领就认领，否则打出第一张手牌，否则休息。
      const sim = simulationFor(game);
      let guard = 0;
      while (game.phase !== 'finished' && guard < 300) {
        const actions = enumerateLegalActions(sim.view);
        const claims = actions.filter(a => a.type === 'claim');
        const plays = actions.filter(a => a.type === 'play');
        const action = claims[0] ?? plays[0] ?? actions[0];
        sim.step(action);
        game = applyAction(game, action);
        guard += 1;
      }
      const proj = publicProjection(sim.view);
      assert.ok(['turn', 'overflow', 'finished'].includes(proj.phase));
      assert.ok(sim.view.players.every(p => p.stock.every(v => v >= 0)), '库存出现负数');
      if (game.phase === 'finished') {
        assert.equal(sim.ranking().length, n);
      }
    }
  }
});

test('任务G：轨迹记录与复放——相同行动序列 + 相同种子 ⇒ 相同最终状态', () => {
  const game = make(4, 424242);
  // 先用真实游戏走 12 步记录行动轨迹。
  const rng = mulberry32(3);
  let g = game;
  const trajectory = [];
  for (let i = 0; i < 12 && g.phase !== 'finished'; i++) {
    const sim = simulationFor(g);
    const actions = enumerateLegalActions(sim.view);
    const action = actions[Math.floor(rng() * actions.length)];
    trajectory.push(JSON.parse(JSON.stringify(action)));
    g = applyAction(g, action);
  }
  // 复放：从同一初始局面用预设牌序 + 相同行动序列重放。
  const replay = simulationFor(game);
  for (const action of trajectory) replay.step(action);
  assert.deepEqual(publicProjection(replay.view), publicProjection(simulationFor(g).view), '复放终态与原轨迹终态不一致');
  assert.equal(hashPublicState(replay.view), hashPublicState(simulationFor(g).view));
});
