/** P0/P1 集成：真实引擎上的第一名率配对运行器（非测试替身）。
 *
 * 使用真实 web-v1 编译产物与真实 AI 决策；小样本仅为测试运行器语义，
 * 不作为任何棋力结论。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireBuiltEngine } from '../lib/paths.mjs';
import { buildRegistry } from '../adversarial/registry.mjs';
import { runFirstPlaceSeatChallenge, toSeatVersion } from '../tournament/first-place-challenge.mjs';

requireBuiltEngine();

function descriptors() {
  const registry = buildRegistry();
  const base = registry.versions['ai5-readiness-efficiency'].parameters;
  return {
    champion: { ...base, id: 'fp-test-champion' },
    candidate: { ...base, id: 'fp-test-candidate', tempoWeight: 1.05 },
    opponents: [
      { ...registry.versions['style-engine'].parameters, id: 'style-engine' },
      { ...registry.versions['neutral-baseline'].parameters, id: 'neutral-baseline' },
    ],
  };
}

test('第一名率配对运行器：A/B 同种子、同对手、焦点席位轮换，第一名由引擎唯一裁定', () => {
  const { champion, candidate, opponents } = descriptors();
  const result = runFirstPlaceSeatChallenge({
    champion, candidate, opponents,
    seeds: [1_500_000_001, 1_500_000_002, 1_500_000_003],
    seatCount: 3,
    maxMoves: 500,
    deadlineMs: 60_000,
  });
  assert.equal(result.pairs.length, 3);
  assert.equal(result.games.length, 6);
  for (const [index, pair] of result.pairs.entries()) {
    assert.equal(pair.seed, 1_500_000_001 + index);
    assert.equal(pair.focusSeat, index % 3, '焦点席位必须随 seedIndex 轮换');
    const armA = result.games.find(g => g.seed === pair.seed && g.arm === 'A');
    const armB = result.games.find(g => g.seed === pair.seed && g.arm === 'B');
    assert.ok(armA && armB);
    assert.equal(armA.focusSeat, pair.focusSeat);
    assert.equal(armB.focusSeat, pair.focusSeat);
    // 非焦点席位的对手在两个实验中完全一致。
    for (let seat = 0; seat < 3; seat++) {
      if (seat === pair.focusSeat) continue;
      assert.equal(armA.versions[seat], armB.versions[seat]);
    }
    if (armA.status === 'finished' && armB.status === 'finished') {
      assert.equal(typeof armA.firstPlace, 'boolean');
      assert.equal(typeof armB.firstPlace, 'boolean');
      const rankingSeats = armA.ranking.map(r => r.seat);
      assert.equal(new Set(rankingSeats).size, 3, '第一名必须唯一（无并列共享名次）');
      assert.equal(armA.firstPlace, armA.ranking[0].seat === pair.focusSeat);
    }
  }
});

test('第一名率配对运行器：同种子/同配置重复执行结果完全一致（确定性）', () => {
  const { champion, candidate, opponents } = descriptors();
  const options = {
    champion, candidate, opponents,
    seeds: [1_500_000_101, 1_500_000_102],
    seatCount: 2,
    maxMoves: 500,
    deadlineMs: 60_000,
  };
  const first = runFirstPlaceSeatChallenge(options);
  const second = runFirstPlaceSeatChallenge(options);
  const project = run => run.games.map(g => ({
    seed: g.seed, arm: g.arm, focusSeat: g.focusSeat, status: g.status,
    firstPlace: g.firstPlace, winnerSeat: g.winnerSeat,
    scores: g.ranking.map(r => r.score),
  }));
  assert.deepEqual(project(first), project(second));
});

test('席位版本：search-control 候选的联合搜索配置按人数注入', () => {
  const version = toSeatVersion({
    id: 'cand-joint',
    engineWeight: 1, tempoWeight: 1, contestWeight: 1, synergyWeight: 1,
    goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
    adapter: 'champion-guided', jointVersion: 'joint-js5', budgetMs: 100,
    jointOptionsByPlayerCount: { '2': { workUnits: 8 }, '5': { overrideMargin: 0.05 } },
  }, { seatCount: 2 });
  assert.equal(version.adapter, 'champion-guided');
  assert.deepEqual(version.jointOptions, { workUnits: 8 });
  const noOptions = toSeatVersion({ id: 'plain', engineWeight: 1 }, { seatCount: 2 });
  assert.equal(noOptions.jointOptions, undefined);
});
