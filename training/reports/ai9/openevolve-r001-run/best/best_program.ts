// AI9 多模块联合进化程序
// 模块：M02:acquisitionValue / M05:restMultiplier
// 每个 EVOLVE-BLOCK 对应一个模块；不得增删 block、不得改签名。
// 只能使用各模块的 scope 列出的作用域内依赖；禁止 import/eval/网络/文件/进程/
// 随机数/时钟/隐藏牌库字段；函数必须纯且确定性。
// ===== M02 商人卡获取 =====
// 函数：acquisitionValue（ai/evaluator.ts）
// 签名：(state, cardId, preferred, profile, pressure, params, model)
// 真实决策接线：planner: searchGrade/prospectiveFormula 的新卡价值 + champion-guided 冠军基座
// 依赖模块：M03, M04
// 作用域内可用依赖：MERCHANT_BY_ID、GOLEM_BY_ID、VALUES、weighted、stockCount、cloneStock、engineValue、goalGap、stockPotential、keepValue、trimStock、acquisitionRepeatDelta、types: Golem/Stock/PressureModel/AIParameters/EngineModelContext
// ===== M05 打出与休息调度 =====
// 函数：restMultiplier（ai/evolve/modules.ts）
// 签名：(state, preferred, params)
// 真实决策接线：planner.searchGrade：休息路线惩罚乘子（缺省 1）
// 依赖模块：无
// 作用域内可用依赖：GOLEM_BY_ID、MERCHANT_BY_ID、has、tradeLimit、VALUES、weighted、stockCount、types: AIObservation/Action/AIParameters/EvolveStateView

/* EVOLVE-BLOCK-START */
export function acquisitionValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
  model: EngineModelContext | null = null,
): number {
  // AI7 C2：v2 只追加"重复使用增量"（创造卡可反复产出/升级卡长期作用/
  // 交易卡循环），叠加在冻结的获取估值血统之上——不替换、不放大其他项。
  const withV2 = (value: number): number =>
    params.engineModel === 'v2' && model
      ? value + acquisitionRepeatDelta(cardId, state, preferred, model)
      : value;
  if (params.acquisitionVariant === 'goal-remaining') {
    return withV2(acquisitionValueGoalRemaining(state, cardId, preferred, profile, pressure, params));
  }
  if (params.acquisitionVariant === 'readiness-efficiency') {
    return withV2(acquisitionValueReadinessEfficiency(state, cardId, preferred, profile, pressure, params));
  }
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
  return withV2(profile.engine * (raw * .6 * params.engineWeight + synergy * 2 * params.synergyWeight + goalFit * 2 * params.goalWeight)
    + profile.contest * params.contestWeight * (demand * .45 + risk * urgency * .55) * .9);
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
export function restMultiplier(state: EvolveStateView, preferred: string | null, params: AIParameters): number {
  const total = state.hand.length + state.played.length;
  if (!total || !state.played.length) return 1.12;
  return 1.12 - .24 * state.played.length / total;
}
/* EVOLVE-BLOCK-END */
