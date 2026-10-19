import { GOLEM_BY_ID, MERCHANT_BY_ID, type Merchant, type Stock } from './data.js';
import { applyAction, count, createGame, has, ranking, readable, score, tradeLimit, type Action, type Color, type Game } from './engine.js';
import { chooseAIAction } from './ai.js';

const KEY = 'crystal-corridor-game-v2-canonical';
const COLOR = ['黄','绿','蓝','粉'];
const classColor = ['yellow','green','blue','pink'];
const root = document.getElementById('app')!;
let game: Game | null = null;
let modal: Modal | null = null;
let handoff = false;
let showHelp = false;
let toast = '';
let botPaused = false;
let botTimer: ReturnType<typeof setTimeout> | null = null;

type Modal =
  | { kind: 'upgrade'; id: string; steps: Color[]; draft: Stock }
  | { kind: 'trade'; id: string; repeats: number }
  | { kind: 'acquire'; index: number; payment: Color[] }
  | { kind: 'discard'; colors: Color[] };

try {
  const saved = localStorage.getItem(KEY);
  if (saved) {
    const parsed: Game = JSON.parse(saved);
    if (parsed?.version === 2 && Array.isArray(parsed.players) && parsed.players.length >= 2 && parsed.players.length <= 5 && parsed.players[parsed.current]) game = parsed;
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
  const bottom = market ? `<span>${marketIndex === 0 ? '免费获取' : `左侧压 ${marketIndex} 颗`}</span><b>获取 ↗</b>`
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
  return `<main class="layout landing"><header class="topbar"><div class="brand-icon">◇</div><div class="brand-text"><strong>晶石回廊</strong><span>CRYSTAL CORRIDOR</span></div><span class="edition">V1.3 · 五人同屏</span></header>
    <div class="landing-split"><section class="welcome-copy"><div class="eyebrow">桌游数字化 · AI 实战训练</div><h1>与晶石工匠，<br>角逐最佳引擎。</h1><p>支持 1～2 名人类与 0～3 名 AI，最多 5 人；双真人支持超宽屏同屏操作。</p><div class="feature-row"><span>◇ 3 个 AI 席位</span><span>◇ 自动行动</span><span>◇ 离线可玩</span></div></section>
    <section class="setup-box"><div class="eyebrow">NEW GAME</div><h2>创建对局</h2><p class="hint">单真人搭配至少一名 AI；双真人固定使用左右两侧操作区。最多三名 AI。</p>
    <div class="setup-players"><div><label for="humanCount">人类玩家</label><select id="humanCount"><option value="1">1 名</option><option value="2" selected>2 名</option></select></div>
    <div><label for="botCount">AI 玩家</label><select id="botCount">${Array.from({length:4},(_,i)=>`<option value="${i}" ${i===3?'selected':''}>${i} 名</option>`).join('')}</select></div></div>
    <label>人类玩家名称</label><div id="nameInputs" class="name-inputs"><input maxlength="20" aria-label="玩家 1" value="玩家 1"/><input maxlength="20" aria-label="玩家 2" value="玩家 2"/></div>
    <div class="ai-seat-heading"><b>AI 玩家席位</b><span>最多 3 位</span></div><div class="ai-seat-picker">${Array.from({length:3},(_,i)=>`<div data-ai-slot="${i}" class="ai-slot selected"><b>✧ AI ${i+1}</b><span>已加入</span></div>`).join('')}</div>
    <p id="setupValidation" class="setup-validation">合计 5 名参赛者</p>
    <button class="primary-btn big" data-action="start">开始对局 <span>↗</span></button><p class="small-muted">独立学习原型，不使用原版插画。</p></section></div>
    <footer class="footer"><a href="https://github.com/Xike-yuhuofei/Century" target="_blank" rel="noopener">项目仓库</a></footer></main>`;
}
function syncSetup(){
  if(game)return;
  const humans=Number((root.querySelector('#humanCount') as HTMLSelectElement)?.value||2);
  const bots=Number((root.querySelector('#botCount') as HTMLSelectElement)?.value||0);
  const container=root.querySelector<HTMLElement>('#nameInputs');
  if(!container)return;
  // Keep the second player's typed name when switching 2 -> 1 -> 2.
  const nameInputs=[...container.querySelectorAll<HTMLInputElement>('input')];
  nameInputs.forEach((input,i)=>{input.hidden=i>=humans;});
  for(const seat of root.querySelectorAll<HTMLElement>('[data-ai-slot]')){
    const selected=Number(seat.dataset.aiSlot)<bots;
    seat.classList.toggle('selected',selected);
    const state=seat.querySelector('span');
    if(state)state.textContent=selected?'已加入':'空席';
  }
  const valid=(humans===1||humans===2)&&bots>=0&&bots<=3&&humans+bots>=2&&humans+bots<=5;
  const status=root.querySelector<HTMLElement>('#setupValidation');
  if(status){
    status.textContent=valid?`合计 ${humans+bots} 名参赛者`:humans===1&&bots===0?'单人模式至少需要 1 名 AI':'总人数须为 2–5 人';
    status.classList.toggle('invalid',!valid);
  }
  const start=root.querySelector<HTMLButtonElement>('[data-action="start"]');
  if(start)start.disabled=!valid;
}
function playerCard(p: Game['players'][number], active: boolean): string {
  return `<div class="player-pill ${active ? 'active-player' : ''}"><div class="avatar">${p.isAI?"AI":p.id+1}</div><div class="player-info"><b>${esc(p.name)}</b><small>${p.claimed.length} 张魔像 · ${p.turns} 回合</small></div><span class="player-score">${score(p)}<small>估分</small></span></div>`;
}
function golemCard(id: string, index: number, g: Game): string {
  const golem = GOLEM_BY_ID[id];
  const available = has(g.players[g.current].stock, golem.cost);
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
      <div class="duel-player-title"><span class="duel-avatar">${p.isAI?"AI":index+1}</span><div><div class="duel-name">${esc(p.name)}</div><span class="duel-status">${active?(p.isAI?'● AI 正在行动':'● 当前行动方'):'○ 等待行动'} · ${p.turns} 回合</span></div></div>
      <div class="duel-score"><b>${score(p)}</b><small>当前估分</small></div>
    </header>
    <div class="duel-stock"><div class="duel-minor-head"><b>商队</b><span class="capacity ${count(p.stock) > 10 ? 'over-capacity' : ''}">${count(p.stock)} / 10 颗</span></div><div class="resource-bar">${stones(p.stock)}</div></div>
    <div class="duel-zone duel-hand"><div class="duel-minor-head"><b>手牌 · ${p.hand.length} 张</b><span>${active&&!p.isAI?'点击卡牌打出':'正面公开展示'}</span></div>
      <div class="duel-card-grid">${p.hand.length ? p.hand.map(id => merchantCard(id, undefined, undefined, active&&!p.isAI?'hand':'inactive')).join('') : '<div class="duel-empty">手牌已全部打出，可以休息取回</div>'}</div></div>
    <div class="duel-zone duel-played"><div class="duel-minor-head"><b>已打出 · ${p.played.length} 张</b><span>卡面朝上</span></div>
      <div class="duel-card-grid duel-used-grid">${p.played.length ? p.played.map(id => merchantCard(id, undefined, undefined, 'played')).join('') : '<div class="duel-empty">暂无已打出卡牌</div>'}</div></div>
    <footer class="duel-player-footer"><div><b>魔像 ${p.claimed.length} 张</b><span>${p.claimed.length ? p.claimed.map(id => `${GOLEM_BY_ID[id].points}分`).join(' · ') : '尚未认领'}</span><span>铜币 ${p.copper} · 银币 ${p.silver}</span></div>
      <button type="button" class="rest-btn" data-action="rest" ${active&&!p.isAI&&g.phase==='turn'?'':'disabled'}>休息 · 收回卡牌 ↗</button></footer>
  </section>`;
}
function renderDuelBoard(g: Game): string {
  const target = 6;
  const finished = g.phase === 'finished';
  return `<main class="layout duel-layout"><header class="topbar duel-topbar"><div class="brand-icon">◇</div><div class="brand-text"><strong>晶石回廊</strong><span>CRYSTAL CORRIDOR · 双人同屏</span></div>
    <div class="duel-now">${finished ? '本局结束' : `第 ${g.turnNumber} 手 · ${esc(g.players[g.current].name)} 行动中`}</div>
    <div class="top-actions">${aiPauseControl(g)}<button class="subtle-btn" data-action="help">规则</button><button class="subtle-btn" data-action="reset">新开一局</button></div></header>
    ${g.triggerPlayer !== null && !finished ? '<div class="final-alert">终局已触发，本轮结束后结算</div>' : ''}
    <div class="duel-table">
      ${renderDuelPlayer(g, 0)}
      <div class="duel-center"><div class="duel-center-heading"><span>共享市场 · CENTER TABLE</span><strong>玩家双方均可查看所有卡牌</strong></div>
        <section class="duel-market"><div class="duel-market-title"><h2>魔像市场</h2><span>剩余 ${g.golemDeck.length} 张 · 认领第 ${target} 张触发终局</span></div>
        <div class="golem-grid">${g.golemMarket.map((id, i) => golemCard(id, i, g)).join('')}</div></section>
        <section class="duel-market"><div class="duel-market-title"><h2>商人市场</h2><span>剩余 ${g.merchantDeck.length} 张 · 越靠右获取成本越高</span></div>
        <div class="merchant-grid">${g.merchantMarket.map((m, i) => merchantCard(m.id, i, m.bonus)).join('')}</div></section>
        <section class="duel-log"><div class="duel-minor-head"><b>行动记录</b><span>点击对应玩家手牌、市场牌或休息按钮完成行动</span></div>
        <div class="duel-log-lines">${g.log.slice(0, 4).map(line => `<span>${esc(line)}</span>`).join('')}</div></section>
      </div>
      ${renderDuelPlayer(g, 1)}
    </div>${finished ? renderResult(g) : ''}</main>`;
}
function aiPauseControl(g:Game):string{
  if(!g.players.some(p=>p.isAI)||g.phase==='finished')return '';
  return `<button class="subtle-btn ai-pause" data-action="ai-pause">${botPaused?'▶ 继续 AI':'Ⅱ 暂停 AI'}</button>`;
}
function renderAISeat(g:Game,p:Game['players'][number]):string{
  const active=g.current===p.id&&g.phase!=='finished';
  return `<section class="ai-seat ${active?'ai-seat-active':''}" data-bot-seat="${p.id}" aria-label="${esc(p.name)}席位">
    <div class="ai-seat-top"><div><span class="ai-seat-tag">AI · ${p.id}</span><b>${esc(p.name)}</b><small>${active?(botPaused?'已暂停':'正在计算行动'):'等待回合'}</small></div><div class="ai-seat-score">${score(p)}<small>分</small></div></div>
    <div class="ai-seat-stock"><span>商队 ${count(p.stock)}/10</span><div>${stones(p.stock,true)}</div></div>
    <div class="ai-seat-zone"><span>手牌 · ${p.hand.length}</span><div class="ai-face-row">${p.hand.length?p.hand.map(id=>merchantCard(id,undefined,undefined,'inactive')).join(''):'<span class="ai-empty">无手牌</span>'}</div></div>
    <div class="ai-seat-zone"><span>已打出 · ${p.played.length}</span><div class="ai-face-row">${p.played.length?p.played.map(id=>merchantCard(id,undefined,undefined,'played')).join(''):'<span class="ai-empty">暂无</span>'}</div></div>
    <div class="ai-seat-foot">魔像 ${p.claimed.length} 张 · 铜币 ${p.copper} · 银币 ${p.silver}</div>
  </section>`;
}
function renderSoloAIBoard(g:Game):string{
  const human=g.players.find(p=>!p.isAI)!;
  const bots=g.players.filter(p=>p.isAI);
  const finished=g.phase==='finished',target=g.players.length>=4?5:6;
  return `<main class="layout duel-layout ai-board-layout"><header class="topbar duel-topbar"><div class="brand-icon">◇</div><div class="brand-text"><strong>晶石回廊</strong><span>CRYSTAL CORRIDOR · AI ARENA</span></div>
    <div class="duel-now">${finished?'对局结束':`第 ${g.turnNumber} 手 · ${esc(g.players[g.current].name)} 行动中`}</div>
    <div class="top-actions">${aiPauseControl(g)}<button class="subtle-btn" data-action="help">规则</button><button class="subtle-btn" data-action="reset">新开一局</button></div></header>
    ${g.triggerPlayer!==null&&!finished?'<div class="final-alert">终局已触发，本轮结束后结算</div>':''}
    <div class="ai-arena">
      ${renderDuelPlayer(g,human.id)}
      <div class="duel-center"><div class="duel-center-heading"><span>共享市场 · CENTER TABLE</span><strong>1 名人类 VS ${bots.length} 名 AI</strong></div>
        <section class="duel-market"><div class="duel-market-title"><h2>魔像市场</h2><span>剩余 ${g.golemDeck.length} 张 · 第 ${target} 张触发终局</span></div><div class="golem-grid">${g.golemMarket.map((id,i)=>golemCard(id,i,g)).join('')}</div></section>
        <section class="duel-market"><div class="duel-market-title"><h2>商人市场</h2><span>剩余 ${g.merchantDeck.length} 张</span></div><div class="merchant-grid">${g.merchantMarket.map((m,i)=>merchantCard(m.id,i,m.bonus)).join('')}</div></section>
        <section class="duel-log"><div class="duel-minor-head"><b>对局记录</b><span>AI 自动行动</span></div><div class="duel-log-lines">${g.log.slice(0,6).map(line=>`<span>${esc(line)}</span>`).join('')}</div></section>
      </div>
      <aside class="ai-seat-grid">${bots.map(p=>renderAISeat(g,p)).join('')}</aside>
    </div>${finished?renderResult(g):''}</main>`;
}

// Visual-only preferences; game engine owns card ownership, availability and turns.
let fiveOrders: Record<number,string[]> = {0:[],1:[]};
let fiveSorting: Record<number,'manual'|'type'> = {0:'manual',1:'manual'};
let fivePinned: Record<number,string[]> = {0:[],1:[]};
let fiveFold: Record<number,boolean> = {0:false,1:false};
let fiveDrag: {id:string,side:number}|null = null;
function fiveHandOrder(p:Game['players'][number],side:number):string[]{
  const ids=p.hand;
  const previous=fiveOrders[side].filter(id=>ids.includes(id));
  const ordered=[...previous,...ids.filter(id=>!previous.includes(id))];
  fiveOrders[side]=ordered;
  if(fiveSorting[side]==='type'){
    const level:Record<string,number>={create:0,upgrade:1,trade:2};
    const sorted=ordered.filter(id=>!fivePinned[side].includes(id)).sort((x,y)=>level[MERCHANT_BY_ID[x].kind]-level[MERCHANT_BY_ID[y].kind]);
    return ordered.map(id=>fivePinned[side].includes(id)?id:sorted.shift()!);
  }
  return ordered;
}
function fiveHandCard(id:string,side:number,active:boolean):string {
  return merchantCard(id,undefined,undefined,active?'hand':'inactive')
    .replace('class="merchant-card',`draggable="true" data-hand-owner="${side}" class="merchant-card ${fivePinned[side].includes(id)?'five-pinned':''}`);
}
function fivePlayer(g:Game,side:number):string {
  const p=g.players[side],active=g.current===side&&g.phase!=='finished';
  const hand=fiveHandOrder(p,side);
  return `<section class="five-player ${active?'five-active':''}" aria-label="${esc(p.name)}的操作区" data-side="${side}">
    <header class="five-player-top">
      <div class="five-player-profile"><span class="five-num">${side+1}</span><div><strong>${esc(p.name)}</strong><small>${active?'● 当前行动':'等待行动'} · 已行动 ${p.turns} 回合</small></div></div>
      <div class="five-player-points"><strong>${score(p)}</strong><small>当前得分</small></div>
    </header>
    <div class="five-stock"><div class="five-rowhead"><b>商队水晶</b><span class="${count(p.stock)>10?'over-capacity':''}">${count(p.stock)} / 10</span></div><div class="five-stones">${stones(p.stock)}</div></div>
    <div class="five-cards-zone five-hand-zone">
      <div class="five-rowhead"><b>商人手牌 <em>${p.hand.length}</em></b><div class="five-tiny-buttons">
        <button data-action="five-sort" data-side="${side}" data-mode="type" class="${fiveSorting[side]==='type'?'selected':''}">按类型</button>
        <button data-action="five-sort" data-side="${side}" data-mode="manual" class="${fiveSorting[side]==='manual'?'selected':''}">自定义</button>
      </div></div>
      <div class="five-hand-cards" data-list-side="${side}">${hand.map(id=>fiveHandCard(id,side,active)).join('')||'<div class="five-blank">手牌已打完。可执行休息或其他行动。</div>'}</div>
    </div>
    <div class="five-cards-zone five-played-zone ${fiveFold[side]?'five-folded':''}">
      <div class="five-rowhead"><b>已打出 <em>${p.played.length}</em></b><button class="five-fold" data-action="five-fold" data-side="${side}">${fiveFold[side]?'展开':'折叠'} ${fiveFold[side]?'▾':'▴'}</button></div>
      <div class="five-played-cards">${p.played.map(id=>merchantCard(id,undefined,undefined,'played')).join('')||'<div class="five-blank">尚未打出商人卡</div>'}</div>
    </div>
    <footer class="five-player-foot">
      <div><div><strong>魔像 ${p.claimed.length} 张</strong><span>${p.claimed.map(id=>GOLEM_BY_ID[id].points+'分').join(' · ')||'尚未认领'}</span></div><small>铜币 ${p.copper} · 银币 ${p.silver}</small></div>
      <button class="five-rest" data-action="rest" ${!active||g.phase!=='turn'?'disabled':''}>休息 · 回收商人卡</button>
    </footer>
  </section>`;
}
function fiveAI(g:Game):string {
  const bots=g.players.filter(p=>p.isAI);
  return `<section class="five-ai-strip"><div class="five-rowhead"><b>AI 玩家 ${bots.length} / 3</b><span>自动行动 · 不占用真人区域</span></div><div class="five-ai-cards">${Array.from({length:3},(_,i)=>{
    const p=bots[i];if(!p)return '<div class="five-ai-item five-ai-empty">空席</div>';
    const active=g.current===p.id&&g.phase!=='finished';
    const last=g.log.find(line=>line.startsWith(p.name+' '))||'尚未行动';
    return `<article class="five-ai-item ${active?'five-ai-current':''}" title="${esc(last)}"><div class="five-ai-top"><b>${esc(p.name)}</b><strong>${score(p)} <small>分</small></strong></div><div class="five-ai-stones">${stones(p.stock,true)}</div><div class="five-ai-meta">商人 ${p.hand.length+p.played.length} · 魔像 ${p.claimed.length} · ${active?'正在行动':'等待'}</div><div class="five-ai-log">${esc(last)}</div></article>`;
  }).join('')}</div></section>`;
}
function renderFiveBoard(g:Game):string {
  const current=g.players[g.current],finished=g.phase==='finished',target=g.players.length>=4?5:6;
  return `<main class="five-root">
    <header class="five-topbar"><div class="five-brand"><span class="five-brand-gem">◇</span><div><b>晶石回廊</b><small>CENTURY · GOLEM</small></div></div><div class="five-turn">第 ${g.turnNumber} 手 · ${finished?'对局已结束':esc(current.name)+' 行动中'}</div>
       <div class="five-controls">${aiPauseControl(g)}<button class="subtle-btn" data-action="help">规则</button><button class="subtle-btn" data-action="reset">新游戏</button></div></header>
    ${g.triggerPlayer!==null&&!finished?'<div class="five-final-alert">终局已触发，本轮结束后计分</div>':''}
    <div class="five-board">
      ${fivePlayer(g,0)}
      <section class="five-center">
        ${fiveAI(g)}
        <section class="five-market five-golem-market"><div class="five-rowhead"><b>魔像市场 <em>5</em></b><span>第 ${target} 张触发终局 · 牌库剩余 ${g.golemDeck.length}</span></div>
        <div class="five-golem-grid">${g.golemMarket.map((id,i)=>golemCard(id,i,g)).join('')}</div></section>
        <section class="five-market five-merchant-market"><div class="five-rowhead"><b>商人市场 <em>6</em></b><span>从左至右获取成本递增 · 牌库剩余 ${g.merchantDeck.length}</span></div>
        <div class="five-merchant-grid">${g.merchantMarket.map((m,i)=>merchantCard(m.id,i,m.bonus)).join('')}</div></section>
        <section class="five-workbench ${modal?'five-work-active':''}">
          ${modal && !finished ? `<div class="five-inline-modal">${modalBody()}</div>` : `<div class="five-work-default"><strong>${current.isAI?'AI 自动执行行动':current.name+' · 请选择行动'}</strong><span>打出手牌、获取商人、认领魔像或休息。点击卡牌查看或执行操作。</span><small>交易和升级在此处选择数量；当前商队 ${count(current.stock)} / 10</small></div>`}
        </section>
        <div class="five-log">${esc(g.log[0]||'对局已开始')}</div>
      </section>
      ${fivePlayer(g,1)}
    </div>
    <div id="five-hover" class="five-hover" hidden></div>
    ${finished?renderResult(g):''}
  </main>`;
}

function renderBoard(g: Game): string {
  if(g.players.filter(p=>!p.isAI).length===2)return renderFiveBoard(g);
  if(g.players.filter(p=>!p.isAI).length===1&&g.players.some(p=>p.isAI))return renderSoloAIBoard(g);
  if (g.players.length === 2) return renderDuelBoard(g);
  const p = g.players[g.current];
  const target = g.players.length >= 4 ? 5 : 6;
  const finished = g.phase === 'finished';
  return `<main class="layout board-layout"><header class="topbar"><div class="brand-icon">◇</div><div class="brand-text"><strong>晶石回廊</strong><span>CRYSTAL CORRIDOR</span></div><div class="top-actions"><span class="turn-badge">第 ${g.turnNumber} 手</span>${aiPauseControl(g)}<button class="subtle-btn" data-action="help">规则</button><button class="subtle-btn" data-action="reset">新开一局</button></div></header>
  <section class="players-strip">${g.players.map((x, i) => playerCard(x, i === g.current && !finished)).join('')}</section>
  ${g.triggerPlayer !== null && !finished ? '<div class="final-alert">终局已触发！本轮完成后结算。</div>' : ''}
  <section class="game-section"><div class="section-head"><div><span class="section-index">01 / THE GOLEMS</span><h2>魔像市场 <small>认领目标</small></h2></div><div class="section-meta">牌库剩余 ${g.golemDeck.length} 张 · 每人认领 ${target} 张触发终局</div></div>
  <div class="golem-grid">${g.golemMarket.map((id, i) => golemCard(id, i, g)).join('')}</div></section>
  <section class="game-section"><div class="section-head"><div><span class="section-index">02 / THE MERCHANTS</span><h2>商人市场 <small>构建引擎</small></h2></div><div class="section-meta">牌库剩余 ${g.merchantDeck.length} 张 · 越靠右获取成本越高</div></div>
  <div class="merchant-grid">${g.merchantMarket.map((card, i) => merchantCard(card.id, i, card.bonus)).join('')}</div></section>
  <section class="personal-zone"><div class="zone-head"><div><span class="section-index">03 / YOUR CARAVAN</span><h2>${esc(p.name)} 的回合 <small>${finished ? '已结束' : '请选择一个行动'}</small></h2></div><div class="resource-bar">${stones(p.stock)}<div class="capacity ${count(p.stock) > 10 ? 'over-capacity' : ''}">${count(p.stock)} / 10 颗</div></div></div>
  <div class="personal-layout"><div class="hand-area"><div class="hand-heading"><b>当前手牌 <span>${p.hand.length} 张</span></b><span>点击卡牌执行打出</span></div><div class="hand-grid">${p.hand.length ? p.hand.map(id => merchantCard(id)).join('') : '<p class="empty-hand">没有可打出的商人卡。可以休息、获取或认领。</p>'}</div>
  <div class="played"><b>已打出 ${p.played.length} 张</b> <span>${p.played.map(id => MERCHANT_BY_ID[id].kind === 'create' ? '创造' : MERCHANT_BY_ID[id].kind === 'upgrade' ? '升级' : '交易').join(' · ') || '无'}</span><button class="rest-btn" data-action="rest" ${finished ? 'disabled' : ''}>休息 · 收回已打出卡牌</button></div></div>
  <aside class="right-column"><div class="score-panel"><h3>个人战绩</h3><div class="score-large">${score(p)} <span>当前估分</span></div><div class="score-breakdown"><span>魔像 ${p.claimed.reduce((s, id) => s + GOLEM_BY_ID[id].points, 0)} 分</span><span>铜币 ${p.copper} · 银币 ${p.silver}</span><span>非黄水晶 ${p.stock[1] + p.stock[2] + p.stock[3]} 分</span></div></div>
  <div class="history"><h3>行动记录</h3>${g.log.slice(0, 7).map(line => `<p>${esc(line)}</p>`).join('')}</div></aside></div></section>
  <footer class="footer">点击手牌：打出 · 点击市场：获取或认领 · 「休息」独占一回合。所有规则由本地引擎校验。</footer>
  ${handoff && !finished ? `<div class="overlay cover"><div class="handoff-card"><div class="cover-symbol">◇</div><div class="eyebrow">PASS THE DEVICE</div><h2>轮到 ${esc(p.name)}</h2><p>请把设备交给下一位玩家，准备后再显示手牌。</p><button class="primary-btn big" data-action="ready">我已就位，显示游戏 ↗</button></div></div>` : ''}
  ${finished ? renderResult(g) : ''}</main>`;
}
function renderResult(g: Game): string {
  const result = ranking(g);
  return `<div class="overlay cover"><section class="result-card"><div class="eyebrow">GAME COMPLETE</div><h2>对局结束</h2><div class="trophy">◇</div><p class="winner">获胜者：<strong>${esc(result[0].name)}</strong></p><p class="small-muted">平分时最后行动的玩家优先</p><div class="result-table">${result.map((p, i) => `<div><b>${i + 1}. ${esc(p.name)}</b><span>${p.claimed.length} 张魔像</span><strong>${score(p)} 分</strong></div>`).join('')}</div><button class="primary-btn big" data-action="reset">开始新的一局 ↗</button></section></div>`;
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
  return `<div class="overlay" data-overlay="help"><section class="dialog help-dialog"><button class="close-modal" data-action="close-help">✕</button><div class="eyebrow">RULE BOOK</div><h2>规则速览</h2><div class="help-rows"><p><b>四类行动：</b>每回合选择 打出、获取、休息、认领 中的一项。</p><p><b>打出：</b>创造获得水晶；升级可逐级、可连续升级同一颗；交易可在一回合重复多次。</p><p><b>获取：</b>目标左侧每张卡上压 1 颗任意水晶，目标卡上的累计水晶归获取者。</p><p><b>休息：</b>取回全部已打出商人卡，占用完整一回合。</p><p><b>认领：</b>精确支付魔像需求。左一铜币 +3 分，左二银币 +1 分；铜币耗尽后银币移至最左。</p><p><b>容量：</b>你的回合结束最多保留 10 颗，超过时自行选择弃置。</p><p><b>终局：</b>2–3 人局认领第 6 张、4–5 人局认领第 5 张触发；完成当前整轮后结算。</p><p><b>计分：</b>魔像分 + 铜币×3 + 银币×1 + 剩余非黄水晶×1；平分时最后行动者获胜。</p></div><button class="primary-btn" data-action="close-help">返回游戏</button></section></div>`;
}
function render() {
  root.innerHTML = `${game ? renderBoard(game) : renderSetup()}
    ${modal && game && game.players.filter(p=>!p.isAI).length!==2 && !handoff && game.phase !== 'finished' ? `<div class="overlay" data-overlay="modal"><section class="dialog">${game.phase !== 'overflow' ? '<button class="close-modal" data-action="cancel">✕</button>' : ''}${modalBody()}</section></div>` : ''}
    ${showHelp ? renderRules() : ''}${toast ? `<div class="toast" role="alert">${esc(toast)}</div>` : ''}`;
  scheduleBot();
}
function save() { try { if (game) localStorage.setItem(KEY, JSON.stringify(game)); else localStorage.removeItem(KEY); } catch { /* 可无存储运行 */ } }
function notify(message: string) { toast = message; render(); }
function action(a: Action) {
  if (!game) return;
  try {
    const previous = game.current;
    game = applyAction(game, a);
    modal = game.phase === 'overflow' && !game.players[game.current].isAI ? {kind:'discard', colors:[]} : null;
    handoff = game.players.filter(p=>!p.isAI).length!==2 && game.players.length>2 && game.current!==previous && game.phase!=='finished' && !game.players[game.current].isAI && game.players.filter(p=>!p.isAI).length>1;
    toast = '';
    save(); render();
  } catch(e) { notify(e instanceof Error ? e.message : '行动无法执行'); }
}
function start(){
  const inputs=[...root.querySelectorAll<HTMLInputElement>('#nameInputs input')];
  try{
    const humans=Number((root.querySelector('#humanCount') as HTMLSelectElement).value);
    const bots=Number((root.querySelector('#botCount') as HTMLSelectElement).value);
    if((humans!==1&&humans!==2)||bots<0||bots>3||humans+bots<2||humans+bots>5||inputs.length!==2)
      throw Error('请选择 1～2 名人类和 0～3 名 AI，且总人数至少 2 人');
    const names=[...inputs.slice(0,humans).map(x=>x.value),...Array.from({length:bots},(_,i)=>`AI 工匠 ${i+1}`)];
    game=createGame(names,undefined,Array.from({length:bots},(_,i)=>humans+i));
    fiveOrders={0:[],1:[]};fiveSorting={0:'manual',1:'manual'};fivePinned={0:[],1:[]};fiveFold={0:false,1:false};
    modal=null;handoff=false;botPaused=false;showHelp=false;toast='';save();render();
  }catch(e){notify(e instanceof Error?e.message:'无法开始游戏');}
}
function control(target: HTMLElement) {
  const type = target.dataset.action || '';
  if (type === 'start') { start(); return; }
  if (type === 'reset') {
    if (game?.phase !== 'finished' && !confirm('确定结束当前对局并重新开始吗？当前存档将被覆盖。')) return;
    game = null; handoff = false; showHelp = false; modal = null; botPaused=false; toast = ''; save(); render(); return;
  }
  if (type === 'help') { showHelp = true; render(); return; }
  if (type === 'close-help') { showHelp = false; render(); return; }
  if (type === 'ready') { handoff = false; render(); return; }
  if (type === 'ai-pause') { botPaused=!botPaused; render(); return; }
  if (type === 'cancel') { if (game?.phase === 'overflow') return; modal = null; toast = ''; render(); return; }
  if (!game || game.phase==='finished'||handoff||showHelp||game.players[game.current].isAI) return;
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
function scheduleBot(){
  if(botTimer!==null){clearTimeout(botTimer);botTimer=null;}
  if(!game||game.phase==='finished'||handoff||showHelp||modal||botPaused||!game.players[game.current]?.isAI)return;
  const player=game.current,turn=game.turnNumber;
  botTimer=setTimeout(()=>{
    botTimer=null;
    if(!game||game.current!==player||game.turnNumber!==turn||game.phase==='finished'||handoff||showHelp||botPaused||!game.players[game.current]?.isAI)return;
    try{action(chooseAIAction(game).action);}
    catch(e){botPaused=true;notify('AI 行动异常，已暂停：'+(e instanceof Error?e.message:String(e)));}
  },470);
}

// Non-game UI actions: folding, sorting and ordering do not consume a turn.
function fiveUIControl(target:HTMLElement):boolean{
  const action=target.dataset.action,side=Number(target.dataset.side);
  if(!game||!['five-fold','five-sort'].includes(action||''))return false;
  if(side!==0&&side!==1)return true;
  if(action==='five-fold')fiveFold[side]=!fiveFold[side];
  if(action==='five-sort')fiveSorting[side]=target.dataset.mode==='type'?'type':'manual';
  render();return true;
}
root.addEventListener('dragstart',event=>{
  const c=(event.target as HTMLElement).closest<HTMLElement>('.five-hand-cards .merchant-card[data-hand-owner]');
  if(!c||!game)return;
  fiveDrag={id:c.dataset.id||'',side:Number(c.dataset.handOwner)};
  event.dataTransfer?.setData('text/plain',fiveDrag.id);
  if(event.dataTransfer)event.dataTransfer.effectAllowed='move';
});
root.addEventListener('dragover',event=>{
  const c=(event.target as HTMLElement).closest<HTMLElement>('.five-hand-cards .merchant-card[data-hand-owner]');
  if(c&&fiveDrag&&Number(c.dataset.handOwner)===fiveDrag.side)event.preventDefault();
});
root.addEventListener('drop',event=>{
  const c=(event.target as HTMLElement).closest<HTMLElement>('.five-hand-cards .merchant-card[data-hand-owner]');
  if(!game||!fiveDrag||!c||Number(c.dataset.handOwner)!==fiveDrag.side)return;
  event.preventDefault();
  const from=fiveDrag.id,to=c.dataset.id||'',side=fiveDrag.side;
  const previous=fiveHandOrder(game.players[side],side);
  const before=previous.indexOf(from),target=previous.indexOf(to);
  const order=previous.filter(id=>id!==from);
  const position=order.indexOf(to);
  if(before>=0&&target>=0&&position>=0&&from!==to){
    order.splice(before<target?position+1:position,0,from);
    fiveOrders[side]=order;fiveSorting[side]='manual';
  }
  fiveDrag=null;render();
});
root.addEventListener('dragend',()=>{fiveDrag=null;});
// Read-only enlarged card preview; pointer does not obstruct the table.
root.addEventListener('pointerover',event=>{
  if(fiveDrag)return;
  const c=(event.target as HTMLElement).closest<HTMLElement>('.five-root .merchant-card');
  const tip=root.querySelector<HTMLElement>('#five-hover');
  if(!c||!tip)return;
  const id=c.dataset.id||'';
  if(!MERCHANT_BY_ID[id])return;
  tip.innerHTML=merchantCard(id,undefined,undefined,'inactive');
  const r=c.getBoundingClientRect();
  const w=220,h=260;
  tip.style.left=(r.right+w+15<window.innerWidth?r.right+13:Math.max(8,r.left-w-13))+'px';
  tip.style.top=Math.max(8,Math.min(window.innerHeight-h-8,r.top-5))+'px';
  tip.hidden=false;
});
root.addEventListener('pointerout',event=>{
  const c=(event.target as HTMLElement).closest<HTMLElement>('.five-root .merchant-card');
  const other=event.relatedTarget as Node|null;
  if(!c||other&&c.contains(other))return;
  const tip=root.querySelector<HTMLElement>('#five-hover');
  if(tip)tip.hidden=true;
});
root.addEventListener('contextmenu',event=>{
  const c=(event.target as HTMLElement).closest<HTMLElement>('.five-hand-cards .merchant-card[data-hand-owner]');
  if(!c)return;
  event.preventDefault();
  const side=Number(c.dataset.handOwner),id=c.dataset.id||'';
  if(side!==0&&side!==1)return;
  fivePinned[side]=fivePinned[side].includes(id)?fivePinned[side].filter(x=>x!==id):[...fivePinned[side],id];
  render();
});

root.addEventListener('click', event => {
  const element = event.target as HTMLElement;
  const target = element.closest<HTMLElement>('[data-action]');
  if (target && !target.hasAttribute('disabled') && !fiveUIControl(target)) control(target);
});
root.addEventListener('change',e=>{
  const target=e.target as HTMLSelectElement;
  if(target.id==='humanCount'||target.id==='botCount')syncSetup();
});
render();