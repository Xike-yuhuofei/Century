/** D3：候选生成器（确定性、可复现、支持从基线/父候选继续）。
 *
 * 本轮提供两类生成器：
 * 1. 确定性有界变异生成器（默认，无 LLM、无网络）：按目标边界扰动默认值或父候选值；
 * 2. OpenEvolve/LLM 生成器适配接口（`externalGenerator` 注入点）：离线研发阶段可
 *    由 OpenEvolve 产出候选 spec，但最终产物仍是本模块的 Candidate Artifact，
 *    且必须在游戏推理前完全本地化（LLM 不进入运行时）。
 *
 * 生成只产合法候选；非法 spec 由 createCandidateFromSpec 显式抛错，供演示/测试
 * 记录"生成即拒绝"的失败隔离。
 */

import { gaussian, mulberry32 } from '../lib/rng.mjs';
import {
  getTarget, listTargets, normalizeModuleSpec, normalizeSearchValues,
  buildGameCandidatePieces, buildProxyCandidatePieces, defaultTargetValues,
} from './evolution-targets.mjs';
import { createCandidateArtifact } from './candidate-artifact.mjs';
import {
  ALL_PLAYER_COUNTS, SCHEMAS, assertCondition, canonicalJSON, clamp, gameRulesDescriptor,
  sha256Canonical, shortHash,
} from './core.mjs';

const gameRulesCache = { value: null };
function cachedGameRules() {
  if (!gameRulesCache.value) gameRulesCache.value = gameRulesDescriptor();
  return gameRulesCache.value;
}

function slug(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 24);
}

function candidateIdFor({ targetId, round, index, values }) {
  const digest = shortHash(sha256Canonical(values), 6);
  return `cand-ai7-${slug(targetId)}-r${round}c${index}-${digest}`;
}

function cloneValues(targetId, values) {
  return JSON.parse(JSON.stringify(values));
}

/** 从父 artifact 提取同一目标的起点值（支持"从已批准候选继续"）。 */
export function parentValuesFor(parentArtifact, targetId) {
  if (!parentArtifact) return defaultTargetValues(targetId);
  const target = getTarget(targetId);
  if (!parentArtifact.algorithmStructure.targetIds.includes(targetId)) {
    return defaultTargetValues(targetId);
  }
  if (target.kind === 'function-module') {
    return cloneValues(targetId, parentArtifact.parameters.values);
  }
  const options = parentArtifact.algorithmStructure.jointOptionsByPlayerCount ?? {};
  if (target.structural) {
    return { playerCounts: [...parentArtifact.applicablePlayerCounts] };
  }
  if (target.perPlayerCount) {
    return Object.fromEntries(ALL_PLAYER_COUNTS.map(n => [String(n), options[String(n)]?.workUnits ?? target.defaultValue[String(n)]]));
  }
  const key = target.jointOptionKey;
  return { [key]: options[String(ALL_PLAYER_COUNTS[0])]?.[key] ?? target.defaultValue[key] };
}

function perturbModule(target, baseValues, random) {
  const coefficients = {};
  for (const key of target.featureKeys) {
    const current = baseValues.coefficients?.[key] ?? target.defaultCoefficients[key];
    const [low, high] = target.coefficientBounds[key];
    coefficients[key] = Number(clamp(current + gaussian(random) * 0.35, low, high).toFixed(4));
  }
  const bias = Number(clamp((baseValues.bias ?? 0) + gaussian(random) * 0.08, target.biasBounds[0], target.biasBounds[1]).toFixed(4));
  return { template: baseValues.template ?? 'linear-feature-v1', coefficients, bias };
}

function perturbSearch(target, baseValues, random) {
  if (target.structural) {
    const base = new Set(baseValues.playerCounts ?? ALL_PLAYER_COUNTS);
    // 确定性：每个轮次至少保留一个基准人数，并以随机数决定是否裁剪第 5 人。
    const counts = ALL_PLAYER_COUNTS.filter(n => {
      if (!base.has(n)) return false;
      if (n === 2) return true;
      return random() < 0.8;
    });
    return { playerCounts: counts.length ? counts : [2, 3] };
  }
  if (target.perPlayerCount) {
    const result = {};
    for (const n of ALL_PLAYER_COUNTS) {
      const key = String(n);
      const current = baseValues[key] ?? target.defaultValue[key];
      const [low, high] = target.bounds[key];
      const next = target.integer ? Math.round(current + gaussian(random) * 24) : current + gaussian(random) * 0.1;
      result[key] = clamp(next, low, high);
    }
    return result;
  }
  const key = Object.keys(target.defaultValue)[0];
  const current = baseValues[key] ?? target.defaultValue[key];
  const [low, high] = target.bounds[key];
  const step = target.integer ? 2 : Math.max(0.01, (high - low) * 0.08);
  const next = current + gaussian(random) * step;
  return { [key]: target.integer ? Math.round(clamp(next, low, high)) : Number(clamp(next, low, high).toFixed(4)) };
}

/** 按目标规范化并构造 artifact。 */
export function createCandidateFromSpec({
  targetId, values, round = 1, index = 0, candidateId = null,
  parentArtifact = null, experiment, playerCounts = null,
}) {
  const target = getTarget(targetId);
  assertCondition(experiment && typeof experiment === 'object', '生成候选必须提供 experiment 引用');
  const normalized = target.kind === 'function-module'
    ? normalizeModuleSpec(targetId, values)
    : normalizeSearchValues(targetId, values);
  const id = candidateId ?? candidateIdFor({ targetId, round, index, values: normalized });
  const pieces = target.kind === 'function-module'
    ? buildProxyCandidatePieces({ targetId, spec: normalized, candidateId: id, applicablePlayerCounts: playerCounts ?? ALL_PLAYER_COUNTS })
    : buildGameCandidatePieces({ targetId, values: normalized, candidateId: id, playerCounts });

  const parameters = target.kind === 'function-module'
    ? pieces.parameters
    : {
        id,
        version: target.version,
        values: pieces.parameters,
        boundsVersion: 'ai-parameters-v1',
      };

  const artifact = createCandidateArtifact({
    candidateId: id,
    parentId: parentArtifact?.candidateId ?? null,
    algorithmStructure: pieces.algorithmStructure,
    parameters,
    source: pieces.source ?? { kind: 'descriptor' },
    experiment,
    applicablePlayerCounts: pieces.applicablePlayerCounts,
    safety: { status: 'pending', checks: [] },
    gameRules: cachedGameRules(),
  });
  return { artifact, targetValues: pieces.targetValues, evaluationMode: pieces.algorithmStructure.evaluationMode };
}

/** 目标选择：失败标签 hint 可提高相关目标权重，但绝不作为奖励真值。 */
function chooseTarget({ random, targets, hints }) {
  const suggested = new Set(hints?.suggestedTargets ?? []);
  if (suggested.size === 0) {
    return targets[Math.floor(random() * targets.length)];
  }
  // 80% 概率落到建议目标，20% 保留探索；建议目标必须真实存在。
  if (random() < 0.2) return targets[Math.floor(random() * targets.length)];
  const suggestedTargets = targets.filter(t => suggested.has(t.id));
  if (suggestedTargets.length === 0) return targets[Math.floor(random() * targets.length)];
  return suggestedTargets[Math.floor(random() * suggestedTargets.length)];
}

/**
 * 生成一批候选（确定性：同 seed/round/parent/experiment ⇒ 同 artifacts）。
 *
 * @param {object} options
 * @param {number} options.count 候选数
 * @param {number} options.round 轮次（1 起）
 * @param {number} options.seed 生成种子（与游戏种子无关）
 * @param {object} options.experiment { configRef, configHash, seedRefs }
 * @param {object|null} [options.parentArtifact]
 * @param {string[]|null} [options.targetIds] 限定的目标集合
 * @param {object|null} [options.hints] 失败标签研究提示（suggestedTargets）
 * @param {(options:object)=>Array<object>|null} [options.externalGenerator] OpenEvolve 适配注入点
 */
export function generateCandidateBatch({
  count, round = 1, seed, experiment, parentArtifact = null,
  targetIds = null, hints = null, externalGenerator = null,
}) {
  assertCondition(Number.isSafeInteger(count) && count > 0, `count 必须为正整数，实际：${count}`);
  assertCondition(Number.isSafeInteger(seed) && seed >= 0, `seed 必须为非负整数，实际：${seed}`);
  assertCondition(Number.isSafeInteger(round) && round >= 1, `round 必须为 ≥1 整数`);
  assertCondition(experiment && typeof experiment === 'object', '缺少 experiment 引用');

  if (externalGenerator) {
    const external = externalGenerator({ count, round, seed, experiment, parentArtifact, targetIds, hints });
    if (Array.isArray(external)) {
      return external.map((item, index) => createCandidateFromSpec({
        ...item, round, index, parentArtifact, experiment,
      }));
    }
  }

  const targets = listTargets().filter(t => targetIds === null || targetIds.includes(t.id));
  assertCondition(targets.length > 0, '没有可用进化目标');
  const random = mulberry32(seed);
  const results = [];
  const seen = new Set();
  let guard = 0;
  while (results.length < count && guard < count * 20) {
    guard += 1;
    const target = chooseTarget({ random, targets, hints });
    const base = parentValuesFor(parentArtifact, target.id);
    const mutated = target.kind === 'function-module'
      ? perturbModule(target, base, random)
      : perturbSearch(target, base, random);
    let candidate;
    try {
      candidate = createCandidateFromSpec({
        targetId: target.id, values: mutated, round, index: results.length,
        parentArtifact, experiment,
      });
    } catch {
      continue; // 变异越界/非法：跳过，不污染批次
    }
    if (seen.has(candidate.artifact.identityDigest)) continue;
    seen.add(candidate.artifact.identityDigest);
    results.push(candidate);
  }
  assertCondition(results.length === count, `生成候选不足：期望 ${count}，实际 ${results.length}`);
  return results;
}

/** 演示/测试用脚本化候选：包含非法参数与带禁止构造的模块（验证失败隔离）。 */
export function scriptedCandidates({ experiment, round = 1, parentArtifact = null }) {
  const results = [];
  const accepted = [];
  // 1) 合法搜索控制候选：更低覆盖边际（更容易覆盖冠军建议）。
  accepted.push(createCandidateFromSpec({
    targetId: 'overrideMargin', values: { overrideMargin: 0.01 },
    round, index: 0, parentArtifact, experiment,
  }));
  // 2) 合法模块候选：提高 goalFit 权重。
  accepted.push(createCandidateFromSpec({
    targetId: 'acquisitionValue',
    values: { template: 'linear-feature-v1', coefficients: { goalFit: 2.4, readiness: 0.15 }, bias: 0 },
    round, index: 1, parentArtifact, experiment,
  }));
  // 3) 非法参数：candidateCap 越界 → 生成阶段拒绝（记录错误，不进入候选池）。
  try {
    createCandidateFromSpec({ targetId: 'candidateCap', values: { candidateCap: 99 }, round, index: 2, experiment });
  } catch (error) {
    results.push({ rejectedAtGeneration: true, targetId: 'candidateCap', error: error.message });
  }
  // 4) 静态安全检查失败的模块：notes 中带禁止构造（artifact 合法，safety 阶段淘汰）。
  accepted.push(createCandidateFromSpec({
    targetId: 'engineValue',
    values: {
      template: 'linear-feature-v1',
      coefficients: { outputWeight: 0.4 },
      bias: 0,
      notes: 'candidate tries Math.random() and merchantDeck access',
    },
    round, index: 3, parentArtifact, experiment,
  }));
  return { candidates: accepted, rejectedAtGeneration: results };
}
