/** D2 多目标进化接口：边界、输入检查、隐藏信息拒绝、预算、回退、回归、搜索控制映射。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listTargets, getTarget, normalizeModuleSpec, normalizeSearchValues, assertTargetInput,
  evaluateModule, defaultTargetValues, targetRegression, buildGameCandidatePieces,
  buildProxyCandidatePieces, jointOptionsForPlayerCount,
} from '../evolution-targets.mjs';

const RESOURCE_TARGETS = ['acquisitionValue', 'engineValue', 'goalValue', 'keepValue', 'restValue'];
const SEARCH_TARGETS = ['gateThreshold', 'overrideMargin', 'candidateCap', 'searchBudget', 'searchBudgetAllocation', 'playerCountScope'];

test('两组目标全部注册且 evaluationMode 正确', () => {
  const targets = listTargets();
  for (const id of RESOURCE_TARGETS) {
    const target = getTarget(id);
    assert.equal(target.group, 'resource-strategy');
    assert.equal(target.kind, 'function-module');
    assert.equal(target.evaluationMode, 'proxy');
    assert.equal(target.integration, 'candidate-plugin-only');
    assert.equal(target.productionWiring.startsWith('not-wired'), true);
  }
  for (const id of SEARCH_TARGETS) {
    const target = getTarget(id);
    assert.equal(target.group, 'search-control');
    assert.equal(target.kind, 'parameter-vector');
    assert.equal(target.evaluationMode, 'game');
    assert.equal(target.fallback.strategy, 'frozen-champion-default');
  }
  assert.throws(() => getTarget('wholeEngineRewrite'), /未知进化目标/);
});

test('每个资源/策略目标有独立回归 fixture，默认/扰动结果有限且可复现', () => {
  for (const id of RESOURCE_TARGETS) {
    const rows = targetRegression(id);
    assert.ok(rows.length >= 2, `${id} 回归 fixture 不足`);
    for (const row of rows) {
      assert.equal(row.baseline.fallbackHit, false, `${id}/${row.name} 默认系数不应回退`);
      assert.equal(row.perturbed.fallbackHit, false, `${id}/${row.name} 扰动系数不应回退`);
      assert.equal(Number.isFinite(row.baseline.value), true);
      assert.equal(Number.isFinite(row.perturbed.value), true);
      const again = targetRegression(id).find(x => x.name === row.name);
      assert.equal(again.baseline.value, row.baseline.value);
    }
  }
});

test('模块参数类型/边界/未知字段检查', () => {
  assert.throws(() => normalizeModuleSpec('acquisitionValue', { coefficients: { notAFeature: 1 } }), /未知特征系数/);
  assert.throws(() => normalizeModuleSpec('acquisitionValue', { coefficients: { goalFit: 9 } }), /越界/);
  assert.throws(() => normalizeModuleSpec('acquisitionValue', { coefficients: { goalFit: Number.NaN } }), /有限数值/);
  assert.throws(() => normalizeModuleSpec('acquisitionValue', { bias: 9 }), /越界/);
  assert.throws(() => normalizeModuleSpec('acquisitionValue', { outputClamp: [0, 1] }), /不可由候选改写/);
  assert.throws(() => normalizeModuleSpec('acquisitionValue', { surprise: 1 }), /未声明字段/);
  const normalized = normalizeModuleSpec('goalValue', { coefficients: { goalFit: 1.5 }, bias: 0.1 });
  assert.equal(normalized.coefficients.goalFit, 1.5);
  assert.equal(normalized.coefficients.remainingCost, getTarget('goalValue').defaultCoefficients.remainingCost);
  assert.equal(normalized.schema, 'century-declarative-linear-module-v1');
});

test('隐藏信息与随机源被输入白名单/递归扫描拒绝', () => {
  const input = {
    stock: [1, 1, 1, 0], hand: ['M01'], played: [],
    cardId: 'M02', preferred: 'G02', profile: { engine: 1, contest: 1 },
    pressure: { mean: { M02: 0.4 }, peak: { M02: 0.7 } },
  };
  assert.equal(assertTargetInput('acquisitionValue', input), true);
  assert.throws(() => assertTargetInput('acquisitionValue', { ...input, merchantDeck: ['M01'] }), /隐藏信息/);
  assert.throws(() => assertTargetInput('acquisitionValue', { ...input, pressure: { seed: 1 } }), /隐藏信息/);
  assert.throws(() => assertTargetInput('acquisitionValue', { ...input, surprise: 1 }), /白名单/);
  const result = evaluateModule('acquisitionValue', { ...input, merchantDeck: ['M01'] }, defaultTargetValues('acquisitionValue'));
  assert.equal(result.fallbackHit, true);
  assert.match(result.fallbackReason, /隐藏信息/);
});

test('资源预算：超大输入触发回退而非抛出到控制面', () => {
  const input = {
    stock: [1, 1, 1, 0], hand: Array.from({ length: 2000 }, (_, i) => `M${i}`), played: [],
    cardId: 'M02', preferred: 'G02', profile: { engine: 1, contest: 1 }, pressure: { mean: {}, peak: {} },
  };
  const result = evaluateModule('acquisitionValue', input, defaultTargetValues('acquisitionValue'));
  assert.equal(result.fallbackHit, true);
  assert.match(result.fallbackReason, /超过预算|隐藏信息/);
});

test('搜索控制参数边界与整数约束', () => {
  assert.equal(normalizeSearchValues('candidateCap', { candidateCap: 5 }).candidateCap, 5);
  assert.throws(() => normalizeSearchValues('candidateCap', { candidateCap: 4.5 }), /整数/);
  assert.throws(() => normalizeSearchValues('candidateCap', { candidateCap: 99 }), /越界/);
  assert.throws(() => normalizeSearchValues('gateThreshold', { contestThreshold: 0.2 }), /越界/);
  assert.throws(() => normalizeSearchValues('overrideMargin', { unknown: 1 }), /未声明参数|缺少参数/);
  const allocation = normalizeSearchValues('searchBudgetAllocation', { 2: 32, 3: 64, 4: 96, 5: 128 });
  assert.deepEqual(allocation, { 2: 32, 3: 64, 4: 96, 5: 128 });
  const scope = normalizeSearchValues('playerCountScope', { playerCounts: [5, 3, 3] });
  assert.deepEqual(scope.playerCounts, [3, 5]);
  assert.throws(() => normalizeSearchValues('playerCountScope', { playerCounts: [6] }), /非法人数/);
});

test('搜索控制 → 分人数适配器选项（不改冠军代码/参数）', () => {
  const pieces = buildGameCandidatePieces({
    targetId: 'searchBudgetAllocation',
    values: { 2: 32, 3: 64, 4: 96, 5: 128 },
    candidateId: 'cand-ai7-alloc-test',
  });
  assert.equal(pieces.algorithmStructure.decisionCore, 'champion-guided');
  assert.equal(pieces.algorithmStructure.jointOptionsByPlayerCount['2'].workUnits, 32);
  assert.equal(pieces.algorithmStructure.jointOptionsByPlayerCount['5'].workUnits, 128);
  assert.equal(pieces.parameters.id, 'cand-ai7-alloc-test');
  assert.equal(pieces.parameters.adapter, 'champion-guided');
  assert.equal(pieces.parameters.jointVersion, 'joint-js5');

  const gate = buildGameCandidatePieces({ targetId: 'gateThreshold', values: { contestThreshold: 0.9 }, candidateId: 'cand-ai7-gate-test' });
  assert.equal(gate.algorithmStructure.jointOptionsByPlayerCount['3'].contestThreshold, 0.9);
  assert.equal(gate.algorithmStructure.jointOptionsByPlayerCount['3'].workUnits, 32);

  const scope = buildGameCandidatePieces({ targetId: 'playerCountScope', values: { playerCounts: [2, 5] }, candidateId: 'cand-ai7-scope-test' });
  assert.deepEqual(scope.applicablePlayerCounts, [2, 5]);
  assert.equal(scope.algorithmStructure.jointOptionsByPlayerCount['2'].workUnits, 32);
  assert.equal(scope.algorithmStructure.jointOptionsByPlayerCount['4'], undefined);

  assert.deepEqual(jointOptionsForPlayerCount('searchBudget', { workUnits: 40 }, 3), { workUnits: 40 });
});

test('声明模块候选结构：plugin-only、非生产接线、适用人数可限定', () => {
  const pieces = buildProxyCandidatePieces({
    targetId: 'keepValue',
    spec: { coefficients: { coverage: 2.5 } },
    candidateId: 'cand-ai7-keep-test',
    applicablePlayerCounts: [3, 5],
  });
  assert.equal(pieces.algorithmStructure.decisionCore, 'plugin-only');
  assert.equal(pieces.algorithmStructure.evaluationMode, 'proxy');
  assert.equal(pieces.algorithmStructure.integration, 'candidate-plugin-only');
  assert.deepEqual(pieces.applicablePlayerCounts, [3, 5]);
  assert.equal(pieces.source.kind, 'declarative-module');
  assert.equal(pieces.parameters.values.coefficients.coverage, 2.5);
});
