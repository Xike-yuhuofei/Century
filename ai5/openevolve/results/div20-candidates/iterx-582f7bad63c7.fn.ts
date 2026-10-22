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
  const before = target
    ? target.cost.reduce((n, amount, i) => n + Math.max(0, amount - state.stock[i]) * VALUES[i], 0)
    : 0;
  const after = cloneStock(state.stock);
  const usable = card.kind === 'create' ||
    (card.kind === 'trade' && card.input!.every((n, i) => n <= after[i]));
  if (usable && card.input) card.input.forEach((n, i) => { after[i] -= n; });
  if (usable && card.output) card.output.forEach((n, i) => { after[i] += n; });
  const tempo = target && usable
    ? before - target.cost.reduce((n, amount, i) => n + Math.max(0, amount - after[i]) * VALUES[i], 0)
    : 0;
  const room = Math.max(0, 10 - stockCount(state.stock));
  const capacity = card.output
    ? Math.min(room, stockCount(card.output)) / (stockCount(card.output) + 1)
    : 0;
  const demand = pressure.mean[cardId] ?? 0;
  const risk = pressure.peak[cardId] ?? 0;
  const finish = before > 0 && tempo >= before ? 1 : 0;
  const handTax = Math.max(0, state.hand.length + state.played.length - 7) * .04;
  return profile.engine * (
      raw * .6 * params.engineWeight
      + synergy * 2 * params.synergyWeight
      + goalFit * 1.4 * params.goalWeight
      + Math.max(0, tempo) * .3 * params.tempoWeight
      + capacity * .25 * params.capacityWeight
      + finish * .6 * params.endgameWeight
      - handTax * params.restWeight
    )
    + profile.contest * params.contestWeight *
      (demand * .35 + risk * (.65 + finish * .35)) * .9;
}