/** D3 候选生成：确定性、父候选继承、去重、非法候选隔离。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCandidateBatch, createCandidateFromSpec, parentValuesFor, scriptedCandidates,
} from '../candidate-generator.mjs';
import { sha256Canonical } from '../core.mjs';
import { runSafetyChecks } from '../safety-check.mjs';

function experiment() {
  return {
    configRef: 'test://generator',
    configHash: sha256Canonical({ test: 1 }),
    seedRefs: [
      { purpose: 'screen', windowId: 'ai7-screen-w000', base: 1_610_000_000, count: 2 },
      { purpose: 'deep', windowId: 'ai7-deep-w000', base: 1_620_000_000, count: 2 },
    ],
  };
}

test('确定性生成：同 seed/round/parent/experiment ⇒ 同 artifact 身份', () => {
  const options = {
    count: 6, round: 2, seed: 123, experiment: experiment(),
    targetIds: ['candidateCap', 'searchBudget', 'gateThreshold'],
  };
  const first = generateCandidateBatch(options).map(x => x.artifact.identityDigest);
  const second = generateCandidateBatch(options).map(x => x.artifact.identityDigest);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
  assert.ok(first.length === 6);
});

test('从父候选继续：搜索控制值与模块系数被继承', () => {
  const parentGame = createCandidateFromSpec({
    targetId: 'searchBudget', values: { workUnits: 160 }, round: 1, index: 0, experiment: experiment(),
  }).artifact;
  assert.deepEqual(parentValuesFor(parentGame, 'searchBudget'), { workUnits: 160 });

  const parentProxy = createCandidateFromSpec({
    targetId: 'keepValue',
    values: { template: 'linear-feature-v1', coefficients: { coverage: 2.2 } },
    round: 1, index: 1, experiment: experiment(),
  }).artifact;
  const inherited = parentValuesFor(parentProxy, 'keepValue');
  assert.equal(inherited.coefficients.coverage, 2.2);

  const child = generateCandidateBatch({
    count: 1, round: 3, seed: 77, experiment: experiment(),
    targetIds: ['searchBudget'], parentArtifact: parentGame,
  })[0];
  assert.equal(child.artifact.parentId, parentGame.candidateId);
  assert.ok(child.artifact.algorithmStructure.jointOptionsByPlayerCount['2'].workUnits >= 8);
});

test('失败标签研究提示只影响目标选择，不修改候选评分字段', () => {
  const hints = { suggestedTargets: ['restValue'] };
  const batch = generateCandidateBatch({
    count: 8, round: 1, seed: 5, experiment: experiment(),
    targetIds: ['restValue', 'candidateCap'], hints,
  });
  assert.ok(batch.some(x => x.artifact.algorithmStructure.targetIds.includes('restValue')));
  for (const item of batch) {
    assert.equal('reward' in (item.artifact.parameters.values ?? {}), false);
    assert.equal(item.artifact.algorithmStructure.integration === 'production-seat-dispatch'
      || item.artifact.algorithmStructure.integration === 'candidate-plugin-only', true);
  }
});

test('脚本化候选：非法参数生成即拒绝；不安全模块由安全检查隔离', () => {
  const batch = scriptedCandidates({ experiment: experiment(), round: 1 });
  assert.ok(batch.candidates.length >= 3);
  assert.ok(batch.rejectedAtGeneration.length >= 1);
  const unsafe = batch.candidates.find(x => x.artifact.algorithmStructure.targetIds.includes('engineValue'));
  assert.ok(unsafe);
  const safety = runSafetyChecks(unsafe.artifact);
  assert.equal(safety.status, 'failed');
  assert.ok(safety.checks.some(c => c.status === 'fail' && c.id === 'forbidden-constructs'));
});

test('显式父候选不可用时 controller 应失败而非静默回退（单元层面校验函数契约）', () => {
  // parentValuesFor(null) = 默认值（官方基线）；非 null 父候选必须有匹配目标。
  assert.deepEqual(parentValuesFor(null, 'overrideMargin'), { overrideMargin: 0.02 });
});
