/** Joint Search V1 共享类型（AI6 第四阶段·任务 A）。
 *
 * 模块定位：src/js/ 是独立的多玩家联合规划器实验模块。与 src/ai（正式冠军）
 * 完全隔离：正式网页 AI 决策路径不 import 本模块，冠军行为逐位不变；
 * 本模块经独立实验适配器（./adapter.ts）按显式版本注入训练评测。
 *
 * 信息边界（不可妥协，与 src/sim、src/om 同一纪律）：
 * - 规划输入只允许 AIObservation 公开观察 + 公开历史摘要 + 显式版本化参数；
 * - 模拟随机流独立于正式游戏 RNG（PublicSimulation 信念采样 + 显式种子）；
 * - 不访问隐藏牌库顺序（结构上不可达，见 tests/joint-fairness.test.mjs 静态扫描）。
 *
 * Issue #20 根本缺陷的修复定位（任务书 §一）：
 * 旧 Beam Search 推演序列是"我→我→我→我"，对手行动与市场补牌从未真实进入
 * 自身行动之间的时序。Joint Search 的推演序列是"我→下家→其余玩家按座位→
 * 我→……→终局/叶子"，全部经 PublicBeliefSimulator 精确推进（任务 B）。
 */

import type { Action } from '../engine.js';
import type { AIObservation } from '../ai/observation.js';
import type { PublicHistorySummary } from '../sim/history.js';
import type { OpponentModel } from '../om/index.js';

// === 对手行为模式（任务 E：至少三种模式） ===

/** random：合法行动均匀采样（信息公平基线）；
 * rule：每个对手按自身进度效用贪心决策（非敌对联盟，见 §任务 B.9）；
 * om-v1：Opponent Model V1 predictAction 分布采样（状态键缓存）。 */
export type JointOpponentMode = 'random' | 'rule' | 'om-v1';

// === 叶子评价器分层（任务 D：明确分离的候选评价器） ===

/** L0 当前冠军启发式；L1 多人向量估值；L2 目标存活/竞争风险/终局时间增强；
 * L3 独立校准的胜率近似（分段线性映射，权重经离线校准；缺权重时回落 L2）。 */
export type LeafEvaluatorLevel = 'L0' | 'L1' | 'L2' | 'L3';

// === 搜索结构（任务 C：两种对照搜索） ===

/** joint-rollout：根行动候选 + 后续己方启发式决策 + 概率式对手行动；
 * joint-tree：在关键己方后续决策点继续展开分支（选择性扩展），对手节点采样。 */
export type JointSearchVariant = 'joint-rollout' | 'joint-tree';

// === 决策轨迹（任务 H：关键决策轨迹输出） ===

export type RootActionEvaluation = {
  action: Action;
  /** 根行动先验（冠军启发式筛选分，未归一）。 */
  prior: number;
  trials: number;
  /** 联合模拟聚合值（均值，值域约 [0,1]）。语义（A3，不得混淆）：
   * 到达终局的轨迹值 = 真实第一名结果（1/0）；未到终局的叶子值 = L0–L3
   * 启发式胜率近似（logistic 映射，未校准）——整体是"未校准联合模拟
   * 评价值"，不是经校准的预期第一名率。 */
  mean: number;
  /** 均值标准误（trials=0 时为 null）。 */
  se: number | null;
};

export type DecisionTrace = {
  /** 根状态摘要（回合/席位/市场）。 */
  root: { turnNumber: number; current: number; golemMarket: readonly string[]; phase: string };
  /** 全部根行动的筛选与采样结果（按 mean 降序，trials=0 的仅先验）。 */
  evaluations: RootActionEvaluation[];
  /** 被拒绝的次优行动及理由（任务 H：必须说明为什么选择该行动）。 */
  rejected: { action: Action; mean: number; why: string }[];
  /** 对手行动预测摘要（om-v1 模式下采样到的对手行动家族分布）。 */
  opponentSamples?: { seat: number; family: string; action: string; p: number }[];
  /** 市场变化事件（轨迹内对手认领/补牌，任务 H：市场变化后能否改目标）。 */
  marketEvents?: { transition: number; kind: 'claim' | 'refill'; seat: number; golemId?: string; merchantId?: string }[];
};

// === 决策输出 ===

export type JointDecisionStats = {
  rollouts: number;
  transitions: number;
  elapsedMs: number;
  /** 墙钟预算是否耗尽截断（固定工作量模式下恒为 false）。 */
  budgetExhausted: boolean;
  omTimeMs: number;
  cloneMs: number;
  legalGenMs: number;
  rootActions: number;
  candidateCount: number;
  /** 信念世界数（P1-1 多世界采样）。 */
  worldsUsed: number;
  /** 分相计时（第五阶段 B1 画像；champion-guided 填写，planner 路径缺省为 undefined）。 */
  planMs?: number;
  rootSimMs?: number;
  gateMs?: number;
  screenMs?: number;
  rolloutMs?: number;
  aggregateMs?: number;
  /** 实际创建的根信念模拟数（B 优化披露：非门控决策 = 1，门控 = worlds）。 */
  rootSimulationsCreated?: number;
  /** 本决策实际参与试验的信念世界数（零试验 = 0；与配置数分开披露）。 */
  worldsConfigured?: number;
  /** 已启动的完整候选批次（每批 = 全部候选 × 批内世界数）。 */
  batchesStarted?: number;
  /** 进入 rollout 时的剩余试验窗口（毫秒；固定工作量模式为 null）。 */
  trialWindowMs?: number | null;
  /** 整批（W×M 条轨迹）的启动门槛；minBatchFloorMs = 缩减批次门槛。 */
  fullBatchFloorMs?: number;
  minBatchFloorMs?: number;
  /** 进入 rollout 前的已耗时（plan/root/legal/gate/screen 合计）。 */
  rolloutStartMs?: number;
  /** 零试验原因（rollouts>0 时为 null；非门控为 not-gated）。 */
  zeroTrialReason?: 'not-gated' | 'rerank-no-rollout' | 'no-window' | 'plan-and-screen-exhausted' | 'batch-floor-not-met' | 'no-batch-started' | null;
  /** 端到端耗时是否超过名义预算（墙钟模式）。 */
  overBudget?: boolean;
  /** 是否因试验窗口截止而停止（墙钟模式）。 */
  stoppedByDeadline?: boolean;
  /** 本次允许覆盖冠军的最低挑战者试验数（完整批次=2；缩减批次=3）。 */
  overrideMinTrials?: number;
  /** 根筛选目标范围（all / preferred）。 */
  screenGoalScope?: 'all' | 'preferred';
  /** 墙钟批次准入模式（legacy / balanced）。 */
  batchAdmission?: 'legacy' | 'balanced';
  /** 互斥阶段计时之和；unaccounted = elapsed − 各阶段（不得把包含关系相加）。 */
  accountingMs?: number;
  unaccountedMs?: number;
  /** cloneMs 是否真实测量（当前未测量时固定 0，不得据此宣称零开销）。 */
  cloneMsMeasured?: boolean;
  /** 临近终局候选覆盖遥测（仅显式 nearTerminalCandidate≠off 时填写）。 */
  nearTerminal?: {
    policy: string;
    risky: boolean;
    reason: string | null;
    threshold: number;
    threatenedSeats: number[];
    /** 被注入的当步正式净分最大行动（未注入为 null）。 */
    injected: { action: Action; delta: number; scoreAfter: number; discarded: number } | null;
    replacedAction: Action | null;
    mode: string;
    /** 候选来源（与 evaluations 同序）：champion/claim/prior/near-terminal。 */
    candidateSources: string[];
  };
};

export type JointDecision = {
  action: Action;
  reason: string;
  /** 全部根行动评价（含未获预算者；按先验聚合排序）。 */
  evaluations: RootActionEvaluation[];
  chosen: RootActionEvaluation;
  trace: DecisionTrace;
  stats: JointDecisionStats;
  /** 逐试验原始值（collectTrials=true 时披露；配对统计/CRN 验证用）。
   * actionIndex 对应 evaluations 中同 action 的条目。 */
  trials?: { actionIndex: number; world: number; replica: number; value: number }[];
};

// === 搜索选项 ===

export type JointSearchOptions = {
  /** 搜索结构（缺省 joint-rollout）。 */
  variant?: JointSearchVariant;
  /** 对手行为模式（缺省 rule）。 */
  opponentMode?: JointOpponentMode;
  /** 叶子评价器（缺省 L2）。 */
  evaluator?: LeafEvaluatorLevel;
  /** 决策墙钟预算（毫秒）。与 workUnits 互斥：两者都给时 workUnits 优先（确定性）。 */
  budgetMs?: number;
  /** 固定联合模拟工作量（轨迹条数；64/128/256/512）。设置后搜索逐位可复现。 */
  workUnits?: number;
  /** 模拟随机流基础种子（信念采样 + 对手采样；缺省 0）。 */
  simSeed?: number;
  /** 单条轨迹最大转移步数（防长尾；champion-guided 缺省 48，见 champion-guided.ts；
   * 旧注释的 90 与实现不一致，已按实现更正）。 */
  horizon?: number;
  /** 信念世界数（P1-1 多世界采样；缺省 4，固定工作量模式按预算收缩）。
   * 同一根行动的试验分布到不同未知牌序世界；同一 (world, replica) 跨根行动
   * 共享对手采样随机流（CRN 配对）。 */
  worlds?: number;
  /** 逐试验值披露（配对统计/CRN 验证；缺省 false）。 */
  collectTrials?: boolean;
  /** joint-tree 每个己方决策点展开的分支数（缺省 2）。 */
  treeBranching?: number;
  /** joint-tree 己方决策点展开深度（缺省 1）。 */
  treeDepth?: number;
  /** 附加公开历史摘要（缺省空摘要；对局追踪器产物）。 */
  historySummary?: PublicHistorySummary;
  /** 注入的对手模型实例（缺省由适配器懒创建共享实例）。 */
  opponentModel?: OpponentModel;
  /** 决策者人格（缺省 NEUTRAL_PROFILE；训练按席位映射注入）。 */
  profileName?: string;
  /** 临近终局候选覆盖策略（仅 champion-guided 消费；缺省 off = 冻结行为）：
   * off=不注入；replace=替换一个先验填充候选；add=追加一个候选（cap+1）。 */
  nearTerminalCandidate?: 'off' | 'replace' | 'add';
  /** 根筛选目标范围（仅 champion-guided）：all=全部市场目标（冻结语义）；
   * preferred=只对 [null, 冠军偏好目标] 打分（JS5 注释记载的 10ms 口径）。 */
  screenGoalScope?: 'all' | 'preferred';
  /** 墙钟批次准入（仅 champion-guided）：legacy=冻结行为（M×5ms 门槛、
   * 只跑完整 W×M 批次）；balanced=W×M 成本预检 + 全候选缩减批次 +
   * 缩减批次最低 3 试验覆盖门槛。固定工作量模式不受影响。 */
  batchAdmission?: 'legacy' | 'balanced';
};

// === 规划器接口（任务 A 推荐接口） ===

export interface JointPlanner {
  decide(observation: AIObservation, options?: JointSearchOptions): JointDecision;
}

// === 版本化算法适配器（任务书 §二：新候选使用明确版本化的算法适配器） ===

/** JS 编号为本阶段消融编号（JS0–JS5），与 PR #22 评测阶段 B0/B1/B2 无关。
 * JS5 = PR #26 修复后的 Champion-Guided Joint Search（champion-guided 结构）。
 * joint-js5-opt = AI6 第五阶段优化配置（champion-guided 结构 + tune2 块
 * 选出的选项覆盖；配置经评测选项显式注入并记录于报告 jointOptions）。 */
export type JointVersionId = 'joint-js1' | 'joint-js2' | 'joint-js3' | 'joint-js4' | 'joint-js5' | 'joint-js5-opt';

export type JointVersionSpec = {
  id: JointVersionId;
  label: string;
  kind: 'champion-contest' | 'joint' | 'champion-guided';
  /** kind=champion-contest：委托正式冠军决策入口 + beam-contest 结构（冠军 beam-rollout
   * + golemSurvivalModel 静态目标存活折扣，即 JS1 定义）；kind=joint：本模块联合搜索；
   * kind=champion-guided：JS5 冠军引导选择性联合搜索（champion-guided.ts）。 */
  defaults: Required<Pick<JointSearchOptions, 'variant' | 'opponentMode' | 'evaluator'>>;
  /** 版本独有选项预设（显式注入；空/缺省 = 与冻结缺省相同）。预设必须来自
   * 已有评测记载，禁止把标签当成配置。 */
  optionPreset?: Partial<Pick<JointSearchOptions,
    'opponentMode' | 'evaluator' | 'horizon' | 'worlds' | 'nearTerminalCandidate'>> & {
      championStructure?: string;
      gateMode?: 'auto' | 'always' | 'never' | 'rerank';
      contestThreshold?: number;
      candidateCap?: number;
      overrideMargin?: number;
      claimRanking?: 'enumeration' | 'prior';
    };
};

export const JOINT_VERSIONS: Record<JointVersionId, JointVersionSpec> = {
  'joint-js1': {
    id: 'joint-js1', label: 'JS1 冠军+静态目标存活折扣', kind: 'champion-contest',
    defaults: { variant: 'joint-rollout', opponentMode: 'rule', evaluator: 'L2' },
  },
  'joint-js2': {
    id: 'joint-js2', label: 'JS2 冠军启发式+真实座位联合 rollout（规则对手）', kind: 'joint',
    defaults: { variant: 'joint-rollout', opponentMode: 'rule', evaluator: 'L2' },
  },
  'joint-js3': {
    id: 'joint-js3', label: 'JS3 JS2+Opponent Model V1', kind: 'joint',
    defaults: { variant: 'joint-rollout', opponentMode: 'om-v1', evaluator: 'L2' },
  },
  'joint-js4': {
    id: 'joint-js4', label: 'JS4 JS3+Selective Joint Tree', kind: 'joint',
    defaults: { variant: 'joint-tree', opponentMode: 'om-v1', evaluator: 'L2' },
  },
  'joint-js5': {
    id: 'joint-js5', label: 'JS5 冠军引导选择性联合搜索（竞争门控+保守覆盖）', kind: 'champion-guided',
    defaults: { variant: 'joint-rollout', opponentMode: 'rule', evaluator: 'L2' },
  },
  'joint-js5-opt': {
    id: 'joint-js5-opt', label: 'JS5-opt 第五阶段优化配置（champion-guided + tune2 选项覆盖）', kind: 'champion-guided',
    defaults: { variant: 'joint-rollout', opponentMode: 'rule', evaluator: 'L2' },
    // 第五阶段 tune2 冻结：唯一独有选项 claimRanking='prior'
    // （AI6-PHASE5-REPORT.md §4.3；确认集 inconclusive，未晋级）。
    optionPreset: { claimRanking: 'prior' },
  },
};
