/** 对抗性联赛测试：候选生成接口（spec 校验 / 确定性物化 / 注册隔离）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCandidateSpec, materializeCandidate, registerCandidates,
  exampleCandidateSpecs, candidateFromParameters, CANDIDATE_SCHEMA,
} from '../adversarial/candidate.mjs';
import { buildRegistry } from '../adversarial/registry.mjs';

const reg = buildRegistry({ jointOptions: null });

test('spec 校验：schema/id/变异轴/核心约束全量拒绝路径', () => {
  const base = { schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'style-rush', mutations: { tempoWeight: 1.2 } };
  assert.ok(validateCandidateSpec(base));
  assert.throws(() => validateCandidateSpec({ ...base, schema: 'wrong' }), /schema/);
  assert.throws(() => validateCandidateSpec({ ...base, id: 'no-prefix' }), /cand-/);
  assert.throws(() => validateCandidateSpec({ ...base, id: 'cand-' }), /cand-/);
  assert.throws(() => validateCandidateSpec({ ...base, decisionCore: 'random-legal' }), /random-legal/);
  assert.throws(() => validateCandidateSpec({
    schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'style-rush',
    decisionCore: 'champion-guided', mutations: { tempoWeight: 1.2 },
  }), /mutations 仅适用于 beam-search/);
  assert.throws(() => validateCandidateSpec({
    schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'style-rush',
    decisionCore: 'beam-search', jointOptions: { workUnits: 64 },
  }), /jointOptions 仅适用于 champion-guided/);
  assert.throws(() => validateCandidateSpec({ schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'style-rush' }), /至少一个变异轴/);
  assert.throws(() => validateCandidateSpec({
    schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'style-rush',
    mutations: { adapter: 'champion-guided' },
  }), /未知权重参数/);
  assert.throws(() => validateCandidateSpec({
    schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'style-rush', decisionCore: 'beam-search',
    parameters: { id: 'y', adapter: 'champion-guided' },
  }), /非法携带 adapter/);
  assert.throws(() => validateCandidateSpec({
    schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'custom', decisionCore: 'beam-search',
  }), /base=custom 必须提供完整 parameters/);
});

test('物化：束搜索候选 strip-adapter + 权重合并，同 spec 同指纹', () => {
  const spec = {
    schema: CANDIDATE_SCHEMA, id: 'cand-rush-plus', base: 'style-rush',
    decisionCore: 'beam-search', mutations: { tempoWeight: 1.8, restWeight: 0.4 },
  };
  const d1 = materializeCandidate(spec, reg);
  const d2 = materializeCandidate(spec, reg);
  assert.equal(d1.fingerprint, d2.fingerprint, '物化必须确定性（纯函数）');
  assert.equal(d1.parameters.tempoWeight, 1.8);
  assert.equal(d1.parameters.restWeight, 0.4);
  assert.equal(d1.parameters.adapter, undefined, '候选不得携带 adapter');
  assert.equal(d1.parameters.structure, 'beam-rollout', '继承基座结构');
  assert.equal(d1.parameters.acquisitionVariant, 'readiness-efficiency', '继承基座血统');
  assert.match(d1.lineage.derivedFrom, /style-rush/);
  // 基座指纹披露在血统溯源中
  assert.ok(d1.lineage.derivedFrom.includes(reg.versions['style-rush'].fingerprint.slice(0, 12)));
});

test('物化：冠军引导候选（JS5 基座 + jointOptions 轴）', () => {
  const d = materializeCandidate({
    schema: CANDIDATE_SCHEMA, id: 'cand-js5-fast-gate', base: 'js5-frozen-champion',
    decisionCore: 'champion-guided', jointOptions: { workUnits: 96 },
  }, reg);
  assert.equal(d.decisionCore, 'champion-guided');
  assert.equal(d.parameters.adapter, 'champion-guided');
  assert.equal(d.parameters.jointVersion, 'joint-js5');
  assert.deepEqual(d.jointOptions, { workUnits: 96 });
  // 指纹覆盖 jointOptions：不同 workUnits → 不同指纹
  const d2 = materializeCandidate({
    schema: CANDIDATE_SCHEMA, id: 'cand-js5-fast-gate', base: 'js5-frozen-champion',
    decisionCore: 'champion-guided', jointOptions: { workUnits: 128 },
  }, reg);
  assert.notEqual(d.fingerprint, d2.fingerprint);
});

test('物化：非适配器基座的冠军引导候选自动补显式 adapter 标记', () => {
  const d = materializeCandidate({
    schema: CANDIDATE_SCHEMA, id: 'cand-joint-style', base: 'neutral-baseline',
    decisionCore: 'champion-guided', jointOptions: { budgetMs: 50 },
  }, reg);
  assert.equal(d.parameters.adapter, 'champion-guided');
  assert.equal(d.parameters.jointVersion, 'joint-js5');
});

test('物化：custom 基座 + 越界权重拒绝 + 未注册基座拒绝', () => {
  assert.throws(() => materializeCandidate({
    schema: CANDIDATE_SCHEMA, id: 'cand-custom', base: 'custom', decisionCore: 'beam-search',
    parameters: { id: 'cand-custom', tempoWeight: 1 }, mutations: { tempoWeight: 42 },
  }, reg), /越界/);
  assert.throws(() => materializeCandidate({
    schema: CANDIDATE_SCHEMA, id: 'cand-custom', base: 'custom', decisionCore: 'beam-search',
    parameters: { id: 'cand-custom', engineWeight: 1, tempoWeight: 1 }, // 缺 6 个权重
  }), /必须为/); // validateAIParameters 对缺失权重拒绝
  assert.throws(() => materializeCandidate({
    schema: CANDIDATE_SCHEMA, id: 'cand-x', base: 'not-registered', decisionCore: 'beam-search',
    mutations: { tempoWeight: 1.2 },
  }, reg), /候选基座未注册/);
});

test('registerCandidates：评估注册表隔离（不修改原注册表）+ id 冲突拒绝', () => {
  const specs = exampleCandidateSpecs();
  const evalReg = registerCandidates(reg, specs);
  assert.equal(Object.keys(evalReg.versions).length, Object.keys(reg.versions).length + specs.length);
  assert.equal(reg.versions['cand-rush-plus'], undefined, '原注册表不得被修改');
  assert.ok(evalReg.versions['cand-rush-plus']);
  assert.deepEqual(evalReg.snapshot.candidates, specs.map(s => s.id));
  assert.throws(() => registerCandidates(reg, [...specs, specs[0]]), /冲突/);
  // 冻结
  assert.throws(() => { 'use strict'; evalReg.versions['cand-rush-plus'].parameters.tempoWeight = 9; }, TypeError);
});

test('candidateFromParameters：参数对象便利入口（含适配器参数自动分流）', () => {
  const beamSpec = candidateFromParameters('cand-from-params', {
    id: 'x', structure: 'beam-rollout', tempoWeight: 1.5,
    engineWeight: 1, contestWeight: 1, synergyWeight: 1, goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
  });
  assert.equal(beamSpec.decisionCore, 'beam-search');
  const jointSpec = candidateFromParameters('cand-from-params-joint', {
    id: 'y', adapter: 'champion-guided', jointVersion: 'joint-js5',
  });
  assert.equal(jointSpec.decisionCore, 'champion-guided');
  assert.equal(jointSpec.parameters.adapter, 'champion-guided');
});

test('示例候选全部可物化（文档化起点）', () => {
  const evalReg = registerCandidates(reg, exampleCandidateSpecs());
  for (const id of exampleCandidateSpecs().map(s => s.id)) {
    assert.ok(evalReg.versions[id], `示例候选 ${id} 必须可物化`);
  }
});
