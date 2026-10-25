/**
 * Century AI5 演化目标：商人卡获取估值函数 acquisitionValue（初始程序 = 当前冠军实现）。
 *
 * 游戏语境：Century 五人对局中的商人卡获取决策。本函数为市场每张可获取的
 * 商人卡打分，分数越高越倾向获取；返回值进入规划器加权求和（乘 stage 系数
 * 0.35/0.32 后与其他规划项竞争），直接决定引擎建设节奏与关键商人卡竞争。
 *
 * 函数语义：
 * - state.stock: 当前持有的水晶库存（4 色数量数组，索引 0-3 对应四色水晶）
 * - state.hand / state.played: 手牌与已打出商人卡 id 列表（现有引擎构成）
 * - cardId: 待估值的市场商人卡
 * - preferred: 当前锁定的目标魔像 id（可能为 null）
 * - profile: { engine, contest } 席位人格权重
 * - pressure: 对手需求压力模型 { mean: Record<cardId, number>, peak: ... }
 *   mean=平均需求热度，peak=最强单一对手需求（均只来自公开信息）
 * - params: 8 个进化乘子（engineWeight / tempoWeight / contestWeight /
 *   synergyWeight / goalWeight / capacityWeight / restWeight / endgameWeight），
 *   涉及的乘子必须保持接入，不得删除参数项
 *
 * 作用域内可用依赖（所在文件已导入，禁止再 import 其他模块）：
 * - MERCHANT_BY_ID: Record<string, Merchant> 商人卡全集（kind: 'trade'|'create'|'upgrade'，
 *   input/output 为 4 色数量数组）
 * - GOLEM_BY_ID: Record<string, Golem> 魔像全集（cost 为 4 色费用数组）
 * - VALUES: 每色水晶价值表（number[4]）
 * - weighted(stock): 加权水晶总值；stockCount(stock): 总颗数；cloneStock(stock): 拷贝
 * - engineValue(state, preferred): 当前引擎对目标魔像的综合产出覆盖估值
 * - 类型：Golem / Stock（4 色数组）/ PressureModel / AIParameters
 *
 * 硬性约束（违反即淘汰）：
 * - 函数名、导出方式与参数签名不得改动
 * - 只能使用入参与上述依赖；禁止新增 import / require / eval / Function 构造器
 * - 禁止访问隐藏信息（merchantDeck / golemDeck 牌库顺序不存在于任何入参中）
 * - 禁止进程、网络、文件系统、全局可变状态；函数必须纯（同输入同输出）
 * - 不得按 cardId 硬编码查表作弊；逻辑必须对任意卡牌成立
 */
/* EVOLVE-BLOCK-START */
export function acquisitionValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
): number {
  const card = MERCHANT_BY_ID[cardId];
  if (!card) return 0;
  const current = engineValue(state, preferred);
  const added = { ...state, hand: [...state.hand, cardId] };
  const raw = Math.max(0, engineValue(added, preferred) - current);
  const target: Golem | null = preferred ? GOLEM_BY_ID[preferred] ?? null : null;
  const engine = [...state.hand, ...state.played].map(id => MERCHANT_BY_ID[id]).filter(Boolean);
  const supplied = engine.reduce((a, c) => {
    if (c.output) c.output.forEach((n, i) => { a[i] += n; });
    return a;
  }, [0, 0, 0, 0] as Stock);
  const synergy = card.kind === 'trade'
    ? card.input!.reduce((n, amount, i) => n + Math.min(amount, supplied[i]) * VALUES[i], 0) / (weighted(card.input!) + 1)
    : card.kind === 'create'
      ? engine.filter(c => c.kind === 'trade').reduce((n, c) =>
          n + c.input!.reduce((v, amount, i) => v + Math.min(amount, card.output![i]), 0), 0) * .18
      : .5;
  const goalFit = target && card.output
    ? card.output.reduce((n, amount, i) => n + Math.min(amount, target.cost[i]) * VALUES[i], 0) / (weighted(target.cost) + 1)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  // 被抢风险与目标契合叠加为紧迫度：越关键且越可能被抢，越值得立刻出手。
  const urgency = 1 + (risk > 0 && goalFit > 0 ? goalFit : 0);
  return profile.engine * (raw * .6 * params.engineWeight + synergy * 2 * params.synergyWeight + goalFit * 2 * params.goalWeight)
    + profile.contest * params.contestWeight * (demand * .45 + risk * urgency * .55) * .9;
}
/* EVOLVE-BLOCK-END */
