/** 不可变版本注册表（AI6 第六阶段 P0：冠军版本与评测身份污染修复）。
 *
 * 背景（P0 审计结论，修复前失败证据：confirm-replay-check js0 重放 24/24 → 1/12）：
 * PR #30 晋级后 CHAMPION_PARAMETERS 从束搜索冠军（ai5-readiness-efficiency）
 * 切换为适配器冠军描述符（joint-js5，携带 adapter 字段）。所有把
 * CHAMPION_PARAMETERS 当作"历史冻结冠军"引用的评测路径从此静默失真：
 * - js0（历史冠军）经 chooseAIAction 适配器分派实际运行 JS5；
 * - js1（beam-contest）因适配器分支优先于 structure 覆盖，同样静默变成 JS5；
 * - 对手池风格变体继承 adapter 字段，权重修改被适配器忽略（变体 ≡ 冠军本体）；
 * - gate=never 等价审计退化为 JS5 vs JS5 自比（失去鉴别力）。
 *
 * 本注册表把"可对照版本"的完整身份显式冻结，与 CHAMPION_PARAMETERS 解耦：
 * - legacy-js0：历史束搜索冠军（challengeIndex=9 晋级，ai5-readiness-efficiency）；
 * - legacy-js1：历史冠军参数 + 静态目标存活折扣结构（beam-contest）；
 * - joint-js5-frozen：PR #30 晋级时的 JS5 完整描述符（challengeIndex=11 证据）；
 * - joint-js6-experimental：第六阶段实验候选（可变；算法实现注册后才能解析）。
 *
 * 纪律：
 * - 冻结版本参数为逐字快照，任何改动都会被指纹钉定测试
 *   （web-v1/tests/version-registry.test.mjs）与 version-gate 门禁捕获；
 * - 算法身份由（参数 + 结构 + 适配器 + 版本 id + 来源 commit）共同决定，
 *   显示名称不参与身份判定；
 * - 评测代码必须经 frozenVersion() 解析历史/冻结版本，禁止把
 *   CHAMPION_PARAMETERS 充当任何历史版本（该常量只代表"当前部署冠军"）。
 */

import type { AIParameters } from './parameters.js';

// === 确定性指纹（变更检测用，非密码学） ===

/** 稳定字符串化：键排序 + 数组保序（参数对象为扁平标量集合）。 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** FNV-1a 双通道 64 位指纹（十六进制 16 字符）。 */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 参数对象指纹（canonical JSON 的 FNV 指纹）。 */
export function parametersFingerprint(params: AIParameters): string {
  return fingerprint(canonicalJSON(params));
}

// === 冻结版本 ===

export type FrozenVersionId = 'legacy-js0' | 'legacy-js1' | 'joint-js5-frozen' | 'joint-js6-experimental';

export type FrozenVersion = {
  id: FrozenVersionId;
  label: string;
  /** 算法族（身份判定字段，非显示名）：beam-search = 冠军束搜索路径；
   * champion-guided-joint-search = 适配器联合搜索路径。 */
  algorithm: 'beam-search' | 'champion-guided-joint-search' | 'experimental';
  /** 完整参数快照（分派唯一依据；adapter 字段存在 → 适配器分派）。 */
  parameters: AIParameters;
  /** 束搜索结构（algorithm=beam-search 时必须非空）。 */
  structure: 'beam-rollout' | 'beam-contest' | null;
  /** 来源 commit（身份溯源）。 */
  originCommit: string;
  /** 晋级/冻结证据摘要。 */
  originEvidence: string;
  frozen: boolean;
};

/** legacy-js0 参数快照 = 晋级前 CHAMPION_PARAMETERS（a69956a^ 逐字快照，
 * 与 web-v1/tests/fixtures/legacy-champion.json 及
 * training/champions/candidates/ai5-readiness-efficiency.json 一致）。 */
const LEGACY_JS0_PARAMETERS: AIParameters = {
  id: 'ai5-readiness-efficiency',
  engineWeight: 1,
  tempoWeight: 1,
  contestWeight: 1,
  synergyWeight: 1,
  goalWeight: 1,
  capacityWeight: 1,
  restWeight: 1,
  endgameWeight: 1,
  structure: 'beam-rollout',
  acquisitionVariant: 'readiness-efficiency',
};

/** joint-js5-frozen 参数快照 = PR #30 晋级 champion.json parameters（逐字）。 */
const JOINT_JS5_FROZEN_PARAMETERS: AIParameters = {
  id: 'joint-js5',
  adapter: 'champion-guided',
  engineWeight: 1,
  tempoWeight: 1,
  contestWeight: 1,
  synergyWeight: 1,
  goalWeight: 1,
  capacityWeight: 1,
  restWeight: 1,
  endgameWeight: 1,
  acquisitionVariant: 'readiness-efficiency',
  jointVersion: 'joint-js5',
  budgetMs: 100,
};

export const FROZEN_VERSIONS: Record<FrozenVersionId, FrozenVersion> = {
  'legacy-js0': {
    id: 'legacy-js0',
    label: '历史冠军 ai5-readiness-efficiency（束搜索 beam-rollout，challengeIndex=9 晋级）',
    algorithm: 'beam-search',
    parameters: LEGACY_JS0_PARAMETERS,
    structure: 'beam-rollout',
    originCommit: 'a69956a^（晋级前 CHAMPION_PARAMETERS 逐字快照）',
    originEvidence: 'challengeIndex=9（500 种子正式挑战）；PR #19',
    frozen: true,
  },
  'legacy-js1': {
    id: 'legacy-js1',
    label: '历史冠军 + 静态目标存活折扣（beam-contest 结构，JS1 冻结定义）',
    algorithm: 'beam-search',
    parameters: { ...LEGACY_JS0_PARAMETERS, structure: 'beam-contest' },
    structure: 'beam-contest',
    originCommit: 'a69956a^（JS1 = 冻结冠军参数 + beam-contest）',
    originEvidence: 'PR #26/27 消融编号 JS1；2–5 人与 js0 统计不可区分（第五阶段 confirm）',
    frozen: true,
  },
  'joint-js5-frozen': {
    id: 'joint-js5-frozen',
    label: 'JS5 冠军引导选择性联合搜索（PR #30 正式晋级描述符，challengeIndex=11）',
    algorithm: 'champion-guided-joint-search',
    parameters: JOINT_JS5_FROZEN_PARAMETERS,
    structure: null,
    originCommit: 'a69956a（JS5 正式晋级）',
    originEvidence: 'challengeIndex=11（250 种子 × 2 方向，配对得分优势率 0.758，Wilson 下界 0.634>0.5）；PR #30',
    frozen: true,
  },
  'joint-js6-experimental': {
    id: 'joint-js6-experimental',
    label: '第六阶段实验候选（占位：算法实现注册后才能解析；禁止未验证晋级）',
    algorithm: 'experimental',
    parameters: { id: 'joint-js6-experimental' } as AIParameters,
    structure: null,
    originCommit: 'research/ai6-phase6-winrate-scaling（进行中）',
    originEvidence: '待第六阶段实验填充（无证据前不得晋级）',
    frozen: false,
  },
};

/** 解析冻结版本（未知 id 抛错；实验版本未注册算法实现时抛错）。 */
export function frozenVersion(id: FrozenVersionId | string): FrozenVersion {
  const v = FROZEN_VERSIONS[id as FrozenVersionId];
  if (!v) {
    throw new Error(`未知版本 id：${String(id)}（注册表：${Object.keys(FROZEN_VERSIONS).join(', ')}）`);
  }
  if (v.algorithm === 'experimental' && !v.parameters.adapter) {
    throw new Error(`实验版本 ${id} 尚未注册算法实现（占位身份），不能参与对局`);
  }
  return v;
}

/** 实验候选描述（本阶段联合搜索实验的显式注入形态）：与 JOINT_VERSIONS 对齐，
 * 参数快照 = js5 冻结描述符 + 选项覆盖；身份指纹覆盖选项。 */
export function experimentalDescriptor(overrides: Record<string, unknown>): {
  id: string; algorithm: 'champion-guided-joint-search'; parameters: AIParameters; structure: null; options: Record<string, unknown>; fingerprint: string;
} {
  const options = { budgetMs: JOINT_JS5_FROZEN_PARAMETERS.budgetMs, ...overrides };
  return {
    id: 'joint-js6-experimental',
    algorithm: 'champion-guided-joint-search',
    parameters: JOINT_JS5_FROZEN_PARAMETERS,
    structure: null,
    options,
    fingerprint: fingerprint(canonicalJSON(options)),
  };
}
