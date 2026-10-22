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
  const raw = Math.max(0,
    engineValue({ ...state, hand: [...state.hand, cardId] }, preferred)
      - engineValue(state, preferred)
  );
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
    ? Math.max(0, card.output.reduce((n, amount, i) => {
        const missing = Math.max(0, target.cost[i] - state.stock[i]);
        return n + (Math.min(amount, missing)
          - Math.min(card.input?.[i] ?? 0, missing)) * VALUES[i];
      }, 0)) / (target.cost.reduce((n, amount, i) =>
        n + Math.max(0, amount - state.stock[i]) * VALUES[i], 0) + 1)
    : 0;
  // 小幅偏好拿到后即可运转的牌，减少投资于暂时无法启动的引擎组件。
  const ready = card.input && stockCount(card.input) > 0
    ? card.input.reduce((n, amount, i) =>
        n + Math.min(amount, state.stock[i]), 0) / stockCount(card.input)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  // 被抢风险与目标契合叠加为紧迫度：越关键且越可能被抢，越值得立刻出手。
  const urgency = 1 + (risk > 0 && goalFit > 0 ? goalFit : 0);
  return profile.engine * (raw * .6 * params.engineWeight + ready * .12 * params.tempoWeight
      + synergy * 2 * params.synergyWeight + goalFit * 2 * params.goalWeight)
    + profile.contest * params.contestWeight * (demand * .45 + risk * urgency * .55) * .9;
}