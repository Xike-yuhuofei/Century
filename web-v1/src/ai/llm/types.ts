/** LLM 玩家共享类型（浏览器与 Node 实验运行器共用）。
 *
 * 信息边界：本目录只消费 AIObservation（buildObservation 产物）与公开卡表；
 * 完整 Game 仅用于入口处的正式引擎合法性复核与离线回退，绝不进入提示词。
 */

import type { Action } from '../../engine.js';
import type { AIObservation } from '../observation.js';

export type LLMProviderKind = 'openai-compatible' | 'mock' | 'codex-cli';

export type LLMProviderInfo = {
  readonly id: string;
  readonly kind: LLMProviderKind;
  readonly model: string;
  /** 仅主机名，绝不包含路径、查询串或密钥。 */
  readonly endpointHost: string | null;
  /** real=真实大模型；mock=确定性测试替身（不得对外宣称真实成绩）。 */
  readonly mode: 'real' | 'mock';
  readonly parameters: Readonly<Record<string, unknown>>;
};

export type LLMChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type LLMCompletionRequest = {
  messages: readonly LLMChatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 仅 Mock Provider 使用；真实 Provider 忽略。 */
  metadata?: {
    candidateIds: readonly string[];
    phase: AIObservation['phase'];
    turnNumber: number;
    observationHash: string;
  };
};

export type LLMUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LLMCompletion = {
  text: string;
  effectiveModel: string;
  providerRequestId: string | null;
  finishReason: string | null;
  usage: LLMUsage | null;
  latencyMs: number;
};

export interface LLMProvider {
  info(): LLMProviderInfo;
  complete(request: LLMCompletionRequest): Promise<LLMCompletion>;
}

export type LLMActionKind = 'claim' | 'play-create' | 'play-upgrade' | 'play-trade' | 'acquire' | 'rest' | 'discard';

export type LLMActionCandidate = {
  /** 短、稳定、同公开局面可复现的行动 ID。 */
  id: string;
  action: Action;
  kind: LLMActionKind;
  /** 面向 LLM 的中文单行说明（只含公开信息）。 */
  summary: string;
};

export type LLMCandidateSet = {
  version: 'llm-candidates-v1';
  observationHash: string;
  candidates: LLMActionCandidate[];
  /** 合法行动全量数量（enumerateLegalActions dedupe=true）。 */
  fullLegalCount: number;
  keptCount: number;
  pruned: boolean;
  fullCounts: Readonly<Record<LLMActionKind, number>>;
  keptCounts: Readonly<Record<LLMActionKind, number>>;
  /** 获取支付的压缩口径：保留引擎要求的完整有序序列；超限时确定性抽样。 */
  paymentOrderPolicy: 'ordered-preserved-pruned-deterministic';
  notes: readonly string[];
};

export type LLMAlternative = {
  actionId: string;
  comparison: string;
};

/** LLM 结构化响应（严格 Schema，不含隐藏思维链）。 */
export type LLMDecisionPayload = {
  selectedActionId: string;
  reason: string;
  primaryGoal: string;
  alternativeActions: LLMAlternative[];
  expectedBenefits: string[];
  risks: string[];
  strategyTags: string[];
};

export type LLMSchemaValidation = {
  ok: boolean;
  value: LLMDecisionPayload | null;
  errors: string[];
  warnings: string[];
};

export type LLMAttemptRecord = {
  attempt: number;
  latencyMs: number;
  effectiveModel: string | null;
  providerRequestId: string | null;
  finishReason: string | null;
  usage: LLMUsage | null;
  rawText: string | null;
  error: string | null;
  parse: 'ok' | 'invalid-json' | 'schema-invalid' | 'request-failed';
};

export type LLMChampionShadow = {
  action: Action;
  actionKey: string;
  reason: string;
  latencyMs: number;
  agreement: boolean;
};

export type LLMFallbackCause =
  | 'timeout'
  | 'api-error'
  | 'invalid-json'
  | 'schema-invalid'
  | 'illegal-action'
  | 'call-limit'
  | 'token-budget'
  | 'no-candidates'
  | 'provider-unavailable';

export type LLMTurnContext = {
  gameId: string;
  seed: number | null;
  seatCount: number;
  focusSeat: number;
  experimentId: string;
  /** 数据来源：experiment=真实实验；ui=网页；test=CI。 */
  channel: 'experiment' | 'ui' | 'test';
};

export type LLMTurnRecord = {
  schema: 'century-llm-turn-v1';
  decisionId: string;
  gameId: string;
  seed: number | null;
  seatCount: number;
  focusSeat: number;
  experimentId: string;
  channel: 'experiment' | 'ui' | 'test';
  seat: number;
  turnNumber: number;
  round: number;
  playerTurn: number;
  phase: AIObservation['phase'];
  observation: AIObservation;
  observationHash: string;
  candidateSet: LLMCandidateSet;
  provider: LLMProviderInfo;
  effectiveModel: string | null;
  generationConfig: {
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    maxRetries: number;
    candidateLimit: number;
  };
  prompt: { system: string; user: string; promptHash: string; estimatedPromptTokens: number };
  attempts: LLMAttemptRecord[];
  parsed: LLMDecisionPayload | null;
  selectedActionId: string | null;
  /** 模型建议行动（解析成功且 ID 合法时存在）。 */
  proposedAction: Action | null;
  /** 最终交给正式引擎的行动（可能等于 proposedAction，也可能是回退）。 */
  executedAction: Action;
  source: 'llm' | 'fallback';
  fallbackCause: LLMFallbackCause | null;
  fallbackReason: string | null;
  engineValidation: 'accepted' | 'fallback-accepted' | 'failed';
  championShadow: LLMChampionShadow | null;
  usage: LLMUsage;
  totalLatencyMs: number;
  /** 原始 API 失败/回退的真实标记，绝不伪装为成功。 */
  apiFailure: boolean;
  createdAt: string;
};

export type LLMPlayerDecision = {
  action: Action;
  source: 'llm' | 'fallback';
  reason: string;
  record: LLMTurnRecord;
};

export type LLMPlayerConfig = {
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  temperature: number;
  maxCalls: number;
  tokenBudget: number;
  candidateLimit: number;
  shadowChampion: boolean;
};

export const DEFAULT_LLM_CONFIG: LLMPlayerConfig = Object.freeze({
  timeoutMs: 45_000,
  maxRetries: 2,
  maxTokens: 700,
  temperature: 0,
  maxCalls: 200,
  tokenBudget: 2_000_000,
  candidateLimit: 64,
  shadowChampion: false,
});
