/** AI7 C1 终局精确求解回归（独立测试）。
 *
 * 锚点：
 * - `TS-3P-FIN-003`（审计 §5.1）：精确结算下 M20×2 = 66 分 / 名次 2，
 *   M18×1 = 62 分 / 名次 3；冻结 js5 仍选 M18（生产行为不变）。
 * - 官方终局计分：非黄每颗 1 分、黄 0 分；弃置先弃黄。
 * - 2–5 人终局状态：求解结果必须能通过正式引擎 `applyAction` 复核。
 * - 仍有对手行动：名次界使用对手单动作上界，不假设对手不行动。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createGame, applyAction, score, ranking, count,
} from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai.js';
import { BASELINE_PARAMETERS, CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { trimStock } from '../dist/js/ai/evaluator.js';
import { chooseAIAction } from '../dist/js/ai.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import {
  isFinalOwnAction, solveFinalAction, finalScoreOfAction, endgameDiscardColors,
} from '../dist/js/js/endgame.js';
import { buildPublicSimState, enumerateLegalActions } from '../dist/js/sim/index.js';

const TRAIN_DATA = resolve(import.meta.dirname, '../../training/scenarios/data/scenarios.jsonl');
const SCENARIOS = readFileSync(TRAIN_DATA, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

function scenarioGame(id) {
  const scenario = SCENARIOS.find(s => s.id === id);
  assert.ok(scenario, `缺少基准局面 ${id}`);
  const game = structuredClone(scenario.engineState.position);
  for (const p of game.players) p.isAI = true;
  return game;
}

function legalOf(game) {
  const view = buildObservation(game, game.current);
  const sim = buildPublicSimState(view);
  return enumerateLegalActions(sim, { dedupe: true });
}

function actionKey(a) {
  return JSON.stringify(a);
}

/** 我方行动后，把终局圈剩余的对手行动逐一在正式引擎上执行，返回名次集合。
 * 只用公开合法枚举（测试侧 ground truth 复核，不属于 AI 输入）。 */
function ranksAfterOwnAction(game, action) {
  const seat = game.current;
  let g = applyAction(structuredClone(game), action);
  const ranks = [];
  let guard = 0;
  while (g.phase !== 'finished' && guard++ < 20) {
    if (g.phase === 'overflow') {
      const p = g.players[g.current];
      const colors = endgameDiscardColors(p.stock, count(p.stock) - 10);
      g = applyAction(g, { type: 'discard', colors });
      continue;
    }
    const legal = legalOf(g);
    // 对每个对手合法行动分别推进（若还有两名以上对手，递归分支会爆炸；
    // 本用例只覆盖终局圈剩余 ≤2 席位的局面）。
    const branches = legal.slice(0, 40);
    let last = null;
    for (const a of branches) {
      const h = applyAction(structuredClone(g), a);
      last = h;
      ranks.push(ranking(h).findIndex(p => p.id === seat) + 1);
    }
    assert.ok(last, '对手无合法行动（状态异常）');
    break; // 只展开第一个仍会行动的对手；其余分支留给名次区间上界。
  }
  return ranks;
}

test('TS-3P-FIN-003：精确求解选 M20×2（66 分 / 名次 2），M18×1 为 62 分 / 名次 3', () => {
  const game = scenarioGame('TS-3P-FIN-003');
  const view = buildObservation(game, game.current);
  assert.equal(isFinalOwnAction(view), true);
  const legal = legalOf(game);
  const solved = solveFinalAction(view, legal);
  assert.ok(solved, '终局求解不应返回 null');
  assert.deepEqual(solved.action, { type: 'play', cardId: 'M20', repeats: 2 });
  assert.equal(solved.ownFinalScore, 66);
  assert.equal(solved.guaranteedRank, 2);
  assert.equal(solved.optimisticRank, 2);

  const m18 = finalScoreOfAction(view, { type: 'play', cardId: 'M18', repeats: 1 });
  assert.equal(m18.ownFinalScore, 62, 'M18×1 精确最终得分应为 62');
  const m18Ranks = ranksAfterOwnAction(game, { type: 'play', cardId: 'M18', repeats: 1 });
  assert.equal(Math.max(...m18Ranks), 3, 'M18×1 在对手实际行动后应为名次 3');

  // 正式引擎复核：M20×2 后我方最终分 66；M18×1 后 62。
  const afterM20 = applyAction(structuredClone(game), solved.action);
  assert.equal(score(afterM20.players[1]), 66);
  const afterM18 = applyAction(structuredClone(game), { type: 'play', cardId: 'M18', repeats: 1 });
  assert.equal(score(afterM18.players[1]), 62);

  // 仍有对手行动（座位 2）：不假设对手不行动——名次界不得优于实际复核最差名次。
  const ranks = ranksAfterOwnAction(game, solved.action);
  assert.ok(ranks.length > 0);
  assert.ok(Math.max(...ranks) <= solved.guaranteedRank,
    `公开保证名次 ${solved.guaranteedRank} 不得优于对手实际行动后的最差名次 ${Math.max(...ranks)}`);
});

test('冻结 js5 仍选 M18（生产行为不变）；js6 候选选 M20×2', () => {
  const game = scenarioGame('TS-3P-FIN-003');
  const js5 = chooseJointAction(structuredClone(game), {
    version: 'joint-js5', workUnits: 128, worlds: 4, simSeed: 0,
  });
  assert.deepEqual(js5.action, { type: 'play', cardId: 'M18', repeats: 1 }, '冻结 js5 行为漂移');
  assert.equal(js5.config.endgameSolver, 'off');

  const js6 = chooseJointAction(structuredClone(game), {
    version: 'joint-js6-endgame', workUnits: 128, worlds: 4, simSeed: 0,
  });
  assert.deepEqual(js6.action, { type: 'play', cardId: 'M20', repeats: 2 });
  assert.equal(js6.config.endgameSolver, 'exact');
  assert.equal(js6.config.endgameDiscard, true);
  assert.equal(js6.joint.stats.endgame.ownFinalScore, 66);
  assert.equal(js6.joint.stats.endgame.guaranteedRank, 2);
  assert.equal(js6.joint.stats.endgame.rankModel, 'public-market-one-action-bound');
});

test('终局弃置口径：先弃黄，保留非黄（构造的 12 颗溢出局面）', () => {
  const stock = [1, 3, 5, 3];
  const colors = endgameDiscardColors(stock, 2);
  assert.deepEqual(colors, [0, 1]);
  const remaining = [...stock];
  for (const c of colors) remaining[c] -= 1;
  assert.deepEqual(remaining, [0, 2, 5, 3]);
  assert.equal(remaining.slice(1).reduce((s, x) => s + x, 0), 10);
});

test('审计 §5.7：冠军 trim 保留黄（残值 9），终局口径弃黄（残值 10）', () => {
  const stock = [1, 3, 5, 3];
  const market = ['G30', 'G23', 'G21', 'G20', 'G36'];
  const trimmed = trimStock(stock, market, null, CHAMPION_PARAMETERS);
  const trimResidual = trimmed.stock.slice(1).reduce((s, x) => s + x, 0);
  const colors = endgameDiscardColors(stock, 2);
  const endgameStock = [...stock];
  for (const c of colors) endgameStock[c] -= 1;
  const endgameResidual = endgameStock.slice(1).reduce((s, x) => s + x, 0);
  assert.deepEqual(trimmed.discarded, [1, 2], '冠军 trimStock 会弃绿/蓝并保留黄');
  assert.deepEqual(colors, [0, 1], '终局口径先弃黄');
  assert.equal(trimResidual, 9);
  assert.equal(endgameResidual, 10);
});

test('适配器溢出路径：js6 使用官方得分弃置；js5 保持冻结 trimStock', () => {
  const build = () => {
    const g = scenarioGame('TS-3P-FIN-003');
    g.phase = 'overflow';
    g.triggerPlayer = 0;
    g.players[1].stock = [1, 3, 5, 3];
    return g;
  };
  const js6 = chooseJointAction(build(), { version: 'joint-js6-endgame', workUnits: 16, worlds: 2 });
  assert.equal(js6.joint, null);
  assert.deepEqual(js6.action, { type: 'discard', colors: [0, 1] });
  assert.match(js6.reason, /终局官方得分口径/);
  assert.doesNotThrow(() => applyAction(build(), js6.action));

  const js5 = chooseJointAction(build(), { version: 'joint-js5', workUnits: 16, worlds: 2 });
  assert.equal(js5.action.type, 'discard');
  assert.equal(js5.action.colors.length, 2);
  assert.match(js5.reason, /trimStock/);
});

test('2/3/4 人真实终局局面：求解行动经正式引擎复核合法', () => {
  const terminalIds = SCENARIOS
    .filter(s => s.engineState.position.triggerPlayer !== null)
    .filter(s => s.classification.playerCount <= 4)
    .map(s => s.id);
  assert.ok(terminalIds.length >= 5, `终局局面样本不足：${terminalIds.length}`);
  for (const id of terminalIds) {
    const game = scenarioGame(id);
    const view = buildObservation(game, game.current);
    if (!isFinalOwnAction(view)) continue;
    const legal = legalOf(game);
    const solved = solveFinalAction(view, legal);
    assert.ok(solved, `${id} 终局求解为空`);
    assert.doesNotThrow(() => applyAction(structuredClone(game), solved.action), `${id} 求解行动非法`);
    assert.ok(solved.ownFinalScore >= 0);
    assert.ok(solved.guaranteedRank >= 1 && solved.guaranteedRank <= game.players.length);
    // 求解得分必须等于正式引擎该行动后的当前席位得分（含弃置）。
    const after = applyAction(structuredClone(game), solved.action);
    let final = after;
    if (after.phase === 'overflow') {
      const p = after.players[after.current];
      final = applyAction(after, { type: 'discard', colors: endgameDiscardColors(p.stock, count(p.stock) - 10) });
    }
    assert.equal(score(final.players[game.current]), solved.ownFinalScore, `${id} 精确得分不一致`);
  }
});

test('5 人真实终局局面：存在且求解合法（由正式引擎对局推进产生）', () => {
  const collected = [];
  for (let seed = 5200; seed < 5204 && collected.length < 2; seed++) {
    let g = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 600) {
      if (g.phase === 'turn' && g.triggerPlayer !== null && g.players.length === 5) {
        collected.push(structuredClone(g));
        break;
      }
      const r = chooseAIAction(g, { parameters: BASELINE_PARAMETERS });
      g = applyAction(g, r.action);
      moves += 1;
    }
  }
  assert.ok(collected.length > 0, '未采集到 5 人终局局面');
  for (const game of collected) {
    const view = buildObservation(game, game.current);
    assert.equal(view.players.length, 5);
    assert.equal(isFinalOwnAction(view), true);
    const legal = legalOf(game);
    const solved = solveFinalAction(view, legal);
    assert.ok(solved, '5 人终局求解为空');
    assert.doesNotThrow(() => applyAction(structuredClone(game), solved.action), '5 人终局求解行动非法');
  }
});

test('非终局状态不触发精确求解（避免中局贪心化）', () => {
  const mid = scenarioGame('TS-2P-CON-001');
  const view = buildObservation(mid, mid.current);
  assert.equal(isFinalOwnAction(view), false);
  assert.equal(solveFinalAction(view, legalOf(mid)), null);
});

test('官方平分规则：同分时座位号大者优先（求解名次与引擎 ranking 一致）', () => {
  // 终局圈：双方同分（各 1 颗绿水晶），座位号大者为本轮后手 ⇒ 名次更高。
  const fakeView = (playerId) => ({
    playerId, current: playerId, phase: 'turn', triggerPlayer: 0, turnNumber: 20,
    players: [
      { id: 0, stock: [0, 1, 0, 0], hand: [], played: [], claimed: [], copper: 0, silver: 0 },
      { id: 1, stock: [0, 1, 0, 0], hand: [], played: [], claimed: [], copper: 0, silver: 0 },
    ],
    golemMarket: [], merchantMarket: [], copper: 0, silver: 0,
  });
  const legal = [{ type: 'rest' }];

  const seat0 = solveFinalAction(fakeView(0), legal);
  assert.equal(seat0.ownFinalScore, 1);
  assert.equal(seat0.guaranteedRank, 2, '座位 0 同分应为名次 2（官方后手优先）');
  assert.equal(seat0.optimisticRank, 2);

  const seat1 = solveFinalAction(fakeView(1), legal);
  assert.equal(seat1.ownFinalScore, 1);
  assert.equal(seat1.guaranteedRank, 1, '座位 1 同分应为名次 1');
  assert.equal(seat1.optimisticRank, 1);

  // 与正式引擎 ranking 的平分规则逐条一致（score(b) − score(a) || b.id − a.id）。
  const game = { players: fakeView(0).players.map(p => ({ ...p, name: `P${p.id}`, turns: 0 })) };
  assert.deepEqual(ranking(game).map(p => p.id), [1, 0]);

  // 求解器不得把“同分但座位更小”误判为领先：座位 0 的最终名次必须等于引擎名次。
  assert.equal(seat0.guaranteedRank, ranking(game).findIndex(p => p.id === 0) + 1);
});
