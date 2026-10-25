/** P0：预注册实验计划（读取正式验证结果之前锁定）。
 *
 * 目的：把「先看结果、再挑口径」的路径封死。计划在创建时即为不可变对象，
 * 落盘后通过 planHash 复核；正式挑战运行器必须：
 *   1. 先 create/lock 计划；
 *   2. 再执行对局；
 *   3. 最后用同一计划 hash 验证结果归属。
 *
 * 计划必须预先指定（任务书 4.2）：
 * - 候选身份与源码/产物哈希、冻结冠军、冻结对手阵容；
 * - 2/3/4/5 人、人数权重、主指标与原假设；
 * - 每个人的独立验证种子窗口（互不重叠）；
 * - 最大样本量、提前停止规则（默认禁止）；
 * - 显著性水平与单侧非劣效门槛。
 *
 * 本模块只做「计划身份」与「执行一致性」核验，不做统计计算。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalJSON, sha256Canonical, deepFreeze, assertCondition,
} from '../evolution/core.mjs';
import { VALIDATION_POOL_BASE, VALIDATION_POOL_MAX } from '../lib/seeds.mjs';

export const PREREGISTRATION_SCHEMA = 'century-preregistration-v1';
export const PREREGISTRATION_LOCK_SCHEMA = 'century-preregistration-lock-v1';

export const REQUIRED_SEAT_COUNTS = Object.freeze([2, 3, 4, 5]);
export const DEFAULT_WEIGHTS = Object.freeze({ '2': 0.25, '3': 0.25, '4': 0.25, '5': 0.25 });
/** 正式挑战的固定搜索工作量（P3）：同一决策完全由显式种子与固定批次数决定，
 * 墙钟只用于资源保护，不参与展开顺序或行动选择。 */
export const DEFAULT_SEARCH_WORK_UNITS = 64;
export const DEFAULT_STOPPING_RULE = Object.freeze({
  kind: 'fixed-sample',
  optionalStopping: false,
  earlyStopOnSignificance: false,
  note: '固定样本；禁止因中途显著提前晋级（如需可选停止必须另行预注册并具备 anytime-valid 保证）',
});

function assertHex(value, name, length = 64) {
  assertCondition(typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value),
    `${name} 必须是 ${length} 位小写十六进制，实际：${String(value)}`);
  return value;
}

function normalizeSeatWindows(seatWindows) {
  assertCondition(seatWindows && typeof seatWindows === 'object', 'seatWindows 必须为对象');
  const result = {};
  const seenRanges = [];
  for (const seatCount of REQUIRED_SEAT_COUNTS) {
    const entry = seatWindows[String(seatCount)] ?? seatWindows[seatCount];
    assertCondition(entry && typeof entry === 'object', `缺少 ${seatCount} 人种子窗口`);
    const base = Number(entry.base);
    const count = Number(entry.count);
    assertCondition(Number.isSafeInteger(base) && Number.isSafeInteger(count) && count > 0,
      `${seatCount} 人种子窗口非法：base=${String(entry.base)} count=${String(entry.count)}`);
    assertCondition(base >= VALIDATION_POOL_BASE && base + count <= VALIDATION_POOL_MAX,
      `${seatCount} 人种子窗口 [${base},${base + count}) 不在正式验证池 [${VALIDATION_POOL_BASE},${VALIDATION_POOL_MAX})`);
    for (const [otherSeat, other] of Object.entries(seenRanges)) {
      const overlap = base < other.base + other.count && other.base < base + count;
      assertCondition(!overlap,
        `${seatCount} 人窗口 [${base},${base + count}) 与 ${otherSeat} 人窗口 [${other.base},${other.base + other.count}) 重叠——跨人数观测必须独立`);
    }
    seenRanges[String(seatCount)] = { base, count };
    result[String(seatCount)] = { base, count };
  }
  return result;
}

function normalizeWeights(weights) {
  const normalized = {};
  let sum = 0;
  for (const seatCount of REQUIRED_SEAT_COUNTS) {
    const w = Number(weights?.[String(seatCount)] ?? weights?.[seatCount]);
    assertCondition(Number.isFinite(w) && w >= 0, `${seatCount} 人权重非法：${String(w)}`);
    normalized[String(seatCount)] = w;
    sum += w;
  }
  assertCondition(Math.abs(sum - 1) < 1e-9, `人数权重之和必须为 1，实际：${sum}`);
  return normalized;
}

/**
 * 创建预注册计划（纯函数，不写盘；调用方必须先 lock 再跑对局）。
 *
 * @param {object} options
 * @param {string} options.planId
 * @param {{id:string, parametersSha256:string, sourceHash:string, artifactHash:string}} options.candidate
 * @param {{id:string, parametersSha256:string, artifactHash:string}} options.champion
 * @param {Array<{id:string, fingerprint:string}>} options.opponents
 * @param {object} options.seatWindows {2:{base,count},3:...,4:...,5:...}
 * @param {object} [options.weights]
 * @param {number} [options.alphaBudget]
 * @param {number} options.challengeIndex
 * @param {number} [options.nonInferiorityMargin]
 * @param {number} [options.minSeedsPerSeatCount]
 * @param {number} [options.searchWorkUnits] 固定联合搜索工作量（1–4096）
 * @param {object} [options.engine] {engineBundleSha256, sourceClosureSha256, codeCommit}
 * @param {string} [options.createdAt]
 */
export function createPreregistration({
  planId,
  candidate,
  champion,
  opponents,
  seatWindows,
  weights = DEFAULT_WEIGHTS,
  alphaBudget = 0.05,
  challengeIndex,
  nonInferiorityMargin = 0.02,
  minSeedsPerSeatCount = 60,
  maxSeedsPerSeatCount = null,
  searchWorkUnits = DEFAULT_SEARCH_WORK_UNITS,
  engine = null,
  createdAt = null,
}) {
  assertCondition(typeof planId === 'string' && /^[a-z0-9][a-z0-9._-]{2,95}$/i.test(planId),
    `planId 非法：${String(planId)}`);
  assertCondition(candidate && typeof candidate === 'object', '缺少候选身份');
  assertCondition(champion && typeof champion === 'object', '缺少冠军身份');
  assertCondition(Array.isArray(opponents) && opponents.length > 0, '对手阵容不能为空');
  assertCondition(Number.isSafeInteger(challengeIndex) && challengeIndex >= 1, 'challengeIndex 必须为 ≥1 整数');
  assertCondition(Number.isFinite(alphaBudget) && alphaBudget > 0 && alphaBudget < 1, 'alphaBudget 必须在 (0,1)');
  assertCondition(Number.isFinite(nonInferiorityMargin) && nonInferiorityMargin >= 0 && nonInferiorityMargin < 1,
    'nonInferiorityMargin 必须在 [0,1)');
  assertCondition(Number.isSafeInteger(searchWorkUnits) && searchWorkUnits >= 1 && searchWorkUnits <= 4096,
    `searchWorkUnits 必须为 1–4096 的整数，实际：${String(searchWorkUnits)}`);

  assertHex(candidate.parametersSha256, 'candidate.parametersSha256');
  assertHex(candidate.sourceHash, 'candidate.sourceHash');
  assertHex(candidate.artifactHash, 'candidate.artifactHash');
  assertHex(champion.parametersSha256, 'champion.parametersSha256');
  assertHex(champion.artifactHash, 'champion.artifactHash');
  for (const [index, opponent] of opponents.entries()) {
    assertCondition(typeof opponent.id === 'string' && opponent.id.length > 0, `对手 ${index} 缺少 id`);
    assertCondition(typeof opponent.fingerprint === 'string' && opponent.fingerprint.length >= 8,
      `对手 ${index}（${opponent.id}）缺少 fingerprint`);
  }

  const windows = normalizeSeatWindows(seatWindows);
  const weightMap = normalizeWeights(weights);
  const engineDescriptor = engine
    ? {
        engineBundleSha256: assertHex(engine.engineBundleSha256, 'engine.engineBundleSha256'),
        sourceClosureSha256: assertHex(engine.sourceClosureSha256, 'engine.sourceClosureSha256'),
        // 决策核心身份（不含 CHAMPION-PARAMETERS 生成区）：晋级落地后参数区会变，
        // 但决策核心不变；身份核验必须用这一对，否则合法晋级会被误判为证据失效。
        decisionSourceSha256: engine.decisionSourceSha256
          ? assertHex(engine.decisionSourceSha256, 'engine.decisionSourceSha256') : null,
        decisionArtifactSha256: engine.decisionArtifactSha256
          ? assertHex(engine.decisionArtifactSha256, 'engine.decisionArtifactSha256') : null,
        codeCommit: typeof engine.codeCommit === 'string' ? engine.codeCommit : null,
      }
    : null;

  const plan = {
    schema: PREREGISTRATION_SCHEMA,
    planId,
    createdAt: createdAt ?? new Date().toISOString(),
    primaryObjective: 'firstPlaceWinRate',
    primaryMetric: 'pairedFirstPlaceRateDelta',
    decisionMetric: 'weightedPairedFirstPlaceRateDelta',
    nullHypothesis: 'H0: 2–5 人加权第一名率增量 ≤ 0；各人数非劣效 H0: delta < −margin',
    alternativeHypothesis: 'H1: 加权增量 > 0 且各人数 delta ≥ −margin',
    candidate: {
      id: candidate.id,
      parametersSha256: candidate.parametersSha256,
      sourceHash: candidate.sourceHash,
      artifactHash: candidate.artifactHash,
    },
    champion: {
      id: champion.id,
      parametersSha256: champion.parametersSha256,
      artifactHash: champion.artifactHash,
    },
    opponents: opponents.map(o => ({ id: o.id, fingerprint: o.fingerprint })),
    opponentsDigest: sha256Canonical(opponents.map(o => ({ id: o.id, fingerprint: o.fingerprint }))),
    seatCounts: [...REQUIRED_SEAT_COUNTS],
    weights: weightMap,
    seatWindows: windows,
    minSeedsPerSeatCount,
    maxSeedsPerSeatCount: maxSeedsPerSeatCount ?? Math.max(...Object.values(windows).map(w => w.count)),
    alphaBudget,
    challengeIndex,
    nonInferiorityMargin,
    searchWorkUnits,
    stoppingRule: { ...DEFAULT_STOPPING_RULE },
    multiplicity: {
      withinChallenge: 'IUT（主检验 + 各人数非劣效，各自在 alpha 水平，全部通过才晋级）',
      acrossChallenges: '几何 alpha 消耗（α_k = alphaBudget / 2^k），由 alpha-ledger 强制',
      acrossCandidates: 'fixed-sequence：一次挑战只检验预注册的首选候选；失败即停止，不重置预算',
    },
    engine: engineDescriptor,
    validationPool: [VALIDATION_POOL_BASE, VALIDATION_POOL_MAX],
    note: '计划创建后不可修改；读取正式验证结果前必须落盘加锁',
  };
  const planHash = sha256Canonical(plan);
  return deepFreeze({ ...plan, planHash });
}

/** 计划落盘（加锁）。已存在同名计划且内容不同 → 拒绝（防止事后改口径）。 */
export function lockPreregistration({ plan, dir, writeJSON }) {
  assertCondition(plan?.schema === PREREGISTRATION_SCHEMA, '计划 schema 非法');
  assertCondition(typeof plan.planHash === 'string', '计划缺少 planHash');
  const path = resolve(dir, `${plan.planId}.json`);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    if (existing?.plan?.planHash !== plan.planHash) {
      throw new Error(`预注册计划 ${plan.planId} 已存在且内容不同（hash ${existing?.plan?.planHash} ≠ ${plan.planHash}）——禁止事后修改实验口径`);
    }
    return { path, planHash: plan.planHash, alreadyLocked: true };
  }
  const lock = {
    schema: PREREGISTRATION_LOCK_SCHEMA,
    plan,
    lockedAt: new Date().toISOString(),
  };
  writeJSON(path, lock);
  return { path, planHash: plan.planHash, alreadyLocked: false };
}

/** 读取并复核计划 hash（任何字段被改动都会失败）。 */
export function loadPreregistration(path) {
  assertCondition(existsSync(path), `预注册计划不存在：${path}`);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  assertCondition(doc.schema === PREREGISTRATION_LOCK_SCHEMA, '预注册锁文件 schema 非法');
  assertCondition(doc.plan && typeof doc.plan === 'object', '预注册锁文件缺少 plan');
  const { planHash, ...basePlan } = doc.plan;
  const recomputed = sha256Canonical(basePlan);
  assertCondition(recomputed === planHash,
    `预注册计划 hash 被篡改：记录 ${planHash} ≠ 复算 ${recomputed}`);
  return deepFreeze({ ...basePlan, planHash, lockedAt: doc.lockedAt });
}

/** 执行前核验：候选/冠军/对手/引擎身份必须与计划一致。 */
export function assertPlanIdentity({ plan, candidate, champion, opponents, engine = null }) {
  assertCondition(candidate.parametersSha256 === plan.candidate.parametersSha256, '候选参数身份与预注册不一致');
  assertCondition(candidate.sourceHash === plan.candidate.sourceHash, '候选源码哈希与预注册不一致（验证期间被修改？）');
  assertCondition(candidate.artifactHash === plan.candidate.artifactHash, '候选产物哈希与预注册不一致');
  assertCondition(champion.parametersSha256 === plan.champion.parametersSha256, '冠军参数身份与预注册不一致（冠军在验证期间被替换？）');
  assertCondition(champion.artifactHash === plan.champion.artifactHash, '冠军产物哈希与预注册不一致');
  const opponentDigest = sha256Canonical(opponents.map(o => ({ id: o.id, fingerprint: o.fingerprint })));
  assertCondition(opponentDigest === plan.opponentsDigest, '对手阵容与预注册不一致');
  if (plan.engine && engine) {
    if (plan.engine.decisionSourceSha256) {
      assertCondition(engine.decisionSourceSha256 === plan.engine.decisionSourceSha256,
        '引擎决策核心源码在验证期间发生变化（decisionSourceSha256 不符）');
    }
    if (plan.engine.decisionArtifactSha256) {
      assertCondition(engine.decisionArtifactSha256 === plan.engine.decisionArtifactSha256,
        '引擎决策核心产物在验证期间发生变化（decisionArtifactSha256 不符）');
    }
    assertCondition(engine.engineBundleSha256 === plan.engine.engineBundleSha256,
      '引擎产物在验证期间发生变化（engineBundleSha256 不符）');
    assertCondition(engine.sourceClosureSha256 === plan.engine.sourceClosureSha256,
      '源码闭包在验证期间发生变化（sourceClosureSha256 不符）');
  }
  return true;
}

/** 执行后核验：种子必须来自计划区块、全局唯一、且不跨人数复用。 */
export function assertValidationSeeds({ plan, seedsBySeatCount }) {
  const seen = new Map();
  for (const seatCount of plan.seatCounts) {
    const list = seedsBySeatCount?.[String(seatCount)] ?? seedsBySeatCount?.[seatCount];
    assertCondition(Array.isArray(list) && list.length > 0, `${seatCount} 人验证种子缺失`);
    const window = plan.seatWindows[String(seatCount)];
    assertCondition(list.length <= window.count, `${seatCount} 人验证种子数 ${list.length} 超过预注册窗口 ${window.count}`);
    for (const seed of list) {
      assertCondition(Number.isSafeInteger(seed), `${seatCount} 人种子非法：${String(seed)}`);
      assertCondition(seed >= window.base && seed < window.base + window.count,
        `${seatCount} 人种子 ${seed} 落在预注册窗口 [${window.base}, ${window.base + window.count}) 之外`);
      assertCondition(!seen.has(seed), `种子 ${seed} 被重复使用（${seen.get(seed)} 人与 ${seatCount} 人）——跨人数/跨层相关`);
      seen.set(seed, seatCount);
    }
  }
  return true;
}

/** 固定样本核验：实际样本必须等于预注册样本，禁止中途窥视后停/加。 */
export function assertFixedSample({ plan, observedSeedsBySeatCount }) {
  assertCondition(plan.stoppingRule?.optionalStopping === false, '预注册禁止可选停止，但计划声明允许可选停止');
  for (const seatCount of plan.seatCounts) {
    const observed = observedSeedsBySeatCount?.[String(seatCount)] ?? observedSeedsBySeatCount?.[seatCount];
    assertCondition(Number.isSafeInteger(observed), `${seatCount} 人实际样本数缺失`);
    assertCondition(observed === plan.seatWindows[String(seatCount)].count,
      `${seatCount} 人实际样本 ${observed} ≠ 预注册 ${plan.seatWindows[String(seatCount)].count}（可选停止/补样本会破坏固定样本保证）`);
  }
  return true;
}

/** 结果时间核验：结果必须产生于计划锁定之后。 */
export function assertResultsAfterLock({ plan, resultsProducedAt }) {
  assertCondition(plan.lockedAt, '计划未锁定（缺少 lockedAt）');
  const locked = Date.parse(plan.lockedAt);
  const produced = Date.parse(resultsProducedAt);
  assertCondition(Number.isFinite(locked) && Number.isFinite(produced), '时间戳非法');
  assertCondition(produced >= locked, `结果时间 ${resultsProducedAt} 早于计划锁定 ${plan.lockedAt}——存在事后挑口径嫌疑`);
  return true;
}

export { canonicalJSON };
