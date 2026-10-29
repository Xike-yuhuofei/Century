/** P1.3 补充验收：最小失败改动定位（同父代/同种子层的模块观测效应）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeModuleEffects } from '../module-effects.mjs';

function candidate({ id, parentId = 'p1', modules, pairs }) {
  return {
    candidateId: id,
    parentId,
    lineage: { modulesChanged: modules, operator: 'llm' },
    quick: { score: { firstPlaceDelta: 0 } },
    __pairs: pairs,
  };
}

function pairsFor({ seeds, championFirst = 0, first }) {
  return seeds.map((seed, index) => ({
    seed,
    seatCount: 2 + (index % 4),
    candidateFirst: first,
    championFirst,
    status: 'finished',
  }));
}

function roundOf({ round, parentId = 'p1', members }) {
  return {
    round,
    candidates: members.map(member => candidate({ ...member, parentId })),
  };
}

const loadPairs = c => c.__pairs ?? null;

test('同层两侧差值：4 层稳定的模块得到 positive-association', () => {
  const rounds = [1, 2, 3, 4].map(round => roundOf({
    round,
    members: [
      { id: `r${round}-with-a`, modules: ['M05'], pairs: pairsFor({ seeds: [round * 10 + 1, round * 10 + 2], first: 1 }) },
      { id: `r${round}-with-b`, modules: ['M05'], pairs: pairsFor({ seeds: [round * 10 + 1, round * 10 + 2], first: 1 }) },
      { id: `r${round}-without-a`, modules: ['M02'], pairs: pairsFor({ seeds: [round * 10 + 1, round * 10 + 2], first: 0 }) },
      { id: `r${round}-without-b`, modules: ['M02'], pairs: pairsFor({ seeds: [round * 10 + 1, round * 10 + 2], first: 0 }) },
    ],
  }));
  const analysis = analyzeModuleEffects({ state: { rounds }, loadPairs, bootstrapIterations: 2000 });
  const effect = analysis.modules.find(m => m.moduleId === 'M05');
  assert.equal(effect.strata, 4);
  assert.equal(effect.seedComparisons, 8);
  assert.equal(effect.effect, 1);
  assert.equal(effect.direction, 'positive-association');
  assert.ok(effect.ci.lower > 0, '区间下界应大于 0');
});

test('少于 3 层：即使差值稳定也标 inconclusive', () => {
  const rounds = [1, 2].map(round => roundOf({
    round,
    members: [
      { id: `r${round}-with`, modules: ['M09'], pairs: pairsFor({ seeds: [round * 10 + 1, round * 10 + 2], first: 1 }) },
      { id: `r${round}-without`, modules: ['M01'], pairs: pairsFor({ seeds: [round * 10 + 1, round * 10 + 2], first: 0 }) },
    ],
  }));
  const analysis = analyzeModuleEffects({ state: { rounds }, loadPairs, bootstrapIterations: 2000 });
  const effect = analysis.modules.find(m => m.moduleId === 'M09');
  assert.equal(effect.strata, 2);
  assert.equal(effect.direction, 'inconclusive');
});

test('同一种子 championFirst 不一致时剔除该种子；剩余不足 2 个种子则不给结论', () => {
  const rounds = [roundOf({
    round: 1,
    members: [
      { id: 'with', modules: ['M05'], pairs: [
        { seed: 1, seatCount: 2, candidateFirst: 1, championFirst: 0, status: 'finished' },
        { seed: 2, seatCount: 2, candidateFirst: 1, championFirst: 0, status: 'finished' },
      ] },
      { id: 'without', modules: ['M01'], pairs: [
        { seed: 1, seatCount: 2, candidateFirst: 0, championFirst: 1, status: 'finished' },
        { seed: 2, seatCount: 2, candidateFirst: 0, championFirst: 0, status: 'finished' },
      ] },
    ],
  })];
  const analysis = analyzeModuleEffects({ state: { rounds }, loadPairs, bootstrapIterations: 2000 });
  const effect = analysis.modules.find(m => m.moduleId === 'M05');
  assert.equal(effect.strata, 0);
  assert.equal(effect.direction, 'inconclusive');
});

test('单候选层（<2 个候选）不参与比较；control 候选（无 lineage）不计入', () => {
  const rounds = [roundOf({
    round: 1,
    members: [
      { id: 'only', modules: ['M04'], pairs: pairsFor({ seeds: [1, 2], first: 1 }) },
    ],
  }), {
    round: 2,
    candidates: [{
      candidateId: 'control',
      parentId: null,
      lineage: null,
      quick: { score: { firstPlaceDelta: 0 } },
      __pairs: pairsFor({ seeds: [3, 4], first: 1 }),
    }],
  }];
  const analysis = analyzeModuleEffects({ state: { rounds }, loadPairs, bootstrapIterations: 2000 });
  assert.equal(analysis.strata, 0);
  assert.deepEqual(analysis.modules, []);
});
