export type Stock = [number, number, number, number];
export type Merchant = {
  id: string;
  kind: 'create' | 'upgrade' | 'trade';
  output?: Stock;
  input?: Stock;
  steps?: number;
  starter?: boolean;
};
export type Golem = { id: string; points: number; cost: Stock };

const stock = (text: string): Stock => {
  const values = text.split(',').map(Number);
  if (values.length !== 4 || values.some(x => !Number.isInteger(x) || x < 0)) {
    throw new Error(`无效水晶结构：${text}`);
  }
  return values as Stock;
};

export const STARTER_CARDS: Merchant[] = Array.from({ length: 5 }, (_, i) => [
  { id: `S${i + 1}C`, kind: 'create' as const, output: stock('2,0,0,0'), starter: true },
  { id: `S${i + 1}U`, kind: 'upgrade' as const, steps: 2, starter: true },
]).flat();

const creations = [
  '4,0,0,0', '3,0,0,0', '2,1,0,0', '1,1,0,0',
  '0,2,0,0', '1,0,1,0', '0,0,1,0', '0,0,0,1',
];
const trades = [
  ['2,0,0,0', '0,0,1,0'],
  ['2,0,0,0', '0,2,0,0'],
  ['3,0,0,0', '0,0,0,1'],
  ['3,0,0,0', '0,1,1,0'],
  ['3,0,0,0', '0,3,0,0'],
  ['4,0,0,0', '0,0,2,0'],
  ['4,0,0,0', '0,0,1,1'],
  ['5,0,0,0', '0,0,3,0'],
  ['5,0,0,0', '0,0,0,2'],
  ['0,1,0,0', '3,0,0,0'],
  ['0,2,0,0', '3,0,1,0'],
  ['0,2,0,0', '0,0,2,0'],
  ['0,2,0,0', '2,0,0,1'],
  ['0,3,0,0', '2,0,2,0'],
  ['0,3,0,0', '0,0,3,0'],
  ['0,3,0,0', '1,0,1,1'],
  ['0,3,0,0', '0,0,0,2'],
  ['0,0,1,0', '0,2,0,0'],
  ['0,0,1,0', '1,2,0,0'],
  ['0,0,1,0', '4,1,0,0'],
  ['0,0,2,0', '2,3,0,0'],
  ['0,0,2,0', '2,1,0,1'],
  ['0,0,2,0', '0,2,0,1'],
  ['0,0,2,0', '0,0,0,2'],
  ['0,0,3,0', '0,0,0,3'],
  ['0,0,0,1', '2,2,0,0'],
  ['0,0,0,1', '0,3,0,0'],
  ['0,0,0,1', '3,0,1,0'],
  ['0,0,0,1', '1,1,1,0'],
  ['0,0,0,1', '0,0,2,0'],
  ['0,0,0,2', '1,1,3,0'],
  ['0,0,0,2', '0,3,2,0'],
  ['1,1,0,0', '0,0,0,1'],
  ['2,0,1,0', '0,0,0,2'],
];

export const MERCHANT_DECK: Merchant[] = [
  ...creations.map((output, i) => ({ id: `M${String(i + 1).padStart(2,'0')}`, kind: 'create' as const, output: stock(output) })),
  { id: 'M09', kind: 'upgrade', steps: 3 },
  ...trades.map(([input, output], i) => ({
    id: `M${String(i + 10).padStart(2,'0')}`, kind: 'trade' as const,
    input: stock(input), output: stock(output),
  })),
];

const golemRows: [number, string[]][] = [
  [6, ['2,2,0,0']],
  [7, ['3,2,0,0']],
  [8, ['2,3,0,0','0,4,0,0','2,0,2,0']],
  [9, ['2,1,0,1','3,0,2,0']],
  [10, ['0,5,0,0','2,0,0,2','0,2,2,0']],
  [11, ['2,0,3,0','3,0,0,2']],
  [12, ['0,2,0,2','0,2,1,1','0,3,2,0','1,1,1,1','0,0,4,0','1,0,2,1']],
  [13, ['0,2,3,0','2,2,2,0']],
  [14, ['0,0,2,2','2,0,0,3','3,1,1,1','0,3,0,2']],
  [15, ['2,2,0,2','0,0,5,0']],
  [16, ['0,2,0,3','1,3,1,1','0,0,0,4']],
  [17, ['0,0,3,2','2,0,2,2']],
  [18, ['0,0,2,3','1,1,3,1']],
  [19, ['0,2,2,2']],
  [20, ['0,0,0,5','1,1,1,3']],
];
export const GOLEM_DECK: Golem[] = golemRows.flatMap(([points, costs]) =>
  costs.map(cost => ({ id: '', points, cost: stock(cost) }))
).map((x, i) => ({ ...x, id: `G${String(i + 1).padStart(2,'0')}` }));

export const MERCHANT_BY_ID = Object.fromEntries([...STARTER_CARDS, ...MERCHANT_DECK].map(m => [m.id, m])) as Record<string, Merchant>;
export const GOLEM_BY_ID = Object.fromEntries(GOLEM_DECK.map(g => [g.id, g])) as Record<string, Golem>;

// 检查数据完整性；不要以「理论增益」替代真实的行动合法性校验。
if (STARTER_CARDS.length !== 10 || MERCHANT_DECK.length !== 43 || GOLEM_DECK.length !== 36) {
  throw new Error('卡牌数量应为 10 + 43 + 36 = 89');
}
for (const g of GOLEM_DECK) {
  const colors = g.cost.filter(x => x > 0).length;
  const value = g.cost.reduce((sum, n, i) => sum + n * (i + 1), 0);
  if (value + (colors === 3 ? 1 : colors === 4 ? 2 : 0) !== g.points) {
    throw new Error(`魔像卡数据与计分不符：${g.id}`);
  }
}