/** JS5 临近终局候选覆盖回归（P1-C）。
 *
 * 证据来源：
 * - c83f C10（century-replay-2026-10-24T17-11-18-358Z.json turn 176 seat 0）：
 *   基线候选遗漏当步正式净分最大行动 [0,0,0]（+3 分），replace/add 注入后
 *   联合模拟 8 次试验全部第一，决策改变为 [0,0,0]。
 * - 两个结构不同但同类的 AI 席位局面（game4 turn187 seat1：冠军休息、
 *   最大行动 M03×2；game22 turn148 seat2：冠军 S01、最大行动 M03×1）：
 *   证明修复覆盖的是"公开风险 + 当步正式净分"机制，不是记住 C10。
 *
 * 所有 fixture 只含公开状态（空牌库）；不使用历史未来序列。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAction, score, count } from '../dist/js/engine.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai.js';
import { trimStock } from '../dist/js/ai/evaluator.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { nearTerminalRisk, immediateOfficialScoreDelta, maxImmediateScoreAction } from '../dist/js/js/near-terminal.js';
import { createSimulation } from '../dist/js/sim/session.js';
import { enumerateLegalActions } from '../dist/js/sim/legal.js';
import { buildObservation } from '../dist/js/ai/observation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(readFileSync(resolve(HERE, 'fixtures', name), 'utf8')).game;
const clone = v => JSON.parse(JSON.stringify(v));
const key = a => JSON.stringify(a);

const CASES = [
  {
    name: 'C10 人类席位（历史上遗漏 +3 分升级）',
    file: 'js5-near-terminal-c10.json',
    seat: 0,
    expectedInjected: { type: 'play', cardId: 'M43', steps: [0, 0, 0] },
    expectedChampion: { type: 'play', cardId: 'M43', steps: [1, 1, 2] },
    expectedDelta: 3,
    expectedScoreAfter: 60,
    threatenedSeats: [3],
    selectionFlips: true,
  },
  {
    name: 'AI 席位 / 冠军休息 / 交易卡 M03（结构泛化 1）',
    file: 'js5-near-terminal-ai-rest.json',
    seat: 1,
    expectedInjected: { type: 'play', cardId: 'M03', repeats: 2 },
    expectedChampion: { type: 'rest' },
    expectedDelta: 2,
    selectionFlips: false,
  },
  {
    name: 'AI 席位 / 冠军 S01 / 交易卡 M03（结构泛化 2）',
    file: 'js5-near-terminal-ai-trade.json',
    seat: 2,
    expectedInjected: { type: 'play', cardId: 'M03', repeats: 1 },
    expectedChampion: { type: 'play', cardId: 'S01' },
    expectedDelta: 1,
    selectionFlips: false,
  },
];

function run(game, options) {
  return chooseJointAction(clone(game), {
    version: 'joint-js5', gateMode: 'always', workUnits: 32, worlds: 4, horizon: 48,
    simSeed: 2026102509, profile: NEUTRAL_PROFILE, ...options,
  });
}

function legalOf(game) {
  const sim = createSimulation(buildObservation(clone(game), game.current), { simSeed: 0 });
  return enumerateLegalActions(sim.view, { dedupe: true });
}

test('当步正式净分差分与正式引擎逐动作一致（含强制弃置）', () => {
  for (const c of CASES) {
    const game = load(c.file);
    const view = buildObservation(game, game.current);
    const before = score(game.players[game.current]);
    const legal = legalOf(game);
    assert.ok(legal.length > 0);
    let checked = 0;
    for (const action of legal) {
      const estimate = immediateOfficialScoreDelta(view, action);
      const next = clone(game);
      const after = applyAction(next, action);
      let final = after;
      if (after.phase === 'overflow') {
        const discarded = trimStock(after.players[after.current].stock, after.golemMarket, null, CHAMPION_PARAMETERS).discarded;
        final = applyAction(after, { type: 'discard', colors: discarded });
      }
      const actual = score(final.players[game.current]) - before;
      if (estimate === null) continue; // overflow 阶段/非当前席位等不支持项
      assert.equal(estimate.delta, actual, `${c.name}: ${key(action)} 净分差分不一致`);
      assert.equal(estimate.scoreAfter, score(final.players[game.current]), `${c.name}: ${key(action)} scoreAfter 不一致`);
      checked += 1;
    }
    assert.ok(checked >= Math.min(10, legal.length), `${c.name}: 有效比对动作过少`);
  }
});

test('C10：冻结基线候选遗漏 + replace/add 注入后可见且可选中', () => {
  const game = load('js5-near-terminal-c10.json');
  const baseline = run(game);
  assert.deepEqual(baseline.joint.championAction, { type: 'play', cardId: 'M43', steps: [1, 1, 2] });
  assert.equal(baseline.joint.stats.nearTerminal, undefined, 'off 策略不得输出注入遥测（冻结行为）');
  assert.ok(!baseline.joint.evaluations.some(e => key(e.action) === key(CASES[0].expectedInjected)), '基线候选不应包含 [0,0,0]（修复前状态）');

  const replaced = run(game, { nearTerminalCandidate: 'replace' });
  const injected = replaced.joint.stats.nearTerminal;
  assert.ok(injected?.risky, 'C10 必须识别为临近终局风险');
  assert.deepEqual(injected.threatenedSeats, [3], '公开可触发席位应为 seat 3');
  assert.deepEqual(injected.injected.action, CASES[0].expectedInjected);
  assert.equal(injected.injected.delta, 3);
  assert.equal(injected.injected.scoreAfter, 60);
  assert.equal(injected.mode, 'replace');
  assert.equal(replaced.joint.stats.candidateCount, 4, 'replace 不增加候选数（预算中性）');
  assert.ok(injected.candidateSources.includes('near-terminal'));
  const evalInjected = replaced.joint.evaluations.find(e => key(e.action) === key(CASES[0].expectedInjected));
  assert.ok(evalInjected, '注入候选必须参与联合评估');
  assert.equal(evalInjected.trials, 8, 'replace 下每候选试验数应保持 8（4 世界 × 2 轮）');
  assert.equal(evalInjected.mean, 1, 'C10 注入候选在 8 条 CRN 轨迹上应全部第一');
  assert.deepEqual(replaced.action, CASES[0].expectedInjected, 'C10 注入候选应被联合仲裁选中');
  assert.deepEqual(replaced.joint.championAction, CASES[0].expectedChampion, '冠军行动锚点不变');

  const added = run(game, { nearTerminalCandidate: 'add' });
  assert.equal(added.joint.stats.candidateCount, 5, 'add 明确增加一个候选');
  assert.deepEqual(added.joint.stats.nearTerminal.injected.action, CASES[0].expectedInjected);
  assert.deepEqual(added.action, CASES[0].expectedInjected, 'add 下同样选中注入候选');
});

test('结构泛化：不同席位/牌面/库存下，注入机制仍覆盖当步净分最大行动', () => {
  for (const c of CASES.slice(1)) {
    const game = load(c.file);
    const legal = legalOf(game);
    const best = maxImmediateScoreAction(buildObservation(game, game.current), legal);
    assert.equal(best?.delta, c.expectedDelta, `${c.name}: 最大净分差分应为 ${c.expectedDelta}`);
    assert.equal(key(best.action), key(c.expectedInjected), `${c.name}: 最大行动应为期望值`);

    const risk = nearTerminalRisk(buildObservation(game, game.current));
    assert.equal(risk.risky, true, `${c.name}: 应识别临近终局风险`);
    if (c.threatenedSeats) assert.deepEqual(risk.threatenedSeats, c.threatenedSeats);

    const baseline = run(game);
    assert.equal(baseline.joint.championAction ? key(baseline.joint.championAction) : null, key(c.expectedChampion), `${c.name}: 冠军锚点`);
    assert.ok(!baseline.joint.evaluations.some(e => key(e.action) === key(c.expectedInjected)), `${c.name}: 基线应遗漏最大净分行动`);

    const replaced = run(game, { nearTerminalCandidate: 'replace' });
    const inj = replaced.joint.stats.nearTerminal;
    assert.deepEqual(inj.injected.action, c.expectedInjected, `${c.name}: replace 注入行动`);
    assert.equal(replaced.joint.stats.candidateCount, baseline.joint.stats.candidateCount, `${c.name}: replace 候选数不变`);
    assert.ok(replaced.joint.evaluations.some(e => key(e.action) === key(c.expectedInjected)), `${c.name}: 注入候选参与评估`);
    assert.doesNotThrow(() => applyAction(clone(game), replaced.action), `${c.name}: 决策必须合法`);

    const added = run(game, { nearTerminalCandidate: 'add' });
    assert.equal(added.joint.stats.candidateCount, baseline.joint.stats.candidateCount + 1, `${c.name}: add 候选数 +1`);
    assert.ok(added.joint.evaluations.some(e => key(e.action) === key(c.expectedInjected)), `${c.name}: add 注入候选参与评估`);
  }
});
