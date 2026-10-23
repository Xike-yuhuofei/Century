import { ranking, score, type Game } from './engine.js';
import { validateReplay } from './replay.js';

/** 已结束（或被新开一局覆盖前）对局的本地归档：完整游戏快照，可回看、可导出。 */
export type ArchiveEntry = {
  /** 稳定指纹：同一对局重复归档（结束时 + 重开覆盖时）只保留一条。 */
  id: string;
  savedAt: string;
  finished: boolean;
  players: number;
  turns: number;
  title: string;
  game: Game;
};

export const ARCHIVE_KEY = 'crystal-corridor-archive-v1';
export const ARCHIVE_LIMIT = 20;

/** 指纹取自可观察的对局状态，不含时间戳，保证刷新后仍能识别同一对局。 */
export function archiveKey(g: Game): string {
  return ['v1', g.players.length, g.turnNumber, g.phase, g.copper, g.silver,
    ...g.players.map(p => `${p.id}:${p.turns}:${p.claimed.length}:${score(p)}`)].join('|');
}

export function makeEntry(g: Game, savedAt = new Date().toISOString()): ArchiveEntry {
  const top = ranking(g)[0];
  return {
    id: archiveKey(g),
    savedAt,
    finished: g.phase === 'finished',
    players: g.players.length,
    turns: g.turnNumber,
    title: g.phase === 'finished' ? `获胜者：${top.name} · ${score(top)} 分` : `进行至第 ${g.turnNumber} 手 · 未完成`,
    game: g,
  };
}

/** 新条目置顶；同指纹去重；超过上限丢弃最旧。 */
export function pushArchive(entries: ArchiveEntry[], entry: ArchiveEntry): ArchiveEntry[] {
  return [entry, ...entries.filter(e => e.id !== entry.id)].slice(0, ARCHIVE_LIMIT);
}

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** 坏条目（字段缺失、对局结构损坏、复盘记录无效）直接剔除，不让历史脏数据阻断页面。 */
function entryValid(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const item = e as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.savedAt !== 'string' || typeof item.finished !== 'boolean' ||
      typeof item.title !== 'string' || typeof item.turns !== 'number' || typeof item.players !== 'number') return false;
  const g = item.game as Game | undefined;
  if (!g || g.version !== 2 || !Array.isArray(g.players) || g.players.length < 2 || g.players.length > 6) return false;
  try { validateReplay(g.replay, g); } catch { return false; }
  return true;
}

export function loadArchive(store?: Store): ArchiveEntry[] {
  const s = store ?? globalThis.localStorage;
  if (!s) return [];
  try {
    const parsed = JSON.parse(s.getItem(ARCHIVE_KEY) || 'null');
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(entryValid);
  } catch { return []; }
}

/** 存储配额不足时减半重试一次；最坏情况放弃本次写入，绝不影响对局本身。 */
export function saveArchive(entries: ArchiveEntry[], store?: Store): void {
  const s = store ?? globalThis.localStorage;
  if (!s) return;
  const attempt = (n: number) => s.setItem(ARCHIVE_KEY, JSON.stringify({ version: 1, entries: entries.slice(0, Math.min(ARCHIVE_LIMIT, n)) }));
  try { attempt(ARCHIVE_LIMIT); }
  catch { try { attempt(Math.ceil(ARCHIVE_LIMIT / 2)); } catch { /* 存储不可用时静默 */ } }
}
