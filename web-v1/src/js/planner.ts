/** JointPlanner V1 主编排（AI6 第四阶段·任务 A/C/E/F）。
 *
 * decide(observation, options) 流程：
 * 1. 溢出阶段直接走冠军 trimStock 弃置口径（无搜索）；
 * 2. createSimulation 构造公共模拟根（信念采样一次 → 全部根行动共享同一随机世界 = CRN）；
 * 3. enumerateLegalActions 全量合法根行动（可达性上界 = 全量集合）；
 * 4. 冠军启发式根筛选（searchGrade/routeGrade 镜像 + 座位感知存活先验）；
 * 5. 预算分配：top-M 候选保底各 1 次联合模拟，剩余预算 top-M 均匀轮转
 *    （UCB 方案因小样本过度集中被替换，实测见报告）+ 高先验未试行动有界晋升；
 * 6. 聚合输出最高稳健预期胜率行动（任务 C.9）。
 *
 * 预算与确定性（任务 F）：
 * - budgetMs：墙钟预算，trial 原子执行，超时返回已完成样本的最优——
 *   极端情况下（0 trial 完成）回退先验最优行动，永远返回合法行动；
 * - workUnits：固定联合模拟次数（64/128/256/512），全部随机性来自显式种子
 *   ⇒ 同观察 + 同选项 ⇒ 逐位相同决策（可复放）；
 * - 两者都提供时 workUnits 优先（确定性模式）。
 *
 * 对手模型成本纪律（任务 E）：轨迹内只用 predictAction（亚毫秒级）；
 * predictSurvival / predictClaimETA 不在轨迹内调用。
 */

import type { Action } from '../engine.js';
import { GOLEM_BY_ID } from '../data.js';
import type { AIObservation } from '../ai/observation.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';
import { createSimulation, type PublicSimulation } from '../sim/session.js';
import { enumerateLegalActions } from '../sim/legal.js';
import { mulberry32 } from '../sim/rng.js';
import { createOpponentModel, type OpponentModel } from '../om/index.js';
import { heuristicContext, screenRootActions, rootSurvival, discardDecision } from './rollout-policy.js';
import { runJointRollout, type RolloutContext } from './joint-rollout.js';
import { runJointTreeTrial, type TreeContext } from './joint-tree.js';
import { NEUTRAL_PROFILE } from '../ai/profiles.js';
import {
  JOINT_VERSIONS, type JointDecision, JointPlanner, JointSearchOptions,
  RootActionEvaluation, DecisionTrace,
} from './types.js';

const fail = (message: string): never => { throw new Error(message); };

/** 共享对手模型单例（进程级）：状态键 LRU 缓存跨决策复用（任务 E.2/5）。
 * 配置为轻量档：rollouts 仅用于意外触发的 ETA/Survival 保护上限，
 * 轨迹内正常路径不触发；budgetMs 截断保护决策预算。 */
let sharedOM: OpponentModel | null = null;
function sharedOpponentModel(): OpponentModel {
  if (!sharedOM) {
    sharedOM = createOpponentModel({
      seed: 0, rollouts: 8, horizon: 3, etaHorizon: 4,
      temperature: 0.8, useHistory: true, useHistoryStyle: true,
      budgetMs: 20, cacheSize: 512,
    });
  }
  return sharedOM;
}

/** UCB 探索系数（保留常数；当前分配为 top-M 均匀轮转 + 有界晋升，
 * UCB 方案因小样本过度集中已被替换——实测记录见报告 §搜索算法设计）。 */
const UCB_C = 0.6;

/** 未试行动的晋升加成（归一先验之上；有界探索，避免预算被均匀摊薄）。 */
const UNTRIED_BONUS = 0.25;

/** 决策聚合的稳健性惩罚系数（最终选优 = mean − λ·se；λ=0.25 折中噪声与贪心）。 */
const ROBUST_LAMBDA = 0.25;

/** 解析选项：版本缺省 < 调用选项。 */
function resolveOptions(versionId: string | undefined, options: JointSearchOptions | undefined) {
  const version = versionId ? JOINT_VERSIONS[versionId as keyof typeof JOINT_VERSIONS] : undefined;
  const o = options ?? {};
  return {
    variant: o.variant ?? version?.defaults.variant ?? 'joint-rollout',
    opponentMode: o.opponentMode ?? version?.defaults.opponentMode ?? 'rule',
    evaluator: o.evaluator ?? version?.defaults.evaluator ?? 'L2',
    // 防御性默认：budgetMs 与 workUnits 均未给定时按 100ms 墙钟预算
    // （否则 trialTarget=Infinity 会跑满 guard 上限）。
    budgetMs: o.budgetMs ?? (o.workUnits !== undefined ? undefined : 100),
    workUnits: o.workUnits,
    simSeed: o.simSeed ?? 0,
    horizon: o.horizon ?? 56,
    treeBranching: o.treeBranching ?? 2,
    treeDepth: o.treeDepth ?? 1,
    historySummary: o.historySummary,
    opponentModel: o.opponentModel ?? null,
    profileName: o.profileName,
  };
}

/** 候选分配上限：先验前 M 个获得保底 trial（M 随工作量伸缩；÷16 保证
 * 每个候选获得足够试验数以压低叶值噪声——实测 ÷8 会把 160 trial 摊薄成
 * 每行动 8 次，比较噪声淹没 0.1 量级的价值差）。 */
function topMFor(workUnits: number | undefined, candidateCount: number): number {
  if (!workUnits) return Math.min(candidateCount, 10);
  return Math.min(candidateCount, Math.max(4, Math.ceil(workUnits / 16)));
}

class JointPlannerV1 implements JointPlanner {
  constructor(private versionId: string | undefined) {}

  decide(observation: AIObservation, options?: JointSearchOptions): JointDecision {
    const t0 = performance.now();
    const opts = resolveOptions(this.versionId, options);
    if (observation.phase === 'finished') fail('游戏已结束，无法决策');
    const mySeat = observation.playerId;

    // 溢出阶段：冠军 trimStock 弃置口径（无搜索；弃置为强制行动族）。
    if (observation.phase === 'overflow') {
      const colors = discardDecision(observation.players[mySeat].stock, observation.golemMarket, CHAMPION_PARAMETERS);
      const action: Action = { type: 'discard', colors };
      return {
        action,
        reason: '溢出弃置（冠军 trimStock 口径）',
        evaluations: [],
        chosen: { action, prior: 0, trials: 1, mean: 1, se: null },
        trace: { root: { turnNumber: observation.turnNumber, current: observation.current, golemMarket: observation.golemMarket, phase: observation.phase }, evaluations: [], rejected: [] },
        stats: { rollouts: 0, transitions: 0, elapsedMs: performance.now() - t0, budgetExhausted: false, omTimeMs: 0, cloneMs: 0, legalGenMs: 0, rootActions: 0, candidateCount: 1 },
      };
    }
    if (observation.current !== mySeat) fail('观察席位不是当前行动者（失去行动机会后禁止规划）');

    // 根模拟：信念采样一次（CRN 世界）。
    const root = createSimulation(observation, { simSeed: opts.simSeed, historySummary: opts.historySummary });
    const legalGenStart = performance.now();
    const legalRootActions = enumerateLegalActions(root.view, { dedupe: true });
    const legalGenMs = performance.now() - legalGenStart;
    if (!legalRootActions.length) fail('根状态无合法行动（规则引擎不一致）');

    // 根筛选：冠军启发式 + 座位感知存活先验。
    const ctxRoot = heuristicContext(root.view, CHAMPION_PARAMETERS, NEUTRAL_PROFILE);
    const survival = rootSurvival(observation, observation.triggerPlayer !== null ? 0 : 2);
    const screened = screenRootActions(observation, legalRootActions, ctxRoot, survival);

    // 试验执行器（rollout / tree）。
    const om = opts.opponentMode === 'om-v1' ? (opts.opponentModel ?? sharedOpponentModel()) : null;
    const baseCtx = {
      mySeat,
      mode: opts.opponentMode,
      evaluator: opts.evaluator,
      horizon: opts.horizon,
      om,
      profileName: opts.profileName,
    } satisfies Omit<RolloutContext, 'events' | 'omTimeMs'>;

    // 聚合器：全部根行动保留（trials=0 的仅先验）。
    const aggregates = screened.map(({ action, prior }) => ({
      action, prior, trials: 0, sum: 0, sqSum: 0,
    }));
    const cloneMs = { value: 0 };
    const omTimeMs = { value: 0 };
    let transitions = 0;
    let rollouts = 0;
    let finishedTrajectories = 0;

    // 轨迹内墙钟硬上限（预算模式）：deadline = 总预算尾部留 5% 余量给聚合与回退。
    // 每条轨迹额外保证 PER_TRIAL_FLOOR_MS 的最小深度窗口：预算尾端启动的轨迹
    // 若只跑到总 deadline 就会以近零转移的"立即后继估值"灌进聚合（实测把
    // js2-2p 分差从 −18.7 恶化到 −44.4）。保底窗口让尾端轨迹也有有意义深度，
    // 代价是总耗时最多超调 PER_TRIAL_FLOOR_MS（仍在预算 +5% 内）。
    const PER_TRIAL_FLOOR_MS = 5;
    const trialDeadline = opts.workUnits || opts.budgetMs === undefined ? undefined : t0 + opts.budgetMs * 0.95;
    /** 首条轨迹的行动日志（对手采样解释输出）。 */
    let firstTrialActorLog: RolloutContext['actorLog'] | undefined;
    const runTrial = (index: number, trialIndex: number, withEvents: boolean): number => {
      const entry = aggregates[index];
      const forkStart = performance.now();
      const events = withEvents ? ([] as NonNullable<RolloutContext['events']>) : undefined;
      const actorLog = withEvents ? ([] as NonNullable<RolloutContext['actorLog']>) : undefined;
      const trialEnd = trialDeadline === undefined ? undefined : Math.max(trialDeadline, forkStart + PER_TRIAL_FLOOR_MS);
      const ctx: RolloutContext = { ...baseCtx, events, omTimeMs, deadline: trialEnd, actorLog };
      if (withEvents) firstTrialActorLog = actorLog;
      let value: number;
      let used: number;
      if (opts.variant === 'joint-tree') {
        const treeCtx: TreeContext = { ...ctx, treeBranching: opts.treeBranching, treeDepth: opts.treeDepth };
        const outcome = runJointTreeTrial(root, entry.action, trialIndex, opts.simSeed, treeCtx);
        value = outcome.value;
        used = outcome.transitions;
      } else {
        const outcome = runJointRollout(root, entry.action, trialIndex, opts.simSeed, ctx);
        value = outcome.value;
        used = outcome.transitions;
        if (outcome.finished) finishedTrajectories += 1;
      }
      cloneMs.value += performance.now() - forkStart;
      transitions += used;
      rollouts += 1;
      entry.trials += 1;
      entry.sum += value;
      entry.sqSum += value * value;
      if (events) chosenEventsRef.push(...events);
      return value;
    };

    // 首条轨迹的事件采集（选定行动不重跑：直接采集先验最优首条轨迹的市场事件）。
    const chosenEventsRef: NonNullable<DecisionTrace['marketEvents']> = [];

    const deadline = opts.workUnits ? Infinity : (opts.budgetMs !== undefined ? t0 + opts.budgetMs : Infinity);
    const trialTarget = opts.workUnits ?? Infinity;
    const M = topMFor(opts.workUnits, aggregates.length);

    // 阶段 1：top-M 候选保底各 1 次（首条轨迹挂事件采集）。
    // 终止用 trialDeadline：保底轨迹必须在轨迹级硬上限前启动，否则会孵化
    // 零转移轨迹（实测缺陷，见阶段 2 注释）。
    const trialLaunchDeadline = trialDeadline ?? deadline;
    for (let i = 0; i < M; i++) {
      if (rollouts >= trialTarget || performance.now() > trialLaunchDeadline) break;
      runTrial(i, rollouts, i === 0);
    }

    // 阶段 2：top-M 均匀轮转（round-robin）。设计说明：单条联合轨迹的叶值方差
    // 大（σ≈0.2-0.3），在 ≤64 trial 的现实预算下 UCB 的探索项会向早期幸运行动
    // 过度集中（实测）；均匀轮转在同等预算下给出更低的比较噪声，符合任务 C.5
    // "按潜力分配预算"的意图（潜力筛选 = 先验 top-M）。未试高先验行动的
    // 晋升窗口保留（M+4 名内、σ(prior/8)+0.25 超过当前最佳已试均值时晋升一次）。
    // 循环终止用 trialDeadline（轨迹级硬上限）而非总 deadline——否则最后 5%
    // 窗口会孵化数百条零转移轨迹并把根状态叶子值灌进聚合（实测缺陷）。
    const normalizedPriorOf = (p: number) => 1 / (1 + Math.exp(-p / 8));
    const promotionEligible = Math.min(aggregates.length, M + 4);
    let guard = 0;
    let cursor = 0;
    while (rollouts < trialTarget && performance.now() < trialLaunchDeadline && guard < 100_000) {
      guard += 1;
      // 晋升检查：资格窗口内未试行动的归一先验显著超过已试最佳均值时插入。
      let promoteIndex = -1;
      let bestTriedMean = -Infinity;
      for (let i = 0; i < M; i++) {
        if (aggregates[i].trials > 0) bestTriedMean = Math.max(bestTriedMean, aggregates[i].sum / aggregates[i].trials);
      }
      for (let i = M; i < promotionEligible; i++) {
        const a = aggregates[i];
        if (a.trials === 0 && normalizedPriorOf(a.prior) + UNTRIED_BONUS > bestTriedMean) { promoteIndex = i; break; }
      }
      const index = promoteIndex >= 0 ? promoteIndex : cursor % M;
      runTrial(index, rollouts, false);
      cursor = promoteIndex >= 0 ? cursor : cursor + 1;
    }

    // 聚合输出：已试行动（trials>0）按 mean 降序在前；未试行动按先验降序随其后。
    // 未试行动的 mean 披露为归一先验 σ(prior/8)（与评价同尺度的诚实代理，非模拟结果）。
    const normalizedPrior = (p: number) => 1 / (1 + Math.exp(-p / 8));
    const evaluations: RootActionEvaluation[] = aggregates.map(a => {
      const mean = a.trials > 0 ? a.sum / a.trials : normalizedPrior(a.prior);
      const variance = a.trials > 1 ? Math.max(0, (a.sqSum - a.sum * a.sum / a.trials) / (a.trials - 1)) : null;
      const se = variance !== null ? Math.sqrt(variance / a.trials) : null;
      return {
        action: a.action, prior: a.prior, trials: a.trials, mean,
        se: a.trials > 0 ? (se ?? (a.trials === 1 ? 0 : null)) : null,
      };
    }).sort((x, y) => {
      if (x.trials > 0 && y.trials > 0) return y.mean - x.mean;
      if (x.trials > 0) return -1;
      if (y.trials > 0) return 1;
      return y.prior - x.prior;
    });

    // 最终选优：仅在 trials ≥ 2 的行动中取 mean − λ·se 最大者（低样本行动的
    // 单次幸运值不得赢得选优）；无 trials ≥ 2 行动时回退最高均值已试行动；
    // 全部行动零模拟完成时（慢机上筛选即耗尽极小预算）回退先验最优行动——
    // 任务 F 要求超时/异常时回退已验证的合法决策，绝不抛错。
    const tried = evaluations.filter(e => e.trials > 0);
    let bestEval: RootActionEvaluation;
    if (tried.length === 0) {
      bestEval = evaluations[0]; // screened 已按先验降序；全部未试 = 先验最优
    } else {
      bestEval = tried.reduce((best, e) => (e.mean > best.mean ? e : best), tried[0]);
      let robustScore = -Infinity;
      for (const e of tried) {
        if (e.trials < 2 || e.se === null) continue;
        const score = e.mean - ROBUST_LAMBDA * e.se;
        if (score > robustScore) { robustScore = score; bestEval = e; }
      }
    }

    const rejected = evaluations
      .filter(e => e !== bestEval && e.trials > 0)
      .slice(0, 3)
      .map(e => ({
        action: e.action,
        mean: e.mean,
        why: e.se !== null && bestEval.se !== null && e.mean > bestEval.mean
          ? `均值更高但方差更大（se=${e.se.toFixed(3)}），稳健分（mean−0.25·se）低于选定行动`
          : `预期第一名率 ${e.mean.toFixed(3)} 低于选定行动 ${bestEval.mean.toFixed(3)}（样本 ${e.trials}）`,
      }));

    const elapsedMs = performance.now() - t0;
    const budgetExhausted = !opts.workUnits && opts.budgetMs !== undefined && elapsedMs >= opts.budgetMs * 0.98;

    const trace: DecisionTrace = {
      root: { turnNumber: observation.turnNumber, current: observation.current, golemMarket: [...observation.golemMarket], phase: observation.phase },
      evaluations,
      rejected,
      marketEvents: chosenEventsRef ?? [],
      opponentSamples: (firstTrialActorLog ?? [])
        .filter(x => x.seat !== mySeat)
        .slice(0, 12)
        .map(x => ({ seat: x.seat, family: x.family ?? 'unknown', action: x.label ?? JSON.stringify(x.action), p: x.p ?? 0 })),
    };

    const chosenAction = bestEval.action;
    // 合法性防御（任务 F：超时/异常回退合法决策）：
    // 根行动来自全量合法枚举，结构上合法；此处再经模拟器试探步兜底。
    const legalityProbe = root.fork();
    let legal = true;
    try { legalityProbe.step(chosenAction); } catch { legal = false; }
    if (!legal) {
      let fallbackFound = false;
      for (const e of evaluations) {
        const probe = root.fork();
        try { probe.step(e.action); bestEval = e; fallbackFound = true; break; } catch { /* 继续找 */ }
      }
      if (!fallbackFound) throw new Error('全部根行动合法性试探失败（规则层缺陷）');
    }

    const golemTag = (a: Action) => (a.type === 'claim' && GOLEM_BY_ID[observation.golemMarket[a.index]] ? `（${observation.golemMarket[a.index]}，${GOLEM_BY_ID[observation.golemMarket[a.index]].points} 分）` : '');
    return {
      action: bestEval.action,
      reason: `${this.versionId ?? 'joint'} ${opts.variant}/${opts.opponentMode}/${opts.evaluator}：预期第一名率 ${(bestEval.trials > 0 ? bestEval.mean : bestEval.prior).toFixed(3)}（${bestEval.trials} 条联合轨迹，se=${bestEval.se?.toFixed(3) ?? 'n/a'}）${golemTag(bestEval.action)}`,
      evaluations,
      chosen: bestEval,
      trace,
      stats: {
        rollouts,
        transitions,
        elapsedMs,
        budgetExhausted,
        omTimeMs: omTimeMs.value,
        cloneMs: cloneMs.value,
        legalGenMs,
        rootActions: legalRootActions.length,
        candidateCount: M,
      },
    };
  }
}

/** 创建 JointPlanner（versionId 绑定缺省配置；任务 A 推荐接口）。 */
export function createJointPlanner(versionId?: string): JointPlanner {
  return new JointPlannerV1(versionId);
}
