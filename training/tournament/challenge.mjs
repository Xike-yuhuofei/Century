/** 冠军挑战锦标赛（任务书第七节）。
 *
 * 实验设计（控制初始牌库随机性、座位优势、策略人格与过拟合）：
 * - 双向混战：方向 A 候选占 1 席 + 对手占 N−1 席；方向 B 候选占 N−1 席 + 对手占 1 席。
 *   合并后候选的公平先名率期望恰为 0.5（(1/N + (N−1)/N) / 2）。
 * - 配对种子：同一 seed 的两局共享同一洗牌序列，消除牌运差异（配对比较）。
 * - 座位轮换：席位随 seedIndex 轮转（seat = seedIndex % seatCount），覆盖全部座位。
 * - 策略人格：人格按正式游戏席位映射显式注入（席位 0 中立代理 + 席位 1..N−1 人格轮换），
 *   与正式游戏逐席一致。
 * - 对手池（审计整改）：默认对手 = 冠军；可传入多样化对手池（风格变体/历史冠军），
 *   避免候选只学会击败单一版本。晋级确认挑战保持"冠军独占对手"，语义干净。
 * - 统计检验（审计整改）：同 seed 双向对局共享洗牌序列，是配对样本而非独立样本；
 *   晋级判定按 seed 配对聚合（pairedPromotionDecision），不再把 2×seeds 局当独立样本。
 * - P0-5 整改：seatCount 参数化（2–5 人局）——正式挑战协议历史上硬编码 5 人，
 *   JS5 全人数部署后晋级证据无法覆盖相同口径的全部人数。每种人数单独成次挑战
 *   （跨人数绝不合并样本/合并判定）；主统计量按人数定义（见 PRIMARY_METRIC）。
 */

import { simulateGame } from '../simulator/simulate.mjs';
import { pairedPromotionDecision, firstPlaceStats, wilsonCI, meanCI, alphaSpendingThreshold, PROMOTION_ALPHA_BUDGET, Z_95 } from '../evaluator/stats.mjs';

/** 挑战席位数约束（引擎要求至少 1 人类代理席）。 */
export const MIN_SEAT_COUNT = 2;
export const MAX_SEAT_COUNT = 5;

/** 每种人数的主要统计量定义（P0-5：按人数明确口径；跨人数不得合并）。
 * - 决定性晋级统计量（全部人数统一）：配对得分优势率（决定性种子中双向平均
 *   分差 > 0 的比例；pairedPromotionDecision 消费）；
 * - 2 人局：方向 A = 头对头先名率（1 席 vs 1 席，机会基准 0.5）；
 * - ≥3 人局：方向 A = 单席位先名率（机会基准 1/N）；方向 B = N−1 席阵营先名率
 *   （机会基准 (N−1)/N），分开披露不合并。 */
export const PRIMARY_METRIC = Object.freeze({
  pairedScoreAdvantage: '决定性晋级统计量（全部人数统一，几何 alpha 消耗）',
  2: 'directionA 头对头先名率（机会基准 0.5）',
  3: 'directionA 单席位先名率（机会基准 1/3）；directionB 阵营先名率（2/3）分列',
  4: 'directionA 单席位先名率（机会基准 1/4）；directionB 阵营先名率（3/4）分列',
  5: 'directionA 单席位先名率（机会基准 1/5）；directionB 阵营先名率（4/5）分列',
});

/** 席位版本分配（含对手池轮换，导出供轮换分布回归测试）。
 *
 * 对手轮换（P1 可靠性整改）：旧公式 `(seedIndex×5+seat) % pool.length` 在池大小
 * 为 5（默认）时塌缩为 `seat % 5`——每个席位的对手在所有种子上固定不变，
 * "风格跨席位轮换"名存实亡。新公式取 `(池大小−1)×(seedIndex+seat) mod 池大小`
 * （即 −(seedIndex+seat) mod L，步长 L−1 与 L 恒互素）：
 * - 任何池大小下，每个席位的对手都随 seedIndex 遍历全池（确定性、可复现）；
 * - 池 ≥ N 时同一局内各对手席位拿到互不相同的对手（席位差 < N ≤ 池大小）；
 * - 分配只依赖 (seedIndex, seat)，与方向 A/B 无关——同一 seed 双向对局的
 *   同席位对手完全一致，保持配对设计的可比性（只差候选席位数）；
 * - 池首（冠军本体）经轮换会以对手身份出现在席位 1..N−1；f=0 ⇔ i ≡ −s (mod L)，
 *   此时席位 s = 候选席仅当 s=0 且 i≡0，故冠军永远不会在候选席位上"自己对抗自己"。 */
export function versionsFor(candidateSeats, candidate, opponents, seedIndex, seatCount = 5) {
  const poolSize = opponents.length;
  return Array.from({ length: seatCount }, (_, seat) => {
    if (candidateSeats.includes(seat)) {
      // 显式适配器候选（AI6：champion-guided 联合搜索等）：adapter/budgetMs 等
      // 注入字段透传到 version 顶层（模拟器按 version.adapter 分派）；无 adapter
      // 字段的参数/结构候选行为逐字节不变。
      return {
        id: candidate.id, parameters: candidate, structure: candidate.structure,
        ...(candidate.adapter ? { adapter: candidate.adapter, jointVersion: candidate.jointVersion, budgetMs: candidate.budgetMs, gateMode: candidate.gateMode } : {}),
      };
    }
    const opponentIndex = (poolSize - 1) * ((seedIndex + seat) % poolSize) % poolSize;
    const opponent = opponents[opponentIndex];
    return { id: opponent.id, parameters: opponent, structure: opponent.structure };
  });
}

/** 候选席位的逐局指标。 */
function candidateGameMetrics(result, candidateSeats, seatCount) {
  const rows = result.ranking; // 按 final rank 排序
  const rankOfSeat = new Map(rows.map((r, idx) => [r.seat, idx + 1]));
  const scoreOfSeat = new Map(rows.map(r => [r.seat, r.score]));
  const golemsOfSeat = new Map(rows.map(r => [r.seat, r.golems]));
  const candidateScores = candidateSeats.map(s => scoreOfSeat.get(s));
  const opponentSeats = Array.from({ length: seatCount }, (_, i) => i).filter(s => !candidateSeats.includes(s));
  const opponentScores = opponentSeats.map(s => scoreOfSeat.get(s));
  return {
    candidateWon: candidateSeats.some(s => rankOfSeat.get(s) === 1),
    candidateMeanScore: candidateScores.reduce((s, x) => s + x, 0) / candidateSeats.length,
    candidateMeanRank: candidateSeats.reduce((s, x) => s + rankOfSeat.get(x), 0) / candidateSeats.length,
    candidateMeanGolems: candidateSeats.reduce((s, x) => s + golemsOfSeat.get(x), 0) / candidateSeats.length,
    opponentMeanScore: opponentScores.reduce((s, x) => s + x, 0) / opponentScores.length,
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
 * @param {Array<object>} [options.opponents] 对手池（默认仅冠军）；非候选席位按 (seedIndex×(池大小−1)+seat) 轮转取池内对手，任何池大小下逐种子轮换
 * @param {number} [options.maxMoves] 单局步数上限
 * @param {number} [options.deadlineMs] 单局时间预算
 */
export function runChallenge({ champion, candidate, seeds, seedBase = 1, seatCount = 5, opponents = null, maxMoves, deadlineMs }) {
  if (!champion?.id || !candidate?.id) throw new Error('champion/candidate 必须带 id 的参数对象');
  if (champion.id === candidate.id) throw new Error('候选与冠军 id 不得相同');
  if (!Number.isSafeInteger(seatCount) || seatCount < MIN_SEAT_COUNT || seatCount > MAX_SEAT_COUNT) {
    throw new Error(`seatCount 必须在 ${MIN_SEAT_COUNT}..${MAX_SEAT_COUNT}，实际：${seatCount}`);
  }
  const pool = opponents?.length ? opponents : [champion];
  if (pool.some(o => o.id === candidate.id)) throw new Error('对手池不得包含候选参数');
  const games = [];
  const seedPairs = [];
  let anomalies = 0;
  for (let i = 0; i < seeds; i++) {
    const seed = seedBase + i;
    const seat = i % seatCount;
    // 方向 A：候选 1 席；方向 B：候选 N−1 席（配对种子，同 seed 同洗牌）。
    const candidateSeatsA = [seat];
    const candidateSeatsB = Array.from({ length: seatCount }, (_, s) => s).filter(s => s !== seat);
    const roundRobin = [
      ['A', versionsFor(candidateSeatsA, candidate, pool, i, seatCount), candidateSeatsA],
      ['B', versionsFor(candidateSeatsB, candidate, pool, i, seatCount), candidateSeatsB],
    ];
    const finishedMetrics = [];
    let seedAnomalies = 0;
    for (const [direction, versions, candidateSeats] of roundRobin) {
      const result = simulateGame({ seed, versions, seatCount, maxMoves, deadlineMs });
      if (result.status !== 'finished') {
        anomalies += 1;
        seedAnomalies += 1;
        games.push({ seed, direction, status: result.status, reason: result.reason });
        continue;
      }
      const metrics = candidateGameMetrics(result, candidateSeats, seatCount);
      games.push({ seed, direction, status: 'finished', ...metrics });
      finishedMetrics.push(metrics);
    }
    // 同 seed 配对聚合：两方向均分差合并为一个配对样本（洗牌序列相同，只差候选席位数）。
    if (seedAnomalies === 0) {
      const diff = finishedMetrics.reduce((s, m) => s + (m.candidateMeanScore - m.opponentMeanScore), 0) / finishedMetrics.length;
      seedPairs.push({ seed, status: 'finished', diff: Number(diff.toFixed(4)), anomalies: 0 });
    } else {
      seedPairs.push({ seed, status: 'anomaly', diff: null, anomalies: seedAnomalies });
    }
  }
  const finished = games.filter(g => g.status === 'finished');
  const finishedPairs = seedPairs.filter(p => p.status === 'finished');
  const wins = finished.filter(g => g.candidateWon).length;
  const summary = {
    champion: champion.id,
    candidate: candidate.id,
    // P0-5：人数与主统计量口径随证据披露；一次挑战只覆盖一种人数。
    seatCount,
    primaryMetric: PRIMARY_METRIC[seatCount],
    opponents: pool.map(o => o.id),
    seeds,
    totalGames: games.length,
    finishedGames: finished.length,
    anomalies,
    anomalyRate: games.length ? Number((anomalies / games.length).toFixed(4)) : 0,
    candidateWins: wins,
    // candidateWinRate 即"合并第一名率"（候选阵营 rank-1 局占比），语义细节见 firstPlace。
    candidateWinRate: finished.length ? Number((wins / finished.length).toFixed(4)) : 0,
    seedBase,
    // 真实第一名率（P1 复审：与配对得分优势率严格区分，随证据披露）。
    firstPlace: firstPlaceStats(games),
    // P0-5：方向分列先名率（A=单席位口径 / B=阵营口径；机会基准 1/N 与 (N−1)/N）。
    firstPlaceByDirection: Object.fromEntries(['A', 'B'].map(dir => {
      const rows = finished.filter(g => g.direction === dir);
      return [dir, {
        games: rows.length,
        wins: rows.filter(g => g.candidateWon).length,
        chanceBaseline: dir === 'A' ? 1 / seatCount : (seatCount - 1) / seatCount,
        wilson: rows.length ? wilsonCI(rows.filter(g => g.candidateWon).length, rows.length) : null,
      }];
    })),
    paired: {
      seeds,
      finished: finishedPairs.length,
      won: finishedPairs.filter(p => p.diff > 0).length,
      lost: finishedPairs.filter(p => p.diff < 0).length,
      tied: finishedPairs.filter(p => p.diff === 0).length,
    },
  };
  if (finished.length) {
    summary.winCI = wilsonCI(wins, finished.length);
    summary.meanScoreDiffCI = meanCI(finished.map(g => g.candidateMeanScore - g.opponentMeanScore));
    summary.meanRankCI = meanCI(finished.map(g => g.candidateMeanRank));
    summary.meanGolems = Number((finished.reduce((s, g) => s + g.candidateMeanGolems, 0) / finished.length).toFixed(3));
    summary.meanMoves = Number((finished.reduce((s, g) => s + g.moves, 0) / finished.length).toFixed(1));
    summary.meanDecisionMs = Number((finished.reduce((s, g) => s + g.totalDecisionMs, 0) / finished.length).toFixed(1));
  }
  if (finishedPairs.length) {
    summary.pairedDiffCI = meanCI(finishedPairs.map(p => p.diff));
  }
  summary.seedPairs = seedPairs;
  return { summary, games };
}

/** 完整挑战：含晋级判定（按种子配对统计 + alpha 消耗多重检验控制）。
 * minSeeds：决定性配对种子下限（默认 60 = 120 局）。
 * 晋级统计量为「配对得分优势率」（决定性种子中双向平均分差 > 0 的比例），
 * 不是第一名概率；真实第一名率随 summary.firstPlace 一并披露。
 * 对手池缺省 = 仅冠军，保证晋级语义是"胜过当前冠军"。
 *
 * challengeIndex（P0 可靠性整改）：本次确认挑战是系统终身第几次挑战（来自验证
 * 账本 challengeCount + 1）。传入后按几何 alpha 消耗收紧检验阈值（α_k = 预算/2^k），
 * 控制长期重复挑战的家族误晋级率 ≤ 预算（默认 5%）；判定对象携带
 * challengeIndex / alpha / alphaBudget / z 供晋级脚本独立重算。不传（手动诊断）时
 * 维持 95% 单次检验，其结论不得作为晋级证据。 */
export function challengeWithDecision({ champion, candidate, seeds, seedBase = 1, seatCount = 5, minSeeds = 60, maxAnomalyRate = 0.02, opponents = null, challengeIndex = null, alphaBudget = PROMOTION_ALPHA_BUDGET, maxMoves, deadlineMs }) {
  const { summary, games } = runChallenge({ champion, candidate, seeds, seedBase, seatCount, opponents, maxMoves, deadlineMs });
  const threshold = challengeIndex !== null
    ? alphaSpendingThreshold(challengeIndex, { alphaBudget })
    : null;
  summary.decision = pairedPromotionDecision({
    seedPairs: summary.seedPairs,
    minSeeds,
    maxAnomalyRate,
    z: threshold?.z ?? Z_95,
  });
  if (threshold) {
    summary.decision.challengeIndex = threshold.challengeIndex;
    summary.decision.alpha = threshold.alpha;
    summary.decision.alphaBudget = threshold.alphaBudget;
  }
  return { summary, games };
}
