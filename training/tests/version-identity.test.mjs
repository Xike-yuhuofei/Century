/** 版本身份与对手池测试（AI6 第六阶段 P0：training 侧）。
 * 与 web-v1/tests/version-registry.test.mjs 互补：本文件覆盖对手池
 * 单一事实来源（pools.mjs）与金丝雀账本一致性（version-canary.json）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { FROZEN_VERSIONS, frozenVersion, parametersFingerprint } from '../../web-v1/dist/js/ai/version-registry.js';
import { POOLS, HISTORICAL_POOLS } from '../joint/pools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CANARY = resolve(REPO, 'training/joint/version-canary.json');

test('金丝雀账本一致性：version-canary.json 指纹与当前注册表一致', () => {
  assert.ok(existsSync(CANARY), 'version-canary.json 必须提交入库（金丝雀登记）');
  const doc = JSON.parse(readFileSync(CANARY, 'utf8'));
  for (const [id, fp] of Object.entries(doc.fingerprints)) {
    assert.equal(parametersFingerprint(FROZEN_VERSIONS[id].parameters), fp, `${id} 冻结参数漂移`);
  }
  assert.ok(doc.digests['legacy-js0'], '金丝雀决策摘要必须含 legacy-js0');
  assert.ok(doc.digests['joint-js5-frozen'], '金丝雀决策摘要必须含 joint-js5-frozen');
});

test('classic 池：风格变体参数 ≠ 基座且走束搜索结构；冠军席 = joint-js5-frozen', () => {
  const pool = POOLS.classic();
  const ids = pool.map(m => m.id);
  assert.equal(ids[0], 'joint-js5-frozen');
  assert.ok(ids.includes('neutral-baseline'));
  const legacy = frozenVersion('legacy-js0');
  for (const id of ['style-tempo', 'style-contest', 'style-engine']) {
    const m = pool.find(x => x.id === id);
    assert.ok(m, `${id} 缺失`);
    assert.notDeepEqual(m.parameters, legacy.parameters, `${id} 权重修改无效`);
    assert.equal(m.structure, 'beam-rollout');
  }
  // 冠军席参数 = 冻结 js5（适配器分派）。
  assert.deepEqual(pool[0].parameters, FROZEN_VERSIONS['joint-js5-frozen'].parameters);
});

test('diverse 池：结构多样性成员齐全且变体参数互不相同', () => {
  const pool = POOLS.diverse();
  const ids = pool.map(m => m.id);
  for (const expected of ['joint-js5-frozen', 'ai4-struct-beam-rollout', 'style-rush', 'style-engine', 'random-legal']) {
    assert.ok(ids.includes(expected), `diverse 池缺少 ${expected}`);
  }
  const rush = pool.find(m => m.id === 'style-rush');
  const eng = pool.find(m => m.id === 'style-engine');
  assert.notDeepEqual(rush.parameters, eng.parameters);
  assert.equal(pool.find(m => m.id === 'random-legal').randomLegal, true);
});

test('phase5 历史池：冠军席 id = ai5-readiness-efficiency（历史重放专用）', () => {
  const pool = HISTORICAL_POOLS.classic();
  assert.equal(pool[0].id, 'ai5-readiness-efficiency');
  assert.equal(pool[0].parameters.id, 'ai5-readiness-efficiency');
  const dpool = HISTORICAL_POOLS.diverse();
  assert.equal(dpool[0].id, 'ai5-readiness-efficiency');
});

test('决策级身份不等式：legacy-js0 ≠ legacy-js1 ≠ joint-js5（单局自对局）', () => {
  const seed = 1300500000;
  const selfPlay = play => {
    let game = createGame(['A', 'B'], seed, [1]);
    game.players[0].isAI = true;
    const decisions = [];
    let moves = 0;
    while (game.phase !== 'finished' && moves < 1500) {
      const seat = game.current;
      const profile = seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
      const action = play(game, seat, profile);
      decisions.push(JSON.stringify(action));
      game = applyAction(game, action);
      moves += 1;
    }
    return JSON.stringify(decisions);
  };
  const beam = (v) => selfPlay((g, seat, profile) =>
    chooseAIAction(g, { parameters: frozenVersion(v).parameters, structure: frozenVersion(v).structure, profile }).action);
  const js5 = selfPlay((g, seat, profile) =>
    chooseJointAction(g, { version: 'joint-js5', workUnits: 16, simSeed: seed, profile }).action);
  const d0 = beam('legacy-js0');
  const d1 = beam('legacy-js1');
  assert.notEqual(d0, d1, 'legacy-js0 与 legacy-js1（beam-contest）必须有行为差异');
  assert.notEqual(d0, js5, 'legacy-js0 与 joint-js5 必须有行为差异');
  assert.notEqual(d1, js5, 'legacy-js1 与 joint-js5 必须有行为差异');
});
