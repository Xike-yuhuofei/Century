/** 公共模拟器 Differential Testing（AI6 第二阶段·任务 E，最高优先级验收）。
 *
 * 方法：测试环境构造同一个合法完整世界；真实剩余牌序仅作为测试预设条件
 * 注入模拟器（preset sampler）；比较正式规则引擎与公共模拟器的下一状态。
 *
 * 对照内容：
 * 1. 合法行动集合一致性：以正式引擎为 oracle 的独立候选宇宙 × 引擎接受集
 *    = 模拟器枚举集（双向，检测过宽/过严两个方向）。
 * 2. 后继状态逐字段对照：所有有规则意义的公开状态字段。
 * 3. 连续多步 playout（模式 B 持续会话）+ 每步重建保真（模式 A）。
 * 4. 牌库多重集 oracle：真实剩余牌库 ≡ 模拟器未知卡集合（每步强制）。
 * 5. 边界：市场补牌、牌库耗尽、容量溢出与弃置、终局触发与整轮完成、
 *    最终计分与平分决胜名次。
 *
 * 验收门槛：≥ 20,000 次合法状态转移对照，零不一致。
 * 差异时自动保存最小可复现局面（见 public-sim-harness.mjs dumpRepro）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
import { enumerateLegalActions } from '../dist/js/sim/index.js';
import {
  actionKey, assertDeckOracle, assertProjectionEqual, compareSingleStep,
  engineAcceptedActions, engineRankingOf, gameProjection, mulberry32,
  publicProjection, runDifferentialPlayout, simulationFor,
} from './public-sim-harness.mjs';
import { createSimulation } from '../dist/js/sim/index.js';
import { buildObservation } from '../dist/js/ai.js';

/** 跨测试累计的合法状态转移对照次数（验收门槛计数器）。 */
const stats = { comparisons: 0, positions: 0, games: 0, illegalParityChecks: 0 };

test('任务E：2–5人 playout differential（随机 + 贪心认领，模式 A+B）', () => {
  const plans = [];
  for (const n of [2, 3, 4, 5]) {
    plans.push({ playerCount: n, seed: 101, driverName: 'greedyClaim' });
    plans.push({ playerCount: n, seed: 202, driverName: 'greedyClaim' });
    plans.push({ playerCount: n, seed: 303, driverName: 'random' });
    plans.push({ playerCount: n, seed: 404, driverName: 'random' });
  }
  let finished = 0;
  for (const plan of plans) {
    const result = runDifferentialPlayout({ ...plan, maxSteps: 400 });
    stats.comparisons += result.comparisons;
    stats.games += 1;
    if (result.finished) finished += 1;
  }
  // 贪心认领驱动保证大量对局到达真实终局（触发/整轮完成/结算）。
  assert.ok(finished >= plans.length / 2, `到达终局的对局不足：${finished}/${plans.length}`);
});

test('任务E：冻结冠军 AI 驱动终局 differential（真实对局路径）', () => {
  // 仅作测试驱动器（与 tests/ai-fairness.test.mjs 同一模式）；n=2 与 n=5 覆盖两端。
  for (const n of [2, 5]) {
    const result = runDifferentialPlayout({ playerCount: n, seed: 505, driverName: 'ai', maxSteps: 400 });
    stats.comparisons += result.comparisons;
    stats.games += 1;
    assert.equal(result.finished, true, `AI 驱动对局未到达终局（n=${n}，步数=${result.steps}）`);
  }
});

test('任务E：合法行动集合一致性 + 逐动作后继对照（引擎为 oracle）', () => {
  // 采集跨阶段、跨人数的随机合法局面快照。
  const positions = [];
  const rng = mulberry32(990001);
  for (const n of [2, 3, 4, 5]) {
    for (const seed of [11, 22, 33, 44, 55]) {
      let game = createGame(Array.from({ length: n }, (_, i) => `玩家${i + 1}`), seed);
      let step = 0;
      while (game.phase !== 'finished' && step < 220) {
        // 跳过开局同质阶段（合法行动稀少），优先采集中后期局面。
        if (step >= 12 && step % 6 === 0) positions.push({ game: structuredClone(game), n, seed, step });
        const sim = simulationFor(game);
        const actions = enumerateLegalActions(sim.view);
        const claims = actions.filter(a => a.type === 'claim');
        const pool = claims.length ? claims : actions;
        game = applyAction(game, pool[Math.floor(rng() * pool.length)]);
        step += 1;
      }
    }
  }
  assert.ok(positions.length >= 100, `局面快照不足：${positions.length}`);

  let successorComparisons = 0;
  let checked = 0;
  for (const position of positions) {
    if (successorComparisons >= 24500 || checked >= 700) break;
    checked += 1;
    const { game } = position;
    const sim = simulationFor(game);

    // 引擎接受集（oracle，独立候选宇宙 × 引擎逐条校验）。
    const engineAccepted = engineAcceptedActions(game);
    const engineKeys = new Set(engineAccepted.map(actionKey));

    // 模拟器接受集（全量枚举 + fork 试探）。
    const enumerated = enumerateLegalActions(sim.view);
    const simAcceptedKeys = new Set();
    for (const action of enumerated) {
      const branch = sim.fork();
      if (branch.tryStep(action)) simAcceptedKeys.add(actionKey(action));
      stats.illegalParityChecks += 1;
    }

    // 双向一致：引擎接受 ⇔ 模拟器接受（过宽与过严两个方向都覆盖）。
    for (const action of enumerated) {
      const key = actionKey(action);
      assert.equal(simAcceptedKeys.has(key), engineKeys.has(key), `合法集合不一致（n=${position.n} seed=${position.seed} step=${position.step}）：action=${key} 引擎=${engineKeys.has(key) ? '接受' : '拒绝'} 模拟器=${simAcceptedKeys.has(key) ? '接受' : '拒绝'}`);
    }
    // 模拟器不得漏掉引擎接受的任何行动。
    for (const key of engineKeys) {
      assert.ok(simAcceptedKeys.has(key), `模拟器漏掉引擎合法行动：${key}（n=${position.n} seed=${position.seed} step=${position.step}）`);
    }

    // 去重口径必须仍是引擎接受集的子集（可证明后继等价收缩）。
    const deduped = enumerateLegalActions(sim.view, { dedupe: true });
    for (const action of deduped) {
      assert.ok(engineKeys.has(actionKey(action)), `dedupe 枚举产生引擎拒绝的行动：${actionKey(action)}`);
    }

    // 逐动作后继对照（全部接受的行动，含全部行动类型）。
    for (const action of engineAccepted) {
      const engineAfter = applyAction(game, action);
      const branch = sim.fork();
      branch.step(action);
      assertProjectionEqual(gameProjection(engineAfter), publicProjection(branch.view),
        { label: `universe n=${position.n} seed=${position.seed} step=${position.step}`, action });
      assertDeckOracle(engineAfter, branch, `universe n=${position.n}`);
      successorComparisons += 1;
    }
    stats.positions += 1;
  }
  stats.comparisons += successorComparisons;
});

test('任务E：容量溢出与弃置 differential（构造极端库存）', () => {
  // 构造：当前玩家库存 13 颗，手牌含 S01（创造 +2 黄）→ 打出后 15 颗触发溢出。
  const game = createGame(['甲', '乙', '丙'], 777);
  game.players[0].stock = [10, 1, 1, 1];
  const sim = simulationFor(game);
  let comparisons = 0;
  const stepped = compareSingleStep(game, sim, { type: 'play', cardId: 'S01' }, { label: 'overflow-trigger' });
  comparisons += stepped.comparisons;
  const g = stepped.game;
  assert.equal(g.phase, 'overflow', '构造失败：未触发溢出');

  // 弃置阶段：规范组合宇宙逐动作对照（同一玩家当前行动的溢出处理，不得推进他人回合）。
  // 弃置顺序与后继可证明无关（逐色扣减交换律），模拟器与引擎 oracle 均用规范组合口径。
  const accepted = engineAcceptedActions(g);
  assert.ok(accepted.length >= 5, `弃置候选过少：${accepted.length}`);
  for (const action of accepted) {
    const engineAfter = applyAction(g, action);
    const branch = sim.fork();
    branch.step(action);
    assertProjectionEqual(gameProjection(engineAfter), publicProjection(branch.view), { label: 'overflow-discard', action });
    // 弃置完成后应回到 turn 并轮转到下一位（0 号位弃置 → 1 号位行动）。
    assert.equal(engineAfter.phase, 'turn');
    assert.equal(engineAfter.current, (g.current + 1) % g.players.length);
    comparisons += 1;
  }
  stats.comparisons += comparisons;
});

test('任务E：牌库耗尽 differential（商人 + 魔像）', () => {
  const game = createGame(['甲', '乙'], 888);
  // 构造与公开信息一致的"近耗尽"世界：剩余牌库仅 2 张商人卡 + 1 张魔像卡，
  // 其余卡全部进入公开区域（对手手牌 / 已认领），保证牌库 oracle 一致。
  const keepMerchants = game.merchantDeck.slice(0, 2);
  const keepGolems = game.golemDeck.slice(0, 1);
  game.players[1].hand = [...game.players[1].hand, ...game.merchantDeck.slice(2)];
  game.players[1].claimed = [...game.players[1].claimed, ...game.golemDeck.slice(1)];
  game.merchantDeck = keepMerchants;
  game.golemDeck = keepGolems;
  const sim = simulationFor(game);
  let comparisons = 0;
  const rng = mulberry32(4242);
  let g = game;
  let guard = 0;
  let exhausted = false;
  while (g.phase !== 'finished' && guard < 80) {
    const s = simulationFor(g);
    const actions = enumerateLegalActions(s.view);
    const acquires = actions.filter(a => a.type === 'acquire' && a.index > 0);
    const pool = acquires.length ? acquires : actions;
    const action = pool[Math.floor(rng() * pool.length)];
    comparisons += compareSingleStep(g, sim, action, { label: 'deck-exhaustion', guard }).comparisons;
    g = applyAction(g, action);
    guard += 1;
    // 商人牌库耗尽后市场不补牌（市场规模只减不增）。
    if (g.merchantDeck.length === 0) exhausted = true;
  }
  assert.equal(exhausted, true, '构造失败：未到达牌库耗尽');
  stats.comparisons += comparisons;
});

test('任务E：终局触发与整轮完成 differential', () => {
  // 构造接近终局（与公开信息一致的牌库 oracle）：0 号位已认领 4 张
  // （4 人局门槛 5），再认领 1 张触发终局，其余玩家完成当前整轮后 finished。
  const game = createGame(['甲', '乙', '丙', '丁'], 999);
  // 从剩余牌库取 4 张作为 0 号位已认领（公开区域，牌库同步移除）。
  game.players[0].claimed = game.golemDeck.slice(0, 4);
  game.golemDeck = game.golemDeck.slice(4);
  // 给 0 号位恰好覆盖市场第一张魔像费用的水晶 + 硬币池各 1。
  const cost = GOLEM_BY_ID[game.golemMarket[0]].cost;
  game.players[0].stock = cost.map(c => c + 1);
  game.copper = 1;
  game.silver = 1;
  const sim = simulationFor(game);
  let comparisons = 0;
  let g = game;
  let guard = 0;
  while (g.phase !== 'finished' && guard < 40) {
    const s = simulationFor(g);
    const actions = enumerateLegalActions(s.view);
    const claims = actions.filter(a => a.type === 'claim');
    const action = claims.length ? claims[0] : { type: 'rest' };
    comparisons += compareSingleStep(g, sim, action, { label: 'endgame-trigger', guard }).comparisons;
    g = applyAction(g, action);
    guard += 1;
  }
  assert.equal(g.phase, 'finished', '构造失败：未触发终局');
  assert.equal(g.triggerPlayer, 0, '终局触发者应为 0 号位');
  assert.deepEqual(sim.ranking(), engineRankingOf(g), '终局名次不一致');
  stats.comparisons += comparisons;
});

test('任务E：平分决胜名次（同分后手席位优先）', () => {
  const tieGame = createGame(['甲', '乙', '丙'], 1111);
  tieGame.players[0].silver = 2; // 2 分
  tieGame.players[1].stock = [0, 2, 0, 0]; // 2 分（绿水晶计分）
  tieGame.players[2].claimed = [];
  tieGame.phase = 'finished';
  const tieSim = createSimulation(buildObservation(tieGame), { simSeed: 1 });
  assert.deepEqual(tieSim.ranking(), engineRankingOf(tieGame), '平分决胜名次不一致');
  assert.deepEqual(tieSim.ranking(), [1, 0, 2], '同分应后手席位优先');
});

test('任务E：对照总量达到验收门槛（≥ 20,000 次合法状态转移对照）', () => {
  assert.ok(stats.comparisons >= 20000, `对照次数不足：${stats.comparisons}（门槛 20000）`);
  console.log(`[public-sim-differential] 合法转移对照 ${stats.comparisons} 次 | 合法性奇偶校验 ${stats.illegalParityChecks} 次 | 局面 ${stats.positions} | 对局 ${stats.games}`);
});
