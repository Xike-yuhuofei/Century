/** AI 9.0 多模块候选生成器（协同进化控制器使用）。
 *
 * 生成策略（全部产出同一 Candidate Artifact 协议）：
 * - single：单模块确定性变异；
 * - pair：双模块联合变异（真正的联合改码，不是参数拼接）；
 * - multi：3+ 模块联合变异；
 * - crossover：从两个精英候选抽取不同模块组合（依赖闭包补齐）；
 * - ablation：移除精英候选中的一个模块（回退官方实现），验证交互贡献；
 * - openevolve：真实 OpenEvolve LLM 联合进化（不可用时显式降级并记录原因）；
 * - control：完整官方模块（行为基线，不冒充提升）。
 *
 * 纪律：绝不把确定性变异标记为 openevolve-llm；依赖冲突在生成阶段拒绝；
 * 所有候选必须通过静态检查/组装/编译/探针后才会进入 artifact 仓库。
 */

import { readFileSync } from 'node:fs';
import { moduleRegistry, getModule, sha256 } from '../../ai5/openevolve/node/module_registry.mjs';
import { mutateModuleFunction } from './module-mutations.mjs';
import { createCompiledModuleCandidate, candidateParametersFor } from './multi-module-candidate.mjs';
import {
  runMultiModuleOpenEvolve, createCandidateFromOpenEvolveMulti, probeOpenEvolveAI9,
} from './openevolve-multi-bridge.mjs';
import { assertCondition, sha256Canonical, shortHash } from './core.mjs';
import { PARAMETER_BOUNDS } from '../../web-v1/dist/js/ai/parameters.js';

/** 代码 + 参数联合变异：在一个权重边界内做 ±5% 扰动（确定性由生成种子决定）。 */
function mutateWeights(parameters, random) {
  const keys = Object.keys(PARAMETER_BOUNDS);
  const key = keys[Math.floor(random() * keys.length) % keys.length];
  const [low, high] = PARAMETER_BOUNDS[key];
  const base = Number(parameters?.[key] ?? 1);
  const next = Math.min(high, Math.max(low, base * (1 + (random() * 0.1 - 0.05))));
  return {
    parameters: { ...(parameters ?? {}), [key]: Number(next.toFixed(4)) },
    key,
    from: base,
    to: Number(next.toFixed(4)),
  };
}

const DEFAULT_STRATEGIES = Object.freeze(['single', 'pair', 'multi', 'crossover', 'ablation']);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length];
}

/** 代码 + 参数联合变异（只对 pair/multi 生效，控制/单模块保持单一变量原则）。 */
function jointParameterMutation({ moduleConfig, parentArtifact, random }) {
  if (moduleConfig.jointParameters === false) return null;
  if (random() >= (moduleConfig.parameterMutationRate ?? 0.5)) return null;
  const base = parentArtifact?.parameters?.values ?? candidateParametersFor('cand-ai9-param-base');
  return mutateWeights(base, random);
}

function pickMany(list, count, random) {
  const pool = [...list];
  const out = [];
  while (out.length < count && pool.length) {
    const index = Math.floor(random() * pool.length) % pool.length;
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
}

/** 候选 artifact 的模块函数文本（多模块 artifact）。 */
export function moduleTextsFromArtifact(artifact) {
  assertCondition(artifact?.source?.modules?.length > 0, '候选 artifact 不是多模块源码候选');
  const byId = {};
  for (const meta of artifact.source.modules) {
    const file = artifact.source.files.find(f => f.path === meta.path);
    assertCondition(file, `${meta.id} 源码文件缺失：${meta.path}`);
    assertCondition(sha256(file.content) === meta.functionSha256, `${meta.id} 源码哈希不符`);
    byId[meta.id] = file.content;
  }
  return byId;
}

/** 依赖闭包：如果选中 M02，必须同时把 M03/M04 的来源固定下来（同一捐赠者）。 */
export function expandDependencies(selected, textSources, registry) {
  const result = { ...selected };
  const queue = [...Object.keys(selected)];
  while (queue.length) {
    const id = queue.shift();
    const module = getModule(id, registry);
    for (const dep of module.dependsOn ?? []) {
      if (result[dep] !== undefined) continue;
      const source = textSources[dep];
      // 依赖模块没有候选源码时保持官方实现：接口版本由注册表冻结，
      // 这不是"缺少文件"，而是"未进化该依赖"。
      if (source === undefined) continue;
      result[dep] = source;
      queue.push(dep);
    }
  }
  return result;
}

function candidateId({ strategy, round, index, modules }) {
  const hash = sha256Canonical(Object.entries(modules).sort(([a], [b]) => a.localeCompare(b)).map(([id, text]) => [id, sha256(text)]));
  return `cand-ai9-${strategy.replace(/[^a-z0-9]+/gi, '-')}-r${round}c${index}-${shortHash(hash, 6)}`;
}

/** 把模块文本映射转成 createCompiledModuleCandidate 的 modules 数组。 */
function modulesArray(map) {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, text]) => ({ id, text }));
}

function createCandidate({
  strategy, moduleTexts, experiment, round, index, parentArtifact, label, sourceOrigin,
  parameters = null, parameterMutation = null,
}) {
  const modules = modulesArray(moduleTexts);
  assertCondition(modules.length > 0, `${strategy} 候选模块为空`);
  const id = candidateId({ strategy, round, index, modules: moduleTexts });
  const finalId = parentArtifact?.candidateId === id ? `${id}-x` : id;
  const created = createCompiledModuleCandidate({
    modules,
    moduleIds: modules.map(m => m.id),
    experiment,
    round,
    index,
    candidateId: finalId,
    parentId: parentArtifact?.candidateId ?? null,
    parameters: parameters ? { ...parameters, id: finalId } : null,
    sourceOrigin,
    mutationLabel: label,
  });
  return { ...created, strategy, parameterMutation };
}

/**
 * 生成一批多模块候选。
 *
 * @param {object} options CampaignController 生成接口 + 扩展
 * @param {number} options.count
 * @param {number} options.round
 * @param {number} options.seed
 * @param {object} options.experiment
 * @param {object|null} [options.parentArtifact]
 * @param {string[]|null} [options.targetIds] 限定模块集合
 * @param {object|null} [options.hints]
 * @param {object} [options.moduleConfig] { strategies, openevolveIterations, allowOpenEvolve, allowDeterministicFallback }
 * @param {object[]} [options.eliteArtifacts] 精英候选 artifact（协同进化控制器注入）
 * @param {object|null} [options.mapElites] MAP-Elites 单元格（预留）
 */
export function generateMultiModuleBatch({
  count, round = 1, seed, experiment, parentArtifact = null, targetIds = null,
  hints = null, moduleConfig = {}, eliteArtifacts = [], mapElites = null,
}) {
  const registry = moduleRegistry();
  const allIds = registry.modules.map(m => m.id);
  const ids = (targetIds ?? allIds).filter(id => allIds.includes(id));
  assertCondition(ids.length > 0, '没有可用模块');
  const strategies = moduleConfig.strategies ?? DEFAULT_STRATEGIES;
  const random = rng(seed + round * 101);
  const parentTexts = parentArtifact ? moduleTextsFromArtifact(parentArtifact) : {};
  const candidates = [];
  const rejectedAtGeneration = [];
  const seen = new Set();
  const elites = eliteArtifacts.filter(a => a?.source?.modules?.length > 0);
  let openEvolveAttempts = 0;
  const maxOpenEvolvePerBatch = Number.isSafeInteger(moduleConfig.maxOpenEvolvePerBatch)
    ? Math.max(0, moduleConfig.maxOpenEvolvePerBatch)
    : 1;

  const accept = created => {
    assertCondition(created?.artifact, '候选生成器返回空 artifact');
    if (seen.has(created.artifact.identityDigest)) return false;
    seen.add(created.artifact.identityDigest);
    candidates.push(created);
    return true;
  };

  // control 候选：官方模块（每个 campaign 至少保留一个行为基线）。
  if (moduleConfig.includeControl !== false) {
    try {
      const official = createCompiledModuleCandidate({
        moduleIds: [ids[0]], experiment, round, index: 0,
        parentId: parentArtifact?.candidateId ?? null,
        sourceOrigin: 'deterministic-template',
        mutationLabel: 'official-control',
        candidateId: `cand-ai9-control-r${round}-${shortHash(sha256Canonical({ ids, round }), 6)}`,
      });
      accept({ ...official, strategy: 'control' });
    } catch (error) {
      rejectedAtGeneration.push({ strategy: 'control', error: String(error.message).slice(0, 500) });
    }
  }

  let guard = 0;
  while (candidates.length < count && guard < count * 6) {
    guard += 1;
    // 严格轮转策略，不随候选数量漂移；否则会重复同一策略并跳过 crossover/ablation。
    const strategy = strategies[(guard - 1) % strategies.length];
    try {
      if (strategy === 'openevolve') {
        if (openEvolveAttempts >= maxOpenEvolvePerBatch) {
          rejectedAtGeneration.push({
            strategy,
            reason: `本批最多 ${maxOpenEvolvePerBatch} 次真实 LLM 运行；剩余名额用确定性 pair 候选补齐（不冒充 LLM 来源）`,
            fallback: 'pair',
          });
          const selected = pickMany(ids, 2, random);
          const texts = {};
          for (const id of selected) texts[id] = mutateModuleFunction(id, Math.floor(random() * 3)).text;
          const expanded = expandDependencies(texts, { ...parentTexts }, registry);
          accept(createCandidate({
            strategy: 'pair-fallback', moduleTexts: expanded, experiment, round,
            index: candidates.length, parentArtifact,
            label: 'deterministic-fallback (OpenEvolve batch budget reached)', sourceOrigin: 'deterministic-template',
          }));
          continue;
        }
        const probe = probeOpenEvolveAI9();
        if (!probe.available) {
          rejectedAtGeneration.push({ strategy, reason: `OpenEvolve 不可用：${probe.blocked.join(',')}`, fallback: moduleConfig.allowDeterministicFallback !== false ? 'pair' : null });
          if (moduleConfig.allowDeterministicFallback === false) continue;
          const selected = pickMany(ids, 2, random);
          const texts = {};
          for (const id of selected) texts[id] = mutateModuleFunction(id, Math.floor(random() * 3)).text;
          const expanded = expandDependencies(texts, { ...parentTexts }, registry);
          accept(createCandidate({
            strategy: 'pair-fallback', moduleTexts: expanded, experiment, round,
            index: candidates.length, parentArtifact,
            label: 'deterministic-fallback (OpenEvolve unavailable)', sourceOrigin: 'deterministic-template',
          }));
          continue;
        }
        const selected = pickMany(ids, Math.min(ids.length, Math.max(2, Math.min(4, ids.length))), random);
        openEvolveAttempts += 1;
        const run = runMultiModuleOpenEvolve({
          moduleIds: selected,
          iterations: moduleConfig.openevolveIterations ?? 2,
          outputDir: moduleConfig.openevolveOutputDir
            ? `${moduleConfig.openevolveOutputDir}/r${round}c${candidates.length}`
            : null,
        });
        if (!run.ok) {
          rejectedAtGeneration.push({ strategy, reason: `OpenEvolve 运行失败：${run.logTail?.slice(-300)}` });
          continue;
        }
        const created = createCandidateFromOpenEvolveMulti({
          outputDir: run.outputDir, experiment, round, index: candidates.length,
          parentId: parentArtifact?.candidateId ?? null, expectedModuleIds: selected,
        });
        created.strategy = strategy;
        if (accept(created)) {
          created.provenance = { ...created.provenance, strategy, selectedModules: selected, elapsedMs: run.elapsedMs };
        }
        continue;
      }
      if (strategy === 'single') {
        const selected = [pick(ids, random)];
        const text = mutateModuleFunction(selected[0], Math.floor(random() * 3)).text;
        const expanded = expandDependencies({ [selected[0]]: text }, { ...parentTexts }, registry);
        accept(createCandidate({
          strategy, moduleTexts: expanded, experiment, round, index: candidates.length,
          parentArtifact, label: `single:${selected[0]}`, sourceOrigin: 'deterministic-template',
        }));
        continue;
      }
      if (strategy === 'pair') {
        const selected = pickMany(ids, Math.min(2, ids.length), random);
        const texts = {};
        for (const id of selected) texts[id] = mutateModuleFunction(id, Math.floor(random() * 3)).text;
        const expanded = expandDependencies(texts, { ...parentTexts }, registry);
        const joint = jointParameterMutation({ moduleConfig, parentArtifact, random });
        accept(createCandidate({
          strategy, moduleTexts: expanded, experiment, round, index: candidates.length,
          parentArtifact,
          label: `pair:${selected.join('+')}${joint ? `+param:${joint.key}` : ''}`,
          sourceOrigin: 'deterministic-template',
          parameters: joint?.parameters ?? null,
          parameterMutation: joint,
        }));
        continue;
      }
      if (strategy === 'multi') {
        const selected = pickMany(ids, Math.min(3, ids.length), random);
        const texts = {};
        for (const id of selected) texts[id] = mutateModuleFunction(id, Math.floor(random() * 3)).text;
        const expanded = expandDependencies(texts, { ...parentTexts }, registry);
        const joint = jointParameterMutation({ moduleConfig, parentArtifact, random });
        accept(createCandidate({
          strategy, moduleTexts: expanded, experiment, round, index: candidates.length,
          parentArtifact,
          label: `multi:${selected.join('+')}${joint ? `+param:${joint.key}` : ''}`,
          sourceOrigin: 'deterministic-template',
          parameters: joint?.parameters ?? null,
          parameterMutation: joint,
        }));
        continue;
      }
      if (strategy === 'crossover') {
        if (elites.length < 2) {
          rejectedAtGeneration.push({ strategy, reason: 'crossover 需要至少 2 个精英候选' });
          continue;
        }
        const [a, b] = pickMany(elites, 2, random);
        const aTexts = moduleTextsFromArtifact(a);
        const bTexts = moduleTextsFromArtifact(b);
        const donorA = Object.keys(aTexts);
        const donorB = Object.keys(bTexts).filter(id => !donorA.includes(id));
        assertCondition(donorA.length && donorB.length, '两个精英候选没有可组合的模块');
        const fromA = pickMany(donorA, Math.max(1, Math.ceil(donorA.length / 2)), random);
        const fromB = pickMany(donorB, Math.max(1, Math.ceil(donorB.length / 2)), random);
        const texts = {};
        for (const id of fromA) texts[id] = aTexts[id];
        for (const id of fromB) texts[id] = bTexts[id];
        const expanded = expandDependencies(texts, { ...aTexts, ...bTexts }, registry);
        accept(createCandidate({
          strategy, moduleTexts: expanded, experiment, round, index: candidates.length,
          parentArtifact, label: `crossover:${a.candidateId}+${b.candidateId}`,
          sourceOrigin: 'crossover',
        }));
        continue;
      }
      if (strategy === 'ablation') {
        if (!elites.length) {
          rejectedAtGeneration.push({ strategy, reason: 'ablation 需要至少 1 个精英候选' });
          continue;
        }
        const donor = pick(elites, random);
        const textMap = moduleTextsFromArtifact(donor);
        const removable = Object.keys(textMap).filter(id => (getModule(id, registry).dependsOn ?? []).length === 0);
        if (!removable.length) {
          rejectedAtGeneration.push({ strategy, reason: '精英候选没有可独立移除的模块（依赖闭包保护）' });
          continue;
        }
        const removed = pick(removable, random);
        const texts = { ...textMap };
        delete texts[removed];
        if (!Object.keys(texts).length) {
          rejectedAtGeneration.push({ strategy, reason: '移除后没有剩余模块' });
          continue;
        }
        accept(createCandidate({
          strategy, moduleTexts: texts, experiment, round, index: candidates.length,
          parentArtifact, label: `ablation:${removed}<-${donor.candidateId}`,
          sourceOrigin: 'ablation',
        }));
        continue;
      }
      rejectedAtGeneration.push({ strategy, reason: `未知策略：${strategy}` });
    } catch (error) {
      rejectedAtGeneration.push({ strategy, error: String(error.message).slice(0, 600) });
    }
  }

  if (candidates.length < count) {
    rejectedAtGeneration.push({ strategy: 'batch', reason: `生成不足：期望 ${count}，实际 ${candidates.length}` });
  }
  return { candidates, rejectedAtGeneration, mapElites };
}

/** MAP-Elites 行为分桶（2D：获取占比 × 认领占比；每桶只保留最优）。 */
export function eliteCell(evidence) {
  const actions = evidence?.behaviorSignature?.actions ?? evidence?.metrics?.behaviorSignature?.actions ?? null;
  if (!actions) return null;
  const bx = Math.max(0, Math.min(4, Math.round((actions.acquire ?? 0) * 4)));
  const by = Math.max(0, Math.min(4, Math.round((actions.claim ?? 0) * 4)));
  return `${bx}-${by}`;
}

/** 记录协同进化精英：模块级精英池 + MAP-Elites 单元格。 */
export function recordCoEvolutionElite({ state, artifact, evidence, item, strategy = null }) {
  const score = Number(evidence?.metrics?.firstPlaceDelta ?? evidence?.metrics?.chanceAdjustedRate ?? 0);
  const deep = item?.deep ? 1 : 0;
  if (!state.moduleElites) state.moduleElites = [];
  if (!state.mapElites) state.mapElites = {};
  const entry = {
    candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest,
    strategy,
    score,
    deep,
    modules: artifact.source.modules.map(m => m.id).sort(),
    evidencePath: item?.deep?.evidencePath ?? item?.quick?.evidencePath ?? null,
    recordedAt: new Date().toISOString(),
  };
  for (const id of entry.modules) {
    const current = state.moduleElites.find(e => e.moduleId === id);
    if (!current || score > current.score || (deep && !current.deep)) {
      if (current) Object.assign(current, { ...entry, moduleId: id });
      else state.moduleElites.push({ moduleId: id, ...entry });
    }
  }
  const cell = eliteCell(evidence);
  if (cell) {
    const current = state.mapElites[cell];
    if (!current || score > current.score || (deep && !current.deep)) {
      state.mapElites[cell] = { ...entry, cell };
    }
  }
}

export { DEFAULT_STRATEGIES };
