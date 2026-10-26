/** D3：开发池低成本评估（不消费正式验证池）。
 *
 * 数据分区：
 * - quick screen 只用 AI7 screen 窗口；
 * - deep confirm 只用 AI7 deep 窗口；
 * - 两个窗口集合必须互不相交（assertIndependentWindows），且都不得触碰
 *   [900M, 1.06e9) 正式验证池。
 *
 * 对手多样性（解决"固定单一对手"）：
 * - screen：轮换历史冻结冠军 + 风格变体（每局按 round/seedIndex 轮换）；
 * - deep：固定锚点（冻结 JS5 冠军）+ 轮换风格/历史版本，检查"不只赢上一任"。
 *
 * 评分维度（多目标筛选输入）：
 * - 结果：分人数第一名率、Wilson 下界、机会调整增益、平均名次、分差；
 * - 稳定性：异常率、最长对局墙钟；
 * - 行为：动作分布/得分/名次/回合数的行为签名（多样性去重）；
 * - 代理候选（plugin-only）：fixture 归一化增量 + fallback 率，明确标记
 *   evidenceType='offline-proxy'，不冒充对局强度。
 */

import { buildRegistry, toSeatVersion } from '../adversarial/registry.mjs';
import { playLeagueGame } from '../adversarial/league.mjs';
import { wilsonCI } from '../evaluator/stats.mjs';
import { seatVersionFor } from './candidate-artifact.mjs';
import { getTarget, evaluateModule, targetRegression } from './evolution-targets.mjs';
import { evaluateCompiledProxy } from './compiled-candidate.mjs';
import { evaluateCompiledCandidateGames } from './compiled-game-evaluator.mjs';
import {
  AI7_DEV_BLOCKS, AI9_DEV_BLOCKS, SCHEMAS, assertCondition, assertDevSeedInBlock, canonicalJSON,
  clamp, deepFreeze, sha256Canonical, shortHash,
} from './core.mjs';

const SCREEN_ROTATION = Object.freeze([
  'ai5-readiness-efficiency', 'style-rush', 'style-engine', 'style-contest',
  'neutral-baseline', 'random-legal',
]);
const DEEP_ANCHOR = 'js5-frozen-champion';
/** 轻量开发池的统一确定性工作量：32 workUnits（M4 预算下约数十毫秒/决策）。
 * 所有 champion-guided 席位（候选与锚点）同口径，避免"锚点更慢/更强"的系统偏差；
 * searchBudget 目标可显式覆盖自身预算。 */
const DEFAULT_WORK_UNITS = 32;

let registryCache = null;
function registry() {
  if (!registryCache) registryCache = buildRegistry();
  return registryCache;
}

/** 每局对手选择：轮换而非固定；deep 模式保留冻结冠军锚点。 */
export function opponentIdsForGame({ round, seedIndex = 0, seatCount, mode = 'screen' }) {
  assertCondition(mode === 'screen' || mode === 'deep', `评测模式非法：${mode}`);
  const ids = [];
  if (mode === 'deep') ids.push(DEEP_ANCHOR);
  const start = (round - 1 + seedIndex) % SCREEN_ROTATION.length;
  for (let i = 0; ids.length < seatCount - 1; i++) {
    ids.push(SCREEN_ROTATION[(start + i) % SCREEN_ROTATION.length]);
  }
  return ids;
}

export function opponentPolicyDescription({ mode }) {
  return {
    mode,
    anchor: mode === 'deep' ? DEEP_ANCHOR : null,
    rotation: [...SCREEN_ROTATION],
    rule: 'opponent index = (round−1 + seedIndex + i) mod rotation.length；deep 首席固定锚点',
  };
}

function opponentSeatVersions(ids) {
  const reg = registry();
  return ids.map(id => {
    const descriptor = reg.versions[id];
    assertCondition(descriptor, `对手未注册：${id}`);
    const seat = toSeatVersion(descriptor);
    return descriptor.decisionCore === 'champion-guided'
      ? { ...seat, jointOptions: { workUnits: DEFAULT_WORK_UNITS } }
      : seat;
  });
}

function rankOfSeat(result, seat) {
  const idx = result.ranking.findIndex(row => row.seat === seat);
  return idx >= 0 ? idx + 1 : null;
}

function candidateActionCounts(result, focusSeat) {
  return result.actionCounts?.[focusSeat] ?? null;
}

function aggregateCounts(rows) {
  const keys = ['acquire', 'claim', 'rest', 'play', 'discard'];
  const totals = Object.fromEntries(keys.map(k => [k, 0]));
  for (const row of rows) {
    const counts = row.candidateActions;
    if (!counts) continue;
    for (const key of keys) totals[key] += counts[key] ?? 0;
  }
  const total = keys.reduce((s, k) => s + totals[k], 0);
  return Object.fromEntries(keys.map(k => [k, total ? Number((totals[k] / total).toFixed(4)) : 0]));
}

/** 行为签名：只含对局可观察量；用于候选去重与多样性保留。 */
export function behaviorSignatureFromGames(rows, { seatCounts }) {
  const actions = aggregateCounts(rows);
  const finished = rows.filter(r => r.status === 'finished');
  const meanRank = finished.length ? finished.reduce((s, r) => s + (r.candidateRank ?? 0), 0) / finished.length : null;
  const meanScore = finished.length ? finished.reduce((s, r) => s + (r.candidateScore ?? 0), 0) / finished.length : null;
  const meanMoves = finished.length ? finished.reduce((s, r) => s + r.moves, 0) / finished.length : null;
  const signature = {
    kind: 'game-behavior-v1',
    actions,
    meanRank: meanRank === null ? null : Number(meanRank.toFixed(4)),
    meanScore: meanScore === null ? null : Number(meanScore.toFixed(2)),
    meanMoves: meanMoves === null ? null : Number(meanMoves.toFixed(2)),
    seatCounts: [...seatCounts],
  };
  return { signature, hash: sha256Canonical(signature) };
}

function summarizeByPlayerCount(rows) {
  const byCount = new Map();
  for (const row of rows) {
    if (!byCount.has(row.seatCount)) byCount.set(row.seatCount, []);
    byCount.get(row.seatCount).push(row);
  }
  const result = {};
  for (const [seatCount, list] of [...byCount.entries()].sort((a, b) => a[0] - b[0])) {
    const finished = list.filter(r => r.status === 'finished');
    const wins = finished.filter(r => r.winnerSeat === r.focusSeat).length;
    const chance = 1 / seatCount;
    const rate = finished.length ? wins / finished.length : null;
    result[String(seatCount)] = {
      seatCount,
      games: list.length,
      finishedGames: finished.length,
      anomalies: list.length - finished.length,
      anomalyRate: list.length ? Number(((list.length - finished.length) / list.length).toFixed(4)) : 0,
      wins,
      firstPlaceRate: rate === null ? null : Number(rate.toFixed(4)),
      chanceRate: chance,
      chanceLift: rate === null ? null : Number((rate - chance).toFixed(4)),
      wilson: finished.length ? wilsonCI(wins, finished.length) : null,
      meanRank: finished.length ? Number((finished.reduce((s, r) => s + (r.candidateRank ?? seatCount), 0) / finished.length).toFixed(3)) : null,
      meanScoreDiff: finished.length
        ? Number((finished.reduce((s, r) => s + (r.candidateScore - r.opponentMeanScore), 0) / finished.length).toFixed(3))
        : null,
      meanWallMs: finished.length ? Number((finished.reduce((s, r) => s + r.wallMs, 0) / finished.length).toFixed(1)) : null,
      maxWallMs: finished.length ? Math.max(...finished.map(r => r.wallMs)) : null,
    };
  }
  return result;
}

/** 校验 screen/deep 两个窗口互不重叠且都在指定开发块（AI7 或 AI9）。 */
export function assertIndependentWindows({ screenSeeds, deepSeeds, blocks = AI7_DEV_BLOCKS }) {
  assertCondition(Array.isArray(screenSeeds) && screenSeeds.length > 0, 'screenSeeds 不能为空');
  assertCondition(Array.isArray(deepSeeds) && deepSeeds.length > 0, 'deepSeeds 不能为空');
  for (const seed of screenSeeds) assertDevSeedInBlock(seed, blocks.screen, 'screen seed');
  for (const seed of deepSeeds) assertDevSeedInBlock(seed, blocks.deep, 'deep seed');
  const overlap = new Set(screenSeeds.filter(s => deepSeeds.includes(s)));
  assertCondition(overlap.size === 0, `快筛与深验种子重叠：${[...overlap].join(',')}`);
  return true;
}

/**
 * 对局评估（game 候选）。
 *
 * @param {object} options
 * @param {object} options.artifact Candidate Artifact
 * @param {number[]} options.seeds 种子列表（必须落在对应 purpose 的 AI7 块）
 * @param {'screen'|'deep'} [options.purpose]
 * @param {number} options.round
 * @param {number[]} [options.playerCounts]
 * @param {number} [options.maxMoves]
 * @param {number} [options.deadlineMs]
 */
export function evaluateGameCandidate({
  artifact, seeds, purpose = 'screen', round = 1, playerCounts = null,
  maxMoves = 500, deadlineMs = 60_000,
}) {
  assertCondition(artifact.algorithmStructure.evaluationMode === 'game', '该候选不是 game 模式');
  assertCondition(Array.isArray(seeds) && seeds.length > 0, 'seeds 不能为空');
  const block = AI7_DEV_BLOCKS[purpose];
  assertCondition(block, `purpose 非法：${purpose}`);
  for (const seed of seeds) assertDevSeedInBlock(seed, block, `${purpose} seed`);

  const counts = playerCounts ?? artifact.applicablePlayerCounts;
  for (const n of counts) assertCondition(artifact.applicablePlayerCounts.includes(n), `候选不适用 ${n} 人局`);

  const rows = [];
  let seedIndex = 0;
  for (const seatCount of counts) {
    for (const seed of seeds) {
      const focusSeat = seedIndex % seatCount;
      const opponentIds = opponentIdsForGame({ round, seedIndex, seatCount, mode: purpose });
      const opponents = opponentSeatVersions(opponentIds);
      const candidateSeat = seatVersionFor(artifact, seatCount);
      const seatVersions = Array.from({ length: seatCount }, (_, seat) => {
        if (seat === focusSeat) return candidateSeat;
        // 非焦点席位按座位顺序映射到对手池（焦点席之前的座位序号不变，
        // 之后的座位整体前移一位），保证每局 N−1 个对手全部入场且不重复。
        const before = seat < focusSeat ? seat : seat - 1;
        return opponents[before % opponents.length];
      });
      const result = playLeagueGame({
        seed, seatCount, seatVersions, jointOverrides: null, maxMoves, deadlineMs,
      });
      const finished = result.status === 'finished';
      const candidateRank = finished ? rankOfSeat(result, focusSeat) : null;
      const candidateScore = finished ? result.ranking.find(r => r.seat === focusSeat)?.score ?? null : null;
      const opponentScores = finished
        ? result.ranking.filter(r => r.seat !== focusSeat).map(r => r.score)
        : [];
      rows.push({
        seed, seatCount, focusSeat, status: result.status,
        reason: result.reason ?? null,
        winnerSeat: result.winnerSeat ?? null,
        candidateRank,
        candidateScore,
        opponentMeanScore: opponentScores.length
          ? opponentScores.reduce((s, x) => s + x, 0) / opponentScores.length
          : null,
        candidateActions: finished ? candidateActionCounts(result, focusSeat) : null,
        moves: result.moves ?? 0,
        wallMs: result.wallMs ?? 0,
        opponentIds,
        versions: result.versions ?? null,
      });
      seedIndex += 1;
    }
  }

  const byPlayerCount = summarizeByPlayerCount(rows);
  const finished = rows.filter(r => r.status === 'finished');
  const totalWins = finished.filter(r => r.winnerSeat === r.focusSeat).length;
  const anomalies = rows.length - finished.length;
  const behavior = behaviorSignatureFromGames(rows, { seatCounts: counts });
  const minWilsonLower = Object.values(byPlayerCount)
    .map(x => x.wilson?.lower)
    .filter(x => typeof x === 'number');
  const metrics = {
    evidenceType: 'dev-game',
    totalGames: rows.length,
    finishedGames: finished.length,
    anomalies,
    anomalyRate: rows.length ? Number((anomalies / rows.length).toFixed(4)) : 0,
    wins: totalWins,
    firstPlaceRate: finished.length ? Number((totalWins / finished.length).toFixed(4)) : null,
    chanceAdjustedRate: finished.length
      ? Number((Object.values(byPlayerCount).reduce((s, x) => s + (x.chanceLift ?? 0) * x.finishedGames, 0) / finished.length).toFixed(4))
      : null,
    minWilsonLower: minWilsonLower.length ? Number(Math.min(...minWilsonLower).toFixed(4)) : null,
    meanWallMs: finished.length ? Number((finished.reduce((s, r) => s + r.wallMs, 0) / finished.length).toFixed(1)) : null,
    p95WallMs: finished.length
      ? (() => { const sorted = finished.map(r => r.wallMs).sort((a, b) => a - b); return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(1)); })()
      : null,
    byPlayerCount,
  };

  return deepFreeze({
    schema: SCHEMAS.evaluationEvidence,
    candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest,
    evaluationMode: 'game',
    purpose,
    round,
    seedWindow: { base: seeds[0], count: seeds.length, seeds: [...seeds], block },
    opponentPolicy: opponentPolicyDescription({ mode: purpose }),
    metrics,
    behaviorSignature: behavior.signature,
    behaviorHash: behavior.hash,
    games: rows,
  });
}

/** 代理评估（plugin-only 候选）：fixture 归一化增量，不冒充对局强度。 */
export function evaluateProxyCandidate({ artifact, round = 1 }) {
  assertCondition(artifact.algorithmStructure.evaluationMode === 'proxy', '该候选不是 proxy 模式');
  assertCondition(artifact.algorithmStructure.targetIds.length === 1, 'proxy 候选必须只有一个目标');
  if (artifact.buildArtifact?.compiled === true) {
    return evaluateCompiledProxy({ artifact, round });
  }
  const targetId = artifact.algorithmStructure.targetIds[0];
  const target = getTarget(targetId);
  const regression = targetRegression(targetId);
  const rows = [];
  let fallbackCount = 0;
  let weightedDelta = 0;
  let weightSum = 0;
  for (const fixture of regression) {
    const candidate = evaluateModule(targetId, fixture.input, artifact.parameters.values);
    const baseline = fixture.baseline;
    if (candidate.fallbackHit) fallbackCount += 1;
    const baseValue = baseline.value;
    const candidateValue = candidate.value;
    const delta = baseValue === null || candidateValue === null ? 0 : candidateValue - baseValue;
    const normalized = clamp(delta / (Math.abs(baseValue ?? 0) + 1), -1, 1);
    const weight = Math.abs(baseValue ?? 0) + 1;
    weightedDelta += normalized * weight;
    weightSum += weight;
    rows.push({
      fixture: fixture.name,
      baselineValue: baseValue,
      candidateValue,
      delta: Number(delta.toFixed(6)),
      normalizedDelta: Number(normalized.toFixed(6)),
      fallbackHit: candidate.fallbackHit,
    });
  }
  const behaviorSignature = {
    kind: 'proxy-coefficients-v1',
    targetId,
    coefficients: Object.fromEntries(target.featureKeys.map(k =>
      [k, Number(clamp((artifact.parameters.values.coefficients[k] ?? 0) / 3, -1, 1).toFixed(4))])),
    bias: Number(clamp((artifact.parameters.values.bias ?? 0) / 2, -1, 1).toFixed(4)),
  };
  const metrics = {
    evidenceType: 'offline-proxy',
    totalGames: 0,
    fixtures: rows.length,
    fallbackCount,
    fallbackRate: rows.length ? Number((fallbackCount / rows.length).toFixed(4)) : 0,
    proxyDelta: weightSum ? Number((weightedDelta / weightSum).toFixed(6)) : 0,
    productionWiring: 'not-wired',
    targetId,
  };
  return deepFreeze({
    schema: SCHEMAS.evaluationEvidence,
    candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest,
    evaluationMode: 'proxy',
    purpose: 'proxy',
    round,
    seedWindow: null,
    opponentPolicy: null,
    metrics,
    behaviorSignature,
    behaviorHash: sha256Canonical(behaviorSignature),
    fixtures: rows,
  });
}

/** 统一入口：按 artifact 的 evaluationMode 分派。
 * 编译型多模块候选必须走独立的候选决策包注入（候选/冠军模块实例隔离），
 * 绝不使用 seatVersionFor 的官方决策路径（否则候选代码从未执行）。 */
export async function evaluateCandidate(options) {
  const artifact = options.artifact;
  if (artifact.buildArtifact?.compiled === true && artifact.source?.modules?.length > 0) {
    assertCondition(artifact.algorithmStructure.evaluationMode === 'game',
      '编译型多模块候选必须为 game 模式');
    const counts = options.playerCounts ?? artifact.applicablePlayerCounts;
    assertCondition(Array.isArray(options.seeds) && options.seeds.length >= counts.length,
      `编译候选评估需要至少 ${counts.length} 个种子（每人一层），实际 ${options.seeds?.length ?? 0}`);
    // 分人数独立种子：同一种子不得跨人数复用（统计独立性）。
    const base = Math.floor(options.seeds.length / counts.length);
    const extra = options.seeds.length % counts.length;
    let cursor = 0;
    const seedsByPlayerCount = {};
    for (const [index, count] of counts.entries()) {
      const size = base + (index < extra ? 1 : 0);
      seedsByPlayerCount[count] = options.seeds.slice(cursor, cursor + size);
      cursor += size;
    }
    return evaluateCompiledCandidateGames({
      artifact,
      seedsByPlayerCount,
      purpose: options.purpose ?? 'screen',
      round: options.round ?? 1,
      playerCounts: counts,
      maxMoves: options.maxMoves ?? 500,
      deadlineMs: options.deadlineMs ?? 60_000,
      workUnits: options.workUnits ?? 32,
    });
  }
  return artifact.algorithmStructure.evaluationMode === 'game'
    ? evaluateGameCandidate(options)
    : evaluateProxyCandidate(options);
}

/** 证据文件名（稳定、可定位）。 */
export function evidenceFileName({ purpose, round }) {
  return `${purpose}-r${String(round).padStart(3, '0')}.json`;
}

export { shortHash, canonicalJSON };
