/** 不可变算法版本描述符（AI6 合并后可靠性整改 P0-1）。
 *
 * 缺陷背景（OVERNIGHT-AUDIT.md P0-1，2026-10-25 复现实锤）：
 * PR #30 晋级后 CHAMPION_PARAMETERS = joint-js5（携带 adapter='champion-guided'）。
 * training/joint/duel.mjs 的 js0/js1 候选路径与 equivalence-audit.mjs 的 js0 侧
 * 直接传递 CHAMPION_PARAMETERS → decision.ts 适配器分支先于 structure 选项生效，
 * 「js0（冻结冠军）」「js1（beam-contest）」标签实际全部执行 JS5 联合搜索
 * （audit-versions.mjs V2/V3：8/8 探针走适配器路径，首个动作分歧 @step=1）。
 * 「gate=never ≡ js0」等价审计与 JS5 vs JS0 消融因此失去基线意义。
 *
 * 本模块建立四层分离的版本身份（缺一层即身份不明）：
 * 1. 算法身份（identity）：决策核心 + 结构 + 联合版本 + 预算口径——语义不变量；
 * 2. 参数（parameters）：全部来自晋级归档快照（training/champions/candidates/），
 *    绝不读 champion.json / CHAMPION_PARAMETERS 活动状态（活动冠军切换不得
 *    改变历史版本行为）；
 * 3. 搜索预算（budget）：budgetMs / workUnits 显式字段，不混入参数对象；
 * 4. 运行指纹（run fingerprint）：引擎产物指纹 + 代码 commit——由实验运行器
 *    在进程启动时捕获并落盘，不属版本身份（同版本可跨运行复现或漂移）。
 *
 * 纪律：
 * - legacy-* 核心绝不允许携带 adapter/jointVersion/budgetMs（防分派劫持）；
 * - joint-js5-frozen 必须显式携带 adapter='champion-guided'；
 * - live-champion 是唯一读取活动状态的显式别名，仅供「对当前冠军」语义，
 *   禁止用作历史版本对照基线（测试与审计强制）；
 * - 全部描述符深冻结；指纹 = sha256(canonicalJSON(身份字段))，键排序递归序列化。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { validateAIParameters, BASELINE_PARAMETERS, CHAMPION_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { REPO_ROOT } from './paths.mjs';
import { assertVersionLockIntact } from './version-lock.mjs';

export const VERSION_REGISTRY_SCHEMA = 'century-algorithm-version-registry-v1';

/** 决策核心枚举（与 training/adversarial/registry.mjs DECISION_CORES 同口径）。 */
export const DECISION_CORES = Object.freeze(['beam-search', 'champion-guided', 'random-legal']);

/** 晋级归档目录（冻结身份唯一来源）。 */
export const CHAMPION_ARCHIVE_DIR = resolve(REPO_ROOT, 'training/champions/candidates');

const ADAPTER_FIELDS = Object.freeze(['adapter', 'jointVersion', 'budgetMs']);

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

/** 从晋级归档读取冻结参数（严格校验：缺文件/缺 id 一律抛错——宁可终止也不
 * 静默回退到活动冠军状态）。 */
function readArchiveParameters(path) {
  if (!existsSync(path)) {
    throw new Error(`晋级归档不存在：${path}（冻结版本身份必须来自归档快照，禁止回退活动冠军）`);
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const parameters = doc.parameters ?? doc;
  if (!parameters?.id) throw new Error(`晋级归档缺少 parameters.id：${path}`);
  return parameters;
}

/** 深冻结（描述符不可变性的运行时保证）。 */
function freezeDeep(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** 决策身份字段（指纹覆盖范围）：算法身份 + 冻结参数。运行时遥测
 * （engineBundleSha256 / commit / 墙钟）绝不入指纹——它们是运行指纹。 */
function identityFields({ core, structure, jointVersion, budgetMs, parameters }) {
  return {
    core,
    structure: structure ?? null,
    jointVersion: jointVersion ?? null,
    budgetMs: budgetMs ?? null,
    parameters,
  };
}

/** 版本身份指纹：同指纹 ⇔ 同算法身份（核心/结构/预算/参数全部一致）。 */
export function identityFingerprint(descriptor) {
  return sha256Hex(canonicalJSON(identityFields(descriptor)));
}

/** 校验描述符核心一致性（先于一切使用）：
 * - legacy 束搜索核心：绝不允许携带适配器字段（防 decision.ts 分派劫持）；
 * - champion-guided 核心：必须显式携带 adapter='champion-guided'。 */
function assertDescriptorConsistency(descriptor, registryId) {
  if (!DECISION_CORES.includes(descriptor.core)) {
    throw new Error(`版本 ${registryId} 决策核心非法：${String(descriptor.core)}`);
  }
  const hasAdapterField = ADAPTER_FIELDS.some(k => descriptor.parameters?.[k] !== undefined);
  if (descriptor.core !== 'champion-guided' && hasAdapterField) {
    throw new Error(
      `版本 ${registryId}（core=${descriptor.core}）参数非法携带适配器字段 ` +
      `(${ADAPTER_FIELDS.filter(k => descriptor.parameters[k] !== undefined).join('/')}）——` +
      'decision.ts 会将其静默分派到联合搜索（P0-1 缺陷模式）',
    );
  }
  if (descriptor.core === 'champion-guided' && descriptor.parameters?.adapter !== 'champion-guided') {
    throw new Error(`版本 ${registryId}（core=champion-guided）参数必须显式携带 adapter='champion-guided'`);
  }
}

/**
 * 解析注册版本（缺 id / 归档缺失一律抛错，禁止静默回退）。
 *
 * 注册版本：
 * - legacy-js0 / js0：冻结冠军基线 = ai5-readiness-efficiency 晋级归档
 *   （beam-rollout 结构，challengeIndex=9 晋级版本）。第五阶段全部 js0 消融、
 *   confirm 块与 equivalence 审计的历史语义锚点；
 * - legacy-js1 / js1：同一冻结基座 + beam-contest 结构（冠军 + 静态目标存活折扣）；
 * - joint-js5-frozen / js5：JS5 冠军引导选择性联合搜索 = joint-js5 晋级归档
 *   （adapter='champion-guided'，budgetMs=100，acquisitionVariant 血统保留——
 *   联合轨迹贪心镜像消费该字段，缺失会翻转认领仲裁）；
 * - live-champion：活动冠军别名（CHAMPION_PARAMETERS）。显式隔离：仅供
 *   「对手池含当前冠军」语义；历史版本对照/消融基线/等价审计禁止使用
 *   （审计与测试强制——活动冠军切换不得改变历史版本行为）。
 *
 * @param {string} id 版本 id（含 js0/js1/js5 简写别名）
 * @param {object} [options]
 * @param {string} [options.archiveDir] 归档目录（测试可注入临时目录）
 * @returns {Readonly<object>} 深冻结描述符
 */
export function resolveAlgorithmVersion(id, { archiveDir = CHAMPION_ARCHIVE_DIR } = {}) {
  // AI7-A2：冻结版本（含归档参数与决策核心源码）必须通过字节级版本锁；
  // live-champion 是活动别名，明确不锁（其变化由冠军晋级流程治理）。
  if (id !== 'live-champion') assertVersionLockIntact();
  const make = (descriptor) => {
    assertDescriptorConsistency(descriptor, id);
    const fingerprint = identityFingerprint(descriptor);
    return freezeDeep({
      registryId: id,
      ...descriptor,
      parameters: validateAIParameters(descriptor.parameters),
      fingerprint,
      immutable: true,
    });
  };

  switch (id) {
    case 'legacy-js0':
    case 'js0': {
      const source = resolve(archiveDir, 'ai5-readiness-efficiency.json');
      const parameters = readArchiveParameters(source);
      return make({
        id: 'legacy-js0',
        label: 'JS0 冻结冠军基线（ai5-readiness-efficiency 束搜索）',
        core: 'beam-search',
        structure: parameters.structure ?? 'beam-rollout',
        jointVersion: null,
        budgetMs: null,
        parameters,
        source: 'training/champions/candidates/ai5-readiness-efficiency.json',
        lineage: { derivedFrom: 'challengeIndex=9 晋级归档', note: '第五阶段 js0 消融/confirm/等价审计的历史语义锚点' },
      });
    }
    case 'legacy-js1':
    case 'js1': {
      const source = resolve(archiveDir, 'ai5-readiness-efficiency.json');
      const parameters = readArchiveParameters(source);
      return make({
        id: 'legacy-js1',
        label: 'JS1（冻结基座 + beam-contest 结构）',
        core: 'beam-search',
        structure: 'beam-contest',
        jointVersion: null,
        budgetMs: null,
        parameters,
        source: 'training/champions/candidates/ai5-readiness-efficiency.json + structure=beam-contest',
        lineage: { derivedFrom: 'legacy-js0 + beam-contest', note: '冠军 + 静态目标存活折扣（第四阶段最佳折中非联合候选）' },
      });
    }
    case 'joint-js5-frozen':
    case 'js5': {
      const source = resolve(archiveDir, 'joint-js5.json');
      const parameters = readArchiveParameters(source);
      return make({
        id: 'joint-js5-frozen',
        label: 'JS5 冠军引导选择性联合搜索（冻结归档身份）',
        core: 'champion-guided',
        structure: null,
        jointVersion: parameters.jointVersion ?? 'joint-js5',
        budgetMs: parameters.budgetMs ?? 100,
        parameters,
        source: 'training/champions/candidates/joint-js5.json',
        lineage: { derivedFrom: 'challengeIndex=11 晋级归档', note: 'acquisitionVariant=readiness-efficiency 血统必须保留（轨迹镜像消费）' },
      });
    }
    case 'live-champion': {
      const parameters = validateAIParameters(CHAMPION_PARAMETERS);
      const core = parameters.adapter === 'champion-guided' ? 'champion-guided' : 'beam-search';
      return make({
        id: 'live-champion',
        label: '当前活动冠军别名（CHAMPION_PARAMETERS，随晋级切换）',
        core,
        structure: parameters.structure ?? null,
        jointVersion: parameters.jointVersion ?? null,
        budgetMs: parameters.budgetMs ?? null,
        parameters,
        source: 'web-v1/dist CHAMPION_PARAMETERS（活动状态，非归档）',
        lineage: { derivedFrom: 'champion.json 活动别名', note: '仅供「对当前冠军」语义；历史对照/消融基线/等价审计禁止使用' },
      });
    }
    // === AI7 候选（注册身份 ≠ 晋级：全部默认不参与生产决策） ===
    case 'ai7-endgame':
    case 'ai7-arb':
    case 'ai7-engine':
    case 'ai7-engine-seat': {
      const spec = {
        'ai7-endgame': {
          parametersId: 'ai7-endgame-exact', jointVersion: 'joint-js6-endgame',
          label: 'AI7-C1 终局精确求解（官方得分/保证名次/终局弃置）',
          note: 'C1：终局圈枚举合法行动，按官方最终得分与公开名次界决策',
        },
        'ai7-arb': {
          parametersId: 'ai7-arb-paired', jointVersion: 'joint-js7-arb',
          label: 'AI7-C3 JS5 配对仲裁稳健性（置信下界+认领保护）',
          note: 'C3：配对差单侧置信下界 + 高价值认领保护 + 最佳认领候选补全',
        },
        'ai7-engine': {
          parametersId: 'ai7-engine-v2', jointVersion: 'joint-js8-engine',
          label: 'AI7-C2 引擎价值 V2（剩余回合/重复产出/循环成本）',
          note: 'C2：创造卡重复产出、升级长期作用、休息循环摊销、支付机会成本',
        },
        'ai7-engine-seat': {
          parametersId: 'ai7-engine-v2-seat', jointVersion: 'joint-js8-engine-seat',
          label: 'AI7-C4 引擎价值 V2 + 人数条件竞争折扣',
          note: 'C4：5 人局竞争折扣；必须按人数分层单独消融，禁止用 5 人收益推断 2 人',
        },
      }[id];
      const parameters = validateAIParameters({
        ...CHAMPION_PARAMETERS,
        id: spec.parametersId,
        adapter: 'champion-guided',
        jointVersion: spec.jointVersion,
        budgetMs: 100,
        ...(id.startsWith('ai7-engine') ? {
          engineModel: 'v2',
          seatPolicy: id === 'ai7-engine-seat' ? 'stratified' : 'flat',
        } : {}),
      });
      return make({
        id,
        label: spec.label,
        core: 'champion-guided',
        structure: null,
        jointVersion: spec.jointVersion,
        budgetMs: 100,
        parameters,
        source: `web-v1 JOINT_VERSIONS['${spec.jointVersion}']（候选预设）`,
        lineage: { derivedFrom: 'joint-js5-frozen + AI7 候选选项', note: spec.note },
      });
    }
    default:
      throw new Error(`未注册的算法版本：${id}（已注册：legacy-js0, legacy-js1, joint-js5-frozen, live-champion, ai7-endgame, ai7-arb, ai7-engine, ai7-engine-seat）`);
  }
}

/** 版本 → 决策调用选项（运行器按 core 分派；调用点不得自行拼参数对象——
 * 一切「标签身份 = 执行身份」的一致性由此单一出口保证）。 */
export function decisionOptions(descriptor) {
  if (descriptor.core === 'champion-guided') {
    return {
      mode: 'joint',
      joint: {
        version: descriptor.jointVersion,
        ...(descriptor.budgetMs !== null ? { budgetMs: descriptor.budgetMs } : {}),
      },
    };
  }
  if (descriptor.core === 'beam-search') {
    return {
      mode: 'beam',
      beam: {
        parameters: descriptor.parameters,
        ...(descriptor.structure ? { structure: descriptor.structure } : {}),
      },
    };
  }
  throw new Error(`决策核心 ${descriptor.core} 无调用选项映射`);
}

/** 注册表快照（实验报告披露用）：全部注册版本的身份指纹 + 归档来源。
 * 引擎产物指纹 / commit 属运行指纹，由运行器另列，不入本快照。 */
export function describeVersionRegistry({ archiveDir = CHAMPION_ARCHIVE_DIR } = {}) {
  const ids = [
    'legacy-js0', 'legacy-js1', 'joint-js5-frozen', 'live-champion',
    'ai7-endgame', 'ai7-arb', 'ai7-engine', 'ai7-engine-seat',
  ];
  const versions = ids.map(id => {
    const d = resolveAlgorithmVersion(id, { archiveDir });
    return {
      registryId: d.registryId,
      label: d.label,
      core: d.core,
      structure: d.structure,
      jointVersion: d.jointVersion,
      budgetMs: d.budgetMs,
      parametersId: d.parameters.id,
      fingerprint: d.fingerprint,
      source: d.source,
      lineage: d.lineage,
    };
  });
  return freezeDeep({
    schema: VERSION_REGISTRY_SCHEMA,
    builtFrom: String(archiveDir),
    liveChampionParametersId: resolveAlgorithmVersion('live-champion', { archiveDir }).parameters.id,
    versions,
  });
}

/** 断言描述符可用于历史对照（live-champion 禁止——防活动别名混入基线语义）。 */
export function assertFrozenBaseline(descriptor, purpose) {
  if (descriptor.registryId === 'live-champion') {
    throw new Error(`live-champion 别名禁止用于${purpose ?? '历史版本对照'}（活动冠军切换会漂移基线语义）`);
  }
  return descriptor;
}

/** 中立基线参数重导出（池构造单一来源）。 */
export { BASELINE_PARAMETERS };
