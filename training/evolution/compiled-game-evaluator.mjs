/** AI 9.0 编译型多模块候选的真实对局评估（开发池，不消费验证池）。
 *
 * 设计：
 * - 候选以独立 ESM 决策包注入焦点席位（候选模块实例与官方冠军模块实例
 *   互不共享状态）；
 * - B 臂永远使用不可变冻结冠军（adversarial registry 的 js5 归档身份），
 *   与同日种子/对手/座位配对；
 * - 2–5 人全部覆盖；焦点席位随种子轮换；
 * - 主指标 = 焦点席位配对第一名率增量；平均分/资源效率仅诊断；
 * - 种子必须来自 AI7 开发池（screen/deep 分区），绝不触碰验证池。
 */

import { buildRegistry, toSeatVersion } from '../adversarial/registry.mjs';
import { simulateGame } from '../simulator/simulate.mjs';
import { analyzeSeatStratum } from '../evaluator/first-place.mjs';
import { wilsonCI } from '../evaluator/stats.mjs';
import {
  SCHEMAS, AI7_DEV_BLOCKS, AI9_DEV_BLOCKS, assertCondition, assertDevSeedInBlock,
  deepFreeze, sha256Canonical,
} from './core.mjs';
import { loadCompiledCandidateModules } from './multi-module-candidate.mjs';

const SCREEN_ROTATION = Object.freeze([
  'ai5-readiness-efficiency', 'style-rush', 'style-engine', 'style-contest',
  'neutral-baseline', 'random-legal',
]);
const DEEP_ANCHOR = 'js5-frozen-champion';
export const DEFAULT_WORK_UNITS = 32;

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

/** 注册表描述符 → 模拟器席位配置。champion-guided 必须显式带 adapter 字段，
 * 否则 simulateGame 会走 chooseAIAction 并忽略 jointOptions（workUnits 固定口径失效）。 */
function seatVersionOf(descriptor) {
  const seat = toSeatVersion(descriptor);
  return descriptor.decisionCore === 'champion-guided'
    ? { ...seat, adapter: 'champion-guided' }
    : seat;
}

function candidateSeatVersion({ artifact, modules, workUnits }) {
  return {
    id: artifact.candidateId,
    fingerprint: artifact.identityDigest,
    decisionCore: 'champion-guided',
    parameters: artifact.parameters.values,
    adapter: 'champion-guided',
    jointVersion: artifact.algorithmStructure.jointVersion ?? 'joint-js5',
    jointOptions: workUnits === null ? {} : { workUnits },
    aiModule: modules.aiModule,
    jointModule: modules.jointModule,
  };
}

function rankOf(result, seat) {
  const idx = result.ranking?.findIndex(row => row.seat === seat) ?? -1;
  return idx >= 0 ? idx + 1 : null;
}

function actionCounts(result, seat) {
  const seats = result.metrics?.seats ?? [];
  const row = seats[seat];
  if (!row) return null;
  const total = (row.acquireActions ?? 0) + (row.claimActions ?? 0) + (row.restActions ?? 0) + (row.playActions ?? 0);
  return {
    acquire: total ? Number(((row.acquireActions ?? 0) / total).toFixed(4)) : 0,
    claim: total ? Number(((row.claimActions ?? 0) / total).toFixed(4)) : 0,
    rest: total ? Number(((row.restActions ?? 0) / total).toFixed(4)) : 0,
    play: total ? Number(((row.playActions ?? 0) / total).toFixed(4)) : 0,
  };
}

/**
 * 真实对局评估（A=候选焦点席位，B=冻结冠军同一焦点席位）。
 *
 * @param {object} options
 * @param {object} options.artifact 编译型多模块 Candidate Artifact
 * @param {number[]} options.seeds 开发池种子
 * @param {'screen'|'deep'} [options.purpose]
 * @param {number} options.round
 * @param {number[]} [options.playerCounts]
 * @param {number} [options.maxMoves]
 * @param {number} [options.deadlineMs]
 * @param {number|null} [options.workUnits] 固定工作量（缺省 32，正式研究口径）
 */
export async function evaluateCompiledCandidateGames({
  artifact, seeds = null, seedsByPlayerCount = null, purpose = 'screen', round = 1, playerCounts = null,
  maxMoves = 500, deadlineMs = 60_000, workUnits = DEFAULT_WORK_UNITS,
  blocks = null,
}) {
  assertCondition(artifact?.buildArtifact?.compiled === true, '候选不是编译型 artifact');
  assertCondition(artifact.source?.modules?.length > 0, '候选不是多模块 artifact');
  assertCondition(
    (Array.isArray(seeds) && seeds.length > 0) || (seedsByPlayerCount && typeof seedsByPlayerCount === 'object'),
    '必须提供 seeds 或 seedsByPlayerCount',
  );
  const blockSet = blocks ?? (String(artifact.experiment?.configRef ?? '').startsWith('ai9://')
    ? AI9_DEV_BLOCKS
    : AI7_DEV_BLOCKS);
  const block = blockSet[purpose];
  assertCondition(block, `purpose 非法：${purpose}`);
  const counts = playerCounts ?? artifact.applicablePlayerCounts;
  const seedsFor = count => seedsByPlayerCount?.[count] ?? seeds;
  for (const count of counts) {
    const list = seedsFor(count);
    assertCondition(Array.isArray(list) && list.length > 0, `${count} 人种子缺失`);
    for (const seed of list) assertDevSeedInBlock(seed, block, `${purpose} seed`);
  }
  for (const n of counts) assertCondition(artifact.applicablePlayerCounts.includes(n), `候选不适用 ${n} 人局`);

  const registry = buildRegistry({ jointOptions: workUnits === null ? null : { workUnits } });
  const championDescriptor = registry.versions[DEEP_ANCHOR];
  assertCondition(championDescriptor, '缺少冻结冠军注册身份');
  const loaded = await loadCompiledCandidateModules(artifact);
  const rows = [];
  const pairs = [];
  let seedIndex = 0;
  try {
    for (const seatCount of counts) {
      for (const seed of seedsFor(seatCount)) {
        const focusSeat = seedIndex % seatCount;
        const opponentIds = opponentIdsForGame({ round, seedIndex, seatCount, mode: purpose });
        const opponents = opponentIds.map(id => {
          const descriptor = registry.versions[id];
          assertCondition(descriptor, `对手未注册：${id}`);
          return seatVersionOf(descriptor);
        });
        const baseSeats = Array.from({ length: seatCount }, (_, seat) => {
          if (seat === focusSeat) return null;
          const before = seat < focusSeat ? seat : seat - 1;
          return opponents[before % opponents.length];
        });
        const arms = [
          { arm: 'A', version: candidateSeatVersion({ artifact, modules: loaded, workUnits }) },
          { arm: 'B', version: seatVersionOf(championDescriptor) },
        ];
        const results = {};
        for (const { arm, version } of arms) {
          const seatVersions = baseSeats.map(v => (v === null ? version : v));
          const result = simulateGame({ seed, versions: seatVersions, seatCount, maxMoves, deadlineMs });
          results[arm] = result;
          const finished = result.status === 'finished';
          const first = finished && result.ranking[0]?.seat === focusSeat;
          const score = finished ? result.ranking.find(r => r.seat === focusSeat)?.score ?? null : null;
          rows.push({
            seed, seedIndex, seatCount, focusSeat, arm, status: result.status,
            reason: result.reason ?? null, firstPlace: finished ? first : null,
            winnerSeat: result.winnerSeat ?? null, moves: result.moves ?? 0,
            wallMs: result.wallMs ?? 0, score,
            meanDecisionMs: result.metrics?.meanDecisionMs ?? null,
            rank: finished ? rankOf(result, focusSeat) : null,
            candidateActions: finished ? actionCounts(result, focusSeat) : null,
            opponentIds,
            versions: seatVersions.map(v => v.id),
          });
        }
        const a = results.A;
        const b = results.B;
        const aFinished = a.status === 'finished';
        const bFinished = b.status === 'finished';
        pairs.push({
          seed, focusSeat, seatCount,
          candidateFirst: aFinished ? (a.ranking[0]?.seat === focusSeat ? 1 : 0) : null,
          championFirst: bFinished ? (b.ranking[0]?.seat === focusSeat ? 1 : 0) : null,
          anomalies: (aFinished ? 0 : 1) + (bFinished ? 0 : 1),
          status: aFinished && bFinished ? 'finished' : 'anomaly',
        });
        seedIndex += 1;
      }
    }
  } finally {
    loaded.cleanup();
  }

  const finishedPairs = pairs.filter(p => p.status === 'finished' && p.anomalies === 0);
  const finishedRows = rows.filter(r => r.status === 'finished');
  const byPlayerCount = {};
  for (const seatCount of counts) {
    const stratumPairs = finishedPairs.filter(p => p.seatCount === seatCount);
    const stratumRows = finishedRows.filter(r => r.seatCount === seatCount);
    const aRows = stratumRows.filter(r => r.arm === 'A');
    const bRows = stratumRows.filter(r => r.arm === 'B');
    const aWins = aRows.filter(r => r.firstPlace).length;
    const bWins = bRows.filter(r => r.firstPlace).length;
    byPlayerCount[String(seatCount)] = {
      seatCount,
      pairs: stratumPairs.length,
      candidateGames: aRows.length,
      championGames: bRows.length,
      candidateFirst: aWins,
      championFirst: bWins,
      candidateFirstRate: aRows.length ? Number((aWins / aRows.length).toFixed(4)) : null,
      championFirstRate: bRows.length ? Number((bWins / bRows.length).toFixed(4)) : null,
      delta: stratumPairs.length
        ? Number((stratumPairs.reduce((s, p) => s + (p.candidateFirst - p.championFirst), 0) / stratumPairs.length).toFixed(4))
        : null,
      wilson: aRows.length ? wilsonCI(aWins, aRows.length) : null,
    };
  }
  let seatStratum = null;
  let pooledStratum = null;
  const pairRecords = finishedPairs.map(p => ({
    seed: p.seed, focusSeat: p.focusSeat,
    candidateFirst: p.candidateFirst, championFirst: p.championFirst,
  }));
  try {
    // 分人数区间用最大人数层（避免跨人数伪影）；研究级总体区间用全部独立种子。
    const analysisCount = counts.includes(5) ? 5 : counts[counts.length - 1];
    const minSeeds = Math.max(2, Math.min(60, Math.floor(finishedPairs.length * 0.5) + 1));
    const maxAnomalyRate = 0.5;
    seatStratum = analyzeSeatStratum({
      pairs: finishedPairs
        .filter(p => p.seatCount === analysisCount)
        .map(p => ({
          seed: p.seed, focusSeat: p.focusSeat,
          candidateFirst: p.candidateFirst, championFirst: p.championFirst,
        })),
      minSeeds,
      maxAnomalyRate,
      seatCount: analysisCount,
    });
    pooledStratum = analyzeSeatStratum({
      pairs: pairRecords,
      minSeeds,
      maxAnomalyRate,
      seatCount: null,
    });
  } catch (error) {
    seatStratum = { status: 'error', reason: error.message };
    pooledStratum = { status: 'error', reason: error.message };
  }
  const totalGames = rows.length;
  const anomalies = totalGames - finishedRows.length;
  const signature = {
    kind: 'compiled-module-behavior-v1',
    modules: artifact.source.modules.map(m => m.id).sort(),
    actions: aggregateActions(rows.filter(r => r.arm === 'A')),
    byPlayerCount,
  };
  return deepFreeze({
    schema: SCHEMAS.evaluationEvidence,
    candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest,
    evaluationMode: 'game',
    purpose,
    round,
    executorHash: sha256Canonical({
      artifactHash: artifact.artifactHash,
      buildArtifactHash: artifact.buildArtifact.sha256,
      modules: artifact.source.modules.map(m => [m.id, m.functionSha256]),
    }),
    seedWindow: seeds
      ? { base: seeds[0], count: seeds.length, seeds: [...seeds], block }
      : {
          byPlayerCount: Object.fromEntries(counts.map(n => [String(n), [...seedsFor(n)]])),
          block,
        },
    opponentPolicy: {
      mode: purpose,
      anchor: purpose === 'deep' ? DEEP_ANCHOR : null,
      rotation: [...SCREEN_ROTATION],
      controlArm: 'js5-frozen-champion (immutable archive)',
      workUnits,
    },
    metrics: {
      evidenceType: 'dev-game-compiled-modules',
      totalGames,
      finishedGames: finishedRows.length,
      anomalies,
      anomalyRate: totalGames ? Number((anomalies / totalGames).toFixed(4)) : 1,
      pairs: pairs.length,
      finishedPairs: finishedPairs.length,
      candidateFirstRate: finishedPairs.length
        ? Number((finishedPairs.reduce((s, p) => s + p.candidateFirst, 0) / finishedPairs.length).toFixed(4))
        : null,
      championFirstRate: finishedPairs.length
        ? Number((finishedPairs.reduce((s, p) => s + p.championFirst, 0) / finishedPairs.length).toFixed(4))
        : null,
      firstPlaceDelta: finishedPairs.length
        ? Number((finishedPairs.reduce((s, p) => s + (p.candidateFirst - p.championFirst), 0) / finishedPairs.length).toFixed(4))
        : null,
      firstPlaceDeltaCi: seatStratum?.ci ?? null,
      firstPlaceDeltaPooledCi: pooledStratum?.ci ?? null,
      chanceAdjustedRate: (() => {
        const rows = Object.values(byPlayerCount).filter(x => x.candidateFirstRate !== null);
        if (!rows.length) return null;
        return Number((rows.reduce((s, x) => s + (x.candidateFirstRate - 1 / x.seatCount), 0) / rows.length).toFixed(4));
      })(),
      minWilsonLower: (() => {
        const values = Object.values(byPlayerCount).map(x => x.wilson?.lower).filter(Number.isFinite);
        return values.length ? Number(Math.min(...values).toFixed(4)) : null;
      })(),
      byPlayerCount,
      meanDecisionMs: meanOf(rows.filter(r => r.arm === 'A').map(r => r.meanDecisionMs).filter(Number.isFinite)),
      p95WallMs: percentile(rows.filter(r => r.arm === 'A').map(r => r.wallMs)),
    },
    behaviorSignature: signature,
    behaviorHash: sha256Canonical(signature),
    pairs,
    games: rows,
  });
}

function aggregateActions(rows) {
  const keys = ['acquire', 'claim', 'rest', 'play'];
  const totals = Object.fromEntries(keys.map(k => [k, 0]));
  for (const row of rows) {
    if (!row.candidateActions) continue;
    for (const key of keys) totals[key] += row.candidateActions[key] ?? 0;
  }
  const sum = keys.reduce((s, k) => s + totals[k], 0);
  return Object.fromEntries(keys.map(k => [k, sum ? Number((totals[k] / sum).toFixed(4)) : 0]));
}

function meanOf(values) {
  const list = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return list.length ? Number((list.reduce((s, v) => s + v, 0) / list.length).toFixed(3)) : null;
}

function percentile(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  return Number(list[Math.min(list.length - 1, Math.floor(list.length * 0.95))].toFixed(1));
}
