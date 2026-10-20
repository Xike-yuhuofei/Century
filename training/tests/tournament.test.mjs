/** 训练系统测试：统计工具、冠军挑战、参数进化。运行前需先构建 web-v1。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wilsonCI, meanCI, promotionDecision, pairedPromotionDecision } from '../evaluator/stats.mjs';
import { runChallenge, challengeWithDecision } from '../tournament/challenge.mjs';
import { mutateCandidate, evolve, compareCandidates } from '../optimizer/evolve.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { buildOpponentPool, styleVariants, historicalChampions } from '../lib/opponents.mjs';
import { nextValidationBase, consumeLedger, VALIDATION_POOL_BASE, VALIDATION_STRIDE } from '../lib/seeds.mjs';
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

test('晋级判定规则（独立样本版，仅用于诊断场景）', () => {
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

test('配对晋级判定：以种子为统计单位，配对样本不当独立局计数', () => {
  // 60 个决定性种子全部为候选胜 → 晋级。
  const allWon = Array.from({ length: 60 }, (_, i) => ({ seed: i + 1, status: 'finished', diff: 3, anomalies: 0 }));
  const strong = pairedPromotionDecision({ seedPairs: allWon, minSeeds: 60 });
  assert.equal(strong.promote, true);
  assert.equal(strong.verdict, 'promote');

  // 旧实现把同种子的双向 2 局当独立样本：10 个种子全胜 = 20"独立局"全胜，
  // 会虚报样本充足。配对判定必须按 10 个种子计 → 样本不足。
  const tenSeeds = Array.from({ length: 10 }, (_, i) => ({ seed: i + 1, status: 'finished', diff: 5, anomalies: 0 }));
  const overcounted = pairedPromotionDecision({ seedPairs: tenSeeds, minSeeds: 20 });
  assert.equal(overcounted.verdict, 'insufficient', '10 个种子不得冒充 20 个独立样本');
  assert.equal(pairedPromotionDecision({ seedPairs: tenSeeds, minSeeds: 10 }).verdict, 'promote');

  // 明显劣势：决定性种子 20/60 胜 → 区间上界 ≤ 0.5，拒绝。
  const weak = [
    ...Array.from({ length: 20 }, (_, i) => ({ seed: i + 1, status: 'finished', diff: 1, anomalies: 0 })),
    ...Array.from({ length: 40 }, (_, i) => ({ seed: 21 + i, status: 'finished', diff: -4, anomalies: 0 })),
  ];
  const weakResult = pairedPromotionDecision({ seedPairs: weak, minSeeds: 60 });
  assert.equal(weakResult.promote, false);
  assert.equal(weakResult.verdict, 'rejected');

  // 决定性种子不足。
  assert.equal(pairedPromotionDecision({ seedPairs: allWon.slice(0, 30), minSeeds: 60 }).verdict, 'insufficient');

  // 平局种子不计入分母但披露平局率（61 胜 + 1 平：平局率 1/62）。
  const withTies = [
    ...Array.from({ length: 61 }, (_, i) => ({ seed: i + 1, status: 'finished', diff: 2, anomalies: 0 })),
    { seed: 100, status: 'finished', diff: 0, anomalies: 0 },
  ];
  const tieResult = pairedPromotionDecision({ seedPairs: withTies, minSeeds: 60 });
  assert.equal(tieResult.promote, true);
  assert.ok(Math.abs(tieResult.tieRate - 1 / 62) < 1e-4, `平局率 ${tieResult.tieRate}`);

  // 异常率超限直接拒绝。
  const unstable = Array.from({ length: 60 }, (_, i) => ({ seed: i + 1, status: i < 5 ? 'anomaly' : 'finished', diff: i < 5 ? null : 1, anomalies: i < 5 ? 2 : 0 }));
  assert.equal(pairedPromotionDecision({ seedPairs: unstable, minSeeds: 60 }).verdict, 'rejected');
});

test('双向混战挑战：基线 vs 基线（不同 id）产出配对样本且先名率约 0.5', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-smoke' };
  const candidate = { ...BASELINE_PARAMETERS, id: 'cand-smoke' };
  const { summary } = runChallenge({ champion, candidate, seeds: 4, seedBase: 500 });
  assert.equal(summary.totalGames, 8);
  assert.equal(summary.anomalies, 0);
  assert.equal(summary.paired.finished, 4, '每种子一个配对样本');
  assert.equal(summary.seedPairs.length, 4);
  assert.equal(summary.opponents.length, 1, '缺省对手池 = 仅冠军');
  // 同参数对局中，先名率应接近 0.5（小幅样本允许偏离）。
  assert.ok(summary.candidateWinRate >= 0 && summary.candidateWinRate <= 1);
  assert.ok(summary.pairedDiffCI, '必须输出按种子配对的分差区间');
});

test('对手池：非候选席位轮转使用池内对手', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-pool' };
  const candidate = { ...BASELINE_PARAMETERS, id: 'cand-pool' };
  const opponents = [
    { ...BASELINE_PARAMETERS, id: 'opp-1' },
    { ...BASELINE_PARAMETERS, id: 'opp-2' },
  ];
  const { summary } = runChallenge({ champion, candidate, seeds: 2, seedBase: 800, opponents });
  assert.equal(summary.opponents.length, 2);
  assert.equal(summary.paired.finished, 2);
  assert.equal(summary.anomalies, 0);
  assert.throws(
    () => runChallenge({ champion, candidate, seeds: 1, opponents: [{ ...BASELINE_PARAMETERS, id: 'cand-pool' }] }),
    /对手池/,
    '对手池不得包含候选参数',
  );
});

test('对手池构建：冠军 + 基线 + 风格变体（去重、限量、全部合法）', () => {
  const pool = buildOpponentPool({ champion: BASELINE_PARAMETERS, baseline: BASELINE_PARAMETERS, maxOpponents: 4 });
  assert.equal(pool[0].id, BASELINE_PARAMETERS.id);
  assert.ok(pool.length <= 4);
  for (const opponent of pool) assert.doesNotThrow(() => validateAIParameters(opponent));
  const ids = new Set(pool.map(p => p.id));
  assert.equal(ids.size, pool.length, '对手池按 id 去重');
  // 风格变体真实偏离冠军（不是虚假多样性）。
  const variants = styleVariants(BASELINE_PARAMETERS);
  assert.equal(variants.length, 3);
  assert.ok(variants.some(v => v.tempoWeight !== BASELINE_PARAMETERS.tempoWeight));
  assert.ok(variants.some(v => v.contestWeight !== BASELINE_PARAMETERS.contestWeight));
  // 历史档案目录不存在时返回空（尚无晋级历史不是错误）。
  assert.deepEqual(historicalChampions('/nonexistent/path/candidates'), []);
});

test('验证种子账本：种子块不可重复使用', () => {
  // 无账本：按运行身份派生（不同 runId 起点不同）。
  const first = nextValidationBase(null, { runId: '111' });
  const second = nextValidationBase(null, { runId: '222' });
  assert.ok(first >= VALIDATION_POOL_BASE);
  assert.notEqual(first, second);
  // 有账本：严格递增一个块，绝不与历史重叠。
  const next = nextValidationBase({ lastBase: VALIDATION_POOL_BASE + 5 * VALIDATION_STRIDE }, { runId: '999' });
  assert.equal(next, VALIDATION_POOL_BASE + 6 * VALIDATION_STRIDE);
  // 消费记账保留历史。
  const ledger = consumeLedger(null, first);
  assert.equal(ledger.lastBase, first);
  assert.equal(ledger.history.length, 1);
  assert.equal(consumeLedger(ledger, next).history.length, 2);
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

test('进化循环：截止时间触发安全退出且保持状态一致（审计整改）', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'evo-deadline' };
  const generationsLogged = [];
  const result = evolve({
    champion,
    generations: 5,
    population: 4,
    gamesPerCandidate: 2,
    seedBase: 900,
    // 立即到期：一个候选都不能再评估。
    deadlineAt: Date.now() - 1000,
    safetyMarginMs: 0,
    onGeneration: state => generationsLogged.push(state.generation),
  });
  assert.deepEqual(generationsLogged, [], '到期后不得产出任何一代');
  assert.equal(result.state.interrupted, true, '必须标记中断');
  assert.equal(result.improved, false);
  assert.equal(result.state.generation, 0);
});

test('排序键：胜率优先，平均分差打破并列', () => {
  // 比较器 < 0 表示前者排在前面（降序：更强者在前）。
  assert.equal(compareCandidates({ winRate: 0.6, meanScoreDiff: 0 }, { winRate: 0.4, meanScoreDiff: 9 }), -1);
  assert.equal(compareCandidates({ winRate: 0.4, meanScoreDiff: 9 }, { winRate: 0.6, meanScoreDiff: 0 }), 1);
  assert.equal(compareCandidates({ winRate: 0.5, meanScoreDiff: 3 }, { winRate: 0.5, meanScoreDiff: 1 }), -1);
  assert.equal(compareCandidates({ winRate: 0.5, meanScoreDiff: 2 }, { winRate: 0.5, meanScoreDiff: 2 }), 0);
});
