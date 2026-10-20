import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../data.js';
import { validateReplay } from '../replay.js';
import { count, type Game } from '../engine.js';
export const MOBILE_KEY = 'century-mobile-game-v2';
export const DESKTOP_KEY = 'crystal-corridor-game-v2-canonical';
/** 校验不可信或过期存档；两个视图使用同一 v2 数据契约，但独立保存。 */
export function parseMobileSave(raw: string | null): Game | null {
  if (!raw) return null;
  const g = JSON.parse(raw);
  const integer = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  const stock = (s: unknown) => Array.isArray(s) && s.length === 4 && s.every(integer) && s.every(n => n <= 100);
  const ids = (a: unknown, lookup: Record<string, unknown>) => Array.isArray(a) && a.every(id => typeof id === 'string' && Object.hasOwn(lookup,id));
  if (!g || g.version !== 2 || !Array.isArray(g.players) || g.players.length < 2 || g.players.length > 6 ||
      !integer(g.current) || g.current >= g.players.length || !integer(g.turnNumber) || !integer(g.copper) || !integer(g.silver) ||
      !['turn','overflow','finished'].includes(g.phase) || !(g.triggerPlayer === null || integer(g.triggerPlayer) && g.triggerPlayer < g.players.length) ||
      !Array.isArray(g.log) || !g.log.every((s: unknown) => typeof s === 'string') ||
      !ids(g.merchantDeck, MERCHANT_BY_ID) || !ids(g.golemDeck, GOLEM_BY_ID) || !ids(g.golemMarket, GOLEM_BY_ID) || g.golemMarket.length > 5 ||
      !Array.isArray(g.merchantMarket) || g.merchantMarket.length > 6 || !g.merchantMarket.every((m: {id:string;bonus:unknown}) => m && Object.hasOwn(MERCHANT_BY_ID,m.id) && stock(m.bonus)) ||
      !g.players.every((p: any, i: number) => p && p.id === i && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 20 &&
        (p.isAI === undefined || typeof p.isAI === 'boolean') && stock(p.stock) && ids(p.hand, MERCHANT_BY_ID) && ids(p.played, MERCHANT_BY_ID) && ids(p.claimed, GOLEM_BY_ID) &&
        new Set([...p.hand,...p.played]).size === p.hand.length + p.played.length && integer(p.copper) && integer(p.silver) && integer(p.turns))) throw Error('存档版本或内容无效，请保留备份后开始新局');
  const humans = g.players.filter((p: any) => !p.isAI).length;
  if (humans < 1 || humans > 2 || g.players.length - humans > 4 || (g.players.length === 6 && (humans !== 2 || g.players.slice(0,2).some((p:any)=>p.isAI)))) throw Error('此存档不符合手机版 1–2 真人、0–4 AI 配置');
  const game=g as Game;
  const overflow=game.phase==='overflow';
  if(game.turnNumber<1 || game.players.some((p,i)=>count(p.stock)>10 && (!overflow || i!==game.current)) ||
      overflow && count(game.players[game.current].stock)<=10 || game.phase==='finished' && game.triggerPlayer===null){
    throw Error('存档的回合阶段与商队容量不一致，请导入有效备份');
  }
  validateReplay(game.replay, game);
  if (game.replay) parseMobileSave(JSON.stringify(game.replay.initial));
  return game;
}
