/** P0：Alpha 消耗账本（append-only，不可重置）。
 *
 * 背景：长期反复挑战会累积假阳性。仓库既有方案是几何消耗 α_k = 预算/2^k，
 * 但挑战序号来自种子账本的 challengeCount —— 它本身不是专门记录「已消耗多少
 * 显著性预算」的账本；一旦重复挑战、换名挑战或重建账本，α 就可能被静默重置。
 *
 * 本账本把每次正式挑战的 α 预留与最终判定显式落盘：
 * - challengeIndex 必须严格递增且无空洞（1,2,3,…）；
 * - 同一 planId 不得重复使用；
 * - 每个 challengeIndex 只能有一条预留与一条结果（结果不可覆盖）；
 * - 累计消耗不得超过 alphaBudget；
 * - 任何完整性失败 → fail-closed（拒绝新的挑战/晋级）。
 *
 * 旧几何逻辑仍保留在 evaluator/stats.mjs 作为历史复现工具；新正式流程必须
 * 同时通过本账本。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { probit } from '../evaluator/stats.mjs';

export const ALPHA_LEDGER_SCHEMA = 'century-alpha-ledger-v1';
export const ALPHA_LEDGER_PATH = resolve(REPO_ROOT, 'training/governance/alpha-ledger.json');
export const DEFAULT_ALPHA_BUDGET = 0.05;
const LOCK_TIMEOUT_MS = 10_000;
const FLOAT_EPS = 1e-12;

export function emptyAlphaLedger({ alphaBudget = DEFAULT_ALPHA_BUDGET, spendingPlan = null } = {}) {
  return {
    schema: ALPHA_LEDGER_SCHEMA,
    alphaBudget,
    familyId: 'century-formal-challenges-v1',
    spendingPlan: spendingPlan ?? {
      mode: 'geometric',
      createdAt: new Date().toISOString(),
      note: '兼容起点：α_k = alphaBudget / 2^k；总额严格 ≤ alphaBudget',
    },
    createdAt: new Date().toISOString(),
    reservations: [],
    outcomes: [],
    note: 'append-only；challengeIndex 严格递增；累计消耗不得超过 alphaBudget',
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLedgerLock(path, fn) {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`alpha 账本锁等待超时：${lockPath}`);
      }
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* 已关闭 */ }
    try { unlinkSync(lockPath); } catch { /* 已清理 */ }
  }
}

function atomicWriteJSON(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function readAlphaLedger(path = ALPHA_LEDGER_PATH) {
  if (!existsSync(path)) return emptyAlphaLedger();
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  assertAlphaLedgerIntegrity(ledger);
  return ledger;
}

export function alphaForChallenge(challengeIndex, alphaBudget = DEFAULT_ALPHA_BUDGET, spendingPlan = null) {
  if (!Number.isSafeInteger(challengeIndex) || challengeIndex < 1) {
    throw new Error(`challengeIndex 必须为 ≥1 的整数，实际：${challengeIndex}`);
  }
  if (!(alphaBudget > 0 && alphaBudget < 1)) {
    throw new Error(`alphaBudget 必须在 (0,1)，实际：${alphaBudget}`);
  }
  const plan = spendingPlan ?? { mode: 'geometric' };
  if (plan.mode === 'fixed-horizon-bonferroni') {
    const horizon = Number(plan.maxChallenges);
    if (!Number.isSafeInteger(horizon) || horizon < 1) {
      throw new Error(`fixed-horizon 计划的 maxChallenges 非法：${plan.maxChallenges}`);
    }
    if (challengeIndex > horizon) {
      throw new Error(
        `统计预算已按预注册计划耗尽（challengeIndex ${challengeIndex} > horizon ${horizon}）——` +
        '必须明确停止正式挑战；不得静默重置预算或换名继续',
      );
    }
    const alpha = alphaBudget / horizon;
    return { challengeIndex, alpha, alphaBudget, z: probit(1 - alpha), spendingMode: plan.mode, maxChallenges: horizon };
  }
  if (plan.mode !== 'geometric') throw new Error(`未知 alpha 消耗模式：${String(plan.mode)}`);
  const alpha = alphaBudget / 2 ** challengeIndex;
  return { challengeIndex, alpha, alphaBudget, z: probit(1 - Math.max(alpha, 1e-15)), spendingMode: 'geometric' };
}

export function assertAlphaLedgerIntegrity(ledger) {
  if (!ledger || ledger.schema !== ALPHA_LEDGER_SCHEMA) throw new Error('alpha 账本 schema 非法');
  if (!(ledger.alphaBudget > 0 && ledger.alphaBudget < 1)) throw new Error('alpha 账本 alphaBudget 非法');
  if (!Array.isArray(ledger.reservations) || !Array.isArray(ledger.outcomes)) {
    throw new Error('alpha 账本结构非法（reservations/outcomes 必须为数组）');
  }
  const planIds = new Set();
  let cumulative = 0;
  let previous = 0;
  for (const [index, entry] of ledger.reservations.entries()) {
    if (entry.challengeIndex !== previous + 1) {
      throw new Error(`alpha 账本 challengeIndex 必须严格连续递增：第 ${index} 条为 ${entry.challengeIndex}，期望 ${previous + 1}（禁止重置/跳号）`);
    }
    previous = entry.challengeIndex;
    if (typeof entry.planId !== 'string' || entry.planId.length === 0) throw new Error(`第 ${index} 条缺少 planId`);
    if (planIds.has(entry.planId)) throw new Error(`planId ${entry.planId} 被重复预留（禁止换名重置预算）`);
    planIds.add(entry.planId);
    const expected = alphaForChallenge(entry.challengeIndex, ledger.alphaBudget, ledger.spendingPlan);
    if (Math.abs(entry.alpha - expected.alpha) > FLOAT_EPS) {
      throw new Error(`第 ${entry.challengeIndex} 次预留 alpha=${entry.alpha} ≠ 预注册消耗计划 ${expected.alpha}（禁止手工放宽）`);
    }
    cumulative += entry.alpha;
    if (cumulative > ledger.alphaBudget + FLOAT_EPS) {
      throw new Error(`累计 alpha ${cumulative} 超过预算 ${ledger.alphaBudget}`);
    }
  }
  const outcomeIndexes = new Set();
  for (const outcome of ledger.outcomes) {
    if (outcomeIndexes.has(outcome.challengeIndex)) {
      throw new Error(`challengeIndex ${outcome.challengeIndex} 存在多条结果（结果不可覆盖）`);
    }
    outcomeIndexes.add(outcome.challengeIndex);
    if (!ledger.reservations.some(r => r.challengeIndex === outcome.challengeIndex)) {
      throw new Error(`结果引用了未预留的 challengeIndex ${outcome.challengeIndex}`);
    }
  }
  return true;
}

/** 预留一次正式挑战的 alpha（必须在读取正式验证结果之前）。 */
export function reserveAlpha({
  challengeIndex, planId, candidateId, evidenceDir = null,
  alphaBudget = null, ledgerPath = ALPHA_LEDGER_PATH,
}) {
  if (typeof planId !== 'string' || planId.length === 0) throw new Error('reserveAlpha 缺少 planId');
  if (typeof candidateId !== 'string' || candidateId.length === 0) throw new Error('reserveAlpha 缺少 candidateId');
  return withLedgerLock(ledgerPath, () => {
    const ledger = existsSync(ledgerPath)
      ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
      : emptyAlphaLedger({ alphaBudget: alphaBudget ?? DEFAULT_ALPHA_BUDGET });
    assertAlphaLedgerIntegrity(ledger);
    if (alphaBudget !== null && Math.abs(alphaBudget - ledger.alphaBudget) > FLOAT_EPS) {
      throw new Error(`alphaBudget 与账本不一致（账本 ${ledger.alphaBudget}，请求 ${alphaBudget}）——禁止重置预算`);
    }
    const expectedIndex = ledger.reservations.length === 0
      ? 1
      : ledger.reservations[ledger.reservations.length - 1].challengeIndex + 1;
    if (challengeIndex !== expectedIndex) {
      throw new Error(
        `challengeIndex ${challengeIndex} ≠ 账本下一个可用序号 ${expectedIndex}——` +
        '重复挑战/换名挑战不得重置或跳过 alpha 预算',
      );
    }
    const entry = alphaForChallenge(challengeIndex, ledger.alphaBudget, ledger.spendingPlan);
    const reserved = {
      challengeIndex,
      planId,
      candidateId,
      alpha: entry.alpha,
      z: entry.z,
      alphaBudget: ledger.alphaBudget,
      evidenceDir,
      reservedAt: new Date().toISOString(),
      status: 'reserved',
    };
    ledger.reservations.push(reserved);
    assertAlphaLedgerIntegrity(ledger);
    atomicWriteJSON(ledgerPath, ledger);
    return reserved;
  });
}

/** 追加结果（不可覆盖；失败也必须记录，失败不退还 alpha）。 */
export function completeAlpha({
  challengeIndex, decision, evidenceHash, planId, ledgerPath = ALPHA_LEDGER_PATH,
}) {
  if (!Number.isSafeInteger(challengeIndex) || challengeIndex < 1) throw new Error('completeAlpha challengeIndex 非法');
  if (typeof decision !== 'string' || decision.length === 0) throw new Error('completeAlpha 缺少 decision');
  return withLedgerLock(ledgerPath, () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assertAlphaLedgerIntegrity(ledger);
    const reservation = ledger.reservations.find(r => r.challengeIndex === challengeIndex);
    if (!reservation) throw new Error(`未找到 challengeIndex ${challengeIndex} 的 alpha 预留`);
    if (planId && reservation.planId !== planId) {
      throw new Error(`planId 不符：预留 ${reservation.planId} ≠ 结果 ${planId}`);
    }
    const outcome = {
      challengeIndex,
      planId: reservation.planId,
      decision,
      evidenceHash: typeof evidenceHash === 'string' ? evidenceHash : null,
      completedAt: new Date().toISOString(),
    };
    ledger.outcomes.push(outcome);
    assertAlphaLedgerIntegrity(ledger);
    atomicWriteJSON(ledgerPath, ledger);
    return outcome;
  });
}

/** 汇总（审计报告用）。 */
export function alphaLedgerSummary(ledger) {
  const spent = ledger.reservations.reduce((s, r) => s + r.alpha, 0);
  return {
    schema: ledger.schema,
    familyId: ledger.familyId ?? null,
    spendingPlan: ledger.spendingPlan ?? { mode: 'geometric' },
    alphaBudget: ledger.alphaBudget,
    challenges: ledger.reservations.length,
    completed: ledger.outcomes.length,
    spent,
    remaining: ledger.alphaBudget - spent,
    nextChallengeIndex: (ledger.reservations.at(-1)?.challengeIndex ?? 0) + 1,
    lastDecision: ledger.outcomes.at(-1)?.decision ?? null,
  };
}

/**
 * 初始化一个新的 alpha 家族（显式治理动作，不会自动发生）。
 *
 * 用途：长期运行时几何消耗会耗尽预算。可持续的替代方案是「预注册固定期限 +
 * 等额 Bonferroni」：预先承诺最多 K 次正式挑战，每次 α = budget / K。
 * 该方案统计功效在后期远高于几何消耗（α 不随 k 衰减到 0），但必须在**开始
 * 该家族之前**显式写入授权记录；不得在中途因结果不显著而重建账本。
 *
 * @param {object} options
 * @param {'geometric'|'fixed-horizon-bonferroni'} options.mode
 * @param {number} [options.maxChallenges] fixed-horizon 模式必填
 * @param {number} [options.alphaBudget]
 * @param {string} options.authorization 授权依据（PR/issue/治理记录 id）；不得为空
 * @param {string} options.authorizedBy 授权主体（账号或流程）
 * @param {string} [options.ledgerPath]
 */
export function initializeAlphaFamily({
  mode, maxChallenges = null, alphaBudget = DEFAULT_ALPHA_BUDGET,
  authorization, authorizedBy, familyId = null, ledgerPath = ALPHA_LEDGER_PATH,
}) {
  if (!['geometric', 'fixed-horizon-bonferroni'].includes(mode)) throw new Error(`未知模式：${mode}`);
  if (typeof authorization !== 'string' || authorization.trim().length === 0) {
    throw new Error('初始化 alpha 家族必须提供非空 authorization（禁止静默重置统计预算）');
  }
  if (typeof authorizedBy !== 'string' || authorizedBy.trim().length === 0) {
    throw new Error('初始化 alpha 家族必须提供 authorizedBy');
  }
  if (mode === 'fixed-horizon-bonferroni') {
    if (!Number.isSafeInteger(maxChallenges) || maxChallenges < 1) throw new Error('fixed-horizon 模式必须提供正整数 maxChallenges');
  }
  if (existsSync(ledgerPath)) {
    throw new Error(`alpha 账本已存在（${ledgerPath}）——禁止覆盖/重置；如需新家族必须使用新路径并显式审计`);
  }
  const ledger = emptyAlphaLedger({
    alphaBudget,
    spendingPlan: {
      mode,
      ...(mode === 'fixed-horizon-bonferroni' ? { maxChallenges } : {}),
      createdAt: new Date().toISOString(),
      authorization,
      authorizedBy,
      note: mode === 'fixed-horizon-bonferroni'
        ? `预注册期限：最多 ${maxChallenges} 次正式挑战，每次 α = ${alphaBudget}/${maxChallenges}；期满必须停止`
        : 'α_k = alphaBudget / 2^k',
    },
  });
  if (familyId) ledger.familyId = familyId;
  assertAlphaLedgerIntegrity(ledger);
  atomicWriteJSON(ledgerPath, ledger);
  return ledger;
}
