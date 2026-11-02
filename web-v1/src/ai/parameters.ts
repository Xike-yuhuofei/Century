/** AI 参数集中管理（任务书第六节）。
 *
 * 设计原则：
 * - 8 个任务参数全部实现为既有求值项的乘子，默认值 1.0 时决策行为与 V3.0 基线逐位一致。
 * - 每个参数必须真实影响决策（由 tests/ai-modules.test.mjs 灵敏度测试保证），禁止虚假参数。
 * - 冠军参数块由训练系统通过 PR 生成更新（training/scripts/apply-champion.mjs），
 *   保证训练版与网页实战版永远使用同一套参数与同一份算法源码。
 */

/** 可调参数集。全部乘子默认 1.0 = 基线行为。
 * structure：可选结构变体标识（beam-adaptive/beam-rollout），
 * 由验证器透传，使"结构 × 参数"作为完整版本参与进化与挑战。 */
export type AIParameters = {
  /** 版本标识（写进决策理由，便于追溯）。 */
  id: string;
  /** 引擎建设收益：商人卡长期产出价值在搜索/路线评估中的权重。 */
  engineWeight: number;
  /** 得分速度：步数成本与单位行动得分效率的权重。 */
  tempoWeight: number;
  /** 抢牌竞争：对手对市场卡的需求压力权重。 */
  contestWeight: number;
  /** 商人卡组合价值：新卡与现有引擎的协同收益权重。 */
  synergyWeight: number;
  /** 魔像目标匹配：新卡产出与目标魔像费用契合度的权重。 */
  goalWeight: number;
  /** 商队容量管理：保留水晶（支付/弃置选择）的价值权重。 */
  capacityWeight: number;
  /** 休息行动成本：规划中含休息的路线额外惩罚乘子。 */
  restWeight: number;
  /** 终局紧迫程度：越接近终局引擎项衰减越快（stage 的指数）。 */
  endgameWeight: number;
  /** 结构变体（缺省 beam-lineage = 冠军基线）。
   * 'beam-contest'（Issue #20）：beam-rollout + 座位感知目标存活折扣。 */
  structure?: 'beam-lineage' | 'beam-adaptive' | 'beam-rollout' | 'beam-contest';
  /** 商人卡获取估值变体（缺省 baseline = 冠军基线实现）。
   * 'goal-remaining'：AI5 进化候选 66f6a296aa72（OpenEvolve 自动生成，两次独立
   * 进化重复发现）——goalFit 只统计目标魔像还缺的水晶（max(0, cost−stock)），
   * 其余项与基线逐字一致。变体经静态安全检查、3000 用例探针、沙箱对战与
   * 100 新种子深度验证后按 AI 4.0 挑战流程参赛（挑战证据见
   * training/reports/challenge-ai5-goal-remaining/）。 */
  acquisitionVariant?: 'baseline' | 'goal-remaining' | 'readiness-efficiency';
  /** 引擎价值模型（AI7 任务 C2；缺省/`v1` = 冻结冠军静态口径，行为逐位不变）。
   * `v2`：创造卡重复产出、升级卡长期作用、休息循环摊销、读取剩余回合与
   * 人数竞争折扣（ai/engine-model.ts）。只影响搜索/估值，不改变规则。 */
  engineModel?: 'v1' | 'v2';
  /** 人数条件策略（AI7 任务 C4；缺省/`flat` = 与人数无关的冻结口径）。
   * `stratified`：按人数折减引擎重复收益（必须在报告与评测中按人数分层
   * 单独消融，禁止用 5 人收益推断 2 人）。 */
  seatPolicy?: 'flat' | 'stratified';
  /** 显式适配器冠军（AI6 第五阶段）：结构候选（非参数变体）晋级后，决策入口
   * 按此分派到对应决策核心。携带 adapter 时 8 个权重乘子不参与决策（决策核心
   * 在适配器内，可缺省——validateAIParameters 会补默认值 1.0 保持类型完备）。
   * 'champion-guided'：JS5 冠军引导选择性联合搜索（web-v1/src/js/champion-guided.ts，
   * challengeIndex=10 晋级证据见 training/reports/js5-formal-challenge/）。 */
  adapter?: 'champion-guided';
  /** 适配器决策核心的版本 id（adapter='champion-guided' 时为联合规划版本）。 */
  jointVersion?: string;
  /** 适配器每决策墙钟预算（毫秒；缺省 100）。 */
  budgetMs?: number;
};

/** 参数合法区间；超出即拒绝（防止进化产生无意义参数）。 */
export const PARAMETER_BOUNDS = {
  engineWeight: [0.05, 5], tempoWeight: [0.05, 5], contestWeight: [0.05, 5],
  synergyWeight: [0.05, 5], goalWeight: [0.05, 5], capacityWeight: [0.05, 5],
  restWeight: [0.05, 5], endgameWeight: [0.25, 4],
} as const satisfies Record<string, readonly [number, number]>;

/** 基线参数：与 V3.0 第一阶段（main @ 8e3e2c3）行为完全一致。 */
export const BASELINE_PARAMETERS: AIParameters = {
  id: 'v4.0-baseline',
  engineWeight: 1, tempoWeight: 1, contestWeight: 1,
  synergyWeight: 1, goalWeight: 1, capacityWeight: 1,
  restWeight: 1, endgameWeight: 1,
};

// === CHAMPION-PARAMETERS-BEGIN（由 training/scripts/apply-champion.mjs 生成，勿手改） ===
export const CHAMPION_PARAMETERS: AIParameters = {
  id: "joint-js5",
  engineWeight: 1,
  tempoWeight: 1,
  contestWeight: 1,
  synergyWeight: 1,
  goalWeight: 1,
  capacityWeight: 1,
  restWeight: 1,
  endgameWeight: 1,
  acquisitionVariant: "readiness-efficiency",
  adapter: "champion-guided",
  jointVersion: "joint-js5",
  budgetMs: 100,
};
// === CHAMPION-PARAMETERS-END ===

const PARAM_KEYS = Object.keys(PARAMETER_BOUNDS) as Array<keyof typeof PARAMETER_BOUNDS>;

/** 校验并归一化参数对象；非法输入抛出明确错误。
 * 适配器冠军（source.adapter 存在）：权重乘子可缺省（补默认 1.0 保持类型完备），
 * jointVersion/budgetMs 按适配器口径校验；无 adapter 字段的输入校验行为与
 * 历史版本逐字节一致（同样的必填要求与错误文案）。 */
export function validateAIParameters(input: unknown): AIParameters {
  if (typeof input !== 'object' || input === null) throw new Error('AI 参数必须为对象');
  const source = input as Record<string, unknown>;
  if (typeof source.id !== 'string' || source.id.length === 0 || source.id.length > 64) {
    throw new Error('AI 参数缺少合法的 id');
  }
  const result: Partial<AIParameters> = { id: source.id };
  // 显式适配器冠军：决策核心在适配器内，权重乘子不参与决策（可缺省）。
  const adapterMode = source.adapter === 'champion-guided';
  if (source.adapter !== undefined) {
    if (source.adapter !== 'champion-guided') {
      throw new Error(`未知适配器冠军类型：${String(source.adapter)}`);
    }
    result.adapter = source.adapter;
  }
  for (const key of PARAM_KEYS) {
    const value = source[key];
    if (adapterMode && value === undefined) { result[key] = 1; continue; }
    const [low, high] = PARAMETER_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
      throw new Error(`参数 ${key} 必须为 ${low}–${high} 之间的有限数值，实际：${String(value)}`);
    }
    result[key] = value;
  }
  // 结构标识透传（可选）：合法性在此统一校验，决策入口无需重复。
  if (source.structure !== undefined) {
    if (source.structure !== 'beam-lineage' && source.structure !== 'beam-adaptive' && source.structure !== 'beam-rollout' && source.structure !== 'beam-contest') {
      throw new Error(`未知 AI 结构：${String(source.structure)}`);
    }
    result.structure = source.structure;
  }
  // 获取估值变体透传（可选）：与结构同为代码级版本轴，挑战流程按席位注入。
  if (source.acquisitionVariant !== undefined) {
    if (source.acquisitionVariant !== 'baseline' && source.acquisitionVariant !== 'goal-remaining' && source.acquisitionVariant !== 'readiness-efficiency') {
      throw new Error(`未知获取估值变体：${String(source.acquisitionVariant)}`);
    }
    result.acquisitionVariant = source.acquisitionVariant;
  }
  // 引擎模型/人数策略（AI7 候选）：枚举校验；缺省不写入字段（= v1/flat）。
  if (source.engineModel !== undefined) {
    if (source.engineModel !== 'v1' && source.engineModel !== 'v2') {
      throw new Error(`未知引擎价值模型：${String(source.engineModel)}`);
    }
    result.engineModel = source.engineModel;
  }
  if (source.seatPolicy !== undefined) {
    if (source.seatPolicy !== 'flat' && source.seatPolicy !== 'stratified') {
      throw new Error(`未知人数条件策略：${String(source.seatPolicy)}`);
    }
    result.seatPolicy = source.seatPolicy;
  }
  // 适配器冠军的版本与预算透传：jointVersion 交由决策入口对照联合规划版本
  // 注册表校验（此处只做形状校验，避免 parameters → js/adapter 循环依赖）。
  if (source.jointVersion !== undefined) {
    if (typeof source.jointVersion !== 'string' || !/^joint-js[0-9a-z-]+$/.test(source.jointVersion)) {
      throw new Error(`适配器冠军的 jointVersion 非法：${String(source.jointVersion)}`);
    }
    result.jointVersion = source.jointVersion;
  }
  if (source.budgetMs !== undefined) {
    if (typeof source.budgetMs !== 'number' || !Number.isFinite(source.budgetMs) || source.budgetMs < 1 || source.budgetMs > 10_000) {
      throw new Error(`适配器冠军的 budgetMs 必须为 1–10000 的有限数值，实际：${String(source.budgetMs)}`);
    }
    result.budgetMs = source.budgetMs;
  }
  if (result.adapter && !result.jointVersion) {
    throw new Error('适配器冠军缺少 jointVersion');
  }
  return result as AIParameters;
}

let activeParameters: AIParameters = CHAMPION_PARAMETERS;

/** 读取当前激活参数（正式游戏默认即冠军参数）。 */
export function getAIParameters(): AIParameters {
  return activeParameters;
}

/** 设置当前激活参数（训练/实验用；正式游戏无需调用）。 */
export function setAIParameters(parameters: AIParameters): void {
  activeParameters = validateAIParameters(parameters);
}

/** 恢复冠军基线参数。 */
export function resetAIParameters(): void {
  activeParameters = CHAMPION_PARAMETERS;
}

/** 版本注册表：多版本混战时按 id 解析参数。 */
const versionRegistry = new Map<string, AIParameters>();

export function registerAIVersion(parameters: AIParameters): void {
  const validated = validateAIParameters(parameters);
  versionRegistry.set(validated.id, validated);
}

export function resolveAIParameters(reference?: AIParameters | string | null): AIParameters {
  if (reference === undefined || reference === null) return activeParameters;
  if (typeof reference === 'string') {
    const found = versionRegistry.get(reference);
    if (!found) throw new Error(`未注册的 AI 版本：${reference}`);
    return found;
  }
  return validateAIParameters(reference);
}
