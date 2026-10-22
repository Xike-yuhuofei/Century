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
  // 只奖励补足目标的实际缺口，避免继续高估库存已经满足的颜色。
  const goalFit = target && card.output
    ? card.output.reduce((n, amount, i) =>
        n + Math.min(amount, Math.max(0, target.cost[i] - state.stock[i])) * VALUES[i], 0)
      / (weighted(target.cost) + 1)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  const readiness = card.kind === 'trade'
    ? card.input!.reduce((n, amount, i) =>
        n + Math.min(amount, state.stock[i]) * VALUES[i], 0) / (weighted(card.input!) + 1)
      * (.5 + .5 * card.input!.reduce((r, amount, i) =>
          amount ? Math.min(r, state.stock[i] / amount) : r, 1))
    : card.kind === 'upgrade'
      ? Math.min(1, state.stock.reduce((n, amount, i) =>
          n + amount * (VALUES.length - 1 - i), 0) / 6)
      : Math.min(1, Math.max(0, 10 - stockCount(state.stock)) /
          Math.max(1, stockCount(card.output!)));
  return profile.engine * (
    raw * .6 * params.engineWeight
    + synergy * 2 * params.synergyWeight
    + goalFit * 2 * params.goalWeight
    + readiness * (.35 * params.tempoWeight + .2 * params.capacityWeight)
  ) + profile.contest * params.contestWeight
    * (demand * .45 + risk * (1 + goalFit * .5) * .55) * .9;
}