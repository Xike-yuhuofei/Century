/** AI13 第二轮：轨迹内策略融合（目标锁定 / 计划跟随 / 终局加分）回归。
 *
 * 目的：新选项全部缺省关闭；显式开启时决策合法、确定、配置身份可审计。
 * 不改变冻结冠军默认行为。
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

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, 'fixtures/js5-near-terminal-c10.json'), 'utf8')).game;
const clone = v => JSON.parse(JSON.stringify(v));
const key = a => JSON.stringify(a);
const base = () => {
  const game = clone(fixture);
  game.players[0].isAI = true;
  return game;
};
const run = (opts = {}) => chooseJointAction(base(), {
  version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
  profile: NEUTRAL_PROFILE, simSeed: 20261102, ...opts,
});

test('新研究选项缺省全部关闭', () => {
  const cfg = resolveJointConfig('joint-js5', {});
  assert.equal(cfg.championTerminalBonus, 0);
  assert.equal(cfg.championTerminalAware, false);
  assert.equal(cfg.selfPlanFollowing, false);
  assert.equal(cfg.selfGoalLock, false);
});

test('selfGoalLock/selfPlanFollowing 缺省与显式 false 逐位一致', () => {
  const a = run({});
  const b = run({ selfGoalLock: false, selfPlanFollowing: false });
  assert.equal(key(a.action), key(b.action));
  assert.equal(a.config.selfGoalLock, false);
  assert.equal(b.config.selfGoalLock, false);
});

test('selfGoalLock 开启后决策合法、确定，并进入配置身份', () => {
  const cfg = resolveJointConfig('joint-js5', { selfGoalLock: true });
  assert.equal(cfg.selfGoalLock, true);
  const a = run({ selfGoalLock: true });
  const b = run({ selfGoalLock: true });
  assert.equal(key(a.action), key(b.action));
  assert.equal(a.config.selfGoalLock, true);
  const game = clone(fixture);
  assert.doesNotThrow(() => applyAction(game, a.action), `目标锁定决策非法：${key(a.action)}`);
});

test('championTerminalBonus 开启后决策合法且配置身份可审计', () => {
  const cfg = resolveJointConfig('joint-js5', { championTerminalBonus: 12, championTerminalAware: true });
  assert.equal(cfg.championTerminalBonus, 12);
  assert.equal(cfg.championTerminalAware, true);
  const d = chooseJointAction(base(), {
    version: 'joint-js5', workUnits: 32, championParameters: CHAMPION_PARAMETERS,
    profile: NEUTRAL_PROFILE, simSeed: 20261102,
    championTerminalBonus: 12, championTerminalAware: true,
  });
  const game = clone(fixture);
  assert.doesNotThrow(() => applyAction(game, d.action), `终局加分决策非法：${key(d.action)}`);
});
