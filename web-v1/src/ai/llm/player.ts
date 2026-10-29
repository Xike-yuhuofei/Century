/** LLM 玩家决策适配层：公开观察 → 候选 → Provider → Schema 校验 → 正式引擎复核 → 回退。
 *
 * 关键纪律：
 * - Provider 只看到公开观察与合法候选；完整 Game 不进入提示词；
 * - 模型建议必须落在候选集内，并由 `applyAction` 在深拷贝上复核；
 * - 任何超时/解析失败/接口失败/非法建议都记录真实原因并回退到离线冠军，
 *   绝不把回退伪装成 LLM 成功；
 * - 只保存可复盘的结构化字段，不保存或推断模型隐藏思维链。
 */

import { applyAction, type Action, type Game } from '../../engine.js';
import { chooseAIAction } from '../decision.js';
import type { AIParameters } from '../parameters.js';
import { buildObservation, type AIObservation } from '../observation.js';
import {
  actionKey, buildCandidateSet, candidateById, emptyCandidateSet,
  fnv1a, observationHash, sameAction,
} from './candidates.js';
import { buildLLMPrompt, summarizeAction, type PromptHistoryEntry } from './prompt.js';
import { validateLLMResponse } from './schema.js';
import {
  DEFAULT_LLM_CONFIG, type LLMActionCandidate, type LLMAttemptRecord, type LLMChampionShadow,
  type LLMCompletion, type LLMDecisionPayload, type LLMFallbackCause, type LLMPlayerConfig,
  type LLMPlayerDecision, type LLMProvider, type LLMTurnContext, type LLMTurnRecord,
} from './types.js';

export type LLMPlayerOptions = {
  provider: LLMProvider;
  config?: Partial<LLMPlayerConfig>;
  /** 冠军影子决策参数；缺省使用当前激活冠军。 */
  championParameters?: AIParameters | string;
  /** 数据记录回调（实验运行器写入 JSONL；UI 写入内存）。 */
  record?: (record: LLMTurnRecord) => void;
};

export type LLMPlayerStats = {
  calls: number;
  tokens: number;
  decisions: number;
  fallbacks: number;
  lastError: string | null;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const cloneGame = (game: Game): Game => JSON.parse(JSON.stringify(game)) as Game;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 400);
}

function normalizeConfig(input?: Partial<LLMPlayerConfig>): LLMPlayerConfig {
  const config = { ...DEFAULT_LLM_CONFIG, ...(input ?? {}) };
  const numericKeys = [
    'timeoutMs', 'maxRetries', 'maxTokens', 'temperature',
    'maxCalls', 'tokenBudget', 'candidateLimit',
  ] as const;
  for (const key of numericKeys) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`LLM 配置 ${key} 必须是非负有限数，实际：${String(value)}`);
    }
  }
  if (typeof config.shadowChampion !== 'boolean') {
    throw new Error(`LLM 配置 shadowChampion 必须是布尔值，实际：${String(config.shadowChampion)}`);
  }
  if (config.timeoutMs <= 0) throw new Error('LLM timeoutMs 必须大于 0');
  if (config.maxTokens <= 0) throw new Error('LLM maxTokens 必须大于 0');
  if (config.maxCalls <= 0) throw new Error('LLM maxCalls 必须大于 0');
  if (config.tokenBudget <= 0) throw new Error('LLM tokenBudget 必须大于 0');
  config.candidateLimit = Math.max(8, Math.floor(config.candidateLimit));
  return config;
}

function estimateCompletionTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / 2);
}

/** 在深拷贝上验证行动是否被正式引擎接受。 */
export function verifyEngineAction(game: Game, action: Action): { ok: boolean; error: string | null } {
  try {
    applyAction(cloneGame(game), action);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export class LLMPlayer {
  private readonly provider: LLMProvider;
  private readonly config: LLMPlayerConfig;
  private readonly championParameters?: AIParameters | string;
  private readonly recordSink?: (record: LLMTurnRecord) => void;
  private history = new Map<number, PromptHistoryEntry[]>();
  private calls = 0;
  private tokens = 0;
  private decisions = 0;
  private fallbacks = 0;
  private lastError: string | null = null;

  constructor(options: LLMPlayerOptions) {
    this.provider = options.provider;
    this.config = normalizeConfig(options.config);
    this.championParameters = options.championParameters;
    this.recordSink = options.record;
  }

  reset(): void {
    this.history.clear();
    this.calls = 0;
    this.tokens = 0;
    this.decisions = 0;
    this.fallbacks = 0;
    this.lastError = null;
  }

  /** 中断恢复：重建同一席位的最近决策历史（只含本 AI 自己的公开输出）。 */
  seedHistory(seat: number, entries: readonly PromptHistoryEntry[]): void {
    this.history.set(seat, entries.slice(-8).map(entry => ({ ...entry })));
  }

  /** 中断恢复：把此前已消耗的调用/Token/决策计数带回预算。 */
  restoreUsage(usage: { calls?: number; tokens?: number; decisions?: number; fallbacks?: number }): void {
    this.calls = Math.max(0, Math.floor(usage.calls ?? 0));
    this.tokens = Math.max(0, Math.floor(usage.tokens ?? 0));
    this.decisions = Math.max(0, Math.floor(usage.decisions ?? 0));
    this.fallbacks = Math.max(0, Math.floor(usage.fallbacks ?? 0));
  }

  stats(): LLMPlayerStats {
    return {
      calls: this.calls, tokens: this.tokens, decisions: this.decisions,
      fallbacks: this.fallbacks, lastError: this.lastError,
    };
  }

  async decide(game: Game, context: LLMTurnContext): Promise<LLMPlayerDecision> {
    if (game.phase === 'finished') throw new Error('游戏已结束，LLM 无法行动');
    const seat = game.current;
    if (!game.players[seat]?.isAI) throw new Error(`LLM 席位 ${seat} 不是 AI`);
    const started = Date.now();
    const view = buildObservation(game, seat);
    const obsHash = observationHash(view);
    const history = this.history.get(seat) ?? [];

    let candidateSet = emptyCandidateSet(obsHash);
    let candidates: LLMActionCandidate[] = [];
    let prompt: ReturnType<typeof buildLLMPrompt> | null = null;
    let candidateError: string | null = null;
    try {
      candidateSet = buildCandidateSet(view, { candidateLimit: this.config.candidateLimit });
      candidates = candidateSet.candidates;
      prompt = buildLLMPrompt({ view, candidateSet, history });
    } catch (error) {
      candidateError = errorText(error);
    }

    const attempts: LLMAttemptRecord[] = [];
    let parsed: LLMDecisionPayload | null = null;
    let proposed: LLMActionCandidate | null = null;
    let lastFailure: LLMFallbackCause | null = candidateError ? 'no-candidates' : null;
    let lastFailureReason: string | null = candidateError;

    if (prompt && candidates.length > 0) {
      const estimated = prompt.estimatedPromptTokens + this.config.maxTokens;
      if (this.tokens + estimated > this.config.tokenBudget) {
        lastFailure = 'token-budget';
        lastFailureReason = `Token 预算不足：已用 ${this.tokens}，本次预计 ${estimated}，上限 ${this.config.tokenBudget}`;
      } else {
        const maxAttempts = Math.max(1, Math.floor(this.config.maxRetries) + 1);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (this.calls >= this.config.maxCalls) {
            lastFailure = 'call-limit';
            lastFailureReason = `达到每局调用上限 ${this.config.maxCalls}`;
            break;
          }
          this.calls += 1;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
          const attemptStarted = Date.now();
          let completion: LLMCompletion | null = null;
          try {
            const pending = this.provider.complete({
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
              ],
              maxTokens: this.config.maxTokens,
              temperature: this.config.temperature,
              timeoutMs: this.config.timeoutMs,
              signal: controller.signal,
              metadata: {
                candidateIds: candidates.map(c => c.id),
                phase: view.phase,
                turnNumber: view.turnNumber,
                observationHash: obsHash,
              },
            });
            completion = await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                setTimeout(() => {
                  controller.abort();
                  reject(new Error(`LLM 决策超时（${this.config.timeoutMs}ms）`));
                }, this.config.timeoutMs + 250);
              }),
            ]);
          } catch (error) {
            const text = errorText(error);
            this.lastError = text;
            const timeoutFailure = /abort|超时|timeout/i.test(text);
            lastFailure = timeoutFailure ? 'timeout' : 'api-error';
            lastFailureReason = text;
            attempts.push({
              attempt, latencyMs: Date.now() - attemptStarted,
              effectiveModel: null, providerRequestId: null, finishReason: null,
              usage: null, rawText: null, error: text, parse: 'request-failed',
            });
            if (attempt < maxAttempts) await sleep(Math.min(1000, 250 * attempt));
            continue;
          } finally {
            clearTimeout(timeout);
          }

          const usage = completion.usage ?? {
            promptTokens: prompt.estimatedPromptTokens,
            completionTokens: estimateCompletionTokens(completion.text),
            totalTokens: prompt.estimatedPromptTokens + estimateCompletionTokens(completion.text),
          };
          this.tokens += Math.max(0, usage.totalTokens);
          const baseAttempt: LLMAttemptRecord = {
            attempt,
            latencyMs: completion.latencyMs,
            effectiveModel: completion.effectiveModel,
            providerRequestId: completion.providerRequestId,
            finishReason: completion.finishReason,
            usage,
            rawText: completion.text.slice(0, 20_000),
            error: null,
            parse: 'ok',
          };
          const validation = validateLLMResponse(completion.text, candidates.map(c => c.id));
          if (!validation.ok || !validation.value) {
            const text = validation.errors.join('；');
            this.lastError = text;
            lastFailure = validation.errors.some(x => x.includes('JSON')) ? 'invalid-json' : 'schema-invalid';
            if (lastFailure === 'schema-invalid' && /JSON/.test(text)) lastFailure = 'invalid-json';
            lastFailureReason = text;
            attempts.push({
              ...baseAttempt, parse: lastFailure === 'invalid-json' ? 'invalid-json' : 'schema-invalid',
              error: text,
            });
            if (attempt < maxAttempts) await sleep(Math.min(1000, 250 * attempt));
            continue;
          }
          parsed = validation.value;
          proposed = candidateById(candidateSet, parsed.selectedActionId);
          if (!proposed) {
            lastFailure = 'schema-invalid';
            lastFailureReason = `selectedActionId ${parsed.selectedActionId} 不在候选集`;
            attempts.push({ ...baseAttempt, parse: 'schema-invalid', error: lastFailureReason });
            continue;
          }
          const verification = verifyEngineAction(game, proposed.action);
          if (!verification.ok) {
            lastFailure = 'illegal-action';
            lastFailureReason = verification.error;
            attempts.push({ ...baseAttempt, parse: 'schema-invalid', error: `引擎拒绝：${verification.error}` });
            this.lastError = verification.error;
            break;
          }
          attempts.push(baseAttempt);
          const reason = parsed.reason;
          const record = this.buildRecord({
            game, context, view, obsHash, candidateSet, prompt, attempts,
            parsed, proposedAction: proposed.action, executedAction: proposed.action,
            source: 'llm', fallbackCause: null, fallbackReason: null,
            engineValidation: 'accepted', started, seat,
            championShadow: this.shadow(game, context, proposed.action, view),
          });
          this.commitHistory(seat, view, proposed.action, parsed.primaryGoal, reason);
          this.decisions += 1;
          this.recordSink?.(record);
          return { action: proposed.action, source: 'llm', reason, record };
        }
      }
    } else if (!candidateError) {
      lastFailure = 'no-candidates';
      lastFailureReason = '候选集为空';
    }
    if (prompt && candidates.length === 0 && lastFailure === null) {
      lastFailure = 'no-candidates';
      lastFailureReason = '候选集为空';
    }

    // —— 回退：离线冠军优先，其次首个合法候选 ——
    const fallback = this.fallbackAction(game, candidates);
    const shadow = this.shadow(game, context, fallback.action, view);
    this.fallbacks += 1;
    this.lastError = lastFailureReason ?? 'LLM 不可用';
    const record = this.buildRecord({
      game, context, view, obsHash, candidateSet, prompt, attempts,
      parsed, proposedAction: proposed?.action ?? null, executedAction: fallback.action,
      source: 'fallback', fallbackCause: lastFailure ?? 'provider-unavailable',
      fallbackReason: lastFailureReason ?? '未知失败',
      engineValidation: 'fallback-accepted', started, seat, championShadow: shadow,
    });
    const summary = summarizeAction(view, fallback.action);
    this.commitHistory(seat, view, fallback.action, '离线冠军回退', fallback.reason);
    this.recordSink?.(record);
    return { action: fallback.action, source: 'fallback', reason: `${fallback.reason}（${summary}）`, record };
  }

  private fallbackAction(game: Game, candidates: LLMActionCandidate[]): { action: Action; reason: string } {
    try {
      const decision = chooseAIAction(cloneGame(game), this.championParameters !== undefined
        ? { parameters: this.championParameters }
        : undefined);
      if (verifyEngineAction(game, decision.action).ok) {
        return { action: decision.action, reason: `离线冠军回退：${decision.reason}` };
      }
    } catch { /* 继续尝试候选 */ }
    for (const candidate of candidates) {
      if (verifyEngineAction(game, candidate.action).ok) {
        return { action: candidate.action, reason: '回退：首个公开合法候选' };
      }
    }
    throw new Error('LLM 回退失败：离线冠军与候选均未通过正式引擎校验');
  }

  private shadow(game: Game, context: LLMTurnContext, compared: Action, view: AIObservation): LLMChampionShadow | null {
    if (!this.config.shadowChampion) return null;
    const started = Date.now();
    try {
      const decision = chooseAIAction(cloneGame(game), this.championParameters !== undefined
        ? { parameters: this.championParameters }
        : undefined);
      const shadowView = view;
      return {
        action: decision.action,
        actionKey: actionKey(decision.action),
        reason: `离线冠军影子：${decision.reason}${shadowView.phase === 'overflow' ? '（溢出弃置）' : ''}`.slice(0, 500),
        latencyMs: Date.now() - started,
        agreement: sameAction(decision.action, compared),
      };
    } catch {
      return null;
    }
  }

  private commitHistory(seat: number, view: AIObservation, action: Action, primaryGoal: string, reason: string): void {
    const list = this.history.get(seat) ?? [];
    list.push({
      turnNumber: view.turnNumber,
      actionSummary: summarizeAction(view, action),
      primaryGoal,
      reason: reason.slice(0, 300),
    });
    this.history.set(seat, list.slice(-8));
  }

  private buildRecord(args: {
    game: Game; context: LLMTurnContext; view: AIObservation; obsHash: string;
    candidateSet: ReturnType<typeof emptyCandidateSet>; prompt: ReturnType<typeof buildLLMPrompt> | null;
    attempts: LLMAttemptRecord[]; parsed: LLMDecisionPayload | null;
    proposedAction: Action | null; executedAction: Action; source: 'llm' | 'fallback';
    fallbackCause: LLMFallbackCause | null; fallbackReason: string | null;
    engineValidation: 'accepted' | 'fallback-accepted' | 'failed';
    started: number; seat: number; championShadow: LLMChampionShadow | null;
  }): LLMTurnRecord {
    const usage = args.attempts.reduce((sum, attempt) => ({
      promptTokens: sum.promptTokens + (attempt.usage?.promptTokens ?? 0),
      completionTokens: sum.completionTokens + (attempt.usage?.completionTokens ?? 0),
      totalTokens: sum.totalTokens + (attempt.usage?.totalTokens ?? 0),
    }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    const last = args.attempts.at(-1);
    const prompt = args.prompt ?? { system: '', user: '', promptHash: '', estimatedPromptTokens: 0 };
    const createdAt = new Date().toISOString();
    const decisionId = `d${fnv1a([
      args.context.gameId, args.view.turnNumber, args.seat, prompt.promptHash,
      args.source, actionKey(args.executedAction), createdAt,
    ].join('|')).toString(16).padStart(8, '0')}`;
    return {
      schema: 'century-llm-turn-v1',
      decisionId,
      gameId: args.context.gameId,
      seed: args.context.seed,
      seatCount: args.context.seatCount,
      focusSeat: args.context.focusSeat,
      experimentId: args.context.experimentId,
      channel: args.context.channel,
      seat: args.seat,
      turnNumber: args.view.turnNumber,
      round: Math.floor((args.view.turnNumber - 1) / args.view.players.length) + 1,
      playerTurn: args.view.players[args.seat].turns + 1,
      phase: args.view.phase,
      observation: args.view,
      observationHash: args.obsHash,
      candidateSet: args.candidateSet,
      provider: this.provider.info(),
      effectiveModel: last?.effectiveModel ?? null,
      generationConfig: {
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
        candidateLimit: this.config.candidateLimit,
      },
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptHash: prompt.promptHash,
        estimatedPromptTokens: prompt.estimatedPromptTokens,
      },
      attempts: args.attempts,
      parsed: args.parsed,
      selectedActionId: args.parsed?.selectedActionId ?? null,
      proposedAction: args.proposedAction,
      executedAction: args.executedAction,
      source: args.source,
      fallbackCause: args.fallbackCause,
      fallbackReason: args.fallbackReason,
      engineValidation: args.engineValidation,
      championShadow: args.championShadow,
      usage,
      totalLatencyMs: Date.now() - args.started,
      apiFailure: args.source === 'fallback' || args.attempts.some(a => a.error !== null || a.parse !== 'ok'),
      createdAt,
    };
  }
}

export function createLLMPlayer(options: LLMPlayerOptions): LLMPlayer {
  return new LLMPlayer(options);
}
