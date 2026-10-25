/** P0：第一名率配对挑战运行器（唯一冠军晋级证据来源）。
 *
 * 实验设计（与任务书 4.1 逐条对应）：
 * - 每个 seed 生成两个实验：
 *     A：候选控制焦点席位，其余席位为冻结对手池；
 *     B：冻结冠军控制同一焦点席位，其余席位与 A 完全相同（同 seed、同对手、同座位）；
 * - 焦点席位随 seed 轮换（(i + seatOffset) mod N），覆盖全部座位；
 * - 焦点席位是单个 AI 玩家：绝不把「候选占 N−1 席的阵营第一名率」当个人第一名率；
 * - 第一名由正式引擎 ranking 的唯一排序裁定（分数降序，同分时席位号大者优先）；
 * - delta = candidateFirst − championFirst ∈ {−1,0,+1}，按 seed 聚为一个配对样本。
 *
 * 公平性约束：
 * - 对手池不得包含候选身份；冠军身份只在 B 的焦点席位出现；
 * - 两个实验的对手选择只依赖 (seedIndex, seat)，与 A/B 无关；
 * - 所有席位共享同一正式引擎与同一规则版本（requireBuiltEngine 在 CLI 层强制）。
 */

import { simulateGame } from '../simulator/simulate.mjs';
import { sha256Canonical, assertCondition } from '../evolution/core.mjs';
import { firstPlacePromotionDecision, clusterFirstPlacePairs } from '../evaluator/first-place.mjs';
import {
  assertFixedSample, assertPlanIdentity, assertResultsAfterLock, assertValidationSeeds,
  DEFAULT_SEARCH_WORK_UNITS,
} from '../evaluator/preregistration.mjs';

/** 正式挑战的固定搜索工作量：质量比较必须固定 workUnits，墙钟仅用于资源控制。
 * 计划与实际执行共用同一常量；计划字段 searchWorkUnits 是唯一权威值。 */
export const DEFAULT_FORMAL_WORK_UNITS = DEFAULT_SEARCH_WORK_UNITS;

/** 版本描述符 → 模拟器席位版本（保留适配器分派字段；两个实验同口径）。 */
export function toSeatVersion(descriptor, { seatCount = null, workUnits = DEFAULT_FORMAL_WORK_UNITS } = {}) {
  assertCondition(descriptor && typeof descriptor === 'object', '版本描述符缺失');
  assertCondition(typeof descriptor.id === 'string' && descriptor.id.length > 0, '版本描述符缺少 id');
  const version = { id: descriptor.id, parameters: descriptor };
  if (descriptor.structure !== undefined) version.structure = descriptor.structure;
  if (descriptor.adapter !== undefined) {
    version.adapter = descriptor.adapter;
    if (descriptor.jointVersion !== undefined) version.jointVersion = descriptor.jointVersion;
    if (descriptor.budgetMs !== undefined) version.budgetMs = descriptor.budgetMs;
    if (descriptor.gateMode !== undefined) version.gateMode = descriptor.gateMode;
    // 正式挑战强制固定 workUnits：候选与冠军在同一搜索工作量下比较，
    // 不允许墙钟预算决定展开顺序；候选按人数覆盖的显式 workUnits 优先。
    const perCount = descriptor.jointOptionsByPlayerCount;
    const explicit = perCount && seatCount !== null
      ? (perCount[String(seatCount)] ?? perCount[seatCount] ?? {})
      : {};
    version.jointOptions = {
      workUnits: explicit.workUnits ?? workUnits,
      ...explicit,
    };
  }
  return version;
}

export function descriptorFingerprint(descriptor) {
  return sha256Canonical(descriptor);
}

function validateRoster({ opponents, candidate, champion }) {
  assertCondition(Array.isArray(opponents) && opponents.length > 0, '对手池不能为空');
  for (const opponent of opponents) {
    assertCondition(opponent?.id && typeof opponent.id === 'string', '对手缺少 id');
    assertCondition(opponent.id !== candidate.id, `对手池不得包含候选 ${candidate.id}`);
    assertCondition(opponent.id !== champion.id, `对手池不得包含冠军 ${champion.id}（冠军只在 B 实验焦点席位出现）`);
  }
  const ids = new Set(opponents.map(o => o.id));
  assertCondition(ids.size === opponents.length, '对手池存在重复 id');
  const fingerprints = new Set(opponents.map(descriptorFingerprint));
  assertCondition(fingerprints.size === opponents.length, '对手池存在重复行为身份（fingerprint 重复）');
  return true;
}

/** 对手分配只依赖 (seedIndex, seat)，A/B 完全一致。 */
export function opponentForSeat({ seedIndex, seat, opponents }) {
  return opponents[(seedIndex + seat) % opponents.length];
}

export function focusSeatFor({ seedIndex, seatCount, seatOffset = 0 }) {
  assertCondition(Number.isSafeInteger(seedIndex) && seedIndex >= 0, 'seedIndex 必须为非负整数');
  assertCondition(Number.isSafeInteger(seatCount) && seatCount >= 2 && seatCount <= 5, 'seatCount 必须在 2..5');
  return (seedIndex + seatOffset) % seatCount;
}

/**
 * 单人数第一名率配对挑战。
 *
 * @param {object} options
 * @param {object} options.champion 冻结冠军参数（含 id）
 * @param {object} options.candidate 候选参数（含 id）
 * @param {Array<object>} options.opponents 冻结对手池（AIParameters 描述符）
 * @param {number[]} options.seeds 本人数层的验证种子（升序、唯一）
 * @param {number} options.seatCount
 * @param {number} [options.seatOffset]
 * @param {number} [options.maxMoves]
 * @param {number} [options.deadlineMs]
 */
export function runFirstPlaceSeatChallenge({
  champion, candidate, opponents, seeds, seatCount, seatOffset = 0,
  maxMoves = 1200, deadlineMs = 300_000, workUnits = DEFAULT_FORMAL_WORK_UNITS,
}) {
  assertCondition(champion?.id && candidate?.id, 'champion/candidate 必须带 id');
  assertCondition(champion.id !== candidate.id, '冠军与候选 id 不得相同');
  validateRoster({ opponents, candidate, champion });
  assertCondition(Array.isArray(seeds) && seeds.length > 0, 'seeds 不能为空');
  assertCondition(new Set(seeds).size === seeds.length, 'seeds 存在重复（破坏配对独立性）');
  for (const seed of seeds) {
    assertCondition(Number.isSafeInteger(seed) && seed >= 0, `seed 非法：${String(seed)}`);
  }

  const pairs = [];
  const games = [];
  let anomalyGames = 0;

  for (const [seedIndex, seed] of seeds.entries()) {
    const focusSeat = focusSeatFor({ seedIndex, seatCount, seatOffset });
    const baseVersions = Array.from({ length: seatCount }, (_, seat) => {
      if (seat === focusSeat) return null;
      return toSeatVersion(opponentForSeat({ seedIndex, seat, opponents }));
    });
    const arms = [
      { arm: 'A', version: toSeatVersion(candidate, { seatCount, workUnits }) },
      { arm: 'B', version: toSeatVersion(champion, { seatCount, workUnits }) },
    ];
    const results = {};
    for (const { arm, version } of arms) {
      const versions = baseVersions.map(v => (v === null ? version : v));
      const result = simulateGame({ seed, versions, seatCount, maxMoves, deadlineMs });
      results[arm] = result;
      const finished = result.status === 'finished';
      const first = finished && result.ranking[0]?.seat === focusSeat;
      games.push({
        seed,
        seedIndex,
        arm,
        focusSeat,
        seatCount,
        status: result.status,
        reason: result.reason ?? null,
        firstPlace: finished ? first : null,
        winnerSeat: result.winnerSeat ?? null,
        moves: result.moves ?? 0,
        wallMs: result.wallMs ?? 0,
        ranking: result.ranking ?? [],
        versions: versions.map(v => v.id),
      });
      if (!finished) anomalyGames += 1;
    }
    pairs.push({
      seed,
      focusSeat,
      candidateFirst: results.A.status === 'finished' ? results.A.ranking[0].seat === focusSeat : null,
      championFirst: results.B.status === 'finished' ? results.B.ranking[0].seat === focusSeat : null,
      anomalies: (results.A.status === 'finished' ? 0 : 1) + (results.B.status === 'finished' ? 0 : 1),
      status: results.A.status === 'finished' && results.B.status === 'finished' ? 'finished' : 'anomaly',
    });
  }

  const totalGames = games.length;
  return {
    seatCount,
    seatOffset,
    seeds: [...seeds],
    pairs,
    games,
    totalGames,
    anomalyGames,
    anomalyRate: totalGames ? Number((anomalyGames / totalGames).toFixed(4)) : 0,
    uniqueSeeds: new Set(seeds).size,
  };
}

/**
 * 2–5 人完整第一名率挑战（每种人数独立成次、独立种子块）。
 *
 * @param {object} options
 * @param {Array<{seatCount:number, seeds:number[]}>} options.seatPlans
 * @param {object} [options.weights]
 * @param {number} [options.alpha]
 * @param {number} [options.margin]
 * @param {number} [options.minSeeds]
 * @param {number} [options.maxAnomalyRate]
 */
export function runFirstPlaceChallengeBundle({
  champion, candidate, opponents, seatPlans,
  weights = null, alpha = 0.05, margin = 0.02, minSeeds = 60, maxAnomalyRate = 0.02,
  seatOffset = 0, maxMoves = 1200, deadlineMs = 300_000, workUnits = DEFAULT_FORMAL_WORK_UNITS,
}) {
  assertCondition(Array.isArray(seatPlans) && seatPlans.length > 0, 'seatPlans 不能为空');
  const strata = [];
  const runs = [];
  for (const plan of seatPlans) {
    const run = runFirstPlaceSeatChallenge({
      champion, candidate, opponents, seeds: plan.seeds, seatCount: plan.seatCount,
      seatOffset, maxMoves, deadlineMs, workUnits,
    });
    runs.push(run);
    strata.push({ seatCount: plan.seatCount, pairs: run.pairs });
  }
  const decision = firstPlacePromotionDecision({
    strata, weights, alpha, margin, minSeeds, maxAnomalyRate,
  });
  return { runs, decision };
}

/**
 * 预注册驱动的正式挑战（P0 唯一允许产生晋级证据的入口）。
 *
 * 顺序强制：计划已锁定 → 身份核验 → 对局 → 身份复核 → 种子/固定样本核验 →
 * 统计判定 → 结果时间核验。
 *
 * @param {object} options
 * @param {object} options.plan loadPreregistration() 的结果（含 lockedAt）
 * @param {object} options.champion
 * @param {object} options.candidate
 * @param {Array<object>} options.opponents
 * @param {object} [options.engine] 当前构建身份 {engineBundleSha256, sourceClosureSha256, codeCommit}
 * @param {(descriptor:object)=>{parametersSha256:string, sourceHash:string, artifactHash:string}} [options.recomputeIdentity]
 * @param {object} [options.runtime]
 */
export function runPreregisteredFirstPlaceChallenge({
  plan, champion, candidate, opponents, engine = null, recomputeIdentity = null,
  seatOffset = 0, maxMoves = 1200, deadlineMs = 300_000, workUnits = null,
}) {
  assertCondition(plan?.lockedAt, '预注册计划未锁定（缺少 lockedAt）');
  const planWorkUnits = plan.searchWorkUnits ?? DEFAULT_FORMAL_WORK_UNITS;
  assertCondition(Number.isSafeInteger(planWorkUnits) && planWorkUnits >= 1,
    `预注册 searchWorkUnits 非法：${String(planWorkUnits)}`);
  assertCondition(workUnits === null || workUnits === planWorkUnits,
    `实际 workUnits ${String(workUnits)} ≠ 预注册 searchWorkUnits ${planWorkUnits}（搜索预算不得在读取结果后调整）`);
  const championIdentity = {
    parametersSha256: sha256Canonical(champion),
    artifactHash: plan.champion.artifactHash,
  };
  const candidateIdentity = recomputeIdentity
    ? recomputeIdentity(candidate)
    : {
        parametersSha256: sha256Canonical(candidate),
        sourceHash: plan.candidate.sourceHash,
        artifactHash: plan.candidate.artifactHash,
      };
  assertPlanIdentity({
    plan,
    candidate: candidateIdentity,
    champion: championIdentity,
    opponents,
    engine,
  });

  const seatPlans = plan.seatCounts.map(seatCount => {
    const window = plan.seatWindows[String(seatCount)];
    return {
      seatCount,
      seeds: Array.from({ length: window.count }, (_, i) => window.base + i),
    };
  });
  const seedsBySeatCount = Object.fromEntries(seatPlans.map(p => [String(p.seatCount), p.seeds]));
  assertValidationSeeds({ plan, seedsBySeatCount });

  const alphaEntry = { alpha: plan.alphaBudget / 2 ** plan.challengeIndex };
  const { runs, decision } = runFirstPlaceChallengeBundle({
    champion, candidate, opponents, seatPlans,
    weights: plan.weights,
    alpha: alphaEntry.alpha,
    margin: plan.nonInferiorityMargin,
    minSeeds: plan.minSeedsPerSeatCount,
    seatOffset,
    maxMoves,
    deadlineMs,
    workUnits: planWorkUnits,
  });

  if (recomputeIdentity) {
    assertPlanIdentity({
      plan,
      candidate: recomputeIdentity(candidate),
      champion: championIdentity,
      opponents,
      engine,
    });
  }
  const observedSeedsBySeatCount = Object.fromEntries(runs.map(r => [String(r.seatCount), r.uniqueSeeds]));
  assertFixedSample({ plan, observedSeedsBySeatCount });
  const producedAt = new Date().toISOString();
  assertResultsAfterLock({ plan, resultsProducedAt: producedAt });

  const evidenceHash = sha256Canonical({
    planHash: plan.planHash,
    searchWorkUnits: planWorkUnits,
    runs: runs.map(r => ({ seatCount: r.seatCount, pairs: r.pairs })),
    decision,
  });

  return {
    schema: 'century-first-place-formal-challenge-v1',
    planId: plan.planId,
    planHash: plan.planHash,
    challengeIndex: plan.challengeIndex,
    alpha: alphaEntry.alpha,
    alphaBudget: plan.alphaBudget,
    searchWorkUnits: planWorkUnits,
    candidateId: candidate.id,
    championId: champion.id,
    opponents: opponents.map(o => ({ id: o.id, fingerprint: descriptorFingerprint(o) })),
    engine,
    producedAt,
    decision,
    runs,
    evidenceHash,
  };
}

export { clusterFirstPlacePairs };
