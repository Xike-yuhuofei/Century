/** 对抗性联赛·对抗性候选生成接口（overnight-adversarial-league）。
 *
 * 目的：为后续 OpenEvolve 搜索提供"能够有效对抗 JS5 冠军"的候选进出协议——
 * 搜索系统只需产出本模块定义的候选 JSON（century-adversarial-candidate-v1），
 * 即可物化为联赛可用的版本描述符并进入评估管线，无需了解联赛内部实现。
 *
 * 候选规范（spec）字段：
 * - schema: 固定 'century-adversarial-candidate-v1'；
 * - id: 候选 id（cand- 前缀强制，避免与注册表冻结 id 冲突）；
 * - base: 派生基座的注册表版本 id（'js5-frozen-champion' / 'style-rush' / ...）
 *   或 'custom'（此时必须提供完整 parameters）；
 * - decisionCore: 'beam-search'（默认，参数/结构变异候选）| 'champion-guided'
 *   （联合搜索结构候选：允许覆盖 jointOptions，如 gateMode/worlds/预算）；
 * - mutations: 权重覆盖（仅 beam-search；键 ∈ PARAMETER_BOUNDS，越界拒绝）；
 * - parameters: 'custom' 基座时的完整参数（非 champion-guided 核心禁止携带
 *   adapter 字段——权重会被决策分派静默忽略，见 registry.mjs audit 注释）；
 * - structure / acquisitionVariant: 可选轴覆盖（默认继承基座）；
 * - jointOptions: 仅 champion-guided 核心（如 {budgetMs:100} 或确定性
 *   {workUnits:N}）；beam-search 候选提供即抛错；
 * - generatedBy / notes: 溯源字段（报告披露，不入指纹）。
 *
 * 指纹：materializeCandidate 产出的描述符经 registry.versionFingerprint 计算——
 * 同 spec 重复物化必然同指纹（纯函数，无时钟/随机源）。
 */

import {
  validateDescriptor, versionFingerprint, stripAdapter, applyWeightOverrides,
  canonicalJSON, DECISION_CORES, PARAMETER_BOUNDS,
} from './registry.mjs';

export const CANDIDATE_SCHEMA = 'century-adversarial-candidate-v1';

/** 校验候选规范（严格模式：任何越界/走私 adapter/未知字段拒绝）。 */
export function validateCandidateSpec(spec) {
  if (typeof spec !== 'object' || spec === null) throw new Error('候选规范必须为对象');
  const { schema, id, base, decisionCore = 'beam-search', mutations, parameters, structure, acquisitionVariant, jointOptions } = spec;
  if (schema !== CANDIDATE_SCHEMA) throw new Error(`候选 schema 必须为 ${CANDIDATE_SCHEMA}，实际：${String(schema)}`);
  if (typeof id !== 'string' || !/^cand-[a-z0-9][a-z0-9._-]{0,58}$/i.test(id)) {
    throw new Error(`候选 id 必须以 cand- 开头且形如 cand-<name>：${String(id)}`);
  }
  if (typeof base !== 'string' || base.length === 0) throw new Error('候选缺少 base（注册表版本 id 或 custom）');
  if (!DECISION_CORES.includes(decisionCore)) {
    throw new Error(`候选 decisionCore 非法：${String(decisionCore)}（允许：${DECISION_CORES.join('|')}）`);
  }
  if (decisionCore === 'random-legal') throw new Error('random-legal 不是合法候选核心（候选必须是有明确意图的策略变异）');
  if (base === 'custom') {
    if (typeof parameters !== 'object' || parameters === null) throw new Error('base=custom 必须提供完整 parameters');
  } else if (mutations === undefined && parameters === undefined && structure === undefined && acquisitionVariant === undefined && jointOptions === undefined) {
    throw new Error('候选必须提供至少一个变异轴（mutations/parameters/structure/acquisitionVariant/jointOptions）');
  }
  if (mutations !== undefined && decisionCore !== 'beam-search') {
    throw new Error('mutations 仅适用于 beam-search 候选（冠军引导核心不消费权重乘子）');
  }
  if (mutations !== undefined) {
    if (typeof mutations !== 'object' || mutations === null) throw new Error('mutations 必须为对象');
    for (const key of Object.keys(mutations)) {
      if (!(key in PARAMETER_BOUNDS)) throw new Error(`未知权重参数：${key}`);
    }
  }
  if (jointOptions !== undefined && decisionCore !== 'champion-guided') {
    throw new Error('jointOptions 仅适用于 champion-guided 候选');
  }
  if (parameters !== undefined && base !== 'custom' && decisionCore !== 'champion-guided') {
    // 非自定义基座 + 束搜索核心：完整 parameters 覆盖允许，但不得携带 adapter。
    if (typeof parameters !== 'object' || parameters === null) throw new Error('parameters 必须为对象');
    if (parameters.adapter !== undefined) {
      throw new Error('候选 parameters 非法携带 adapter 字段（权重会被决策分派静默忽略——audit 缺陷防御）');
    }
  }
  return { schema, id, base, decisionCore, mutations, parameters, structure, acquisitionVariant, jointOptions };
}

/** 物化候选 → 联赛版本描述符（纯函数、确定性；同 spec 同指纹）。 */
export function materializeCandidate(spec, registry) {
  const normalized = validateCandidateSpec(spec);
  const { id, base, decisionCore, mutations, parameters, structure, acquisitionVariant, jointOptions } = normalized;
  let candidateParameters;
  let lineageNote;
  if (base === 'custom') {
    candidateParameters = { ...parameters };
    lineageNote = 'custom 完整参数';
  } else {
    const baseVersion = registry.versions[base];
    if (!baseVersion) {
      throw new Error(`候选基座未注册：${base}（已注册：${Object.keys(registry.versions).join(', ')}）`);
    }
    const baseParams = decisionCore === 'champion-guided'
      ? baseVersion.parameters // 冠军引导候选：继承基座完整参数（含 adapter）
      : stripAdapter(baseVersion.parameters); // 束搜索候选：强制剥离适配器字段
    candidateParameters = { ...baseParams };
    lineageNote = `base=${base}（${baseVersion.fingerprint.slice(0, 12)}）`;
  }
  if (mutations !== undefined) candidateParameters = applyWeightOverrides(candidateParameters, mutations);
  if (parameters !== undefined && base !== 'custom' && decisionCore === 'champion-guided') {
    // 冠军引导候选的 parameters 轴：显式完整覆盖（必须自带合法 adapter）。
    candidateParameters = { ...parameters };
  }
  if (structure !== undefined) candidateParameters = { ...candidateParameters, structure };
  if (acquisitionVariant !== undefined) candidateParameters = { ...candidateParameters, acquisitionVariant };
  if (decisionCore === 'champion-guided' && candidateParameters.adapter !== 'champion-guided') {
    // 基座非适配器冠军时补显式适配器标记（validateDescriptor 强制要求）。
    candidateParameters = {
      ...candidateParameters,
      adapter: 'champion-guided',
      jointVersion: candidateParameters.jointVersion ?? 'joint-js5',
    };
  }
  const validated = validateDescriptor({ id, family: 'candidate', decisionCore, parameters: candidateParameters });
  const descriptor = {
    id, family: 'candidate', decisionCore,
    parameters: validated,
    structure: validated.structure ?? null,
    acquisitionVariant: validated.acquisitionVariant ?? null,
    jointOptions: decisionCore === 'champion-guided' ? (jointOptions ?? null) : null,
    lineage: { derivedFrom: lineageNote, note: spec.notes ?? 'OpenEvolve 对抗性候选' },
    description: spec.notes ?? `对抗性候选（${decisionCore}）`,
  };
  return Object.freeze({
    ...descriptor,
    fingerprint: versionFingerprint({ decisionCore, parameters: validated, structure: descriptor.structure, acquisitionVariant: descriptor.acquisitionVariant, jointOptions: descriptor.jointOptions }),
    specCanonical: canonicalJSON(normalized),
  });
}

/** 批量注册候选 → 新评估注册表（不修改输入注册表；返回深冻结副本）。 */
export function registerCandidates(registry, specs) {
  const versions = { ...registry.versions };
  for (const spec of specs) {
    const descriptor = materializeCandidate(spec, { versions });
    if (versions[descriptor.id]) throw new Error(`候选 id 与既有版本冲突：${descriptor.id}`);
    versions[descriptor.id] = descriptor;
  }
  const snapshot = Object.freeze({
    ...registry.snapshot,
    versionFingerprints: Object.fromEntries(Object.entries(versions).map(([vid, v]) => [vid, v.fingerprint])),
    candidates: specs.map(s => s.id),
  });
  const freezeDeep = value => {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) freezeDeep(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  return freezeDeep({ versions, snapshot });
}

/** 冒烟示例候选（文档化起点，非预训练结果）：展示三种典型变异轴。 */
export function exampleCandidateSpecs() {
  return Object.freeze([
    {
      schema: CANDIDATE_SCHEMA, id: 'cand-rush-plus', base: 'style-rush',
      decisionCore: 'beam-search',
      mutations: { tempoWeight: 1.8, restWeight: 0.4 },
      notes: '示例：速攻族加强变异（冒烟演示用，非训练产物）',
    },
    {
      schema: CANDIDATE_SCHEMA, id: 'cand-js5-fast-gate', base: 'js5-frozen-champion',
      decisionCore: 'champion-guided',
      jointOptions: { workUnits: 96 },
      notes: '示例：JS5 结构候选——确定性工作量档位（冒烟演示用）',
    },
    {
      schema: CANDIDATE_SCHEMA, id: 'cand-goal-remaining', base: 'custom',
      decisionCore: 'beam-search',
      parameters: {
        id: 'cand-goal-remaining', structure: 'beam-rollout', acquisitionVariant: 'goal-remaining',
        engineWeight: 1, tempoWeight: 1, contestWeight: 1, synergyWeight: 1,
        goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
      },
      notes: '示例：custom 参数基座 + 历史获取估值变体血统（冒烟演示用）',
    },
  ]);
}

/** 参数对象直接转候选 spec（训练管线便利入口）。 */
export function candidateFromParameters(id, parameters, { notes = null } = {}) {
  return validateCandidateSpec({
    schema: CANDIDATE_SCHEMA, id, base: 'custom',
    decisionCore: parameters?.adapter === 'champion-guided' ? 'champion-guided' : 'beam-search',
    parameters: parameters?.adapter === 'champion-guided' ? parameters : stripAdapter(parameters),
    notes,
  });
}
