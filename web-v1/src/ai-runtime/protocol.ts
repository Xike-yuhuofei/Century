/** AI Worker 决策协议（夜间任务 C：离线高算力 AI Worker 运行时）。
 *
 * 设计目标：允许未来 Century JS6 AI 在网页游戏中使用 500ms/1000ms 乃至更长的
 * 决策时间而不阻塞游戏主线程；高计算量允许，界面失去响应、提交过期行动、
 * 违反信息公平性不允许。
 *
 * 协议版本：PROTOCOL_VERSION 遵循 semver 语义（主版本不兼容才递增）。
 * 双端（client / worker）握手时校验主版本一致，不一致立即失败——禁止静默混用。
 *
 * 信息公平性（不可妥协，运行时强制）：
 * - 决策请求只允许携带 AIObservation 公开观察（白名单字段，见 OBSERVATION_KEYS）；
 *   worker 端对请求载荷做结构防火墙校验，任何多带字段的请求（例如整份 Game，
 *   携带 merchantDeck/golemDeck 隐藏牌序）直接拒绝并回报错误。
 * - 隐藏牌库数据在结构上不进入 worker：client 端 buildObservation 不可能产出
 *   隐藏字段；worker 端白名单校验拒绝越权载荷（双层防线）。
 *
 * 消息方向：
 * - client → worker：init / decision / cancel / reset
 * - worker → client：ready / decision / cancelled / error
 */

import type { AIObservation } from '../ai/observation.js';
import type { Action } from '../engine.js';

/** 协议版本。破坏性变更递增主版本号；握手校验主版本一致。
 * 1.1.0（P1-1 整改）：递归 schema 校验（players/market/payload 严格字段约束）、
 * 数值与资源范围校验、非法版本描述符/预算参数拒绝。 */
export const PROTOCOL_VERSION = '1.1.0';

/** 协议主版本号（握手比较用）。 */
export const PROTOCOL_MAJOR_VERSION = PROTOCOL_VERSION.split('.')[0];

/** AIObservation 的合法字段白名单。worker 端据此拒绝携带隐藏数据的载荷。 */
export const OBSERVATION_KEYS = [
  'playerId', 'players', 'current', 'merchantMarket', 'golemMarket',
  'copper', 'silver', 'phase', 'triggerPlayer', 'turnNumber',
] as const;

/** 明确禁止出现在请求载荷观察中的字段（隐藏牌库与规则引擎内部态）。 */
export const FORBIDDEN_KEYS = [
  'merchantDeck', 'golemDeck', 'log', 'version',
] as const;

/** 决策预算模式：
 * - fixed-work：固定联合模拟工作量（workUnits 条轨迹），逐位可复现；
 * - wall-clock：墙钟毫秒预算，跨机器不要求逐位一致（报告延迟分布）。 */
export type DecisionBudget =
  | { mode: 'fixed-work'; workUnits: number }
  | { mode: 'wall-clock'; budgetMs: number };

/** AI 版本描述符：worker 据此在联合规划版本注册表中分派决策核心。 */
export type AIVersionDescriptor = {
  /** 联合规划版本 id（如 'joint-js5'）。 */
  jointVersion: string;
  /** 决策者人格（缺省 NEUTRAL_PROFILE）。 */
  profileName?: string;
};

/** 单条决策请求的完整载荷（client → worker）。 */
export type DecisionRequestPayload = {
  /** 公开观察（唯一合法决策输入）。 */
  observation: AIObservation;
  /** AI 版本描述符。 */
  ai: AIVersionDescriptor;
  /** 决策预算。 */
  budget: DecisionBudget;
  /** 独立模拟随机流基础种子（信念采样 + 对手采样；与正式游戏 RNG 无关）。 */
  simSeed: number;
  /** 单条轨迹最大转移步数（可选；缺省搜索内部口径）。 */
  horizon?: number;
  /** 信念世界数（可选；缺省搜索内部口径）。 */
  worlds?: number;
};

/** client → worker 消息。 */
export type AIWorkerRequest =
  | { kind: 'init'; protocolVersion: string }
  | {
      kind: 'decision';
      protocolVersion: string;
      requestId: string;
      /** 决策所基于的游戏状态版本（对局单调递增或换局重置）。 */
      gameStateVersion: number;
      payload: DecisionRequestPayload;
    }
  | { kind: 'cancel'; protocolVersion: string; requestId: string }
  | { kind: 'reset'; protocolVersion: string };

/** 决策统计（JointDecisionStats 的协议投影；搜索内部字段透传）。 */
export type DecisionStats = {
  rollouts: number;
  transitions: number;
  elapsedMs: number;
  budgetExhausted: boolean;
  rootActions: number;
  candidateCount: number;
  worldsUsed: number;
  omTimeMs: number;
  cloneMs: number;
  legalGenMs: number;
};

/** 根行动评价摘要（诊断用，按均值降序截断）。 */
export type EvaluationSummary = {
  action: Action;
  prior: number;
  trials: number;
  mean: number;
};

/** 决策诊断信息（worker → client；不包含任何隐藏信息——不存在）。 */
export type DecisionDiagnostics = {
  protocolVersion: string;
  requestId: string;
  gameStateVersion: number;
  ai: AIVersionDescriptor;
  budget: DecisionBudget;
  simSeed: number;
  /** 决策核心侧耗时（worker 内 performance.now 口径）。 */
  elapsedMs: number;
  reason: string;
  action: Action;
  stats: DecisionStats;
  /** 竞争门控是否触发（champion-guided 专有；其他版本缺省 false）。 */
  gated: boolean;
  /** 前 K 根行动评价摘要（按 mean 降序）。 */
  topEvaluations: EvaluationSummary[];
};

/** worker → client 消息。 */
export type AIWorkerResponse =
  | { kind: 'ready'; protocolVersion: string }
  | {
      kind: 'decision';
      protocolVersion: string;
      requestId: string;
      gameStateVersion: number;
      diagnostics: DecisionDiagnostics;
    }
  | {
      kind: 'cancelled';
      protocolVersion: string;
      /** 被取消的 requestId。 */
      requestId: string;
    }
  | {
      kind: 'error';
      protocolVersion: string;
      /** 关联的 requestId；init 阶段错误为 null。 */
      requestId: string | null;
      message: string;
      /** 错误分类：protocol（协议/载荷非法）、decision（决策核心异常）、fatal（worker 不可继续）。 */
      category: 'protocol' | 'decision' | 'fatal';
    };

/** 协议主版本一致性校验（双端握手共用）。 */
export function isCompatibleProtocolVersion(version: string): boolean {
  return typeof version === 'string' && version.split('.')[0] === PROTOCOL_MAJOR_VERSION;
}

// ==================== P1-1 递归 schema 校验 ====================
// v1.0 只检查观察对象顶层字段——嵌套结构（players[i] / merchantMarket[i]）里
// 夹带的隐藏牌库字段（例如 players 元素内层对象的 merchantDeck 字段）可以穿透防火墙
// 全部层级执行：白名单字段约束 + 禁止字段递归扫描 + 数值/资源范围校验。

/** ObservationPlayer 的合法字段白名单（与 buildObservation 产出逐字段一致）。
 * 注意：hand 是规则允许的公开/决策者可知信息（buildObservation 显式复制），
 * 不是隐藏信息——校验绝不得把合法手牌误判为隐藏字段。 */
export const OBSERVATION_PLAYER_KEYS = [
  'id', 'name', 'isAI', 'stock', 'hand', 'played', 'claimed', 'copper', 'silver', 'turns',
] as const;

/** MarketMerchant 的合法字段白名单。 */
export const MARKET_MERCHANT_KEYS = ['id', 'bonus'] as const;

/** 结构上限（防病态载荷：超大数组/超界数值消耗 Worker 算力）。
 * 上限取引擎合法规模的宽松上界（魔像市场 5 张、商人市场 6 张、 claimed 随对局
 * 增长），仅拦截病态超大载荷，不限制任何合法对局状态。 */
export const PAYLOAD_LIMITS = Object.freeze({
  maxPlayers: 5,
  maxMarketMerchants: 6,
  maxGolemMarket: 6,
  maxClaimedGolems: 12,
  maxCardListLength: 64,
  maxStockLength: 4,
  maxTurnNumber: 1_000_000,
  maxResourceValue: 999,
  maxNameLength: 32,
  maxIdLength: 16,
  maxWorkUnits: 1_000_000,
  maxBudgetMs: 60_000,
  maxHorizon: 4096,
  maxWorlds: 64,
  maxSimSeed: 2 ** 31 - 1,
});

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInt(value: unknown, path: string, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`协议防火墙：${path} 必须为 [${min}, ${max}] 内的安全整数，实际：${JSON.stringify(value)}`);
  }
}

function assertStringId(value: unknown, path: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`协议防火墙：${path} 必须为 ≤${maxLength} 字符的字母数字 id，实际：${JSON.stringify(value)}`);
  }
}

/** 递归禁止字段扫描：任意层级出现 merchantDeck/golemDeck/log/version 即拒绝。 */
function assertNoForbiddenKeysDeep(value: unknown, path: string, depth = 0): void {
  if (depth > 8) return; // 深度上限（合法观察最多 4 层）
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoForbiddenKeysDeep(value[i], `${path}[${i}]`, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
        throw new Error(`协议防火墙：${path}.${key} 携带禁止字段（隐藏牌库/引擎内部态不得以任何嵌套层级进入 Worker）`);
      }
      assertNoForbiddenKeysDeep(value[key], `${path}.${key}`, depth + 1);
    }
  }
}

/** 水晶库存（引擎 Stock = 按颜色的 4 位计数数组 [黄,绿,蓝,粉]）。 */
function assertStockArray(value: unknown, path: string, maxLength: number): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxLength) {
    throw new Error(`协议防火墙：${path} 必须为长度 ≤${maxLength} 的计数数组`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'number' || !Number.isSafeInteger(value[i]) || value[i] < 0 || value[i] > PAYLOAD_LIMITS.maxResourceValue) {
      throw new Error(`协议防火墙：${path}[${i}] 必须为 [0, ${PAYLOAD_LIMITS.maxResourceValue}] 内的非负整数计数，实际：${JSON.stringify(value[i])}`);
    }
  }
}

function assertCardIdArray(value: unknown, path: string, maxLength: number): void {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error(`协议防火墙：${path} 必须为长度 ≤${maxLength} 的数组`);
  }
  for (let i = 0; i < value.length; i++) {
    assertStringId(value[i], `${path}[${i}]`, PAYLOAD_LIMITS.maxIdLength);
  }
}

function validateObservationPlayer(player: unknown, index: number): void {
  const path = `players[${index}]`;
  if (!isPlainObject(player)) throw new Error(`协议防火墙：${path} 必须为对象`);
  for (const key of Object.keys(player)) {
    if (!(OBSERVATION_PLAYER_KEYS as readonly string[]).includes(key)) {
      throw new Error(`协议防火墙：${path} 携带白名单之外的字段 '${key}'`);
    }
  }
  assertInt(player.id, `${path}.id`, 0, PAYLOAD_LIMITS.maxPlayers - 1);
  if (player.name !== undefined) {
    if (typeof player.name !== 'string' || player.name.length > PAYLOAD_LIMITS.maxNameLength) {
      throw new Error(`协议防火墙：${path}.name 必须为 ≤${PAYLOAD_LIMITS.maxNameLength} 字符的字符串`);
    }
  }
  if (player.isAI !== undefined && typeof player.isAI !== 'boolean') {
    throw new Error(`协议防火墙：${path}.isAI 必须为布尔值`);
  }
  assertStockArray(player.stock, `${path}.stock`, PAYLOAD_LIMITS.maxStockLength);
  // hand/played/claimed：规则允许的公开或决策者可知卡牌信息（合法字段）。
  assertCardIdArray(player.hand, `${path}.hand`, PAYLOAD_LIMITS.maxCardListLength);
  assertCardIdArray(player.played, `${path}.played`, PAYLOAD_LIMITS.maxCardListLength);
  assertCardIdArray(player.claimed, `${path}.claimed`, PAYLOAD_LIMITS.maxClaimedGolems);
  assertInt(player.copper, `${path}.copper`, 0, PAYLOAD_LIMITS.maxResourceValue);
  assertInt(player.silver, `${path}.silver`, 0, PAYLOAD_LIMITS.maxResourceValue);
  assertInt(player.turns, `${path}.turns`, 0, PAYLOAD_LIMITS.maxTurnNumber);
}

function validateMarketMerchant(merchant: unknown, index: number): void {
  const path = `merchantMarket[${index}]`;
  if (!isPlainObject(merchant)) throw new Error(`协议防火墙：${path} 必须为对象`);
  for (const key of Object.keys(merchant)) {
    if (!(MARKET_MERCHANT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`协议防火墙：${path} 携带白名单之外的字段 '${key}'`);
    }
  }
  assertStringId(merchant.id, `${path}.id`, PAYLOAD_LIMITS.maxIdLength);
  assertStockArray(merchant.bonus, `${path}.bonus`, 4);
}

/** 请求载荷结构防火墙：观察必须是白名单字段且不含禁止字段，且嵌套结构
 * （players/market）逐层通过严格 schema 校验。
 * 该校验是"隐藏牌库数据不作为 Worker 决策输入"的运行时强制层：
 * 即使调用方误传整份 Game（含 merchantDeck/golemDeck），也会在此被拒绝。 */
export function validateObservationShape(observation: unknown): asserts observation is AIObservation {
  if (!isPlainObject(observation)) {
    throw new Error('协议防火墙：观察载荷必须是对象');
  }
  // 顶层禁止字段 + 白名单（含递归扫描兜底——任意嵌套层级的禁止字段）。
  for (const key of Object.keys(observation)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      throw new Error(`协议防火墙：观察载荷携带禁止字段 '${key}'（隐藏牌库/引擎内部态不得进入 Worker）`);
    }
    if (!(OBSERVATION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`协议防火墙：观察载荷携带白名单之外的字段 '${key}'`);
    }
  }
  for (const key of OBSERVATION_KEYS) {
    if (!(key in observation)) {
      throw new Error(`协议防火墙：观察载荷缺少必需字段 '${key}'`);
    }
  }
  assertNoForbiddenKeysDeep(observation, 'observation');
  // 严格字段约束（类型 + 范围）。
  assertInt(observation.playerId, 'observation.playerId', 0, PAYLOAD_LIMITS.maxPlayers - 1);
  assertInt(observation.current, 'observation.current', 0, PAYLOAD_LIMITS.maxPlayers - 1);
  if (!Array.isArray(observation.players) || observation.players.length < 2 || observation.players.length > PAYLOAD_LIMITS.maxPlayers) {
    throw new Error(`协议防火墙：observation.players 必须为 2..${PAYLOAD_LIMITS.maxPlayers} 人数组`);
  }
  const seenIds = new Set<number>();
  for (let i = 0; i < observation.players.length; i++) {
    validateObservationPlayer(observation.players[i], i);
    const id = (observation.players[i] as Rec).id;
    if (seenIds.has(id as number)) throw new Error(`协议防火墙：players[${i}].id 重复（${id}）`);
    seenIds.add(id as number);
  }
  if (!Array.isArray(observation.merchantMarket) || observation.merchantMarket.length > PAYLOAD_LIMITS.maxMarketMerchants) {
    throw new Error(`协议防火墙：observation.merchantMarket 必须为长度 ≤${PAYLOAD_LIMITS.maxMarketMerchants} 的数组`);
  }
  for (let i = 0; i < observation.merchantMarket.length; i++) validateMarketMerchant(observation.merchantMarket[i], i);
  assertCardIdArray(observation.golemMarket, 'observation.golemMarket', PAYLOAD_LIMITS.maxGolemMarket);
  assertInt(observation.copper, 'observation.copper', 0, PAYLOAD_LIMITS.maxResourceValue);
  assertInt(observation.silver, 'observation.silver', 0, PAYLOAD_LIMITS.maxResourceValue);
  if (observation.phase !== 'turn' && observation.phase !== 'overflow' && observation.phase !== 'finished') {
    throw new Error(`协议防火墙：observation.phase 非法：${JSON.stringify(observation.phase)}`);
  }
  if (observation.triggerPlayer !== null) {
    assertInt(observation.triggerPlayer, 'observation.triggerPlayer', 0, PAYLOAD_LIMITS.maxPlayers - 1);
  }
  assertInt(observation.turnNumber, 'observation.turnNumber', 0, PAYLOAD_LIMITS.maxTurnNumber);
}

/** AI 版本描述符校验（非法版本描述符拒绝）。 */
export function validateAIVersionDescriptor(ai: unknown): asserts ai is AIVersionDescriptor {
  if (!isPlainObject(ai)) throw new Error('协议防火墙：ai 版本描述符必须是对象');
  for (const key of Object.keys(ai)) {
    if (!['jointVersion', 'profileName'].includes(key)) {
      throw new Error(`协议防火墙：ai 描述符携带白名单之外的字段 '${key}'`);
    }
  }
  if (typeof ai.jointVersion !== 'string' || !/^joint-js[0-9a-z-]{1,16}$/.test(ai.jointVersion)) {
    throw new Error(`协议防火墙：ai.jointVersion 非法版本描述符：${JSON.stringify(ai.jointVersion)}`);
  }
  if (ai.profileName !== undefined && (typeof ai.profileName !== 'string' || ai.profileName.length > PAYLOAD_LIMITS.maxNameLength)) {
    throw new Error(`协议防火墙：ai.profileName 必须为 ≤${PAYLOAD_LIMITS.maxNameLength} 字符的字符串`);
  }
}

/** 决策预算校验（非法预算参数拒绝）。 */
export function validateDecisionBudget(budget: unknown): asserts budget is DecisionBudget {
  if (!isPlainObject(budget)) throw new Error('协议防火墙：budget 必须为对象');
  if (budget.mode === 'fixed-work') {
    for (const key of Object.keys(budget)) {
      if (key !== 'mode' && key !== 'workUnits') throw new Error(`协议防火墙：budget 携带白名单之外的字段 '${key}'`);
    }
    assertInt(budget.workUnits, 'budget.workUnits', 1, PAYLOAD_LIMITS.maxWorkUnits);
    return;
  }
  if (budget.mode === 'wall-clock') {
    for (const key of Object.keys(budget)) {
      if (key !== 'mode' && key !== 'budgetMs') throw new Error(`协议防火墙：budget 携带白名单之外的字段 '${key}'`);
    }
    assertInt(budget.budgetMs, 'budget.budgetMs', 1, PAYLOAD_LIMITS.maxBudgetMs);
    return;
  }
  throw new Error(`协议防火墙：budget.mode 非法：${JSON.stringify((budget as Rec).mode)}`);
}

/** 完整决策载荷校验（worker 端 decision 消息的统一入口）：
 * 载荷白名单 + 观察/版本描述符/预算/种子的严格校验。 */
export function validateDecisionPayload(payload: unknown): asserts payload is DecisionRequestPayload {
  if (!isPlainObject(payload)) throw new Error('协议防火墙：决策载荷必须是对象');
  const allowed = ['observation', 'ai', 'budget', 'simSeed', 'horizon', 'worlds'];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new Error(`协议防火墙：决策载荷携带白名单之外的字段 '${key}'`);
    }
  }
  for (const key of ['observation', 'ai', 'budget', 'simSeed']) {
    if (!(key in payload)) throw new Error(`协议防火墙：决策载荷缺少必需字段 '${key}'`);
  }
  assertNoForbiddenKeysDeep(payload, 'payload');
  validateObservationShape(payload.observation);
  validateAIVersionDescriptor(payload.ai);
  validateDecisionBudget(payload.budget);
  assertInt(payload.simSeed, 'payload.simSeed', 0, PAYLOAD_LIMITS.maxSimSeed);
  if (payload.horizon !== undefined) assertInt(payload.horizon, 'payload.horizon', 1, PAYLOAD_LIMITS.maxHorizon);
  if (payload.worlds !== undefined) assertInt(payload.worlds, 'payload.worlds', 1, PAYLOAD_LIMITS.maxWorlds);
}
