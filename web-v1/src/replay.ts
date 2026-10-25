import { GOLEM_BY_ID, MERCHANT_BY_ID } from './data.js';
import { ranking, readable, score, type Action, type Game, type Player, type Replay, type ReplayTurn } from './engine.js';

export function replayCoverage(g: Game): string {
  if (!g.replay) return '旧存档：没有完整回合记录，仅保留近期日志；后续行动将开始记录。';
  return `${g.replay.fromStart ? '从开局完整记录' : `旧存档：从第 ${g.replay.initial.turnNumber} 手开始记录，之前行动无法恢复`} · ${g.replay.turns.length} 个回合${g.phase === 'overflow' ? '（当前回合待弃置）' : ''}`;
}

function actionText(a: Action, t: ReplayTurn): string {
  if (a.type === 'discard') return `超额弃置：${a.colors.map(c => ['黄','绿','蓝','粉'][c]).join('、')}`;
  if (a.type === 'rest') return `休息，收回 ${t.before.played.length} 张商人卡（${t.before.played.join('、') || '无'}）`;
  if (a.type === 'acquire') return `获取商人卡 ${t.cardId}，市场第 ${a.index + 1} 张，依次支付：${a.payment.map(c => ['黄','绿','蓝','粉'][c]).join('、') || '免费'}`;
  if (a.type === 'claim') return `认领魔像 ${t.cardId}（${GOLEM_BY_ID[t.cardId!].points} 分），市场第 ${a.index + 1} 张，支付：${readable(GOLEM_BY_ID[t.cardId!].cost)}`;
  const card = MERCHANT_BY_ID[a.cardId];
  const effect = card.kind === 'create' ? `创造 ${readable(card.output!)}` : card.kind === 'trade' ? `交易 ${a.repeats ?? 1} 次，每次 ${readable(card.input!)} → ${readable(card.output!)}` : `升级 ${(a.steps ?? []).length} 次：${(a.steps ?? []).map(c => `${['黄','绿','蓝'][c]}→${['绿','蓝','粉'][c]}`).join('、') || '跳过升级'}`;
  return `打出 ${a.cardId}，${effect}`;
}
const plainName = (s: string) => s.replace(/[\r\n|<>#*`\[\]\\]/g, ' ');
function playerPosition(p: Player): string {
  return `水晶 ${readable(p.stock)}；铜 ${p.copper}、银 ${p.silver}；估分 ${score(p)}；手牌 ${p.hand.join('、') || '无'}；已打出 ${p.played.join('、') || '无'}；魔像 ${p.claimed.join('、') || '无'}`;
}

export function replayMarkdown(g: Game): string {
  const lines = ['# 晶石回廊 · 对局复盘', '', `状态：${g.phase === 'finished' ? '已结束' : g.phase === 'overflow' ? '进行中，当前回合待弃置' : '进行中'}；${g.players.length} 人${g.players.length === 6 ? '（非官方六人扩展）' : ''}`, '', replayCoverage(g), '', '## 玩家与当前成绩', '', ...ranking(g).map((p, i) => `${i + 1}. ${plainName(p.name)}（座位 ${p.id + 1}，${p.isAI ? 'AI' : '真人'}）：${score(p)} 分，${p.turns} 回合，${p.claimed.length} 张魔像，铜 ${p.copper}、银 ${p.silver}、非黄水晶 ${p.stock[1] + p.stock[2] + p.stock[3]} 颗`), '', g.phase === 'finished' ? '平分时本轮后手优先。' : '对局尚未结束，以上为当前估分。', '', '## 记录起点', ''];
  const initial = g.replay?.initial ?? g;
  lines.push(...initial.players.map(p => `- ${plainName(p.name)}：${playerPosition(p)}`), '', `商人市场：${initial.merchantMarket.map(m => `${m.id}（奖励 ${readable(m.bonus)}）`).join('、')}`, `魔像市场：${initial.golemMarket.join('、')}`, '', '## 按回合的行动', '');
  for (const t of g.replay?.turns ?? []) {
    lines.push(`### 第 ${t.round} 轮 · 第 ${t.turnNumber} 手 · ${plainName(t.before.name)}（座位 ${t.playerId + 1}，个人第 ${t.playerTurn} 回合）`, '', ...t.actions.map(a => `- ${actionText(a, t)}`), `- 行动前：${playerPosition(t.before)}`, `- 行动后：${playerPosition(t.after)}`, `- 本回合估分变化：${score(t.after) - score(t.before)}`, ...(t.triggersEnd ? ['- 触发终局，本轮结束后结算。'] : []), ...(!t.completed ? ['- 回合未完成：等待超额弃置。'] : []), '');
  }
  if (!g.replay?.fromStart) lines.push('## 旧存档起点的近期日志（不代表完整历史）', '', ...initial.log.slice().reverse().map(l => `- ${plainName(l)}`), '');
  if (!g.replay?.turns.length) lines.push('尚无已记录行动。', '');
  return lines.join('\n');
}

export function replayJSON(g: Game): string {
  return JSON.stringify({format: 'century-replay', version: 1, coverage: replayCoverage(g), replay: g.replay ?? null, current: {...g, replay: undefined}}, null, 2);
}

export function downloadReplay(g: Game): void {
  const url = URL.createObjectURL(new Blob([replayJSON(g)], {type: 'application/json;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = `century-replay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 新增字段在备份导入时也需要校验，避免坏历史阻断行动或导出。 */
export function validateReplay(value: unknown, g: Game): asserts value is Replay | undefined {
  if (value === undefined) return;
  const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const ids = (a: unknown, cards: Record<string, unknown>) => Array.isArray(a) && a.every(id => typeof id === 'string' && Object.hasOwn(cards, id));
  const player = (p: any) => p && integer(p.id) && p.id < g.players.length && typeof p.name === 'string' && p.name.length <= 20 &&
    Array.isArray(p.stock) && p.stock.length === 4 && p.stock.every(integer) && integer(p.copper) && integer(p.silver) && integer(p.turns) && ids(p.hand, MERCHANT_BY_ID) && ids(p.played, MERCHANT_BY_ID) && ids(p.claimed, GOLEM_BY_ID);
  const colors = (a: unknown, max = 3) => Array.isArray(a) && a.every(c => integer(c) && c <= max);
  const action = (a: any) => a && (a.type === 'rest' || a.type === 'discard' && colors(a.colors) || a.type === 'acquire' && integer(a.index) && a.index < 6 && colors(a.payment) || a.type === 'claim' && integer(a.index) && a.index < 5 || a.type === 'play' && Object.hasOwn(MERCHANT_BY_ID, a.cardId) && (a.steps === undefined || colors(a.steps, 2)) && (a.repeats === undefined || integer(a.repeats) && a.repeats >= 1 && a.repeats <= 10));
  const r = value as Replay;
  const initialValid = r?.initial && !('replay' in r.initial) && integer(r.initial.turnNumber) && r.initial.turnNumber > 0 &&
    Array.isArray(r.initial.players) && r.initial.players.length === g.players.length && r.initial.players.every(player) &&
    Array.isArray(r.initial.log) && r.initial.log.every(l => typeof l === 'string') && ids(r.initial.golemMarket, GOLEM_BY_ID) &&
    Array.isArray(r.initial.merchantMarket) && r.initial.merchantMarket.every(m => m && Object.hasOwn(MERCHANT_BY_ID, m.id) && Array.isArray(m.bonus) && m.bonus.length === 4 && m.bonus.every(integer));
  const turnValid = (t: ReplayTurn, i: number): boolean => !!t &&
    integer(t.turnNumber) && t.turnNumber >= r.initial.turnNumber && t.turnNumber <= g.turnNumber &&
    (!i || t.turnNumber > r.turns[i - 1].turnNumber) &&
    t.round === Math.floor((t.turnNumber - 1) / g.players.length) + 1 && integer(t.playerTurn) && t.playerTurn > 0 &&
    integer(t.playerId) && t.playerId < g.players.length && player(t.before) && player(t.after) &&
    t.before.id === t.playerId && t.after.id === t.playerId && typeof t.completed === 'boolean' && typeof t.triggersEnd === 'boolean' &&
    Array.isArray(t.actions) && t.actions.length >= 1 && t.actions.length <= 2 && t.actions.every(action) &&
    t.actions.every(a => a.type !== 'claim' && a.type !== 'acquire' || typeof t.cardId === 'string' && Object.hasOwn(a.type === 'claim' ? GOLEM_BY_ID : MERCHANT_BY_ID, t.cardId));
  if (!r || r.version !== 1 || typeof r.fromStart !== 'boolean' || !initialValid ||
      r.fromStart && r.initial.turnNumber !== 1 || !Array.isArray(r.turns) || !r.turns.every(turnValid)) {
    throw Error('存档的复盘记录无效，请导入有效备份');
  }
}
