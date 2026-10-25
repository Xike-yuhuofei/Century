/** AI7 自主进化平台·核心原语（任务 D 全部子任务共用）。
 *
 * 设计纪律：
 * 1. 不修改冠军决策代码与参数；本目录只新增控制面模块；
 * 2. 不修改 Agent A 的账本与晋级门禁核心；种子只通过 governance-adapter 申请；
 * 3. 只使用开发池（AI7 dev block），验证池 [900M, 1.06e9) 在本模块被硬拒绝；
 * 4. 一切身份哈希使用 canonical JSON（键排序递归序列化），与
 *    training/lib/version-registry.mjs、training/adversarial/registry.mjs 同口径。
 */

import { createHash } from 'node:crypto';
import {
  ENGINE_SEED_MAX,
  VALIDATION_POOL_BLOCK,
  AI6_SCENARIO_BLOCK,
} from '../../ai5/lib/seed_policy.mjs';
import { engineBundleSha256 } from '../lib/paths.mjs';

export { VALIDATION_POOL_BLOCK };

export const SCHEMAS = Object.freeze({
  candidateArtifact: 'century-candidate-artifact-v1',
  artifactManifest: 'century-candidate-artifact-manifest-v1',
  evolutionTarget: 'century-evolution-target-v1',
  campaign: 'century-evolution-campaign-v1',
  campaignEvent: 'century-evolution-event-v1',
  evaluationEvidence: 'century-evolution-evidence-v1',
  failureLabels: 'century-failure-labels-v1',
  governanceRequest: 'century-governance-challenge-request-v1',
});

/** AI7 开发池（左右闭开）。与既有全部区块物理隔离：
 * - [1.50e9, 1.60e9) AI6 战术基准局面库；
 * - [900M, 1.06e9) 正式验证池（严禁触碰）；
 * - AI7 在 1.6e9 之后新开：[1.61e9, 1.62e9) 快筛窗口池、[1.62e9, 1.63e9) 深验窗口池。
 *
 * 说明（报告必须披露）：本区块尚未写入 ai5/lib/seed_policy.mjs（该文件属 Agent A
 * 治理面，本轮不修改）。正式集成 Agent A 的可信治理接口时，必须由该接口登记
 * AI7 区块并通过账本分配；测试替身只用于离线研发演示，不产生正式证据。 */
export const AI7_DEV_BLOCKS = Object.freeze({
  screen: Object.freeze([1_610_000_000, 1_620_000_000]),
  deep: Object.freeze([1_620_000_000, 1_630_000_000]),
});

/** 区块内每个窗口的种子数（窗口 = 一次治理分配的不可变切片）。 */
export const AI7_WINDOW_SIZE = 1_000;
export const AI7_SCREEN_WINDOW_COUNT = (AI7_DEV_BLOCKS.screen[1] - AI7_DEV_BLOCKS.screen[0]) / AI7_WINDOW_SIZE;
export const AI7_DEEP_WINDOW_COUNT = (AI7_DEV_BLOCKS.deep[1] - AI7_DEV_BLOCKS.deep[0]) / AI7_WINDOW_SIZE;

/** 开发窗口总数（按用途）。 */
export function ai7WindowCount(purpose) {
  assertCondition(purpose === 'screen' || purpose === 'deep', `窗口用途非法：${String(purpose)}`);
  return purpose === 'screen' ? AI7_SCREEN_WINDOW_COUNT : AI7_DEEP_WINDOW_COUNT;
}

export const ALL_PLAYER_COUNTS = Object.freeze([2, 3, 4, 5]);

/** 游戏规则版本：规则语义版本 + 实际引擎产物指纹（运行指纹）。
 * 规则版本号在规则变更时手动递增；引擎指纹确保"同一规则版本、同一实现"。 */
export const GAME_RULES_VERSION = 'century-rules-v1';

/** 稳定 canonical JSON：键排序递归序列化（数组保序）。 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256Canonical(value) {
  return sha256Hex(canonicalJSON(value));
}

export function shortHash(hash, length = 12) {
  return hash.slice(0, length);
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/** 断言种子落在指定开发区块内（含头不含尾）；越界即终止。 */
export function assertDevSeedInBlock(seed, block, name = 'seed') {
  assertCondition(Number.isSafeInteger(seed), `${name} 必须为安全整数，实际：${String(seed)}`);
  assertCondition(seed >= block[0] && seed < block[1], `${name} ${seed} 越界：必须在 ${block[0]}..${block[1] - 1}`);
  assertCondition(seed <= ENGINE_SEED_MAX, `${name} ${seed} 超过引擎安全上限 ${ENGINE_SEED_MAX}`);
  return seed;
}

/** 验证池硬拒绝：任何候选/窗口/种子都不得落入正式验证池。 */
export function assertNotValidationSeed(seed, name = 'seed') {
  if (seed >= VALIDATION_POOL_BLOCK[0] && seed < VALIDATION_POOL_BLOCK[1]) {
    throw new Error(`${name} ${seed} 落入正式验证池 [${VALIDATION_POOL_BLOCK[0]}, ${VALIDATION_POOL_BLOCK[1]})——AI7 禁止消费正式验证池`);
  }
  return seed;
}

/** 开发窗口校验：窗口完整落在指定块内，且不触碰验证池。 */
export function assertWindow({ base, count, block, name = 'window' }) {
  assertCondition(Number.isSafeInteger(base) && Number.isSafeInteger(count) && count > 0,
    `${name} 非法：base=${String(base)}, count=${String(count)}`);
  assertCondition(base >= block[0] && base + count <= block[1],
    `${name} [${base}, ${base + count}) 越界：必须在 ${block[0]}..${block[1]}`);
  assertNotValidationSeed(base, `${name} 起点`);
  assertNotValidationSeed(base + count - 1, `${name} 终点`);
  return { base, count };
}

/** 断言两个区间不重叠（左右闭开）。 */
export function assertDisjoint(a, b, name = 'blocks') {
  const overlap = a[0] < b[1] && b[0] < a[1];
  assertCondition(!overlap, `${name} 重叠：[${a.join(',')}) 与 [${b.join(',')})`);
  return true;
}

/** AI7 开发块与既有区块的静态隔离自检（模块加载时执行一次）。 */
assertDisjoint(AI7_DEV_BLOCKS.screen, AI7_DEV_BLOCKS.deep, 'AI7 screen/deep');
assertDisjoint(AI7_DEV_BLOCKS.screen, VALIDATION_POOL_BLOCK, 'AI7 screen/validation');
assertDisjoint(AI7_DEV_BLOCKS.deep, VALIDATION_POOL_BLOCK, 'AI7 deep/validation');
assertDisjoint(AI7_DEV_BLOCKS.screen, AI6_SCENARIO_BLOCK, 'AI7 screen/AI6 scenario');
assertDisjoint(AI7_DEV_BLOCKS.deep, AI6_SCENARIO_BLOCK, 'AI7 deep/AI6 scenario');

/** 规则版本描述（artifact 固化字段；engineBundleSha256 是运行指纹，不是规则版本）。 */
export function gameRulesDescriptor() {
  return Object.freeze({
    version: GAME_RULES_VERSION,
    engineBundleSha256: engineBundleSha256(),
  });
}

/** 确定性窗口 id：只依赖区块名、序号与用途，不含墙钟/随机源。 */
export function windowId(purpose, index) {
  assertCondition(purpose === 'screen' || purpose === 'deep', `窗口用途非法：${String(purpose)}`);
  return `ai7-${purpose}-w${String(index).padStart(3, '0')}`;
}

/** 简单种子化随机源（候选生成只依赖种子与轮次，保证同输入同输出）。 */
export function seededRng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** 对象只允许出现在白名单中的键（用于隐藏信息检查；递归一层）。 */
export function assertAllowedKeys(object, allowed, forbidden, name) {
  assertCondition(object && typeof object === 'object', `${name} 必须为对象`);
  for (const key of Object.keys(object)) {
    if (forbidden.includes(key)) throw new Error(`${name} 包含禁止字段 ${key}（隐藏信息/越权访问）`);
    if (!allowed.includes(key)) throw new Error(`${name} 包含未声明字段 ${key}（输入白名单之外）`);
  }
  return true;
}

export const HIDDEN_INFO_KEYS = Object.freeze([
  'merchantDeck', 'golemDeck', 'deck', 'hidden', 'futureDeck', 'deckOrder',
  'unseenOrder', 'seed', 'random', 'rng',
]);

export const FORBIDDEN_CONSTRUCTS = Object.freeze([
  { re: /\bimport\b/, why: '禁止 import' },
  { re: /\brequire\s*\(/, why: '禁止 require' },
  { re: /\beval\s*\(/, why: '禁止 eval' },
  { re: /\bnew\s+Function\b|\bFunction\s*\(/, why: '禁止动态构造函数' },
  { re: /\bprocess\b|\bglobalThis\b/, why: '禁止进程/全局逃逸' },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, why: '禁止网络访问' },
  { re: /\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\bMath\.random\b/, why: '禁止时钟/随机源' },
  { re: /\bmerchantDeck\b|\bgolemDeck\b|\.deck\b/, why: '禁止隐藏牌库' },
  { re: /\bwriteFileSync\b|\breadFileSync\b|\bnode:fs\b|\bnode:net\b|\bnode:child_process\b|\bnode:os\b/, why: '禁止文件/网络/进程模块' },
]);

/** 扫描文本中的禁止构造（用于候选源码/声明模块的静态安全检查）。 */
export function scanForbiddenConstructs(text) {
  const hits = [];
  for (const { re, why } of FORBIDDEN_CONSTRUCTS) {
    const match = text.match(re);
    if (match) hits.push({ why, token: match[0] });
  }
  return hits;
}
