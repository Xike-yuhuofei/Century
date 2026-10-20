/** 冠军挑战锦标赛（任务书第七节）。
 *
 * 实验设计（控制初始牌库随机性、座位优势、策略人格与过拟合）：
 * - 双向混战：方向 A 候选占 1 席 + 冠军占 4 席；方向 B 冠军占 1 席 + 候选占 4 席。
 *   合并后候选的公平先名率期望恰为 0.5（(1/5 + 4/5) / 2）。
 * - 配对种子：同一 seed 的两局共享同一洗牌序列，消除牌运差异（配对比较）。
 * - 座位轮换：席位随 seed 轮转（seat = seedIndex % seatCount），覆盖全部座位。
 * - 策略人格：人格由席位推导（第 n 个行动的 AI 对应第 n 种人格），
 *   候选与冠军在两个方向上都遍历全部人格席位。
 * - 训练/验证隔离：训练种子与确认种子由调用方分开指定，禁止用训练种子宣布晋级。
 */

import { simulateGame } from '../simulator/simulate.mjs';
import { promotionDecision, wilsonCI, meanCI } from '../evaluator/stats.mjs';

const SEAT_COUNT = 5;

function versionsFor(candidateSeats, candidate, champion) {
  return Array.from({ length: SEAT_COUNT }, (_, seat) =>
    candidateSeats.includes(seat)
      ? { id: candidate.id, parameters: candidate }
      : { id: champion.id, parameters: champion });
}

/** 候选席位的逐局指标。 */
function candidateGameMetrics(result, candidateSeats) {
  const rows = result.ranking; // 按 final rank 排序
  const rankOfSeat = new Map(rows.map((r, idx) => [r.seat, idx + 1]));
  const scoreOfSeat = new Map(rows.map(r => [r.seat, r.score]));
  const golemsOfSeat = new Map(rows.map(r => [r.seat, r.golems]));
  const candidateScores = candidateSeats.map(s => scoreOfSeat.get(s));
  const championSeats = Array.from({ length: SEAT_COUNT }, (_, i) => i).filter(s => !candidateSeats.includes(s));
  const championScores = championSeats.map(s => scoreOfSeat.get(s));
  const best = candidateSeats.filter(s => rankOfSeat.get(s) === 1).length > 0;
  return {
    candidateWon: best,
    candidateMeanScore: candidateScores.reduce((s, x) => s + x, 0) / candidateSeats.length,
    candidateMeanRank: candidateSeats.reduce((s, x) => s + rankOfSeat.get(x), 0) / candidateSeats.length,
    candidateMeanGolems: candidateSeats.reduce((s, x) => s + golemsOfSeat.get(x), 0) / candidateSeats.length,
    championMeanScore: championScores.reduce((s, x) => s + x, 0) / championScores.length,
    moves: result.moves,
    totalDecisionMs: result.metrics?.totalDecisionMs ?? 0,
  };
}

/**
 * 运行一次冠军挑战。
 * @param {object} options
 * @param {object} options.champion 冠军参数（AIParameters）
 * @param {object} options.candidate 候选参数（AIParameters）
 * @param {number} options.seeds 种子数量（每种子 2 局：双向）
 * @param {number} [options.seedBase] 种子起点
 * @param {number} [options.maxMoves] 单局步数上限
 * @param {number} [options.deadlineMs] 单局时间预算
 */
export function runChallenge({ champion, candidate, seeds, seedBase = 1, maxMoves, deadlineMs }) {
  if (!champion?.id || !candidate?.id) throw new Error('champion/candidate 必须带 id 的参数对象');
  if (champion.id === candidate.id) throw new Error('候选与冠军 id 不得相同');
  const games = [];
  let anomalies = 0;
  for (let i = 0; i < seeds; i++) {
    const seed = seedBase + i;
    const seat = i % SEAT_COUNT;
    // 方向 A：候选 1 席；方向 B：候选 4 席（配对种子，同 seed 同洗牌）。
    const directionA = versionsFor([seat], candidate, champion);
    const directionB = versionsFor(
      Array.from({ length: SEAT_COUNT }, (_, s) => s).filter(s => s !== seat),
      candidate, champion,
    );
    for (const [direction, versions] of [['A', directionA], ['B', directionB]]) {
      const result = simulateGame({ seed, versions, maxMoves, deadlineMs });
      if (result.status !== 'finished') {
        anomalies += 1;
        games.push({ seed, direction, status: result.status, reason: result.reason });
        continue;
      }
      const candidateSeats = direction === 'A' ? [seat]
        : Array.from({ length: SEAT_COUNT }, (_, s) => s).filter(s => s !== seat);
      games.push({ seed, direction, status: 'finished', ...candidateGameMetrics(result, candidateSeats) });
    }
  }
  const finished = games.filter(g => g.status === 'finished');
  const wins = finished.filter(g => g.candidateWon).length;
  const summary = {
    champion: champion.id,
    candidate: candidate.id,
    seeds,
    totalGames: games.length,
    finishedGames: finished.length,
    anomalies,
    anomalyRate: games.length ? Number((anomalies / games.length).toFixed(4)) : 0,
    candidateWins: wins,
    candidateWinRate: finished.length ? Number((wins / finished.length).toFixed(4)) : 0,
    seedBase,
  };
  if (finished.length) {
    summary.winCI = wilsonCI(wins, finished.length);
    summary.meanScoreDiffCI = meanCI(finished.map(g => g.candidateMeanScore - g.championMeanScore));
    summary.meanRankCI = meanCI(finished.map(g => g.candidateMeanRank));
    summary.meanGolems = Number((finished.reduce((s, g) => s + g.candidateMeanGolems, 0) / finished.length).toFixed(3));
    summary.meanMoves = Number((finished.reduce((s, g) => s + g.moves, 0) / finished.length).toFixed(1));
    summary.meanDecisionMs = Number((finished.reduce((s, g) => s + g.totalDecisionMs, 0) / finished.length).toFixed(1));
  }
  return { summary, games };
}

/** 完整挑战：含晋级判定。 */
export function challengeWithDecision({ champion, candidate, seeds, seedBase = 1, minGames = 100, maxAnomalyRate = 0.02, ...rest }) {
  const { summary, games } = runChallenge({ champion, candidate, seeds, seedBase, ...rest });
  summary.decision = promotionDecision({
    wins: summary.candidateWins,
    games: summary.finishedGames,
    anomalyRate: summary.anomalyRate,
    minGames,
    maxAnomalyRate,
  });
  return { summary, games };
}
