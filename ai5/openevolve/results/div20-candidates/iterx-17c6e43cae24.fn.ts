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
  const input = card.input;
  const output = card.output;
  const missing = input
    ? input.reduce((n, amount, i) =>
        n + Math.max(0, amount - state.stock[i]) * VALUES[i], 0)
    : 0;
  const readiness = 1 / (1 + missing);
  const gain = output ? weighted(output) - (input ? weighted(input) : 0) : 2;
  const efficiency = Math.max(0, gain) / ((input ? stockCount(input) : 0) + 1);
  const goalFit = target && output
    ? output.reduce((n, amount, i) =>
        n + Math.min(amount, Math.max(0, target.cost[i] - state.stock[i])) * VALUES[i], 0
      ) / (weighted(target.cost) + 1)
    : 0;
  const room = Math.max(0, 10 - stockCount(state.stock));
  const growth = output
    ? Math.max(0, stockCount(output) - (input ? stockCount(input) : 0))
    : 0;
  const capacity = output
    ? growth === 0 ? 1 : Math.min(room, growth) / (growth + 1)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  const depth = state.hand.length + state.played.length;
  return profile.engine * (
      raw * .7 * params.engineWeight
      + synergy * readiness * 1.6 * params.synergyWeight
      + goalFit * .65 * params.goalWeight
      + efficiency * readiness * .45 * params.tempoWeight
      + capacity * .3 * params.capacityWeight
      + (goalFit + efficiency) / (depth + 2) * params.endgameWeight
      - Math.max(0, depth - 7) * .045 * params.restWeight
    )
    + profile.contest * params.contestWeight *
      (demand * .3 + risk * .7) *
      (1 + readiness * .12 + goalFit * .2);
}