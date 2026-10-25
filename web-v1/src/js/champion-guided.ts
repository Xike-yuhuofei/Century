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
import { CHAMPION_PARAMETERS, validateAIParameters } from '../ai/parameters.js';
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
import {
  nearTerminalRisk, maxImmediateScoreAction, immediateOfficialScoreDelta,
  type ImmediateScoreCandidate, type NearTerminalRisk,
} from './near-terminal.js';
import { isFinalOwnAction, solveFinalAction, type EndgameSolution } from './endgame.js';
import { batchFloors, fitWorlds, type BatchAdmission } from './budget.js';
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
  // === AI7 任务 C1：终局精确求解 ===
  /** 终局圈精确求解（缺省 off = 冻结行为）：触发终局后枚举全部合法行动，
   * 按"保证名次 + 官方最终得分"直接选择，不再走束搜索/联合仲裁。 */
  endgameSolver?: 'off' | 'exact';
  /** 终局圈强制弃置按官方得分口径（非黄留存）；缺省 false = 冻结 trimStock。
   * 同时作用于根决策与轨迹内己方弃置。 */
  endgameDiscard?: boolean;
  // === AI7 任务 C3：联合仲裁稳健性 ===
  /** 仲裁统计（缺省 legacy = 冻结 mean − 0.25·se 独立口径）：
   * paired = 同一 (world, replica) 的配对差 + 单侧置信下界。 */
  arbitration?: 'legacy' | 'paired';
  /** 挑战者允许覆盖冠军所需的最少配对试验数（缺省 legacy=2；paired 建议 4）。 */
  minPairedTrials?: number;
  /** 配对差单侧置信倍数（paired 模式；缺省 1.645 ≈ 95% 单侧）。 */
  pairedZ?: number;
  /** 高价值认领保护（缺省 false = 冻结行为）：冠军行动是"立即可得且当步
   * 正式净分 ≥ claimProtectDelta"的认领时，挑战者需额外跨越 claimProtectMargin。 */
  claimProtection?: boolean;
  /** 受保护认领的当步正式净分门槛（缺省 10 分）。 */
  claimProtectDelta?: number;
  /** 受保护认领的额外覆盖边际（缺省 0.10，稳健分单位）。 */
  claimProtectMargin?: number;
  /** 候选构造保证"当步正式净分最大的可立即认领行动"进入候选集（缺省 false）。 */
  ensureBestClaimCandidate?: boolean;
  /** AI6 第六阶段 C2：试验预算分配（缺省 balanced = JS5 语义逐位不变）。
   * racing = 首个完整平衡批次后按 Hoeffding 置信界淘汰：非冠军候选的
   * UCB(mean+ε) 低于冠军候选 LCB(mean−ε) 时淘汰（δ 按 M 候选 union 校正）；
   * 全部非冠军候选被淘汰 → 提前返回冠军行动（保守语义保底）；
   * 存活候选独占剩余预算。采样键 (world, replica) 与 balanced 完全一致
   * （CRN 保持、逐试验可审计）；冠军候选绝不被淘汰。 */
  allocation?: 'balanced' | 'racing';
  /** racing 单决策淘汰错误率预算 δ（缺省 0.05；实际 ε 按 δ/M union 校正）。 */
  racingDelta?: number;
  /** AI6 第六阶段 C4：终局模式（缺省 default = JS5 语义）。claimFocus =
   * 终局已触发（triggerPlayer 非 null）时，候选 = 冠军行动 ∪ 全部合法认领
   * （不再限 2 个）∪ 先验 top 填满 cap——终局是小行动空间精确排序问题，
   * 认领顺序比探索宽度更重要。 */
  endgameMode?: 'default' | 'claimFocus';
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
    // AI7-A2 身份冻结：本决策消费的冠军基座参数必须来自调用描述符；未显式
    // 传入时才回退模块级活动冠军（生产入口显式传入，冻结版本传入归档参数）。
    // 归一化保证部分参数对象不会以 undefined 乘子进入束搜索。
    const championParameters = o.championParameters
      ? validateAIParameters(o.championParameters)
      : CHAMPION_PARAMETERS;
    const t0 = performance.now();
    const phase: PhaseTimings = { planMs: 0, rootSimMs: 0, legalGenMs: 0, gateMs: 0, screenMs: 0, rolloutMs: 0, aggregateMs: 0 };
    if (observation.phase === 'finished') fail('游戏已结束，无法决策');
    const mySeat = observation.playerId;
    if (observation.current !== mySeat) fail('观察席位不是当前行动者');

    // 1. 冠军规划（冻结参数 + 显式结构；人格经 profileOverride 注入）。
    const profile: Profile = o.profileName ? profileByName(o.profileName) : NEUTRAL_PROFILE;
    const planStart = performance.now();
    const plan = choosePlan(observation, championParameters, profile, o.championStructure ?? 'beam-rollout');
    phase.planMs = performance.now() - planStart;
    const championAction: Action | null = plan?.first ?? null;

    // 溢出阶段在 adapter 层处理（champion trimStock 口径），不会进入这里。

    // 2. 根模拟（B：先只建 roots[0]——合法行动与 gating 所需；其余信念世界
    //    仅在门控触发后创建，内容确定性不变，非门控决策省 W−1 次构造）。
    const worldCount = Math.max(1, Math.min(8, Math.floor(o.worlds ?? 4)));
    const rootSimStart = performance.now();
    const root = createSimulation(observation, { simSeed: worldSeed(o.simSeed ?? 0, 0), historySummary: o.historySummary });
    // 互斥分相：rootSimMs 只含 createSimulation，legalGenMs 单独计量
    // （旧实现 rootSimMs 包含 legalGenMs，阶段相加会重复计时）。
    phase.rootSimMs = performance.now() - rootSimStart;
    let rootsCreated = 1;
    const roots: PublicSimulation[] = [root];
    const legalStart = performance.now();
    const legalRootActions = enumerateLegalActions(root.view, { dedupe: true });
    phase.legalGenMs = performance.now() - legalStart;
    if (!legalRootActions.length) fail('根状态无合法行动（规则引擎不一致）');
    const immediateClaimGoals = new Set<string>(
      legalRootActions.filter(a => a.type === 'claim').map(a => observation.golemMarket[a.index]),
    );

    // AI7 C1：终局圈精确求解。终局触发后当前席位只剩最后一次行动——直接
    // 按官方最终得分与保证名次枚举全部合法根行动，不再用静态目标价值或
    // 低置信度联合模拟决定最后一手。只在显式 endgameSolver='exact' 时启用。
    if (o.endgameSolver === 'exact' && isFinalOwnAction(observation)) {
      const solveStart = performance.now();
      const solved: EndgameSolution | null = solveFinalAction(observation, legalRootActions);
      phase.screenMs += performance.now() - solveStart;
      if (solved) {
        const elapsedMs = performance.now() - t0;
        const scoreTag = solved.action.type === 'claim'
          ? `认领 ${observation.golemMarket[solved.action.index]}`
          : JSON.stringify(solved.action);
        const rejected = solved.alternatives
          .filter(a => JSON.stringify(a.action) !== JSON.stringify(solved.action))
          .slice(0, 4)
          .map(a => ({
            action: a.action,
            mean: a.ownFinalScore,
            why: `终局精确结算：最终 ${a.ownFinalScore} 分，保证名次 ${a.guaranteedRank}（乐观 ${a.optimisticRank}）`,
          }));
        return {
          action: solved.action,
          reason: `js6 终局精确求解（${scoreTag}）：最终 ${solved.ownFinalScore} 分，保证名次 ${solved.guaranteedRank}（乐观 ${solved.optimisticRank}），`
            + `枚举 ${solved.evaluatedActions} 个合法行动；对手单动作上界 ${solved.opponents.map(x => `座${x.seat}:${x.upper}`).join('/')}`,
          evaluations: [],
          chosen: { action: solved.action, prior: 0, trials: 0, mean: solved.ownFinalScore, se: null },
          trace: {
            root: { turnNumber: observation.turnNumber, current: observation.current, golemMarket: [...observation.golemMarket], phase: observation.phase },
            evaluations: [],
            rejected,
          },
          stats: {
            rollouts: 0, transitions: 0, elapsedMs, budgetExhausted: false,
            omTimeMs: 0, cloneMs: 0, cloneMsMeasured: false, legalGenMs: phase.legalGenMs,
            rootActions: legalRootActions.length, candidateCount: solved.evaluatedActions,
            worldsUsed: 0, worldsConfigured: worldCount, batchesStarted: 0,
            trialWindowMs: 0, zeroTrialReason: 'not-gated',
            overBudget: false,
            planMs: phase.planMs, rootSimMs: phase.rootSimMs, gateMs: phase.gateMs,
            screenMs: phase.screenMs, rolloutMs: 0, aggregateMs: 0,
            rootSimulationsCreated: rootsCreated,
            screenGoalScope: o.screenGoalScope ?? 'all', batchAdmission: o.batchAdmission ?? 'legacy',
            endgame: {
              solver: 'exact',
              ownFinalScore: solved.ownFinalScore,
              guaranteedRank: solved.guaranteedRank,
              optimisticRank: solved.optimisticRank,
              discarded: [...solved.discarded],
              denial: solved.denial,
              rankModel: solved.rankModel,
              evaluatedActions: solved.evaluatedActions,
              opponents: solved.opponents,
              alternatives: solved.alternatives,
              championAction: championAction ? championAction : null,
            },
          } satisfies JointDecisionStats,
          championAction,
          gated: false,
          contestedGoals: [...observation.golemMarket],
        };
      }
    }

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
          omTimeMs: 0, cloneMs: 0, cloneMsMeasured: false, legalGenMs: phase.legalGenMs, rootActions: legalRootActions.length,
          candidateCount: 0, worldsUsed: 0, worldsConfigured: worldCount,
          planMs: phase.planMs, rootSimMs: phase.rootSimMs, gateMs: phase.gateMs,
          screenMs: 0, rolloutMs: 0, aggregateMs: 0, rootSimulationsCreated: rootsCreated,
          batchesStarted: 0, trialWindowMs: 0, zeroTrialReason: 'not-gated', overBudget: false,
          screenGoalScope: o.screenGoalScope ?? 'all', batchAdmission: o.batchAdmission ?? 'legacy',
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
    const ctxRoot = heuristicContext(root.view, championParameters, NEUTRAL_PROFILE);
    // 根筛选目标范围：缺省 all（冻结语义）；preferred 是文件注释记载的 JS5
    // 10ms 口径，现在真正接线（此前注释说用 preferred、实现却落 all）。
    const screened = screenRootActions(observation, legalRootActions, ctxRoot, survival, {
      goalScope: o.screenGoalScope ?? 'all',
      preferredGoal: plan?.preferred ?? null,
    });
    phase.screenMs = performance.now() - screenStart;
    const candidates: Action[] = [];
    const candidateSources: Array<'champion' | 'claim' | 'prior' | 'near-terminal'> = [];
    const priorOf = new Map<string, number>();
    const seen = new Set<string>();
    const push = (a: Action | null | undefined, source: 'champion' | 'claim' | 'prior' | 'near-terminal') => {
      if (!a) return false;
      const k = actionKey(a);
      if (seen.has(k)) return false;
      seen.add(k);
      candidates.push(a);
      candidateSources.push(source);
      return true;
    };
    push(championAction, 'champion');
    // C2：立即认领候选的选取原则（缺省 enumeration = PR #27 原始语义；
    // prior 模式按根筛选先验降序取前 2，避免枚举顺序偶然排除高分认领）。
    // C4 claimFocus：终局已触发时候选 = 冠军行动 ∪ 全部合法认领（认领顺序
    // 是终局的核心决策；不再限 2 个）∪ 先验 top 填满 cap。
    const claimActions = legalRootActions.filter(x => x.type === 'claim');
    // AI7 C3：认领候选的当步正式净分/毛分（与 near-terminal 同一口径）。
    // 毛分 = 魔像分值 + 硬币（支付水晶是认领的必要成本，保护门槛按毛分判断
    // "这是不是一个明确的高分机会"）；净分仍用于候选补全的优先序。
    const claimDeltas = new Map<string, number>();
    const claimGross = new Map<string, number>();
    for (const a of claimActions) {
      const scored = immediateOfficialScoreDelta(observation, a);
      if (!scored) continue;
      claimDeltas.set(actionKey(a), scored.delta);
      const goal = a.type === 'claim' ? GOLEM_BY_ID[observation.golemMarket[a.index]] : null;
      const nonYellowCost = goal ? goal.cost.slice(1).reduce((s, x) => s + x, 0) : 0;
      claimGross.set(actionKey(a), scored.delta + nonYellowCost);
    }
    let bestClaim: { action: Action; delta: number; gross: number } | null = null;
    for (const a of claimActions) {
      const delta = claimDeltas.get(actionKey(a));
      if (delta === undefined) continue;
      if (!bestClaim || delta > bestClaim.delta) {
        bestClaim = { action: a, delta, gross: claimGross.get(actionKey(a)) ?? delta };
      }
    }
    // 候选补全（显式 opt-in）：保证当步净分最大的可立即认领行动进入候选集，
    // 防止"明确得分机会"因枚举顺序/先验排序被低置信度模拟直接覆盖。
    if (o.ensureBestClaimCandidate && bestClaim) push(bestClaim.action, 'claim');
    const claimFocus = o.endgameMode === 'claimFocus' && observation.triggerPlayer !== null;
    if (o.claimRanking === 'prior' || claimFocus) {
      const priorOfAction = new Map(claimActions.map(a => [actionKey(a), screened.find(s => actionKey(s.action) === actionKey(a))?.prior ?? -Infinity]));
      claimActions.sort((x, y) => (priorOfAction.get(actionKey(y)) ?? -Infinity) - (priorOfAction.get(actionKey(x)) ?? -Infinity));
    }
    for (const a of claimActions.slice(0, claimFocus
      ? Math.max(0, (o.candidateCap ?? 4) - candidates.length) // claimFocus：认领优先填满 cap
      : 2)) push(a, 'claim');
    for (const { action } of screened) {
      if (candidates.length >= (o.candidateCap ?? 4)) break;
      push(action, 'prior');
    }
    if (!candidates.length) fail('候选构造为空（规则层缺陷）');

    // P1-C 临近终局候选覆盖（显式 opt-in；缺省 off = 冻结行为）：
    // 公开风险成立时，把"当步正式净分最大"的合法行动注入候选集。
    // - replace：替换最后一个先验填充候选（保持 candidateCap 与每候选预算不变）；
    // - add：追加一个候选（cap+1，明确披露额外轨迹成本）。
    // 不硬编码对局/回合/卡 ID；不改变后继仲裁规则（仍由联合模拟+保守覆盖裁决）。
    const nearTerminalPolicy = o.nearTerminalCandidate ?? 'off';
    const terminalRisk: NearTerminalRisk | null = nearTerminalPolicy === 'off'
      ? null
      : nearTerminalRisk(observation);
    let injected: ImmediateScoreCandidate | null = null;
    let replacedAction: Action | null = null;
    let injectionMode: 'off' | 'replace' | 'add' = nearTerminalPolicy;
    if (terminalRisk?.risky && injectionMode !== 'off') {
      const best = maxImmediateScoreAction(observation, legalRootActions);
      if (best && !seen.has(actionKey(best.action))) {
        injected = best;
        if (injectionMode === 'add') {
          push(best.action, 'near-terminal');
        } else {
          let idx = candidateSources.lastIndexOf('prior');
          if (idx < 0) idx = candidateSources.lastIndexOf('claim');
          if (idx >= 0) {
            replacedAction = candidates[idx];
            seen.delete(actionKey(candidates[idx]));
            candidates[idx] = best.action;
            candidateSources[idx] = 'near-terminal';
            seen.add(actionKey(best.action));
          } else {
            // 只有冠军行动（cap 极小）时不能替换，退化为追加并如实披露。
            push(best.action, 'near-terminal');
            injectionMode = 'add';
          }
        }
      }
    }
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
          omTimeMs: 0, cloneMs: 0, cloneMsMeasured: false, legalGenMs: phase.legalGenMs, rootActions: legalRootActions.length,
          candidateCount: candidates.length, worldsUsed: 0, worldsConfigured: worldCount,
          batchesStarted: 0, trialWindowMs: 0, zeroTrialReason: 'rerank-no-rollout', overBudget: false,
          screenGoalScope: o.screenGoalScope ?? 'all', batchAdmission: o.batchAdmission ?? 'legacy',
          planMs: phase.planMs, rootSimMs: phase.rootSimMs, gateMs: phase.gateMs,
          screenMs: phase.screenMs, rolloutMs: 0, aggregateMs: 0, rootSimulationsCreated: rootsCreated,
          ...(terminalRisk && injectionMode !== 'off' ? {
            nearTerminal: {
              policy: nearTerminalPolicy, risky: terminalRisk.risky,
              reason: terminalRisk.reason, threshold: terminalRisk.threshold,
              threatenedSeats: terminalRisk.threatenedSeats,
              injected: injected ? { action: injected.action, delta: injected.delta, scoreAfter: injected.scoreAfter, discarded: injected.discarded } : null,
              replacedAction, mode: injectionMode, candidateSources,
            },
          } : {}),
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
      params: o.championParameters ?? CHAMPION_PARAMETERS,
      endgameDiscard: o.endgameDiscard === true,
    } satisfies Omit<RolloutContext, 'events' | 'omTimeMs'>;

    const aggregates = candidates.map(action => ({
      action, trials: 0, sum: 0, sqSum: 0,
      // AI7 C3：按 (world, replica) 记录逐试验值，供配对差统计（CRN）。
      pairs: new Map<string, number>(),
    }));
    const trialsLog: { actionIndex: number; world: number; replica: number; value: number }[] | undefined = o.collectTrials === true ? [] : undefined;
    const omTimeMs = { value: 0 };
    let transitions = 0;
    let rollouts = 0;
    const workUnits = o.workUnits;
    // 防御性默认：budgetMs 与 workUnits 均未给定时按 100ms 墙钟预算（与 planner 同纪律）。
    const budgetMs = o.budgetMs ?? (workUnits !== undefined ? undefined : 100);
    const trialDeadline = workUnits || budgetMs === undefined ? undefined : t0 + budgetMs * 0.95;
    // 单轨迹保底窗口：
    // - legacy（冻结行为）= 5ms + M×5ms 批次门槛，只跑完整 W×M 批次；
    // - balanced（显式实验）= 2.5ms + W×M×2.5ms 预检，允许全候选缩减批次。
    // 实测本机 48 转移轨迹约 2.2–2.8ms（0.05–0.06ms/转移，见
    // run-20261025-01/evidence/budget-*.json）；2.5ms 仍保证近 48 转移窗口。
    const admission: BatchAdmission = o.batchAdmission ?? 'legacy';
    const M = candidates.length;
    const floors = batchFloors(admission, worldCount, M);
    const PER_TRIAL_FLOOR_MS = floors.trialFloorMs;
    const fullBatchFloorMs = floors.fullBatchFloorMs;
    const minBatchFloorMs = floors.minBatchFloorMs;
    const rolloutStart = performance.now();
    const rolloutStartOffsetMs = rolloutStart - t0;
    const trialWindowMs = trialDeadline === undefined ? null : Math.max(0, trialDeadline - rolloutStart);
    const worldsUsedSet = new Set<number>();
    let batchesStarted = 0;
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
      entry.pairs.set(`${world}:${replica}`, outcome.value);
      trialsLog?.push({ actionIndex: index, world, replica, value: outcome.value });
      return outcome.value;
    };
    /** 完整批次 = 同一 replica 下全部 (world × candidate) 试验。批次一旦启动
     * 全部入账（部分批次绝不出现）⇒ 任意截断点上各候选试验数之差 < M
     * 且 (world, replica) 键集严格相同（CRN 配对成立）。
     * C2 racing：runBatchOver 支持候选子集批次——只收缩候选集合、绝不收缩
     * (world, replica) 键集 ⇒ 淘汰后存活候选的采样键与 balanced 完全一致。 */
    const runBatchOver = (indices: number[], replica: number, worldsInBatch: number): void => {
      for (let w = 0; w < worldsInBatch; w++) {
        worldsUsedSet.add(w);
        for (const i of indices) runTrial(i, w, replica);
      }
      batchesStarted += 1;
    };
    const runBatch = (replica: number, worldsInBatch: number): void =>
      runBatchOver(aggregates.map((_, i) => i), replica, worldsInBatch);
    let racingEliminated = 0;
    if (o.allocation === 'racing' && championKey) {
      // C2 racing（AI6 第六阶段）：首个完整平衡批次（全员，与 balanced 首批
      // 逐位一致）后，按 Hoeffding 界淘汰"即使后续全胜也无法威胁冠军"的
      // 非冠军候选（UCB_i = mean_i + ε(t) < LCB_champ = mean_c − ε(t)）；
      // δ 按候选数 union 校正；冠军候选绝不淘汰（保守覆盖语义保底）；
      // 采样键 (world, replica) 与 balanced 完全一致（CRN 保持）。
      const delta = Math.max(1e-9, o.racingDelta ?? 0.05);
      const epsUnion = Math.log(2 * Math.max(2, M) / delta);
      const eps = (t: number) => (t > 0 ? Math.sqrt(epsUnion / (2 * t)) : 1);
      const alive = aggregates.map((_, i) => i);
      const championIdx = aggregates.findIndex(a => actionKey(a.action) === championKey);
      const robustOf = (i: number) => {
        const e = aggregates[i];
        return e.trials > 0 ? e.sum / e.trials : -Infinity;
      };
      runBatch(0, worldCount);
      let replica = 1;
      let trialsDone = worldCount * M;
      while (alive.length > 1 && replica < 100_000) {
        if (workUnits !== undefined) {
          if (trialsDone + worldCount * alive.length > workUnits) break;
        } else if (trialDeadline !== undefined) {
          const floorMs = Math.max(1, alive.length) * PER_TRIAL_FLOOR_MS;
          if (performance.now() + floorMs > trialDeadline) break;
        }
        if (championIdx >= 0) {
          const lcbChamp = robustOf(championIdx) - eps(aggregates[championIdx].trials);
          const eliminated = alive.filter(i => i !== championIdx
            && aggregates[i].trials > 0
            && robustOf(i) + eps(aggregates[i].trials) < lcbChamp);
          if (eliminated.length) {
            for (const i of eliminated) alive.splice(alive.indexOf(i), 1);
            racingEliminated += eliminated.length;
          }
          if (alive.length === 1 && alive[0] === championIdx) break; // 冠军直通保底
        }
        runBatchOver(alive, replica, worldCount);
        trialsDone += worldCount * alive.length;
        replica += 1;
      }
    } else if (workUnits !== undefined) {
      // 固定工作量模式（确定性）：完整批次向下取整（每候选严格等试验数；
      // workUnits < W×M 时按最小粒度 1 个完整批次执行并披露）。
      const passes = Math.max(1, Math.floor(workUnits / (worldCount * M)));
      for (let r = 0; r < passes; r++) runBatch(r, worldCount);
    } else if (admission === 'legacy') {
      // 冻结行为（缺省）：门槛只乘 M（历史实现；低估了 W 倍批次成本），
      // 且只启动完整 W×M 批次——保留给未显式选择 balanced 的所有调用方。
      const legacyBatchFloorMs = M * PER_TRIAL_FLOOR_MS;
      let pass = 0;
      while (pass < 100_000 && trialDeadline !== undefined
        && performance.now() + legacyBatchFloorMs <= trialDeadline) {
        runBatch(pass, worldCount);
        pass += 1;
      }
    } else {
      // balanced：批次启动前按"整批 W×M 条轨迹 × 单轨迹保底窗口"预检。
      // 时间不足以跑满 W 个世界时，按可容纳的世界数执行**全候选**缩减批次
      // ——保持各候选共同键集，不用零试验直接放弃有效仲裁。
      let pass = 0;
      while (pass < 100_000 && trialDeadline !== undefined) {
        const worldsFit = fitWorlds(trialDeadline - performance.now(), worldCount, M);
        if (worldsFit === 0) break;
        runBatch(pass, worldsFit);
        pass += 1;
      }
    }
    phase.rolloutMs = performance.now() - rolloutStart;
    const wallClockMode = workUnits === undefined && budgetMs !== undefined;
    const stoppedByDeadline = wallClockMode && trialDeadline !== undefined
      && (batchesStarted === 0 ? rolloutStart >= trialDeadline : performance.now() + minBatchFloorMs > trialDeadline);
    let zeroTrialReason: JointDecisionStats['zeroTrialReason'] = null;
    if (rollouts === 0) {
      if (trialDeadline === undefined) zeroTrialReason = 'no-window';
      else if (rolloutStart >= trialDeadline) zeroTrialReason = 'plan-and-screen-exhausted';
      else if (trialWindowMs !== null && trialWindowMs < minBatchFloorMs) zeroTrialReason = 'batch-floor-not-met';
      else zeroTrialReason = 'no-batch-started';
    }
    // 墙钟模式：只要批次因截止而停止，预算就已耗尽（即使零试验或未超名义
    // 预算）。overBudget 单独表示端到端耗时超过名义 budgetMs。
    const budgetExhausted = wallClockMode && (rollouts === 0
      ? (zeroTrialReason === 'plan-and-screen-exhausted' || zeroTrialReason === 'batch-floor-not-met')
      : true);

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
    const aggregateOf = (key: string) => aggregates.find(a => actionKey(a.action) === key);

    // === AI7 C3：仲裁稳健性 ===
    // 1. 统计口径：legacy = 冻结的独立 mean−0.25·se；paired = 同一
    //    (world, replica) 的配对差单侧置信下界（CRN 已由试验调度保证）。
    // 2. 统一候选样本：只使用冠军与挑战者共同拥有的 (world, replica) 键。
    // 3. 覆盖边际：基础 margin + 受保护认领的额外边际。
    const arbitrationMode = o.arbitration ?? 'legacy';
    const baseMargin = o.overrideMargin ?? 0.02;
    const protectMargin = o.claimProtectMargin ?? 0.10;
    const protectDelta = o.claimProtectDelta ?? 10;
    const protectedKeys = new Set<string>(
      o.claimProtection === true
        ? [...claimGross.entries()].filter(([, gross]) => gross >= protectDelta).map(([key]) => key)
        : [],
    );
    const protectedClaims = [...protectedKeys];
    const championProtected = championKey !== null && protectedKeys.has(championKey);
    const minChallengerTrials = Math.max(
      arbitrationMode === 'paired' ? (o.minPairedTrials ?? 4) : 2,
      admission === 'balanced' && worldsUsedSet.size < worldCount ? 3 : 0,
    );
    const requiredMarginOf = (e: RootActionEvaluation): number =>
      baseMargin + (protectedKeys.size > 0 && !protectedKeys.has(actionKey(e.action)) ? protectMargin : 0);
    const pairedZ = o.pairedZ ?? 1.645;

    /** 配对差统计：仅使用双方共同键（同一 world/replica ⇒ 同一对手/翻牌流）。 */
    const pairedDiffOf = (challenger: RootActionEvaluation): {
      n: number; mean: number | null; se: number | null; lcb: number | null;
    } => {
      const championAgg = championKey ? aggregateOf(championKey) : undefined;
      const challengerAgg = aggregateOf(actionKey(challenger.action));
      if (!championAgg || !challengerAgg) return { n: 0, mean: null, se: null, lcb: null };
      const diffs: number[] = [];
      for (const [pair, value] of challengerAgg.pairs) {
        const base = championAgg.pairs.get(pair);
        if (base !== undefined) diffs.push(value - base);
      }
      const n = diffs.length;
      if (!n) return { n, mean: null, se: null, lcb: null };
      const mean = diffs.reduce((s, x) => s + x, 0) / n;
      if (n < 2) return { n, mean, se: null, lcb: null };
      const variance = diffs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
      const se = Math.sqrt(variance / n);
      return { n, mean, se, lcb: mean - pairedZ * se };
    };

    let bestEval = evaluations[0];
    if (championEval && championEval.trials > 0) {
      let challenger = championEval;
      if (arbitrationMode === 'paired') {
        let bestLcb = -Infinity;
        for (const e of evaluations) {
          if (actionKey(e.action) === championKey) continue;
          const stats = pairedDiffOf(e);
          if (stats.n < minChallengerTrials || stats.lcb === null) continue;
          if (stats.mean === null || stats.mean <= 0) continue;
          if (stats.lcb > requiredMarginOf(e) && stats.lcb > bestLcb) {
            bestLcb = stats.lcb;
            challenger = e;
          }
        }
        bestEval = challenger === championEval ? championEval : challenger;
      } else {
        // 冻结口径（legacy）：独立稳健分比较 + 保守 margin。
        const championScore = robustScoreOf(championEval);
        for (const e of evaluations) {
          if (actionKey(e.action) === championKey) continue;
          if (e.trials < minChallengerTrials) continue;
          if (robustScoreOf(e) > robustScoreOf(challenger)) challenger = e;
        }
        bestEval = robustScoreOf(challenger) > championScore + requiredMarginOf(challenger)
          ? challenger
          : championEval;
      }
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
          ? `冠军行动（稳健分 ${robustScoreOf(e).toFixed(3)}）未被超越（边际 ${requiredMarginOf(e).toFixed(3)}）`
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
    const injectionTag = injected
      ? `；临近终局候选注入 ${actionKey(injected.action)}（当步正式净分 +${injected.delta}，${injectionMode}${replacedAction ? '，替换先验候选' : ''}）`
      : '';
    const arbitrationStats = (arbitrationMode !== 'legacy' || o.claimProtection === true || o.ensureBestClaimCandidate === true)
      ? {
          mode: arbitrationMode,
          minTrials: minChallengerTrials,
          pairedZ: arbitrationMode === 'paired' ? pairedZ : null,
          championProtected,
          protectedClaims,
          candidates: evaluations.map(e => {
            const p = pairedDiffOf(e);
            return {
              action: e.action,
              trials: e.trials,
              pairedTrials: p.n,
              meanDiff: p.mean,
              seDiff: p.se,
              lowerConfidenceBound: p.lcb,
              requiredMargin: requiredMarginOf(e),
            };
          }),
        }
      : undefined;
    const claimGuardStats = (o.claimProtection === true || o.ensureBestClaimCandidate === true)
      ? {
          enabled: o.claimProtection === true,
          bestClaim: bestClaim
            ? { action: bestClaim.action, delta: bestClaim.delta, gross: bestClaim.gross, inCandidates: seen.has(actionKey(bestClaim.action)) }
            : null,
          championProtected,
        }
      : undefined;
    const guardTag = claimGuardStats?.bestClaim
      ? `；认领保护 ${claimGuardStats.championProtected ? '冠军受保护' : '候选含受保护认领'}（最佳认领 ${claimGuardStats.bestClaim.delta} 分）`
      : '';
    return {
      action: bestEval.action,
      reason: `js5 ${gated ? '联合仲裁' : '冠军直通'}：${bestEval === championEval ? '保持冠军行动' : '覆盖为联合最优'}（联合模拟评价值 ${bestEval.mean.toFixed(3)}，未校准胜率近似，${bestEval.trials} 轨迹，实际世界 ${worldsUsedSet.size}/${worldCount}，争议目标 ${risk.contestedGoals.join(',') || '无'}）${golemTag(bestEval.action)}${injectionTag}${guardTag}`,
      evaluations,
      chosen: { action: bestEval.action, prior: 0, trials: bestEval.trials, mean: bestEval.mean, se: bestEval.se },
      trace,
      stats: {
        rollouts, transitions, elapsedMs,
        budgetExhausted,
        omTimeMs: omTimeMs.value, cloneMs: 0, cloneMsMeasured: false, legalGenMs: phase.legalGenMs,
        rootActions: legalRootActions.length, candidateCount: M,
        racingEliminated,
        worldsUsed: worldsUsedSet.size, worldsConfigured: worldCount,
        batchesStarted, trialWindowMs, fullBatchFloorMs, minBatchFloorMs,
        rolloutStartMs: rolloutStartOffsetMs, zeroTrialReason,
        overBudget: wallClockMode && budgetMs !== undefined && elapsedMs > budgetMs,
        stoppedByDeadline,
        overrideMinTrials: minChallengerTrials,
        screenGoalScope: o.screenGoalScope ?? 'all', batchAdmission: admission,
        accountingMs: phase.planMs + phase.rootSimMs + phase.legalGenMs + phase.gateMs + phase.screenMs + phase.rolloutMs + phase.aggregateMs,
        unaccountedMs: Math.max(0, elapsedMs - (phase.planMs + phase.rootSimMs + phase.legalGenMs + phase.gateMs + phase.screenMs + phase.rolloutMs + phase.aggregateMs)),
        planMs: phase.planMs, rootSimMs: phase.rootSimMs, gateMs: phase.gateMs,
        screenMs: phase.screenMs, rolloutMs: phase.rolloutMs, aggregateMs: phase.aggregateMs,
        rootSimulationsCreated: rootsCreated,
        ...(terminalRisk && injectionMode !== 'off' ? {
          nearTerminal: {
            policy: nearTerminalPolicy, risky: terminalRisk.risky,
            reason: terminalRisk.reason, threshold: terminalRisk.threshold,
            threatenedSeats: terminalRisk.threatenedSeats,
            injected: injected ? { action: injected.action, delta: injected.delta, scoreAfter: injected.scoreAfter, discarded: injected.discarded } : null,
            replacedAction, mode: injectionMode, candidateSources,
          },
        } : {}),
        ...(arbitrationStats ? { arbitration: arbitrationStats } : {}),
        ...(claimGuardStats ? { claimGuard: claimGuardStats } : {}),
      } satisfies JointDecisionStats,
      ...(trialsLog ? { trials: trialsLog } : {}),
      championAction,
      gated: true,
      contestedGoals: risk.contestedGoals,
    };
  }
}

/** 选项解析：显式缺省集中在一处（JS5 全部参数显式可审计）。 */
function resolveChampionGuidedOptions(o?: ChampionGuidedSearchOptions): Required<Pick<ChampionGuidedSearchOptions,
  'championStructure' | 'gateMode' | 'overrideMargin' | 'candidateCap' | 'contestThreshold' | 'claimRanking' |
  'nearTerminalCandidate' | 'screenGoalScope' | 'batchAdmission' | 'endgameSolver' | 'endgameDiscard' |
  'arbitration' | 'minPairedTrials' | 'pairedZ' | 'claimProtection' | 'claimProtectDelta' |
  'claimProtectMargin' | 'ensureBestClaimCandidate' |
  'allocation' | 'racingDelta' | 'endgameMode'>> & ChampionGuidedSearchOptions {
  const base = o ?? {};
  const nearTerminalCandidate = base.nearTerminalCandidate ?? 'off';
  if (!['off', 'replace', 'add'].includes(nearTerminalCandidate)) fail(`未知 nearTerminalCandidate：${String(nearTerminalCandidate)}`);
  const screenGoalScope = base.screenGoalScope ?? 'all';
  if (!['all', 'preferred'].includes(screenGoalScope)) fail(`未知 screenGoalScope：${String(screenGoalScope)}`);
  const batchAdmission = base.batchAdmission ?? 'legacy';
  if (!['legacy', 'balanced'].includes(batchAdmission)) fail(`未知 batchAdmission：${String(batchAdmission)}`);
  const endgameSolver = base.endgameSolver ?? 'off';
  if (!['off', 'exact'].includes(endgameSolver)) fail(`未知 endgameSolver：${String(endgameSolver)}`);
  const arbitration = base.arbitration ?? 'legacy';
  if (!['legacy', 'paired'].includes(arbitration)) fail(`未知 arbitration：${String(arbitration)}`);
  const minPairedTrials = base.minPairedTrials ?? 4;
  if (!Number.isSafeInteger(minPairedTrials) || minPairedTrials < 2) fail(`minPairedTrials 必须为 ≥2 的整数：${String(minPairedTrials)}`);
  const pairedZ = base.pairedZ ?? 1.645;
  if (!Number.isFinite(pairedZ) || pairedZ < 0) fail(`pairedZ 必须为非负有限数：${String(pairedZ)}`);
  const claimProtectDelta = base.claimProtectDelta ?? 10;
  if (!Number.isFinite(claimProtectDelta) || claimProtectDelta < 0) fail(`claimProtectDelta 必须为非负有限数：${String(claimProtectDelta)}`);
  const claimProtectMargin = base.claimProtectMargin ?? 0.10;
  if (!Number.isFinite(claimProtectMargin) || claimProtectMargin < 0) fail(`claimProtectMargin 必须为非负有限数：${String(claimProtectMargin)}`);
  const allocation = base.allocation ?? 'balanced';
  if (!['balanced', 'racing'].includes(allocation)) fail(`未知 allocation：${String(allocation)}`);
  const endgameMode = base.endgameMode ?? 'default';
  if (!['default', 'claimFocus'].includes(endgameMode)) fail(`未知 endgameMode：${String(endgameMode)}`);
  const racingDelta = base.racingDelta ?? 0.05;
  if (!(racingDelta > 0 && racingDelta < 1)) fail(`racingDelta 必须在 (0,1)，实际：${String(racingDelta)}`);
  return {
    ...base,
    championStructure: base.championStructure ?? 'beam-rollout',
    gateMode: base.gateMode ?? 'auto',
    overrideMargin: base.overrideMargin ?? 0.02,
    candidateCap: base.candidateCap ?? 4,
    contestThreshold: base.contestThreshold ?? 0.85,
    claimRanking: base.claimRanking ?? 'enumeration',
    allocation, racingDelta, endgameMode,
    nearTerminalCandidate,
    screenGoalScope,
    batchAdmission,
    endgameSolver,
    endgameDiscard: base.endgameDiscard === true,
    arbitration,
    minPairedTrials,
    pairedZ,
    claimProtection: base.claimProtection === true,
    claimProtectDelta,
    claimProtectMargin,
    ensureBestClaimCandidate: base.ensureBestClaimCandidate === true,
  };
}

/** 创建 JS5 规划器（无状态；选项经 decide 注入，评测按版本+选项显式配置）。 */
export function createChampionGuidedPlanner(): ChampionGuidedPlanner {
  return new ChampionGuidedPlanner();
}
