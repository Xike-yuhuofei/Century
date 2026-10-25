/** D3 多样性：行为距离、去重、多候选保留、快筛/深验分区、对手轮换。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorDistance, selectCandidates, scoreCandidate } from '../selection.mjs';
import { opponentIdsForGame, assertIndependentWindows } from '../dev-evaluator.mjs';
import { AI7_DEV_BLOCKS } from '../core.mjs';

function gameSignature(actions, rank = 3, score = 50) {
  return {
    kind: 'game-behavior-v1',
    actions,
    meanRank: rank,
    meanScore: score,
    meanMoves: 150,
    seatCounts: [2, 3],
  };
}

function proxySignature(targetId, coefficient) {
  return { kind: 'proxy-coefficients-v1', targetId, coefficients: { goalFit: coefficient }, bias: 0 };
}

function artifact(id, mode, identity, safety = 'passed') {
  return {
    candidateId: id,
    identityDigest: identity,
    algorithmStructure: { evaluationMode: mode, targetIds: [mode === 'game' ? 'overrideMargin' : 'goalValue'] },
    safety: { status: safety },
  };
}

function evidence(mode, signature, overrides = {}) {
  return {
    metrics: mode === 'game'
      ? {
          evidenceType: 'dev-game', totalGames: 4, anomalyRate: 0, firstPlaceRate: 0.5,
          chanceAdjustedRate: overrides.chanceAdjustedRate ?? 0.1,
          minWilsonLower: overrides.minWilsonLower ?? 0.25, p95WallMs: 1_000,
        }
      : {
          evidenceType: 'offline-proxy', fixtures: 2, fallbackRate: 0, proxyDelta: overrides.proxyDelta ?? 0.1,
        },
    behaviorSignature: signature,
    behaviorHash: `${mode}-${JSON.stringify(signature)}`,
  };
}

test('行为距离：相同=0，不同动作/目标产生正距离，跨类型=1', () => {
  const a = gameSignature({ acquire: 0.2, claim: 0.2, rest: 0.2, play: 0.3, discard: 0.1 });
  const b = gameSignature({ acquire: 0.2, claim: 0.2, rest: 0.2, play: 0.3, discard: 0.1 });
  assert.equal(behaviorDistance(a, b), 0);
  const c = gameSignature({ acquire: 0.5, claim: 0.1, rest: 0.1, play: 0.2, discard: 0.1 }, 4, 80);
  assert.ok(behaviorDistance(a, c) > 0.2);
  assert.equal(behaviorDistance(a, proxySignature('goalValue', 0.5)), 1);
  assert.equal(behaviorDistance(proxySignature('goalValue', 0.2), proxySignature('goalValue', 0.8)) > 0, true);
  assert.equal(behaviorDistance(proxySignature('goalValue', 0.2), proxySignature('keepValue', 0.8)), 1);
});

test('多候选保留：game 与 proxy 各保留最高分，不把 proxy 当对局强度', () => {
  const entries = [
    { artifact: artifact('cand-g1', 'game', 'id-g1'), evidence: evidence('game', gameSignature({ acquire: 0.4, claim: 0.1, rest: 0.1, play: 0.3, discard: 0.1 }, 1, 80), { chanceAdjustedRate: 0.4, minWilsonLower: 0.3 }) },
    { artifact: artifact('cand-g2', 'game', 'id-g2'), evidence: evidence('game', gameSignature({ acquire: 0.1, claim: 0.4, rest: 0.1, play: 0.3, discard: 0.1 }, 2, 60), { chanceAdjustedRate: 0.2, minWilsonLower: 0.15 }) },
    { artifact: artifact('cand-p1', 'proxy', 'id-p1'), evidence: evidence('proxy', proxySignature('goalValue', 0.9), { proxyDelta: 0.3 }) },
    { artifact: artifact('cand-p2', 'proxy', 'id-p2'), evidence: evidence('proxy', proxySignature('keepValue', 0.2), { proxyDelta: 0.1 }) },
  ];
  const result = selectCandidates({ entries, maxKeep: 3, minBehaviorDistance: 0.2 });
  const modes = result.selected.map(x => x.artifact.algorithmStructure.evaluationMode).sort();
  assert.deepEqual(modes, ['game', 'game', 'proxy']);
  assert.equal(result.summary.evaluated, 4);
  assert.equal(result.selected.length, 3);
  assert.equal(result.summary.byMode.game + result.summary.byMode.proxy, 3);
});

test('去重：同身份与同行为哈希只保留一个', () => {
  const entries = [
    { artifact: artifact('cand-a', 'game', 'same-id'), evidence: evidence('game', gameSignature({ acquire: 0.2, claim: 0.2, rest: 0.2, play: 0.3, discard: 0.1 })) },
    { artifact: artifact('cand-b', 'game', 'same-id'), evidence: evidence('game', gameSignature({ acquire: 0.5, claim: 0.1, rest: 0.1, play: 0.2, discard: 0.1 }, 1, 80)) },
  ];
  const result = selectCandidates({ entries, maxKeep: 3 });
  assert.equal(result.selected.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.match(result.duplicates[0].reason, /identity/);

  const sameBehavior = [
    { artifact: artifact('cand-c', 'game', 'id-c'), evidence: { ...evidence('game', gameSignature({ acquire: 0.2, claim: 0.2, rest: 0.2, play: 0.3, discard: 0.1 })), behaviorHash: 'same-behavior' } },
    { artifact: artifact('cand-d', 'game', 'id-d'), evidence: { ...evidence('game', gameSignature({ acquire: 0.2, claim: 0.2, rest: 0.2, play: 0.3, discard: 0.1 })), behaviorHash: 'same-behavior' } },
  ];
  const result2 = selectCandidates({ entries: sameBehavior, maxKeep: 3 });
  assert.equal(result2.selected.length, 1);
  assert.equal(result2.duplicates.length, 1);
  assert.match(result2.duplicates[0].reason, /behavior/);
});

test('安全检查失败的候选被拒绝（失败隔离不进入保留池）', () => {
  const entries = [
    { artifact: artifact('cand-bad', 'game', 'id-bad', 'failed'), evidence: evidence('game', gameSignature({ acquire: 0.2, claim: 0.2, rest: 0.2, play: 0.3, discard: 0.1 })) },
    { artifact: artifact('cand-good', 'game', 'id-good'), evidence: evidence('game', gameSignature({ acquire: 0.4, claim: 0.1, rest: 0.1, play: 0.3, discard: 0.1 }, 1, 80)) },
  ];
  const result = selectCandidates({ entries, maxKeep: 3 });
  assert.equal(result.selected.length, 1);
  assert.equal(result.rejected.length, 1);
});

test('快筛/深验种子分区必须互斥且落在各自开发块', () => {
  const screen = [AI7_DEV_BLOCKS.screen[0], AI7_DEV_BLOCKS.screen[0] + 1];
  const deep = [AI7_DEV_BLOCKS.deep[0], AI7_DEV_BLOCKS.deep[0] + 1];
  assert.equal(assertIndependentWindows({ screenSeeds: screen, deepSeeds: deep }), true);
  assert.throws(() => assertIndependentWindows({ screenSeeds: screen, deepSeeds: [...screen] }), /重叠|越界/);
  assert.throws(() => assertIndependentWindows({ screenSeeds: [900_000_000], deepSeeds: deep }), /越界|验证池/);
});

test('对手轮换：screen 不固定单一对手，deep 保留冻结冠军锚点', () => {
  const a = opponentIdsForGame({ round: 1, seedIndex: 0, seatCount: 3, mode: 'screen' });
  const b = opponentIdsForGame({ round: 1, seedIndex: 1, seatCount: 3, mode: 'screen' });
  const c = opponentIdsForGame({ round: 2, seedIndex: 0, seatCount: 3, mode: 'screen' });
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a).size, a.length);
  const deep = opponentIdsForGame({ round: 1, seedIndex: 0, seatCount: 5, mode: 'deep' });
  assert.equal(deep[0], 'js5-frozen-champion');
  assert.ok(deep.length === 4);
  assert.ok(new Set(deep.slice(1)).size > 1);
});

test('scoreCandidate 输出多维分数且 game/proxy 分组', () => {
  const gameScore = scoreCandidate({
    artifact: artifact('cand-s', 'game', 'id-s'),
    evidence: evidence('game', gameSignature({ acquire: 0.2, claim: 0.2, rest: 0.2, play: 0.3, discard: 0.1 })),
  });
  assert.equal(gameScore.evaluationMode, 'game');
  for (const key of ['quality', 'stability', 'cost', 'safety', 'composite']) {
    assert.equal(typeof gameScore[key], 'number');
    assert.ok(gameScore[key] >= 0 && gameScore[key] <= 1);
  }
  const proxyScore = scoreCandidate({
    artifact: artifact('cand-px', 'proxy', 'id-px'),
    evidence: evidence('proxy', proxySignature('goalValue', 0.5)),
  });
  assert.equal(proxyScore.evaluationMode, 'proxy');
  assert.ok(proxyScore.composite >= 0 && proxyScore.composite <= 1);
});
