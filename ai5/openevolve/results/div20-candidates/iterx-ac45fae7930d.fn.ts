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
  const ready = !card.input || card.input.every((n, i) => state.stock[i] >= n);
  const gain = card.output
    ? Math.max(0, stockCount(card.output) - (card.input ? stockCount(card.input) : 0))
    : 0;
  const room = Math.max(0, 10 - stockCount(state.stock));
  const size = state.hand.length + state.played.length;
  const urgency = 1 + (risk > 0 && goalFit > 0 ? goalFit : 0);
  return profile.engine * (
    raw * .6 * params.engineWeight
    + synergy * 2 * params.synergyWeight
    + goalFit * 2 * params.goalWeight
    + (ready ? .025 : 0) * params.tempoWeight
    + Math.min(room, gain) * .012 * params.capacityWeight
    + (ready && state.played.length ? .01 : 0) * params.restWeight
    - Math.max(0, size - 5) * .035 * params.endgameWeight
  ) + profile.contest * params.contestWeight
    * (demand * .45 + risk * urgency * .55) * .9;
}