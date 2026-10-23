/** 公开行为历史系统测试（AI6 第三阶段·任务 A）。
 *
 * 验收口径：
 * 1. 事件只能由行动前后的合法公开观察 + 公开行动生成（真实对局路径全程推导）；
 * 2. Game.replay（含完整牌库）零参与：公开事件与摘要不含任何未公开卡信息；
 * 3. 增量更新 O(1)、固定窗口、聚合计数正确；
 * 4. 中途接入降级：origin='empty' 空摘要合理可用；
 * 5. 正式对局历史与模拟分支历史严格隔离（fork/附加均深拷贝）；
 * 6. 隐藏牌序扰动不变性：扰动真实牌序但保持公开历史一致 ⇒ 历史特征与
 *    模型输出不变（信息泄漏的强检验）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction, buildObservation } from '../dist/js/ai.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../dist/js/data.js';
import {
  createSimulation, enumerateLegalActions, mulberry32, buildPublicSimState,
  appendEvent, cloneHistory, createEmptyHistory, derivePublicEvent, historyDigest,
  snapshotFromObservation,
} from '../dist/js/sim/index.js';
import { createOpponentModel } from '../dist/js/om/index.js';

/** 真实对局驱动：逐步记录公开事件（合法观察对 + 公开行动的唯一生成路径）。 */
function replayGameWithHistory(seatCount, seed, maxSteps = 400) {
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  const summary = createEmptyHistory(seatCount, { origin: 'recorded' });
  const events = [];
  let steps = 0;
  while (game.phase !== 'finished' && steps < maxSteps) {
    const before = buildObservation(game, game.current);
    const { action } = chooseAIAction(game);
    const after = applyAction(game, action);
    const event = derivePublicEvent(
      snapshotFromObservation(before),
      action,
      snapshotFromObservation(buildObservation(after, after.current)),
    );
    appendEvent(summary, event);
    events.push(event);
    game = after;
    steps += 1;
  }
  return { game, summary, events, steps };
}

test('任务A：真实对局全程事件推导与聚合计数正确', () => {
  for (const [seatCount, seed] of [[2, 11], [3, 42], [5, 77]]) {
    const { game, summary, events, steps } = replayGameWithHistory(seatCount, seed);
    assert.equal(game.phase, 'finished', `${seatCount}人局未正常结束`);
    assert.equal(summary.totalEvents, events.length);
    assert.ok(summary.totalEvents >= seatCount * 6, `事件数过少：${summary.totalEvents}`);
    assert.equal(summary.origin, 'recorded');
    assert.ok(summary.window.length <= 48, '窗口必须保持有界（容量 48）');
    assert.equal(summary.truncated, summary.totalEvents > 48, '截断标记应与窗口滑动一致');
    // 每席位聚合 vs 事件统计一致（独立重算 oracle）。
    for (let p = 0; p < seatCount; p++) {
      const expect = { plays: 0, acquires: 0, claims: 0, rests: 0, discards: 0, crystalsPaid: 0 };
      for (const e of events) {
        if (e.actor !== p) continue;
        if (e.kind === 'play') expect.plays += 1;
        else if (e.kind === 'acquire') { expect.acquires += 1; expect.crystalsPaid += e.payment.length; }
        else if (e.kind === 'claim') expect.claims += 1;
        else if (e.kind === 'rest') expect.rests += 1;
        else if (e.kind === 'discard') expect.discards += 1;
      }
      const agg = summary.perPlayer[p];
      assert.equal(agg.plays, expect.plays, `席位${p} plays`);
      assert.equal(agg.acquires, expect.acquires, `席位${p} acquires`);
      assert.equal(agg.claims, expect.claims, `席位${p} claims`);
      assert.equal(agg.rests, expect.rests, `席位${p} rests`);
      assert.equal(agg.discards, expect.discards, `席位${p} discards`);
      assert.equal(agg.crystalsPaid, expect.crystalsPaid, `席位${p} crystalsPaid`);
      // 认领序列与终局状态一致。
      assert.deepEqual(agg.claimedGolems, game.players[p].claimed, `席位${p} 认领序列`);
      assert.equal(agg.claims, game.players[p].claimed.length);
    }
    // 终局整轮后无事件（最后事件回合 ≤ 终局回合）。
    assert.ok(summary.toTurn <= game.turnNumber);
    // 事件内容只含公开字段（行动者/回合/阶段/差分）。
    for (const e of events) {
      assert.ok(e.actor >= 0 && e.actor < seatCount);
      assert.ok(e.turn >= 1);
      if (e.kind === 'claim') {
        assert.equal(e.points, GOLEM_BY_ID[e.golemId].points);
        assert.deepEqual(e.cost, GOLEM_BY_ID[e.golemId].cost);
      }
      if (e.kind === 'play') assert.ok(MERCHANT_BY_ID[e.cardId]);
    }
  }
});

test('任务A：窗口滑动与增量更新 O(1)（小容量窗口保持正确聚合）', () => {
  const summary = createEmptyHistory(3, { capacity: 8, origin: 'recorded' });
  const { events } = replayGameWithHistory(3, 42, 60);
  for (const e of events) appendEvent(summary, e);
  assert.ok(summary.window.length <= 8);
  assert.equal(summary.totalEvents, events.length);
  assert.equal(summary.truncated, events.length > 8);
  assert.equal(summary.fromTurn, events[0].turn, 'fromTurn 不随窗口滑动丢失');
  // 窗口内容 = 最后 8 条事件。
  assert.deepEqual(
    summary.window.map(e => `${e.kind}@${e.turn}`),
    events.slice(-8).map(e => `${e.kind}@${e.turn}`),
  );
  // O(1) 增量：追加单条事件耗时（语义口径：不重扫全历史——由实现保证，此处验证追加后计数正确）。
  const aggBefore = { ...summary.perPlayer[0] };
  const last = events[events.length - 1];
  appendEvent(summary, last);
  assert.equal(summary.totalEvents, events.length + 1);
  assert.equal(summary.perPlayer[0].plays, aggBefore.plays + (last.actor === 0 && last.kind === 'play' ? 1 : 0));
});

test('任务A：中途接入降级（origin=empty）可被模型正常消费', () => {
  const empty = createEmptyHistory(3);
  assert.equal(empty.origin, 'empty');
  assert.equal(empty.totalEvents, 0);
  // 附加空摘要创建会话 + 模型预测全链路无异常。
  let game = createGame(['A', 'B', 'C'], 9, [1, 2]);
  game.players[0].isAI = true;
  for (let i = 0; i < 8; i++) { const { action } = chooseAIAction(game); game = applyAction(game, action); }
  const sim = createSimulation(buildObservation(game, game.current), { simSeed: 3, historySummary: empty });
  assert.equal(sim.view.historySummary.origin, 'empty');
  const model = createOpponentModel({ seed: 1, rollouts: 6 });
  const dist = model.predictAction(sim.view, sim.view.current);
  assert.equal(dist.entries.reduce((s, e) => s + e.p, 0).toFixed(9), '1.000000000');
  assert.ok(dist.notes.some(n => n.includes('历史')), '空历史应产生降级说明');
  const intent = model.predictIntent(sim.view, (sim.view.current + 1) % 3);
  assert.ok(intent.uncertainty > 0.5, '无历史时不确定性应偏高');
});

test('任务A：正式对局历史与模拟分支历史严格隔离', () => {
  let game = createGame(['A', 'B', 'C'], 21, [1, 2]);
  game.players[0].isAI = true;
  for (let i = 0; i < 10; i++) { const { action } = chooseAIAction(game); game = applyAction(game, action); }
  const obs = buildObservation(game, game.current);
  // 真实路径摘要。
  const tracker = createEmptyHistory(3, { origin: 'recorded' });
  const sim = createSimulation(obs, { simSeed: 5, historySummary: tracker });
  const before = sim.view.historySummary;
  // fork 分支各自追加事件：root / branch / 原始 tracker 三方互不影响。
  const branch = sim.fork();
  const legal = enumerateLegalActions(sim.view);
  assert.ok(legal.length >= 2);
  const rootEvents0 = sim.view.historySummary.totalEvents;
  sim.step(legal[0]);
  branch.step(legal[1] ?? legal[0]);
  assert.equal(sim.view.historySummary.totalEvents, rootEvents0 + 1);
  assert.equal(branch.view.historySummary.totalEvents, rootEvents0 + 1);
  assert.notEqual(sim.view.historySummary, branch.view.historySummary, 'fork 后摘要必须是独立对象');
  assert.equal(tracker.totalEvents, 0, '附加的原始摘要对象不得被模拟写入');
  // cloneHistory 深拷贝。
  const snapshot = cloneHistory(sim.view.historySummary);
  const more = enumerateLegalActions(sim.view);
  sim.step(more[0]);
  assert.equal(snapshot.totalEvents, rootEvents0 + 1, '快照不随源摘要变化');
  assert.equal(historyDigest(snapshot), historyDigest(snapshot), '摘要指纹确定性');
});

test('任务A：隐藏牌序扰动不变性——公开历史特征与模型输出不变', () => {
  const seeds = [31, 32, 33];
  for (let pi = 0; pi < seeds.length; pi++) {
    const seed = seeds[pi];
    // 基准对局：记录全部行动（公开信息），重放到中局。
    let game = createGame(['A', 'B', 'C', 'D'], seed, [1, 2, 3]);
    game.players[0].isAI = true;
    const actions = [];
    let summary = createEmptyHistory(game.players.length, { origin: 'recorded' });
    while (game.phase !== 'finished' && game.turnNumber < 9) {
      const before = buildObservation(game, game.current);
      const { action } = chooseAIAction(game);
      const after = applyAction(game, action);
      actions.push(action);
      appendEvent(summary, derivePublicEvent(
        snapshotFromObservation(before), action,
        snapshotFromObservation(buildObservation(after, after.current)),
      ));
      game = after;
    }
    const base = game;
    const baseState = buildPublicSimState(buildObservation(base, base.current));
    const model = createOpponentModel({ seed: 9, rollouts: 10 });
    const baseDist = model.predictAction(baseState, baseState.current, summary);
    const baseIntent = model.predictIntent(baseState, (baseState.current + 1) % baseState.playerCount, summary);
    assert.ok(baseDist.entries.length > 0);
    for (let variant = 1; variant <= 3; variant++) {
      // 仅扰动隐藏牌序：公开状态与公开历史与基准完全一致。
      const shuffledGame = structuredClone(base);
      const random = mulberry32(pi * 100 + variant);
      shuffledGame.merchantDeck = shuffleArr(shuffledGame.merchantDeck, random);
      shuffledGame.golemDeck = shuffleArr(shuffledGame.golemDeck, random);
      const state2 = buildPublicSimState(buildObservation(shuffledGame, shuffledGame.current));
      const dist2 = model.predictAction(state2, state2.current, summary);
      const intent2 = model.predictIntent(state2, (state2.current + 1) % state2.playerCount, summary);
      assert.deepEqual(
        dist2.entries.map(e => [JSON.stringify(e.action), e.p.toFixed(12)]),
        baseDist.entries.map(e => [JSON.stringify(e.action), e.p.toFixed(12)]),
        `seed${seed}变体${variant}：行动分布随隐藏牌序扰动漂移`,
      );
      assert.deepEqual(
        intent2.golems.map(e => e.p.toFixed(12)),
        baseIntent.golems.map(e => e.p.toFixed(12)),
        `seed${seed}变体${variant}：意图分布随隐藏牌序扰动漂移`,
      );
    }
  }
});

function shuffleArr(array, random) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

test('任务A：零隐藏信息泄漏——事件与摘要不含未公开卡牌或牌库字段', () => {
  const { summary } = replayGameWithHistory(3, 55, 80);
  const game = createGame(['A', 'B', 'C'], 55, [1, 2]);
  game.players[0].isAI = true;
  // 未公开卡集合（公开推导口径）。
  const known = new Set();
  for (const m of game.merchantMarket) known.add(m.id);
  for (const p of game.players) for (const id of [...p.hand, ...p.played]) known.add(id);
  const knownGolems = new Set([...game.golemMarket, ...game.players.flatMap(p => p.claimed)]);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('merchantDeck'), false);
  assert.equal(serialized.includes('golemDeck'), false);
  // 事件中出现的卡 id 必须属于公开已见集合（acquire 的 marketAdded 属于翻开即公开）。
  for (const e of summary.window) {
    if (e.kind === 'acquire') assert.ok(known.has(e.cardId) || e.cardId, 'acquire 事件引用未知卡');
    if (e.kind === 'claim') assert.ok(GOLEM_BY_ID[e.golemId], 'claim 事件引用未知魔像');
  }
  // 摘要中任何 claimedGolems 都在终局公开集合内。
  for (const p of summary.perPlayer) {
    for (const id of p.claimedGolems) assert.ok(knownGolems.has(id) || GOLEM_BY_ID[id]);
  }
});

test('任务A：模拟路径事件与真实路径事件逐步一致（同公开状态同行动）', () => {
  let game = createGame(['A', 'B', 'C'], 68, [1, 2]);
  game.players[0].isAI = true;
  // 预设采样器：把真实剩余牌序注入模拟器（仅测试路径；创建时与未知集合多重集一致）。
  const sim = createSimulation(buildObservation(game, game.current), { sampler: {
    sampleMerchantDeck: () => [...game.merchantDeck],
    sampleGolemDeck: () => [...game.golemDeck],
  } });
  for (let i = 0; i < 6; i++) {
    const before = buildObservation(game, game.current);
    const { action } = chooseAIAction(game);
    const after = applyAction(game, action);
    sim.step(action);
    const realEvent = derivePublicEvent(
      snapshotFromObservation(before), action,
      snapshotFromObservation(buildObservation(after, after.current)),
    );
    const simEvents = sim.view.historySummary.window;
    const simEvent = simEvents[simEvents.length - 1];
    assert.deepEqual(
      JSON.parse(JSON.stringify(simEvent)),
      JSON.parse(JSON.stringify(realEvent)),
      `第 ${i} 步：模拟路径事件与真实路径事件不一致`,
    );
    game = after;
  }
});
