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
 * 4. 高竞争：候选 = 冠军行动 ∪ 立即认领 ∪ 先验 top（≤ candidateCap），
 *    进入联合 rollout（多世界 CRN 配对、对手模式可选、正式规则转移）；
 * 5. 保守覆盖：挑战候选的稳健分（mean − 0.25·se）必须超过冠军候选
 *    overrideMargin 才覆盖——置信不足时保持冠军行动（默认保守）。
 *
 * 与 P0 修复的关系：立即认领不被未来存活折扣惩罚（P0-2）；多世界采样 +
 * CRN 配对（P1-1）；全部转移经 PublicSimulation（正式引擎锚定）；终局值
 * 用正式 ranking。
 *
 * AI6 第五阶段修改（稳健性验证，全部保持冻结缺省语义不变）：
 * - C1 平衡批次提交：试验调度以"完整 (world × candidate) 批次"为提交单位，
 *   预算在批次中途耗尽时整批不启动（部分批次绝不入账）——修复 v1 网格
 *   中途截断时早排候选（index 0 = 冠军行动）获得更多试验的系统性偏差；
 * - B root 延迟创建：非门控决策只创建 roots[0]（合法行动/gating 所需），
 *   其余信念世界仅在门控触发后创建（内容确定性不变，决策逐位一致，
 *   每次非门控决策省 W−1 次 createSimulation）；
 * - B survival 缓存：golemSurvivalModel 每决策只算一次（gating 与根筛选共享）；
 * - B 阶段计时：stats 分相披露 plan/rootSim/legalGen/gate/screen/rollout/aggregate；
 * - A3 语义修正：叶子聚合值是"未校准联合模拟评价值"（L2 = logistic 启发式
 *   margin 映射），不是经校准的获胜概率——reason/why 字符串与文档同步修正；
 * - C2 collectTrials：JS5 补齐逐试验披露（P1-1 CRN 结构验证通道此前
 *   只在 planner（JS2-4）实现，js5 被静默忽略）；
 * - C2/E 诊断选项：claimRanking（缺省 enumeration = PR #27 原始语义；
 *   prior = js5-opt 消融用）、gatedReason 披露。
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

/** 叶子聚合值的统计口径（A3 语义修正）：未校准联合模拟评价值。
 * L0–L3 叶子评价器输出 logistic 映射的启发式胜率近似，未证明是充分校准的
 * 获胜概率；只有到达终局的轨迹值（0/1）才是真实第一名结果。对外披露时
 * 不得将本值直接称为"预期第一名率"。 */
export const LEAF_VALUE_SEMANTICS = 'uncalibrated-joint-simulation-value' as const;

/** JS5 专属选项（JointSearchOptions 的竞争结构扩展）。 */
export type ChampionGuidedOptions = {
  /** 冠军结构（缺省 beam-rollout = 冻结冠军语义）。 */
  championStructure?: AIStructure;
  /** 冠军参数（缺省冻结冠军参数集；消融用）。 */
  championParameters?: AIParameters;
  /** 竞争门控：auto=按风险开启（缺省）；always=消融对照（始终联合评估）；
   * never=纯冠军直通（消融下界）；rerank=路线1"冠军候选+竞争风险重排序"
   * （无模拟：候选按存活调整先验取 argmax——任务书 §四四路线消融对照）。 */
  gateMode?: 'auto' | 'always' | 'never' | 'rerank';
  /** 保守覆盖边际（挑战候选须超过冠军候选的稳健分幅度；缺省 0.02）。 */
  overrideMargin?: number;
  /** 联合评估候选上限（含冠军行动；缺省 4）。 */
  candidateCap?: number;
  /** 目标存活低于该阈值视为争议目标（缺省 0.85）。 */
  contestThreshold?: number;
  /** 立即认领候选进入联合评估的选取原则（缺省 enumeration = PR #27 原始语义：
   * 合法枚举顺序前 2 个；prior = js5-opt 消融：按根筛选先验降序取前 2）。 */
  claimRanking?: 'enumeration' | 'prior';
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
 * 我可立即认领的目标不构成"被抢"风险（P0-2 语义：当步可执行，无插足机会）。
 * survival 允许调用方传入预计算表（每决策只算一次；缺省时内部计算）。 */
export function competitionRisk(
  view: AIObservation,
  options: { contestThreshold: number; immediateClaims: ReadonlySet<string>; survival?: Record<string, number> },
): { gated: boolean; contestedGoals: string[] } {
  if (view.triggerPlayer !== null) {
    // 终局已触发：每个对手都可能在整轮结算内认领达标，目标价值随时重排。
    return { gated: true, contestedGoals: [...view.golemMarket] };
  }
  const survival = options.survival ?? golemSurvivalModel(view, 6);
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

/** 稳健分（与 planner 同口径：mean − 0.25·se）。
 * 诚实性边界（第五阶段 C2）：这是"均值减惩罚项"的启发式保守选择规则，
 * 不是经过独立证明的统计置信下界——不得在任何报告中把它描述为具有
 * 严格统计保证的最优性判定。λ=0.25 的取值来自 PR #27 调参块的消融，
 * 仅有经验性支持。 */
const ROBUST_LAMBDA = 0.25;

/** 阶段计时器（B1 分相画像；stats 分相披露）。 */
type PhaseTimings = {
  planMs: number; rootSimMs: number; legalGenMs: number; gateMs: number;
  screenMs: number; rolloutMs: number; aggregateMs: number;
};

class ChampionGuidedPlanner {
  decide(observation: AIObservation, callOptions?: ChampionGuidedSearchOptions): ChampionGuidedDecision {
    const o = resolveChampionGuidedOptions(callOptions);
    const t0 = performance.now();
    const phase: PhaseTimings = { planMs: 0, rootSimMs: 0, legalGenMs: 0, gateMs: 0, screenMs: 0, rolloutMs: 0, aggregateMs: 0 };
    if (observation.phase === 'finished') fail('游戏已结束，无法决策');
    const mySeat = observation.playerId;
    if (observation.current !== mySeat) fail('观察席位不是当前行动者');

    // 1. 冠军规划（冻结参数 + 显式结构；人格经 profileOverride 注入）。
    const profile: Profile = o.profileName ? profileByName(o.profileName) : NEUTRAL_PROFILE;
    const planStart = performance.now();
    const plan = choosePlan(observation, o.championParameters ?? CHAMPION_PARAMETERS, profile, o.championStructure ?? 'beam-rollout');
    phase.planMs = performance.now() - planStart;
    const championAction: Action | null = plan?.first ?? null;

    // 溢出阶段在 adapter 层处理（champion trimStock 口径），不会进入这里。

    // 2. 根模拟（B：先只建 roots[0]——合法行动与 gating 所需；其余信念世界
    //    仅在门控触发后创建，内容确定性不变，非门控决策省 W−1 次构造）。
    const worldCount = Math.max(1, Math.min(8, Math.floor(o.worlds ?? 4)));
    const rootSimStart = performance.now();
    const root = createSimulation(observation, { simSeed: worldSeed(o.simSeed ?? 0, 0), historySummary: o.historySummary });
    let rootsCreated = 1;
    const roots: PublicSimulation[] = [root];
    const legalStart = performance.now();
    const legalRootActions = enumerateLegalActions(root.view, { dedupe: true });
    phase.legalGenMs = performance.now() - legalStart;
    phase.rootSimMs = performance.now() - rootSimStart;
    if (!legalRootActions.length) fail('根状态无合法行动（规则引擎不一致）');
    const immediateClaimGoals = new Set<string>(
      legalRootActions.filter(a => a.type === 'claim').map(a => observation.golemMarket[a.index]),
    );

    // 3. 竞争检测（公开信息；survival 只算一次，gating 与根筛选共享——
    //    v1 在 competitionRisk 与根筛选各算一次；无条件计算保持 gate=never
    //    审计模式下 contestedGoals 披露与 v1 逐字段一致）。
    const gateStart = performance.now();
    const survival = golemSurvivalModel(observation, 6);
    const risk = competitionRisk(observation, {
      contestThreshold: o.contestThreshold ?? 0.85,
      immediateClaims: immediateClaimGoals,
      survival,
    });
    const gated = o.gateMode === 'always' ? true : o.gateMode === 'never' ? false : risk.gated;
    phase.gateMs = performance.now() - gateStart;

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
          omTimeMs: 0, cloneMs: 0, legalGenMs: phase.legalGenMs, rootActions: legalRootActions.length,
          candidateCount: 0, worldsUsed: worldCount,
          planMs: phase.planMs, rootSimMs: phase.rootSimMs, gateMs: phase.gateMs,
          screenMs: 0, rolloutMs: 0, aggregateMs: 0, rootSimulationsCreated: rootsCreated,
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
    const screenStart = performance.now();
    const ctxRoot = heuristicContext(root.view, CHAMPION_PARAMETERS, NEUTRAL_PROFILE);
    const screened = screenRootActions(observation, legalRootActions, ctxRoot, survival);
    phase.screenMs = performance.now() - screenStart;
    const candidates: Action[] = [];
    const priorOf = new Map<string, number>();
    const seen = new Set<string>();
    const push = (a: Action | null | undefined) => {
      if (!a) return;
      const k = actionKey(a);
      if (seen.has(k)) return;
      seen.add(k);
      candidates.push(a);
    };
    push(championAction);
    // C2：立即认领候选的选取原则（缺省 enumeration = PR #27 原始语义；
    // prior 模式按根筛选先验降序取前 2，避免枚举顺序偶然排除高分认领）。
    const claimActions = legalRootActions.filter(x => x.type === 'claim');
    if (o.claimRanking === 'prior') {
      const priorOfAction = new Map(claimActions.map(a => [actionKey(a), screened.find(s => actionKey(s.action) === actionKey(a))?.prior ?? -Infinity]));
      claimActions.sort((x, y) => (priorOfAction.get(actionKey(y)) ?? -Infinity) - (priorOfAction.get(actionKey(x)) ?? -Infinity));
    }
    for (const a of claimActions.slice(0, 2)) push(a);
    for (const { action, prior } of screened) {
      if (candidates.length >= (o.candidateCap ?? 4)) break;
      push(action);
    }
    if (!candidates.length) fail('候选构造为空（规则层缺陷）');
    // 候选先验表（rerank 路线与冠军行动缺省回退用；screened 覆盖全部合法行动）。
    for (const { action, prior } of screened) priorOf.set(actionKey(action), prior);
    const championKey = championAction ? actionKey(championAction) : null;

    // 门控触发后补齐其余信念世界（B：内容确定性不变——同 (observation, worldSeed)）。
    if (worldCount > 1) {
      const moreStart = performance.now();
      for (let w = 1; w < worldCount; w++) {
        roots.push(createSimulation(observation, { simSeed: worldSeed(o.simSeed ?? 0, w), historySummary: o.historySummary }));
        rootsCreated += 1;
      }
      phase.rootSimMs += performance.now() - moreStart;
    }

    // 路线 1（gateMode='rerank'）：无模拟——候选按存活调整先验取 argmax，
    // 冠军行动以自身先验参与竞争（不享受任何特殊保护）。成本 ≈ 冠军规划 + 筛选。
    if (o.gateMode === 'rerank') {
      let bestIdx = 0;
      let bestPrior = -Infinity;
      candidates.forEach((a, i) => {
        const p = priorOf.get(actionKey(a)) ?? -Infinity;
        if (p > bestPrior) { bestPrior = p; bestIdx = i; }
      });
      const chosen = candidates[bestIdx];
      const elapsedRerank = performance.now() - t0;
      return {
        action: chosen,
        reason: `js5 rerank（路线1：先验重排序，无模拟）：先验 ${(bestPrior).toFixed(3)}${actionKey(chosen) === championKey ? '（=冠军行动）' : '（覆盖冠军）'}`,
        evaluations: candidates.map(a => ({ action: a, prior: priorOf.get(actionKey(a)) ?? -Infinity, trials: 0, mean: 0, se: null })),
        chosen: { action: chosen, prior: bestPrior, trials: 0, mean: 0, se: null },
        trace: { root: { turnNumber: observation.turnNumber, current: observation.current, golemMarket: [...observation.golemMarket], phase: observation.phase }, evaluations: [], rejected: [] },
        stats: {
          rollouts: 0, transitions: 0, elapsedMs: elapsedRerank, budgetExhausted: false,
          omTimeMs: 0, cloneMs: 0, legalGenMs: phase.legalGenMs, rootActions: legalRootActions.length,
          candidateCount: candidates.length, worldsUsed: worldCount,
          planMs: phase.planMs, rootSimMs: phase.rootSimMs, gateMs: phase.gateMs,
          screenMs: phase.screenMs, rolloutMs: 0, aggregateMs: 0, rootSimulationsCreated: rootsCreated,
        },
        championAction,
        gated: true,
        contestedGoals: risk.contestedGoals,
      };
    }

    // 5. 联合评估（多世界 CRN；C1 平衡批次提交：以完整 (world × candidate)
    //    批次为入账单位，杜绝预算截断时早排候选多试验的系统性偏差）。
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
    const trialsLog: { actionIndex: number; world: number; replica: number; value: number }[] | undefined = o.collectTrials === true ? [] : undefined;
    const omTimeMs = { value: 0 };
    let transitions = 0;
    let rollouts = 0;
    const workUnits = o.workUnits;
    // 防御性默认：budgetMs 与 workUnits 均未给定时按 100ms 墙钟预算（与 planner 同纪律）。
    const budgetMs = o.budgetMs ?? (workUnits !== undefined ? undefined : 100);
    const trialDeadline = workUnits || budgetMs === undefined ? undefined : t0 + budgetMs * 0.95;
    const PER_TRIAL_FLOOR_MS = 5;
    const M = candidates.length;
    const rolloutStart = performance.now();
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
      trialsLog?.push({ actionIndex: index, world, replica, value: outcome.value });
      return outcome.value;
    };
    /** 完整批次 = 同一 replica 下全部 (world × candidate) 试验。批次一旦启动
     * 全部入账（部分批次绝不出现）⇒ 任意截断点上各候选试验数之差 < M
     * 且 (world, replica) 键集严格相同（CRN 配对成立）。 */
    const runBatch = (replica: number): void => {
      for (let w = 0; w < worldCount; w++) {
        for (let i = 0; i < M; i++) runTrial(i, w, replica);
      }
    };
    if (workUnits !== undefined) {
      // 固定工作量模式（确定性）：完整批次向下取整（每候选严格等试验数；
      // workUnits < W×M 时按最小粒度 1 个完整批次执行并披露）。
      const passes = Math.max(1, Math.floor(workUnits / (worldCount * M)));
      for (let r = 0; r < passes; r++) runBatch(r);
    } else {
      // 墙钟预算模式：批次启动前预检（预留 batchFloorMs 保证批内每条轨迹
      // 至少 PER_TRIAL_FLOOR_MS 深度窗口，避免近零深度轨迹污染聚合——
      // PR #27 trialLaunchDeadline 教训的批次化版本）。
      const batchFloorMs = M * PER_TRIAL_FLOOR_MS;
      let pass = 0;
      while (pass < 100_000 && trialDeadline !== undefined
        && performance.now() + batchFloorMs <= trialDeadline) {
        runBatch(pass);
        pass += 1;
      }
    }
    phase.rolloutMs = performance.now() - rolloutStart;

    // 6. 聚合 + 保守覆盖。
    const aggregateStart = performance.now();
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
    phase.aggregateMs = performance.now() - aggregateStart;
    const rejected = evaluations
      .filter(e => e !== bestEval && e.trials > 0)
      .slice(0, 3)
      .map(e => ({
        action: e.action,
        mean: e.mean,
        why: e === championEval
          ? `冠军行动（稳健分 ${robustScoreOf(e).toFixed(3)}）未被超越（边际 ${(o.overrideMargin ?? 0.02).toFixed(3)}）`
          : `联合模拟评价值（未校准）${e.mean.toFixed(3)} 低于选定行动（样本 ${e.trials}）`,
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
      reason: `js5 ${gated ? '联合仲裁' : '冠军直通'}：${bestEval === championEval ? '保持冠军行动' : '覆盖为联合最优'}（联合模拟评价值 ${bestEval.mean.toFixed(3)}，未校准胜率近似，${bestEval.trials} 轨迹 × ${worldCount} 世界，争议目标 ${risk.contestedGoals.join(',') || '无'}）${golemTag(bestEval.action)}`,
      evaluations,
      chosen: { action: bestEval.action, prior: 0, trials: bestEval.trials, mean: bestEval.mean, se: bestEval.se },
      trace,
      stats: {
        rollouts, transitions, elapsedMs,
        budgetExhausted: !workUnits && budgetMs !== undefined && elapsedMs >= budgetMs * 0.98,
        omTimeMs: omTimeMs.value, cloneMs: 0, legalGenMs: phase.legalGenMs,
        rootActions: legalRootActions.length, candidateCount: M, worldsUsed: worldCount,
        planMs: phase.planMs, rootSimMs: phase.rootSimMs, gateMs: phase.gateMs,
        screenMs: phase.screenMs, rolloutMs: phase.rolloutMs, aggregateMs: phase.aggregateMs,
        rootSimulationsCreated: rootsCreated,
      } satisfies JointDecisionStats,
      ...(trialsLog ? { trials: trialsLog } : {}),
      championAction,
      gated: true,
      contestedGoals: risk.contestedGoals,
    };
  }
}

/** 选项解析：显式缺省集中在一处（JS5 全部参数显式可审计）。 */
function resolveChampionGuidedOptions(o?: ChampionGuidedSearchOptions): Required<Pick<ChampionGuidedOptions, 'championStructure' | 'gateMode' | 'overrideMargin' | 'candidateCap' | 'contestThreshold' | 'claimRanking'>> & ChampionGuidedSearchOptions {
  const base = o ?? {};
  return {
    ...base,
    championStructure: base.championStructure ?? 'beam-rollout',
    gateMode: base.gateMode ?? 'auto',
    overrideMargin: base.overrideMargin ?? 0.02,
    candidateCap: base.candidateCap ?? 4,
    contestThreshold: base.contestThreshold ?? 0.85,
    claimRanking: base.claimRanking ?? 'enumeration',
  };
}

/** 创建 JS5 规划器（无状态；选项经 decide 注入，评测按版本+选项显式配置）。 */
export function createChampionGuidedPlanner(): ChampionGuidedPlanner {
  return new ChampionGuidedPlanner();
}
