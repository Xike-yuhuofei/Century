import { GOLEM_BY_ID, MERCHANT_BY_ID, type Merchant, type Stock } from './data.js';
import { applyAction, count, createGame, has, ranking, readable, score, tradeLimit, type Action, type Color, type Game } from './engine.js';
import { downloadReplay, replayCoverage, replayMarkdown, validateReplay } from './replay.js';
import { ARCHIVE_LIMIT, loadArchive, makeEntry, pushArchive, saveArchive, type ArchiveEntry } from './archive.js';
import { autoExportEnabled, disableAutoExport, enableAutoExport, maybeAutoExport } from './auto-export.js';
import { chooseAIAction } from './ai.js';
import { visibleOrder, moveInOrder, stepInOrder, groupOrder } from './organize.js';

const KEY = 'crystal-corridor-game-v2-canonical';
const VIEW_KEY = 'crystal-corridor-view-v1.3';
const COLOR = ['黄','绿','蓝','粉'];
const classColor = ['yellow','green','blue','pink'];
const root = document.getElementById('app')!;
let game: Game | null = null;
let modal: Modal | null = null;
let handoff = false;
let showHelp = false;
let showLog = false;
let inspectedAI: number | null = null;
let toast = '';
let botPaused = false;
let resultHidden = false;
let archive: ArchiveEntry[] = loadArchive();
let showHistory = false;
let historyViewId: string | null = null;
const humanNames:string[] = [];
let botTimer: ReturnType<typeof setTimeout> | null = null;
type PlayerView = { order:string[]; folded:boolean };
type ViewState = { compact:boolean; players:Record<string,PlayerView> };
let viewState:ViewState = {compact:true,players:{}};
try {
  const fromStorage = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
  if (fromStorage && typeof fromStorage.compact==='boolean' && fromStorage.players && typeof fromStorage.players==='object') viewState = fromStorage;
} catch { /* 可脱机运行 */ }
let dragging:{player:number; id:string} | null = null;
let suppressPlayUntil = 0;
const mobileMedia = window.matchMedia('(max-width: 980px)');
const dedicatedMobilePage = document.documentElement.dataset.centuryMode === 'mobile';
function usesMobileLayout() { return dedicatedMobilePage || mobileMedia.matches; }
function pageVersionLink() { return dedicatedMobilePage
  ? '<a class="page-version-link" href="../">电脑版</a>'
  : '<a class="page-version-link" href="./mobile/">手机版</a>'; }
let mobileTab: 'golems' | 'merchants' | 'opponents' = 'golems';
let mobileHandExpanded = false;
let mobilePlayedOpen = false;
function pref(id:number): PlayerView {
  const key=String(id);
  const saved=viewState.players[key];
  if (!saved || !Array.isArray(saved.order) || typeof saved.folded!=='boolean') viewState.players[key]={order:[],folded:!!game?.players[id]?.isAI};
  return viewState.players[key];
}
function saveView() { try { localStorage.setItem(VIEW_KEY,JSON.stringify(viewState)); } catch {} }
function sortedHand(p:Game['players'][number]):string[] { return visibleOrder(p.hand,pref(p.id).order); }
function updateHandOrder(player:number, ordered:string[]) {
  if (!game || game.players[player]?.isAI) return;
  const p=game.players[player], seen=new Set(p.hand);
  if (ordered.length!==p.hand.length || new Set(ordered).size!==p.hand.length || ordered.some(id=>!seen.has(id))) return;
  const old=visibleOrder([...p.hand,...p.played],pref(player).order);
  let index=0;
  pref(player).order=old.map(id=>seen.has(id)?ordered[index++]:id);
  saveView(); render();
}
function reorderHand(player:number, id:string, direction?:-1|1, targetId?:string) {
  if (!game || !game.players[player] || game.players[player].isAI) return;
  const hand=sortedHand(game.players[player]);
  const newOrder=targetId ? moveInOrder(hand,hand,id,targetId) : stepInOrder(hand,hand,id,direction!);
  updateHandOrder(player,newOrder);
}
function handTile(p:Game['players'][number],id:string,active:boolean,index:number,ordered:string[]):string {
  if(p.isAI) return merchantCard(id,undefined,undefined,'inactive');
  return `<div class="hand-tile" draggable="${usesMobileLayout() ? 'false' : 'true'}" data-drag-player="${p.id}" data-card-id="${id}" aria-label="${esc(merchantDescription(MERCHANT_BY_ID[id]))}，可拖动排序">
    <div class="tile-grip" aria-hidden="true">⠿</div>
    ${merchantCard(id,undefined,undefined,active?'hand':'inactive')}
    <div class="tile-move"><button type="button" aria-label="将 ${id} 向前移动" title="向前移动" data-action="move-card" data-player="${p.id}" data-id="${id}" data-direction="-1" ${index===0?'disabled':''}>‹</button><span>拖动排序</span><button type="button" aria-label="将 ${id} 向后移动" title="向后移动" data-action="move-card" data-player="${p.id}" data-id="${id}" data-direction="1" ${index===ordered.length-1?'disabled':''}>›</button></div>
  </div>`;
}
function handTools(p:Game['players'][number]):string {
  if(p.isAI) return '<span class="hand-tip">卡面正面展示</span>';
  return `<div class="hand-tools"><button class="hand-tool-btn" data-action="group-cards" data-player="${p.id}" title="按创造、升级、交易分组，不消耗回合">分类整理</button><span class="hand-tip">拖动调整顺序 · ‹ › 微调</span></div>`;
}
function foldedPlayed(p:Game['players'][number], isAI=false):string {
  const closed=pref(p.id).folded;
  return `<button class="fold-btn" data-action="toggle-played" data-player="${p.id}" aria-expanded="${!closed}" aria-label="${closed?'展开':'折叠'}${esc(p.name)}的回收区">${closed?'▸ 展开':'▾ 折叠'}</button>`;
}
function cardSizeControl():string {
  return `<button class="subtle-btn size-switch" data-action="card-size" title="切换个人卡牌尺寸">${viewState.compact?'▣ 标准卡':'▦ 紧凑卡'}</button>`;
}

type Modal =
  | { kind: 'upgrade'; id: string; steps: Color[]; draft: Stock }
  | { kind: 'trade'; id: string; repeats: number }
  | { kind: 'acquire'; index: number; payment: Color[] }
  | { kind: 'discard'; colors: Color[] };

try {
  const saved = localStorage.getItem(KEY);
  if (saved) {
    const parsed: Game = JSON.parse(saved);
    validateReplay(parsed?.replay, parsed);
    if (parsed?.version === 2 && Array.isArray(parsed.players) && parsed.players.length >= 2 && parsed.players.length <= 6 && parsed.players[parsed.current]) game = parsed;
  }
} catch { /* 浏览器禁用存储时仍可游玩 */ }

function esc(value: unknown): string { return String(value).replace(/[&<>"']/g, x => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[x] || x)); }
// 卡面直接绘制实际水晶数量。颜色数量仅保留在屏幕阅读器的 aria-label 中。
function stones(s: Stock, compact = false): string {
  return s.map((n, i) => n > 0
    ? `<span class="stone-group ${compact ? 'stone-group-compact' : ''}" role="img" aria-label="${COLOR[i]}水晶 ${n} 颗"><span class="stone-gems">${Array.from({length: n}, () => `<span aria-hidden="true" class="gem gem-${classColor[i]}"></span>`).join('')}</span></span>`
    : '').filter(Boolean).join('') || '<span class="none">无</span>';
}
function merchantDescription(card: Merchant): string {
  if (card.kind === 'create') return `获得 ${readable(card.output!)}`;
  if (card.kind === 'upgrade') return `最多升级 ${card.steps} 次`;
  return `${readable(card.input!)} → ${readable(card.output!)}`;
}
function merchantCard(id: string, marketIndex?: number, bonus?: Stock, view: 'hand' | 'played' | 'inactive' = 'hand'): string {
  const card = MERCHANT_BY_ID[id];
  const title = card.kind === 'create' ? '创造' : card.kind === 'upgrade' ? '升级' : '交易';
  const symbol = card.kind === 'create' ? '✦' : card.kind === 'upgrade' ? '⇧' : '⇄';
  const effect = card.kind === 'create'
    ? `<div class="effect-label">获得水晶</div><div class="stone-line">${stones(card.output!, true)}</div>`
    : card.kind === 'upgrade'
    ? `<div class="effect-large">⇧ <strong>${card.steps}</strong></div><div class="effect-label">可连续升级</div>`
    : `<div class="stone-line">${stones(card.input!, true)}</div><div class="trade-arrow">↓</div><div class="stone-line">${stones(card.output!, true)}</div>`;
  const market = marketIndex !== undefined;
  const playable = market || view === 'hand';
  const tag = playable ? 'button' : 'div';
  const actionAttr = market ? `data-action="get-merchant" data-index="${marketIndex}"` : view === 'hand' ? 'data-action="play-hand"' : '';
  const bottom = market ? `<span>${marketIndex === 0 ? '免费' : `费用 ${marketIndex} 颗`}</span><b>获取 ↗</b>`
    : view === 'played' ? '<span>已打出 · 休息后收回</span>'
    : view === 'inactive' ? '<span>等待自己回合</span>'
    : `<span>${card.starter ? '起始卡' : '商人卡'}</span><b>打出 ↗</b>`;
  return `<${tag} ${playable ? 'type="button"' : ''} ${actionAttr} data-id="${id}" class="merchant-card card-${card.kind} ${view === 'played' ? 'played-face' : ''} ${view === 'inactive' ? 'inactive-face' : ''}" title="${esc(merchantDescription(card))}">
    <div class="card-head"><span>${symbol} ${title}</span><small>${id}</small></div>
    <div class="merchant-effect">${effect}</div><div class="card-foot">${bottom}</div>
    ${market && bonus && count(bonus) > 0 ? `<div class="market-bonus">卡上水晶 ${stones(bonus, true)}</div>` : ''}
  </${tag}>`;
}
function renderSetup(): string {
  const botOptions=Array.from({length:5},(_,n)=>`<option value="${n}" ${n===4?'selected':''}>${n} 名</option>`).join('');
  return `<main class="layout landing focus-landing"><header class="topbar focus-setup-top"><strong>晶石回廊</strong><div class="top-actions">${pageVersionLink()}<button class="subtle-btn" data-action="history">对局历史</button></div></header>
  <section class="focus-setup-panel"><h1>开始对局</h1><p>默认 1 名真人挑战 4 名 AI · 最多 4 名 AI</p>
    <div class="setup-players"><div><label for="humanCount">真人</label><select id="humanCount">${Array.from({length:5},(_,n)=>`<option value="${n+1}" ${n===0?'selected':''}>${n+1} 名</option>`).join('')}</select></div><div><label for="botCount">AI</label><select id="botCount">${botOptions}</select></div></div>
    <label for="nameInputs">玩家名称</label><div id="nameInputs" class="name-inputs"><input maxlength="20" aria-label="玩家 1" value="玩家 1" /></div>
    <p class="setup-validation" id="setupValidation">共 5 人 · 标准模式</p>
    <button class="primary-btn big" data-action="start">开始游戏 <span>→</span></button>
    <small class="focus-notice">本地离线对局 · 6 人局为非官方扩展</small>
  </section></main>`;
}
function syncSetup() {
  if (game) return;
  const humans = Number((root.querySelector('#humanCount') as HTMLSelectElement)?.value || 1);
  const bots = Number((root.querySelector('#botCount') as HTMLSelectElement)?.value || 0);
  const box = root.querySelector<HTMLElement>('#nameInputs');
  if (!box) return;
  const existing = [...box.querySelectorAll<HTMLInputElement>('input')];
  existing.forEach((input,i)=>{humanNames[i]=input.value;});
  box.innerHTML = Array.from({length:humans},(_,i)=>`<input maxlength="20" aria-label="玩家 ${i+1}" value="${esc(humanNames[i] ?? `玩家 ${i+1}`)}"/>`).join('');
  for(const slot of root.querySelectorAll<HTMLElement>('[data-ai-slot]')) {
    const n = Number(slot.dataset.aiSlot);
    slot.classList.toggle('selected', n < bots);
    const caption = slot.querySelector('span');
    if(caption) caption.textContent = n < bots ? '已加入' : '空席';
  }
  const sixHouse = humans===2 && bots===4;
  const valid = humans+bots>=2 && (humans+bots<=5 || sixHouse);
  const message = root.querySelector<HTMLElement>('#setupValidation');
  if (message) { message.textContent = valid ? (sixHouse ? '6 人扩展模式：2 真人 + 4 AI。沿用 5 人终局门槛（5 张魔像）、起始水晶，并为第六席复制起始卡；非官方规则。' : `合计 ${humans+bots} 名参赛者，符合正式 2–5 人规则。`) : '至少 2 人；普通模式最多 5 人，仅允许 2 真人 + 4 AI 扩展到 6 人。'; message.classList.toggle('invalid',!valid); }
  const submit = root.querySelector<HTMLButtonElement>('[data-action="start"]');
  if(submit) submit.disabled = !valid;
}
function playerCard(p: Game['players'][number], active: boolean): string {
  return `<div class="player-pill ${active ? 'active-player' : ''}"><div class="avatar">${p.isAI ? (aiThinking && active ? 'AI…' : 'AI') : p.id + 1}</div><div class="player-info"><b>${esc(p.name)}</b><small>${p.claimed.length} 张魔像 · ${p.turns} 回合</small></div><span class="player-score">${score(p)}<small>估分</small></span></div>`;
}
function golemCard(id: string, index: number, g: Game, stock = g.players[g.current].stock): string {
  const golem = GOLEM_BY_ID[id];
  const available = has(stock, golem.cost);
  let bonus = '';
  if (index === 0 && g.copper > 0) bonus = `<span class="coin copper">铜 +3 · ${g.copper} 枚</span>`;
  else if (index === 0 && g.copper === 0 && g.silver > 0) bonus = `<span class="coin silver">银 +1 · ${g.silver} 枚</span>`;
  else if (index === 1 && g.copper > 0 && g.silver > 0) bonus = `<span class="coin silver">银 +1 · ${g.silver} 枚</span>`;
  return `<button type="button" data-action="claim" data-index="${index}" class="golem-card ${available ? 'affordable' : ''}" aria-label="${golem.points} 分魔像，需 ${esc(readable(golem.cost))}">
     <div class="golem-top">${bonus || '<span class="golem-tag">魔像卡</span>'}<span class="golem-num">${id}</span></div>
     <div class="golem-emblem"><div class="emblem-inner">✧</div></div><div class="golem-points"><strong>${golem.points}</strong><small>POINTS</small></div>
     <div class="golem-cost">${stones(golem.cost, true)}</div><div class="golem-action">${available ? '可认领 ↗' : '水晶不足'}</div></button>`;
}
/** 双人专用：左右玩家区域始终同时显示；中间共享市场。 */
function renderDuelPlayer(g: Game, index: number): string {
  const p = g.players[index];
  const active = g.current === index && g.phase !== 'finished';
  return `<section class="duel-player ${active ? 'duel-active' : 'duel-waiting'}" aria-label="${esc(p.name)}的游戏区域" data-player="${index}">
    <header class="duel-player-head">
      <div class="duel-player-title"><span class="duel-avatar" aria-hidden="true">${index + 1}</span><div class="duel-name">${esc(p.name)}</div><span class="duel-status">${active ? '正在行动' : ''}</span></div>
      <div class="duel-score" title="当前总分估算"><b>${score(p)}</b><small>分</small></div>
    </header>
    <div class="duel-stock"><div class="resource-bar" aria-label="${esc(p.name)}商队资源">${stones(p.stock)}<span class="stock-counter ${count(p.stock)>10?'over-capacity':''}" title="商队容量">${count(p.stock)}/10</span></div></div>
    <div class="duel-zone duel-hand"><div class="duel-minor-head"><b>手牌 <span class="zone-count">${p.hand.length}</span></b>${handTools(p)}</div>
      <div class="duel-card-grid player-hand-grid ${p.hand.length<=4?'hand-few':p.hand.length<=16?'hand-some':p.hand.length<=28?'hand-many':'hand-packed'}" data-scroll-zone="hand-${p.id}" data-hand-player="${p.id}">${p.hand.length ? sortedHand(p).map((id,i,arr) => handTile(p,id,active && !p.isAI,i,arr)).join('') : '<div class="duel-empty">已出完手牌 · 可休息收回</div>'}</div></div>
    <div class="duel-zone duel-played ${p.played.length===0?'zone-empty':''} ${pref(p.id).folded?'zone-folded':''}"><div class="duel-minor-head"><b>已打出 <span class="zone-count">${p.played.length}</span></b>${foldedPlayed(p)}</div>
      ${pref(p.id).folded?'':`<div class="duel-card-grid duel-used-grid" data-scroll-zone="played-${p.id}">${p.played.map(id => merchantCard(id, undefined, undefined, 'played')).join('')}</div>`}</div>
    <footer class="duel-player-footer"><div class="player-summary" title="已认领魔像与奖励硬币">魔像 ${p.claimed.length} · 铜 ${p.copper} · 银 ${p.silver}</div>
      <button type="button" class="rest-btn" data-action="rest" ${active && !p.isAI && g.phase === 'turn' ? '' : 'disabled'} title="休息占用一个回合，收回全部已打出商人卡">↶ 休息收回</button></footer>
  </section>`;
}
/** AI 默认只留战略信息；详细卡牌可点击展开，不占真人卡区。 */
function renderAICompactLane(g:Game,p:Game['players'][number]):string {
  const n=g.players.filter(x=>x.isAI).findIndex(x=>x.id===p.id)+1;
  const active=g.current===p.id&&g.phase!=='finished';
  return `<div class="ai-lane ${active?'ai-lane-active':''}" aria-label="AI ${n} 手牌与水晶">
    <button class="ai-lane-label" type="button" data-action="inspect-ai" data-player="${p.id}" title="查看 AI ${n} 的回收牌与完整信息" aria-label="查看 AI ${n} 详情，${score(p)} 分">
      <span class="ai-lane-name">AI ${n} <b>${score(p)}<small>分</small></b></span>
      <span class="ai-lane-resources">${stones(p.stock,true)}</span>
      <span class="ai-lane-count">${p.hand.length} 手牌 · ${p.played.length} 已打出</span>
    </button>
    <div class="ai-lane-hand" data-scroll-zone="ai-lane-${p.id}">${p.hand.map(id=>merchantCard(id,undefined,undefined,'inactive')).join('')||'<span class="ai-lane-empty">无可用手牌</span>'}</div>
  </div>`;
}
function renderAIInspector(g:Game):string {
  if(inspectedAI===null) return '';
  const p=g.players[inspectedAI];
  if(!p?.isAI) return '';
  const n=g.players.filter(x=>x.isAI).findIndex(x=>x.id===p.id)+1;
  return `<div class="ai-inspector" role="region" aria-label="AI ${n} 完整卡牌详情">
    <div class="ai-inspector-head"><strong>AI ${n} · ${score(p)} 分</strong><div>${stones(p.stock,true)}</div><button type="button" data-action="inspect-ai" data-player="${p.id}" aria-label="收起 AI 详情">✕</button></div>
    <div class="ai-inspector-sections"><section><h3>手牌 · ${p.hand.length}</h3><div class="ai-inspector-cards" data-scroll-zone="ai-hand-${p.id}">${p.hand.map(id=>merchantCard(id,undefined,undefined,'inactive')).join('')||'<span class="duel-empty">无手牌</span>'}</div></section>
    <section><h3>已打出 · ${p.played.length}</h3><div class="ai-inspector-cards" data-scroll-zone="ai-played-${p.id}">${p.played.map(id=>merchantCard(id,undefined,undefined,'played')).join('')||'<span class="duel-empty">无卡牌</span>'}</div></section></div>
    <div class="ai-inspector-foot">魔像 ${p.claimed.length} · 铜币 ${p.copper} · 银币 ${p.silver}</div>
  </div>`;
}
function minimalTopbar(g:Game):string {
  const finished = g.phase==='finished';
  return `<header class="topbar duel-topbar focus-topbar"><span class="focus-brand">晶石回廊</span><div class="duel-now">${finished?'对局结束':`第 ${g.turnNumber} 手 <strong>${esc(g.players[g.current].name)}</strong> 行动`}</div><div class="top-actions">${pageVersionLink()}${aiPauseControl(g)}<button class="subtle-btn size-switch" data-action="card-size" aria-label="切换手牌尺寸" title="切换手牌尺寸">${viewState.compact?'▦':'▣'}</button><button class="subtle-btn" data-action="toggle-log" aria-label="查看行动记录" title="行动记录">☷</button><button class="subtle-btn" data-action="history" aria-label="对局历史" title="对局历史">⧉</button><button class="subtle-btn" data-action="help" aria-label="规则" title="规则">?</button><button class="subtle-btn" data-action="reset" aria-label="新开一局" title="新开一局">↻</button></div></header>`;
}
function replayControls(g: Game): string {
  return `<div class="replay-controls"><small>${esc(replayCoverage(g))}</small><button class="subtle-btn" data-action="export-replay-md">导出复盘 Markdown</button><button class="subtle-btn" data-action="export-replay-json">导出复盘 JSON</button></div>`;
}
function historyTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/** 对局历史中的自动导出设置：结束的对局自动下载复盘到浏览器默认下载文件夹，无授权流程。 */
function autoExportPanel(): string {
  const status = autoExportEnabled() ? '自动导出：已开启' : '自动导出：已关闭';
  const buttons = autoExportEnabled()
    ? '<button class="subtle-btn" data-action="auto-export-disable">关闭自动导出</button>'
    : '<button class="subtle-btn" data-action="auto-export-enable">开启自动导出</button>';
  return `<div class="auto-export-panel"><p class="small-muted">${status} · 结束的对局自动下载复盘 Markdown 与 JSON 到浏览器默认下载文件夹（~/Downloads）。</p><p class="small-muted">如需固定到专属文件夹，可在浏览器设置中把下载目录改为 /Volumes/Extreme SSD/Projects/Century/century-replays。</p><div class="history-item-actions">${buttons}</div></div>`;
}
function renderHistory(): string {
  const view = historyViewId !== null ? archive.find(e => e.id === historyViewId) : undefined;
  const close = '<button class="close-modal" data-action="close-history" aria-label="关闭对局历史">✕</button>';
  if (view) {
    return `<div class="overlay" data-overlay="history"><section class="dialog history-dialog">${close}<div class="eyebrow">GAME ARCHIVE</div><h2>对局复盘</h2><p class="small-muted">${esc(historyTime(view.savedAt))} · ${view.players} 人 · ${view.turns} 手 · ${esc(view.title)}</p><div class="replay-view" tabindex="0">${esc(replayMarkdown(view.game))}</div><div class="modal-actions"><button class="secondary-btn" data-action="history-back">‹ 返回列表</button><div class="history-item-actions"><button class="subtle-btn" data-action="archive-export-md" data-id="${esc(view.id)}">导出 Markdown</button><button class="subtle-btn" data-action="archive-export-json" data-id="${esc(view.id)}">导出 JSON</button></div></div></section></div>`;
  }
  const list = archive.map(e => `<div class="history-item"><div class="history-item-main"><b>${e.finished ? '✦ ' : '◔ '}${esc(e.title)}</b><small>${esc(historyTime(e.savedAt))} · ${e.players} 人 · ${e.turns} 手</small></div><div class="history-item-actions"><button class="subtle-btn" data-action="history-view" data-id="${esc(e.id)}">复盘</button><button class="subtle-btn" data-action="archive-export-md" data-id="${esc(e.id)}">MD</button><button class="subtle-btn" data-action="archive-export-json" data-id="${esc(e.id)}">JSON</button><button class="subtle-btn" data-action="archive-delete" data-id="${esc(e.id)}">删除</button></div></div>`).join('');
  return `<div class="overlay" data-overlay="history"><section class="dialog history-dialog">${close}<div class="eyebrow">GAME ARCHIVE</div><h2>对局历史</h2>${archive.length ? `<div class="history-list">${list}</div><p class="small-muted">对局结束或重新开局时自动归档，本地保留最近 ${ARCHIVE_LIMIT} 局。</p>` : '<p class="small-muted">暂无归档。对局结束或重新开局时会自动存入，本地保留最近 20 局。</p>'}${autoExportPanel()}<div class="modal-actions"><button class="primary-btn" data-action="close-history">关闭</button></div></section></div>`;
}
function logPopover(g:Game):string {
  return showLog?`<aside class="focus-log-popover" aria-label="行动记录"><div class="log-pop-head"><strong>行动记录</strong><button data-action="toggle-log" aria-label="关闭行动记录">✕</button></div>${replayControls(g)}${g.log.slice(0,10).map(t=>`<p>${esc(t)}</p>`).join('')}</aside>`:'';
}
/** V1.4 主模式：两位真人始终占据左右两边，AI 位于公共市场上方，不侵占人类操作区。 */
function renderHumanAIBoard(g: Game): string {
  const bots=g.players.filter(p=>p.isAI);
  const finished=g.phase==='finished';
  const house=g.players.length===6;
  return `<main class="layout duel-layout human-ai-layout focus-board ${house?'house-six':''} ${viewState.compact?'compact-cards':'normal-cards'}">${minimalTopbar(g)}
    ${g.triggerPlayer!==null&&!finished?'<div class="final-alert">终局已触发 · 本轮结束后计分</div>':''}
    <div class="duel-table human-ai-table">
      ${renderDuelPlayer(g,0)}
      <div class="duel-center human-ai-center">
        <section class="duel-market"><div class="duel-market-title"><h2>魔像</h2></div><div class="golem-grid">${g.golemMarket.map((id,i)=>golemCard(id,i,g)).join('')}</div></section>
        <section class="duel-market"><div class="duel-market-title"><h2>商人</h2></div><div class="merchant-grid">${g.merchantMarket.map((m,i)=>merchantCard(m.id,i,m.bonus)).join('')}</div></section>
        <section class="ai-monitor ai-lanes ai-count-${bots.length}" aria-label="AI 对手公开卡牌" style="--bot-count:${bots.length}">${bots.map(p=>renderAICompactLane(g,p)).join('')}${renderAIInspector(g)}</section>
      </div>
      ${renderDuelPlayer(g,1)}
    </div>${logPopover(g)}${finished?renderResult(g):''}</main>`;
}
function renderDuelBoard(g: Game): string {
  const finished=g.phase==='finished';
  return `<main class="layout duel-layout focus-board ${viewState.compact?'compact-cards':'normal-cards'}">${minimalTopbar(g)}
    ${g.triggerPlayer!==null&&!finished?'<div class="final-alert">终局已触发 · 本轮结束后计分</div>':''}
    <div class="duel-table">
      ${renderDuelPlayer(g,0)}
      <div class="duel-center">
        <section class="duel-market"><div class="duel-market-title"><h2>魔像</h2></div><div class="golem-grid">${g.golemMarket.map((id,i)=>golemCard(id,i,g)).join('')}</div></section>
        <section class="duel-market"><div class="duel-market-title"><h2>商人</h2></div><div class="merchant-grid">${g.merchantMarket.map((m,i)=>merchantCard(m.id,i,m.bonus)).join('')}</div></section>
      </div>
      ${renderDuelPlayer(g,1)}
    </div>${logPopover(g)}${finished?renderResult(g):''}</main>`;
}
function aiPauseControl(g:Game):string {
  if (!g.players.some(p=>p.isAI) || g.phase==='finished') return '';
  return `<button class="subtle-btn ai-pause" data-action="ai-pause">${botPaused?'▶ 继续 AI':'Ⅱ 暂停 AI'}</button>`;
}
function renderAISeat(g:Game, p:Game['players'][number]):string {
  const current = g.current === p.id && g.phase !== 'finished';
  return `<section class="ai-seat ${current?'ai-seat-active':''}" data-bot-seat="${p.id}" aria-label="${esc(p.name)}席位">
    <div class="ai-seat-top"><div><span class="ai-seat-tag">AI ${g.players.filter(x=>x.isAI).findIndex(x=>x.id===p.id)+1}</span><b>${esc(p.name)}</b><small>${current ? botPaused ? '已暂停' : '正在计算行动' : '等待回合'}</small></div><div class="ai-seat-score">${score(p)}<small>分</small></div></div>
    <div class="ai-seat-stock"><span>商队 ${count(p.stock)}/10</span><div>${stones(p.stock, true)}</div></div>
    <div class="ai-seat-zone"><span>手牌 · ${p.hand.length}</span><div class="ai-face-row">${p.hand.length ? p.hand.map(id=>merchantCard(id,undefined,undefined,'inactive')).join('') : '<span class="ai-empty">无手牌</span>'}</div></div>
    <div class="ai-seat-zone ai-played-zone ${p.played.length===0?'zone-empty':''} ${pref(p.id).folded?'zone-folded':''}"><div class="ai-zone-heading"><span>回收区 · ${p.played.length}</span>${foldedPlayed(p,true)}</div>${pref(p.id).folded?'':`<div class="ai-face-row" data-scroll-zone="played-${p.id}">${p.played.length ? p.played.map(id=>merchantCard(id,undefined,undefined,'played')).join('') : '<span class="ai-empty">暂未打出</span>'}</div>`}</div>
    <div class="ai-seat-foot">魔像 ${p.claimed.length} 张 · 铜币 ${p.copper} · 银币 ${p.silver}</div>
  </section>`;
}
/** 1 名人类 + 2–4 AI：人类操作区 / 公共市场 / AI 席位。 */
function renderSoloAIBoard(g:Game):string {
  const human = g.players.find(p=>!p.isAI)!;
  const bots = g.players.filter(p=>p.isAI);
  const finished = g.phase==='finished';
  const target = g.players.length>=4 ? 5 : 6;
  return `<main class="layout duel-layout ai-board-layout ${viewState.compact?'compact-cards':'normal-cards'}"><header class="topbar duel-topbar"><div class="brand-icon">◇</div><div class="brand-text"><strong>晶石回廊</strong><span>CRYSTAL CORRIDOR · AI ARENA</span></div><div class="duel-now">${finished?'对局结束':`第 ${g.turnNumber} 手 · ${esc(g.players[g.current].name)} 行动中`}</div><div class="top-actions">${pageVersionLink()}${aiPauseControl(g)}${cardSizeControl()}<button class="subtle-btn" data-action="help">规则</button><button class="subtle-btn" data-action="reset">新开一局</button></div></header>
    ${g.triggerPlayer!==null&&!finished?'<div class="final-alert">终局已触发，本轮结束后结算</div>':''}
    <div class="ai-arena">
      ${renderDuelPlayer(g,human.id)}
      <div class="duel-center"><div class="duel-center-heading"><span>共享市场 · CENTER TABLE</span><strong>1 名人类 VS ${bots.length} 名 AI</strong></div>
        <section class="duel-market"><div class="duel-market-title"><h2>魔像市场</h2><span>剩余 ${g.golemDeck.length} 张 · 第 ${target} 张触发终局</span></div><div class="golem-grid">${g.golemMarket.map((id,i)=>golemCard(id,i,g)).join('')}</div></section>
        <section class="duel-market"><div class="duel-market-title"><h2>商人市场</h2><span>剩余 ${g.merchantDeck.length} 张</span></div><div class="merchant-grid">${g.merchantMarket.map((m,i)=>merchantCard(m.id,i,m.bonus)).join('')}</div></section>
        <section class="duel-log"><div class="duel-minor-head"><b>对局记录</b><span>AI 自动选择行动</span></div>${replayControls(g)}<div class="duel-log-lines">${g.log.slice(0,6).map(line=>`<span>${esc(line)}</span>`).join('')}</div></section>
      </div>
      <aside class="ai-seat-grid ${bots.length===2?'ai-seat-grid-two':''}">${bots.map(p=>renderAISeat(g,p)).join('')}</aside>
    </div>${finished?renderResult(g):''}</main>`;
}

/** 手机独立视图：共享同一局游戏状态、规则和卡牌动作，不渲染第二套可操作桌面。 */
function renderMobileBoard(g: Game): string {
  const player = g.players[g.current].isAI ? g.players.find(p => !p.isAI)! : g.players[g.current];
  const active = g.current === player.id && g.phase === 'turn';
  const current = g.players[g.current];
  const rivals = g.players.filter(p => p.id !== player.id);
  const finished = g.phase === 'finished';
  const tab = (id: typeof mobileTab, title: string, number: number) =>
    '<button type="button" class="mobile-tab '+(mobileTab===id?'mobile-tab-current':'')+
    '" data-action="mobile-tab" data-tab="'+id+'" aria-pressed="'+(mobileTab===id)+'">'+
    title+' <span>'+number+'</span></button>';
  const board = mobileTab === 'golems'
    ? '<section class="mobile-market" aria-label="魔像市场"><h2>魔像 <small>符合水晶条件的卡牌高亮</small></h2><div class="mobile-market-grid mobile-golems">'+
      g.golemMarket.map((id,i)=>golemCard(id,i,g,player.stock)).join('')+'</div></section>'
    : mobileTab === 'merchants'
    ? '<section class="mobile-market" aria-label="商人市场"><h2>商人 <small>按左到右顺序收取位置费用</small></h2><div class="mobile-market-grid mobile-merchants">'+
      g.merchantMarket.map((m,i)=>merchantCard(m.id,i,m.bonus)).join('')+'</div></section>'
    : '<section class="mobile-rivals" aria-label="对手信息"><h2>玩家与对手</h2>'+
      rivals.map(p => '<details class="mobile-rival"><summary><strong>'+
      esc(p.name)+'</strong><span>'+score(p)+' 分 · 魔像 '+p.claimed.length+
      ' · 手牌 '+p.hand.length+' <span class="mobile-chevron">⌄</span></span></summary>'+
      '<div class="mobile-rival-stock">'+stones(p.stock,true)+' <span>'+count(p.stock)+'/10</span></div>'+
      '<h3>手牌 · '+p.hand.length+'</h3><div class="mobile-rival-cards">'+
      (p.hand.map(id=>merchantCard(id,undefined,undefined,'inactive')).join('') || '<span class="mobile-empty">无手牌</span>')+
      '</div><h3>已打出 · '+p.played.length+'</h3><div class="mobile-rival-cards">'+
      (p.played.map(id=>merchantCard(id,undefined,undefined,'played')).join('') || '<span class="mobile-empty">无已打出卡</span>')+
      '</div><p>铜币 '+p.copper+' · 银币 '+p.silver+'</p></details>').join('')+'</section>';
  const hand = sortedHand(player);
  return '<main class="layout focus-board mobile-board '+(viewState.compact?'compact-cards':'normal-cards')+
    (mobileHandExpanded?' mobile-hand-expanded':'')+'">'+
    '<header class="mobile-topbar"><span class="mobile-brand">晶石回廊</span>'+
    '<span class="mobile-turn">'+(finished?'对局结束':'第 '+g.turnNumber+' 手')+'</span>'+
    '<details class="mobile-more"><summary aria-label="更多设置与规则" title="更多">•••</summary>'+
    '<div class="mobile-more-menu">'+pageVersionLink()+aiPauseControl(g)+
    '<button type="button" data-action="card-size">'+(viewState.compact?'放大卡牌':'缩小卡牌')+'</button>'+
    '<button type="button" data-action="toggle-log">行动记录</button>'+
    '<button type="button" data-action="history">对局历史</button>'+
    '<button type="button" data-action="help">游戏规则</button>'+
    '<button type="button" data-action="reset">新开一局</button></div></details></header>'+
    (g.triggerPlayer!==null&&!finished?'<div class="final-alert">终局已触发 · 本轮结束后计分</div>':'')+
    '<section class="mobile-overview" aria-label="当前玩家与水晶">'+
    '<div class="mobile-player-line"><div><strong>'+esc(player.name)+'</strong>'+
    '<span class="mobile-activity">'+(finished?'已结束':active?'你的回合':'等待 '+esc(current.name)+' 行动')+'</span></div>'+
    '<span class="mobile-score">'+score(player)+' <small>分</small></span></div>'+
    '<div class="mobile-resource-line">'+stones(player.stock)+
    '<span class="mobile-capacity">'+count(player.stock)+'/10</span></div></section>'+
    '<nav class="mobile-tabs" aria-label="切换游戏区域">'+
    tab('golems','魔像',g.golemMarket.length)+
    tab('merchants','商人',g.merchantMarket.length)+
    tab('opponents','对手',rivals.length)+'</nav>'+
    '<div class="mobile-stage" data-scroll-zone="mobile-stage">'+board+'</div>'+
    '<section class="mobile-dock" aria-label="'+esc(player.name)+'手牌操作">'+
    '<div class="mobile-dock-toolbar"><button type="button" class="mobile-expand" data-action="mobile-expand-hand" aria-expanded="'+mobileHandExpanded+'" aria-label="'+(mobileHandExpanded?'收起手牌':'展开手牌')+'">'+
    (mobileHandExpanded?'⌄':'⌃')+' 手牌 '+hand.length+'</button>'+
    '<button type="button" class="mobile-sort" data-action="group-cards" data-player="'+player.id+'" '+(!active?'disabled':'')+'>整理</button>'+
    '<button type="button" class="mobile-rest" data-action="rest" '+(!active?'disabled':'')+'>↶ 休息</button></div>'+
    '<div class="mobile-dock-cards" data-scroll-zone="mobile-hand-'+player.id+'">'+
    (hand.length?hand.map((id,i)=>handTile(player,id,active,i,hand)).join(''):'<span class="mobile-empty">无可用手牌 · 可休息收回</span>')+
    '</div><div class="mobile-played '+(mobilePlayedOpen?'':'mobile-played-closed')+'">'+
    '<div class="mobile-played-label"><span>已打出 '+player.played.length+'</span><button type="button" class="fold-btn" data-action="mobile-toggle-played" aria-expanded="'+mobilePlayedOpen+'">'+(mobilePlayedOpen?'▾ 折叠':'▸ 展开')+'</button></div>'+
    (mobilePlayedOpen?'<div class="mobile-played-cards" data-scroll-zone="mobile-played-'+player.id+'">'+
    player.played.map(id=>merchantCard(id,undefined,undefined,'played')).join('')+'</div>':'')+
    '</div></section>'+
    logPopover(g)+(finished?renderResult(g):'')+'</main>';
}

function renderBoard(g: Game): string {
  if (usesMobileLayout()) return renderMobileBoard(g);
  if (g.players.filter(p=>!p.isAI).length === 2 && g.players.length > 2 && g.players.some(p=>p.isAI)) return renderHumanAIBoard(g);
  if (g.players.length === 2) return renderDuelBoard(g);
  if (g.players.filter(p=>!p.isAI).length === 1 && g.players.some(p=>p.isAI)) return renderSoloAIBoard(g);
  const p = g.players[g.current];
  const target = g.players.length >= 4 ? 5 : 6;
  const finished = g.phase === 'finished';
  return `<main class="layout board-layout ${viewState.compact?'compact-cards':'normal-cards'}"><header class="topbar"><div class="brand-icon">◇</div><div class="brand-text"><strong>晶石回廊</strong><span>CRYSTAL CORRIDOR</span></div><div class="top-actions"><span class="turn-badge">第 ${g.turnNumber} 手</span>${pageVersionLink()}${aiPauseControl(g)}${cardSizeControl()}<button class="subtle-btn" data-action="history">对局历史</button><button class="subtle-btn" data-action="help">规则</button><button class="subtle-btn" data-action="reset">新开一局</button></div></header>
  <section class="players-strip">${g.players.map((x, i) => playerCard(x, i === g.current && !finished)).join('')}</section>
  ${g.triggerPlayer !== null && !finished ? '<div class="final-alert">终局已触发！本轮完成后结算。</div>' : ''}
  <section class="game-section"><div class="section-head"><div><span class="section-index">01 / THE GOLEMS</span><h2>魔像市场 <small>认领目标</small></h2></div><div class="section-meta">牌库剩余 ${g.golemDeck.length} 张 · 每人认领 ${target} 张触发终局</div></div>
  <div class="golem-grid">${g.golemMarket.map((id, i) => golemCard(id, i, g)).join('')}</div></section>
  <section class="game-section"><div class="section-head"><div><span class="section-index">02 / THE MERCHANTS</span><h2>商人市场 <small>构建引擎</small></h2></div><div class="section-meta">牌库剩余 ${g.merchantDeck.length} 张 · 越靠右获取成本越高</div></div>
  <div class="merchant-grid">${g.merchantMarket.map((card, i) => merchantCard(card.id, i, card.bonus)).join('')}</div></section>
  <section class="personal-zone"><div class="zone-head"><div><span class="section-index">03 / YOUR CARAVAN</span><h2>${esc(p.name)} 的回合 <small>${finished ? '已结束' : '请选择一个行动'}</small></h2></div><div class="resource-bar">${stones(p.stock)}<div class="capacity ${count(p.stock) > 10 ? 'over-capacity' : ''}">${count(p.stock)} / 10 颗</div></div></div>
  <div class="personal-layout"><div class="hand-area"><div class="hand-heading"><b>当前手牌 <span>${p.hand.length} 张</span></b>${handTools(p)}</div><div class="hand-grid player-hand-grid" data-scroll-zone="hand-${p.id}" data-hand-player="${p.id}">${p.hand.length ? sortedHand(p).map((id,i,arr)=>handTile(p,id,!finished,i,arr)).join('') : '<p class="empty-hand">没有可打出的商人卡。可以休息、获取或认领。</p>'}</div>
  <div class="played ${pref(p.id).folded?'zone-folded':''}"><div class="played-header"><b>回收区 · ${p.played.length} 张</b>${foldedPlayed(p)}</div>${pref(p.id).folded?'':`<div class="played-card-grid" data-scroll-zone="played-${p.id}">${p.played.length ? p.played.map(id=>merchantCard(id,undefined,undefined,'played')).join('') : '<span class="empty-hand">暂无已打出的商人卡</span>'}</div>`}<button class="rest-btn" data-action="rest" ${finished ? 'disabled' : ''}>休息 · 收回已打出卡牌</button></div></div>
  <aside class="right-column"><div class="score-panel"><h3>个人战绩</h3><div class="score-large">${score(p)} <span>当前估分</span></div><div class="score-breakdown"><span>魔像 ${p.claimed.reduce((s, id) => s + GOLEM_BY_ID[id].points, 0)} 分</span><span>铜币 ${p.copper} · 银币 ${p.silver}</span><span>非黄水晶 ${p.stock[1] + p.stock[2] + p.stock[3]} 分</span></div></div>
  <div class="history"><h3>行动记录</h3>${replayControls(g)}${g.log.slice(0, 7).map(line => `<p>${esc(line)}</p>`).join('')}</div></aside></div></section>
  <footer class="footer">点击手牌：打出 · 点击市场：获取或认领 · 「休息」独占一回合。所有规则由本地引擎校验。</footer>
  ${handoff && !finished ? `<div class="overlay cover"><div class="handoff-card"><div class="cover-symbol">◇</div><div class="eyebrow">PASS THE DEVICE</div><h2>轮到 ${esc(p.name)}</h2><p>请把设备交给下一位玩家，准备后再显示手牌。</p><button class="primary-btn big" data-action="ready">我已就位，显示游戏 ↗</button></div></div>` : ''}
  ${finished ? renderResult(g) : ''}</main>`;
}
function renderResult(g: Game): string {
  if (resultHidden || showHistory) return '';
  const result = ranking(g);
  return `<div class="overlay cover"><section class="result-card"><button class="close-modal" data-action="close-result" aria-label="关闭结算面板">✕</button><div class="eyebrow">GAME COMPLETE</div><h2>对局结束</h2><div class="trophy">◇</div><p class="winner">获胜者：<strong>${esc(result[0].name)}</strong></p><p class="small-muted">平分时最后行动的玩家优先</p><div class="result-table">${result.map((p, i) => `<div><div class="result-main"><b>${i + 1}. ${esc(p.name)}</b><strong>${score(p)} 分</strong></div><span>魔像 ${p.claimed.reduce((s, id) => s + GOLEM_BY_ID[id].points, 0)} 分 · 铜 ${p.copper * 3} · 银 ${p.silver} · 非黄水晶 ${p.stock[1] + p.stock[2] + p.stock[3]} 分</span></div>`).join('')}</div>${replayControls(g)}<div class="result-actions"><button class="primary-btn big" data-action="reset">开始新的一局 ↗</button><button class="secondary-btn" data-action="close-result">查看最终棋盘</button></div></section></div>`;
}
function modalBody(): string {
  if (!game || !modal) return '';
  const p = game.players[game.current];
  const m = modal;
  if (m.kind === 'upgrade') {
    const card = MERCHANT_BY_ID[m.id];
    return `<h2>升级水晶</h2><p>本张卡最多升级 <b>${card.steps}</b> 次，可连续升级同一颗水晶，例如 黄→绿→蓝。</p><div class="modal-progress">已使用 ${m.steps.length} / ${card.steps} 次</div><div class="modal-stock">${stones(m.draft)}</div><p class="modal-caption">点击要升级的水晶颜色：</p><div class="choice-row">${([0,1,2] as Color[]).map(c => `<button data-action="upgrade-step" data-color="${c}" ${m.kind === 'upgrade' && (m.steps.length >= card.steps! || m.draft[c] === 0) ? 'disabled' : ''} class="choice-btn">${stones(([0,0,0,0] as Stock).map((_, i) => i === c ? 1 : 0) as Stock)} <span>→ ${COLOR[c+1]}</span></button>`).join('')}</div><div class="modal-actions"><button class="secondary-btn" data-action="upgrade-undo" ${m.steps.length === 0 ? 'disabled':''}>撤销一步</button><button class="primary-btn" data-action="confirm-upgrade">确认打出</button></div>`;
  }
  if (m.kind === 'trade') {
    const card = MERCHANT_BY_ID[m.id];
    const max = tradeLimit(p.stock, m.id);
    const repeats = m.repeats;
    const forecast = p.stock.map((n, i) => n + (card.output![i] - card.input![i]) * repeats) as Stock;
    return `<h2>交易水晶</h2><p>每次支付 <strong>${readable(card.input!)}</strong>，获得 <strong>${readable(card.output!)}</strong>。</p><div class="stepper"><button data-action="trade-minus" ${m.repeats <= 1 ? 'disabled':''}>−</button><strong>${m.repeats} <small>次</small></strong><button data-action="trade-plus" ${m.repeats >= max ? 'disabled':''}>+</button></div><p class="modal-caption">本次最多可交易 ${max} 次</p><div class="preview"><b>交易后水晶</b><div>${stones(forecast)}</div>${count(forecast) > 10 ? `<p class="warn">回合结束需弃置 ${count(forecast)-10} 颗</p>`:''}</div><div class="modal-actions"><button class="secondary-btn" data-action="cancel">取消</button><button class="primary-btn" data-action="confirm-trade">确认交易</button></div>`;
  }
  if (m.kind === 'acquire') {
    const target = game.merchantMarket[m.index];
    const used = ([0,0,0,0] as Stock);
    m.payment.forEach(c => used[c]++);
    const remain = p.stock.map((n,i) => n - used[i]) as Stock;
    return `<h2>获取商人卡</h2><p>获取第 <b>${m.index+1}</b> 张：需向左侧每张商人卡各压 1 颗水晶，共 <b>${m.index}</b> 颗。</p><div class="preview"><b>${merchantDescription(MERCHANT_BY_ID[target.id])}</b><p>该卡附赠：${readable(target.bonus)}</p></div><div class="modal-progress">已选择 ${m.payment.length} / ${m.index} 颗</div><div class="modal-stock">${stones(remain)}</div><p class="modal-caption">按照从左到右的顺序选择支付水晶：</p><div class="choice-row">${([0,1,2,3] as Color[]).map(c => `<button class="choice-btn" data-action="payment-pick" data-color="${c}" ${remain[c] === 0 || m.kind === 'acquire' && m.payment.length >= m.index ? 'disabled':''}>${stones(([0,0,0,0] as Stock).map((_,i) => i===c ? 1 : 0) as Stock)}</button>`).join('')}</div><p class="selected">${m.payment.length ? '已选择：'+m.payment.map(c=>COLOR[c]).join(' → ') : '尚未选择'}</p><div class="modal-actions"><button class="secondary-btn" data-action="payment-undo" ${m.payment.length === 0 ? 'disabled':''}>撤销一颗</button><button class="primary-btn" data-action="confirm-acquire" ${m.payment.length !== m.index ? 'disabled':''}>确认获取</button></div>`;
  }
  const needed = count(p.stock) - 10;
  const used = ([0,0,0,0] as Stock);
  m.colors.forEach(c => used[c]++);
  const remain = p.stock.map((n,i)=>n - used[i]) as Stock;
  return `<h2>商队容量管理</h2><p>水晶超过 10 颗，请自主选择弃置水晶。该次行动在弃置完成后结束。</p><div class="modal-progress">已选择弃置 ${m.colors.length} / ${needed} 颗</div><div class="modal-stock">${stones(remain)}</div><div class="choice-row">${([0,1,2,3] as Color[]).map(c => `<button class="choice-btn" data-action="discard-pick" data-color="${c}" ${remain[c]===0 || m.kind === 'discard' && m.colors.length >= needed ? 'disabled':''}>弃 ${COLOR[c]}</button>`).join('')}</div><p class="selected">${m.colors.length ? '已选择：'+m.colors.map(c=>COLOR[c]).join('、') : '尚未选择'}</p><div class="modal-actions"><button class="secondary-btn" data-action="discard-undo" ${m.colors.length === 0 ? 'disabled':''}>撤销一颗</button><button class="primary-btn" data-action="confirm-discard" ${m.colors.length !== needed ? 'disabled':''}>确认弃置</button></div>`;
}
function renderRules() {
  return `<div class="overlay" data-overlay="help"><section class="dialog help-dialog"><button class="close-modal" data-action="close-help">✕</button><div class="eyebrow">RULE BOOK</div><h2>规则速览</h2><div class="help-rows"><p><b>四类行动：</b>每回合选择 打出、获取、休息、认领 中的一项。</p><p><b>打出：</b>创造获得水晶；升级可逐级、可连续升级同一颗；交易可在一回合重复多次。</p><p><b>获取：</b>目标左侧每张卡上压 1 颗任意水晶，目标卡上的累计水晶归获取者。</p><p><b>休息：</b>取回全部已打出商人卡，占用完整一回合。</p><p><b>认领：</b>精确支付魔像需求。左一铜币 +3 分，左二银币 +1 分；铜币耗尽后银币移至最左。</p><p><b>容量：</b>你的回合结束最多保留 10 颗，超过时自行选择弃置。</p><p><b>终局：</b>2–3 人局认领第 6 张、4–5 人局认领第 5 张触发；完成当前整轮后结算。</p><p><b>六人扩展：</b>2 真人 + 4 AI，按 5 人局触发终局，第六席使用复制起始卡和 4/5 席起始水晶。</p><p><b>计分：</b>魔像分 + 铜币×3 + 银币×1 + 剩余非黄水晶×1；平分时最后行动者获胜。</p></div><button class="primary-btn" data-action="close-help">返回游戏</button></section></div>`;
}
function render() {
  const scrolls=new Map<string,{top:number,left:number}>();
  root.querySelectorAll<HTMLElement>('[data-scroll-zone]').forEach(el=>scrolls.set(el.dataset.scrollZone!,{top:el.scrollTop,left:el.scrollLeft}));
  root.innerHTML = `${game ? renderBoard(game) : renderSetup()}
    ${modal && game && !handoff && game.phase !== 'finished' ? `<div class="overlay" data-overlay="modal"><section class="dialog">${game.phase !== 'overflow' ? '<button class="close-modal" data-action="cancel">✕</button>' : ''}${modalBody()}</section></div>` : ''}
    ${showHistory ? renderHistory() : ''}
    ${game && game.phase === 'finished' && resultHidden && !showHistory ? '<button class="result-fab" data-action="show-result">查看结算</button>' : ''}
    ${showHelp ? renderRules() : ''}${toast ? `<div class="toast" role="alert">${esc(toast)}</div>` : ''}`;
  root.querySelectorAll<HTMLElement>('[data-scroll-zone]').forEach(el=>{ const at=scrolls.get(el.dataset.scrollZone!); if(at){el.scrollTop=at.top;el.scrollLeft=at.left;} });
  scheduleBot();
}
function save() { try { if (game) localStorage.setItem(KEY, JSON.stringify(game)); else localStorage.removeItem(KEY); } catch { /* 可无存储运行 */ } }
function archiveGame() {
  if (!game) return;
  archive = pushArchive(archive, makeEntry(game));
  saveArchive(archive);
}
function notify(message: string) { toast = message; render(); }
function action(a: Action) {
  if (!game) return;
  try {
    const previous = game.current;
    game = applyAction(game, a);
    if (game.current !== previous) mobilePlayedOpen = false;
    modal = game.phase === 'overflow' && !game.players[game.current].isAI ? { kind:'discard', colors:[] } : null;
    handoff = game.players.length > 2 && game.current !== previous && game.phase !== 'finished' && !game.players[game.current].isAI && game.players.filter(p=>!p.isAI).length > 2;
    toast = '';
    if (game.phase === 'finished') {
      archiveGame();
      if (maybeAutoExport(game)) notify('已自动下载复盘 Markdown 与 JSON（浏览器默认下载文件夹）');
    }
    save(); render();
  } catch(e) { notify(e instanceof Error ? e.message : '行动无法执行'); }
}
function start() {
  const inputs = [...root.querySelectorAll<HTMLInputElement>('#nameInputs input')];
  try {
    const humans = Number((root.querySelector('#humanCount') as HTMLSelectElement)?.value ?? inputs.length);
    const bots = Number((root.querySelector('#botCount') as HTMLSelectElement)?.value ?? 0);
    const names = [...inputs.map(x=>x.value),...Array.from({length:bots},(_,i)=>`AI 工匠 ${i+1}`)];
    if(humans!==inputs.length) throw new Error('人类玩家人数无效');
    game = createGame(names, undefined, Array.from({length:bots},(_,i)=>humans+i));
    modal = null; handoff = false; botPaused = false; showHelp = false; showLog=false; inspectedAI=null; resultHidden = false; mobileTab='golems'; mobileHandExpanded=false; mobilePlayedOpen=false; toast = ''; viewState.players={}; saveView(); save(); render();
  }
  catch(e) { notify(e instanceof Error ? e.message : '无法开始游戏'); }
}
function control(target: HTMLElement) {
  const type = target.dataset.action || '';
  if (type === 'start') { start(); return; }
  if (type === 'mobile-tab' && (target.dataset.tab === 'golems' || target.dataset.tab === 'merchants' || target.dataset.tab === 'opponents')) {
    mobileTab = target.dataset.tab; render();
    const stage=root.querySelector<HTMLElement>('.mobile-stage'); if (stage) stage.scrollTop=0;
    return;
  }
  if (type === 'mobile-expand-hand') { mobileHandExpanded=!mobileHandExpanded; render(); return; }
  if (type === 'mobile-toggle-played') { mobilePlayedOpen=!mobilePlayedOpen; render(); return; }
  if (type === 'inspect-ai') { const id=Number(target.dataset.player); inspectedAI = inspectedAI===id ? null : id; render(); return; }
  if ((type === 'export-replay-md' || type === 'export-replay-json') && game) { downloadReplay(game, type === 'export-replay-md' ? 'md' : 'json'); return; }
  if (type === 'history') { showHistory = true; historyViewId = null; render(); return; }
  if (type === 'close-history') { showHistory = false; historyViewId = null; render(); return; }
  if (type === 'history-back') { historyViewId = null; render(); return; }
  if (type === 'history-view') { historyViewId = target.dataset.id || null; render(); return; }
  if (type === 'archive-export-md' || type === 'archive-export-json') {
    const entry = archive.find(e => e.id === target.dataset.id);
    if (entry) downloadReplay(entry.game, type === 'archive-export-md' ? 'md' : 'json');
    return;
  }
  if (type === 'auto-export-enable') { enableAutoExport(); notify('已开启自动导出：结束的对局将自动下载复盘'); render(); return; }
  if (type === 'auto-export-disable') { disableAutoExport(); notify('已关闭自动导出'); render(); return; }
  if (type === 'archive-delete') {
    if (!confirm('确定删除这条对局归档吗？')) return;
    archive = archive.filter(e => e.id !== target.dataset.id);
    saveArchive(archive);
    if (historyViewId !== null && !archive.some(e => e.id === historyViewId)) historyViewId = null;
    render();
    return;
  }
  if (type === 'toggle-log') { showLog=!showLog; render(); return; }
  if (type === 'reset') {
    if (game?.phase !== 'finished' && !confirm('确定结束当前对局并重新开始吗？当前对局将自动存入对局历史。')) return;
    archiveGame();
    game = null; handoff = false; showHelp = false; showLog=false; inspectedAI=null; modal = null; botPaused = false; resultHidden = false; toast = ''; viewState.players={}; mobileTab='golems'; mobileHandExpanded=false; mobilePlayedOpen=false; saveView(); save(); render(); return;
  }
  if (type === 'help') { showHelp = true; render(); return; }
  if (type === 'close-help') { showHelp = false; render(); return; }
  if (type === 'close-result') { resultHidden = true; render(); return; }
  if (type === 'show-result') { resultHidden = false; render(); return; }
  if (type === 'ready') { handoff = false; render(); return; }
  if (type === 'ai-pause') { botPaused = !botPaused; render(); return; }
  if (type === 'card-size') { viewState.compact=!viewState.compact; saveView(); render(); return; }
  if (type === 'toggle-played') { const id=Number(target.dataset.player); if(game?.players[id]){pref(id).folded=!pref(id).folded;saveView();render();} return; }
  if (type === 'move-card') { if(!modal && !handoff){reorderHand(Number(target.dataset.player), target.dataset.id!,Number(target.dataset.direction) as -1|1);} return; }
  if (type === 'group-cards') { const id=Number(target.dataset.player); if(game?.players[id] && !modal && !handoff && !game.players[id].isAI) updateHandOrder(id,groupOrder(game.players[id].hand,sortedHand(game.players[id]),card=>MERCHANT_BY_ID[card].kind)); return; }
  if (type === 'cancel') { if (game?.phase === 'overflow') return; modal = null; toast = ''; render(); return; }
  if (!game || game.phase === 'finished' || handoff || showHelp || showHistory || game.players[game.current].isAI) return;
  if (game.phase === 'overflow' && !modal) modal = {kind:'discard', colors:[]};
  const p = game.players[game.current];
  const idx = Number(target.dataset.index);
  const color = Number(target.dataset.color) as Color;
  if (type === 'rest') { action({ type:'rest' }); return; }
  if (type === 'claim') { action({ type:'claim', index: idx }); return; }
  if (type === 'get-merchant') {
    if (idx > count(p.stock)) { notify(`当前仅有 ${count(p.stock)} 颗水晶，支付不起市场位置费用`); return; }
    if (idx === 0) { action({ type:'acquire', index:0, payment:[] }); return; }
    modal = {kind:'acquire', index:idx, payment:[]}; render(); return;
  }
  if (type === 'play-hand') {
    const id = target.dataset.id!;
    const card = MERCHANT_BY_ID[id];
    if (!card) return;
    if (card.kind === 'create') { action({type:'play', cardId:id}); return; }
    if (card.kind === 'upgrade') modal = { kind:'upgrade', id, steps:[], draft:[...p.stock] as Stock };
    else if (tradeLimit(p.stock, id) > 0) modal = { kind:'trade', id, repeats:1 };
    else { notify('现有水晶不足以执行该交易'); return; }
    render(); return;
  }
  if (!modal) return;
  if (modal.kind === 'upgrade') {
    if (type === 'upgrade-step' && modal.steps.length < MERCHANT_BY_ID[modal.id].steps! && color <= 2 && modal.draft[color] > 0) {
      modal.draft[color]--; modal.draft[color+1]++; modal.steps.push(color); render(); return;
    }
    if (type === 'upgrade-undo' && modal.steps.length) {
      const c = modal.steps.pop()!; modal.draft[c]++; modal.draft[c+1]--; render(); return;
    }
    if (type === 'confirm-upgrade') { action({type:'play',cardId:modal.id,steps:modal.steps}); return; }
  }
  if (modal.kind === 'trade') {
    if (type === 'trade-minus') { modal.repeats = Math.max(1, modal.repeats - 1); render(); return; }
    if (type === 'trade-plus') { modal.repeats = Math.min(tradeLimit(p.stock, modal.id), modal.repeats + 1); render(); return; }
    if (type === 'confirm-trade') { action({type:'play',cardId:modal.id,repeats:modal.repeats}); return; }
  }
  if (modal.kind === 'acquire') {
    if (type === 'payment-pick' && modal.payment.length < modal.index) {
      const used = modal.payment.filter(c=>c===color).length;
      if (used < p.stock[color]) {modal.payment.push(color);render();} return;
    }
    if (type === 'payment-undo') {modal.payment.pop();render();return;}
    if (type === 'confirm-acquire') {action({type:'acquire',index:modal.index,payment:modal.payment});return;}
  }
  if (modal.kind === 'discard') {
    if (type === 'discard-pick' && modal.colors.length < count(p.stock)-10) {
      const used = modal.colors.filter(c=>c===color).length;
      if (used < p.stock[color]) {modal.colors.push(color);render();} return;
    }
    if (type === 'discard-undo') {modal.colors.pop();render();return;}
    if (type === 'confirm-discard') {action({type:'discard',colors:modal.colors});return;}
  }
}
/** AI 决策 Worker（AI6 第六阶段·任务 G2）：搜索预算 ≥500ms 时主线程同步
 * 决策会冻结 UI——AI 思考移入 Worker（移动端既有模式），主线程保持响应。
 * 纪律：一次决策只提交一次合法行动（Worker 回调一次性作废）；游戏状态
 * 更新后不提交过期决策（game 引用 + 回合数 + 行动者三重过期守卫）；
 * Worker 不可用（file:// 无 module Worker、构造失败）时回退同步决策。 */
let botWorker: Worker | null = null;
let botWorkerURL: string | null = null;
let aiThinking = false;
function stopBotWorker() {
  if (botTimer !== null) { clearTimeout(botTimer); botTimer = null; }
  botWorker?.terminate();
  botWorker = null;
  if (botWorkerURL) URL.revokeObjectURL(botWorkerURL);
  botWorkerURL = null;
  aiThinking = false;
}
function syncBotDecision(expectedTurn: number, expectedPlayer: number) {
  stopBotWorker();
  if (!game || game.turnNumber!==expectedTurn || game.current!==expectedPlayer || game.phase==='finished' || handoff || showHelp || showHistory || botPaused || !game.players[game.current]?.isAI) return;
  try {
    const choice = chooseAIAction(game);
    action(choice.action);
  } catch(e) { botPaused=true; notify(`AI 行动异常，已暂停：${e instanceof Error ? e.message : String(e)}`); }
}
function scheduleBot() {
  if (botTimer !== null) { clearTimeout(botTimer); botTimer=null; }
  if (!game || game.phase==='finished' || handoff || showHelp || showHistory || modal || botPaused || !game.players[game.current]?.isAI) return;
  const expectedTurn = game.turnNumber;
  const expectedPlayer = game.current;
  botTimer = setTimeout(() => {
    botTimer=null;
    if (!game || game.turnNumber!==expectedTurn || game.current!==expectedPlayer || game.phase==='finished' || handoff || showHelp || showHistory || botPaused || !game.players[game.current]?.isAI) return;
    const decisionGame = game;
    try {
      const embedded = document.getElementById('offline-ai-worker');
      const url = embedded && embedded.textContent
        ? URL.createObjectURL(new Blob([embedded.textContent], {type:'text/javascript'}))
        : new URL('./js/ai-worker.js', import.meta.url).href;
      if (embedded && embedded.textContent) botWorkerURL = url;
      aiThinking = true;
      render();
      botWorker = new Worker(url, { type: embedded && embedded.textContent ? 'classic' : 'module' });
      botWorker.onmessage = (event: MessageEvent) => {
        stopBotWorker();
        render();
        // 过期决策守卫：对局对象已换代 / 回合已推进 / 行动者已变 → 丢弃。
        if (!game || game !== decisionGame || game.turnNumber!==expectedTurn || game.current!==expectedPlayer || game.phase==='finished' || handoff || showHelp || showHistory || botPaused) return;
        if (event.data?.error) { botPaused=true; notify(`AI 行动异常，已暂停：${event.data.error}`); render(); return; }
        if (!event.data?.action) throw new Error('AI Worker 返回空行动');
        action(event.data.action);
      };
      botWorker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        // Worker 不可用 → 回退主线程同步决策（保持正确性，牺牲响应性）。
        syncBotDecision(expectedTurn, expectedPlayer);
      };
      botWorker.postMessage(decisionGame);
    } catch {
      syncBotDecision(expectedTurn, expectedPlayer);
    }
  }, 480);
}
root.addEventListener('click', event => {
  const element = event.target as HTMLElement;
  const target = element.closest<HTMLElement>('[data-action]');
  if (target && !target.hasAttribute('disabled')) {
    if (target.dataset.action==='play-hand' && Date.now()<suppressPlayUntil) return;
    control(target);
  }
});
root.addEventListener('dragstart',event=>{
  const tile=(event.target as HTMLElement).closest<HTMLElement>('[data-drag-player][data-card-id]');
  if(!tile || !game || modal || handoff || game.phase==='finished') {event.preventDefault(); return;}
  const player=Number(tile.dataset.dragPlayer);
  if(game.players[player]?.isAI){ event.preventDefault(); return; }
  dragging={player,id:tile.dataset.cardId!};
  event.dataTransfer?.setData('text/plain',dragging.id);
  if(event.dataTransfer) event.dataTransfer.effectAllowed='move';
  tile.classList.add('tile-dragging');
});
root.addEventListener('dragover',event=>{
  const tile=(event.target as HTMLElement).closest<HTMLElement>('[data-drag-player][data-card-id]');
  if(!tile || !dragging || dragging.player!==Number(tile.dataset.dragPlayer) || tile.dataset.cardId===dragging.id) return;
  event.preventDefault();
  if(event.dataTransfer) event.dataTransfer.dropEffect='move';
  root.querySelectorAll('.tile-drop-target').forEach(x=>x.classList.remove('tile-drop-target'));
  tile.classList.add('tile-drop-target');
});
root.addEventListener('drop',event=>{
  const tile=(event.target as HTMLElement).closest<HTMLElement>('[data-drag-player][data-card-id]');
  if(tile && dragging && dragging.player===Number(tile.dataset.dragPlayer)) {
    event.preventDefault(); suppressPlayUntil=Date.now()+350;
    const source=dragging; dragging=null;
    root.querySelectorAll('.tile-drop-target,.tile-dragging').forEach(x=>x.classList.remove('tile-drop-target','tile-dragging'));
    reorderHand(source.player,source.id,undefined,tile.dataset.cardId);
  }
});
root.addEventListener('dragend',()=>{
  dragging=null; suppressPlayUntil=Date.now()+350;
  root.querySelectorAll('.tile-drop-target,.tile-dragging').forEach(x=>x.classList.remove('tile-drop-target','tile-dragging'));
});
root.addEventListener('change', e => {
  const element = e.target as HTMLSelectElement;
  if (element.id !== 'humanCount' && element.id !== 'botCount') return;
  syncSetup();
});
mobileMedia.addEventListener('change', () => { if (!dedicatedMobilePage) { mobileTab='golems'; mobileHandExpanded=false; mobilePlayedOpen=false; render(); } });
render();
