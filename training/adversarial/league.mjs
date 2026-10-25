/** 对抗性联赛·自动联赛框架（overnight-adversarial-league）。
 *
 * 职责：
 * 1. 单局对局循环：任一席位可注入注册表中任意版本（三决策核心按席位隔离
 *    分派——champion-guided / beam-search / random-legal），全部经正式引擎
 *    编译产物（web-v1/dist/js）推进，非法行动由引擎裁决为异常局；
 * 2. 赛程生成：确定性、可复现、种子不重叠（sequentialSeeds 顺序切片），
 *    支持 2–5 人局；焦点版本席位随 seedIndex 轮转覆盖全部座位；
 * 3. 胜率矩阵：matrix[A][B] = P(A 第一名 | A 占 1 席、其余 N−1 席全为 B，
 *    座位与种子轮转)。2 人局头对头一次对局同时填充 matrix[A][B] 与
 *    matrix[B][A]（互补计数）；3 人及以上双向对局分别跑；
 * 4. 完整实验元数据：注册表快照（全部版本指纹 + 注册表指纹 + 引擎产物指纹）、
 *    种子块、运行时选项、异常局严格分离。
 *
 * 指标语义（与 PR #22/挑战管道一致）：一级指标 = 焦点版本席位第一名率
 * （Wilson CI + 按种子聚类 bootstrap），方向/座位分解披露；异常局绝不计入胜率。
 */

import { createGame, applyAction, score as engineScore, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE, validateAIParameters } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { assertInBlock, sequentialSeeds } from '../../ai5/lib/seed_policy.mjs';
import { engineBundleSha256 } from '../lib/paths.mjs';
import { toSeatVersion } from './registry.mjs';
import { randomLegalAction, seatRng } from './strategies.mjs';
import { wilsonCI } from '../evaluator/stats.mjs';
import { firstPlaceClusterCI } from '../baseline/stats.mjs';

export const MIN_SEAT_COUNT = 2;
export const MAX_SEAT_COUNT = 5; // 引擎约束：1 人类代理席 + 最多 4 AI 席
export const LEAGUE_REPORT_SCHEMA = 'century-adversarial-league-v2';

/** 席位人格映射（与 training/simulator/simulate.mjs 逐字一致）。 */
function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

/**
 * 单局对局：每席位独立版本注入（决策核心按席位隔离）。
 *
 * @param {object} options
 * @param {number} options.seed 引擎随机种子（洗牌与起始配置全部由此决定）
 * @param {number} options.seatCount 2–5
 * @param {Array<object>} options.seatVersions 每席位版本（toSeatVersion 形态，
 *   长度必须等于 seatCount）
 * @param {object|null} [options.jointOverrides] 冠军引导核心运行时覆盖
 *   （如冒烟用 {workUnits:64} 确定性快档；正式联赛 null = 冻结 budgetMs）
 * @param {number} [options.maxMoves] 单局步数上限（防死循环）
 * @param {number} [options.deadlineMs] 单局墙钟预算
 */
export function playLeagueGame({ seed, seatCount, seatVersions, jointOverrides = null, maxMoves = 1200, deadlineMs = 60_000 }) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed 必须为非负安全整数');
  if (seatCount < MIN_SEAT_COUNT || seatCount > MAX_SEAT_COUNT) {
    throw new Error(`seatCount 必须在 ${MIN_SEAT_COUNT}..${MAX_SEAT_COUNT}，实际：${seatCount}`);
  }
  if (!Array.isArray(seatVersions) || seatVersions.length !== seatCount) {
    throw new Error('seatVersions 长度必须等于 seatCount');
  }
  const anomaly = (reason, extra = {}) => ({
    status: 'anomaly', reason, seed, seatCount,
    versions: seatVersions.map(v => v.id), fingerprints: seatVersions.map(v => v.fingerprint),
    moves: 0, wallMs: 0, winnerSeat: null, ranking: [], ...extra,
  });
  let game;
  try {
    game = createGame(
      Array.from({ length: seatCount }, (_, i) => `席位${i}`),
      seed,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
    );
    game.players[0].isAI = true;
  } catch (error) {
    return anomaly(`createGame 失败：${error.message}`);
  }
  const seatRngs = new Map();
  const rngFor = seat => {
    if (!seatRngs.has(seat)) seatRngs.set(seat, seatRng(seed, seat));
    return seatRngs.get(seat);
  };
  const actionCounts = seatVersions.map(() => ({ acquire: 0, claim: 0, rest: 0, play: 0, discard: 0 }));
  // AI7-A2：每席位参数在入局前归一化一次；联合搜索席位显式接收该席位
  // 描述符参数（冻结版本不读活动冠军状态）。
  const seatParameters = seatVersions.map(v => (v.parameters ? validateAIParameters(v.parameters) : null));
  let moves = 0;
  const started = performance.now();
  const tick = () => performance.now() - started;
  try {
    while (game.phase !== 'finished') {
      if (moves >= maxMoves) return anomaly(`达到行动步数上限 ${maxMoves}（疑似死循环或无进展）`, { moves });
      if (tick() > deadlineMs) return anomaly(`超出单局时间预算 ${deadlineMs}ms`, { moves });
      const seat = game.current;
      const seatVersion = seatVersions[seat];
      let action;
      if (seatVersion.decisionCore === 'champion-guided') {
        const response = chooseJointAction(game, {
          version: seatVersion.jointVersion ?? 'joint-js5',
          ...(seatVersion.jointOptions ?? {}),
          ...(jointOverrides ?? {}),
          ...(seatParameters[seat] ? { championParameters: seatParameters[seat] } : {}),
          profile: seatProfile(seat),
        });
        action = response.action;
      } else if (seatVersion.decisionCore === 'random-legal') {
        action = randomLegalAction(game, rngFor(seat));
      } else if (seatVersion.decisionCore === 'beam-search') {
        const response = chooseAIAction(game, {
          parameters: seatVersion.parameters,
          ...(seatVersion.structure ? { structure: seatVersion.structure } : {}),
          profile: seatProfile(seat),
        });
        action = response.action;
      } else {
        throw new Error(`席位 ${seat} 未知决策核心：${String(seatVersion.decisionCore)}`);
      }
      const type = action.type;
      if (type in actionCounts[seat]) actionCounts[seat][type] += 1;
      game = applyAction(game, action);
      moves += 1;
    }
  } catch (error) {
    return anomaly(`对局异常：${error.message}`, {
      moves,
      wallMs: Number(tick().toFixed(2)),
      partialScores: game.players.map(p => engineScore(p)),
    });
  }
  const turnCounts = new Set(game.players.map(p => p.turns));
  if (turnCounts.size !== 1) {
    return anomaly('终局各席位回合数不一致，违反终局结算规则', { moves, wallMs: Number(tick().toFixed(2)) });
  }
  const ranked = ranking(game);
  return {
    status: 'finished',
    seed, seatCount,
    versions: seatVersions.map(v => v.id),
    fingerprints: seatVersions.map(v => v.fingerprint),
    moves,
    wallMs: Number(tick().toFixed(2)),
    winnerSeat: ranked[0].id,
    ranking: ranked.map(p => ({
      seat: p.id, score: engineScore(p), golems: p.claimed.length,
      turns: p.turns,
    })),
    actionCounts,
  };
}

/**
 * 生成确定性联赛赛程（胜率矩阵方向）。
 *
 * 语义：
 * - seatCount=2：无序对 {A,B} 一场头对头赛（A 为焦点，席位随 seedIndex 轮转），
 *   同一组对局同时填充 matrix[A][B] 与 matrix[B][A]（互补计数，方向 'h2h'）；
 * - seatCount≥3：每个有序对 (A,B) 一场（A 为焦点占 1 席，其余 N−1 席全 B，
 *   方向 'field'）——matrix[A][B] 与 matrix[B][A] 分别来自独立对局；
 * - 种子：每场 matchId 分配 seedsPerPair 个连续种子（sequentialSeeds 顺序切片），
 *   场与场绝不重叠；全部种子强制落在他块内（assertInBlock）。
 *
 * @param {object} options
 * @param {string[]} options.versionIds 参赛版本 id（注册表内须存在）
 * @param {number[]} options.seatCounts 2–5 的子集（如 [2,3,5]）
 * @param {number} options.seedsPerPair 每场种子数（≥1）
 * @param {number} options.seedBase 起始种子
 * @param {number[]} options.block 种子块 [start, end)（越界抛错）
 */
export function planMatrix({ versionIds, seatCounts, seedsPerPair, seedBase, block }) {
  if (!Array.isArray(versionIds) || versionIds.length < 2 || new Set(versionIds).size !== versionIds.length) {
    throw new Error('versionIds 必须为 ≥2 个互不重复的版本 id');
  }
  if (!Array.isArray(seatCounts) || seatCounts.length === 0) throw new Error('seatCounts 不能为空');
  for (const n of seatCounts) {
    if (n < MIN_SEAT_COUNT || n > MAX_SEAT_COUNT) throw new Error(`seatCount 必须在 ${MIN_SEAT_COUNT}..${MAX_SEAT_COUNT}，实际：${n}`);
  }
  if (!Number.isSafeInteger(seedsPerPair) || seedsPerPair < 1) throw new Error('seedsPerPair 必须为正整数');
  const matches = [];
  let cursor = seedBase;
  const allocate = (matchId, count) => {
    const seeds = sequentialSeeds(block, cursor, count);
    for (const s of seeds) assertInBlock(s, block, `联赛种子（${matchId}）`);
    const seedStart = cursor;
    cursor += count;
    return { seeds, seedStart };
  };
  for (const seatCount of seatCounts) {
    for (let i = 0; i < versionIds.length; i++) {
      for (let j = i + 1; j < versionIds.length; j++) {
        const a = versionIds[i]; const b = versionIds[j];
        if (seatCount === 2) {
          const matchId = `${a}--vs--${b}@2`;
          matches.push({ matchId, focusId: a, opponentId: b, seatCount, direction: 'h2h', ...allocate(matchId, seedsPerPair) });
        } else {
          for (const [focusId, opponentId] of [[a, b], [b, a]]) {
            const matchId = `${focusId}--vs--${opponentId}@${seatCount}`;
            matches.push({ matchId, focusId, opponentId, seatCount, direction: 'field', ...allocate(matchId, seedsPerPair) });
          }
        }
      }
    }
  }
  return {
    schema: 'century-adversarial-league-plan-v1',
    versionIds: [...versionIds], seatCounts: [...seatCounts],
    seedsPerPair, seedBase, seedEnd: cursor, block: [...block],
    matches,
  };
}

/** 单场对局的席位版本分配：焦点占 1 席（seat = seedIndex % seatCount，轮转覆盖
 * 全部座位），其余席位全为对手版本。 */
export function matchSeats(focus, opponent, seatCount, seedIndex) {
  const focusSeat = seedIndex % seatCount;
  return { focusSeat, seatVersions: Array.from({ length: seatCount }, (_, seat) => (seat === focusSeat ? focus : opponent)) };
}

/** 运行赛程（全部对局）。jointOverrides 透传 playLeagueGame。 */
export function runPlan(plan, registry, { jointOverrides = null, maxMoves = 1200, deadlineMs = 60_000 } = {}) {
  const games = [];
  for (const match of plan.matches) {
    const focus = toSeatVersion(registry.versions[match.focusId]);
    const opponent = toSeatVersion(registry.versions[match.opponentId]);
    for (let i = 0; i < match.seeds.length; i++) {
      const seed = match.seeds[i];
      const { focusSeat, seatVersions } = matchSeats(focus, opponent, match.seatCount, i);
      const result = playLeagueGame({ seed, seatCount: match.seatCount, seatVersions, jointOverrides, maxMoves, deadlineMs });
      games.push({
        matchId: match.matchId, direction: match.direction,
        focusId: match.focusId, opponentId: match.opponentId, focusSeat,
        ...result,
      });
    }
  }
  return games;
}

/** 胜率矩阵（来自 runPlan 的对局行）——P0-3 整改：按 (seatCount, matchProtocol)
 * 严格分层，禁止跨人数/跨协议合并。
 *
 * 缺陷背景（PR #40 实锤）：v1 矩阵以 (焦点版本, 对手版本) 为汇总键——同一对的
 * 2p 头对头（h2h）与 5p 有向场（field）被合并进同一 cell（如 js5 vs style-engine
 * n=30 = 15 h2h + 15 field）。不同人数下第一名机会基准不同（1/2 vs 1/5），
 * 合并 Wilson 区间不可作强度判据（PR #40 报告因此误读 style-engine 显著性）。
 *
 * v2 结构：matrix[A][B].byProtocol[`${direction}@${seatCount}`] =
 * { protocol, seatCount, games, wins, firstPlaceRate, wilson, bySeat,
 *   anomalies, focusFingerprints }。2p h2h 仍互补填充 A→B 与 B→A（同一组对局、
 * 各自独立统计）；≥3p field 只计焦点→对手方向。异常局不计入 games/wins，
 * 但按层披露 anomalies 计数。 */
export function buildWinRateMatrix(plan, games) {
  const cells = new Map(); // `${A}\u0000${B}\u0000${direction}@${seatCount}` → cell
  const cellOf = (A, B, direction, seatCount) => {
    const key = `${A}\u0000${B}\u0000${direction}@${seatCount}`;
    if (!cells.has(key)) {
      cells.set(key, {
        A, B, direction, seatCount, protocol: `${direction}@${seatCount}`,
        games: 0, wins: 0, anomalies: 0, seats: {}, focusFingerprints: new Set(),
      });
    }
    return cells.get(key);
  };
  for (const g of games) {
    const cell = cellOf(g.focusId, g.opponentId, g.direction, g.seatCount);
    const won = g.status === 'finished' && g.winnerSeat === g.focusSeat;
    if (g.status !== 'finished') {
      // 异常局：不计入 games/wins；h2h 局双方视角都披露该异常。
      cell.anomalies += 1;
      if (g.direction === 'h2h') cellOf(g.opponentId, g.focusId, 'h2h', g.seatCount).anomalies += 1;
      continue;
    }
    cell.games += 1;
    if (won) cell.wins += 1;
    if (Array.isArray(g.fingerprints) && g.fingerprints[0]) cell.focusFingerprints.add(g.fingerprints[0]);
    const seatKey = String(g.focusSeat);
    (cell.seats[seatKey] ??= { games: 0, wins: 0 });
    cell.seats[seatKey].games += 1;
    if (won) cell.seats[seatKey].wins += 1;
    if (g.direction === 'h2h') {
      const reverse = cellOf(g.opponentId, g.focusId, 'h2h', g.seatCount);
      reverse.games += 1;
      if (!won) reverse.wins += 1;
      if (Array.isArray(g.fingerprints) && g.fingerprints[0]) reverse.focusFingerprints.add(g.fingerprints[0]);
      const rSeatKey = String(g.seatCount - 1 - g.focusSeat); // 2p 对手席 = 1 - focusSeat
      (reverse.seats[rSeatKey] ??= { games: 0, wins: 0 });
      reverse.seats[rSeatKey].games += 1;
      if (!won) reverse.seats[rSeatKey].wins += 1;
    }
  }
  const matrix = {};
  for (const cell of cells.values()) {
    const rate = cell.games ? cell.wins / cell.games : null;
    const entry = {
      A: cell.A, B: cell.B,
      byProtocol: {
        [cell.protocol]: {
          protocol: cell.protocol, direction: cell.direction, seatCount: cell.seatCount,
          games: cell.games, wins: cell.wins,
          firstPlaceRate: rate === null ? null : Number(rate.toFixed(4)),
          wilson: cell.games ? wilsonCI(cell.wins, cell.games) : null,
          anomalies: cell.anomalies,
          focusFingerprints: [...cell.focusFingerprints].sort(),
          bySeat: Object.fromEntries(Object.entries(cell.seats).map(([seat, s]) => [
            seat, { games: s.games, wins: s.wins, firstPlaceRate: Number((s.wins / s.games).toFixed(4)) },
          ])),
        },
      },
    };
    // 合并同 (A,B) 的多个协议层（同方向同人数只会有一层；不同 seatCount 分层披露）。
    if (!matrix[cell.A]) matrix[cell.A] = {};
    if (!matrix[cell.A][cell.B]) {
      matrix[cell.A][cell.B] = entry;
    } else {
      Object.assign(matrix[cell.A][cell.B].byProtocol, entry.byProtocol);
    }
  }
  return matrix;
}

/** 读取分层矩阵单元（协议键 = `${direction}@${seatCount}`）；不存在返回 null。 */
export function matrixCell(matrix, A, B, direction, seatCount) {
  const entry = matrix?.[A]?.[B];
  if (!entry) return null;
  return entry.byProtocol[`${direction}@${seatCount}`] ?? null;
}

/** 联赛汇总报告（完整实验元数据）。 */
export function summarizeLeague({ plan, games, registry, jointOverrides = null, note = null }) {
  const finished = games.filter(g => g.status === 'finished');
  const anomalies = games.filter(g => g.status !== 'finished');
  return {
    schema: LEAGUE_REPORT_SCHEMA,
    date: new Date().toISOString(),
    engineBundleSha256: engineBundleSha256(),
    registrySnapshot: registry.snapshot,
    jointOverrides,
    plan: { ...plan, matches: plan.matches.map(m => ({ ...m, seeds: m.seeds.length })) },
    totals: {
      games: games.length, finished: finished.length,
      anomalies: anomalies.length,
      anomalyRate: games.length ? Number((anomalies.length / games.length).toFixed(4)) : 0,
      anomalyReasons: Object.entries(anomalies.reduce((acc, g) => {
        const key = (g.reason ?? 'unknown').replace(/ seed.*$/, '').slice(0, 80);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})),
      meanMoves: finished.length ? Number((finished.reduce((s, g) => s + g.moves, 0) / finished.length).toFixed(1)) : 0,
      meanWallMs: finished.length ? Number((finished.reduce((s, g) => s + g.wallMs, 0) / finished.length).toFixed(1)) : 0,
    },
    matrix: buildWinRateMatrix(plan, games),
    // 种子聚类 bootstrap 的一级指标按 match 披露（对齐 PR #22 口径）。
    matchSummaries: plan.matches.map(match => {
      const rows = games.filter(g => g.matchId === match.matchId);
      const finishedRows = rows.filter(g => g.status === 'finished');
      const clusterGames = finishedRows.map(g => ({
        seed: g.seed, firstPlace: g.winnerSeat === g.focusSeat, direction: 'A',
        candidateSeats: [g.focusSeat],
      }));
      return {
        matchId: match.matchId, focusId: match.focusId, opponentId: match.opponentId,
        seatCount: match.seatCount, direction: match.direction,
        seeds: match.seeds.length, finished: finishedRows.length, anomalies: rows.length - finishedRows.length,
        firstPlace: finishedRows.length ? firstPlaceClusterCI(clusterGames) : null,
      };
    }),
    games, // 逐局全披露（配对统计与审计复算必需）
    note,
  };
}
