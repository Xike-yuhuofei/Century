/** Worker 决策核心与正式配置一致性（三份报告 P0-B / P1-D）。
 *
 * 此前 Worker 协议只有 version/profile/budget/simSeed/horizon/worlds，
 * gate/margin/cap/claimRanking 无法透传，导致"Worker 决策核心"与正式评测
 * 配置不可比。本测试锁定：
 * 1. search 选项白名单透传 + 未知字段显式拒绝；
 * 2. Worker 的 resolved config/hash 与共享解析器一致；
 * 3. 固定工作量下 Worker 与主线程适配器行动一致（C10 注入候选可选中）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideFromObservation, DecisionCoreError } from '../dist/js/ai-runtime/decision-core.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { resolveJointConfig, jointConfigHash, mergeJointOptions } from '../dist/js/js/config.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai.js';
import { buildObservation } from '../dist/js/ai/observation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const game = JSON.parse(readFileSync(resolve(HERE, 'fixtures/js5-near-terminal-c10.json'), 'utf8')).game;
const observation = buildObservation(game, game.current);
const clone = v => JSON.parse(JSON.stringify(v));

const baseRequest = (overrides = {}) => ({
  observation: clone(observation),
  ai: { jointVersion: 'joint-js5', profileName: NEUTRAL_PROFILE.name },
  budget: { mode: 'fixed-work', workUnits: 32 },
  simSeed: 2026102509,
  horizon: 48,
  worlds: 4,
  ...overrides,
});

test('Worker search 选项透传 + resolved config/hash 一致', () => {
  const search = { nearTerminalCandidate: 'replace', screenGoalScope: 'preferred', batchAdmission: 'balanced' };
  const r = decideFromObservation(baseRequest({ search }));
  const expected = resolveJointConfig('joint-js5', mergeJointOptions('joint-js5', {
    workUnits: 32, simSeed: 2026102509, horizon: 48, worlds: 4,
    profileName: NEUTRAL_PROFILE.name, ...search,
  }), NEUTRAL_PROFILE.name);
  assert.equal(r.diagnostics.config.nearTerminalCandidate, 'replace');
  assert.equal(r.diagnostics.config.screenGoalScope, 'preferred');
  assert.equal(r.diagnostics.config.batchAdmission, 'balanced');
  assert.equal(r.diagnostics.config.claimRanking, 'enumeration');
  assert.equal(r.diagnostics.config.hash, jointConfigHash(expected));
  assert.deepEqual(r.action, { type: 'play', cardId: 'M43', steps: [0, 0, 0] }, 'Worker 固定工作量下应选中注入候选');
});

test('Worker 与主线程适配器固定工作量行动一致（同配置/同种子）', () => {
  const search = { nearTerminalCandidate: 'replace' };
  const worker = decideFromObservation(baseRequest({ search }));
  const main = chooseJointAction(clone(game), {
    version: 'joint-js5', workUnits: 32, simSeed: 2026102509, horizon: 48, worlds: 4,
    profile: NEUTRAL_PROFILE, ...search,
  });
  assert.deepEqual(worker.action, main.action);
  assert.equal(worker.diagnostics.config.hash, main.config.hash);
});

test('joint-js5-opt 在 Worker 中也真正注入 prior 预设', () => {
  const r = decideFromObservation(baseRequest({ ai: { jointVersion: 'joint-js5-opt', profileName: NEUTRAL_PROFILE.name } }));
  assert.equal(r.diagnostics.config.claimRanking, 'prior');
  assert.equal(r.diagnostics.config.preset.claimRanking, 'prior');
});

test('未知搜索选项 / 非法值被协议层拒绝', () => {
  assert.throws(() => decideFromObservation(baseRequest({ search: { rogue: true } })), (e) => e instanceof DecisionCoreError && e.category === 'protocol');
  assert.throws(() => decideFromObservation(baseRequest({ search: { nearTerminalCandidate: 'always' } })), (e) => e instanceof DecisionCoreError && e.category === 'protocol');
  assert.throws(() => decideFromObservation(baseRequest({ search: { candidateCap: 99 } })), (e) => e instanceof DecisionCoreError && e.category === 'protocol');
});
