/** 对抗性联赛测试：联赛框架（对局循环 / 赛程 / 座位轮换 / 胜率矩阵 / 端到端冒烟）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  playLeagueGame, planMatrix, matchSeats, runPlan, buildWinRateMatrix, summarizeLeague,
} from '../adversarial/league.mjs';
import { buildRegistry, toSeatVersion } from '../adversarial/registry.mjs';
import { AI6_LEAGUE_DEV_SUBBLOCK } from '../../ai5/lib/seed_policy.mjs';

const DEV = AI6_LEAGUE_DEV_SUBBLOCK; // [1.4e9, 1.401e9) 开发/审计探针块
const FAST = { workUnits: 64 }; // 确定性快档（冒烟/测试专用）

test('matchSeats：焦点席位随 seedIndex 轮转覆盖全部座位', () => {
  const reg = buildRegistry({ jointOptions: null });
  const focus = toSeatVersion(reg.versions['style-rush']);
  const opponent = toSeatVersion(reg.versions['style-balanced']);
  const covered = new Set();
  for (let i = 0; i < 10; i++) {
    const { focusSeat, seatVersions } = matchSeats(focus, opponent, 5, i);
    covered.add(focusSeat);
    assert.equal(seatVersions[focusSeat].id, 'style-rush');
    for (let s = 0; s < 5; s++) {
      if (s !== focusSeat) assert.equal(seatVersions[s].id, 'style-balanced');
    }
  }
  assert.equal(covered.size, 5, '10 个 seedIndex 必须覆盖全部 5 个座位');
});

test('playLeagueGame：2 人局冒烟（js5 快档 vs 风格），终局与遥测完备', () => {
  const reg = buildRegistry({ jointOptions: null });
  const result = playLeagueGame({
    seed: DEV[0] + 1, seatCount: 2,
    seatVersions: [toSeatVersion(reg.versions['js5-frozen-champion']), toSeatVersion(reg.versions['style-rush'])],
    jointOverrides: FAST,
  });
  assert.equal(result.status, 'finished');
  assert.equal(result.winnerSeat !== null, true);
  assert.equal(result.ranking.length, 2);
  assert.ok(result.moves > 0);
  assert.equal(result.fingerprints.length, 2);
  assert.deepEqual(result.versions, ['js5-frozen-champion', 'style-rush']);
  for (const counts of result.actionCounts) {
    const total = Object.values(counts).reduce((s, x) => s + x, 0);
    assert.ok(total > 0);
  }
});

test('playLeagueGame：随机合法核心席位注入（三核心混战 3 人局）', () => {
  const reg = buildRegistry({ jointOptions: null });
  const result = playLeagueGame({
    seed: DEV[0] + 2, seatCount: 3,
    seatVersions: [
      toSeatVersion(reg.versions['random-legal']),
      toSeatVersion(reg.versions['style-engine']),
      toSeatVersion(reg.versions['ai5-readiness-efficiency']),
    ],
    jointOverrides: FAST,
  });
  assert.equal(result.status, 'finished');
  assert.deepEqual(result.versions, ['random-legal', 'style-engine', 'ai5-readiness-efficiency']);
});

test('playLeagueGame：参数校验（seatCount 越界 / seatVersions 长度不符）', () => {
  const reg = buildRegistry({ jointOptions: null });
  const v = toSeatVersion(reg.versions['neutral-baseline']);
  assert.throws(() => playLeagueGame({ seed: 1, seatCount: 6, seatVersions: [v, v, v, v, v, v] }), /seatCount/);
  assert.throws(() => playLeagueGame({ seed: 1, seatCount: 2, seatVersions: [v] }), /seatVersions/);
  assert.throws(() => playLeagueGame({ seed: -1, seatCount: 2, seatVersions: [v, v] }), /seed/);
});

test('planMatrix：2p 头对头单场、≥3p 双向场、种子场间不重叠、越块抛错', () => {
  const plan2 = planMatrix({
    versionIds: ['style-rush', 'style-balanced'], seatCounts: [2],
    seedsPerPair: 4, seedBase: DEV[0], block: DEV,
  });
  assert.equal(plan2.matches.length, 1);
  assert.equal(plan2.matches[0].direction, 'h2h');
  assert.deepEqual(plan2.matches[0].seeds, [DEV[0], DEV[0] + 1, DEV[0] + 2, DEV[0] + 3]);
  assert.equal(plan2.seedEnd, DEV[0] + 4);

  const plan5 = planMatrix({
    versionIds: ['style-rush', 'style-balanced'], seatCounts: [5],
    seedsPerPair: 3, seedBase: DEV[0] + 10, block: DEV,
  });
  assert.equal(plan5.matches.length, 2, '5 人局每个无序对必须有双向场');
  assert.deepEqual(plan5.matches.map(m => m.direction), ['field', 'field']);
  const seeds = plan5.matches.flatMap(m => m.seeds);
  assert.equal(new Set(seeds).size, seeds.length, '场间种子不得重叠');

  assert.throws(() => planMatrix({
    versionIds: ['style-rush', 'style-balanced'], seatCounts: [2],
    seedsPerPair: DEV[1] - DEV[0] + 1, seedBase: DEV[0], block: DEV,
  }), /越界/);
  assert.throws(() => planMatrix({
    versionIds: ['a', 'a'], seatCounts: [2], seedsPerPair: 1, seedBase: DEV[0], block: DEV,
  }), /互不重复/);
  assert.throws(() => planMatrix({
    versionIds: ['a', 'b'], seatCounts: [6], seedsPerPair: 1, seedBase: DEV[0], block: DEV,
  }), /seatCount/);
});

test('buildWinRateMatrix：异常局绝不计入；2p 头对头双向互补计数', () => {
  const plan = planMatrix({
    versionIds: ['A', 'B'], seatCounts: [2], seedsPerPair: 4,
    seedBase: 100, block: [100, 200],
  });
  const games = [
    { matchId: 'A--vs--B@2', direction: 'h2h', focusId: 'A', opponentId: 'B', focusSeat: 0, status: 'finished', seatCount: 2, winnerSeat: 0 },
    { matchId: 'A--vs--B@2', direction: 'h2h', focusId: 'A', opponentId: 'B', focusSeat: 1, status: 'finished', seatCount: 2, winnerSeat: 1 },
    { matchId: 'A--vs--B@2', direction: 'h2h', focusId: 'A', opponentId: 'B', focusSeat: 0, status: 'finished', seatCount: 2, winnerSeat: 1 },
    { matchId: 'A--vs--B@2', direction: 'h2h', focusId: 'A', opponentId: 'B', focusSeat: 1, status: 'anomaly', reason: 'x', winnerSeat: null },
  ];
  const matrix = buildWinRateMatrix(plan, games);
  // A 焦点 3 finished：A 胜 2（seed0 座0、seed1 座1 时 winner=focus）
  assert.equal(matrix.A.B.games, 3);
  assert.equal(matrix.A.B.wins, 2);
  // 互补：B 视角 wins = 3 - 2 = 1
  assert.equal(matrix.B.A.games, 3);
  assert.equal(matrix.B.A.wins, 1);
  // 异常局（第 4 局）未计入任何 cell
  assert.equal(matrix.A.B.games + matrix.B.A.games, 6);
  // 座位覆盖披露
  assert.deepEqual(Object.keys(matrix.A.B.bySeat).sort(), ['0', '1']);
});

test('buildWinRateMatrix：≥3p 有向场只计入焦点→对手方向', () => {
  const plan = planMatrix({
    versionIds: ['A', 'B'], seatCounts: [3], seedsPerPair: 2,
    seedBase: 100, block: [100, 200],
  });
  const games = [
    { matchId: 'A--vs--B@3', direction: 'field', focusId: 'A', opponentId: 'B', focusSeat: 0, status: 'finished', seatCount: 3, winnerSeat: 0 },
    { matchId: 'A--vs--B@3', direction: 'field', focusId: 'A', opponentId: 'B', focusSeat: 1, status: 'finished', seatCount: 3, winnerSeat: 2 },
    { matchId: 'B--vs--A@3', direction: 'field', focusId: 'B', opponentId: 'A', focusSeat: 0, status: 'finished', seatCount: 3, winnerSeat: 1 },
    { matchId: 'B--vs--A@3', direction: 'field', focusId: 'B', opponentId: 'A', focusSeat: 2, status: 'finished', seatCount: 3, winnerSeat: 2 },
  ];
  const matrix = buildWinRateMatrix(plan, games);
  assert.equal(matrix.A.B.wins, 1);
  assert.equal(matrix.B.A.wins, 1);
  assert.equal(matrix.A.B.games, 2);
  assert.equal(matrix.B.A.games, 2);
});

test('端到端冒烟：2+5 人、3 版本、快档——报告结构、指纹、异常记账、座位覆盖', () => {
  const reg = buildRegistry({ jointOptions: null });
  const plan = planMatrix({
    versionIds: ['js5-frozen-champion', 'style-rush', 'style-balanced'],
    seatCounts: [2, 5], seedsPerPair: 2, seedBase: DEV[0] + 100, block: DEV,
  });
  // 2p: C(3,2)=3 场 h2h；5p: C(3,2)×2=6 场 field
  assert.equal(plan.matches.length, 9);
  const games = runPlan(plan, reg, { jointOverrides: FAST });
  assert.equal(games.length, 18);
  const report = summarizeLeague({ plan, games, registry: reg, jointOverrides: FAST, note: '测试冒烟' });
  assert.equal(report.schema, 'century-adversarial-league-v1');
  assert.equal(report.totals.games, 18);
  assert.equal(report.totals.finished + report.totals.anomalies, 18);
  // 注册表快照全量披露（不可变版本指纹）
  assert.equal(Object.keys(report.registrySnapshot.versionFingerprints).length, 9);
  assert.match(report.registrySnapshot.registryFingerprint, /^[0-9a-f]{64}$/);
  assert.match(report.engineBundleSha256, /^[0-9a-f]{64}$/);
  // 全部对局逐席披露指纹，且与注册表一致
  for (const g of games) {
    for (let s = 0; s < g.fingerprints.length; s++) {
      const versionId = g.versions[s];
      assert.equal(g.fingerprints[s], reg.snapshot.versionFingerprints[versionId]);
    }
  }
  // 矩阵覆盖：3 版本两两方向全齐
  for (const a of ['js5-frozen-champion', 'style-rush', 'style-balanced']) {
    for (const b of ['js5-frozen-champion', 'style-rush', 'style-balanced']) {
      if (a === b) continue;
      const cell = report.matrix[a]?.[b];
      assert.ok(cell, `缺少矩阵单元 ${a}→${b}`);
      assert.ok(cell.games > 0);
      assert.ok(cell.firstPlaceRate >= 0 && cell.firstPlaceRate <= 1);
      assert.ok(cell.wilson, 'Wilson 区间必须披露');
    }
  }
  // 一级指标按场披露 + 座位轮换覆盖（快档下全部正常终局）
  for (const summary of report.matchSummaries) {
    if (summary.anomalies === 0 && summary.finished === summary.seeds) {
      assert.ok(summary.firstPlace, '正常场必须披露 firstPlace CI');
    }
  }
  // 异常局必须带原因（若存在）
  for (const g of games) {
    if (g.status !== 'finished') assert.ok(g.reason);
  }
});

test('summarizeLeague：合成异常场记账与 finished 分离', () => {
  const reg = buildRegistry({ jointOptions: null });
  const plan = planMatrix({
    versionIds: ['style-rush', 'style-balanced'], seatCounts: [2],
    seedsPerPair: 2, seedBase: 100, block: [100, 200],
  });
  const games = [
    { matchId: plan.matches[0].matchId, direction: 'h2h', focusId: 'style-rush', opponentId: 'style-balanced', focusSeat: 0, status: 'finished', seed: 100, seatCount: 2, winnerSeat: 0, moves: 10, wallMs: 1, versions: ['style-rush', 'style-balanced'], fingerprints: ['x', 'y'], ranking: [] },
    { matchId: plan.matches[0].matchId, direction: 'h2h', focusId: 'style-rush', opponentId: 'style-balanced', focusSeat: 1, status: 'anomaly', reason: '对局异常：测试注入', seed: 101, seatCount: 2, winnerSeat: null, moves: 0, wallMs: 0, versions: ['style-rush', 'style-balanced'], fingerprints: ['x', 'y'], ranking: [] },
  ];
  const report = summarizeLeague({ plan, games, registry: reg, jointOverrides: FAST });
  assert.equal(report.totals.anomalies, 1);
  assert.equal(report.totals.finished, 1);
  assert.equal(report.totals.anomalyRate, 0.5);
  assert.deepEqual(report.totals.anomalyReasons, [['对局异常：测试注入', 1]]);
});
