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
