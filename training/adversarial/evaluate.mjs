/** 对抗性联赛·防过拟合双轴评估与强对手筛选（overnight-adversarial-league）。
 *
 * 设计动机：只评估"能否击败 JS5"会选出针对冠军单一策略过拟合的对手——
 * 它在 JS5 面前表现强势，却可能被任何非 JS5 策略轻易反制，对第六阶段
 * （真实单席位第一名率提升）价值有限。因此候选评估强制分轴披露：
 *
 * - 轴 A（adversarial，对抗轴）：候选 vs js5-frozen-champion。
 *   seatCount≥3 时另含方向 B（候选占 N−1 席 vs 冠军占 1 席），配对披露；
 *   2 人局只有头对头（方向 A 语义）。
 * - 轴 G（generality，通用轴）：候选 vs 非冠军泛化池（风格族 + 历史冠军 +
 *   中立基线，versionsForSeats 公式轮换），衡量对策略多样的领域泛化。
 *
 * 两轴各自独立统计、独立披露，任何合并口径都是违规（防过拟合纪律）。
 * selectStrongOpponents 按显式阈值双门槛筛选，输出标准化版本描述符清单
 * 供第六阶段消费。
 */

import { planMatrix, runPlan, buildWinRateMatrix, playLeagueGame, MIN_SEAT_COUNT, MAX_SEAT_COUNT } from './league.mjs';
import { assertInBlock } from '../../ai5/lib/seed_policy.mjs';
import { wilsonCI } from '../evaluator/stats.mjs';

/** 泛化轴对手池（不含冻结冠军本体——它属于轴 A 的职责）。 */
export const GENERALITY_POOL = Object.freeze([
  'style-rush', 'style-engine', 'style-contest', 'style-balanced',
  'ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'neutral-baseline',
]);

/**
 * 单候选双轴评估。
 *
 * @param {object} options
 * @param {object} options.registry 已注册候选的评估注册表（registerCandidates 产出）
 * @param {string} options.candidateId 候选 id
 * @param {number[]} options.seatCounts 评估人数（2..5 子集）
 * @param {number} options.seedsPerCell 每评估单元种子数
 * @param {number} options.axisASeedBase 轴 A 种子基址
 * @param {number} options.axisGSeedBase 轴 G 种子基址（与轴 A 不重叠由调用方保证）
 * @param {number[]} options.block 种子块
 * @param {object|null} [options.jointOverrides] 冠军引导运行时覆盖（透传联赛）
 */
export function evaluateCandidate({
  registry, candidateId, seatCounts = [2, 5], seedsPerCell,
  axisASeedBase, axisGSeedBase, block, jointOverrides = null,
}) {
  if (!registry.versions[candidateId]) throw new Error(`候选未注册：${candidateId}`);
  for (const n of seatCounts) {
    if (n < MIN_SEAT_COUNT || n > MAX_SEAT_COUNT) throw new Error(`seatCount 必须在 ${MIN_SEAT_COUNT}..${MAX_SEAT_COUNT}，实际：${n}`);
  }
  const candidate = registry.versions[candidateId];
  const focusFingerprint = candidate.fingerprint;

  // 轴 A：候选 vs 冻结冠军（计划复用 planMatrix 的头对头/有向场语义）。
  const axisAPlan = planMatrix({
    versionIds: [candidateId, 'js5-frozen-champion'],
    seatCounts, seedsPerPair: seedsPerCell, seedBase: axisASeedBase, block,
  });
  const axisAGames = runPlan(axisAPlan, registry, { jointOverrides });

  // 轴 G：候选占 1 席 vs 泛化池轮换（versionsForSeats 公式语义：对手随
  // (seedIndex + seat) mod |pool| 轮换——复用 planMatrix 有向场，opponent 固定
  // 无法表达池轮换，这里独立实现：每种子 1 局/人数，候选席 = seedIndex % N，
  // 其余席位从泛化池确定性轮换取版本）。
  const axisGGames = [];
  let cursor = axisGSeedBase;
  for (const seatCount of seatCounts) {
    const seeds = [];
    for (let i = 0; i < seedsPerCell; i++) {
      assertInBlock(cursor, block, '轴 G 种子');
      seeds.push(cursor);
      cursor += 1;
    }
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const focusSeat = i % seatCount;
      const pool = GENERALITY_POOL;
      const seatVersions = Array.from({ length: seatCount }, (_, seat) => {
        if (seat === focusSeat) return candidate;
        const poolIndex = (pool.length - 1) * ((i + seat) % pool.length) % pool.length;
        return registry.versions[pool[poolIndex]];
      });
      const result = playLeagueGame({ seed, seatCount, seatVersions, jointOverrides });
      axisGGames.push({
        matchId: `axisG--${candidateId}@${seatCount}`, direction: 'field',
        focusId: candidateId, opponentId: 'generality-pool', focusSeat,
        ...result,
      });
    }
  }

  const axisAPlanForMatrix = { ...axisAPlan, matches: axisAPlan.matches };
  return {
    candidateId,
    fingerprint: focusFingerprint,
    axisA: summarizeAxis(axisAPlanForMatrix, axisAGames),
    axisG: summarizeAxisGenerality(axisGGames),
    axisAGames,
    axisGGames,
  };
}

/** 轴 A 汇总：按 seatCount 聚合焦点席第一名率（Wilson CI + 座位覆盖）。 */
function summarizeAxis(plan, games) {
  const matrix = buildWinRateMatrix(plan, games);
  const cells = [];
  for (const match of plan.matches) {
    const cell = matrix[match.focusId]?.[match.opponentId];
    if (!cell) continue;
    cells.push({
      seatCount: match.seatCount, direction: match.direction,
      games: cell.games, wins: cell.wins,
      firstPlaceRate: cell.firstPlaceRate, wilson: cell.wilson,
      seatCoverage: Object.keys(cell.bySeat).sort().join('+'),
    });
  }
  const anomalies = games.filter(g => g.status !== 'finished').length;
  return { cells, anomalies, totalGames: games.length };
}

/** 轴 G 汇总：候选 vs 泛化池（对手混合轮换）——按 seatCount 聚合。 */
function summarizeAxisGenerality(games) {
  const bySeatCount = new Map();
  for (const g of games) {
    if (g.status !== 'finished') continue;
    const entry = bySeatCount.get(g.seatCount) ?? { games: 0, wins: 0, scoreSum: 0, oppScoreSum: 0 };
    entry.games += 1;
    if (g.winnerSeat === g.focusSeat) entry.wins += 1;
    const focusRow = g.ranking.find(r => r.seat === g.focusSeat);
    const oppRows = g.ranking.filter(r => r.seat !== g.focusSeat);
    if (focusRow) entry.scoreSum += focusRow.score;
    if (oppRows.length) {
      entry.oppScoreSum += oppRows.reduce((s, r) => s + r.score, 0) / oppRows.length;
    }
    bySeatCount.set(g.seatCount, entry);
  }
  const anomalies = games.filter(g => g.status !== 'finished').length;
  return {
    cells: [...bySeatCount.entries()].map(([seatCount, e]) => ({
      seatCount,
      games: e.games, wins: e.wins,
      firstPlaceRate: Number((e.wins / e.games).toFixed(4)),
      wilson: wilsonCI(e.wins, e.games),
      meanScore: Number((e.scoreSum / e.games).toFixed(2)),
      meanOpponentScore: Number((e.oppScoreSum / e.games).toFixed(2)),
      scoreDiff: Number(((e.scoreSum - e.oppScoreSum) / e.games).toFixed(2)),
    })),
    anomalies, totalGames: games.length,
  };
}

/**
 * 强对手筛选（显式双门槛，防过拟合纪律）：
 * - 轴 A 门槛：对冻结冠军的头对头第一名率下界（Wilson 95%）≥ minAxisALower。
 *   （"有证据地对 JS5 构成威胁"，而非点估计碰运气）
 * - 轴 G 门槛：泛化轴第一名率下界 ≥ minAxisGLower 且泛化分差 ≥ minAxisGDiff。
 *   （"不是只会打 JS5 的一招鲜"）
 * 两轴同时达标的候选按轴 A 点估计降序输出；输出标准化版本描述符。
 *
 * @param {object} options
 * @param {number} [options.minAxisALower] 轴 A Wilson 下界门槛（默认 0.5，
 *   即头对头统计上不弱于冠军）
 * @param {number} [options.minAxisGLower] 轴 G Wilson 下界门槛（默认 0.2，
 *   多人局 1/N≈0.2–0.5 区间内不塌陷）
 * @param {number} [options.minAxisGDiff] 轴 G 平均分差门槛（默认 -3 分）
 */
export function selectStrongOpponents(evaluations, {
  minAxisALower = 0.5, minAxisGLower = 0.2, minAxisGDiff = -3,
} = {}) {
  const ranked = [];
  for (const evaluation of evaluations) {
    // 轴 A 主读数：优先头对头（h2h）单元；多人局取方向 A（field）单元。
    const h2h = evaluation.axisA.cells.find(c => c.direction === 'h2h');
    const fieldCells = evaluation.axisA.cells.filter(c => c.direction === 'field');
    const primary = h2h ?? fieldCells[0] ?? null;
    const axisAFirst = primary?.firstPlaceRate ?? null;
    const axisALower = primary?.wilson?.lower ?? null;
    const axisGLower = evaluation.axisG.cells.length
      ? Math.min(...evaluation.axisG.cells.map(c => c.wilson.lower))
      : null;
    const axisGDiff = evaluation.axisG.cells.length
      ? Math.min(...evaluation.axisG.cells.map(c => c.scoreDiff))
      : null;
    const passA = axisALower !== null && axisALower >= minAxisALower;
    const passG = axisGLower !== null && axisGLower >= minAxisGLower
      && axisGDiff !== null && axisGDiff >= minAxisGDiff;
    ranked.push({
      candidateId: evaluation.candidateId,
      fingerprint: evaluation.fingerprint,
      axisA: { firstPlaceRate: axisAFirst, wilsonLower: axisALower, cells: evaluation.axisA.cells },
      axisG: { wilsonLowerMin: axisGLower, scoreDiffMin: axisGDiff, cells: evaluation.axisG.cells },
      verdict: passA && passG ? 'strong' : passA ? 'specialist' : passG ? 'weak-vs-champion' : 'reject',
      criteria: { minAxisALower, minAxisGLower, minAxisGDiff },
    });
  }
  ranked.sort((a, b) => (b.axisA.firstPlaceRate ?? -1) - (a.axisA.firstPlaceRate ?? -1));
  return {
    schema: 'century-adversarial-strong-opponents-v1',
    criteria: { minAxisALower, minAxisGLower, minAxisGDiff },
    strongOpponents: ranked.filter(r => r.verdict === 'strong'),
    all: ranked,
  };
}
