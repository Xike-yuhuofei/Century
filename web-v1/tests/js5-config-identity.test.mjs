/** 配置身份回归（三份报告的共同 P0-B）：版本名 ≠ 实际执行配置。
 *
 * 覆盖：
 * 1. joint-js5-opt 真正注入 claimRanking='prior'（不再是"只有名字不同"）；
 * 2. 有效配置哈希随版本预设/调用方覆盖变化；
 * 3. 活动冠军参数携带 adapter 时 chooseAIAction 确实走 JS5（js0 误分派的
 *    根因），而显式 legacy 束搜索参数走 AI 4.0 束搜索路径；
 * 4. 显式 structure 不能覆盖 adapter 分派（这是旧 duel js0/js1 的缺陷）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chooseAIAction } from '../dist/js/ai.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai.js';
import { resolveJointConfig, jointConfigHash, mergeJointOptions, versionOptionPreset } from '../dist/js/js/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, 'fixtures/js5-near-terminal-c10.json'), 'utf8')).game;
const legacy = JSON.parse(readFileSync(resolve(HERE, 'fixtures/legacy-champion.json'), 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));

test('joint-js5-opt 预设：claimRanking=prior；js5 仍是 enumeration', () => {
  assert.deepEqual(versionOptionPreset('joint-js5-opt'), { claimRanking: 'prior' });
  assert.deepEqual(versionOptionPreset('joint-js5'), {});
  const js5 = resolveJointConfig('joint-js5', mergeJointOptions('joint-js5'));
  const opt = resolveJointConfig('joint-js5-opt', mergeJointOptions('joint-js5-opt'));
  assert.equal(js5.claimRanking, 'enumeration');
  assert.equal(opt.claimRanking, 'prior');
  assert.equal(js5.preset && Object.keys(js5.preset).length, 0);
  assert.equal(opt.preset.claimRanking, 'prior');
  assert.notEqual(jointConfigHash(js5), jointConfigHash(opt), 'opt 的配置哈希必须与 js5 不同');
});

test('调用方覆盖优先于版本预设；resolved 配置可审计', () => {
  const overridden = resolveJointConfig('joint-js5-opt', mergeJointOptions('joint-js5-opt', { claimRanking: 'enumeration' }));
  assert.equal(overridden.claimRanking, 'enumeration');
  assert.equal(overridden.preset.claimRanking, 'prior');
  assert.equal(overridden.overrides.claimRanking, 'enumeration');
  assert.equal(overridden.nearTerminalCandidate, 'off');
  assert.equal(overridden.screenGoalScope, 'all');
  assert.equal(overridden.batchAdmission, 'legacy');
});

test('适配器返回有效配置身份（js5 vs js5-opt）', () => {
  const base = () => clone(fixture);
  // fixture 的当前席位不是 AI，但 chooseJointAction 只要求 current===seat；设置 isAI 便于 chooseAIAction 测试。
  const a = chooseJointAction(base(), { version: 'joint-js5', gateMode: 'always', workUnits: 32, worlds: 4, horizon: 48, simSeed: 2026102509, profile: NEUTRAL_PROFILE });
  const b = chooseJointAction(base(), { version: 'joint-js5-opt', gateMode: 'always', workUnits: 32, worlds: 4, horizon: 48, simSeed: 2026102509, profile: NEUTRAL_PROFILE });
  assert.equal(a.config.claimRanking, 'enumeration');
  assert.equal(b.config.claimRanking, 'prior');
  assert.notEqual(a.config.hash, b.config.hash);
  assert.equal(b.config.hash, jointConfigHash(b.config));
  assert.equal(a.config.budgetMode, 'fixed-work');
  assert.equal(a.config.workUnits, 32);
  assert.equal(a.config.profileName, NEUTRAL_PROFILE.name);
});

test('活动冠军参数确实分派到 JS5；显式 legacy 参数走束搜索；structure 不能覆盖 adapter', () => {
  const game = clone(fixture);
  game.players[0].isAI = true;
  const active = chooseAIAction(clone(game), { profile: NEUTRAL_PROFILE });
  assert.match(active.reason, /^js5 /, `活动冠军参数应分派到 JS5，实际：${active.reason.slice(0, 60)}`);
  const beam = chooseAIAction(clone(game), { parameters: legacy, profile: NEUTRAL_PROFILE });
  assert.match(beam.reason, /^AI 4\.0 /, `显式 legacy 参数应走束搜索，实际：${beam.reason.slice(0, 60)}`);
  // 关键反例：给活动冠军参数加 structure 仍会进入 adapter（旧 duel js1 的结构覆盖被吞）。
  const disguised = chooseAIAction(clone(game), { parameters: { ...CHAMPION_PARAMETERS, structure: 'beam-contest' }, structure: 'beam-contest', profile: NEUTRAL_PROFILE });
  assert.match(disguised.reason, /^js5 /, '携带 adapter 的参数 + structure 仍应走 JS5（记录该分派优先级）');
  const beamContest = chooseAIAction(clone(game), { parameters: legacy, structure: 'beam-contest', profile: NEUTRAL_PROFILE });
  assert.match(beamContest.reason, /^AI 4\.0 .*beam-contest/, '显式 legacy + beam-contest 才真正走束搜索结构');
});
