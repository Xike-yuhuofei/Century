/** 决策核心（环境无关）：公开观察 → 行动 + 诊断。
 *
 * 本模块是 Worker 决策与主线程直接调用的共同决策实现：
 * - Worker 侧：worker-core.ts 调用本模块在子线程执行重搜索；
 * - 主线程侧：等价性测试与本模块直接调用逐位对比（同一公开观察 + 同一
 *   算法版本 + 同一随机流 + 同一固定工作量 ⇒ 行动一致）。
 *
 * 信息边界（结构强制）：
 * - 决策输入只有 AIObservation 公开观察；本模块 import 图中不存在
 *   engine.ts（运行时），隐藏牌库顺序在结构上不可达；
 * - 语义与 js/adapter.ts 的"观察-only 决策 + 第一步合法性纪律"逐项对齐，
 *   但不做 applyAction 复核——那是主线程（持有完整 Game 的一方）的职责；
 *   本模块只做公开模拟合法集的"顾问性"预检（advisory），权威校验始终在
 *   主线程正式规则引擎。
 *
 * 与冠军行为的关系（接入纪律）：
 * - 本模块只复用既有搜索实现（createChampionGuidedPlanner / createJointPlanner /
 *   trimStock 冠军溢出口径），不新增、不修改任何搜索算法与参数；
 * - 默认 AI 入口（chooseAIAction）不经过本模块，冠军行为逐位不变。
 */

import type { AIObservation } from '../ai/observation.js';
import type { Action, Color } from '../engine.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';
import { trimStock } from '../ai/evaluator.js';
import { createSimulation } from '../sim/session.js';
import { enumerateLegalActions } from '../sim/legal.js';
import {
  createChampionGuidedPlanner,
  createJointPlanner,
} from '../js/index.js';
import { JOINT_VERSIONS } from '../js/types.js';
import { mergeJointOptions, resolveJointConfig, jointConfigHash } from '../js/config.js';
import type {
  DecisionBudget, DecisionDiagnostics, DecisionRequestPayload, DecisionSearchOptions, EvaluationSummary,
} from './protocol.js';

/** 决策核心内部异常：携带协议错误分类。 */
export class DecisionCoreError extends Error {
  readonly category: 'protocol' | 'decision';
  constructor(category: 'protocol' | 'decision', message: string) {
    super(message);
    this.name = 'DecisionCoreError';
    this.category = category;
  }
}

/** planner 实例按版本缓存（与 js/adapter.ts 同纪律：无状态，decide 每次独立）。 */
const planners = new Map<string, ReturnType<typeof createJointPlanner> | ReturnType<typeof createChampionGuidedPlanner>>();
function plannerFor(versionId: string) {
  let planner = planners.get(versionId);
  if (!planner) {
    const version = JOINT_VERSIONS[versionId as keyof typeof JOINT_VERSIONS];
    planner = version?.kind === 'champion-guided'
      ? createChampionGuidedPlanner()
      : createJointPlanner(versionId);
    planners.set(versionId, planner);
  }
  return planner;
}

const SEARCH_OPTION_KEYS = new Set([
  'gateMode', 'contestThreshold', 'candidateCap', 'overrideMargin', 'claimRanking', 'nearTerminalCandidate', 'screenGoalScope', 'batchAdmission',
]);

/** 搜索选项白名单校验（未知字段显式拒绝；数值范围与 champion-guided 缺省纪律一致）。 */
function validateSearchOptions(search: unknown): DecisionSearchOptions {
  if (search === undefined) return {};
  if (!search || typeof search !== 'object' || Array.isArray(search)) {
    throw new DecisionCoreError('protocol', 'search 选项必须是对象');
  }
  for (const key of Object.keys(search)) {
    if (!SEARCH_OPTION_KEYS.has(key)) throw new DecisionCoreError('protocol', `未知搜索选项：${key}`);
  }
  const s = search as DecisionSearchOptions;
  if (s.gateMode !== undefined && !['auto', 'always', 'never', 'rerank'].includes(s.gateMode)) {
    throw new DecisionCoreError('protocol', `gateMode 非法：${String(s.gateMode)}`);
  }
  if (s.claimRanking !== undefined && !['enumeration', 'prior'].includes(s.claimRanking)) {
    throw new DecisionCoreError('protocol', `claimRanking 非法：${String(s.claimRanking)}`);
  }
  if (s.nearTerminalCandidate !== undefined && !['off', 'replace', 'add'].includes(s.nearTerminalCandidate)) {
    throw new DecisionCoreError('protocol', `nearTerminalCandidate 非法：${String(s.nearTerminalCandidate)}`);
  }
  if (s.screenGoalScope !== undefined && !['all', 'preferred'].includes(s.screenGoalScope)) {
    throw new DecisionCoreError('protocol', `screenGoalScope 非法：${String(s.screenGoalScope)}`);
  }
  if (s.batchAdmission !== undefined && !['legacy', 'balanced'].includes(s.batchAdmission)) {
    throw new DecisionCoreError('protocol', `batchAdmission 非法：${String(s.batchAdmission)}`);
  }
  if (s.contestThreshold !== undefined && !(Number.isFinite(s.contestThreshold) && s.contestThreshold >= 0 && s.contestThreshold <= 1)) {
    throw new DecisionCoreError('protocol', 'contestThreshold 必须在 [0,1]');
  }
  if (s.candidateCap !== undefined && !(Number.isSafeInteger(s.candidateCap) && s.candidateCap >= 1 && s.candidateCap <= 8)) {
    throw new DecisionCoreError('protocol', 'candidateCap 必须为 1..8 的整数');
  }
  if (s.overrideMargin !== undefined && !(Number.isFinite(s.overrideMargin) && s.overrideMargin >= 0 && s.overrideMargin <= 1)) {
    throw new DecisionCoreError('protocol', 'overrideMargin 必须在 [0,1]');
  }
  return s;
}

/** 冠军溢出弃置口径（与 js/adapter.ts / ai/decision.ts 同一 trimStock 语义，
 * 输入全部来自公开观察：本方水晶库存 + 公开魔像市场）。 */
export function championOverflowDiscard(observation: AIObservation): Action {
  const seat = observation.playerId;
  const player = observation.players[seat];
  if (!player) throw new DecisionCoreError('decision', `观察席位 ${seat} 不存在`);
  return { type: 'discard', colors: trimStock(player.stock, observation.golemMarket, null, CHAMPION_PARAMETERS).discarded as Color[] };
}

/** 固定决策核心入口（Worker 与主线程直调共用）。
 * 输入只有公开观察与显式预算/种子；输出行动 + 完整诊断。 */
export function decideFromObservation(payload: DecisionRequestPayload): {
  action: Action;
  diagnostics: Omit<DecisionDiagnostics, 'protocolVersion' | 'requestId' | 'gameStateVersion'>;
} {
  const { observation, ai, budget, simSeed } = payload;
  const version = JOINT_VERSIONS[ai.jointVersion as keyof typeof JOINT_VERSIONS];
  if (!version) {
    throw new DecisionCoreError('protocol', `未知联合规划版本：${String(ai.jointVersion)}`);
  }
  if (version.kind === 'champion-contest') {
    // js1 委托正式冠军入口 chooseAIAction，需要完整 Game——Worker 决策路径
    // 结构上没有 Game，不支持该 kind（报协议错误，绝不静默降级）。
    throw new DecisionCoreError('protocol', `版本 ${ai.jointVersion} 为 champion-contest（需完整 Game 复核），Worker 决策路径不支持`);
  }
  if (observation.phase === 'finished') {
    throw new DecisionCoreError('decision', '游戏已结束，无法决策');
  }
  const seat = observation.playerId;
  if (observation.current !== seat) {
    throw new DecisionCoreError('decision', `决策席位 ${seat} 不是当前行动者 ${observation.current}`);
  }

  const t0 = performance.now();
  let action: Action;
  let reason: string;
  let gated = false;
  let config: DecisionDiagnostics['config'];
  let stats: DecisionDiagnostics['stats'];
  let evaluations: { action: Action; prior: number; trials: number; mean: number }[] = [];

  if (observation.phase === 'overflow') {
    // 溢出：冠军 trimStock 弃置口径（纯公开信息，零搜索）。
    action = championOverflowDiscard(observation);
    reason = '溢出弃置（冠军 trimStock 口径）';
    const elapsed = performance.now() - t0;
    stats = {
      rollouts: 0, transitions: 0, elapsedMs: elapsed, budgetExhausted: false,
      rootActions: 0, candidateCount: 0, worldsUsed: 0, omTimeMs: 0, cloneMs: 0, legalGenMs: 0,
    };
  } else {
    const planner = plannerFor(ai.jointVersion);
    const search = validateSearchOptions(payload.search);
    const baseOptions = {
      ...(budget.mode === 'fixed-work'
        ? { workUnits: budget.workUnits }
        : { budgetMs: budget.budgetMs }),
      simSeed,
      ...(payload.horizon !== undefined ? { horizon: payload.horizon } : {}),
      ...(payload.worlds !== undefined ? { worlds: payload.worlds } : {}),
      ...search,
      // AI6 第六阶段 P0：正式入口 chooseAIAction 会把冠军参数对象传入适配器
      // （冠军本体 = 归一化 CHAMPION_PARAMETERS，行为不变；风格变体才产生差异）。
      // Worker 只承载生产冠军，因此固定注入 CHAMPION_PARAMETERS 保持同源。
      ...(version.kind === 'champion-guided' ? { championParameters: CHAMPION_PARAMETERS } : {}),
      profileName: ai.profileName,
    };
    // 版本预设（如 joint-js5-opt 的 claimRanking=prior）与调用方覆盖合并；
    // 有效配置进入诊断，Worker 不再与正式评测配置脱节。
    const options = mergeJointOptions(ai.jointVersion, baseOptions);
    const resolved = resolveJointConfig(ai.jointVersion, options, ai.profileName);
    config = { ...resolved, hash: jointConfigHash(resolved) };
    const decision = version.kind === 'champion-guided'
      ? (planner as ReturnType<typeof createChampionGuidedPlanner>).decide(observation, options)
      : (planner as ReturnType<typeof createJointPlanner>).decide(observation, options);
    action = decision.action;
    reason = decision.reason;
    evaluations = decision.evaluations.map(e => ({ action: e.action, prior: e.prior, trials: e.trials, mean: e.mean }));
    gated = 'gated' in decision ? decision.gated === true : false;
    stats = {
      rollouts: decision.stats.rollouts,
      transitions: decision.stats.transitions,
      elapsedMs: decision.stats.elapsedMs,
      budgetExhausted: decision.stats.budgetExhausted,
      rootActions: decision.stats.rootActions,
      candidateCount: decision.stats.candidateCount,
      worldsUsed: decision.stats.worldsUsed,
      omTimeMs: decision.stats.omTimeMs,
      cloneMs: decision.stats.cloneMs,
      legalGenMs: decision.stats.legalGenMs,
    };
  }

  // 顾问性合法预检（公开模拟合法集成员检查；权威校验在主线程正式引擎）。
  // 预检失败时回退首个公开合法行动并显式披露——绝不返回已知非法行动。
  let advisoryFallback = false;
  if (observation.phase !== 'overflow') {
    try {
      const sim = createSimulation(observation, { simSeed });
      const legal = enumerateLegalActions(sim.view, { dedupe: true });
      const canonical = (a: Action) => JSON.stringify(a);
      const legalSet = new Set(legal.map(canonical));
      if (!legalSet.has(canonical(action)) && legal.length > 0) {
        action = legal[0];
        reason = 'Worker 顾问预检失败，回退首个公开合法行动（缺陷暴露）';
        advisoryFallback = true;
      }
    } catch {
      // 公开模拟自身异常不阻断决策（主线程权威校验兜底）；记录诊断。
      advisoryFallback = false;
    }
  }

  const elapsedMs = performance.now() - t0;
  const topEvaluations: EvaluationSummary[] = [...evaluations]
    .sort((a, b) => b.mean - a.mean)
    .slice(0, 5);

  return {
    action,
    diagnostics: {
      ai,
      budget,
      simSeed,
      ...(config ? { config } : {}),
      elapsedMs,
      reason: advisoryFallback ? `${reason}` : reason,
      action,
      stats: { ...stats, elapsedMs },
      gated,
      topEvaluations,
    },
  };
}
