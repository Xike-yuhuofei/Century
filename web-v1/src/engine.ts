import { GOLEM_BY_ID, GOLEM_DECK, MERCHANT_BY_ID, MERCHANT_DECK, type Stock } from './data.js';

export type Color = 0 | 1 | 2 | 3;
export type Player = {
  id: number;
  name: string;
  stock: Stock;
  hand: string[];
  played: string[];
  claimed: string[];
  copper: number;
  silver: number;
  turns: number;
  /** AI 席位；旧版存档缺省为人类。 */
  isAI?: boolean;
};
export type MarketMerchant = { id: string; bonus: Stock };
export type Game = {
  version: 2;
  players: Player[];
  current: number;
  merchantMarket: MarketMerchant[];
  merchantDeck: string[];
  golemMarket: string[];
  golemDeck: string[];
  copper: number;
  silver: number;
  phase: 'turn' | 'overflow' | 'finished';
  triggerPlayer: number | null;
  log: string[];
  turnNumber: number;
};
export type Action =
  | { type: 'play'; cardId: string; steps?: Color[]; repeats?: number }
  | { type: 'acquire'; index: number; payment: Color[] }
  | { type: 'claim'; index: number }
  | { type: 'rest' }
  | { type: 'discard'; colors: Color[] };
export const COLOR_NAMES = ['黄', '绿', '蓝', '粉'] as const;

export const count = (stock: Stock) => stock.reduce((s, v) => s + v, 0);
export const freshStock = (): Stock => [0, 0, 0, 0];
export const has = (available: Stock, needed: Stock) => needed.every((n, i) => available[i] >= n);
export const add = (a: Stock, b: Stock, factor = 1): Stock => a.map((x, i) => x + b[i] * factor) as Stock;
export const readable = (stock: Stock) => stock.map((n, i) => n ? `${COLOR_NAMES[i]}×${n}` : '').filter(Boolean).join('、') || '无';

const fail = (message: string): never => { throw new Error(message); };
const requireThat = (condition: unknown, message: string) => { if (!condition) fail(message); };
const isColor = (i: number): i is Color => Number.isInteger(i) && i >= 0 && i <= 3;
const clone = (game: Game): Game => JSON.parse(JSON.stringify(game)) as Game;

function shuffled<T>(array: T[], random: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function generator(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}
export function createGame(playerNames: string[], seed = Math.floor(Math.random() * 2 ** 32), aiSeats: number[] = []): Game {
  requireThat(playerNames.length >= 2 && playerNames.length <= 6, '游戏人数必须为 2–6 人（6 人仅限 2 真人 + 4 AI 扩展模式）');
  requireThat(playerNames.every(name => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 20), '玩家姓名不能为空且不超过 20 字');
  requireThat(Array.isArray(aiSeats) && new Set(aiSeats).size === aiSeats.length && aiSeats.every(n => Number.isInteger(n) && n >= 0 && n < playerNames.length), 'AI 席位序号无效');
  requireThat(aiSeats.length <= 4 && aiSeats.length < playerNames.length, '最多 4 名 AI，且至少有 1 名人类玩家');
  requireThat(playerNames.length !== 6 || (aiSeats.length === 4 && aiSeats.every(i => i >= 2)), '六人扩展仅允许 2 名人类 + 4 名 AI（固定后四席）');
  const random = generator(seed);
  const merchantDeck = shuffled(MERCHANT_DECK.map(m => m.id), random);
  const golemDeck = shuffled(GOLEM_DECK.map(g => g.id), random);
  const game: Game = {
    version: 2,
    players: playerNames.map((name, i) => ({
      id: i, name: name.trim(), isAI: aiSeats.includes(i),
      stock: i === 0 ? [3,0,0,0] : i === 1 || i === 2 ? [4,0,0,0] : [3,1,0,0], // 第六席沿用四/五号的起始水晶，仅供非官方扩展
      hand: ['S01', 'S02'], played: [], claimed: [], copper: 0, silver: 0, turns: 0,
    })),
    current: 0, merchantMarket: [], merchantDeck,
    golemMarket: [], golemDeck,
    copper: playerNames.length * 2, silver: playerNames.length * 2,
    phase: 'turn', triggerPlayer: null, log: [], turnNumber: 1,
  };
  for (let i = 0; i < 6; i++) drawMerchant(game);
  for (let i = 0; i < 5; i++) drawGolem(game);
  record(game, `游戏开始，${game.players.length} 人对局，由 ${game.players[0].name} 先手`);
  return game;
}
function drawMerchant(g: Game) {
  const id = g.merchantDeck.shift();
  if (id) g.merchantMarket.push({ id, bonus: freshStock() });
}
function drawGolem(g: Game) {
  const id = g.golemDeck.shift();
  if (id) g.golemMarket.push(id);
}
function record(g: Game, message: string) {
  g.log.unshift(message);
  g.log = g.log.slice(0, 45);
}
function finishAction(g: Game) {
  const player = g.players[g.current];
  if (count(player.stock) > 10) {
    g.phase = 'overflow';
    record(g, `${player.name} 商队超过 10 颗，需弃置 ${count(player.stock) - 10} 颗`);
    return;
  }
  player.turns += 1;
  const next = (g.current + 1) % g.players.length;
  if (g.triggerPlayer !== null && next === 0) {
    g.phase = 'finished';
    record(g, '全体玩家完成本轮，游戏结束');
  } else {
    g.current = next;
    g.turnNumber += 1;
  }
}
function applyPlay(g: Game, a: Extract<Action, {type: 'play'}>) {
  const p = g.players[g.current];
  const idx = p.hand.indexOf(a.cardId);
  requireThat(idx >= 0, '只能打出当前手牌中的商人卡');
  const card = MERCHANT_BY_ID[a.cardId];
  requireThat(!!card, '未知商人卡');
  let detail = '';
  if (card.kind === 'create') {
    requireThat(!a.steps?.length && a.repeats === undefined, '创造卡不接受额外参数');
    p.stock = add(p.stock, card.output!);
    detail = `创造 ${readable(card.output!)}`;
  } else if (card.kind === 'upgrade') {
    const steps = a.steps ?? [];
    requireThat(a.repeats === undefined && steps.length <= card.steps!, `本卡最多升级 ${card.steps} 次`);
    for (const source of steps) {
      requireThat(isColor(source) && source < 3, '只能升级黄、绿、蓝水晶');
      requireThat(p.stock[source] > 0, `没有可升级的${COLOR_NAMES[source]}水晶`);
      p.stock[source]--;
      p.stock[source + 1]++;
    }
    detail = `升级 ${steps.length} 次`;
  } else {
    const n = a.repeats ?? 1;
    requireThat(Number.isSafeInteger(n) && n >= 1 && n <= 10 && !a.steps?.length, '交易次数无效');
    for (let i = 0; i < n; i++) {
      requireThat(has(p.stock, card.input!), `第 ${i + 1} 次交易的水晶不足`);
      p.stock = add(add(p.stock, card.input!, -1), card.output!);
    }
    detail = `交易 ${n} 次：${readable(card.input!)} → ${readable(card.output!)}`;
  }
  p.hand.splice(idx, 1);
  p.played.push(card.id);
  record(g, `${p.name} 打出 ${detail}`);
  finishAction(g);
}
function applyAcquire(g: Game, a: Extract<Action, {type:'acquire'}>) {
  const p = g.players[g.current];
  requireThat(Number.isInteger(a.index) && a.index >= 0 && a.index < g.merchantMarket.length, '无效商人卡位置');
  requireThat(Array.isArray(a.payment) && a.payment.length === a.index, `需要支付 ${a.index} 颗水晶`);
  const remaining = [...p.stock] as Stock;
  for (const c of a.payment) {
    requireThat(isColor(c) && remaining[c] > 0, '市场位置费用无效或水晶不足');
    remaining[c]--;
  }
  for (let i = 0; i < a.index; i++) g.merchantMarket[i].bonus[a.payment[i]]++;
  const target = g.merchantMarket.splice(a.index, 1)[0];
  p.stock = add(remaining, target.bonus);
  p.hand.push(target.id);
  drawMerchant(g);
  record(g, `${p.name} 获取商人卡 ${target.id}（支付 ${a.payment.length}，收回卡上 ${count(target.bonus)} 颗）`);
  finishAction(g);
}
function applyClaim(g: Game, a: Extract<Action, {type:'claim'}>) {
  const p = g.players[g.current];
  requireThat(Number.isInteger(a.index) && a.index >= 0 && a.index < g.golemMarket.length, '无效魔像卡位置');
  const id = g.golemMarket[a.index];
  const card = GOLEM_BY_ID[id];
  requireThat(has(p.stock, card.cost), '商队水晶不足，无法认领该魔像');
  p.stock = add(p.stock, card.cost, -1);
  p.claimed.push(id);
  let coin = '';
  if (a.index === 0 && g.copper > 0) { g.copper--; p.copper++; coin = '、获得铜币 3 分'; }
  else if (a.index === 0 && g.copper === 0 && g.silver > 0) { g.silver--; p.silver++; coin = '、获得银币 1 分'; }
  else if (a.index === 1 && g.copper > 0 && g.silver > 0) { g.silver--; p.silver++; coin = '、获得银币 1 分'; }
  g.golemMarket.splice(a.index, 1);
  drawGolem(g);
  record(g, `${p.name} 认领 ${card.points} 分魔像${coin}`);
  const target = g.players.length >= 4 ? 5 : 6;
  if (p.claimed.length >= target && g.triggerPlayer === null) {
    g.triggerPlayer = g.current;
    record(g, `${p.name} 认领第 ${target} 张魔像，触发终局，本轮结束后结算`);
  }
  finishAction(g);
}
export function applyAction(game: Game, action: Action): Game {
  const g = clone(game);
  requireThat(g.phase !== 'finished', '游戏已经结束');
  const p = g.players[g.current];
  if (g.phase === 'overflow') {
    if (action.type !== 'discard') throw new Error('必须先弃置超出上限的水晶');
    const excess = count(p.stock) - 10;
    requireThat(Array.isArray(action.colors) && action.colors.length === excess, `必须弃置恰好 ${excess} 颗`);
    for (const color of action.colors) {
      requireThat(isColor(color) && p.stock[color] > 0, '弃置的水晶不存在');
      p.stock[color]--;
    }
    record(g, `${p.name} 弃置 ${excess} 颗水晶`);
    g.phase = 'turn';
    finishAction(g);
    return g;
  }
  requireThat(action.type !== 'discard', '当前无需弃置水晶');
  if (action.type === 'play') applyPlay(g, action);
  else if (action.type === 'acquire') applyAcquire(g, action);
  else if (action.type === 'claim') applyClaim(g, action);
  else if (action.type === 'rest') {
    p.hand.push(...p.played);
    p.played = [];
    record(g, `${p.name} 休息，收回全部已打出商人卡`);
    finishAction(g);
  } else fail('未知行动类型');
  return g;
}
export function score(p: Player): number {
  return p.claimed.reduce((sum, id) => sum + GOLEM_BY_ID[id].points, 0) + p.copper * 3 + p.silver + p.stock.slice(1).reduce((sum, x) => sum + x, 0);
}
export function ranking(g: Game): Player[] {
  // 平分时本轮后手优先；实际结算在当前整轮完成以后发生。
  return [...g.players].sort((a, b) => score(b) - score(a) || b.id - a.id);
}
export function tradeLimit(available: Stock, cardId: string): number {
  const card = MERCHANT_BY_ID[cardId];
  if (!card || card.kind !== 'trade') return 0;
  return Math.min(10, ...card.input!.map((n, i) => n > 0 ? Math.floor(available[i] / n) : 10));
}
export function legalClaimIndices(g: Game): number[] {
  return g.golemMarket.flatMap((id, index) => has(g.players[g.current].stock, GOLEM_BY_ID[id].cost) ? [index] : []);
}
