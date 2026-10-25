/** 从 c83f 公开观察证据中提取结构性回归 fixture（只含公开字段；空牌库）。
 * 选取标准：AI 席位、near-terminal risk、当步正式净分最大行动不在基线候选，
 * 且与 C10 的牌面/库存/座位/行动族不同。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');
const REPO = resolve(RUN, '../../../..');
const observations = JSON.parse(readFileSync(join(REPO, 'training/reports/human-js5-review/agent-20261025-c83f/evidence/public-observations.json'), 'utf8'));
const picks = [
  { game: 4, turn: 187, seat: 1, name: 'js5-near-terminal-ai-rest.json' },
  { game: 22, turn: 148, seat: 2, name: 'js5-near-terminal-ai-trade.json' },
  { game: 28, turn: 87, seat: 1, name: 'js5-budget-c04.json' },
  { game: 25, turn: 62, seat: 1, name: 'js5-budget-c09.json' },
  { game: 24, turn: 144, seat: 3, name: 'js5-budget-c12.json' },
];
for (const pick of picks) {
  const entry = observations.find(o => o.game === pick.game && o.turn === pick.turn && o.observation.playerId === pick.seat);
  if (!entry) throw new Error(`未找到 game=${pick.game} turn=${pick.turn} seat=${pick.seat}`);
  const view = entry.observation;
  if (view.phase !== 'turn' || view.triggerPlayer !== null) throw new Error('fixture 必须是 turn 阶段未触发');
  const fixture = {
    note: `公开观察 fixture：源自 c83f evidence/public-observations.json（game=${pick.game}, turn=${pick.turn}, seat=${pick.seat}）。只含公开状态；merchantDeck/golemDeck 为空数组。`,
    game: {
      version: 2, log: [],
      players: view.players.map(p => ({
        id: p.id, name: p.name, isAI: p.isAI,
        stock: [...p.stock], hand: [...p.hand], played: [...p.played], claimed: [...p.claimed],
        copper: p.copper, silver: p.silver, turns: p.turns,
      })),
      current: view.current,
      merchantMarket: view.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] })),
      golemMarket: [...view.golemMarket],
      copper: view.copper, silver: view.silver,
      phase: view.phase, triggerPlayer: view.triggerPlayer, turnNumber: view.turnNumber,
      merchantDeck: [], golemDeck: [],
    },
  };
  writeFileSync(join(REPO, 'web-v1/tests/fixtures', pick.name), JSON.stringify(fixture, null, 2) + '\n');
  process.stdout.write(`写入 web-v1/tests/fixtures/${pick.name}（game=${pick.game} turn=${pick.turn} seat=${pick.seat}）\n`);
}
