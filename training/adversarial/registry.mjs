/** 对抗性联赛·对手版本注册表（overnight-adversarial-league）。
 *
 * 目标：为联赛提供"不可变版本身份"，杜绝三类历史缺陷：
 * 1. 仅靠显示名称区分策略——同名不同核、异名同核都无法从 id 判断；
 * 2. 风格变体从当前冠军浅拷贝派生时携带 `adapter` 字段（AI6 第五阶段冠军
 *    joint-js5 是适配器冠军），导致权重乘子被决策分派静默忽略
 *    （web-v1/src/ai/decision.ts 按 params.adapter 分派，适配器核心不消费
 *    权重）——变体实际行为 = 冠军本体。本注册表强制 strip-adapter；
 * 3. 冻结版本身份随当前冠军切换漂移——本注册表从"晋级归档快照"
 *    （training/champions/candidates/*.json）读取冻结参数，绝不读
 *    CHAMPION_PARAMETERS / champion.json 活动状态。
 *
 * 版本描述符（descriptor）字段：
 * - id: 稳定标识（注册表内唯一）；
 * - family: 策略族标签（champion / historical-champion / style / baseline / random）；
 * - decisionCore: 决策核心标识——'champion-guided'（JS5 联合搜索）|
 *   'beam-search'（正式束搜索 chooseAIAction）| 'random-legal'（均匀合法采样）；
 * - parameters: validateAIParameters 校验后的完整参数（非 JS5 版本必无 adapter）；
 * - structure / acquisitionVariant: 结构与血统轴（束搜索核心消费）；
 * - jointOptions: 冠军引导核心的运行时选项（缺省按冻结冠军 budgetMs=100；
 *   联赛冒烟可用确定性 workUnits 快档——见 league.mjs jointProfile）；
 * - lineage: 血统溯源（derivedFrom + 说明）；
 * - description: 人类可读说明。
 *
 * 指纹：versionFingerprint = sha256(canonicalJSON(决策身份字段))，canonical
 * 形式 = 键排序递归序列化。凡进入对局的版本都必须披露指纹；指纹不一致
 * 即版本漂移（联赛报告记录 registryFingerprint 全局锚点）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  validateAIParameters, BASELINE_PARAMETERS, PARAMETER_BOUNDS,
} from '../../web-v1/dist/js/ai/parameters.js';
import { REPO_ROOT, engineBundleSha256 } from '../lib/paths.mjs';

// 重导出（candidate.mjs 与外部审计工具消费权重键空间，避免散落 dist 相对路径）。
export { PARAMETER_BOUNDS };

export const DECISION_CORES = Object.freeze(['champion-guided', 'beam-search', 'random-legal']);

export const CHAMPION_ARCHIVE_DIR = resolve(REPO_ROOT, 'training/champions/candidates');

/** 适配器字段集合：从参数派生束搜索风格变体时必须剥离的全部字段。 */
const ADAPTER_FIELDS = Object.freeze(['adapter', 'jointVersion', 'budgetMs']);

/** 剥离适配器字段（audit 修复核心工具）。
 * JS5 冠军参数携带 adapter='champion-guided'；任何浅拷贝派生（{...champion}）
 * 都会继承该字段并被 decision.ts 分派到联合搜索——权重乘子静默失效。
 * 返回浅拷贝（不修改输入），仅剥离 ADAPTER_FIELDS。 */
export function stripAdapter(parameters) {
  const stripped = { ...parameters };
  for (const key of ADAPTER_FIELDS) delete stripped[key];
  return stripped;
}

/** 稳定 canonical JSON：键排序递归序列化（数组保序）。 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/** sha256 指纹（十六进制）。 */
export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 版本描述符的决策身份字段（指纹覆盖范围——运行时遥测字段绝不入指纹）。 */
function identityFields(descriptor) {
  return {
    decisionCore: descriptor.decisionCore,
    parameters: descriptor.parameters,
    structure: descriptor.structure ?? null,
    acquisitionVariant: descriptor.acquisitionVariant ?? null,
    jointOptions: descriptor.jointOptions ?? null,
  };
}

/** 版本指纹：对决策身份字段做 sha256。同指纹 ⇔ 同决策身份。 */
export function versionFingerprint(descriptor) {
  return sha256Hex(canonicalJSON(identityFields(descriptor)));
}

/** 注册表指纹：全部版本 (id, 指纹) 按 id 排序后的 sha256。
 * 冻结版本身份不随当前冠军切换变化 ⇔ 该指纹稳定。 */
export function registryFingerprint(registry) {
  const entries = Object.entries(registry.versions)
    .map(([id, v]) => [id, v.fingerprint])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(canonicalJSON(entries));
}

/** 校验一个版本描述符：id/decisionCore/parameters 合法性 + 核心一致性约束。 */
export function validateDescriptor(input) {
  if (typeof input !== 'object' || input === null) throw new Error('版本描述符必须为对象');
  const { id, family, decisionCore, parameters } = input;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9@._-]{2,63}$/i.test(id)) {
    throw new Error(`版本 id 非法：${String(id)}`);
  }
  if (typeof family !== 'string' || family.length === 0) throw new Error(`版本 ${id} 缺少 family`);
  if (!DECISION_CORES.includes(decisionCore)) {
    throw new Error(`版本 ${id} 的 decisionCore 非法：${String(decisionCore)}（允许：${DECISION_CORES.join('|')}）`);
  }
  if (typeof parameters !== 'object' || parameters === null) throw new Error(`版本 ${id} 缺少 parameters`);
  // 核心一致性（先于参数校验，给出 audit 语义错误而非校验器附带错误）：
  // 非冠军引导核心绝不允许携带适配器字段——权重乘子会被决策分派静默忽略。
  if (decisionCore !== 'champion-guided' && parameters.adapter !== undefined) {
    throw new Error(`版本 ${id}（decisionCore=${decisionCore}）非法携带 adapter 字段——权重乘子会被决策分派静默忽略（audit 缺陷）`);
  }
  const validated = validateAIParameters(parameters);
  if (decisionCore === 'champion-guided' && validated.adapter !== 'champion-guided') {
    throw new Error(`版本 ${id}（decisionCore=champion-guided）的 parameters 必须显式携带 adapter='champion-guided'`);
  }
  return validated;
}

function freezeDeep(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** 从晋级归档 JSON 读取冻结参数（file 存在性严格校验）。 */
function readArchiveParameters(path) {
  if (!existsSync(path)) throw new Error(`晋级归档不存在：${path}（冻结身份必须来自归档快照，不得读活动冠军状态）`);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const parameters = doc.parameters ?? doc;
  if (!parameters?.id) throw new Error(`晋级归档缺少 parameters.id：${path}`);
  return parameters;
}

/** 由参数构造描述符并冻结（内部工具）。 */
function makeDescriptor({ id, family, decisionCore, parameters, jointOptions = null, lineage, description }) {
  const validated = validateDescriptor({ id, family, decisionCore, parameters });
  const descriptor = {
    id, family, decisionCore,
    parameters: validated,
    structure: validated.structure ?? null,
    acquisitionVariant: validated.acquisitionVariant ?? null,
    jointOptions,
    lineage,
    description,
  };
  return freezeDeep({ ...descriptor, fingerprint: sha256Hex(canonicalJSON(identityFields(descriptor))) });
}

/** 冠军基座参数（strip-adapter 后的血统基座）：JS5 归档参数剥离适配器字段，
 * 保留 structure/acquisitionVariant 血统——束搜索风格变体的派生基座。
 * 归档的适配器冠军参数可缺省权重乘子（validateAIParameters 对 adapter 参数
 * 补默认 1.0），剥离后必须显式补齐（束搜索核心要求全部权重在场，缺省语义
 * 与适配器口径一致：1.0）。
 * 注意：归档的 joint-js5 参数无 structure 字段；冠军引导核心的基座结构是
 * beam-rollout（champion-guided.ts 缺省），此处显式固定，避免派生歧义。 */
export function championBaseParameters(championArchiveParameters) {
  const base = stripAdapter(championArchiveParameters);
  const withWeights = { ...base };
  for (const key of Object.keys(PARAMETER_BOUNDS)) {
    if (withWeights[key] === undefined) withWeights[key] = 1;
  }
  return validateAIParameters({ ...withWeights, structure: withWeights.structure ?? 'beam-rollout' });
}

/** 权重覆盖钳制：越界直接拒绝（防无意义进化参数），不做静默钳制。 */
export function applyWeightOverrides(baseParameters, overrides) {
  const merged = { ...baseParameters };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in PARAMETER_BOUNDS)) throw new Error(`未知权重参数：${key}`);
    const [low, high] = PARAMETER_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
      throw new Error(`权重覆盖 ${key}=${value} 越界：必须为 ${low}–${high} 的有限数值`);
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * 构建对手版本注册表（全部版本源自晋级归档快照 / 显式常量，身份冻结）。
 *
 * @param {object} [options]
 * @param {string} [options.archiveDir] 晋级归档目录（测试可注入临时目录；
 *   缺省 training/champions/candidates）。
 * @param {object} [options.jointOptions] 冠军引导核心运行时选项（缺省按冻结
 *   归档 budgetMs=100；冒烟/测试传 {workUnits:N} 走确定性快档）。
 * @returns {{versions: Object<string, descriptor>, snapshot: object}} 深冻结注册表
 *   与元数据快照（版本指纹表 + 引擎产物指纹——联赛报告全量披露）。
 */
export function buildRegistry({ archiveDir = CHAMPION_ARCHIVE_DIR, jointOptions = null } = {}) {
  // 1) 冻结冠军（JS5）：身份 = 晋级归档快照，与活动冠军状态完全解耦。
  const js5Archive = readArchiveParameters(resolve(archiveDir, 'joint-js5.json'));
  const frozenChampion = makeDescriptor({
    id: 'js5-frozen-champion',
    family: 'champion',
    decisionCore: 'champion-guided',
    parameters: js5Archive,
    jointOptions,
    lineage: { derivedFrom: 'training/champions/candidates/joint-js5.json', note: 'challengeIndex=11 promote 快照' },
    description: 'JS5 冠军引导选择性联合搜索（冻结归档身份，不随当前冠军切换变化）',
  });

  // 2) 历史冠军（束搜索核心，来自归档，无适配器字段）。
  const ai5Archive = readArchiveParameters(resolve(archiveDir, 'ai5-readiness-efficiency.json'));
  const ai5Readiness = makeDescriptor({
    id: 'ai5-readiness-efficiency',
    family: 'historical-champion',
    decisionCore: 'beam-search',
    parameters: ai5Archive,
    lineage: { derivedFrom: 'training/champions/candidates/ai5-readiness-efficiency.json', note: 'challengeIndex=9 晋级，JS5 前任冠军' },
    description: 'AI5 readiness-efficiency（beam-rollout + readiness 获取估值）',
  });
  const ai4Archive = readArchiveParameters(resolve(archiveDir, 'struct-beam-rollout.json'));
  const ai4Beam = makeDescriptor({
    id: 'ai4-struct-beam-rollout',
    family: 'historical-champion',
    decisionCore: 'beam-search',
    parameters: ai4Archive,
    lineage: { derivedFrom: 'training/champions/candidates/struct-beam-rollout.json', note: 'AI4 结构候选晋级（challengeIndex 早期世代）' },
    description: 'AI4 struct-beam-rollout（束搜索 rollout 结构）',
  });

  // 3) 中立基线（全 1.0 权重，V3.0 行为锚点）。
  const neutral = makeDescriptor({
    id: 'neutral-baseline',
    family: 'baseline',
    decisionCore: 'beam-search',
    parameters: BASELINE_PARAMETERS,
    lineage: { derivedFrom: 'BASELINE_PARAMETERS', note: '全权重 1.0 行为锚点' },
    description: '中立基线（束搜索，全权重 1.0）',
  });

  // 4) 风格变体族：冠军血统基座（strip-adapter + beam-rollout + readiness 血统）
  //    + 显式权重覆盖。与 JS5 的差异是结构性的（束搜索 vs 联合搜索）与参数性
  //    的（权重覆盖），绝不经联合搜索路径。
  const base = championBaseParameters(js5Archive);
  const styleSpecs = [
    { id: 'style-rush', overrides: { tempoWeight: 1.6, restWeight: 0.5, engineWeight: 0.5, endgameWeight: 0.6 }, description: '速攻型：行动效率优先，牺牲引擎建设与终局管理' },
    { id: 'style-engine', overrides: { engineWeight: 1.6, capacityWeight: 1.4, tempoWeight: 0.7 }, description: '引擎型：商人卡长期产出优先，牺牲得分速度' },
    { id: 'style-contest', overrides: { contestWeight: 1.6, goalWeight: 1.2 }, description: '争夺型：对手需求压力敏感，积极竞争市场卡' },
    { id: 'style-balanced', overrides: {}, description: '均衡型：冠军血统基座权重（无联合搜索的 JS5 参数对照）' },
  ];
  const styles = styleSpecs.map(spec => makeDescriptor({
    id: spec.id,
    family: 'style',
    decisionCore: 'beam-search',
    parameters: applyWeightOverrides(base, spec.overrides),
    lineage: { derivedFrom: 'js5-frozen-champion (strip-adapter 基座)', note: `权重覆盖 ${JSON.stringify(spec.overrides)}` },
    description: spec.description,
  }));

  // 5) 随机合法策略（与冠军算法结构完全不同的多样性锚点）。
  const randomLegal = makeDescriptor({
    id: 'random-legal',
    family: 'random',
    decisionCore: 'random-legal',
    parameters: BASELINE_PARAMETERS,
    lineage: { derivedFrom: 'BASELINE_PARAMETERS', note: '均匀合法采样（参数不参与决策，仅为类型完备）' },
    description: '随机合法策略（逐决策确定性均匀采样，RNG 流只依赖 (seed, seat)）',
  });

  const versions = Object.fromEntries(
    [frozenChampion, ai5Readiness, ai4Beam, neutral, ...styles, randomLegal].map(v => [v.id, v]),
  );
  const snapshot = Object.freeze({
    schema: 'century-adversarial-registry-v1',
    builtFrom: 'training/champions/candidates/*（晋级归档快照）',
    archiveDir: String(archiveDir),
    versionFingerprints: Object.fromEntries(Object.entries(versions).map(([id, v]) => [id, v.fingerprint])),
    registryFingerprint: registryFingerprint({ versions }),
    engineBundleSha256: engineBundleSha256(),
  });
  return freezeDeep({ versions, snapshot });
}

/** 解析版本（未注册 id 抛错——禁止静默回退）。 */
export function resolveVersion(registry, id) {
  const version = registry.versions[id];
  if (!version) throw new Error(`未注册的对手版本：${id}（已注册：${Object.keys(registry.versions).join(', ')}）`);
  return version;
}

/** 版本 → 对局席位配置（league.mjs 游戏循环消费的分派字段）。 */
export function toSeatVersion(descriptor) {
  return {
    id: descriptor.id,
    fingerprint: descriptor.fingerprint,
    decisionCore: descriptor.decisionCore,
    parameters: descriptor.parameters,
    structure: descriptor.structure,
    jointVersion: descriptor.parameters.jointVersion ?? null,
    jointOptions: descriptor.jointOptions,
  };
}
