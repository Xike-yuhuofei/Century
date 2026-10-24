/** AI 决策客户端（主线程生命周期管理器）。
 *
 * 职责：把"高算力决策"从游戏主线程剥离到 Worker，同时保证：
 * - 过期行动永不提交：requestId + gameStateVersion 双重失效；被替代/取消/
 *   作废的请求只解析出 'superseded'/'cancelled'，不解析出行动；
 * - 状态更新时废弃旧任务：invalidate() 或新的 requestDecision 立即废弃
 *   inflight 并终止忙碌 Worker（释放算力给新任务）；
 * - Worker 故障安全恢复：crash → 重生并重试一次；再次失败 → 已验证合法回退；
 * - AI 异常不卡页面：所有等待都有看门狗；任何路径最终要么给行动、要么给
 *   回退行动、要么显式报告取消——永不悬挂。
 *
 * 接入纪律：本客户端不接入默认页面（desktop app.ts / mobile app.ts 不 import）。
 * 使用方式为显式 opt-in（见 ai-runtime/harness.html 与 OVERNIGHT-REPORT.md）。
 */

import type { AIObservation } from '../ai/observation.js';
import type { Action } from '../engine.js';
import {
  PROTOCOL_VERSION,
  type AIWorkerRequest, type AIWorkerResponse, type AIVersionDescriptor,
  type DecisionBudget, type DecisionDiagnostics, isCompatibleProtocolVersion,
} from './protocol.js';
import { chooseVerifiedFallback } from './fallback.js';

/** 宿主 Worker 抽象（浏览器 DedicatedWorker 与 Node worker_threads 桥接共用）。 */
export type WorkerLike = {
  postMessage(message: AIWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: AIWorkerResponse }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
};

export type WorkerSpawner = () => WorkerLike;

export type DecisionRequestInput = {
  gameStateVersion: number;
  observation: AIObservation;
  ai: AIVersionDescriptor;
  budget: DecisionBudget;
  simSeed: number;
  horizon?: number;
  worlds?: number;
  /** 固定工作量模式的看门狗预期耗时（毫秒；墙钟模式忽略）。 */
  expectedMs?: number;
};

export type FallbackCause = 'worker-error' | 'watchdog' | 'spawn-failure';

export type DecisionOutcome =
  | { status: 'decision'; action: Action; reason: string; diagnostics: DecisionDiagnostics; latencyMs: number; source: 'worker' }
  | { status: 'fallback'; action: Action; reason: string; source: 'fallback'; cause: FallbackCause; latencyMs: number; error?: string }
  | { status: 'superseded'; reason: string }
  | { status: 'cancelled'; reason: string };

export type AIClientEvent =
  | { type: 'spawned' }
  | { type: 'worker-terminated'; cause: 'crash' | 'watchdog' | 'supersede' | 'cancel' | 'error' | 'dispose' }
  | { type: 'worker-error'; message: string }
  | { type: 'protocol-error'; message: string }
  | { type: 'decision'; requestId: string; latencyMs: number }
  | { type: 'fallback'; requestId: string | null; cause: FallbackCause }
  | { type: 'disposed' };

export type ClientOptions = {
  spawn: WorkerSpawner;
  /** init 握手超时（毫秒；默认 5000）。 */
  initTimeoutMs?: number;
  /** 看门狗宽限（毫秒；默认 2000）——预算（或 expectedMs）耗尽后的额外等待上限。 */
  watchdogGraceMs?: number;
  /** 固定工作量模式缺省预期耗时（毫秒；默认 10000，可被请求级 expectedMs 覆盖）。 */
  fixedWorkExpectedMs?: number;
  /** 回退决策（缺省 chooseVerifiedFallback）。 */
  fallback?: (observation: AIObservation) => { action: Action; reason: string };
  /** 事件回调（诊断/测试用）。 */
  onEvent?: (event: AIClientEvent) => void;
};

export type ClientStats = {
  requests: number;
  workerDecisions: number;
  fallbacks: number;
  superseded: number;
  cancelled: number;
  spawns: number;
  watchdogKills: number;
};

export type AIDecisionClient = {
  ready(): Promise<void>;
  requestDecision(input: DecisionRequestInput): Promise<DecisionOutcome>;
  /** 状态更新时废弃旧任务：所有 gameStateVersion < newVersion 的未决结果作废。 */
  invalidate(newGameStateVersion: number): void;
  /** 显式取消当前未决请求（结果永不提交）。 */
  cancel(reason?: string): void;
  dispose(): void;
  stats(): ClientStats;
};

type Inflight = {
  requestId: string;
  gameStateVersion: number;
  observation: AIObservation;
  expectedMs?: number;
  resolve: (outcome: DecisionOutcome) => void;
  watchdog: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  retries: number;
};

type RequestPayload = {
  observation: AIObservation;
  ai: AIVersionDescriptor;
  budget: DecisionBudget;
  simSeed: number;
  horizon?: number;
  worlds?: number;
};

const DEFAULTS = { initTimeoutMs: 5000, watchdogGraceMs: 2000, fixedWorkExpectedMs: 10000 };

export function createAIDecisionClient(options: ClientOptions): AIDecisionClient {
  const opts = { ...DEFAULTS, ...options };
  const counters: ClientStats = {
    requests: 0, workerDecisions: 0, fallbacks: 0, superseded: 0, cancelled: 0, spawns: 0, watchdogKills: 0,
  };
  let worker: WorkerLike | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Inflight | null = null;
  const payloadStore = new Map<string, RequestPayload>();
  /** 失效水位：gameStateVersion 低于该值的响应一律不解析出行动。 */
  let invalidatedBefore = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let requestSeq = 0;
  /** 请求 setup 串行化队列（见 doRequestSetup）。 */
  let requestQueue: Promise<unknown> = Promise.resolve();

  const emit = (event: AIClientEvent) => { try { opts.onEvent?.(event); } catch { /* 诊断回调绝不影响主流程 */ } };

  function spawnWorker(): WorkerLike {
    const next = opts.spawn();
    counters.spawns++;
    next.onmessage = (event: { data: AIWorkerResponse }) => { handleResponse(event.data); };
    next.onerror = (event: { message?: string; preventDefault?: () => void }) => {
      try { event.preventDefault?.(); } catch { /* 宿主差异容忍 */ }
      handleWorkerCrash(event.message ?? 'worker onerror');
    };
    emit({ type: 'spawned' });
    return next;
  }

  function clearWatchdog(target: Inflight | null) {
    if (target?.watchdog) { clearTimeout(target.watchdog); target.watchdog = null; }
  }

  function terminateWorker(cause: 'crash' | 'watchdog' | 'supersede' | 'cancel' | 'error' | 'dispose') {
    if (!worker) return;
    const dead = worker;
    worker = null;
    dead.onmessage = null;
    dead.onerror = null;
    try { dead.terminate(); } catch { /* 已死容忍 */ }
    emit({ type: 'worker-terminated', cause });
  }

  function performHandshake(): Promise<void> {
    worker = spawnWorker();
    return new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      readyTimer = setTimeout(() => {
        readyResolve = null; readyReject = null;
        terminateWorker('error');
        reject(new Error('Worker init 握手超时'));
      }, opts.initTimeoutMs);
      send({ kind: 'init', protocolVersion: PROTOCOL_VERSION });
    });
  }

  function send(request: AIWorkerRequest) {
    if (!worker) throw new Error('Worker 未就绪');
    worker.postMessage(request);
  }

  function armWatchdog(target: Inflight) {
    clearWatchdog(target);
    const payload = payloadStore.get(target.requestId);
    const expected = payload?.budget.mode === 'wall-clock'
      ? payload.budget.budgetMs
      : target.expectedMs ?? opts.fixedWorkExpectedMs;
    const limit = expected + opts.watchdogGraceMs;
    target.watchdog = setTimeout(() => {
      if (inflight !== target) return;
      counters.watchdogKills++;
      const current = target;
      inflight = null;
      clearWatchdog(current);
      payloadStore.delete(current.requestId);
      terminateWorker('watchdog');
      resolveFallbackFor(current, 'watchdog', `看门狗超时（${limit}ms 无响应）`);
    }, limit);
  }

  function resolveFallbackFor(target: Inflight, cause: FallbackCause, error: string) {
    counters.fallbacks++;
    emit({ type: 'fallback', requestId: target.requestId, cause });
    try {
      const fallback = opts.fallback ?? chooseVerifiedFallback;
      const decision = fallback(target.observation);
      target.resolve({
        status: 'fallback', action: decision.action, reason: decision.reason,
        source: 'fallback', cause, latencyMs: performance.now() - target.startedAt, error,
      });
    } catch (fallbackError) {
      // 回退自身失败（理论上只在终局/空合法集发生）：显式取消而非悬挂。
      target.resolve({ status: 'cancelled', reason: `回退失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}` });
    }
  }

  function settleAs(target: Inflight, outcome: DecisionOutcome) {
    if (inflight === target) inflight = null;
    clearWatchdog(target);
    payloadStore.delete(target.requestId);
    target.resolve(outcome);
  }

  function retryOrFallback(target: Inflight, error: string, cause: FallbackCause) {
    if (target.retries === 0) {
      // 首次异常：重生并原样重试一次（决策类错误可能是暂态）。
      target.retries++;
      target.startedAt = performance.now();
      terminateWorker('error');
      performHandshake()
        .then(() => {
          if (disposed || inflight !== target) return;
          armWatchdog(target);
          send({
            kind: 'decision', protocolVersion: PROTOCOL_VERSION, requestId: target.requestId,
            gameStateVersion: target.gameStateVersion, payload: payloadStore.get(target.requestId)!,
          });
        })
        .catch(() => {
          if (inflight === target) inflight = null;
          payloadStore.delete(target.requestId);
          resolveFallbackFor(target, 'spawn-failure', `Worker 重生失败：${error}`);
        });
      return;
    }
    resolveFallbackFor(target, cause, error);
  }

  function supersede(target: Inflight, status: 'superseded' | 'cancelled', reason: string, cause: 'supersede' | 'cancel') {
    try { send({ kind: 'cancel', protocolVersion: PROTOCOL_VERSION, requestId: target.requestId }); } catch { /* worker 已死容忍 */ }
    // 忙碌线程直接终止：过期决策的算力没有价值，且防止其结果被排队新请求等待。
    terminateWorker(cause);
    if (status === 'superseded') counters.superseded++;
    else counters.cancelled++;
    settleAs(target, { status, reason });
  }

  function handleWorkerCrash(message: string) {
    emit({ type: 'worker-error', message });
    if (readyReject) {
      const reject = readyReject;
      readyResolve = null; readyReject = null;
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      worker = null;
      reject(new Error(`Worker 启动失败：${message}`));
    }
    const current = inflight;
    if (current) {
      // inflight 保持占用：重试期间新请求仍可将其 supersede。
      clearWatchdog(current);
      retryOrFallback(current, `Worker 崩溃：${message}`, 'worker-error');
    }
  }

  /** 就绪保证：已有 worker 直接复用；否则重生并握手。 */
  function ensureReady(): Promise<void> {
    if (worker) return Promise.resolve();
    return performHandshake();
  }

  function handleResponse(response: AIWorkerResponse) {
    if (disposed) return;
    if (!response || typeof response !== 'object' || !isCompatibleProtocolVersion(response.protocolVersion)) {
      emit({ type: 'protocol-error', message: `响应协议版本不兼容：${JSON.stringify((response as { protocolVersion?: unknown })?.protocolVersion)}` });
      return;
    }
    switch (response.kind) {
      case 'ready': {
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        const resolve = readyResolve;
        readyResolve = null; readyReject = null;
        resolve?.();
        return;
      }
      case 'decision': {
        const current = inflight;
        if (!current || current.requestId !== response.requestId) return; // 迟到的旧响应
        if (response.gameStateVersion < invalidatedBefore) {
          settleAs(current, { status: 'superseded', reason: `状态已更新至 v${invalidatedBefore}，作废旧结果` });
          return;
        }
        counters.workerDecisions++;
        const latencyMs = performance.now() - current.startedAt;
        emit({ type: 'decision', requestId: current.requestId, latencyMs });
        settleAs(current, {
          status: 'decision',
          action: response.diagnostics.action,
          reason: response.diagnostics.reason,
          diagnostics: response.diagnostics,
          latencyMs,
          source: 'worker',
        });
        return;
      }
      case 'cancelled': {
        const current = inflight;
        if (!current || current.requestId !== response.requestId) return;
        counters.cancelled++;
        settleAs(current, { status: 'cancelled', reason: 'Worker 确认取消' });
        return;
      }
      case 'error': {
        if (response.requestId === null) {
          emit({ type: 'protocol-error', message: response.message });
          return;
        }
        const current = inflight;
        if (!current || current.requestId !== response.requestId) return;
        clearWatchdog(current);
        if (response.category === 'protocol') {
          // 协议/防火墙错误是确定性的：重试无意义，直接回退并显式暴露。
          inflight = null;
          emit({ type: 'protocol-error', message: response.message });
          resolveFallbackFor(current, 'worker-error', response.message);
          return;
        }
        // 决策类异常：保持 inflight 占用并重试一次。
        retryOrFallback(current, response.message, 'worker-error');
        return;
      }
      default: return;
    }
  }

  /** 请求队列：并发 requestDecision 的 setup 阶段（废弃旧任务 + 握手 + 发送）
   * 串行化，杜绝双 inflight 竞态；决策等待不占队列——后续请求可以进入并
   * supersede 前置未决请求（否则替代语义会与自己死锁）。 */
  async function doRequestSetup(input: DecisionRequestInput, resolveOutcome: (outcome: DecisionOutcome) => void): Promise<void> {
    if (disposed) { resolveOutcome({ status: 'cancelled', reason: '客户端已销毁' }); return; }
    // 同一时刻至多一个 inflight：新请求先废弃旧请求（防过期行动提交的第一道闸）。
    if (inflight) supersede(inflight, 'superseded', '新决策请求替代旧请求', 'supersede');
    try {
      await ensureReady();
    } catch (error) {
      counters.fallbacks++;
      emit({ type: 'fallback', requestId: null, cause: 'spawn-failure' });
      const startedAt = performance.now();
      try {
        const decision = (opts.fallback ?? chooseVerifiedFallback)(input.observation);
        resolveOutcome({
          status: 'fallback', action: decision.action, reason: decision.reason, source: 'fallback',
          cause: 'spawn-failure', latencyMs: performance.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (fallbackError) {
        resolveOutcome({ status: 'cancelled', reason: `回退失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}` });
      }
      return;
    }
    if (disposed) { resolveOutcome({ status: 'cancelled', reason: '客户端已销毁' }); return; }
    const requestId = `req-${++requestSeq}-${Math.random().toString(36).slice(2, 8)}`;
    counters.requests++;
    const target: Inflight = {
      requestId,
      gameStateVersion: input.gameStateVersion,
      observation: input.observation,
      ...(input.expectedMs !== undefined ? { expectedMs: input.expectedMs } : {}),
      resolve: resolveOutcome,
      watchdog: null,
      startedAt: performance.now(),
      retries: 0,
    };
    inflight = target;
    payloadStore.set(requestId, {
      observation: input.observation, ai: input.ai, budget: input.budget,
      simSeed: input.simSeed, ...(input.horizon !== undefined ? { horizon: input.horizon } : {}),
      ...(input.worlds !== undefined ? { worlds: input.worlds } : {}),
    });
    armWatchdog(target);
    send({
      kind: 'decision', protocolVersion: PROTOCOL_VERSION, requestId,
      gameStateVersion: input.gameStateVersion,
      payload: payloadStore.get(requestId)!,
    });
  }

  return {
    ready(): Promise<void> {
      if (worker) return Promise.resolve();
      return performHandshake();
    },
    requestDecision(input: DecisionRequestInput): Promise<DecisionOutcome> {
      return new Promise<DecisionOutcome>(resolveOutcome => {
        const setup = () => doRequestSetup(input, resolveOutcome);
        const queued = requestQueue.then(setup, setup);
        requestQueue = queued.then(() => undefined, () => undefined);
      });
    },
    invalidate(newGameStateVersion: number): void {
      invalidatedBefore = Math.max(invalidatedBefore, newGameStateVersion);
      const current = inflight;
      if (current && current.gameStateVersion < newGameStateVersion) {
        supersede(current, 'superseded', `状态更新至 v${newGameStateVersion}，废弃旧任务`, 'cancel');
      }
    },
    cancel(reason = '显式取消'): void {
      const current = inflight;
      if (current) supersede(current, 'cancelled', reason, 'cancel');
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const current = inflight;
      if (current) {
        inflight = null;
        clearWatchdog(current);
        payloadStore.delete(current.requestId);
        current.resolve({ status: 'cancelled', reason: '客户端已销毁' });
      }
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      readyResolve = null; readyReject = null;
      terminateWorker('dispose');
      emit({ type: 'disposed' });
    },
    stats: () => ({ ...counters }),
  };
}
