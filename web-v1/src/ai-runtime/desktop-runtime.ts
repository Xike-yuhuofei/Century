/** 桌面页面 AI 运行时（生产接入层）。
 *
 * 职责边界：
 * - 把 AI 决策从主线程移到内联 Worker（单文件部署也可用）；
 * - 决策输入只来自 buildObservation 的公开观察，随机流为常量种子（不读取
 *   正式牌库种子），算法身份/预算直接读取当前冠军参数；
 * - Worker 不可用时显式降级到主线程冠军决策（保留棋力），其余故障使用
 *   已验证合法回退，绝不让页面卡死，也绝不静默执行未知版本。
 *
 * 本模块只负责“拿行动 + 报告来源/降级状态”；行动是否属于当前游戏状态、
 * 是否合法，由 app.ts 在应用前用正式引擎 applyAction 复核。
 */

import type { Action, Game } from '../engine.js';
import { buildObservation } from '../ai/observation.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';
import { chooseAIAction } from '../ai/decision.js';
import {
  createAIDecisionClient,
  type AIDecisionClient,
  type ClientStats,
  type DecisionOutcome,
  type WorkerLike,
} from './client.js';

export type DesktopDecisionSource = 'worker' | 'main-thread' | 'fallback';

export type DesktopDecision = {
  action: Action;
  source: DesktopDecisionSource;
  reason: string;
  /** 降级/失败原因（source !== 'worker' 时披露）。 */
  error?: string;
};

export type RuntimeMode = 'uninitialized' | 'worker' | 'main-thread-degraded';

export type DesktopRuntimeStats = ClientStats & {
  mainThreadFallbacks: number;
  spawnFailures: number;
  lastDecisionSource: DesktopDecisionSource | null;
};

export type DesktopAIRuntime = {
  /** 返回 null 表示请求已被替代/取消（结果不得提交）。 */
  decide(game: Game, gameStateVersion: number): Promise<DesktopDecision | null>;
  cancel(reason?: string): void;
  invalidate(gameStateVersion: number): void;
  /** 换局：销毁当前 Worker，下一次决策重新握手（清空协议版本水位）。 */
  reset(): void;
  dispose(): void;
  mode(): RuntimeMode;
  stats(): DesktopRuntimeStats;
};

/** 内联 Worker 源码元素 id（由 build.mjs 注入；单文件与服务器入口一致）。 */
export const WORKER_SOURCE_ELEMENT_ID = 'ai-worker-source';

/** 当前冠军的决策配置。Worker 与主线程降级都从这里取值，避免两套口径。 */
export function championDecisionConfig(): {
  adapter: 'champion-guided' | null;
  jointVersion: string | null;
  budgetMs: number;
  simSeed: number;
} {
  const adapter = CHAMPION_PARAMETERS.adapter === 'champion-guided' ? 'champion-guided' as const : null;
  return {
    adapter,
    jointVersion: CHAMPION_PARAMETERS.jointVersion ?? null,
    budgetMs: CHAMPION_PARAMETERS.budgetMs ?? 100,
    // 常量 0 = 与生产主线程 chooseJointAction 的缺省随机流逐位相同。
    // 绝不使用 form game 的牌库种子：那会把隐藏信息带进 Worker 随机流。
    simSeed: 0,
  };
}

function readWorkerSource(): string {
  const element = document.getElementById(WORKER_SOURCE_ELEMENT_ID);
  const source = element?.textContent?.trim() ?? '';
  if (!source) throw new Error(`缺少内联 AI Worker 源码（#${WORKER_SOURCE_ELEMENT_ID}）`);
  return source;
}

/** 从内联源码创建经典 Worker（不依赖外部 URL，单文件/子路径部署均可）。 */
function spawnInlineWorker(): WorkerLike {
  const source = readWorkerSource();
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  // 经典 Worker 在创建后异步拉取 blob；立即回收在部分浏览器会导致加载失败。
  const revoke = () => { try { URL.revokeObjectURL(url); } catch { /* 已回收 */ } };
  worker.addEventListener('error', revoke, { once: true });
  setTimeout(revoke, 30_000);
  return {
    postMessage: message => worker.postMessage(message),
    terminate: () => { revoke(); worker.terminate(); },
    get onmessage() { return worker.onmessage as unknown as WorkerLike['onmessage']; },
    set onmessage(handler) { worker.onmessage = handler as unknown as Worker['onmessage']; },
    get onerror() { return worker.onerror as unknown as WorkerLike['onerror']; },
    set onerror(handler) { worker.onerror = handler as unknown as Worker['onerror']; },
  };
}

export type DesktopRuntimeOptions = {
  /** 测试/诊断注入；缺省从页面内联源码创建。 */
  spawn?: () => WorkerLike;
};

export function createDesktopAIRuntime(options: DesktopRuntimeOptions = {}): DesktopAIRuntime {
  const spawn = options.spawn ?? spawnInlineWorker;
  let client: AIDecisionClient | null = null;
  let mode: RuntimeMode = 'uninitialized';
  let mainThreadFallbacks = 0;
  let spawnFailures = 0;
  let lastDecisionSource: DesktopDecisionSource | null = null;
  let disposed = false;
  /** Worker 启动失败后锁定主线程降级，避免每个 AI 回合重复等待启动超时。 */
  let workerBlocked = false;

  function getClient(): AIDecisionClient {
    if (disposed) throw new Error('AI 运行时已销毁');
    if (!client) {
      try {
        client = createAIDecisionClient({
          spawn,
          initTimeoutMs: 5000,
          watchdogGraceMs: 2000,
          onEvent: event => {
            if (event.type === 'worker-terminated' && event.cause === 'crash') spawnFailures++;
          },
        });
        mode = 'worker';
      } catch (error) {
        // 同步创建失败（例如 Blob/Worker 不可用）：保持 client=null，
        // 由 decide 走主线程冠军降级并显式披露。
        spawnFailures++;
        mode = 'main-thread-degraded';
        throw error;
      }
    }
    return client;
  }

  function decisionConfigFor(game: Game): {
    observation: ReturnType<typeof buildObservation>;
    ai: { jointVersion: string };
    budget: { mode: 'wall-clock'; budgetMs: number };
    simSeed: number;
  } | null {
    const config = championDecisionConfig();
    if (config.adapter !== 'champion-guided' || !config.jointVersion) return null;
    if (!game.players[game.current]?.isAI) return null;
    return {
      observation: buildObservation(game, game.current),
      ai: { jointVersion: config.jointVersion },
      budget: { mode: 'wall-clock', budgetMs: config.budgetMs },
      simSeed: config.simSeed,
    };
  }

  function mainThreadDecision(game: Game, reason: string, error: string): DesktopDecision {
    mainThreadFallbacks++;
    mode = 'main-thread-degraded';
    try {
      const decision = chooseAIAction(game);
      lastDecisionSource = 'main-thread';
      return {
        action: decision.action,
        source: 'main-thread',
        reason: `主线程冠军降级：${reason}`,
        error,
      };
    } catch (fallbackError) {
      // 主线程冠军自身失败：交给 chooseVerifiedFallback（client 回退路径）
      // 之前先明确失败，由调用方暂停 AI，而不是执行不明行动。
      throw new Error(`主线程冠军降级失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    }
  }

  function fromOutcome(outcome: DecisionOutcome, game: Game): DesktopDecision | null {
    if (outcome.status === 'decision') {
      lastDecisionSource = 'worker';
      return { action: outcome.action, source: 'worker', reason: outcome.reason };
    }
    if (outcome.status === 'fallback') {
      if (outcome.cause === 'spawn-failure') {
        spawnFailures++;
        workerBlocked = true;
        // Worker 根本无法启动：改用主线程冠军，保留棋力并让降级可见。
        return mainThreadDecision(game, 'Worker 启动失败', outcome.error ?? outcome.reason);
      }
      lastDecisionSource = 'fallback';
      return {
        action: outcome.action,
        source: 'fallback',
        reason: outcome.reason,
        error: outcome.error ?? `回退原因：${outcome.cause}`,
      };
    }
    // superseded / cancelled：调用方不应提交，返回 null 表示本次弃权。
    return null;
  }

  return {
    async decide(game, gameStateVersion) {
      if (disposed) throw new Error('AI 运行时已销毁');
      const payload = decisionConfigFor(game);
      if (!payload) {
        // 冠军已不再走联合搜索（或当前席位不是 AI）：显式主线程降级。
        return mainThreadDecision(game, '冠军配置不再支持 Worker 路径', 'adapter/jointVersion 缺失');
      }
      if (workerBlocked) {
        return mainThreadDecision(game, 'Worker 此前启动失败，本局保持主线程冠军', 'worker-blocked');
      }
      let active: AIDecisionClient;
      try {
        active = getClient();
      } catch (error) {
        return mainThreadDecision(game, 'Worker 不可用', error instanceof Error ? error.message : String(error));
      }
      const outcome = await active.requestDecision({
        gameStateVersion,
        observation: payload.observation,
        ai: payload.ai,
        budget: payload.budget,
        simSeed: payload.simSeed,
      });
      return fromOutcome(outcome, game);
    },
    cancel(reason = '取消当前 AI 决策') {
      client?.cancel(reason);
    },
    invalidate(gameStateVersion) {
      client?.invalidate(gameStateVersion);
    },
    reset() {
      client?.dispose();
      client = null;
      mode = 'uninitialized';
      lastDecisionSource = null;
      workerBlocked = false;
    },
    dispose() {
      disposed = true;
      client?.dispose();
      client = null;
      mode = 'uninitialized';
    },
    mode: () => mode,
    stats: () => ({
      ...(client?.stats() ?? {
        requests: 0, workerDecisions: 0, fallbacks: 0, superseded: 0, cancelled: 0, spawns: 0, watchdogKills: 0,
      }),
      mainThreadFallbacks,
      spawnFailures,
      lastDecisionSource,
    }),
  };
}
