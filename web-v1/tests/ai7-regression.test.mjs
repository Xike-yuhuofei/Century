/** AI7 候选回归：生产不变、合法性、确定性（独立测试）。
 *
 * 1. 冻结冠军参数与 js5 决策行为逐位不变（生产默认决策不得被候选改变）。
 * 2. 三个候选版本在 2–5 人战术语料上全部返回可经正式引擎复核的合法行动。
 * 3. 固定工作量下候选决策逐位可复现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { applyAction } from '../dist/js/engine.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { PROFILES, NEUTRAL_PROFILE, CHAMPION_PARAMETERS } from '../dist/js/ai.js';
import { actionKey } from '../../training/scenarios/lib/classify.mjs';

const TRAIN_DATA = resolve(import.meta.dirname, '../../training/scenarios/data/scenarios.jsonl');
const SCENARIOS = readFileSync(TRAIN_DATA, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

const seatProfile = seat => seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
const CANDIDATES = ['joint-js6-endgame', 'joint-js7-arb', 'joint-js8-engine', 'joint-js8-engine-seat'];

function revive(scenario) {
  const game = structuredClone(scenario.engineState.position);
  for (const p of game.players) p.isAI = true;
  return game;
}

test('生产冠军参数未被候选篡改：仍是 joint-js5 / champion-guided / 100ms', () => {
  assert.equal(CHAMPION_PARAMETERS.id, 'joint-js5');
  assert.equal(CHAMPION_PARAMETERS.adapter, 'champion-guided');
  assert.equal(CHAMPION_PARAMETERS.jointVersion, 'joint-js5');
  assert.equal(CHAMPION_PARAMETERS.budgetMs, 100);
  assert.equal(CHAMPION_PARAMETERS.engineModel, undefined, '生产参数不得默认启用引擎 V2');
  assert.equal(CHAMPION_PARAMETERS.seatPolicy, undefined, '生产参数不得默认启用人条件策略');
});

test('冻结 js5 决策与语料 js5-w128 逐位一致（含四个审计局面）', () => {
  const ids = ['TS-2P-MCL-001', 'TS-4P-MCL-001', 'TS-4P-AVS-001', 'TS-3P-AVS-001', 'TS-3P-FIN-003'];
  for (const id of ids) {
    const scenario = SCENARIOS.find(s => s.id === id);
    const recorded = scenario.decisions['js5-w128'];
    assert.ok(recorded, `${id} 缺少 js5-w128 记录`);
    const game = revive(scenario);
    const r = chooseJointAction(game, {
      version: 'joint-js5', workUnits: 128, worlds: 4, simSeed: 0, profile: seatProfile(game.current),
    });
    assert.equal(actionKey(r.action), recorded.actionKey, `${id} 冻结 js5 行为漂移`);
  }
});

test('候选版本在全部战术语料上决策合法（2–5 人分层）', () => {
  const counts = new Map();
  for (const scenario of SCENARIOS) {
    counts.set(scenario.classification.playerCount, (counts.get(scenario.classification.playerCount) ?? 0) + 1);
    for (const version of CANDIDATES) {
      const game = revive(scenario);
      const r = chooseJointAction(game, {
        version, workUnits: 16, worlds: 2, simSeed: 0, profile: seatProfile(game.current),
      });
      assert.ok(r.action, `${scenario.id}/${version} 无决策`);
      assert.doesNotThrow(() => applyAction(structuredClone(game), r.action),
        `${scenario.id}/${version} 决策非法：${JSON.stringify(r.action)}`);
      assert.ok(r.config.hash, `${scenario.id}/${version} 缺少配置哈希`);
    }
  }
  for (const count of [2, 3, 4, 5]) {
    assert.ok((counts.get(count) ?? 0) >= 5, `${count} 人语料样本不足`);
  }
});

test('固定工作量决策逐位可复现（候选版本）', () => {
  const scenario = SCENARIOS.find(s => s.id === 'TS-4P-AVS-001');
  for (const version of CANDIDATES) {
    const run = () => {
      const game = revive(scenario);
      return chooseJointAction(game, {
        version, workUnits: 32, worlds: 4, simSeed: 7, profile: seatProfile(game.current),
      });
    };
    const a = run();
    const b = run();
    assert.deepEqual(a.action, b.action, `${version} 决策不可复现`);
    assert.equal(a.reason, b.reason, `${version} 决策理由不可复现`);
    assert.equal(a.config.hash, b.config.hash, `${version} 配置哈希不可复现`);
  }
});
