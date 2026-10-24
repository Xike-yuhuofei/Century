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

/** 协议版本。破坏性变更递增主版本号；握手校验主版本一致。 */
export const PROTOCOL_VERSION = '1.0.0';

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

/** 请求载荷结构防火墙：观察必须是白名单字段且不含禁止字段。
 * 该校验是"隐藏牌库数据不作为 Worker 决策输入"的运行时强制层：
 * 即使调用方误传整份 Game（含 merchantDeck/golemDeck），也会在此被拒绝。 */
export function validateObservationShape(observation: unknown): asserts observation is AIObservation {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new Error('协议防火墙：观察载荷必须是对象');
  }
  const record = observation as Record<string, unknown>;
  for (const key of FORBIDDEN_KEYS) {
    if (key in record) {
      throw new Error(`协议防火墙：观察载荷携带禁止字段 '${key}'（隐藏牌库/引擎内部态不得进入 Worker）`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!(OBSERVATION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`协议防火墙：观察载荷携带白名单之外的字段 '${key}'`);
    }
  }
  for (const key of OBSERVATION_KEYS) {
    if (!(key in record)) {
      throw new Error(`协议防火墙：观察载荷缺少必需字段 '${key}'`);
    }
  }
}
