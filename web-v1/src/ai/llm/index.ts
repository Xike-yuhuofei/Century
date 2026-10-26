/** LLM 玩家共享出口（浏览器与 Node 实验运行器共用）。 */

export {
  buildCandidateSet, candidateById, emptyCandidateSet, actionKey, sameAction,
  observationHash, fnv1a, stableStringify, containsAction,
} from './candidates.js';
export { buildLLMPrompt, summarizeAction, type BuiltPrompt, type PromptHistoryEntry } from './prompt.js';
export { extractJsonObject, validateLLMResponse } from './schema.js';
export { createMockProvider, type MockProviderOptions, type MockFailureMode } from './mock.js';
export { createOpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai-compatible.js';
export { LLMPlayer, createLLMPlayer, verifyEngineAction, type LLMPlayerOptions, type LLMPlayerStats } from './player.js';
export type {
  LLMProvider, LLMProviderInfo, LLMProviderKind, LLMCompletion, LLMCompletionRequest,
  LLMUsage, LLMActionCandidate, LLMActionKind, LLMCandidateSet, LLMDecisionPayload,
  LLMAlternative, LLMSchemaValidation, LLMAttemptRecord, LLMChampionShadow,
  LLMFallbackCause, LLMTurnContext, LLMTurnRecord, LLMPlayerDecision, LLMPlayerConfig,
} from './types.js';
export { DEFAULT_LLM_CONFIG } from './types.js';
