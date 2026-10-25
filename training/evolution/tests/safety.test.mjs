/** D2/D4 安全门禁：重封印 artifact 也必须按目标边界 fail-closed。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateFromSpec } from '../candidate-generator.mjs';
import {
  buildGameCandidatePieces, buildProxyCandidatePieces,
} from '../evolution-targets.mjs';
import { createCandidateArtifact } from '../candidate-artifact.mjs';
import { runSafetyChecks } from '../safety-check.mjs';
import { sha256Canonical, gameRulesDescriptor } from '../core.mjs';

function experiment() {
  return {
    configRef: 'test://safety',
    configHash: sha256Canonical({ test: 'safety' }),
    seedRefs: [
      { purpose: 'screen', windowId: 'ai7-screen-w000', base: 1_610_000_000, count: 2 },
      { purpose: 'deep', windowId: 'ai7-deep-w000', base: 1_620_000_000, count: 2 },
    ],
  };
}

function safetyStatus(artifact, checkId) {
  const result = runSafetyChecks(artifact);
  return result.checks.find(c => c.id === checkId)?.status;
}

/** 绕过生成器、手工重封印的 game artifact：模拟不可信来源直接注册。 */
function rawGameArtifact({ targetId, values, candidateId, mutateStructure = null, mutateParameters = null }) {
  const pieces = buildGameCandidatePieces({ targetId, values, candidateId });
  const algorithmStructure = JSON.parse(JSON.stringify(pieces.algorithmStructure));
  const parameters = JSON.parse(JSON.stringify(pieces.parameters));
  mutateStructure?.(algorithmStructure);
  mutateParameters?.(parameters);
  return createCandidateArtifact({
    candidateId,
    parentId: null,
    algorithmStructure,
    parameters: { id: candidateId, version: 1, values: parameters },
    source: { kind: 'descriptor' },
    experiment: experiment(),
    applicablePlayerCounts: pieces.applicablePlayerCounts,
    gameRules: gameRulesDescriptor(),
  });
}

/** 绕过生成器、手工重封印的 proxy artifact。 */
function rawProxyArtifact({ targetId, spec, candidateId, mutateValues }) {
  const pieces = buildProxyCandidatePieces({ targetId, spec, candidateId });
  const values = JSON.parse(JSON.stringify(pieces.parameters.values));
  mutateValues?.(values);
  return createCandidateArtifact({
    candidateId,
    parentId: null,
    algorithmStructure: pieces.algorithmStructure,
    parameters: { id: candidateId, version: 1, values },
    source: {
      kind: 'declarative-module',
      entry: 'module.json',
      files: [{ path: 'module.json', content: JSON.stringify(values) }],
    },
    experiment: experiment(),
    applicablePlayerCounts: pieces.applicablePlayerCounts,
    gameRules: gameRulesDescriptor(),
  });
}

test('合法候选（含 playerCountScope）全部通过安全检查', () => {
  const candidates = [
    createCandidateFromSpec({
      targetId: 'candidateCap', values: { candidateCap: 5 },
      round: 1, index: 0, experiment: experiment(),
    }).artifact,
    createCandidateFromSpec({
      targetId: 'playerCountScope', values: { playerCounts: [2, 5] },
      round: 1, index: 1, experiment: experiment(),
    }).artifact,
    createCandidateFromSpec({
      targetId: 'acquisitionValue',
      values: { template: 'linear-feature-v1', coefficients: { goalFit: 2.2 } },
      round: 1, index: 2, experiment: experiment(),
    }).artifact,
  ];
  for (const artifact of candidates) {
    const result = runSafetyChecks(artifact);
    assert.equal(result.status, 'passed', `${artifact.candidateId}: ${JSON.stringify(result.checks.filter(c => c.status === 'fail'))}`);
  }
});

test('分人数联合选项越界（candidateCap/工作预算）被安全门禁拒绝', () => {
  const cap = rawGameArtifact({
    targetId: 'candidateCap', values: { candidateCap: 4 }, candidateId: 'cand-ai7-safety-cap',
    mutateStructure: structure => {
      for (const n of ['2', '3', '4', '5']) structure.jointOptionsByPlayerCount[n].candidateCap = 99;
    },
  });
  assert.equal(safetyStatus(cap, 'parameter-bounds'), 'fail');

  const budget = rawGameArtifact({
    targetId: 'searchBudget', values: { workUnits: 32 }, candidateId: 'cand-ai7-safety-budget',
    mutateStructure: structure => {
      for (const n of ['2', '3', '4', '5']) structure.jointOptionsByPlayerCount[n].workUnits = 4;
    },
  });
  assert.equal(safetyStatus(budget, 'parameter-bounds'), 'fail');

  const unknown = rawGameArtifact({
    targetId: 'overrideMargin', values: { overrideMargin: 0.02 }, candidateId: 'cand-ai7-safety-unknown',
    mutateStructure: structure => {
      for (const n of ['2', '3', '4', '5']) structure.jointOptionsByPlayerCount[n].engineRewrite = 1;
    },
  });
  assert.equal(safetyStatus(unknown, 'parameter-bounds'), 'fail');
});

test('模块系数/未声明字段越界被安全门禁拒绝', () => {
  const artifact = rawProxyArtifact({
    targetId: 'acquisitionValue', spec: { coefficients: { goalFit: 2 } },
    candidateId: 'cand-ai7-safety-module',
    mutateValues: values => { values.coefficients.goalFit = 99; },
  });
  assert.equal(safetyStatus(artifact, 'parameter-bounds'), 'fail');

  const unknown = rawProxyArtifact({
    targetId: 'acquisitionValue', spec: { coefficients: { goalFit: 2 } },
    candidateId: 'cand-ai7-safety-module-key',
    mutateValues: values => { values.coefficients.notAFeature = 1; },
  });
  assert.equal(safetyStatus(unknown, 'parameter-bounds'), 'fail');
});

test('非法冠军权重被正式参数校验器拒绝', () => {
  const artifact = rawGameArtifact({
    targetId: 'gateThreshold', values: { contestThreshold: 0.9 }, candidateId: 'cand-ai7-safety-weight',
    mutateParameters: parameters => { parameters.engineWeight = 999; },
  });
  assert.equal(safetyStatus(artifact, 'parameter-bounds'), 'fail');
});
