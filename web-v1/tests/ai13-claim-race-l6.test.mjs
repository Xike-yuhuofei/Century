/** AI13 方向 A：多人认领竞赛叶评价 L6 回归。
 *
 * 目的：验证 L6 只由公开状态推导、与 L2 有可观测差异、决策合法且确定性；
 * 缺省 L2 行为不变。L6 是研究选项，不进入生产默认路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAction } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai/observation.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai/profiles.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { resolveJointConfig } from '../dist/js/js/config.js';
import { createSimulation } from '../dist/js/sim/session.js';
import { leafVector, evaluateLeaf } from '../dist/js/js/evaluators.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, 'fixtures/js5-near-terminal-c10.json'), 'utf8')).game;
const clone = v => JSON.parse(JSON.stringify(v));
const key = a => JSON.stringify(a);
const base = () => {
  const game = clone(fixture);
  game.players[0].isAI = true;
  return game;
};

test('L6 认领威胁只依赖公开状态且长度与席位一致', () => {
  const observation = buildObservation(clone(fixture), clone(fixture).current);
  const sim = createSimulation(observation, { simSeed: 0 });
  const vector = leafVector(sim.view, observation.current, { withClaimThreat: true });
  assert.equal(vector.claimThreat.length, sim.view.players.length);
  for (const threat of vector.claimThreat) {
    assert.ok(Number.isFinite(threat), '威胁值必须有限');
    assert.ok(threat >= 0, '威胁值不得为负');
  }
});

test('L6 与 L2 在该局面有可观测差异且值域合法', () => {
  const observation = buildObservation(clone(fixture), clone(fixture).current);
  const sim = createSimulation(observation, { simSeed: 0 });
  const seat = observation.current;
  const l2 = evaluateLeaf(sim.view, false, seat, 'L2', () => false);
  const l6 = evaluateLeaf(sim.view, false, seat, 'L6', () => false);
  assert.ok(l2 > 0 && l2 < 1, `L2 越界：${l2}`);
  assert.ok(l6 > 0 && l6 < 1, `L6 越界：${l6}`);
  assert.notEqual(l2, l6, '该局面的认领威胁差不为 0，L6 应与 L2 不同');
});

test('L6 进入有效配置身份，决策合法且同输入确定性一致', () => {
  const cfg0 = resolveJointConfig('joint-js5', {});
  const cfg1 = resolveJointConfig('joint-js5', { evaluator: 'L6' });
  assert.equal(cfg0.evaluator, 'L2');
  assert.equal(cfg1.evaluator, 'L6');
  const run = () => chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102, evaluator: 'L6',
  });
  const a = run();
  const b = run();
  assert.equal(key(a.action), key(b.action), 'L6 决策必须确定性');
  const game = clone(fixture);
  assert.doesNotThrow(() => applyAction(game, a.action), `L6 决策非法：${key(a.action)}`);
});

test('opponentClaimBias 缺省 0 与显式 0 行为逐位一致', () => {
  const run = (opts) => chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102, ...opts,
  });
  const a = run({});
  const b = run({ opponentClaimBias: 0 });
  assert.equal(key(a.action), key(b.action));
  assert.equal(a.config.opponentClaimBias, 0);
  assert.equal(b.config.opponentClaimBias, 0);
  const cfg = resolveJointConfig('joint-js5', { opponentClaimBias: 0.2 });
  assert.equal(cfg.opponentClaimBias, 0.2);
  assert.equal(cfg.overrides.opponentClaimBias, 0.2);
});

test('缺省 evaluator 仍为 L2（L6 不影响生产默认路径）', () => {
  const decision = chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102,
  });
  assert.equal(decision.config.evaluator, 'L2');
});
