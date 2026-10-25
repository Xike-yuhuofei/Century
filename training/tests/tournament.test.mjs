/** 训练系统测试：统计工具、冠军挑战、参数进化。运行前需先构建 web-v1。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wilsonCI, meanCI, promotionDecision, pairedPromotionDecision, firstPlaceStats, probit, alphaSpendingThreshold, PROMOTION_ALPHA_BUDGET, Z_95 } from '../evaluator/stats.mjs';
import { runChallenge, challengeWithDecision, versionsFor } from '../tournament/challenge.mjs';
import { mutateCandidate, evolve, compareCandidates, championFingerprint } from '../optimizer/evolve.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { buildOpponentPool, styleVariants, historicalChampions, beamBaseParameters } from '../lib/opponents.mjs';
import { createGame } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction } from '../../web-v1/dist/js/ai.js';
import { CHAMPION_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import {
  nextValidationBase, consumeLedger, assertBlockFree, validationChallengeCount,
  alignToTrainingBlock, allocateTrainingBlock, migrateLegacyCursor,
  VALIDATION_POOL_BASE, VALIDATION_POOL_MAX, VALIDATION_STRIDE,
  TRAINING_POOL_MAX, TRAINING_SEED_BLOCK, ENGINE_SEED_MAX,
} from '../lib/seeds.mjs';
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

test('适配器冠军的风格变体：剥离 adapter 且权重真实生效（2026-10-24 audit 回归）', () => {
  // 缺陷背景：CHAMPION_PARAMETERS.adapter='champion-guided' 后，浅拷贝风格变体
  // 被 decision.ts 静默分派到 JS5 联合搜索，权重乘子 100% 失效（变体 ≡ 冠军本体，
  // 行为探针逐位一致 48/48）。styleVariants 必须经 beamBaseParameters 归一化。
  const variants = styleVariants(CHAMPION_PARAMETERS);
  assert.equal(variants.length, 3);
  for (const v of variants) {
    assert.equal(v.adapter, undefined, '风格变体不得携带 adapter 字段');
    assert.equal(v.jointVersion, undefined);
    assert.equal(v.budgetMs, undefined);
    assert.equal(v.structure, 'beam-rollout', '适配器冠军的束搜索基座结构');
    assert.doesNotThrow(() => validateAIParameters(v));
  }
  assert.ok(variants.some(v => v.tempoWeight !== 1), '权重扰动必须真实存在');
  // 权重真实生效的结构性证据：变体决策走束搜索路径（reason 为束规划格式，
  // 不含适配器分派标记"冠军直通/联合规划"；变体 id 含 js5 字样属正常——id 透传）。
  const game = createGame(['A', 'B'], 1, [1]);
  game.players[0].isAI = true;
  const response = chooseAIAction(game, { parameters: variants[0] });
  assert.doesNotMatch(response.reason, /冠军直通|联合规划/);
  assert.match(response.reason, /beam-rollout/);
});

test('buildOpponentPool：适配器冠军入场但派生对手全部走束搜索基座', () => {
  const pool = buildOpponentPool({ champion: CHAMPION_PARAMETERS, baseline: BASELINE_PARAMETERS, maxOpponents: 5 });
  assert.equal(pool[0].adapter, 'champion-guided', '冠军本体席位保留适配器分派');
  for (const opponent of pool.slice(1)) {
    assert.equal(opponent.adapter, undefined, `对手 ${opponent.id} 不得携带 adapter（audit 缺陷防御）`);
  }
});

test('beamBaseParameters：适配器参数归一化 + 非适配器参数原样保留', () => {
  const normalized = beamBaseParameters(CHAMPION_PARAMETERS);
  assert.equal(normalized.adapter, undefined);
  assert.equal(normalized.structure, 'beam-rollout');
  assert.equal(normalized.acquisitionVariant, 'readiness-efficiency', '血统保留');
  for (const key of ['engineWeight', 'tempoWeight', 'restWeight', 'endgameWeight']) {
    assert.equal(normalized[key], 1, `缺省权重补 1.0：${key}`);
  }
  // 非适配器冠军：structure 原样保留（不改变既有行为）。
  const kept = beamBaseParameters({ ...BASELINE_PARAMETERS, structure: 'beam-lineage' });
  assert.equal(kept.structure, 'beam-lineage');
  assert.equal(kept.adapter, undefined);
});

test('验证种子账本：种子块不可重复使用（AI7-A1：无账本 fail-closed）', () => {
  // AI7-A1：无账本/空账本禁止按运行身份/时间派生起点（旧 fail-open 缺陷）。
  assert.throws(() => nextValidationBase(null, { runId: '111' }), /账本缺失|fail-closed/);
  assert.throws(() => nextValidationBase({ history: [] }, { runId: '222' }), /没有可核验|禁止按运行身份/);
  const first = VALIDATION_POOL_BASE + 10 * VALIDATION_STRIDE;
  // 有账本：下一块严格落在已消费块之后（旧式 lastBase 无 size 按整步长保守计）。
  const next = nextValidationBase({ lastBase: VALIDATION_POOL_BASE + 5 * VALIDATION_STRIDE }, { runId: '999' });
  assert.equal(next, VALIDATION_POOL_BASE + 7 * VALIDATION_STRIDE, 'lastBase 块按最大步长保守估计，下一块再空一个步长');
  // 消费记账保留历史 + 累计挑战次数（多重检验 alpha 消耗的挑战序号来源）。
  const ledger = consumeLedger(null, first);
  assert.equal(ledger.lastBase, first);
  assert.equal(ledger.history.length, 1);
  assert.equal(ledger.challengeCount, 1);
  const twice = consumeLedger(ledger, next);
  assert.equal(twice.history.length, 2);
  assert.equal(twice.challengeCount, 2);
  // 旧账本（无 challengeCount 字段）按 history 条数兜底。
  assert.equal(validationChallengeCount({ lastBase: first, history: ledger.history }), 1);
  assert.equal(validationChallengeCount(null), 0);
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

// ---- P1 复审：指标命名与真实第一名率 ----

test('配对判定的统计量是"配对得分优势率"，不是先名率（命名修正回归）', () => {
  const pairs = Array.from({ length: 60 }, (_, i) => ({ seed: i + 1, status: 'finished', diff: i < 40 ? 3 : -2, anomalies: 0 }));
  const decision = pairedPromotionDecision({ seedPairs: pairs, minSeeds: 60 });
  // 判定文案不得再出现"先名率"字样（它衡量的是分差>0 的比例）。
  assert.ok(!/先名/.test(decision.reason), `判定文案不得使用先名率：${decision.reason}`);
  assert.ok(/得分优势率/.test(decision.reason), `判定文案必须标明得分优势率：${decision.reason}`);
  assert.equal(decision.scoreAdvantageRate, 40 / 60, '必须显式输出 scoreAdvantageRate 字段');
});

test('firstPlaceStats：方向 A/B 与合并第一名率，合并期望 0.5', () => {
  const games = [
    { status: 'finished', direction: 'A', candidateWon: true },
    { status: 'finished', direction: 'A', candidateWon: false },
    { status: 'finished', direction: 'A', candidateWon: false },
    { status: 'finished', direction: 'A', candidateWon: false },
    { status: 'finished', direction: 'B', candidateWon: true },
    { status: 'finished', direction: 'B', candidateWon: true },
    { status: 'finished', direction: 'B', candidateWon: true },
    { status: 'finished', direction: 'B', candidateWon: true },
    { status: 'anomaly', direction: 'A', candidateWon: undefined },
  ];
  const stats = firstPlaceStats(games);
  assert.equal(stats.directionA.wins, 1);
  assert.equal(stats.directionA.games, 4);
  assert.ok(Math.abs(stats.directionA.rate - 0.25) < 1e-9);
  assert.equal(stats.directionB.wins, 4);
  assert.equal(stats.directionB.games, 4);
  assert.equal(stats.merged.wins, 5);
  assert.equal(stats.merged.games, 8, '异常局不计入第一名率');
  assert.ok(Math.abs(stats.merged.wilsonCI.point - 5 / 8) < 1e-9);
  assert.ok(stats.merged.note, '局级区间必须标注配对近似免责说明');
  // 空输入不抛错（rate 为 null）。
  const empty = firstPlaceStats([]);
  assert.equal(empty.merged.rate, null);
});

test('runChallenge：summary 必须携带 firstPlace 真实第一名率', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-fp' };
  const candidate = { ...BASELINE_PARAMETERS, id: 'cand-fp' };
  const { summary } = runChallenge({ champion, candidate, seeds: 3, seedBase: 600 });
  assert.ok(summary.firstPlace, 'summary 必须包含 firstPlace 块');
  assert.equal(summary.firstPlace.directionA.games, 3);
  assert.equal(summary.firstPlace.directionB.games, 3);
  assert.equal(summary.firstPlace.merged.games, 6);
  assert.equal(summary.firstPlace.merged.wins, summary.candidateWins, '合并第一名数与 candidateWins 一致');
  // 晋级判定文案不得混用"先名率"。
  const { summary: withDecision } = challengeWithDecision({ champion, candidate, seeds: 3, seedBase: 601, minSeeds: 1 });
  assert.ok(!/配对先名率/.test(withDecision.decision.reason), `晋级文案不得使用先名率：${withDecision.decision.reason}`);
});

// ---- P0 复审：训练种子基数透传 ----

test('evolve：seedBase 必须真正驱动训练种子游标（P0 透传回归，块分配语义）', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'evo-seedbase' };
  // population 1 × 1 代：rngCursor +1；候选种子块 = 对齐基数起的第一个 1000 种子块。
  const result = evolve({
    champion, generations: 1, population: 1, gamesPerCandidate: 2, seedBase: 20261021,
  });
  // 20261021 向上块对齐 = 20262000；消费一个 1000 种子块后游标 = 20263000。
  assert.equal(result.state.seedCursor, 20263000, `seedBase 未透传：游标 ${result.state.seedCursor}`);
  assert.equal(result.state.rngCursor, 20261022, 'rng 游标必须独立逐代前进');
  // 缺省时退回默认基数（行为不变，仅确认默认值仍生效）。
  const fallback = evolve({ champion, generations: 1, population: 1, gamesPerCandidate: 2 });
  assert.equal(fallback.state.seedCursor, 101000, '缺省 seedBase 100000 对齐后消费一块 → 101000');
});

// ---- P0 复审：冠军切换后的状态继承 ----

test('evolve：冠军切换后旧精英池与待定候选必须失效（P0 回归）', () => {
  const oldChampion = { ...BASELINE_PARAMETERS, id: 'old-champ' };
  const newChampion = { ...BASELINE_PARAMETERS, id: 'new-champ', structure: 'beam-rollout' };
  // 模拟旧冠军留下的断点：含旧结构精英与待定候选。
  const staleState = {
    generation: 7,
    sigma: 0.05,
    seedCursor: 123456,
    elites: [
      { parameters: { ...oldChampion, id: 'old-elite-1', structure: 'beam-lineage', engineWeight: 1.2 }, winRate: 0.6 },
      { parameters: { ...oldChampion, id: 'old-elite-2', structure: 'beam-lineage', tempoWeight: 1.3 }, winRate: 0.58 },
    ],
    pendingCandidate: { ...oldChampion, id: 'old-pending', structure: 'beam-lineage' },
    history: [{ generation: 6, bestId: 'old-elite-1', bestWinRate: 0.6 }],
  };
  const parentIds = [];
  const result = evolve({
    champion: newChampion,
    initialState: staleState,
    generations: 1,
    population: 2,
    gamesPerCandidate: 2,
    seedBase: 20261022,
    onGeneration: (state, candidates) => {
      for (const c of candidates) parentIds.push(c.parentId);
    },
  });
  // 旧精英必须被清空：全部候选的父代只能是新冠军。
  assert.deepEqual(parentIds, ['new-champ', 'new-champ'], '冠军换人后不得继续沿旧精英进化');
  assert.ok(result.state.eliteReset, '必须记录精英失效事件');
  assert.equal(result.state.eliteReset.newChampionId, 'new-champ');
  assert.equal(result.state.eliteReset.eliteCount, 2);
  // 步长复位（0.18）后经 1 代收缩：胜率 > 0.5 → ×0.85 = 0.153；否则 ×0.92 = 0.1656。
  // 两个分支都从复位值 0.18 出发，绝不残留断点里的旧步长 0.05。
  assert.ok(
    Math.abs(result.state.sigma - 0.18 * 0.85) < 1e-9 || Math.abs(result.state.sigma - 0.18 * 0.92) < 1e-9,
    `冠军切换后步长必须从初始值重新收缩，不得残留旧值：${result.state.sigma}`,
  );
  // 旧格式断点（无 rngCursor）自动迁移：seedCursor 123456（旧块索引语义）
  // → 绝对种子 123,456,000（旧最后已消费块之后），rng 流从 123456 续接；
  // 1 代 × population 2 消费 2 块 → 123,458,000。
  assert.equal(result.state.seedCursor, 123458000, '旧断点必须迁移到绝对种子语义且续接在旧已消费块之后');
  assert.equal(result.state.rngCursor, 123457, 'rng 游标从旧游标续接，不重复');
  assert.ok(result.state.seedMigration, '迁移事件必须落盘供审计');
  assert.equal(result.state.seedMigration.from, 123456);
  assert.equal(result.state.seedMigration.to, 123458000 - 2000, '迁移起点 = 旧游标×1000（旧最后已消费块之后）');
  assert.equal(result.state.history.length, 2, '历史必须保留供审计');
});

test('evolve：同一冠军断点续训保留精英池；参数被手改后精英失效', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'same-champ' };
  const keptState = {
    generation: 3,
    sigma: 0.1,
    seedCursor: 5000,
    elites: [{ parameters: { ...champion, id: 'elite-keep', engineWeight: 1.1 }, winRate: 0.55 }],
    pendingCandidate: null,
    history: [],
    championId: champion.id,
    championFingerprint: championFingerprint(champion),
  };
  const parentIds = [];
  evolve({
    champion,
    initialState: keptState,
    generations: 1,
    population: 1,
    gamesPerCandidate: 2,
    onGeneration: (state, candidates) => { for (const c of candidates) parentIds.push(c.parentId); },
  });
  assert.deepEqual(parentIds, ['elite-keep'], '同一冠军续训必须沿用精英池');
  // 冠军参数被手改（id 不变但指纹变化）→ 精英同样失效。
  const tampered = { ...champion, engineWeight: 1.4 };
  const parentIds2 = [];
  const result2 = evolve({
    champion: tampered,
    initialState: keptState,
    generations: 1,
    population: 1,
    gamesPerCandidate: 2,
    onGeneration: (state, candidates) => { for (const c of candidates) parentIds2.push(c.parentId); },
  });
  assert.deepEqual(parentIds2, ['same-champ'], '冠军参数被改动后旧精英必须失效');
  assert.ok(result2.state.eliteReset);
});

// ---- P1 复审：历史冠军保底入池 ----

test('对手池：历史冠军必须保底入池（P1 回归）', () => {
  const archiveDir = join(mkdtempSync(join(tmpdir(), 'archive-')), 'candidates');
  mkdirSync(archiveDir, { recursive: true });
  const mk = (id, weight) => writeFileSync(join(archiveDir, `${id}.json`), JSON.stringify({
    id, parameters: { ...BASELINE_PARAMETERS, id, engineWeight: weight },
  }));
  mk('hist-20261001', 1.1);
  mk('hist-20261010', 1.2);
  mk('hist-20261020', 1.3);
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-now' };
  // 默认容量 5：此前历史冠军永远轮不到，修复后必须有历史版本入池。
  const pool = buildOpponentPool({ champion, baseline: BASELINE_PARAMETERS, archiveDir, maxOpponents: 5 });
  assert.ok(pool.some(p => p.id.startsWith('hist-')), `历史冠军必须入池：${pool.map(p => p.id).join(',')}`);
  // 极小容量 2：基线与风格变体让位，历史冠军仍保底 1 席。
  const tiny = buildOpponentPool({ champion, baseline: BASELINE_PARAMETERS, archiveDir, maxOpponents: 2 });
  assert.equal(tiny.length, 2);
  assert.ok(tiny.some(p => p.id.startsWith('hist-')), '容量 2 时历史冠军仍必须保底');
  // 容量充足时更多历史版本按时间倒序补充。
  const wide = buildOpponentPool({ champion, baseline: BASELINE_PARAMETERS, archiveDir, maxOpponents: 16 });
  const histIds = wide.filter(p => p.id.startsWith('hist-')).map(p => p.id);
  assert.equal(histIds.length, 3, '容量充足时三个历史版本都应入池');
  for (const opponent of pool) assert.doesNotThrow(() => validateAIParameters(opponent));
});

// ---- P1 复审：种子账本防重 ----

test('验证种子账本：下一块起点必须跳过全部已消费块（含大块历史）', () => {
  // 历史里有一块 80 种子的消费记录 + lastBase 之外更晚的大块。
  const ledger = consumeLedger(consumeLedger(null, VALIDATION_POOL_BASE, 80), VALIDATION_POOL_BASE + VALIDATION_STRIDE, 500);
  const next = nextValidationBase(ledger, { runId: '1' });
  assert.equal(next, VALIDATION_POOL_BASE + VALIDATION_STRIDE + 500 + VALIDATION_STRIDE,
    '下一块必须落在最大已消费末端之后，而不是只看 lastBase');
  // 旧格式账本（无 size）按最大步长保守处理。
  const legacy = { lastBase: VALIDATION_POOL_BASE + 10 * VALIDATION_STRIDE, history: [{ base: VALIDATION_POOL_BASE + 10 * VALIDATION_STRIDE, at: '2026-01-01' }] };
  assert.equal(
    nextValidationBase(legacy, { runId: '1' }),
    VALIDATION_POOL_BASE + 11 * VALIDATION_STRIDE + VALIDATION_STRIDE,
    '旧账本无 size 时按 VALIDATION_STRIDE 保守估计',
  );
});

test('验证种子账本：重叠消费必须被拒绝（防重复使用）', () => {
  const ledger = consumeLedger(null, VALIDATION_POOL_BASE + 1000 * VALIDATION_STRIDE, 80);
  // 与已消费块直接重叠。
  assert.throws(() => assertBlockFree(VALIDATION_POOL_BASE + 1000 * VALIDATION_STRIDE + 10, 80, ledger), /重叠/);
  // 账本缺 size 的旧条目按 2000 保守估计 → 落在其内部的块也要拒绝。
  const legacy = { lastBase: VALIDATION_POOL_BASE, history: [{ base: VALIDATION_POOL_BASE, at: '2026-01-01' }] };
  assert.throws(() => assertBlockFree(VALIDATION_POOL_BASE + 500, 80, legacy), /重叠/);
  // 不重叠的下一块通过。
  assert.ok(assertBlockFree(VALIDATION_POOL_BASE + 1000 * VALIDATION_STRIDE + VALIDATION_STRIDE, 80, ledger));
  // 非法输入直接抛错；缺账本同样 fail-closed（AI7-A1）。
  assert.throws(() => assertBlockFree(VALIDATION_POOL_BASE, 0, null), /非法/);
  assert.throws(() => assertBlockFree(VALIDATION_POOL_BASE, 80, null), /账本缺失|fail-closed/);
});

// ---- P0 可靠性整改：长期多重检验控制（几何 alpha 消耗） ----

test('probit：标准正态分位数精度达标', () => {
  assert.ok(Math.abs(probit(0.975) - 1.959963984540054) < 1e-6, `probit(0.975) = ${probit(0.975)}`);
  assert.ok(Math.abs(probit(0.5)) < 1e-9);
  assert.ok(Math.abs(probit(1 - 0.001) - 3.090232306167813) < 1e-6);
  assert.throws(() => probit(0), /probit/);
  assert.throws(() => probit(1), /probit/);
});

test('alphaSpendingThreshold：几何消耗，挑战越多阈值越紧，终身族错误率受控', () => {
  // 第 1 次挑战与旧制完全一致（单侧 α=0.025，z≈1.96）——不惩罚首次晋级。
  const first = alphaSpendingThreshold(1);
  assert.equal(first.alpha, 0.025);
  assert.ok(Math.abs(first.z - Z_95) < 1e-6, `第 1 次阈值应等于 1.96：${first.z}`);
  // 单调收紧（α < 1e-15 后 z 饱和于双精度极限，改为单调不减；前 45 次严格递增）。
  let sum = 0;
  let prevZ = 0;
  for (let k = 1; k <= 200; k++) {
    const t = alphaSpendingThreshold(k);
    assert.ok(t.z >= prevZ, `阈值必须随挑战次数单调不减：k=${k}`);
    if (k <= 45) assert.ok(t.z > prevZ, `前 45 次阈值必须严格收紧：k=${k}`);
    prevZ = t.z;
    sum += t.alpha;
  }
  assert.ok(sum <= PROMOTION_ALPHA_BUDGET + 1e-12, `Σα_k=${sum} 必须受终身预算 ${PROMOTION_ALPHA_BUDGET} 约束`);
  assert.ok(Math.abs(sum - PROMOTION_ALPHA_BUDGET) < 1e-9, '预算应被几何级数精确耗尽');
  // 非法输入快速失败。
  assert.throws(() => alphaSpendingThreshold(0), /challengeIndex/);
  assert.throws(() => alphaSpendingThreshold(1.5), /challengeIndex/);
  assert.throws(() => alphaSpendingThreshold(3, { alphaBudget: 1.5 }), /alphaBudget/);
});

test('pairedPromotionDecision：同一证据下挑战序号越大判定越严格（多重检验回归）', () => {
  // 41/60 决定性种子胜（优势率 0.683）：k=1 时 Wilson 下界 > 0.5 → 晋级；
  // k=6 时阈值收紧到 z≈3.16 → 下界跌回 0.5 以下 → 不确定，保留冠军。
  const pairs = Array.from({ length: 60 }, (_, i) => ({ seed: VALIDATION_POOL_BASE + i, status: 'finished', diff: i < 41 ? 2 : -1.5, anomalies: 0 }));
  const first = pairedPromotionDecision({ seedPairs: pairs, minSeeds: 60, z: alphaSpendingThreshold(1).z });
  assert.equal(first.verdict, 'promote');
  const sixth = pairedPromotionDecision({ seedPairs: pairs, minSeeds: 60, z: alphaSpendingThreshold(6).z });
  assert.equal(sixth.verdict, 'inconclusive', '同一证据在第 6 次挑战时必须按收紧阈值保留冠军');
  // 判定必须披露所用阈值。
  assert.equal(first.z, alphaSpendingThreshold(1).z);
  assert.equal(sixth.z, alphaSpendingThreshold(6).z);
});

test('challengeWithDecision：challengeIndex 透传到判定证据（供晋级脚本独立重算）', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-idx' };
  const candidate = { ...BASELINE_PARAMETERS, id: 'cand-idx' };
  const { summary } = challengeWithDecision({ champion, candidate, seeds: 3, seedBase: 602, minSeeds: 1, challengeIndex: 2 });
  assert.equal(summary.decision.challengeIndex, 2);
  assert.equal(summary.decision.alphaBudget, PROMOTION_ALPHA_BUDGET);
  assert.equal(summary.decision.alpha, 0.0125, '第 2 次挑战 α = 0.05/4');
  assert.ok(Math.abs(summary.decision.z - alphaSpendingThreshold(2).z) < 1e-12);
  // 不传 challengeIndex（手动诊断）时维持 95% 检验且不携带序号。
  const manual = challengeWithDecision({ champion: { ...champion, id: 'champ-idx2' }, candidate, seeds: 2, seedBase: 603, minSeeds: 1 });
  assert.equal(manual.summary.decision.challengeIndex, undefined);
  assert.ok(Math.abs(manual.summary.decision.z - Z_95) < 1e-12);
});

// ---- P0 可靠性整改：对手池轮换塌缩回归 ----

test('versionsFor：pool=5（默认池）时每席位对手必须随种子轮转（塌缩回归）', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-rot' };
  const candidate = { ...BASELINE_PARAMETERS, id: 'cand-rot' };
  const pool = [champion, ...[1, 2, 3, 4].map(n => ({ ...BASELINE_PARAMETERS, id: `opp-${n}` }))];
  // 旧公式 (seedIndex×5+seat)%5 = seat：席位 s 永远拿 opp-s（每席只出现 1 种对手）。
  // 修复后必须逐种子轮转：每席位在 25 个种子窗口内至少见到 4 种不同对手。
  for (let seat = 0; seat < 5; seat++) {
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      if (i % 5 === seat) continue; // 该种子席位 s 是候选席，不计入对手观察
      seen.add(versionsFor([i % 5], candidate, pool, i)[seat].id);
    }
    assert.ok(seen.size >= 4, `席位 ${seat} 的对手必须跨种子轮转（旧缺陷固定为 1 种），实际 ${seen.size} 种`);
  }
  // 池首（冠军本体）必须经轮换以对手身份出场（席位 1-4）。
  const allIds = new Set();
  for (let i = 0; i < 25; i++) {
    for (let seat = 0; seat < 5; seat++) {
      if (i % 5 === seat) continue;
      allIds.add(versionsFor([i % 5], candidate, pool, i)[seat].id);
    }
  }
  assert.ok(allIds.has('champ-rot'), '冠军本体必须经轮换以对手身份出场');
  // 同局内各对手席位的对手互不重复（池 ≥ 5 时）。
  for (let i = 0; i < 10; i++) {
    const seat = i % 5;
    const row = versionsFor([seat], candidate, pool, i);
    const oppIds = row.filter((_, s) => s !== seat).map(v => v.id);
    assert.equal(new Set(oppIds).size, oppIds.length, `seed${i} 同局对手重复：${oppIds.join(',')}`);
  }
  // 确定性复现：同输入逐位一致。
  assert.deepEqual(versionsFor([1], candidate, pool, 7), versionsFor([1], candidate, pool, 7));
});

test('versionsFor：分配只依赖 (seedIndex, seat)，双向对战同席位对手一致（配对可比性）', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'champ-pair' };
  const candidate = { ...BASELINE_PARAMETERS, id: 'cand-pair' };
  const pool = [champion, { ...BASELINE_PARAMETERS, id: 'opp-1' }, { ...BASELINE_PARAMETERS, id: 'opp-2' }];
  // 方向 A 候选占席位 cA、方向 B 候选占 cB：只要席位 s 在两方向都是对手席，
  // 它拿到的对手必须相同——配对差异只来自候选席位数，不来自对手身份漂移。
  for (let i = 0; i < 6; i++) {
    for (const cA of [0, 2]) {
      for (const cB of [1, 4]) {
        if (cA === cB) continue;
        for (let s = 0; s < 5; s++) {
          if (s === cA || s === cB) continue;
          const inA = versionsFor([cA], candidate, pool, i)[s];
          const inB = versionsFor([cB], candidate, pool, i)[s];
          assert.equal(inA.id, inB.id, `seed${i} 席位${s} 在双向对局中必须拿到同一对手（A:${inA.id} vs B:${inB.id}）`);
        }
      }
    }
  }
});

// ---- P0 可靠性整改：训练种子块分配 ----

test('训练种子块分配：块对齐、池内、耗尽拒绝', () => {
  assert.equal(alignToTrainingBlock(0), 0);
  assert.equal(alignToTrainingBlock(100000), 100000);
  assert.equal(alignToTrainingBlock(20261021), 20262000, '非块对齐基数向上对齐');
  assert.throws(() => alignToTrainingBlock(-1), /非法/);
  assert.throws(() => alignToTrainingBlock(1.5), /非法/);

  const first = allocateTrainingBlock(0);
  assert.deepEqual(first, { base: 0, next: TRAINING_SEED_BLOCK });
  // 池内最后一块必须完整放下。
  const last = allocateTrainingBlock(TRAINING_POOL_MAX - TRAINING_SEED_BLOCK);
  assert.equal(last.base + TRAINING_SEED_BLOCK, TRAINING_POOL_MAX);
  // 越过训练池上限（= 验证池起点）必须拒绝，绝不污染验证种子。
  assert.throws(() => allocateTrainingBlock(TRAINING_POOL_MAX), /训练种子池已耗尽/);
  // 非块对齐游标拒绝（无论是否越界）。
  assert.throws(() => allocateTrainingBlock(TRAINING_POOL_MAX - TRAINING_SEED_BLOCK + 1), /块对齐/);
  assert.throws(() => allocateTrainingBlock(123), /块对齐/);
});

test('种子池布局：训练池与验证池物理隔离且全部在引擎安全范围内', () => {
  assert.equal(TRAINING_POOL_MAX, VALIDATION_POOL_BASE, '训练池上界 = 验证池起点，无缝无叠');
  assert.ok(VALIDATION_POOL_MAX <= ENGINE_SEED_MAX, '验证池上限必须 ≤ 2^31-1（引擎 mod 2^32 回绕）');
  assert.ok(TRAINING_POOL_MAX <= ENGINE_SEED_MAX);
  assert.equal(TRAINING_SEED_BLOCK, 1000, '块大小与 --games-per-candidate 上限对齐');
});

test('旧断点迁移：两种旧游标语义都确定性续接且不重复消费', () => {
  // 小游标（默认基数起步的旧运行）：旧消费名义值 = 游标×1000，新种子从其后继续。
  assert.deepEqual(migrateLegacyCursor(123456), { seedCursor: 123456000, rngCursor: 123456 });
  assert.deepEqual(migrateLegacyCursor(0), { seedCursor: 0, rngCursor: 0 });
  assert.deepEqual(migrateLegacyCursor(899999), { seedCursor: 899999000, rngCursor: 899999 }, '恰好在池内最后一块之前');
  // 大游标（日期基数 20261021 起步的真实断点）：旧消费名义值 ≈ 2e10 在池外，
  // 直接把游标向上对齐为池内绝对种子续用，绝不落到旧"游标×1000"（> 2^31）。
  const migrated = migrateLegacyCursor(20261049);
  assert.equal(migrated.seedCursor, 20262000, '真实断点 20261049 → 池内绝对种子 20262000');
  assert.ok(migrated.seedCursor < TRAINING_POOL_MAX, '迁移结果必须留在训练池内');
  assert.ok(migrated.seedCursor * 1000 > ENGINE_SEED_MAX, '若按旧语义乘 1000 必然越界（回归动机）');
  assert.throws(() => migrateLegacyCursor(-5), /seedCursor/);
  assert.throws(() => migrateLegacyCursor(undefined), /seedCursor/);
});

test('evolve：训练种子块互不重叠且全部落在训练池内（分配回归）', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'evo-blocks' };
  const logged = [];
  const result = evolve({
    champion, generations: 2, population: 3, gamesPerCandidate: 5, seedBase: 500,
    experimentLog: entry => { if (entry.type === 'candidate') logged.push(entry); },
  });
  const blocks = logged.map(e => e.seedBase);
  assert.equal(blocks.length, 6);
  // 块对齐且互不重叠，按消费顺序严格递增一个块。
  for (let i = 0; i < blocks.length; i++) {
    assert.equal(blocks[i] % TRAINING_SEED_BLOCK, 0, `块 ${i} 必须块对齐`);
    assert.ok(blocks[i] + TRAINING_SEED_BLOCK <= TRAINING_POOL_MAX, '块必须完整落在训练池内');
    if (i > 0) assert.equal(blocks[i], blocks[i - 1] + TRAINING_SEED_BLOCK, '块必须连续不重叠');
  }
  assert.equal(result.state.seedCursor, blocks.at(-1) + TRAINING_SEED_BLOCK);
  assert.equal(result.state.rngCursor, 500 + 2, 'rng 游标逐代 +1');
});

test('evolve：训练池耗尽必须抛错而不是越界污染验证池（边界值）', () => {
  const champion = { ...BASELINE_PARAMETERS, id: 'evo-exhaust' };
  // 游标停在池内最后一块：population 2 → 第 2 块越界抛错。
  assert.throws(() => evolve({
    champion,
    initialState: {
      generation: 0, sigma: 0.18, rngCursor: 1, seedCursor: TRAINING_POOL_MAX - TRAINING_SEED_BLOCK,
      elites: [], history: [], pendingCandidate: null,
      championId: champion.id, championFingerprint: championFingerprint(champion),
    },
    generations: 1, population: 2, gamesPerCandidate: 2,
  }), /训练种子池已耗尽/);
  // 恰好一块放得下：不抛错且游标精确停在池上限。
  const fits = evolve({
    champion,
    initialState: {
      generation: 0, sigma: 0.18, rngCursor: 1, seedCursor: TRAINING_POOL_MAX - TRAINING_SEED_BLOCK,
      elites: [], history: [], pendingCandidate: null,
      championId: champion.id, championFingerprint: championFingerprint(champion),
    },
    generations: 1, population: 1, gamesPerCandidate: 2,
  });
  assert.equal(fits.state.seedCursor, TRAINING_POOL_MAX);
  // 非法 seedBase 快速失败。
  assert.throws(() => evolve({ champion, seedBase: -1 }), /seedBase/);
  assert.throws(() => evolve({ champion, seedBase: TRAINING_POOL_MAX }), /放不下|seedBase/);
});
