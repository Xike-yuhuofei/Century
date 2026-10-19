/** 仅用于展示：整理卡牌顺序不改变规则引擎中的真实手牌集合。 */
export type CardGroup = 'create' | 'upgrade' | 'trade';
export function visibleOrder(hand: readonly string[], preferred: readonly string[]): string[] {
  const available = new Set(hand);
  return [...new Set(preferred.filter(id => available.has(id))), ...hand.filter(id => !preferred.includes(id))];
}
/** 保留已打出卡牌的相对顺序，休息收回时可以回到用户原定位置。 */
export function moveInOrder(owned: readonly string[], preferred: readonly string[], id: string, target: string): string[] {
  const result = visibleOrder(owned, preferred);
  const from = result.indexOf(id), to = result.indexOf(target);
  if (from < 0 || to < 0 || from === to) return result;
  result.splice(from, 1);
  result.splice(result.indexOf(target), 0, id);
  return result;
}
export function stepInOrder(owned: readonly string[], preferred: readonly string[], id: string, delta: -1 | 1): string[] {
  const result = visibleOrder(owned, preferred);
  const i = result.indexOf(id);
  const next = i + delta;
  if (i < 0 || next < 0 || next >= result.length) return result;
  [result[i], result[next]] = [result[next], result[i]];
  return result;
}
export function groupOrder(owned: readonly string[], preferred: readonly string[], lookup: (id:string) => CardGroup): string[] {
  const priority: Record<CardGroup, number> = { create:0, upgrade:1, trade:2 };
  return visibleOrder(owned, preferred).sort((a,b) => priority[lookup(a)] - priority[lookup(b)]);
}
