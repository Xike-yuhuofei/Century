/** D3：多维候选筛选、行为多样性保留与去重。
 *
 * 解决的问题：
 * - 只选一次快筛冠军 → 多维评分 + 多候选保留；
 * - 多轮生成高度相似候选 → 行为签名去重 + 最小行为距离；
 * - 快筛优秀但深验不稳定 → 稳定性维度独立计分，深验窗口独立；
 * - 代理候选与对局候选不可比 → 分组保留，禁止把 proxy 分数当对局强度。
 *
 * 纪律：本模块只排序/保留，不修改候选，不触发晋级。
 */

import { assertCondition, clamp, deepFreeze, sha256Canonical } from './core.mjs';

function normalizedInverse(value, scale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return 1 / (1 + Math.max(0, value) / scale);
}

/** 行为距离：同类型签名比较；跨类型视为最大差异（不可比较）。 */
export function behaviorDistance(a, b) {
  if (!a || !b) return 1;
  if (a.kind !== b.kind) return 1;
  if (a.kind === 'game-behavior-v1') {
    const keys = ['acquire', 'claim', 'rest', 'play', 'discard'];
    const actionL1 = keys.reduce((s, k) => s + Math.abs((a.actions?.[k] ?? 0) - (b.actions?.[k] ?? 0)), 0);
    const actionDistance = clamp(actionL1 / 2, 0, 1);
    const rankDistance = a.meanRank === null || b.meanRank === null
      ? 0 : clamp(Math.abs(a.meanRank - b.meanRank) / 5, 0, 1);
    const scoreDistance = a.meanScore === null || b.meanScore === null
      ? 0 : clamp(Math.abs(a.meanScore - b.meanScore) / 120, 0, 1);
    const moveDistance = a.meanMoves === null || b.meanMoves === null
      ? 0 : clamp(Math.abs(a.meanMoves - b.meanMoves) / 400, 0, 1);
    return Number((0.55 * actionDistance + 0.15 * rankDistance + 0.2 * scoreDistance + 0.1 * moveDistance).toFixed(6));
  }
  if (a.kind === 'compiled-module-behavior-v1' && b.kind === 'compiled-module-behavior-v1') {
    // 编译型多模块候选：动作分布是唯一稳定的行为维度（其余字段随人数分层）。
    const keys = ['acquire', 'claim', 'rest', 'play'];
    const actionL1 = keys.reduce((s, k) => s + Math.abs((a.actions?.[k] ?? 0) - (b.actions?.[k] ?? 0)), 0);
    const moduleJaccard = (() => {
      const setA = new Set(a.modules ?? []);
      const setB = new Set(b.modules ?? []);
      const union = new Set([...setA, ...setB]);
      if (!union.size) return 0;
      const intersection = [...setA].filter(id => setB.has(id)).length;
      return 1 - intersection / union.size;
    })();
    return Number(clamp(0.7 * clamp(actionL1 / 2, 0, 1) + 0.3 * moduleJaccard, 0, 1).toFixed(6));
  }
  if (a.kind === 'proxy-coefficients-v1') {
    if (a.targetId !== b.targetId) return 1;
    const keys = new Set([...Object.keys(a.coefficients ?? {}), ...Object.keys(b.coefficients ?? {})]);
    const l1 = [...keys].reduce((s, k) => s + Math.abs((a.coefficients?.[k] ?? 0) - (b.coefficients?.[k] ?? 0)), 0);
    const bias = Math.abs((a.bias ?? 0) - (b.bias ?? 0));
    return Number(clamp(l1 / (keys.size * 2) + bias / 4, 0, 1).toFixed(6));
  }
  return 1;
}

/** 单候选多维评分（不依赖其他候选）。 */
export function scoreCandidate({ artifact, evidence }) {
  assertCondition(artifact && evidence, '评分需要 artifact 与 evidence');
  const safety = artifact.safety.status === 'passed' ? 1 : 0;
  const mode = artifact.algorithmStructure.evaluationMode;
  let quality = 0;
  let stability = 0;
  let cost = 0;
  if (mode === 'game') {
    const metrics = evidence.metrics;
    const chanceAdjusted = clamp(metrics.chanceAdjustedRate ?? 0, -1, 1);
    const wilsonLower = clamp(metrics.minWilsonLower ?? 0, 0, 1);
    quality = clamp(0.6 * ((chanceAdjusted + 1) / 2) + 0.4 * wilsonLower, 0, 1);
    stability = clamp(1 - (metrics.anomalyRate ?? 1), 0, 1);
    cost = normalizedInverse(metrics.p95WallMs ?? metrics.meanWallMs ?? 60000, 30_000);
  } else {
    const metrics = evidence.metrics;
    quality = clamp((metrics.proxyDelta + 1) / 2, 0, 1);
    stability = clamp(1 - (metrics.fallbackRate ?? 1), 0, 1);
    cost = 1; // 代理评估成本恒定
  }
  const composite = mode === 'game'
    ? 0.5 * quality + 0.2 * stability + 0.1 * cost + 0.2 * safety
    : 0.55 * quality + 0.2 * stability + 0.1 * cost + 0.15 * safety;
  return deepFreeze({
    candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest,
    evaluationMode: mode,
    targetIds: [...artifact.algorithmStructure.targetIds],
    quality: Number(quality.toFixed(6)),
    stability: Number(stability.toFixed(6)),
    cost: Number(cost.toFixed(6)),
    safety,
    composite: Number(composite.toFixed(6)),
  });
}

/** 行为签名身份哈希（精确重复检测）。 */
export function behaviorHash(evidence) {
  return evidence?.behaviorHash ?? sha256Canonical(evidence?.behaviorSignature ?? null);
}

/**
 * 多候选保留选择。
 *
 * @param {object} options
 * @param {Array<{artifact:object,evidence:object}>} options.entries
 * @param {number} options.maxKeep 最多保留数
 * @param {number} [options.minBehaviorDistance] 最小行为距离（默认 0.12）
 * @param {boolean} [options.requireSafety] 是否只保留安全通过候选（默认 true）
 * @returns {{selected:object[], rejected:object[], duplicates:object[], summary:object}}
 */
export function selectCandidates({
  entries, maxKeep, minBehaviorDistance = 0.12, requireSafety = true,
}) {
  assertCondition(Array.isArray(entries), 'entries 必须为数组');
  assertCondition(Number.isSafeInteger(maxKeep) && maxKeep > 0, `maxKeep 必须为正整数，实际：${maxKeep}`);

  const scored = entries.map(entry => ({
    ...entry,
    score: scoreCandidate({ artifact: entry.artifact, evidence: entry.evidence }),
    behaviorHash: behaviorHash(entry.evidence),
  }));
  const rejected = [];
  const duplicates = [];
  const eligible = [];
  const seenIdentity = new Set();
  const seenBehavior = new Set();

  for (const entry of scored) {
    if (requireSafety && entry.artifact.safety.status !== 'passed') {
      rejected.push({ candidateId: entry.artifact.candidateId, reason: `safety=${entry.artifact.safety.status}` });
      continue;
    }
    if (entry.artifact.algorithmStructure.evaluationMode === 'game' && (entry.evidence.metrics.anomalyRate ?? 1) > 0.2) {
      rejected.push({ candidateId: entry.artifact.candidateId, reason: `anomalyRate=${entry.evidence.metrics.anomalyRate}` });
      continue;
    }
    if (entry.artifact.algorithmStructure.evaluationMode === 'proxy' && (entry.evidence.metrics.fallbackRate ?? 1) > 0.5) {
      rejected.push({ candidateId: entry.artifact.candidateId, reason: `fallbackRate=${entry.evidence.metrics.fallbackRate}` });
      continue;
    }
    if (seenIdentity.has(entry.artifact.identityDigest)) {
      duplicates.push({ candidateId: entry.artifact.candidateId, reason: 'identity-duplicate' });
      continue;
    }
    if (seenBehavior.has(entry.behaviorHash)) {
      duplicates.push({ candidateId: entry.artifact.candidateId, reason: 'behavior-hash-duplicate' });
      continue;
    }
    seenIdentity.add(entry.artifact.identityDigest);
    seenBehavior.add(entry.behaviorHash);
    eligible.push(entry);
  }

  eligible.sort((a, b) => (b.score.composite - a.score.composite) || (a.artifact.candidateId < b.artifact.candidateId ? -1 : 1));
  const selected = [];
  const selectedIds = new Set();

  const take = entry => {
    if (selected.length >= maxKeep || selectedIds.has(entry.artifact.candidateId)) return;
    selected.push(entry);
    selectedIds.add(entry.artifact.candidateId);
  };

  // 1) 先保留各评测模式的最高分（防止 proxy 与 game 分数不可比导致整组被吞）。
  for (const mode of ['game', 'proxy']) {
    const best = eligible.find(e => e.artifact.algorithmStructure.evaluationMode === mode);
    if (best) take(best);
  }
  // 2) 剩余名额优先保留对局候选（可挑战性），proxy 候选只作研究保留；
  //    每一类内部按“质量优先 + 行为距离”贪心，填不满再放宽阈值。
  const fillOrder = [...eligible].sort((a, b) => {
    const modeRank = entry => (entry.artifact.algorithmStructure.evaluationMode === 'game' ? 0 : 1);
    return (modeRank(a) - modeRank(b)) || (b.score.composite - a.score.composite)
      || (a.artifact.candidateId < b.artifact.candidateId ? -1 : 1);
  });
  for (const entry of fillOrder) {
    if (selected.length >= maxKeep) break;
    if (selectedIds.has(entry.artifact.candidateId)) continue;
    const distance = selected.length === 0
      ? 1
      : Math.min(...selected.map(s => behaviorDistance(entry.evidence.behaviorSignature, s.evidence.behaviorSignature)));
    if (distance >= minBehaviorDistance) take(entry);
  }
  if (selected.length < maxKeep) {
    for (const entry of fillOrder) {
      if (selected.length >= maxKeep) break;
      take(entry);
    }
  }

  const summary = {
    evaluated: entries.length,
    eligible: eligible.length,
    selected: selected.length,
    rejected: rejected.length,
    duplicates: duplicates.length,
    byMode: {
      game: selected.filter(e => e.artifact.algorithmStructure.evaluationMode === 'game').length,
      proxy: selected.filter(e => e.artifact.algorithmStructure.evaluationMode === 'proxy').length,
    },
    maxKeep,
    minBehaviorDistance,
    meanBehaviorDistance: selected.length < 2 ? null : Number((
      selected.reduce((sum, entry, i) => {
        if (i === 0) return sum;
        const prev = selected[i - 1];
        return sum + behaviorDistance(entry.evidence.behaviorSignature, prev.evidence.behaviorSignature);
      }, 0) / (selected.length - 1)).toFixed(6)),
    scoring: 'composite = quality/stability/cost/safety 加权；game 与 proxy 分组保留',
  };
  return deepFreeze({ selected, rejected, duplicates, summary });
}
