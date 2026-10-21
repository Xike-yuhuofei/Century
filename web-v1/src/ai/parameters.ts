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
  /** 结构变体（缺省 beam-lineage = 冠军基线）。 */
  structure?: 'beam-lineage' | 'beam-adaptive' | 'beam-rollout';
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
  id: "v4.0-baseline",
  engineWeight: 1,
  tempoWeight: 1,
  contestWeight: 1,
  synergyWeight: 1,
  goalWeight: 1,
  capacityWeight: 1,
  restWeight: 1,
  endgameWeight: 1,
};
// === CHAMPION-PARAMETERS-END ===

const PARAM_KEYS = Object.keys(PARAMETER_BOUNDS) as Array<keyof typeof PARAMETER_BOUNDS>;

/** 校验并归一化参数对象；非法输入抛出明确错误。 */
export function validateAIParameters(input: unknown): AIParameters {
  if (typeof input !== 'object' || input === null) throw new Error('AI 参数必须为对象');
  const source = input as Record<string, unknown>;
  if (typeof source.id !== 'string' || source.id.length === 0 || source.id.length > 64) {
    throw new Error('AI 参数缺少合法的 id');
  }
  const result: Partial<AIParameters> = { id: source.id };
  for (const key of PARAM_KEYS) {
    const value = source[key];
    const [low, high] = PARAMETER_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
      throw new Error(`参数 ${key} 必须为 ${low}–${high} 之间的有限数值，实际：${String(value)}`);
    }
    result[key] = value;
  }
  // 结构标识透传（可选）：合法性在此统一校验，决策入口无需重复。
  if (source.structure !== undefined) {
    if (source.structure !== 'beam-lineage' && source.structure !== 'beam-adaptive' && source.structure !== 'beam-rollout') {
      throw new Error(`未知 AI 结构：${String(source.structure)}`);
    }
    result.structure = source.structure;
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
