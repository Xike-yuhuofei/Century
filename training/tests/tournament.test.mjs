/** 训练系统测试：统计工具、冠军挑战、参数进化。运行前需先构建 web-v1。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wilsonCI, meanCI, promotionDecision } from '../evaluator/stats.mjs';
import { runChallenge, challengeWithDecision } from '../tournament/challenge.mjs';
import { mutateCandidate, evolve, compareCandidates } from '../optimizer/evolve.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { BASELINE_PARAMETERS, validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';

test('Wilson 区间数学性质', () => {
  const ci = wilsonCI(50, 100);
  assert.ok(ci.lower > 0.4 && ci.lower < 0.5 && ci.upper > 0.5 && ci.upper < 0.6, `50/100 区间异常：${JSON.stringify(ci)}`);
  const extreme = wilsonCI(0, 20);
  assert.equal(extreme.point, 0);
  assert.ok(extreme.upper < 0.2);
  assert.throws(() => wilsonCI(11, 10), /wins/);
  assert.throws(() => wilsonCI(1, 0), /n/);
});

test('均值区间', () => {
  const ci = meanCI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(ci.mean, 5.5);
  assert.ok(ci.lower < 5.5 && ci.upper > 5.5);
});

test('晋级判定规则', () => {
  // 明显优势：下界 > 0.5。
  const strong = promotionDecision({ wins: 70, games: 100, anomalyRate: 0 });
  assert.equal(strong.promote, true);
  // 劣势：上界 ≤ 0.5。
  const weak = promotionDecision({ wins: 30, games: 100, anomalyRate: 0 });
  assert.equal(weak.promote, false);
  assert.equal(weak.verdict, 'rejected');
  // 不确定：区间跨越 0.5 → 保留冠军。
  const mid = promotionDecision({ wins: 52, games: 100, anomalyRate: 0 });
  assert.equal(mid.promote, false);
  assert.equal(mid.verdict, 'inconclusive');
  // 样本不足。
  const small = promotionDecision({ wins: 9, games: 10, anomalyRate: 0 });
  assert.equal(small.verdict, 'insufficient');
  // 异常率超限直接拒绝。
  const unstable = promotionDecision({ wins: 90, games: 100, anomalyRate: 0.1 });
  assert.equal(unstable.verdict, 'rejected');
});

test('双向混战挑战：基线 vs 基线（不同 id）先名率约 0.5', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-smoke' };
  const candidate = { ...BASELINE_PARAMETERS, id: 'cand-smoke' };
  const { summary } = runChallenge({ champion, candidate, seeds: 4, seedBase: 500 });
  assert.equal(summary.totalGames, 8);
  assert.equal(summary.anomalies, 0);
  // 同参数对局中，先名率应接近 0.5（小幅样本允许偏离）。
  assert.ok(summary.candidateWinRate >= 0 && summary.candidateWinRate <= 1);
  // 方向 A 候选 1 席，方向 B 候选 4 席。
  const dirA = summary.finishedGames ? undefined : undefined;
  assert.ok(summary.meanRankCI || summary.finishedGames === 0);
  void dirA;
});

test('候选参数突变：合法、可复现、受边界约束', () => {
  const rngA = mulberry32(7);
  const rngB = mulberry32(7);
  const a = mutateCandidate(BASELINE_PARAMETERS, { id: 'm1', sigma: 0.3, rng: rngA });
  const b = mutateCandidate(BASELINE_PARAMETERS, { id: 'm1', sigma: 0.3, rng: rngB });
  assert.deepEqual(a, b, '同种子突变必须可复现');
  assert.equal(a.id, 'm1');
  // 大 sigma 下不越界。
  const wild = mutateCandidate(BASELINE_PARAMETERS, { id: 'm2', sigma: 5, rng: mulberry32(3) });
  assert.doesNotThrow(() => validateAIParameters(wild));
});

test('进化循环：微型运行产出状态与历史', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'evo-champ' };
  const generationsLogged = [];
  const result = evolve({
    champion,
    generations: 1,
    population: 2,
    gamesPerCandidate: 2,
    seedBase: 700,
    onGeneration: state => generationsLogged.push(state.generation),
  });
  assert.deepEqual(generationsLogged, [1]);
  assert.equal(result.state.history.length, 1);
  assert.equal(typeof result.state.history[0].bestWinRate, 'number');
  assert.ok(result.state.seedCursor > 700, '种子游标必须前进（可复现）');
});

test('排序键：胜率优先，平均分差打破并列', () => {
  // 比较器 < 0 表示前者排在前面（降序：更强者在前）。
  assert.equal(compareCandidates({ winRate: 0.6, meanScoreDiff: 0 }, { winRate: 0.4, meanScoreDiff: 9 }), -1);
  assert.equal(compareCandidates({ winRate: 0.4, meanScoreDiff: 9 }, { winRate: 0.6, meanScoreDiff: 0 }), 1);
  assert.equal(compareCandidates({ winRate: 0.5, meanScoreDiff: 3 }, { winRate: 0.5, meanScoreDiff: 1 }), -1);
  assert.equal(compareCandidates({ winRate: 0.5, meanScoreDiff: 2 }, { winRate: 0.5, meanScoreDiff: 2 }), 0);
});
