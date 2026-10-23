/** Issue #20 回归测试:AI 开局同质争抢同一魔像卡(座位感知竞争时序缺失)。
 *
 * 缺陷:beam 系结构的规划是纯单代理搜索——目标魔像在全部路线中永不消失,
 * 对手模型只覆盖商人卡,魔像卡的"被排在我前面的对手截胡"风险零建模。
 * 四个 AI 因此在开局全员锁定同一"最优"目标,先手必得,后手规划反复作废。
 *
 * 修复:新增结构变体 beam-contest(座位感知存活折扣):
 * - golemSurvivalModel 依据公开信息(座位顺序、对手库存与手牌、目标费用)
 *   估计每个市场魔像在我认领前仍存活的概率,乘进该目标的路线评分;
 * - 冠军结构与其余结构行为逐位不变(金标准断言)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
import {
  chooseAIAction, buildObservation, BASELINE_PARAMETERS,
  normalizeStructure,
} from '../dist/js/ai.js';
import { golemSurvivalModel } from '../dist/js/ai/opponent-model.js';

/** 与训练/duel_runner 一致的五席对局(人类席位由 AI 代理)。 */
function probeGame(seed) {
  const game = createGame(['AI-1', 'AI-2', 'AI-3', 'AI-4', '代理'], seed, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  return game;
}

const goalOf = (reason) => {
  const m = /公开目标 (\S+?)，/.exec(reason);
  return m ? m[1] : '-';
};

const contestParams = { ...BASELINE_PARAMETERS, id: 'test-beam-contest', structure: 'beam-contest' };

test('结构轴注册:beam-contest 合法,未知结构仍报错', () => {
  assert.equal(normalizeStructure('beam-contest'), 'beam-contest');
  assert.throws(() => normalizeStructure('seat-aware-9000'), /未知 AI 结构/);
});

test('存活模型:对手可达费用越高,目标存活系数越低', () => {
  const target = 'G01';
  const cost = GOLEM_BY_ID[target].cost;
  const mkPlayer = (id, stock) => ({
    id, name: `P${id}`, isAI: true,
    stock, hand: [], played: [], claimed: [],
    copper: 0, silver: 0, turns: 0,
  });
  const view = (opponentStock) => ({
    playerId: 0,
    players: [mkPlayer(0, [0, 0, 0, 0]), mkPlayer(1, opponentStock), mkPlayer(2, [0, 0, 0, 0]), mkPlayer(3, [0, 0, 0, 0])],
    current: 0,
    merchantMarket: [],
    golemMarket: [target],
    copper: 0, silver: 0,
    phase: 'turn',
    triggerPlayer: null,
    turnNumber: 1,
  });
  const strong = golemSurvivalModel(view([...cost]), 6)[target];
  const weak = golemSurvivalModel(view([0, 0, 0, 0]), 6)[target];
  assert.ok(strong >= 0 && strong <= 1, '存活系数必须位于 [0,1]');
  assert.ok(strong < weak, `满覆盖对手(${strong})应比零覆盖对手(${weak})更压低存活系数`);
});

test('存活模型:同一局面下先手视角的存活系数高于后手视角(座位感知)', () => {
  const game = probeGame(20261023);
  const first = buildObservation(game, 0);
  const last = buildObservation(game, 3);
  const firstSurvival = golemSurvivalModel({ ...first, current: 0 }, 6);
  const lastSurvival = golemSurvivalModel({ ...last, current: 3 }, 6);
  for (const id of game.golemMarket) {
    assert.ok(
      firstSurvival[id] > lastSurvival[id],
      `魔像 ${id}:先手视角 ${firstSurvival[id]} 应高于后手视角 ${lastSurvival[id]}`,
    );
  }
});

test('存活模型:终局当步不做折扣(triggerPlayer 非 null 时全为 1)', () => {
  const game = probeGame(20261023);
  const view = { ...buildObservation(game, 0), current: 0, triggerPlayer: 1 };
  const survival = golemSurvivalModel(view, 1);
  for (const id of game.golemMarket) assert.equal(survival[id], 1);
});

test('金标准:冠军结构(beam-rollout)决策序列逐位不变(seed=20261023,24 步)', () => {
  const GOLDEN = [
    '0:acquire:2:2', '1:play:S02', '2:play:S02', '3:play:S02', '4:play:S02',
    '0:play:M38', '1:rest', '2:rest', '3:rest', '4:rest',
    '0:play:S02', '1:play:S02', '2:play:S02', '3:play:S02', '4:play:S02',
    '0:rest', '1:claim:G01', '2:acquire:0:0', '3:rest', '4:rest',
    '0:play:M38', '1:acquire:0:0', '2:play:M11x1', '3:acquire:1:1',
  ];
  let game = probeGame(20261023);
  const steps = [];
  for (let i = 0; i < GOLDEN.length && game.phase !== 'finished'; i++) {
    const seat = game.current;
    const d = chooseAIAction(game); // 默认路径 = 冠军参数,行为必须与基线逐位一致
    const a = d.action;
    steps.push(
      a.type === 'claim' ? `${seat}:claim:${game.golemMarket[a.index]}`
        : a.type === 'play' ? `${seat}:play:${a.cardId}${a.repeats ? `x${a.repeats}` : ''}`
        : a.type === 'acquire' ? `${seat}:acquire:${a.index}:${a.payment.length}`
        : `${seat}:${a.type}`,
    );
    game = applyAction(game, d.action);
  }
  assert.deepEqual(steps, GOLDEN);
});

test('行为生效:beam-contest 的开局目标选择与 beam-rollout 存在座位感知差异', () => {
  const seeds = [20261023, 11, 22, 33, 44, 55, 66, 77];
  let differingSeeds = 0;
  const detail = [];
  for (const seed of seeds) {
    const goals = { rollout: [], contest: [] };
    for (const [key, options] of [
      ['rollout', undefined],
      ['contest', { parameters: contestParams, structure: 'beam-contest' }],
    ]) {
      let game = probeGame(seed);
      for (let i = 0; i < 4 && game.phase !== 'finished'; i++) {
        const d = chooseAIAction(game, options);
        goals[key].push(goalOf(d.reason));
        game = applyAction(game, d.action);
      }
    }
    const same = goals.rollout.every((g, i) => g === goals.contest[i]);
    if (!same) differingSeeds++;
    detail.push(`seed=${seed} rollout=[${goals.rollout}] contest=[${goals.contest}]`);
  }
  console.log('    ' + detail.join('\n    '));
  assert.ok(differingSeeds >= 1, `beam-contest 应至少在一个 seed 上改变开局目标分配(实际 ${differingSeeds}/8)`);
});

test('beam-contest:决策全程合法且同 seed 确定性可复现', () => {
  const options = { parameters: contestParams, structure: 'beam-contest' };
  const run = () => {
    let game = probeGame(20261023);
    const steps = [];
    for (let i = 0; i < 60 && game.phase !== 'finished'; i++) {
      const seat = game.current;
      const d = chooseAIAction(game, options);
      steps.push(`${seat}:${d.action.type}`);
      game = applyAction(game, d.action);
    }
    return steps;
  };
  const a = run();
  const b = run();
  assert.ok(a.length > 0);
  assert.deepEqual(a, b, '同 seed 的 beam-contest 决策必须确定性可复现');
});
