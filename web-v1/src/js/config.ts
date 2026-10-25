/** 联合搜索的有效配置解析（JS5 证据优化：配置身份单一入口）。
 *
 * 背景（三份真人分析报告的共同结论）：版本名称不等于实际执行配置——
 * - `joint-js5-opt` 此前只是标签，未注入任何独有选项；
 * - 网页生产路径不传 profile / simSeed，训练 duel 按席位注入；
 * - Worker 协议此前不包含 gate/margin/cap/claimRanking。
 * 本模块把"版本注册表 → 预设 → 调用方覆盖"合成一个可审计的 resolved
 * options 对象，并给出稳定的 32 位 FNV-1a 配置哈希（浏览器/Worker/Node 共用）。
 *
 * 纪律：预设只记录**已经过评测/报告明确记载**的配置，不凭空发明"最优"。
 * - joint-js5：无覆盖（PR #27 + 第五阶段冻结缺省）。
 * - joint-js5-opt：claimRanking='prior'（AI6 第五阶段 tune2 冻结，见
 *   AI6-PHASE5-REPORT.md §4.3；确认集 inconclusive，未晋级）。
 */

import { CHAMPION_PARAMETERS, type AIParameters } from '../ai/parameters.js';
import { JOINT_VERSIONS, type JointSearchOptions } from './types.js';

/** JS5 搜索缺省值（与 champion-guided.ts resolveChampionGuidedOptions 一致）。
 * 集中在此供适配器 / Worker / 研究 runner 共用；新增选项必须同步默认值。 */
export type JointSearchResolved = {
  versionId: string;
  kind: string;
  algorithm: 'champion-guided' | 'joint-rollout' | 'joint-tree' | 'champion-contest';
  variant: string;
  championStructure: string;
  championParametersId: string;
  acquisitionVariant: string | null;
  profileName: string | null;
  budgetMode: 'fixed-work' | 'wall-clock';
  budgetMs: number | null;
  workUnits: number | null;
  simSeed: number;
  horizon: number;
  worlds: number;
  opponentMode: string;
  evaluator: string;
  gateMode: string;
  contestThreshold: number;
  candidateCap: number;
  overrideMargin: number;
  claimRanking: string;
  nearTerminalCandidate: string;
  screenGoalScope: string;
  batchAdmission: string;
  /** 版本预设覆盖（显式披露；opt 不再是"只有名字不同"）。 */
  preset: Record<string, unknown>;
  /** 调用方覆盖（显式披露）。 */
  overrides: Record<string, unknown>;
};

export const JOINT_SEARCH_DEFAULTS = {
  championStructure: 'beam-rollout',
  gateMode: 'auto',
  contestThreshold: 0.85,
  candidateCap: 4,
  overrideMargin: 0.02,
  claimRanking: 'enumeration',
  nearTerminalCandidate: 'off',
  screenGoalScope: 'all',
  batchAdmission: 'legacy',
  variant: 'joint-rollout',
  worlds: 4,
  horizon: 48,
  opponentMode: 'rule',
  evaluator: 'L2',
} as const;

const PRESET_FIELDS = [
  'championStructure', 'gateMode', 'contestThreshold', 'candidateCap', 'overrideMargin',
  'claimRanking', 'nearTerminalCandidate', 'screenGoalScope', 'batchAdmission',
  'variant', 'worlds', 'horizon', 'opponentMode', 'evaluator',
] as const;

/** 版本预设（仅已记载配置；preset 为空 = 与冻结缺省逐项相同）。 */
export function versionOptionPreset(versionId: string): Record<string, unknown> {
  const version = JOINT_VERSIONS[versionId as keyof typeof JOINT_VERSIONS];
  if (!version) throw new Error(`未知联合规划版本：${String(versionId)}`);
  return { ...(version.optionPreset ?? {}) };
}

/** 合并版本预设与调用方覆盖；返回新对象（不修改入参）。 */
export function mergeJointOptions(versionId: string, options: JointSearchOptions = {}): JointSearchOptions {
  return { ...versionOptionPreset(versionId), ...options };
}

/** 有效配置解析。`options` 已含预设合并后的值；未给的字段取缺省。 */
export function resolveJointConfig(
  versionId: string,
  options: JointSearchOptions & Record<string, unknown> = {},
  profileName?: string | null,
): JointSearchResolved {
  const version = JOINT_VERSIONS[versionId as keyof typeof JOINT_VERSIONS];
  if (!version) throw new Error(`未知联合规划版本：${String(versionId)}`);
  const preset = versionOptionPreset(versionId);
  const workUnits = typeof options.workUnits === 'number' ? options.workUnits : null;
  const budgetMs = workUnits === null
    ? (typeof options.budgetMs === 'number' ? options.budgetMs : (version.kind === 'champion-guided' ? 100 : null))
    : null;
  const merged = {
    ...JOINT_SEARCH_DEFAULTS,
    ...Object.fromEntries(PRESET_FIELDS.filter(k => preset[k] !== undefined).map(k => [k, preset[k]])),
    ...Object.fromEntries(PRESET_FIELDS.filter(k => (options as Record<string, unknown>)[k] !== undefined).map(k => [k, (options as Record<string, unknown>)[k]])),
  };
  // AI7-A2：被冻结版本身份的描述符必须携带其归档参数；配置身份披露
  // 「实际消费的冠军基座参数 id / 血统」，不再无条件读活动 CHAMPION_PARAMETERS。
  // 未显式传入时保持历史缺省（生产路径显式传入活动参数）。
  const championParameters = (options.championParameters ?? CHAMPION_PARAMETERS) as AIParameters;
  return {
    versionId,
    kind: version.kind,
    algorithm: version.kind === 'champion-guided' ? 'champion-guided'
      : version.kind === 'joint' ? (String(merged.variant) === 'joint-tree' ? 'joint-tree' : 'joint-rollout')
      : 'champion-contest',
    variant: String(merged.variant),
    championStructure: String(merged.championStructure),
    championParametersId: championParameters.id,
    acquisitionVariant: championParameters.acquisitionVariant ?? null,
    profileName: profileName ?? null,
    budgetMode: workUnits !== null ? 'fixed-work' : budgetMs !== null ? 'wall-clock' : 'wall-clock',
    budgetMs,
    workUnits,
    simSeed: typeof options.simSeed === 'number' ? options.simSeed : 0,
    horizon: Number(merged.horizon),
    worlds: Number(merged.worlds),
    opponentMode: String(merged.opponentMode),
    evaluator: String(merged.evaluator),
    gateMode: String(merged.gateMode),
    contestThreshold: Number(merged.contestThreshold),
    candidateCap: Number(merged.candidateCap),
    overrideMargin: Number(merged.overrideMargin),
    claimRanking: String(merged.claimRanking),
    nearTerminalCandidate: String(merged.nearTerminalCandidate),
    screenGoalScope: String(merged.screenGoalScope),
    batchAdmission: String(merged.batchAdmission),
    preset,
    overrides: Object.fromEntries(PRESET_FIELDS.filter(k => (options as Record<string, unknown>)[k] !== undefined).map(k => [k, (options as Record<string, unknown>)[k]])),
  };
}

/** 32 位 FNV-1a（确定性、零依赖；用于配置身份，不作为密码学哈希）。 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 稳定序列化（键排序；数组保持顺序）。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 有效配置哈希（忽略可能已附加的 hash 字段，保证可重复计算）。 */
export function jointConfigHash(config: JointSearchResolved & { hash?: string }): string {
  const { hash: _ignored, ...payload } = config;
  return fnv1a32(stableStringify(payload));
}
