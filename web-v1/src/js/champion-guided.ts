/** JS5：Champion-Guided Joint Search（PR #26 修复后的第二阶段新架构）。
 *
 * 动机（PR #26 根因审计结论）：联合搜索 V1 的失败根源不是时序机制错误
 * （P0-1 已修复），而是轨迹内 1-ply 贪心自博弈策略的棋力远低于冠军
 * 6 层束搜索——先用弱策略替换冠军规划、再期望更复杂的多人搜索提高胜率
 * 是结构倒置。JS5 反转该结构：冠军规划始终在场，联合搜索只在竞争证据
 * 支持时对冠军候选做保守仲裁。
 *
 * 流程（Champion-Guided Joint Search）：
 * 1. 冠军束搜索（choosePlan，冻结参数 + 冠军结构）生成默认行动（~10ms）；
 * 2. 竞争检测（公开信息：座位感知目标存活 + 终局触发状态）评估抢牌风险；
 * 3. 低竞争（gate=auto 且无争议目标）：直接返回冠军行动——行为与冻结
 *    冠军一致，联合模拟零开销，绝不用低质量模拟扰动强规划；
 * 4. 高竞争：候选 = 冠军行动 ∪ 立即可支付认领 ∪ 先验 top（≤ candidateCap），
 *    进入联合 rollout（多世界 CRN 配对、对手模式可选、正式规则转移）；
 * 5. 保守覆盖：挑战候选的稳健分（mean − 0.25·se）必须超过冠军候选
 *    overrideMargin 才覆盖——置信不足时保持冠军行动（默认保守）。
 *
 * 与 P0 修复的关系：立即认领不被未来存活折扣惩罚（P0-2）；多世界采样 +
 * CRN 配对（P1-1）；全部转移经 PublicSimulation（正式引擎锚定）；终局值
 * 用正式 ranking。
 */

import type { Action } from '../engine.js';
import { GOLEM_BY_ID } from '../data.js';
import type { AIObservation } from '../ai/observation.js';
import type { AIParameters } from '../ai/parameters.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';
import { choosePlan } from '../ai/planner.js';
import type { AIStructure } from '../ai/structures.js';
import type { Profile } from '../ai/profiles.js';
import { NEUTRAL_PROFILE } from '../ai/profiles.js';
import { createSimulation, type PublicSimulation } from '../sim/session.js';
import { enumerateLegalActions } from '../sim/legal.js';
import { createOpponentModel, type OpponentModel } from '../om/index.js';
import { golemSurvivalModel } from '../ai/opponent-model.js';
import { heuristicContext, screenRootActions } from './rollout-policy.js';
import { runJointRollout, type RolloutContext } from './joint-rollout.js';
import { worldSeed } from './planner.js';
import { profileByName } from './simview.js';
import type {
  JointDecision, JointDecisionStats, JointOpponentMode, JointSearchOptions,
  LeafEvaluatorLevel, RootActionEvaluation, DecisionTrace,
} from './types.js';

const fail = (message: string): never => { throw new Error(message); };

/** JS5 专属选项（JointSearchOptions 的竞争结构扩展）。 */
export type ChampionGuidedOptions = {
  /** 冠军结构（缺省 beam-rollout = 冻结冠军语义）。 */
  championStructure?: AIStructure;
  /** 冠军参数（缺省冻结冠军参数集；消融用）。 */
  championParameters?: AIParameters;
  /** 竞争门控：auto=按风险开启（缺省）；always=消融对照（始终联合评估）；
   * never=纯冠军直通（消融下界）。 */
  gateMode?: 'auto' | 'always' | 'never';
  /** 保守覆盖边际（挑战候选须超过冠军候选的稳健分幅度；缺省 0.02）。 */
  overrideMargin?: number;
  /** 联合评估候选上限（含冠军行动；缺省 4）。 */
  candidateCap?: number;
  /** 目标存活低于该阈值视为争议目标（缺省 0.85）。 */
  contestThreshold?: number;
};

export type ChampionGuidedSearchOptions = JointSearchOptions & ChampionGuidedOptions;

export type ChampionGuidedDecision = JointDecision & {
  /** 冠军规划行动（联合仲裁的锚点；choosePlan 无解时为 null）。 */
  championAction: Action | null;
  /** 本次决策是否进入联合评估（gate=false 时行为 = 冻结冠军）。 */
  gated: boolean;
  /** 争议目标（公开信息推导）。 */
  contestedGoals: string[];
};

/** 竞争检测（任务：竞争检测模块识别抢牌、座位顺序、目标存活及终局风险）。
 * 只用公开信息：golemSurvivalModel（冠军 M1 模型）+ 终局触发状态。
 * 我可立即认领的目标不构成"被抢"风险（P0-2 语义：当步可执行，无插足机会）。 */
export function competitionRisk(
  view: AIObservation,
  options: { contestThreshold: number; immediateClaims: ReadonlySet<string> },
): { gated: boolean; contestedGoals: string[] } {
  if (view.triggerPlayer !== null) {
    // 终局已触发：每个对手都可能在整轮结算内认领达标，目标价值随时重排。
    return { gated: true, contestedGoals: [...view.golemMarket] };
  }
  const survival = golemSurvivalModel(view, 6);
  const contestedGoals = view.golemMarket.filter(id =>
    !options.immediateClaims.has(id) && (survival[id] ?? 1) < options.contestThreshold);
  return { gated: contestedGoals.length > 0, contestedGoals };
}

const actionKey = (a: Action): string => JSON.stringify(a);

/** 共享对手模型（与 planner 同配置；om-v1 模式时使用）。 */
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

/** 稳健分（与 planner 同口径：mean − 0.25·se）。 */
const ROBUST_LAMBDA = 0.25;

class ChampionGuidedPlanner {
  decide(observation: AIObservation, callOptions?: ChampionGuidedSearchOptions): ChampionGuidedDecision {
    const o = resolveChampionGuidedOptions(callOptions);
    const t0 = performance.now();
    if (observation.phase === 'finished') fail('游戏已结束，无法决策');
    const mySeat = observation.playerId;
    if (observation.current !== mySeat) fail('观察席位不是当前行动者');

    // 1. 冠军规划（冻结参数 + 显式结构；人格经 profileOverride 注入）。
    const profile: Profile = o.profileName ? profileByName(o.profileName) : NEUTRAL_PROFILE;
    const plan = choosePlan(observation, o.championParameters ?? CHAMPION_PARAMETERS, profile, o.championStructure ?? 'beam-rollout');
    const championAction: Action | null = plan?.first ?? null;

    // 溢出阶段在 adapter 层处理（champion trimStock 口径），不会进入这里。

    // 2. 根模拟（多世界）+ 合法根行动 + 立即认领集合（P0-2 语义）。
    const worldCount = Math.max(1, Math.min(8, Math.floor(o.worlds ?? 4)));
    const roots: PublicSimulation[] = [];
    for (let w = 0; w < worldCount; w++) {
      roots.push(createSimulation(observation, { simSeed: worldSeed(o.simSeed ?? 0, w), historySummary: o.historySummary }));
    }
    const root = roots[0];
    const legalRootActions = enumerateLegalActions(root.view, { dedupe: true });
    if (!legalRootActions.length) fail('根状态无合法行动（规则引擎不一致）');
    const immediateClaimGoals = new Set<string>(
      legalRootActions.filter(a => a.type === 'claim').map(a => observation.golemMarket[a.index]),
    );

    // 3. 竞争检测（公开信息）。
    const risk = competitionRisk(observation, {
      contestThreshold: o.contestThreshold ?? 0.85,
      immediateClaims: immediateClaimGoals,
    });
    const gated = o.gateMode === 'always' ? true : o.gateMode === 'never' ? false : risk.gated;

    // 低竞争：冠军直通（行为 = 冻结冠军；无联合模拟）。
    if (!gated) {
      const action = championAction ?? legalRootActions[0];
      const elapsedMs = performance.now() - t0;
      return {
        action,
        reason: `js5 冠军直通（无争议目标：[${risk.contestedGoals.join(',') || '无'}]）：${plan?.preferred ?? '无规划目标'}`,
        evaluations: [],
        chosen: { action, prior: 0, trials: 0, mean: 0, se: null },
        trace: { root: { turnNumber: observation.turnNumber, current: observation.current, golemMarket: [...observation.golemMarket], phase: observation.phase }, evaluations: [], rejected: [] },
        stats: {
          rollouts: 0, transitions: 0, elapsedMs, budgetExhausted: false,
          omTimeMs: 0, cloneMs: 0, legalGenMs: 0, rootActions: legalRootActions.length,
          candidateCount: 0, worldsUsed: worldCount,
        },
        championAction,
        gated: false,
        contestedGoals: risk.contestedGoals,
      };
    }

    // 4. 候选构造：冠军行动 ∪ 立即认领 ∪ 先验 top（≤ candidateCap）。
    //    根筛选维持 'all' 全目标口径（与 JS2-4 同语义，保证消融可比性）。
    //    实测记录：3p 中局慢决策的尾部成本来自冠军束搜索本身（choosePlan
    //    72-103ms，状态依赖；js0 同样承担），根筛选仅 3-10ms——预算尾部
    //    不足以试验时自然回退冠军行动（保守覆盖语义的退化情形）。
    const ctxRoot = heuristicContext(root.view, CHAMPION_PARAMETERS, NEUTRAL_PROFILE);
    const survival = golemSurvivalModel(observation, 6);
    const screened = screenRootActions(observation, legalRootActions, ctxRoot, survival);
    const candidates: Action[] = [];
    const seen = new Set<string>();
    const push = (a: Action | null | undefined) => {
      if (!a) return;
      const k = actionKey(a);
      if (seen.has(k)) return;
      seen.add(k);
      candidates.push(a);
    };
    push(championAction);
    for (const a of legalRootActions.filter(x => x.type === 'claim').slice(0, 2)) push(a);
    for (const { action } of screened) {
      if (candidates.length >= (o.candidateCap ?? 4)) break;
      push(action);
    }
    if (!candidates.length) fail('候选构造为空（规则层缺陷）');

    // 5. 联合评估（多世界 CRN 平衡调度；与 planner 同纪律）。
    const opponentMode: JointOpponentMode = o.opponentMode ?? 'rule';
    const evaluator: LeafEvaluatorLevel = o.evaluator ?? 'L2';
    const om = opponentMode === 'om-v1' ? (o.opponentModel ?? sharedOpponentModel()) : null;
    const baseCtx = {
      mySeat,
      mode: opponentMode,
      evaluator,
      horizon: o.horizon ?? 48,
      om,
      profileName: o.profileName,
    } satisfies Omit<RolloutContext, 'events' | 'omTimeMs'>;

    const aggregates = candidates.map(action => ({ action, trials: 0, sum: 0, sqSum: 0 }));
    const omTimeMs = { value: 0 };
    let transitions = 0;
    let rollouts = 0;
    const workUnits = o.workUnits;
    // 防御性默认：budgetMs 与 workUnits 均未给定时按 100ms 墙钟预算（与 planner 同纪律）。
    const budgetMs = o.budgetMs ?? (workUnits !== undefined ? undefined : 100);
    const trialDeadline = workUnits || budgetMs === undefined ? undefined : t0 + budgetMs * 0.95;
    const PER_TRIAL_FLOOR_MS = 5;
    const M = candidates.length;
    const replicasPlanned = workUnits ? Math.max(1, Math.floor(workUnits / (worldCount * M))) : Infinity;
    const trialTarget = workUnits ?? Infinity;
    const budgetExceeded = (): boolean => trialDeadline !== undefined && performance.now() > trialDeadline;
    const runTrial = (index: number, world: number, replica: number): number => {
      const entry = aggregates[index];
      const forkStart = performance.now();
      const trialEnd = trialDeadline === undefined ? undefined : Math.max(trialDeadline, forkStart + PER_TRIAL_FLOOR_MS);
      const ctx: RolloutContext = { ...baseCtx, omTimeMs, deadline: trialEnd };
      const outcome = runJointRollout(roots[world % roots.length], entry.action, world, replica, o.simSeed ?? 0, ctx);
      transitions += outcome.transitions;
      rollouts += 1;
      entry.trials += 1;
      entry.sum += outcome.value;
      entry.sqSum += outcome.value * outcome.value;
      return outcome.value;
    };
    let pass = 0;
    for (let r = 0; r < replicasPlanned; r++) {
      for (let w = 0; w < worldCount; w++) {
        for (let i = 0; i < M; i++) {
          if (rollouts >= trialTarget || budgetExceeded()) break;
          runTrial(i, w, r);
        }
        if (rollouts >= trialTarget || budgetExceeded()) break;
      }
      if (rollouts >= trialTarget || budgetExceeded()) break;
      pass = r + 1;
    }
    while (!workUnits && !budgetExceeded() && pass < 100_000) {
      for (let w = 0; w < worldCount; w++) {
        for (let i = 0; i < M; i++) {
          if (budgetExceeded()) break;
          runTrial(i, w, pass);
        }
        if (budgetExceeded()) break;
      }
      pass += 1;
    }

    // 6. 聚合 + 保守覆盖。
    const championKey = championAction ? actionKey(championAction) : null;
    const evaluations: RootActionEvaluation[] = aggregates.map(a => {
      const mean = a.trials > 0 ? a.sum / a.trials : 0;
      const variance = a.trials > 1 ? Math.max(0, (a.sqSum - a.sum * a.sum / a.trials) / (a.trials - 1)) : null;
      const se = variance !== null ? Math.sqrt(variance / a.trials) : (a.trials === 1 ? 0 : null);
      return { action: a.action, prior: 0, trials: a.trials, mean, se };
    }).sort((x, y) => y.mean - x.mean);
    const robustScoreOf = (e: RootActionEvaluation) =>
      e.trials > 0 ? e.mean - ROBUST_LAMBDA * (e.se ?? 0) : -Infinity;
    const championEval = championKey ? evaluations.find(e => actionKey(e.action) === championKey) : undefined;
    let bestEval = evaluations[0];
    if (championEval && championEval.trials > 0) {
      // 保守覆盖：仅当挑战者稳健分超过冠军候选 margin 时换行动。
      const championScore = robustScoreOf(championEval);
      let challenger = championEval;
      for (const e of evaluations) {
        if (actionKey(e.action) === championKey) continue;
        if (e.trials < 2) continue; // 单试验挑战者不足以覆盖冠军
        if (robustScoreOf(e) > robustScoreOf(challenger)) challenger = e;
      }
      bestEval = robustScoreOf(challenger) > championScore + (o.overrideMargin ?? 0.02) ? challenger : championEval;
    } else if (championEval) {
      // 冠军行动未获试验（预算极端）：回退冠军行动（冻结冠军语义保底）。
      bestEval = championEval;
    }
    const rejected = evaluations
      .filter(e => e !== bestEval && e.trials > 0)
      .slice(0, 3)
      .map(e => ({
        action: e.action,
        mean: e.mean,
        why: e === championEval
          ? `冠军行动（稳健分 ${robustScoreOf(e).toFixed(3)}）未被超越（边际 ${(o.overrideMargin ?? 0.02).toFixed(3)}）`
          : `预期第一名率 ${e.mean.toFixed(3)} 低于选定行动（样本 ${e.trials}）`,
      }));

    const elapsedMs = performance.now() - t0;
    const trace: DecisionTrace = {
      root: { turnNumber: observation.turnNumber, current: observation.current, golemMarket: [...observation.golemMarket], phase: observation.phase },
      evaluations,
      rejected,
      opponentSamples: [],
    };
    const golemTag = (a: Action) => (a.type === 'claim' && GOLEM_BY_ID[observation.golemMarket[a.index]] ? `（${observation.golemMarket[a.index]}，${GOLEM_BY_ID[observation.golemMarket[a.index]].points} 分）` : '');
    return {
      action: bestEval.action,
      reason: `js5 ${gated ? '联合仲裁' : '冠军直通'}：${bestEval === championEval ? '保持冠军行动' : '覆盖为联合最优'}（预期第一名率 ${bestEval.mean.toFixed(3)}，${bestEval.trials} 轨迹 × ${worldCount} 世界，争议目标 ${risk.contestedGoals.join(',') || '无'}）${golemTag(bestEval.action)}`,
      evaluations,
      chosen: { action: bestEval.action, prior: 0, trials: bestEval.trials, mean: bestEval.mean, se: bestEval.se },
      trace,
      stats: {
        rollouts, transitions, elapsedMs,
        budgetExhausted: !workUnits && budgetMs !== undefined && elapsedMs >= budgetMs * 0.98,
        omTimeMs: omTimeMs.value, cloneMs: 0, legalGenMs: 0,
        rootActions: legalRootActions.length, candidateCount: M, worldsUsed: worldCount,
      } satisfies JointDecisionStats,
      championAction,
      gated: true,
      contestedGoals: risk.contestedGoals,
    };
  }
}

/** 选项解析：显式缺省集中在一处（JS5 全部参数显式可审计）。 */
function resolveChampionGuidedOptions(o?: ChampionGuidedSearchOptions): Required<Pick<ChampionGuidedOptions, 'championStructure' | 'gateMode' | 'overrideMargin' | 'candidateCap' | 'contestThreshold'>> & ChampionGuidedSearchOptions {
  const base = o ?? {};
  return {
    ...base,
    championStructure: base.championStructure ?? 'beam-rollout',
    gateMode: base.gateMode ?? 'auto',
    overrideMargin: base.overrideMargin ?? 0.02,
    candidateCap: base.candidateCap ?? 4,
    contestThreshold: base.contestThreshold ?? 0.85,
  };
}

/** 创建 JS5 规划器（无状态；选项经 decide 注入，评测按版本+选项显式配置）。 */
export function createChampionGuidedPlanner(): ChampionGuidedPlanner {
  return new ChampionGuidedPlanner();
}
