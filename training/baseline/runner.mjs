/** 多人第一名率基准运行器（AI6 第一阶段任务 B：2-5 人评测基准）。
 *
 * 两种配置，全部使用正式引擎编译产物与冻结冠军参数（不改任何行为）：
 *
 * 1. mirror（镜像基准）：全部席位 = 冠军。用途：
 *    - 座位公平性校准（每席位第一名率期望 = 1/N，偏离即座位优势信号）；
 *    - 得分 / 名次分布、决策延迟分位数、吞吐量的基线标定。
 *
 * 2. contest（对抗基准）：双向配对设计对 challenge.mjs 的 N=5 特例做 N=2..5 泛化：
 *    - 方向 A：冠军占 1 席（席位随 seedIndex 轮转，覆盖全部座位）；
 *    - 方向 B：冠军占 N-1 席；同 seed 两方向共享洗牌序列（配对样本）；
 *    - 合并后冠军阵营第一名率期望 = ((1/N) + (N-1)/N) / 2 = 0.5（无优势零假设）；
 *    - 对手池（前代冠军 / 中立基线 / tempo·contest·engine 风格变体）按
 *      versionsForSeats 的确定性公式随 seedIndex 轮换（任意池大小均遍历）；
 *    - 对手池不含冠军本体（冠军 vs 冠军属于 mirror 配置的职责）。
 *
 * 指标（对齐任务书）：
 * - primary：第一名率（按种子聚类的 bootstrap 区间，见 stats.mjs）；
 * - 辅助：配对得分优势（沿用 challenge.mjs 的 seedPairs 语义，仅披露不判定）；
 * - 平均名次、平均得分与分差、座位胜率、对手风格胜率、
 *   决策延迟 p50/p95/p99（collectDecisions 遥测）、吞吐（games/h、transitions/s 估算）、
 *   异常局数量与原因（异常局绝不计入胜率）。
 */

import { simulateGame } from '../simulator/simulate.mjs';
import {
  firstPlaceMetric, firstPlaceBy, meanRank, latencySummary,
  pairedDiffSummary, percentile,
} from './stats.mjs';
import { wilsonCI, meanCI } from '../evaluator/stats.mjs';
import { buildOpponentPool } from '../lib/opponents.mjs';
import { BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';

export const CANDIDATE_ARCHIVE_DIR = resolve(REPO_ROOT, 'training/champions/candidates');
export const MIN_SEAT_COUNT = 2;
export const MAX_SEAT_COUNT = 5; // 引擎约束：1 人类代理席 + 最多 4 AI 席

/** 由冻结冠军记录构造席位版本对象（parameters + structure 原样透传）。 */
export function championVersion(champion) {
  const parameters = champion.parameters ?? champion;
  if (!parameters?.id) throw new Error('冠军记录缺少 parameters.id');
  return { id: parameters.id, parameters, structure: parameters.structure };
}

/** 对抗配置的对手池：前代冠军（保底 1 席）+ 中立基线 + 冠军风格变体 ×3。
 * 明确剔除冠军本体（buildOpponentPool 会把冠军放池首，此处切掉）。 */
export function baselineOpponentPool(champion, { archiveDir = CANDIDATE_ARCHIVE_DIR, maxOpponents = 6 } = {}) {
  const championId = (champion.parameters ?? champion).id;
  const pool = buildOpponentPool({
    champion: champion.parameters ?? champion,
    baseline: BASELINE_PARAMETERS,
    archiveDir,
    maxOpponents,
  }).filter(o => o.id !== championId);
  if (pool.length < 2) throw new Error('对抗基准对手池至少需要 2 个非冠军版本');
  return pool;
}

/** 席位版本分配（challenge.mjs versionsFor 的 N=2..5 泛化，公式语义不变）：
 * - 非候选席位按 (池大小−1)×(seedIndex+seat) mod 池大小 轮换取对手；
 * - 任何池大小下每个席位的对手都随 seedIndex 遍历全池；
 * - 分配只依赖 (seedIndex, seat)，同 seed 双方向同席位对手一致（配对可比）。
 * candidate 为 championVersion 包装对象 {id, parameters, structure}，
 * 与对手条目（纯参数对象）的结构不同，两类席位分别解包。 */
export function versionsForSeats(candidateSeats, candidate, opponents, seedIndex, seatCount) {
  if (seatCount < MIN_SEAT_COUNT || seatCount > MAX_SEAT_COUNT) {
    throw new Error(`seatCount 必须在 ${MIN_SEAT_COUNT}..${MAX_SEAT_COUNT}（引擎 1 人类代理 + 最多 4 AI），实际：${seatCount}`);
  }
  if (!candidate?.parameters) throw new Error('candidate 必须为 championVersion 包装对象（含 parameters）');
  const poolSize = opponents.length;
  if (poolSize < 2) throw new Error('对手池至少需要 2 个版本（否则轮换塌缩）');
  return Array.from({ length: seatCount }, (_, seat) => {
    if (candidateSeats.includes(seat)) {
      return { id: candidate.id, parameters: candidate.parameters, structure: candidate.structure };
    }
    const opponentIndex = (poolSize - 1) * ((seedIndex + seat) % poolSize) % poolSize;
    const opponent = opponents[opponentIndex];
    return { id: opponent.id, parameters: opponent, structure: opponent.structure };
  });
}

/** 冠军阵营单局指标（镜像配置下 opponentMeanScore = 其余席位均值，仅参考）。 */
function championGameMetrics(result, championSeats, seatCount) {
  const rankOfSeat = new Map(result.ranking.map((r, idx) => [r.seat, idx + 1]));
  const scoreOfSeat = new Map(result.ranking.map(r => [r.seat, r.score]));
  const golemsOfSeat = new Map(result.ranking.map(r => [r.seat, r.golems]));
  const championScores = championSeats.map(s => scoreOfSeat.get(s));
  const opponentSeats = Array.from({ length: seatCount }, (_, i) => i).filter(s => !championSeats.includes(s));
  const opponentScores = opponentSeats.map(s => scoreOfSeat.get(s));
  return {
    championWon: championSeats.some(s => rankOfSeat.get(s) === 1),
    championMeanRank: championSeats.reduce((s, x) => s + rankOfSeat.get(x), 0) / championSeats.length,
    championMeanScore: championScores.reduce((s, x) => s + x, 0) / championSeats.length,
    championMeanGolems: championSeats.reduce((s, x) => s + golemsOfSeat.get(x), 0) / championSeats.length,
    opponentMeanScore: opponentScores.length
      ? opponentScores.reduce((s, x) => s + x, 0) / opponentScores.length
      : null,
    winnerSeat: result.winnerSeat,
    moves: result.moves,
    wallMs: result.wallMs,
    totalDecisionMs: result.metrics?.totalDecisionMs ?? 0,
    decisionCount: result.metrics?.seats.reduce((s, x) => s + x.decisionCount, 0) ?? 0,
    // 终局逐席位名次行（镜像座位公平性分解用）：seat / score / golems。
    rankingRows: result.ranking.map(r => ({ seat: r.seat, score: r.score, golems: r.golems })),
  };
}

/** 运行一批对局的公共路径：逐局记录 + 决策采样 + 异常记账。
 * seedPairs 仅在双方向（配对）计划中构建——镜像配置是单方向，无配对语义。 */
function runGames({ gamePlan, collectDecisions, maxMoves, deadlineMs }) {
  const games = [];
  const seedPairs = [];
  const decisionSamples = [];
  let anomalies = 0;
  for (const plan of gamePlan) {
    const finishedMetrics = [];
    let seedAnomalies = 0;
    for (const entry of plan.directions) {
      const result = simulateGame({
        seed: plan.seed,
        versions: entry.versions,
        seatCount: plan.seatCount,
        maxMoves,
        deadlineMs,
        collectDecisions,
      });
      if (result.status !== 'finished') {
        anomalies += 1;
        seedAnomalies += 1;
        games.push({
          seed: plan.seed, direction: entry.direction, seatCount: plan.seatCount,
          status: result.status, reason: result.reason, championSeats: entry.championSeats,
        });
        continue;
      }
      const metrics = championGameMetrics(result, entry.championSeats, plan.seatCount);
      games.push({
        seed: plan.seed, direction: entry.direction, seatCount: plan.seatCount,
        status: 'finished', championSeats: entry.championSeats,
        versionsIds: entry.versions.map(v => v?.id ?? 'baseline'),
        ...metrics,
      });
      if (collectDecisions && result.decisionSamplesMs) decisionSamples.push(...result.decisionSamplesMs);
      finishedMetrics.push(metrics);
    }
    if (plan.directions.length > 1) {
      if (seedAnomalies === 0) {
        const diff = finishedMetrics.reduce((s, m) => s + (m.championMeanScore - m.opponentMeanScore), 0) / finishedMetrics.length;
        seedPairs.push({ seed: plan.seed, status: 'finished', diff: Number(diff.toFixed(4)), anomalies: 0 });
      } else {
        seedPairs.push({ seed: plan.seed, status: 'anomaly', diff: null, anomalies: seedAnomalies });
      }
    }
  }
  return { games, seedPairs, decisionSamples, anomalies };
}

/** 汇总一批对局（全部基准指标）。 */
function summarize({ config, seatCount, games, seedPairs, decisionSamples, anomalies, seedBase, seedCount, opponentPool, extra = {} }) {
  const finished = games.filter(g => g.status === 'finished');
  const summary = {
    config,
    seatCount,
    championId: opponentPool.championId,
    opponents: opponentPool.ids,
    seedBase,
    seedCount,
    totalGames: games.length,
    finishedGames: finished.length,
    anomalies,
    anomalyRate: games.length ? Number((anomalies / games.length).toFixed(4)) : 0,
    anomalyReasons: Object.entries(games.filter(g => g.status !== 'finished').reduce((acc, g) => {
      const key = g.reason?.replace(/ seed.*$/, '').slice(0, 80) ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})),
  };

  if (finished.length > 0) {
    const wallMs = finished.reduce((s, g) => s + g.wallMs, 0);
    const decisionMs = finished.reduce((s, g) => s + g.totalDecisionMs, 0);
    const moves = finished.reduce((s, g) => s + g.moves, 0);
    const decisions = finished.reduce((s, g) => s + g.decisionCount, 0);
    summary.throughput = {
      meanWallMsPerGame: Number((wallMs / finished.length).toFixed(1)),
      gamesPerHourSingleCore: Math.floor(3_600_000 / (wallMs / finished.length)),
      meanMovesPerGame: Number((moves / finished.length).toFixed(1)),
      meanDecisionsPerGame: Number((decisions / finished.length).toFixed(1)),
      // 引擎状态迁移速率估算：总迁移数 ÷（墙钟 − AI 决策时间）；纯引擎微基准见 perf.mjs。
      engineTransitionsPerSecEstimate: wallMs > decisionMs
        ? Math.round(moves / ((wallMs - decisionMs) / 1000))
        : null,
    };
    summary.latency = latencySummary(decisionSamples);
    if (decisionSamples.length > 0) {
      summary.latency.p995Ms = Number(percentile([...decisionSamples].sort((a, b) => a - b), 0.995).toFixed(3));
    }
  }

  if (config === 'contest' && finished.length > 0) {
    // primary：第一名率（种子聚类 bootstrap 主区间 + Wilson 独立样本参考区间）。
    // 保留 direction / championSeats 供 byDirection / bySeat 分解。
    const firstPlaceGames = finished.map(g => ({
      seed: g.seed, firstPlace: g.championWon,
      direction: g.direction, championSeats: g.championSeats,
    }));
    const wins = finished.filter(g => g.championWon).length;
    summary.firstPlace = {
      ...firstPlaceMetric(firstPlaceGames),
      wilsonRef: wilsonCI(wins, finished.length),
      byDirection: firstPlaceBy(firstPlaceGames, g => g.direction ?? 'mirror'),
      bySeat: firstPlaceBy(firstPlaceGames, g => g.championSeats.join('+')),
    };
    summary.meanRank = meanRank(finished.map(g => g.championMeanRank));
    summary.meanRankCI = meanCI(finished.map(g => g.championMeanRank));
    summary.meanScore = Number((finished.reduce((s, g) => s + g.championMeanScore, 0) / finished.length).toFixed(2));
    summary.meanScoreDiff = Number((finished.reduce((s, g) => s + (g.championMeanScore - g.opponentMeanScore), 0) / finished.length).toFixed(4));
    summary.meanScoreDiffCI = meanCI(finished.map(g => g.championMeanScore - g.opponentMeanScore));
    summary.meanGolems = Number((finished.reduce((s, g) => s + g.championMeanGolems, 0) / finished.length).toFixed(3));

    // 对手风格分解：冠军在某对手版本出现的对局中的第一名率（方向 A/B 合并）。
    const presence = {};
    for (const g of finished) {
      for (const [seatIdx, id] of g.versionsIds.entries()) {
        if (g.championSeats.includes(seatIdx)) continue;
        const bucket = presence[id] ?? { games: 0, championFirstPlace: 0 };
        bucket.games += 1;
        if (g.championWon) bucket.championFirstPlace += 1;
        presence[id] = bucket;
      }
    }
    summary.byOpponentStyle = Object.fromEntries(
      Object.entries(presence).map(([id, b]) => [id, {
        gamesPresent: b.games,
        championFirstPlaceRate: Number((b.championFirstPlace / b.games).toFixed(4)),
      }]),
    );
  }

  if (config === 'mirror' && finished.length > 0) {
    // 座位公平性：每席位第一名率期望 1/N，偏离 = 座位优势信号。
    const perSeat = {};
    for (const g of finished) {
      const scoreOfSeat = new Map(g.rankingRows.map(r => [r.seat, r.score]));
      for (let seat = 0; seat < seatCount; seat++) {
        const bucket = perSeat[seat] ?? { games: 0, firstPlace: 0, scoreSum: 0 };
        bucket.games += 1;
        bucket.scoreSum += scoreOfSeat.get(seat) ?? 0;
        if (g.winnerSeat === seat) bucket.firstPlace += 1;
        perSeat[seat] = bucket;
      }
    }
    summary.seatFairness = Object.fromEntries(Object.entries(perSeat).map(([seat, b]) => [seat, {
      games: b.games,
      firstPlaceRate: Number((b.firstPlace / b.games).toFixed(4)),
      expected: Number((1 / seatCount).toFixed(4)),
      meanScore: Number((b.scoreSum / b.games).toFixed(2)),
    }]));
    summary.maxSeatDeviation = Math.max(...Object.values(summary.seatFairness).map(s => Math.abs(s.firstPlaceRate - s.expected)));
  }

  // 辅助指标：配对得分优势（保留 challenge.mjs 语义，仅披露不判定）。
  summary.pairedScoreAdvantage = pairedDiffSummary(seedPairs);

  summary.games = games;
  summary.seedPairs = seedPairs;
  Object.assign(summary, extra);
  return summary;
}

/** 单局确定性结果指纹：剔除一切计时/遥测字段，同种子同配置必然相同。
 * 复放校验（replay）与回归测试用它比对"对局结果是否逐位一致"。 */
export function outcomeKey(game) {
  return JSON.stringify({
    seed: game.seed, direction: game.direction, seatCount: game.seatCount,
    status: game.status, winnerSeat: game.winnerSeat, moves: game.moves,
    rankingRows: game.rankingRows, versionsIds: game.versionsIds,
    championSeats: game.championSeats, reason: game.reason ?? null,
  });
}

/** 镜像基准：全部席位 = 冠军。 */
export function runMirrorBaseline({ champion, seatCount, seeds, seedBase, maxMoves, deadlineMs, collectDecisions = true }) {
  const version = championVersion(champion);
  const versions = Array.from({ length: seatCount }, () => version);
  const gamePlan = Array.from({ length: seeds }, (_, i) => ({
    seed: seedBase + i,
    seatCount,
    directions: [{
      direction: 'mirror',
      championSeats: Array.from({ length: seatCount }, (_, s) => s),
      versions,
    }],
  }));
  const { games, seedPairs, decisionSamples, anomalies } = runGames({ gamePlan, collectDecisions, maxMoves, deadlineMs });
  return summarize({
    config: 'mirror', seatCount, games, seedPairs, decisionSamples, anomalies,
    seedBase, seedCount: seeds, opponentPool: { ids: [version.id], championId: version.id },
  });
}

/** 对抗基准：双向配对（A: 冠军 1 席轮转；B: 冠军 N-1 席）+ 对手池轮换。 */
export function runContestBaseline({ champion, seatCount, seeds, seedBase, opponents, maxMoves, deadlineMs, collectDecisions = true }) {
  const candidate = championVersion(champion);
  const pool = opponents ?? baselineOpponentPool(champion);
  if (pool.some(o => o.id === candidate.id)) {
    throw new Error(`对手池不得包含冠军本体（冠军 vs 冠军属于 mirror 配置）：${candidate.id}`);
  }
  const championSeatsA = i => [i % seatCount];
  const championSeatsB = i => Array.from({ length: seatCount }, (_, s) => s).filter(s => s !== i % seatCount);
  const gamePlan = Array.from({ length: seeds }, (_, i) => ({
    seed: seedBase + i,
    seatCount,
    directions: [
      { direction: 'A', championSeats: championSeatsA(i), versions: versionsForSeats(championSeatsA(i), candidate, pool, i, seatCount) },
      { direction: 'B', championSeats: championSeatsB(i), versions: versionsForSeats(championSeatsB(i), candidate, pool, i, seatCount) },
    ],
  }));
  const { games, seedPairs, decisionSamples, anomalies } = runGames({ gamePlan, collectDecisions, maxMoves, deadlineMs });
  // 轮换覆盖断言：方向 A 的冠军席位必须遍历全部座位。
  const coveredSeats = new Set(gamePlan.map(p => p.directions[0].championSeats[0]));
  if (coveredSeats.size !== Math.min(seatCount, seeds)) {
    throw new Error(`座位轮换覆盖异常（覆盖 ${[...coveredSeats].sort().join(',')} / 种子数 ${seeds}）`);
  }
  return summarize({
    config: 'contest', seatCount, games, seedPairs, decisionSamples, anomalies,
    seedBase, seedCount: seeds,
    opponentPool: { ids: pool.map(o => o.id), championId: candidate.id },
  });
}
