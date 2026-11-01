/** AI12：冠军计划路线候选（championAlternatives）回归。
 *
 * 目的：允许联合仲裁候选集加入束搜索最终束中排名 2..N 的不同首步，用于检验
 * “仲裁候选空间过窄”是否限制冠军强度。缺省必须逐位不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGame, applyAction } from '../dist/js/engine.js';
import { choosePlan } from '../dist/js/ai/planner.js';
import { buildObservation } from '../dist/js/ai/observation.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai/profiles.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { resolveJointConfig } from '../dist/js/js/config.js';
import { createSimulation } from '../dist/js/sim/session.js';
import { leafVector } from '../dist/js/js/evaluators.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, 'fixtures/js5-near-terminal-c10.json'), 'utf8')).game;
const clone = v => JSON.parse(JSON.stringify(v));
const key = a => JSON.stringify(a);
const createSimulationForTest = observation => createSimulation(observation, { simSeed: 0 });

function planAlternatives(observation, count) {
  return choosePlan(observation, CHAMPION_PARAMETERS, NEUTRAL_PROFILE, 'beam-rollout', null, { alternatives: count });
}

test('plan 路线候选：首步均可在正式引擎上执行，且不与主行动重复', () => {
  const observation = buildObservation(fixture, fixture.current);
  const plan = planAlternatives(observation, 2);
  assert.ok(plan, '缺少计划');
  const alternatives = plan.alternatives ?? [];
  assert.ok(alternatives.length <= 2);
  const seen = new Set([key(plan.first)]);
  for (const alt of alternatives) {
    assert.equal(seen.has(key(alt.action)), false, '候选首步与主行动/其他候选重复');
    seen.add(key(alt.action));
    const game = clone(fixture);
    assert.doesNotThrow(() => applyAction(game, alt.action), `候选首步非法：${key(alt.action)}`);
  }
});

test('championAlternatives 缺省与显式 0 逐位一致（A/A）', () => {
  const base = () => clone(fixture);
  base().players[0].isAI = true;
  const a = chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102,
  });
  const b = chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102, championAlternatives: 0,
  });
  assert.equal(key(a.action), key(b.action));
  // 显式记录 0 会进入 overrides（配置身份如实披露调用方覆盖），但行为必须一致。
  assert.equal(a.config.championAlternatives, 0);
  assert.equal(b.config.championAlternatives, 0);
});

test('championAlternatives 进入有效配置身份且候选行动合法', () => {
  const cfg0 = resolveJointConfig('joint-js5', { championAlternatives: 0 });
  const cfg1 = resolveJointConfig('joint-js5', { championAlternatives: 1 });
  assert.equal(cfg0.championAlternatives, 0);
  assert.equal(cfg1.championAlternatives, 1);
  const base = () => clone(fixture);
  base().players[0].isAI = true;
  const decision = chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102, championAlternatives: 1,
  });
  assert.notEqual(decision.config.hash, resolveJointConfig('joint-js5', {}).hash);
  const game = clone(fixture);
  assert.doesNotThrow(() => applyAction(game, decision.action), `候选行动非法：${key(decision.action)}`);
});

test('championAlternatives 确定性：同输入两次决策完全一致', () => {
  const run = () => chooseJointAction(clone(fixture), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102, championAlternatives: 2,
  });
  const a = run();
  const b = run();
  assert.equal(key(a.action), key(b.action));
  assert.equal(a.config.hash, b.config.hash);
});

test('叶价值手牌权重：缺省 1 与冻结口径一致，权重 0 只计已打出引擎', () => {
  const observation = buildObservation(fixture, fixture.current);
  const sim = createSimulationForTest(observation);
  const base = { handWeight: 1 };
  const frozen = leafVector(sim.view, sim.view.current);
  const weighted = leafVector(sim.view, sim.view.current, base);
  assert.deepEqual(weighted.engine, frozen.engine);
  const playedOnly = leafVector(sim.view, sim.view.current, { handWeight: 0 });
  for (let i = 0; i < playedOnly.engine.length; i++) {
    assert.equal(playedOnly.engine[i], sim.view.players[i].played.length);
  }
  // 有手牌时，降低手牌权重必须降低该席位的 engine 值（否则选项无效）。
  const hasHand = sim.view.players.some(p => p.hand.length > 0);
  if (hasHand) {
    const idx = sim.view.players.findIndex(p => p.hand.length > 0);
    assert.ok(playedOnly.engine[idx] < frozen.engine[idx]);
  }
});

test('evaluatorHandWeight=1 与缺省决策逐位一致（A/A）', () => {
  const base = () => clone(fixture);
  base().players[0].isAI = true;
  const a = chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102,
  });
  const b = chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102, evaluatorHandWeight: 1,
  });
  assert.equal(key(a.action), key(b.action));
  assert.equal(a.config.evaluatorHandWeight, 1);
  assert.equal(b.config.evaluatorHandWeight, 1);
});
