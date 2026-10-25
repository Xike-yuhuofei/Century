/** D2：有边界的多目标进化接口。
 *
 * 当前 OpenEvolve 只进化 acquisitionValue 一个函数。本模块把搜索空间扩展为
 * 两组、逐目标声明的插件契约，并强制每条约束可执行：
 *
 * 第一组：资源与策略评价（声明式线性特征模块，plugin-only，本轮不接正式实现）
 *   acquisitionValue / engineValue / goalValue / keepValue / restValue
 * 第二组：搜索控制（有界参数向量，经 JS5 适配器选项注入；不改冠军代码）
 *   gateThreshold / overrideMargin / candidateCap / searchBudget /
 *   searchBudgetAllocation / playerCountScope
 *
 * 每个目标必须提供：
 * - 类型与输入检查（validateValues / assertTargetInput）；
 * - 隐藏信息拒绝（HIDDEN_INFO_KEYS 递归扫描）；
 * - 资源预算（输入字节、求值时间、输出范围）；
 * - 安全沙箱（声明式模块 = 不执行候选代码；代码模块必须走 Seatbelt）；
 * - 回退机制（非法输入/超预算 → 默认参数 + fallbackHit）；
 * - 独立回归 fixture（tests 逐目标运行）。
 *
 * 重要：第一组目标只通过候选插件接口进行离线回归/代理评分，**不修改**
 * Agent C 负责的正式评价函数实现；第二组通过 seat 分派选项注入，**不修改**
 * 冠军决策代码与冠军参数归档。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { REPO_ROOT } from '../lib/paths.mjs';
import { FEATURE_EXTRACTORS } from './feature-extractors.mjs';
import {
  SCHEMAS, ALL_PLAYER_COUNTS, HIDDEN_INFO_KEYS,
  assertCondition, assertAllowedKeys, canonicalJSON, clamp, deepFreeze,
} from './core.mjs';

export const TARGET_VERSION = 1;
export const MODULE_SCHEMA = 'century-declarative-linear-module-v1';
export const MODULE_TEMPLATE = 'linear-feature-v1';
export const TARGET_SANDBOX_POLICY = deepFreeze({
  moduleCandidates: 'declarative-no-exec',
  codeCandidates: 'seatbelt-required (本轮未启用)',
  hiddenInformation: 'rejected',
});

const RESOURCE_BUDGET = deepFreeze({ maxInputBytes: 8_192, maxEvalMs: 5, outputMustBeFinite: true });

function recursiveHiddenScan(value, path = 'input') {
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (HIDDEN_INFO_KEYS.includes(key)) {
      throw new Error(`${path}.${key} 属于隐藏信息/随机源，候选插件禁止访问`);
    }
    recursiveHiddenScan(value[key], `${path}.${key}`);
  }
}

/** 第一组：声明式线性特征模块定义。 */
const MODULE_TARGETS = [
  {
    id: 'acquisitionValue',
    group: 'resource-strategy',
    label: '商人卡获取估值',
    featureKeys: ['engineDelta', 'synergy', 'goalFit', 'demand', 'risk', 'readiness', 'efficiency', 'capacityRoom', 'depthPenalty'],
    allowedInputKeys: ['stock', 'hand', 'played', 'cardId', 'preferred', 'profile', 'pressure'],
    defaultCoefficients: {
      engineDelta: 0.6, synergy: 2, goalFit: 2, demand: 0.45, risk: 0.55,
      readiness: 0, efficiency: 0, capacityRoom: 0, depthPenalty: 0,
    },
    defaultBias: 0,
    outputClamp: [-5, 30],
    fixtures: [
      {
        name: 'fresh-engine-5p',
        input: {
          stock: [1, 1, 1, 0], hand: ['M01'], played: [],
          cardId: 'M02', preferred: 'G02',
          profile: { engine: 1, contest: 1 },
          pressure: { mean: { M02: 0.4, M01: 0.2 }, peak: { M02: 0.7, M01: 0.3 } },
        },
      },
      {
        name: 'deep-engine-target-ready',
        input: {
          stock: [0, 2, 1, 1], hand: ['M01', 'M05'], played: ['M03'],
          cardId: 'M06', preferred: 'G01',
          profile: { engine: 0.8, contest: 1.2 },
          pressure: { mean: { M06: 0.6 }, peak: { M06: 0.9 } },
        },
      },
    ],
  },
  {
    id: 'engineValue',
    group: 'resource-strategy',
    label: '单卡引擎价值',
    featureKeys: ['outputWeight', 'goalUseful', 'reachable', 'inputCost', 'steps'],
    allowedInputKeys: ['stock', 'card', 'goalId'],
    defaultCoefficients: { outputWeight: 0.32, goalUseful: 0.22, reachable: 0.45, inputCost: 0, steps: 0.7 },
    defaultBias: 0,
    outputClamp: [0, 20],
    fixtures: [
      {
        name: 'trade-reachable',
        input: { stock: [1, 0, 1, 0], card: { kind: 'trade', input: [0, 0, 1, 0], output: [1, 2, 0, 0] }, goalId: 'G01' },
      },
      {
        name: 'create-goal-useful',
        input: { stock: [0, 1, 0, 1], card: { kind: 'create', output: [1, 0, 1, 0] }, goalId: 'G02' },
      },
    ],
  },
  {
    id: 'goalValue',
    group: 'resource-strategy',
    label: '魔像目标价值',
    featureKeys: ['remainingCost', 'goalFit', 'stockPotential', 'points'],
    allowedInputKeys: ['stock', 'goalId', 'goalIds'],
    defaultCoefficients: { remainingCost: -0.5, goalFit: 2, stockPotential: 1.2, points: 0.1 },
    defaultBias: 0,
    outputClamp: [0, 20],
    fixtures: [
      { name: 'close-g01', input: { stock: [2, 1, 0, 1], goalId: 'G01', goalIds: ['G01', 'G02'] } },
      { name: 'far-g03', input: { stock: [0, 1, 2, 2], goalId: 'G03', goalIds: ['G02', 'G03'] } },
    ],
  },
  {
    id: 'keepValue',
    group: 'resource-strategy',
    label: '水晶保留价值',
    featureKeys: ['coverage', 'stockPotential', 'weightedStock', 'capacityPressure'],
    allowedInputKeys: ['stock', 'goalId', 'goalIds'],
    defaultCoefficients: { coverage: 3, stockPotential: 1.2, weightedStock: 0.16, capacityPressure: 0 },
    defaultBias: 0,
    outputClamp: [0, 30],
    fixtures: [
      { name: 'full-stock', input: { stock: [3, 2, 2, 1], goalId: 'G02', goalIds: ['G01', 'G02'] } },
      { name: 'empty-stock', input: { stock: [0, 0, 1, 0], goalId: 'G02', goalIds: ['G01', 'G02'] } },
    ],
  },
  {
    id: 'restValue',
    group: 'resource-strategy',
    label: '休息回收价值',
    featureKeys: ['playedCount', 'handDepth', 'recycleGain', 'tempoLoss'],
    allowedInputKeys: ['stock', 'hand', 'played', 'preferred'],
    defaultCoefficients: { playedCount: 0.4, handDepth: 0.1, recycleGain: 0.8, tempoLoss: 0.6 },
    defaultBias: 0,
    outputClamp: [0, 30],
    fixtures: [
      { name: 'two-played', input: { stock: [1, 1, 0, 0], hand: ['M02'], played: ['M01', 'M03'], preferred: 'G01' } },
      { name: 'empty-engine', input: { stock: [0, 1, 0, 0], hand: [], played: [], preferred: 'G02' } },
    ],
  },
];

/** 第二组：有界搜索控制参数定义。 */
const SEARCH_TARGETS = [
  {
    id: 'gateThreshold',
    label: '竞争门控阈值（contestThreshold）',
    defaultValue: { contestThreshold: 0.85 },
    bound: { contestThreshold: [0.5, 0.99] },
    jointOptionKey: 'contestThreshold',
  },
  {
    id: 'overrideMargin',
    label: '保守覆盖边际（overrideMargin）',
    defaultValue: { overrideMargin: 0.02 },
    bound: { overrideMargin: [0, 0.2] },
    jointOptionKey: 'overrideMargin',
  },
  {
    id: 'candidateCap',
    label: '联合评估候选上限（candidateCap）',
    defaultValue: { candidateCap: 4 },
    bound: { candidateCap: [2, 8] },
    integer: true,
    jointOptionKey: 'candidateCap',
  },
  {
    id: 'searchBudget',
    label: '确定性搜索预算（workUnits）',
    defaultValue: { workUnits: 32 },
    bound: { workUnits: [8, 512] },
    integer: true,
    jointOptionKey: 'workUnits',
  },
  {
    id: 'searchBudgetAllocation',
    label: '分人数搜索预算分配（2–5p workUnits）',
    defaultValue: { 2: 32, 3: 32, 4: 32, 5: 32 },
    bound: { 2: [8, 512], 3: [8, 512], 4: [8, 512], 5: [8, 512] },
    integer: true,
    perPlayerCount: true,
  },
  {
    id: 'playerCountScope',
    label: '适用人数范围',
    defaultValue: { playerCounts: [...ALL_PLAYER_COUNTS] },
    structural: true,
  },
];

/** 冻结冠军归档参数（只读归档，绝不读活动冠军状态）。 */
function readFrozenChampionParameters() {
  const archive = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/candidates/joint-js5.json'), 'utf8'));
  const parameters = archive.parameters ?? archive;
  assertCondition(parameters?.adapter === 'champion-guided', '冻结冠军归档缺少 champion-guided 适配器身份');
  return parameters;
}

function moduleTargetDescriptor(target) {
  return deepFreeze({
    schema: SCHEMAS.evolutionTarget,
    id: target.id,
    group: target.group,
    kind: 'function-module',
    evaluationMode: 'proxy',
    label: target.label,
    version: TARGET_VERSION,
    featureKeys: [...target.featureKeys],
    defaultCoefficients: { ...target.defaultCoefficients },
    coefficientBounds: Object.fromEntries(target.featureKeys.map(k => [k, [-3, 3]])),
    biasBounds: [-2, 2],
    outputClamp: [...target.outputClamp],
    inputs: { allowed: [...target.allowedInputKeys], forbidden: [...HIDDEN_INFO_KEYS] },
    resourceBudget: { ...RESOURCE_BUDGET },
    sandbox: TARGET_SANDBOX_POLICY.moduleCandidates,
    fallback: { strategy: 'default-coefficients', on: ['invalid-input', 'non-finite', 'budget-exceeded'] },
    integration: 'candidate-plugin-only',
    productionWiring: 'not-wired (Agent C 正式评价函数零改动)',
    fixtures: target.fixtures.map(f => ({ name: f.name, input: JSON.parse(JSON.stringify(f.input)) })),
  });
}

function searchTargetDescriptor(target) {
  return deepFreeze({
    schema: SCHEMAS.evolutionTarget,
    id: target.id,
    group: 'search-control',
    kind: 'parameter-vector',
    evaluationMode: 'game',
    label: target.label,
    version: TARGET_VERSION,
    defaultValue: JSON.parse(JSON.stringify(target.defaultValue)),
    bounds: target.bound ? JSON.parse(JSON.stringify(target.bound)) : null,
    integer: !!target.integer,
    perPlayerCount: !!target.perPlayerCount,
    structural: !!target.structural,
    jointOptionKey: target.jointOptionKey ?? null,
    inputs: { allowed: ['candidate', 'playerCount', 'round'], forbidden: [...HIDDEN_INFO_KEYS] },
    resourceBudget: { maxCandidatesPerRound: 12, maxGamesPerCandidate: 24, maxEvalMs: 120_000 },
    sandbox: 'declarative-parameter-only (no code execution)',
    fallback: { strategy: 'frozen-champion-default', on: ['invalid-value', 'budget-exceeded'] },
    integration: 'production-seat-dispatch (JS5 adapter options)',
  });
}

const TARGETS = deepFreeze([
  ...MODULE_TARGETS.map(moduleTargetDescriptor),
  ...SEARCH_TARGETS.map(searchTargetDescriptor),
]);

const TARGET_BY_ID = new Map(TARGETS.map(t => [t.id, t]));

export function listTargets({ group = null, evaluationMode = null } = {}) {
  return TARGETS.filter(t => (group === null || t.group === group) && (evaluationMode === null || t.evaluationMode === evaluationMode));
}

export function getTarget(id) {
  const target = TARGET_BY_ID.get(id);
  assertCondition(target, `未知进化目标：${String(id)}（已注册：${TARGETS.map(t => t.id).join(', ')}）`);
  return target;
}

function assertFiniteNumber(value, name) {
  assertCondition(typeof value === 'number' && Number.isFinite(value), `${name} 必须为有限数值，实际：${String(value)}`);
  return value;
}

function assertWithinBound(value, [low, high], name, integer = false) {
  assertFiniteNumber(value, name);
  if (integer) assertCondition(Number.isInteger(value), `${name} 必须为整数，实际：${value}`);
  assertCondition(value >= low && value <= high, `${name} 越界：必须为 ${low}–${high}，实际：${value}`);
  return value;
}

/** 规范化声明式模块 spec；未知系数/越界一律拒绝。 */
export function normalizeModuleSpec(targetId, spec) {
  const target = getTarget(targetId);
  assertCondition(target.kind === 'function-module', `目标 ${targetId} 不是函数模块`);
  assertCondition(spec && typeof spec === 'object', `${targetId} 模块 spec 必须为对象`);
  const allowed = ['schema', 'template', 'coefficients', 'bias', 'outputClamp', 'notes'];
  for (const key of Object.keys(spec)) {
    assertCondition(allowed.includes(key), `${targetId} 模块 spec 含未声明字段：${key}`);
  }
  if (spec.schema !== undefined) {
    assertCondition(spec.schema === MODULE_SCHEMA, `${targetId} 模块 schema 非法：${String(spec.schema)}`);
  }
  const template = spec.template ?? MODULE_TEMPLATE;
  assertCondition(template === MODULE_TEMPLATE, `${targetId} 模块模板非法：${String(template)}`);
  if (spec.outputClamp !== undefined) {
    assertCondition(Array.isArray(spec.outputClamp) && spec.outputClamp.length === 2
      && spec.outputClamp[0] === target.outputClamp[0] && spec.outputClamp[1] === target.outputClamp[1],
    `${targetId} outputClamp 不可由候选改写（必须为 [${target.outputClamp.join(',')}]）`);
  }
  const coefficients = { ...target.defaultCoefficients };
  for (const [key, value] of Object.entries(spec.coefficients ?? {})) {
    assertCondition(target.featureKeys.includes(key), `${targetId} 模块含未知特征系数：${key}`);
    coefficients[key] = assertWithinBound(value, target.coefficientBounds[key], `${targetId}.${key}`);
  }
  const bias = spec.bias === undefined ? 0 : assertWithinBound(spec.bias, target.biasBounds, `${targetId}.bias`);
  return deepFreeze({
    schema: MODULE_SCHEMA,
    template: MODULE_TEMPLATE,
    coefficients,
    bias,
    outputClamp: [...target.outputClamp],
    notes: typeof spec.notes === 'string' ? spec.notes.slice(0, 240) : null,
  });
}

/** 规范化搜索控制参数。 */
export function normalizeSearchValues(targetId, values) {
  const target = getTarget(targetId);
  assertCondition(target.kind === 'parameter-vector', `目标 ${targetId} 不是参数向量`);
  assertCondition(values && typeof values === 'object', `${targetId} values 必须为对象`);
  if (target.structural) {
    assertCondition(Array.isArray(values.playerCounts) && values.playerCounts.length > 0,
      `${targetId}.playerCounts 必须为非空数组`);
    const counts = [...new Set(values.playerCounts)].sort((a, b) => a - b);
    for (const n of counts) assertCondition(ALL_PLAYER_COUNTS.includes(n), `${targetId} 非法人数：${n}`);
    return deepFreeze({ playerCounts: counts });
  }
  if (target.perPlayerCount) {
    for (const key of Object.keys(values)) {
      assertCondition(['2', '3', '4', '5'].includes(String(key)), `${targetId} 含未知人数键：${key}`);
    }
    const result = {};
    for (const n of ALL_PLAYER_COUNTS) {
      const value = values[n] ?? target.defaultValue[String(n)];
      result[String(n)] = assertWithinBound(value, target.bounds[String(n)] ?? target.bounds[n], `${targetId}.${n}`, target.integer);
    }
    return deepFreeze(result);
  }
  const result = {};
  for (const key of Object.keys(target.defaultValue)) {
    assertCondition(key in values, `${targetId} 缺少参数 ${key}`);
    result[key] = assertWithinBound(values[key], target.bounds[key], `${targetId}.${key}`, target.integer);
  }
  for (const key of Object.keys(values)) {
    assertCondition(key in target.defaultValue, `${targetId} 含未声明参数：${key}`);
  }
  return deepFreeze(result);
}

/** 目标输入白名单 + 隐藏信息递归扫描 + 资源预算。 */
export function assertTargetInput(targetId, input) {
  const target = getTarget(targetId);
  assertCondition(target.kind === 'function-module', `目标 ${targetId} 不支持输入求值`);
  assertAllowedKeys(input, target.inputs.allowed, target.inputs.forbidden, `${targetId} 输入`);
  recursiveHiddenScan(input, `${targetId} 输入`);
  const bytes = canonicalJSON(input).length;
  assertCondition(bytes <= target.resourceBudget.maxInputBytes,
    `${targetId} 输入 ${bytes}B 超过预算 ${target.resourceBudget.maxInputBytes}B`);
  return true;
}

function evaluateWithSpec(target, input, spec) {
  const extractor = FEATURE_EXTRACTORS[target.id];
  assertCondition(typeof extractor === 'function', `目标 ${target.id} 缺少特征提取器`);
  const features = extractor(input);
  let value = spec.bias;
  for (const key of target.featureKeys) {
    value += spec.coefficients[key] * features[key];
  }
  value = clamp(value, spec.outputClamp[0], spec.outputClamp[1]);
  return { value, features };
}

/** 声明式模块求值：输入非法/超预算/非有限 → 回退默认系数并记录 fallbackHit。 */
export function evaluateModule(targetId, input, spec) {
  const target = getTarget(targetId);
  const normalized = normalizeModuleSpec(targetId, spec);
  const started = performance.now();
  try {
    assertTargetInput(targetId, input);
    const result = evaluateWithSpec(target, input, normalized);
    const elapsed = performance.now() - started;
    if (!Number.isFinite(result.value)) throw new Error('输出非有限');
    if (elapsed > target.resourceBudget.maxEvalMs) {
      return fallbackResult(targetId, input, 'budget-exceeded');
    }
    return deepFreeze({
      targetId,
      value: Number(result.value.toFixed(6)),
      features: result.features,
      fallbackHit: false,
      fallbackReason: null,
      elapsedMs: Number(elapsed.toFixed(3)),
      withinBudget: true,
    });
  } catch (error) {
    return fallbackResult(targetId, input, error.message.slice(0, 160));
  }
}

function fallbackResult(targetId, input, reason) {
  const target = getTarget(targetId);
  const defaultSpec = normalizeModuleSpec(targetId, { template: MODULE_TEMPLATE, coefficients: target.defaultCoefficients });
  let value = null;
  let features = null;
  try {
    const result = evaluateWithSpec(target, input, defaultSpec);
    value = Number(result.value.toFixed(6));
    features = result.features;
  } catch {
    value = null;
  }
  return deepFreeze({
    targetId,
    value,
    features,
    fallbackHit: true,
    fallbackReason: reason,
    elapsedMs: 0,
    withinBudget: true,
  });
}

/** 目标默认值（模块 = 默认系数；搜索控制 = 冻结默认选项）。 */
export function defaultTargetValues(targetId) {
  const target = getTarget(targetId);
  if (target.kind === 'function-module') {
    return {
      template: MODULE_TEMPLATE,
      coefficients: { ...target.defaultCoefficients },
      bias: 0,
    };
  }
  return JSON.parse(JSON.stringify(target.defaultValue));
}

/** 搜索控制 → 联合搜索选项（按人数解析）。 */
export function jointOptionsForPlayerCount(targetId, values, seatCount) {
  const target = getTarget(targetId);
  assertCondition(target.group === 'search-control', `目标 ${targetId} 不是搜索控制`);
  assertCondition(ALL_PLAYER_COUNTS.includes(seatCount), `seatCount 非法：${seatCount}`);
  if (target.structural) return {};
  if (target.perPlayerCount) {
    return { workUnits: values[String(seatCount)] };
  }
  const key = target.jointOptionKey;
  return { [key]: values[key] };
}

/** 搜索控制候选 → artifact 片段（game 模式）。 */
export function buildGameCandidatePieces({ targetId, values, candidateId, playerCounts = null }) {
  const target = getTarget(targetId);
  assertCondition(target.group === 'search-control', `目标 ${targetId} 不是搜索控制`);
  const normalized = normalizeSearchValues(targetId, values);
  const applicable = target.structural
    ? normalized.playerCounts
    : (playerCounts ?? [...ALL_PLAYER_COUNTS]);
  for (const n of applicable) assertCondition(ALL_PLAYER_COUNTS.includes(n), `适用人数非法：${n}`);

  const frozen = readFrozenChampionParameters();
  const parameters = validateAIParameters({
    ...frozen,
    id: candidateId,
  });
  const jointOptionsByPlayerCount = {};
  for (const n of applicable) {
    const option = jointOptionsForPlayerCount(targetId, normalized, n);
    // 基线统一用确定性 workUnits（8–512），gateThreshold/overrideMargin/candidateCap
    // 候选在相同工作量口径下比较；searchBudget* 目标覆盖 workUnits 本身。
    jointOptionsByPlayerCount[String(n)] = {
      workUnits: normalized.workUnits ?? (normalized[String(n)] ?? 32),
      ...option,
    };
  }
  return deepFreeze({
    algorithmStructure: {
      targetIds: [targetId],
      decisionCore: 'champion-guided',
      adapter: 'champion-guided',
      structure: null,
      jointVersion: frozen.jointVersion ?? 'joint-js5',
      evaluationMode: 'game',
      jointOptionsByPlayerCount,
      integration: 'production-seat-dispatch',
    },
    parameters,
    applicablePlayerCounts: [...applicable].sort((a, b) => a - b),
    targetValues: normalized,
  });
}

/** 模块候选 → artifact 片段（proxy 模式）。 */
export function buildProxyCandidatePieces({ targetId, spec, candidateId, applicablePlayerCounts = ALL_PLAYER_COUNTS }) {
  const target = getTarget(targetId);
  assertCondition(target.kind === 'function-module', `目标 ${targetId} 不是函数模块`);
  const normalized = normalizeModuleSpec(targetId, spec);
  const moduleJSON = canonicalJSON(normalized);
  return deepFreeze({
    algorithmStructure: {
      targetIds: [targetId],
      decisionCore: 'plugin-only',
      adapter: null,
      structure: null,
      jointVersion: null,
      evaluationMode: 'proxy',
      jointOptionsByPlayerCount: null,
      integration: 'candidate-plugin-only',
    },
    parameters: {
      id: candidateId,
      version: TARGET_VERSION,
      values: normalized,
      boundsVersion: `module-bounds-${targetId}-v${TARGET_VERSION}`,
    },
    source: {
      kind: 'declarative-module',
      entry: 'module.json',
      files: [{ path: 'module.json', content: moduleJSON }],
    },
    applicablePlayerCounts: [...applicablePlayerCounts],
    targetValues: normalized,
  });
}

/** 目标回归 fixture 求值（测试与演示用；返回默认值与扰动值）。 */
export function targetRegression(targetId) {
  const target = getTarget(targetId);
  assertCondition(target.kind === 'function-module', `目标 ${targetId} 没有回归 fixture`);
  return target.fixtures.map(fixture => {
    const defaultSpec = { template: MODULE_TEMPLATE, coefficients: target.defaultCoefficients };
    const baseline = evaluateModule(targetId, fixture.input, defaultSpec);
    const perturbedSpec = {
      template: MODULE_TEMPLATE,
      coefficients: Object.fromEntries(target.featureKeys.map((key, i) =>
        [key, clamp(target.defaultCoefficients[key] * (i % 2 === 0 ? 0.8 : 1.2), -3, 3)])),
    };
    const perturbed = evaluateModule(targetId, fixture.input, perturbedSpec);
    return { name: fixture.name, targetId, input: fixture.input, baseline, perturbed };
  });
}
