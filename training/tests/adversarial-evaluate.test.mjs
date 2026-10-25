/** 对抗性联赛测试：防过拟合双轴评估与强对手筛选。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry } from '../adversarial/registry.mjs';
import { registerCandidates, exampleCandidateSpecs } from '../adversarial/candidate.mjs';
import { evaluateCandidate, selectStrongOpponents, GENERALITY_POOL } from '../adversarial/evaluate.mjs';
import { AI6_LEAGUE_DEV_SUBBLOCK } from '../../ai5/lib/seed_policy.mjs';

const DEV = AI6_LEAGUE_DEV_SUBBLOCK;
const FAST = { workUnits: 64 };

test('GENERALITY_POOL：不含冻结冠军本体（轴 A 的职责），含风格族与历史冠军', () => {
  assert.ok(!GENERALITY_POOL.includes('js5-frozen-champion'));
  for (const expected of ['style-rush', 'style-engine', 'style-contest', 'style-balanced', 'ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'neutral-baseline']) {
    assert.ok(GENERALITY_POOL.includes(expected));
  }
});

test('evaluateCandidate：双轴分离、轴 A 对冠军 / 轴 G 对泛化池、种子分区不重叠', () => {
  const evalReg = registerCandidates(buildRegistry({ jointOptions: null }), exampleCandidateSpecs());
  const seedsPerCell = 3;
  const seatCounts = [2];
  const axisAGames = seatCounts.reduce((s, n) => s + (n === 2 ? 1 : 2), 0) * seedsPerCell;
  const evaluation = evaluateCandidate({
    registry: evalReg, candidateId: 'cand-rush-plus', seatCounts, seedsPerCell,
    axisASeedBase: DEV[0], axisGSeedBase: DEV[0] + axisAGames, block: DEV,
    jointOverrides: FAST,
  });
  assert.equal(evaluation.candidateId, 'cand-rush-plus');
  assert.match(evaluation.fingerprint, /^[0-9a-f]{64}$/);
  // 轴 A：头对头 vs js5-frozen-champion
  assert.equal(evaluation.axisA.totalGames, 3);
  assert.equal(evaluation.axisA.anomalies, 0);
  assert.equal(evaluation.axisA.cells.length, 1);
  assert.equal(evaluation.axisA.cells[0].direction, 'h2h');
  for (const g of evaluation.axisAGames) {
    assert.ok(g.versions.includes('js5-frozen-champion'), '轴 A 每局必须包含冻结冠军');
    assert.ok(g.versions.includes('cand-rush-plus'));
  }
  // 轴 G：对泛化池（无冠军席位）
  assert.equal(evaluation.axisG.totalGames, 3);
  for (const g of evaluation.axisGGames) {
    assert.equal(g.opponentId, 'generality-pool');
    assert.ok(!g.versions.includes('js5-frozen-champion'), '轴 G 绝不允许冠军席位（防口径合并）');
    assert.equal(g.versions[g.focusSeat], 'cand-rush-plus');
  }
  // 轴 G 的对手来自泛化池
  const seenOpponents = new Set(evaluation.axisGGames.flatMap(g => g.versions.filter(v => v !== 'cand-rush-plus')));
  for (const opponent of seenOpponents) assert.ok(GENERALITY_POOL.includes(opponent), `轴 G 对手 ${opponent} 必须来自泛化池`);
  // 种子分区：轴 A 与轴 G 种子零交集
  const axisASeeds = new Set(evaluation.axisAGames.map(g => g.seed));
  const axisGSeeds = new Set(evaluation.axisGGames.map(g => g.seed));
  for (const seed of axisGSeeds) assert.ok(!axisASeeds.has(seed), `轴 G 种子 ${seed} 与轴 A 重叠`);
  // 轴 A 汇总披露 Wilson 与座位覆盖
  assert.ok(evaluation.axisA.cells[0].wilson);
  assert.match(evaluation.axisA.cells[0].seatCoverage, /^[0-9](\+[0-9])*$/);
});

test('evaluateCandidate：轴 A + 轴 G 双人数单元（5p 有向场双方向）', () => {
  const evalReg = registerCandidates(buildRegistry({ jointOptions: null }), exampleCandidateSpecs());
  const seedsPerCell = 2;
  const seatCounts = [2, 5];
  const axisAGames = seatCounts.reduce((s, n) => s + (n === 2 ? 1 : 2), 0) * seedsPerCell;
  const evaluation = evaluateCandidate({
    registry: evalReg, candidateId: 'cand-rush-plus', seatCounts, seedsPerCell,
    axisASeedBase: DEV[0] + 50, axisGSeedBase: DEV[0] + 50 + axisAGames, block: DEV,
    jointOverrides: FAST,
  });
  // 5p 轴 A：cand vs 冠军场 + 冠军 vs cand 场（双方向独立对局）
  const directions5p = evaluation.axisA.cells.filter(c => c.seatCount === 5).map(c => c.direction);
  assert.deepEqual(directions5p, ['field', 'field']);
  const focuses = evaluation.axisA.cells.filter(c => c.seatCount === 5).map(c => (c.firstPlaceRate !== null ? 'ok' : 'null'));
  assert.equal(focuses.length, 2);
  // 轴 G 5p 单元存在
  assert.ok(evaluation.axisG.cells.some(c => c.seatCount === 5));
  // 未注册候选拒绝
  assert.throws(() => evaluateCandidate({
    registry: evalReg, candidateId: 'ghost', seatCounts: [2], seedsPerCell: 1,
    axisASeedBase: DEV[0], axisGSeedBase: DEV[0], block: DEV,
  }), /候选未注册/);
});

test('selectStrongOpponents：四档判定逻辑（strong / specialist / weak-vs-champion / reject）', () => {
  const mkEval = ({ axisALower, axisARate, axisGLowerMin, axisGDiffMin }) => ({
    candidateId: 'cand-x',
    fingerprint: '0'.repeat(64),
    axisA: {
      cells: [{ seatCount: 2, direction: 'h2h', games: 10, wins: Math.round(axisARate * 10), firstPlaceRate: axisARate, wilson: { lower: axisALower, upper: 1, point: axisARate }, seatCoverage: '0+1' }],
      anomalies: 0, totalGames: 10,
    },
    axisG: {
      cells: [{ seatCount: 5, games: 10, wins: 5, firstPlaceRate: 0.5, wilson: { lower: axisGLowerMin, upper: 1, point: 0.5 }, meanScore: 30, meanOpponentScore: 30 - axisGDiffMin, scoreDiff: axisGDiffMin }],
      anomalies: 0, totalGames: 10,
    },
  });
  const selection = selectStrongOpponents([
    mkEval({ axisALower: 0.62, axisARate: 0.7, axisGLowerMin: 0.3, axisGDiffMin: 2 }),   // 双门槛达标
    mkEval({ axisALower: 0.55, axisARate: 0.6, axisGLowerMin: 0.05, axisGDiffMin: -8 }), // 只过轴 A
    mkEval({ axisALower: 0.2, axisARate: 0.3, axisGLowerMin: 0.4, axisGDiffMin: 3 }),    // 只过轴 G
    mkEval({ axisALower: 0.1, axisARate: 0.2, axisGLowerMin: 0.05, axisGDiffMin: -9 }),  // 全不过
  ]);
  assert.equal(selection.all.length, 4);
  assert.deepEqual(selection.all.map(r => r.verdict), ['strong', 'specialist', 'weak-vs-champion', 'reject']);
  assert.equal(selection.strongOpponents.length, 1);
  assert.equal(selection.strongOpponents[0].candidateId, 'cand-x');
  assert.deepEqual(selection.strongOpponents[0].fingerprint, '0'.repeat(64));
  // 排序：按轴 A 点估计降序
  const rates = selection.all.map(r => r.axisA.firstPlaceRate);
  assert.deepEqual(rates, [...rates].sort((a, b) => b - a));
  // 门槛可配置：收紧轴 A 下界到 0.7 → 原 strong（0.62 下界）不再过轴 A，
  // 但轴 G 仍达标 → 判定降级为 weak-vs-champion（轴 G 通过、轴 A 未过）。
  const strict = selectStrongOpponents([mkEval({ axisALower: 0.62, axisARate: 0.7, axisGLowerMin: 0.3, axisGDiffMin: 2 })], { minAxisALower: 0.7 });
  assert.equal(strict.strongOpponents.length, 0);
  assert.equal(strict.all[0].verdict, 'weak-vs-champion');
});

test('selectStrongOpponents：标准化版本描述符输出（第六阶段可消费）', () => {
  const evalReg = registerCandidates(buildRegistry({ jointOptions: null }), exampleCandidateSpecs());
  const selection = selectStrongOpponents([{
    candidateId: 'cand-rush-plus',
    fingerprint: evalReg.versions['cand-rush-plus'].fingerprint,
    axisA: { cells: [{ seatCount: 2, direction: 'h2h', games: 10, wins: 7, firstPlaceRate: 0.7, wilson: { lower: 0.55, upper: 0.82, point: 0.7 }, seatCoverage: '0+1' }], anomalies: 0, totalGames: 10 },
    axisG: { cells: [{ seatCount: 5, games: 10, wins: 6, firstPlaceRate: 0.6, wilson: { lower: 0.31, upper: 0.83, point: 0.6 }, meanScore: 32, meanOpponentScore: 30, scoreDiff: 2 }], anomalies: 0, totalGames: 10 },
  }]);
  assert.equal(selection.schema, 'century-adversarial-strong-opponents-v2');
  const strong = selection.strongOpponents[0];
  // 指纹 = 注册表版本指纹（消费方可直接用 run-league --versions 注入复现）
  assert.equal(strong.fingerprint, evalReg.snapshot.versionFingerprints['cand-rush-plus']);
  assert.ok(evalReg.versions[strong.candidateId].parameters, '描述符必须可直接物化为席位版本');
});
