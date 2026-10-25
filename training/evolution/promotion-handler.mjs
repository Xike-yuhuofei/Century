/** P2/P4：候选进入机器门禁队列后的自动正式挑战处理器。
 *
 * 设计边界：
 * - 本模块只负责「是否值得发起正式挑战」以及「发起挑战并产出证据」；
 * - 冠军发布仍由 CI 的 promotion-machine-gate 完成（独立复核 + auto-merge）；
 * - alpha 预算不足或功效不达标时明确返回 BLOCKED，绝不静默消费验证种子；
 * - proxy-only 候选没有真实对局行为，不得进入第一名率正式挑战。
 */

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { readAlphaLedger, alphaForChallenge, ALPHA_LEDGER_PATH } from '../lib/alpha-ledger.mjs';
import { powerAt, requiredSeeds } from '../evaluator/power.mjs';
import { readJSON } from '../lib/io.mjs';

/**
 * 默认挑战资格政策（读取任何正式结果之前固定）：
 * - 500 种子/人数是 M4 上约 5–6 小时可完成的现实样本；
 * - 目标效应 20pp、方差上界 1（最保守）、功效 80%：在可持续固定期限家族
 *   α=5e-4 下功效约 0.88；在当前几何 α=1.22e-5 下仅 0.60，因此当前预算
 *   会明确 BLOCKED，不会把最后一个 alpha 花在无法检测小效应的挑战上；
 * - 该政策只决定「是否值得发起挑战」，不改变正式挑战的预注册与判定。
 */
const DEFAULT_POLICY = Object.freeze({
  seedsPerSeat: 500,
  targetEffect: 0.2,
  variance: 1,
  minPower: 0.8,
});

/**
 * 预注册功效门禁（读取任何正式结果之前判定）。
 *
 * @param {object} options
 * @param {object} options.ledger alpha 账本
 * @param {number} [options.seedsPerSeat] 计划样本（每人数）
 * @param {number} [options.targetEffect] 目标检测效应（第一名率绝对增量）
 * @param {number} [options.variance] 保守方差上界（1 = 最保守）
 * @param {number} [options.minPower]
 */
export function assessChallengeReadiness({
  ledger,
  seedsPerSeat = DEFAULT_POLICY.seedsPerSeat,
  targetEffect = DEFAULT_POLICY.targetEffect,
  variance = DEFAULT_POLICY.variance,
  minPower = DEFAULT_POLICY.minPower,
}) {
  const nextChallengeIndex = (ledger.reservations.at(-1)?.challengeIndex ?? 0) + 1;
  const alpha = alphaForChallenge(nextChallengeIndex, ledger.alphaBudget, ledger.spendingPlan).alpha;
  const power = powerAt({ n: seedsPerSeat, effect: targetEffect, alpha, variance });
  const needed = requiredSeeds({ effect: targetEffect, alpha, power: minPower, variance });
  const remaining = ledger.alphaBudget - ledger.reservations.reduce((s, r) => s + r.alpha, 0);
  if (!(alpha > 0)) {
    return {
      ready: false, reason: 'alpha-budget-exhausted', alpha, nextChallengeIndex,
      remaining, power, requiredSeeds: needed,
    };
  }
  if (power < minPower) {
    return {
      ready: false, reason: 'insufficient-statistical-power', alpha, nextChallengeIndex,
      remaining, power, requiredSeeds: needed,
      note: `每人数 ${seedsPerSeat} 种子在 α=${alpha} 下仅能检测 ${targetEffect} 效应于 ${(power * 100).toFixed(1)}% 功效；达到 ${(minPower * 100)}% 需要约 ${needed} 个独立种子/人数`,
    };
  }
  return {
    ready: true, reason: null, alpha, nextChallengeIndex,
    remaining, power, requiredSeeds: needed, seedsPerSeat, targetEffect, variance,
  };
}

function artifactEvaluationMode(artifact) {
  const structure = artifact?.algorithmStructure ?? {};
  return structure.evaluationMode
    ?? (structure.decisionCore === 'plugin-only' ? 'proxy' : 'game');
}

/** 把 Candidate Artifact 转成正式挑战 CLI 可消费的候选文档。 */
export function candidateDocFromArtifact(artifact) {
  const values = artifact?.parameters?.values ?? {};
  return {
    id: artifact.candidateId,
    parameters: { ...values, id: artifact.candidateId },
    sourceHash: artifact.sourceHash,
    artifactHash: artifact.artifactHash,
    algorithmStructure: artifact.algorithmStructure,
  };
}

function defaultChallengeRunner({ artifact, evidenceDir, policy }) {
  const doc = candidateDocFromArtifact(artifact);
  const dir = mkdtempSync(join(tmpdir(), 'century-challenge-cert-'));
  const candidatePath = join(dir, 'candidate.json');
  writeFileSync(candidatePath, JSON.stringify(doc, null, 2));
  return new Promise(resolveRun => {
    execFile(process.execPath, [
      resolve(REPO_ROOT, 'training/tournament/run-first-place-challenge.mjs'),
      '--candidate', candidatePath,
      '--seeds-per-seat', String(policy.seedsPerSeat),
      '--work-units', String(policy.workUnits ?? 64),
      '--out', evidenceDir,
    ], { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 24 * 3600_000 }, (error, stdout, stderr) => {
      const evidence = readJSON(join(evidenceDir, 'challenge-evidence.json'));
      resolveRun({
        ok: Boolean(evidence),
        exitCode: error?.code ?? 0,
        stdout: String(stdout ?? '').slice(-2000),
        stderr: String(stderr ?? '').slice(-1000),
        evidenceDir,
        evidence,
        decision: evidence?.decision ?? null,
      });
    });
  });
}

/** 把通过证据复制到 CI 机器门禁固定读取的 latest 目录。 */
function publishEvidenceToLatest(evidenceDir) {
  const latest = resolve(REPO_ROOT, 'training/reports/first-place-promotion/latest');
  mkdirSync(latest, { recursive: true });
  for (const name of ['preregistration.json', 'challenge-evidence.json', 'candidate.json']) {
    const source = join(evidenceDir, name);
    if (existsSync(source)) copyFileSync(source, join(latest, name));
  }
  return latest;
}

/**
 * 创建 CampaignController 的 promotionHandler。
 *
 * @param {object} [options]
 * @param {string} [options.ledgerPath]
 * @param {object} [options.policy] {seedsPerSeat,targetEffect,variance,minPower,workUnits}
 * @param {Function} [options.challengeRunner] 测试注入点；生产默认调用正式挑战 CLI
 */
export function createPromotionHandler({
  ledgerPath = ALPHA_LEDGER_PATH,
  policy = {},
  challengeRunner = defaultChallengeRunner,
  publish = publishEvidenceToLatest,
} = {}) {
  const resolvedPolicy = { ...DEFAULT_POLICY, ...policy };
  return async function promotionHandler({ campaignId, artifact, request, requestPath }) {
    if (!artifact) {
      return { verdict: 'BLOCKED', reason: 'missing-artifact', promotionTriggered: false };
    }
    const mode = artifactEvaluationMode(artifact);
    if (mode !== 'game') {
      return {
        verdict: 'BLOCKED', reason: 'not-game-evaluable',
        note: `候选评估模式为 ${mode}，proxy 候选没有真实对局行为，不得消费正式验证种子`,
        promotionTriggered: false,
      };
    }
    let ledger;
    try {
      ledger = readAlphaLedger(ledgerPath);
    } catch (error) {
      return { verdict: 'BLOCKED', reason: 'alpha-ledger-unavailable', error: String(error.message).slice(0, 300), promotionTriggered: false };
    }
    const readiness = assessChallengeReadiness({ ledger, ...resolvedPolicy });
    if (!readiness.ready) {
      return {
        verdict: 'BLOCKED', reason: readiness.reason, readiness,
        campaignId, candidateId: artifact.candidateId, requestId: request?.requestId ?? null,
        requestPath, promotionTriggered: false,
        note: '统计预算/功效不足：保留现任冠军，不消费验证种子与 alpha',
      };
    }

    const evidenceDir = resolve(REPO_ROOT, 'training/reports/first-place-promotion', artifact.candidateId);
    const result = await challengeRunner({ artifact, evidenceDir, policy: resolvedPolicy, request, requestPath });
    if (!result?.evidence) {
      return {
        verdict: 'CHALLENGE_ERROR', reason: 'no-evidence-produced',
        exitCode: result?.exitCode ?? null, stderr: result?.stderr ?? null,
        evidenceDir, promotionTriggered: false,
      };
    }
    if (result.decision?.promote !== true) {
      return {
        verdict: 'NOT_PROMOTED', reason: result.decision?.verdict ?? 'not-promoted',
        evidenceDir, evidenceHash: result.evidence.evidenceHash,
        decision: result.decision, promotionTriggered: false,
      };
    }
    const latest = publish(evidenceDir);
    return {
      verdict: 'PROMOTE_EVIDENCE_READY',
      evidenceDir, latest, evidenceHash: result.evidence.evidenceHash,
      decision: result.decision,
      promotionTriggered: false,
      note: '证据已就绪；冠军落地与发布由 CI promotion-machine-gate 独立复核并 auto-merge',
    };
  };
}

export { DEFAULT_POLICY };
