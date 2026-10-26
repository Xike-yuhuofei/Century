/** AI9 协同进化：精英池、MAP-Elites、依赖感知交叉、消融与生成器。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  generateMultiModuleBatch, recordCoEvolutionElite, eliteCell,
  expandDependencies, moduleTextsFromArtifact, DEFAULT_STRATEGIES,
} from '../multi-module-generator.mjs';
import { moduleRegistry, getModule } from '../../../ai5/openevolve/node/module_registry.mjs';
import { createCompiledModuleCandidate, MULTI_MODULE_INFO } from '../multi-module-candidate.mjs';

const experiment = {
  configRef: 'ai9://test/coevolution',
  configHash: 'c'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: 'ai9-screen-w002', base: 1_660_002_000, count: 2 },
    { purpose: 'deep', windowId: 'ai9-deep-w002', base: 1_670_002_000, count: 2 },
  ],
};

test('MAP-Elites：行为分桶只依赖公开动作分布，缺失签名返回 null', () => {
  assert.equal(eliteCell({ behaviorSignature: { actions: { acquire: 0, claim: 0, rest: 0.5, play: 0.5 } } }), '0-0');
  assert.equal(eliteCell({ behaviorSignature: { actions: { acquire: 0.5, claim: 0.5, rest: 0, play: 0 } } }), '2-2');
  assert.equal(eliteCell({ metrics: {} }), null);
});

test('精英记录：同类模块只保留更高分，深验优先于快筛；MAP-Elites 每桶保留最优', () => {
  const state = { moduleElites: [], mapElites: {} };
  const artifact = { candidateId: 'cand-a', identityDigest: 'a'.repeat(64), source: { modules: [{ id: 'M01' }, { id: 'M02' }] } };
  const evidence = {
    metrics: { firstPlaceDelta: 0.1, chanceAdjustedRate: 0.1 },
    behaviorSignature: { actions: { acquire: 0.25, claim: 0.5, rest: 0.25, play: 0 } },
  };
  recordCoEvolutionElite({ state, artifact, evidence, item: { deep: { evidencePath: 'x.json' } }, strategy: 'pair' });
  assert.equal(state.moduleElites.length, 2);
  assert.equal(Object.keys(state.mapElites).length, 1);

  const better = { candidateId: 'cand-b', identityDigest: 'b'.repeat(64), source: { modules: [{ id: 'M01' }] } };
  recordCoEvolutionElite({
    state, artifact: better,
    evidence: { metrics: { firstPlaceDelta: 0.3 }, behaviorSignature: { actions: { acquire: 0.25, claim: 0.5, rest: 0.25, play: 0 } } },
    item: { deep: { evidencePath: 'y.json' } }, strategy: 'single',
  });
  const m01 = state.moduleElites.find(e => e.moduleId === 'M01');
  assert.equal(m01.candidateId, 'cand-b');
  assert.equal(state.mapElites['1-2'].candidateId, 'cand-b');
  const m02 = state.moduleElites.find(e => e.moduleId === 'M02');
  assert.equal(m02.candidateId, 'cand-a');
});

test('依赖感知：M02 组合时优先固定同一捐赠者的 M03/M04；缺失依赖保持官方实现', () => {
  const registry = moduleRegistry();
  assert.deepEqual(getModule('M02', registry).dependsOn, ['M03', 'M04']);
  const expanded = expandDependencies({ M02: 'evolved-M02' }, { M03: 'evolved-M03' }, registry);
  assert.deepEqual(expanded, { M02: 'evolved-M02', M03: 'evolved-M03' });
  const officialDeps = expandDependencies({ M02: 'evolved-M02' }, {}, registry);
  assert.deepEqual(officialDeps, { M02: 'evolved-M02' });
});

test('生成器：依赖不足时 crossover/ablation 被拒绝而不是伪造组合', () => {
  const batch = generateMultiModuleBatch({
    count: 2,
    round: 1,
    seed: 7,
    experiment,
    moduleConfig: { strategies: ['crossover', 'ablation'], includeControl: false },
    eliteArtifacts: [],
  });
  assert.equal(batch.candidates.length, 0);
  assert.ok(batch.rejectedAtGeneration.some(r => r.strategy === 'crossover'));
  assert.ok(batch.rejectedAtGeneration.some(r => r.strategy === 'ablation'));
});

test('生成器：单模块确定性候选真实编译，策略/模块身份/探针证据完整', { timeout: 240_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true);
  const batch = generateMultiModuleBatch({
    count: 1,
    round: 1,
    seed: 11,
    experiment,
    moduleConfig: { strategies: ['single'], includeControl: false },
    targetIds: ['M02'],
  });
  assert.equal(batch.candidates.length, 1, JSON.stringify(batch.rejectedAtGeneration));
  const candidate = batch.candidates[0];
  assert.equal(candidate.strategy, 'single');
  assert.deepEqual(candidate.artifact.source.modules.map(m => m.id), ['M02']);
  assert.equal(candidate.probe.probeErrors, 0);
  assert.equal(candidate.probe.changedModules.includes('M02'), true);
  const texts = moduleTextsFromArtifact(candidate.artifact);
  assert.ok(texts.M02.includes('1.04'));
  assert.deepEqual(DEFAULT_STRATEGIES, ['single', 'pair', 'multi', 'crossover', 'ablation']);
});

test('生成器：pair 候选支持代码 + 参数联合变异', { timeout: 240_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, () => {
  const batch = generateMultiModuleBatch({
    count: 1,
    round: 1,
    seed: 21,
    experiment,
    moduleConfig: { strategies: ['pair'], includeControl: false, parameterMutationRate: 1 },
    targetIds: ['M01', 'M02'],
  });
  assert.equal(batch.candidates.length, 1, JSON.stringify(batch.rejectedAtGeneration));
  const candidate = batch.candidates[0];
  assert.equal(candidate.strategy, 'pair');
  assert.ok(candidate.parameterMutation, '联合变异必须记录参数变异');
  assert.ok(candidate.artifact.source.modules.length >= 2);
  const champion = JSON.parse(readFileSync(
    resolve(import.meta.dirname, '../../champions/champion.json'), 'utf8')).parameters;
  assert.notEqual(
    candidate.artifact.parameters.values[candidate.parameterMutation.key],
    champion[candidate.parameterMutation.key],
    '参数变异必须进入 artifact 参数身份',
  );
});

test('生成器：control 候选必须是官方模块且策略显式标记', { timeout: 240_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true);
  const batch = generateMultiModuleBatch({
    count: 1,
    round: 1,
    seed: 12,
    experiment,
    moduleConfig: { strategies: ['single'], includeControl: true },
    targetIds: ['M02', 'M05'],
  });
  assert.ok(batch.candidates.length >= 1);
  const control = batch.candidates.find(c => c.strategy === 'control');
  assert.ok(control, '缺少 control 候选');
  assert.equal(control.probe.identicalToOfficial, true);
});
