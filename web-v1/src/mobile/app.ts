import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import { applyAction, add, count, createGame, has, ranking, readable, score, tradeLimit, type Action, type Color, type Game, type Player } from '../engine.js';
import { visibleOrder, groupOrder, stepInOrder } from '../organize.js';
import { chooseAIAction } from '../ai.js';
import { MOBILE_KEY, DESKTOP_KEY, parseMobileSave } from './storage.js';

const mRoot = document.getElementById('mobile-app')!;
const mColors = ['黄','绿','蓝','粉'];
const mKinds = {create:'创造',upgrade:'升级',trade:'交易'};
type MobileSheet = {kind:'play';id:string;steps:Color[];repeats:number} | {kind:'acquire';index:number;colors:Color[]} | {kind:'claim';index:number} | {kind:'discard';colors:Color[]} | {kind:'rest'|'menu'|'help'|'log'|'new'} | {kind:'player';index:number};
let mGame:Game|null = null, mSheet:MobileSheet|null = null;
let mSaved:Game|null = null, mHandoff = false, mExpanded = false, mPlayed = false, mPaused = false, mArrange = false, mFilter = 'all';
let mShownCurrent = -1;
let mOwner = 0, mWorker:Worker|null = null, mTimer:ReturnType<typeof setTimeout>|null = null;
let mWorkerURL:string|null=null;
let mBusy = false, mToast = '', mNotice = '', mNames = ['玩家 1','玩家 2'];
let mHumans = 1, mBots = 1, mOrder:Record<string,string[]> = {};
let mToastTimer:ReturnType<typeof setTimeout>|null = null;
try { mSaved = parseMobileSave(localStorage.getItem(MOBILE_KEY)); const order=JSON.parse(localStorage.getItem('century-mobile-order-v1')||'{}');mOrder=Object.fromEntries(Object.entries(order||{}).filter(([,ids])=>Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&Object.hasOwn(MERCHANT_BY_ID,id)))) as Record<string,string[]>; } catch(e) { mNotice = e instanceof Error ? e.message : '无法读取存档'; }
const mEsc = (s:string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function mBtn(label:string,action:string,attrs='',cls=''):string { return `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`; }
function mGems(s:Stock):string {
  return `<span class="gems" role="img" aria-label="${readable(s)}">${s.flatMap((n,c)=>Array.from({length:n},()=>`<span class="gem gem-${c}" aria-hidden="true"><i>${mColors[c]}</i></span>`)).join('') || '<span class="empty">无水晶</span>'}</span>`;
}
function mEffect(id:string):string {
  const card = MERCHANT_BY_ID[id];
  if (card.kind==='upgrade') return `<span class="upgrade-effect"><b>${card.steps}</b><span>次升级</span></span><span class="upgrade-path">黄 → 绿 → 蓝 → 粉</span>`;
  if (card.kind==='create') return `<span class="effect create-effect">${mGems(card.output!)}</span>`;
  return `<span class="effect trade-effect">${mGems(card.input!)}<span class="trade-arrow" aria-label="换取">↓</span>${mGems(card.output!)}</span>`;
}
function mDescription(id:string):string { const c=MERCHANT_BY_ID[id]; return `${mKinds[c.kind]} ${id}，${c.kind==='upgrade'?`至多升级 ${c.steps} 次`:c.kind==='create'?`获得 ${readable(c.output!)}`:`支付 ${readable(c.input!)} 换取 ${readable(c.output!)}`}`; }
function mCard(id:string, action='',attrs='',foot=''):string {
  const c = MERCHANT_BY_ID[id], tag = action?'button':'div';
  return `<${tag} ${action?`type="button" data-action="${action}"`:''} ${attrs} class="card merchant ${c.kind}" aria-label="${mDescription(id)}"><span class="card-top"><strong>${mKinds[c.kind]}</strong><small>${id}</small></span>${mEffect(id)}${foot?`<span class="card-foot">${foot}</span>`:''}</${tag}>`;
}
// Compact board cards display only the actual effect; full descriptions remain accessible to screen readers.
function mGraphicCard(id:string, action='', attrs='', bonus=''):string {
  const card=MERCHANT_BY_ID[id], tag=action?'button':'div';
  return `<${tag} ${action?`type="button" data-action="${action}"`:''} ${attrs} class="card merchant ${card.kind} graphic-card" aria-label="${mDescription(id)}">${mEffect(id)}${bonus?`<span class="graphic-bonus">${bonus}</span>`:''}</${tag}>`;
}
function mCoin(i:number):string {
  if(!mGame)return '';
  if(i===0 && mGame.copper) return `<span class="coin copper">铜 +3</span>`;
  if((i===1 && mGame.copper || i===0 && !mGame.copper) && mGame.silver) return `<span class="coin silver">银 +1</span>`;
  return '<span class="coin none">魔像</span>';
}
function mSave() {
  if(!mGame)return;
  try { localStorage.setItem(MOBILE_KEY,JSON.stringify(mGame)); mSaved=mGame; } catch { mNotice='存储不可用，本局仍可游玩；请在菜单导出备份'; }
}
function mSaveOrder(){ try{localStorage.setItem('century-mobile-order-v1',JSON.stringify(mOrder));}catch{} }
function mUpdateHandOrder(player:Player, ordered:string[]){
  const available=new Set(player.hand);
  if(ordered.length!==available.size || new Set(ordered).size!==available.size || ordered.some(id=>!available.has(id)))return;
  const owned=visibleOrder([...player.hand,...player.played],mOrder[player.id]||[]);
  let index=0;
  mOrder[player.id]=owned.map(id=>available.has(id)?ordered[index++]:id);
  mSaveOrder();
}
function mNotify(message:string) { mToast=message; mRender(); if(mToastTimer)clearTimeout(mToastTimer);mToastTimer=setTimeout(()=>{mToast='';const el=document.querySelector('.toast');el?.remove();},3500); }
function mStopAI(){ if(mTimer)clearTimeout(mTimer);mTimer=null;mWorker?.terminate();mWorker=null;if(mWorkerURL)URL.revokeObjectURL(mWorkerURL);mWorkerURL=null;mBusy=false; }
function mActive(){ return !!mGame && !mHandoff && mGame.phase!=='finished' && !mGame.players[mGame.current].isAI; }
function mAdvance(action:Action) {
  if(!mGame)return;
  try {
    const before=mGame.current;
    // 行动前记录包含已打出卡的顺序，休息/打出均不让卡片重排。
    const actor=mGame.players[mGame.current];
    mOrder[actor.id]=visibleOrder([...actor.hand,...actor.played],mOrder[actor.id]||[]);
    mSaveOrder();
    mGame=applyAction(mGame,action);mSheet=null;mExpanded=false;mArrange=false;mFilter='all';
    if(mGame.current!==before && !mGame.players[mGame.current].isAI){
      mOwner=mGame.current;
      mHandoff=mGame.players.filter(p=>!p.isAI).length>1;
    }
    if(mGame.phase==='overflow'&&!mGame.players[mGame.current].isAI)mSheet={kind:'discard',colors:[]};
    mSave();mNotify(mGame.log[0]||'行动完成');
  }catch(e){mNotify(e instanceof Error?e.message:'行动失败');}
}
function mStart(){
  try{
    const names=[...mNames.slice(0,mHumans),...Array.from({length:mBots},(_,i)=>`AI ${i+1}`)];
    const next=createGame(names,undefined,Array.from({length:mBots},(_,i)=>mHumans+i));
    mStopAI();mGame=next;mOwner=0;mHandoff=mHumans===2;mSheet=null;mOrder={};mPaused=false;mExpanded=false;mShownCurrent=-1;mNotice='';mSave();mSaveOrder();mRender();
  }catch(e){mNotify(e instanceof Error?e.message:'无法开始');}
}
function mHome():string {
  return `<main class="home"><header class="home-brand"><span class="eyebrow">CENTURY · GOLEM EDITION</span><h1>晶石回廊<span>每一颗，都有下一步。</span></h1><p>构筑商队，唤醒魔像。<br>一部手机，一场精巧的策略竞速。</p></header><div class="home-crystals">${mGems([1,1,1,1])}</div>${mSaved?`<section class="resume"><div><strong>上次的旅程</strong><p>${mSaved.players.length} 人 · 第 ${mSaved.turnNumber} 手 · ${mSaved.phase==='finished'?'已结算':mEsc(mSaved.players[mSaved.current].name)}</p></div>${mBtn('继续','resume','','primary')}</section>`:''}<section class="setup"><div class="section-title"><h2>开启新旅程</h2><span>本地对局</span></div><div class="setup-counts"><label>真人<select id="humanCount" aria-label="真人数量">${[1,2].map(n=>`<option value="${n}" ${mHumans===n?'selected':''}>${n} 名</option>`).join('')}</select></label><label>AI 对手<select id="botCount" aria-label="AI 数量">${[0,1,2,3,4].map(n=>`<option value="${n}" ${mBots===n?'selected':''}>${n} 名</option>`).join('')}</select></label></div><div class="names">${mNames.slice(0,mHumans).map((n,i)=>`<label>玩家 ${i+1}<input data-name="${i}" aria-label="玩家 ${i+1} 名称" maxlength="20" value="${mEsc(n)}"></label>`).join('')}</div><p class="mode-note ${mHumans+mBots===6?'extension':''}">${mHumans+mBots<2?'至少需要 2 名玩家':mHumans+mBots===6?'非官方六人扩展 · 2 真人 + 4 AI':`${mHumans+mBots} 人 · 正式规则 · ${mHumans+mBots>=4?'5':'6'} 张魔像触发终局`}</p>${mBtn('开始游戏','start',mHumans+mBots<2?'disabled':'','primary wide')}</section><footer>无需账号 · AI 2.0 · 自动保存于本机<br><a href="../">进入电脑桌面版</a> · ${mBtn('玩法速览','help','','text-btn')}<br><small>非官方私人学习项目 · 无跨设备联网</small></footer></main>`;
}
function mHeader():string {
  const g=mGame!, p=g.players[g.current];
  return `<header class="table-header"><div><span class="eyebrow">世纪 · 魔像篇 · 第 ${g.turnNumber} 回合</span><h1><strong class="turn-player" title="${mEsc(p.name)}">${mEsc(p.name)}</strong><span>${g.phase==='finished'?'已结算':p.isAI?(mPaused?'AI 已暂停':'正在行动…'):'的回合'}</span></h1></div>${mBtn('菜单','menu','aria-label="打开游戏菜单"','menu-btn')}</header><nav class="players" aria-label="玩家公开状态">${g.players.map(p=>mBtn(`<strong>${mEsc(p.name)}</strong><span>${score(p)} 分 · ${p.claimed.length} 魔像</span>`,'player',`data-index="${p.id}" aria-current="${p.id===g.current?'true':'false'}"`,p.id===g.current?'player active':'player')).join('')}</nav><div class="turn-line"><span>第 ${g.turnNumber} 手 · ${g.players.length} 人${g.players.length===6?' · 非官方扩展':''}</span><span>${g.triggerPlayer!==null?'最后一轮':`${g.players.length>=4?5:6} 魔像触发终局`}</span></div><section class="caravan" aria-label="当前玩家商队"><div class="caravan-title"><strong>${mEsc(p.name)}的商队</strong><span class="capacity ${count(p.stock)>10?'over':''}">${count(p.stock)} / 10</span><span>铜 ${p.copper} · 银 ${p.silver}</span></div><div class="inventory crystal-strip">${mGems(p.stock)}<span class="vacant-slots" aria-hidden="true">${Array.from({length:Math.max(0,10-count(p.stock))},()=>'<i></i>').join('')}</span></div>${g.phase==='overflow'&&!p.isAI?mBtn(`弃置 ${count(p.stock)-10} 颗，完成回合`,'discard-open','','overflow-resume'):''}</section>`;
}
function mMarkets():string {
  const g=mGame!,p=g.players[g.current];
  return `<main class="markets"><section><div class="section-title"><h2>魔像市场 <small>${g.golemMarket.length}</small></h2><span>铜余 ${g.copper} · 银余 ${g.silver}</span></div><div class="rail golem-rail">${g.golemMarket.map((id,i)=>{const c=GOLEM_BY_ID[id],ready=has(p.stock,c.cost);return `<button type="button" class="card golem ${ready?'claimable':''}" data-action="claim" data-index="${i}" aria-label="${c.points} 分魔像 ${id}，需要 ${readable(c.cost)}，${ready?'可认领':'水晶不足'}"><span class="card-top">${mCoin(i)}<small>${id}</small></span><span class="points">${c.points}<small>分</small></span>${mGems(c.cost)}<span class="card-foot">${ready?'可以认领':'查看需求'}</span></button>`;}).join('')}</div></section><section><div class="section-title"><h2>商人市场 <small>${g.merchantMarket.length}</small></h2><span>全部可见</span></div><div class="rail merchant-rail">${g.merchantMarket.map((m,i)=>mGraphicCard(m.id,'acquire',`data-index="${i}"`,count(m.bonus)?mGems(m.bonus):'')).join('')}</div></section><p class="last-action" aria-live="polite">${mEsc(g.log[0]||'选择一个行动')}</p></main>`;
}
function mHand():string {
  const g=mGame!;
  // 双真人的 AI 回合不显示任何私人手牌；刷新后尚未确认持机者身份。
  if(g.players[g.current].isAI && g.players.filter(p=>!p.isAI).length>1){
    return `<section class="hand-dock waiting-dock" aria-label="私人手牌已隐藏"><div><strong>${g.phase==='finished'?'对局已结算':'AI 回合 · 私人手牌已隐藏'}</strong><p>回到真人回合后，交接确认再查看手牌。</p></div>${g.phase==='finished'?'':mBtn(mPaused?'继续 AI':'暂停 AI','pause')}</section>`;
  }
  const p=g.players[mOwner];
  const order=visibleOrder(p.hand,Array.isArray(mOrder[p.id])?mOrder[p.id]:[]), cards=order.filter(id=>mFilter==='all'||MERCHANT_BY_ID[id].kind===mFilter);
  const active=mActive()&&g.current===mOwner&&g.phase==='turn';
  // 固定十格，已打出的卡保留在原来的排序位置；更多手牌可在展开层访问。
  if (!mExpanded) {
    const all=visibleOrder([...p.hand,...p.played],Array.isArray(mOrder[p.id])?mOrder[p.id]:[]);
    const showing=all.slice(0,10),more=Math.max(0,all.length-10);
    const tiles=showing.map(id=>{
      const played=p.played.includes(id);
      return `<div class="${played?'played-tile':'hand-tile'} tactical-tile" data-card="${id}">${mGraphicCard(id,played?'':'play',`data-id="${id}" ${!active?'disabled':''}`)}</div>`;
    }).join('')+Array.from({length:Math.max(0,10-showing.length)},()=>'<div class="tactical-tile vacant-card" aria-hidden="true"></div>').join('');
    return `<section class="hand-dock tactical-hand" aria-label="个人手牌"><div class="dock-title tactical-head"><div><strong>我的商人卡</strong><small>可打出 ${p.hand.length} · 已打出 ${p.played.length}</small></div>${mBtn(more?`全部 +${more}`:'整理','expand','aria-label="展开全部商人卡及排序"')}${mBtn('已打出','played',`aria-expanded="${mPlayed}"`)}</div><div class="tactical-grid">${tiles}</div><div class="tactical-footer">${mBtn('休息','rest',!active?'disabled':'','primary')}<span>点击卡牌选择行动</span></div>${mPlayed?`<div class="rail played-rail">${p.played.map(id=>mCard(id)).join('')||'<p>尚未打出卡牌</p>'}</div>`:''}</section>`;
  }
  return `<section class="hand-dock ${mExpanded?'expanded':''} ${mArrange?'arranging':''}" aria-label="个人手牌"><div class="dock-grip"></div><div class="dock-title"><button type="button" class="hand-summary" data-action="played" aria-label="${mPlayed?'折叠':'查看'}已打出 ${p.played.length} 张卡牌" aria-expanded="${mPlayed}"><strong>${mEsc(p.name)} · 手牌 ${p.hand.length}</strong><small>${active?(mArrange?'拖动手柄排序':'选牌打出'):g.phase==='finished'?'已结算':'等待行动'} · 已打出 ${p.played.length} 张 ${mPlayed?'▾':'▸'}</small></button>${mBtn(mExpanded?'收起':'展开','expand',`aria-expanded="${mExpanded}"`)}${mBtn('休息','rest',!active?'disabled':'','rest-btn')}</div>${mExpanded?`<div class="hand-controls">${mBtn('全部','filter','data-filter="all" aria-pressed="'+(mFilter==='all')+'"')}${Object.entries(mKinds).map(([kind,label])=>mBtn(label,'filter',`data-filter="${kind}" aria-pressed="${mFilter===kind}"`)).join('')}${mBtn(mArrange?'完成排序':'排序','arrange',`aria-pressed="${mArrange}"`)}</div><div class="sort-tools">${mBtn('按类型整理','group')}${mBtn(mPlayed?`收起已打出 (${p.played.length})`:`查看已打出 (${p.played.length})`,'played',`aria-expanded="${mPlayed}"`)}</div>`:''}<div class="${mExpanded?'hand-grid':'rail hand-rail'}">${cards.map(id=>`<div class="hand-tile" data-card="${id}">${mCard(id,'play',`data-id="${id}" ${!active||mArrange?'disabled':''}`)}${mArrange?`<div class="move-tools">${mBtn('前移','move',`data-id="${id}" data-delta="-1" ${order.indexOf(id)===0?'disabled':''}`)}<button class="drag-handle" type="button" data-drag="${id}" aria-label="拖动 ${id} 排序">拖动</button>${mBtn('后移','move',`data-id="${id}" data-delta="1" ${order.indexOf(id)===order.length-1?'disabled':''}`)}</div>`:''}</div>`).join('')||'<p class="empty-hand">没有可用卡牌，休息后收回。</p>'}</div>${mPlayed?`<div class="rail played-rail">${p.played.map(id=>mCard(id)).join('')||'<p>尚未打出卡牌</p>'}</div>`:''}</section>`;
}
function mDraft(steps:Color[]):Stock {const s=[...mGame!.players[mGame!.current].stock] as Stock;for(const c of steps){s[c]--;s[c+1]++;}return s;}
function mPicker(colors:Color[],limit:number,stock:Stock):string {
  return `<p>已选择 ${colors.length} / ${limit} 颗</p><div class="picker">${stock.map((n,c)=>mBtn(`${mGems(Array.from({length:4},(_,i)=>i===c?1:0) as Stock)}<b>${n-colors.filter(x=>x===c).length}</b>`,'pick',`data-color="${c}" aria-label="选择${mColors[c]}水晶" ${colors.length>=limit||colors.filter(x=>x===c).length>=n?'disabled':''}`)).join('')}</div><div class="selected-gems">${mGems(colors.reduce((s,c)=>{s[c]++;return s;},[0,0,0,0] as Stock))}</div>${mBtn('撤销选择','undo',!colors.length?'disabled':'')}`;
}
function mSheetBody():{title:string;body:string;confirm?:string;disabled?:boolean} {
  const s=mSheet!,g=mGame,p=g?.players[g.current];
  if(s.kind==='help')return {title:'四个行动，一次选择',body:`<div class="help"><p><b>打出</b> 创造水晶、至多逐级升级，或重复交易。</p><p><b>获取</b> 为目标左侧每张卡各放 1 颗任意水晶，拿走目标及其奖励。</p><p><b>休息</b> 花一个回合收回所有已打出卡。</p><p><b>认领</b> 按卡面支付，获得魔像与相应硬币。</p><p>回合结束保留至多 10 颗，自选超额弃置。升级可以中途结束，也可同一颗连续升级。</p><p>2–3 人第 6 张、4–5 人第 5 张魔像触发终局；完成当前整轮后结算。六人为非官方扩展。</p><p>总分 = 魔像分 + 铜币×3 + 银币 + 非黄水晶数；平分时本轮后手胜。</p><p>手牌为私人信息；玩家状态页仅展示水晶、硬币、手牌数量与正面已打出卡。</p></div>`};
  if(s.kind==='menu')return {title:'对局菜单',body:`<div class="menu-list">${mBtn(mPaused?'继续 AI':'暂停 AI','pause')}${mBtn('行动记录','log')}${mBtn('玩法与计分','help')}${mBtn('导出本局备份','export')}${mBtn('返回首页（保留存档）','home')}${mBtn('开始新局','new')}</div><p>手机与电脑存档相互独立。导出的 JSON 可在首页导入。</p>`};
  if(s.kind==='new')return {title:'结束当前旅程？',body:'<p>开始新局会覆盖手机存档。可先取消并从菜单导出备份。</p>',confirm:'结束并配置新局'};
  if(s.kind==='log')return {title:'行动记录',body:`<ol class="game-log">${g!.log.map(l=>`<li>${mEsc(l)}</li>`).join('')}</ol>`};
  if(s.kind==='player'){
    const q=g!.players[s.index];return {title:`${mEsc(q.name)} · 公开信息`,body:`<p>${score(q)} 分（含当前水晶残值） · ${q.claimed.length} 张魔像 · 手牌 ${q.hand.length} 张</p><p>铜币 ${q.copper} · 银币 ${q.silver} · 已行动 ${q.turns} 次</p>${mGems(q.stock)}<h3>已打出的商人卡</h3><div class="public-grid">${q.played.map(id=>mCard(id)).join('')||'暂无'}</div>`};
  }
  if(s.kind==='rest')return {title:'休息，重新出发',body:`<p>收回 ${p!.played.length} 张正面商人卡。本次休息占用一个回合。</p><div class="rail">${p!.played.map(id=>mCard(id)).join('')}</div>`,confirm:'确认休息'};
  if(s.kind==='claim'){
    const c=GOLEM_BY_ID[g!.golemMarket[s.index]],enough=has(p!.stock,c.cost);
    const missing=c.cost.map((n,i)=>Math.max(0,n-p!.stock[i])) as Stock;
    return {title:`认领 ${c.points} 分魔像`,body:`${mCoin(s.index)}<h3>支付这些水晶</h3>${mGems(c.cost)}${enough?`<h3>支付后商队</h3>${mGems(add(p!.stock,c.cost,-1))}`:`<h3>还缺少</h3>${mGems(missing)}`}`,confirm:!mActive()?'等待当前玩家行动':enough?'确认认领':'水晶不足',disabled:!enough||!mActive()||g!.phase!=='turn'};
  }
  if(s.kind==='acquire'){
    const m=g!.merchantMarket[s.index];return {title:s.index?'选择获取费用':'免费获取商人',body:`<div class="preview-card">${mCard(m.id)}</div><p>${count(p!.stock)<s.index?`商队只有 ${count(p!.stock)} 颗，还缺 ${s.index-count(p!.stock)} 颗费用。`:'按选择顺序，向左侧各卡放 1 颗水晶。'}</p>${mPicker(s.colors,s.index,p!.stock)}<h3>同时拿走卡上奖励</h3>${mGems(m.bonus)}`,confirm:'确认获取',disabled:s.colors.length!==s.index};
  }
  if(s.kind==='discard')return {title:`商队超额 · 弃置 ${count(p!.stock)-10} 颗`,body:`<p>行动已执行。请选择要放回的水晶，之后结束回合。</p>${mPicker(s.colors,count(p!.stock)-10,p!.stock)}`,confirm:'确认弃置',disabled:s.colors.length!==count(p!.stock)-10};
  if(s.kind==='play'){
    const c=MERCHANT_BY_ID[s.id];
    if(c.kind==='create')return {title:'创造水晶',body:`<div class="preview-card">${mCard(s.id)}</div><h3>获得后商队</h3>${mGems(add(p!.stock,c.output!))}`,confirm:'确认打出'};
    if(c.kind==='upgrade'){
      const draft=mDraft(s.steps);return {title:`升级 · ${s.steps.length} / ${c.steps} 次`,body:`<p>点选起始颜色，每次升级一级，可连续升级同一颗。</p><div class="picker upgrade-picker">${[0,1,2].map(color=>mBtn(`${mGems(Array.from({length:4},(_,i)=>i===color?1:0) as Stock)}<span>→ ${mColors[color+1]}</span>`,'upgrade',`data-color="${color}" aria-label="升级${mColors[color]}水晶" ${s.steps.length>=c.steps!||!draft[color]?'disabled':''}`)).join('')}</div><h3>升级后的商队</h3>${mGems(draft)}<p>已完成 ${s.steps.length} 次，可随时结束。</p>${mBtn('撤销上一步','undo',s.steps.length?'':'disabled')}`,confirm:`完成 ${s.steps.length} 次升级`};
    }
    const limit=tradeLimit(p!.stock,s.id),result=add(add(p!.stock,c.input!,-s.repeats),c.output!,s.repeats);
    return {title:'连续交易',body:`<div class="preview-card">${mCard(s.id)}</div><div class="stepper">${mBtn('−','minus',s.repeats<=1?'disabled':'','step')}<strong>${s.repeats} 次</strong>${mBtn('+','plus',s.repeats>=limit?'disabled':'','step')}</div><p>当前最多 ${limit} 次</p><h3>交易后商队</h3>${limit?mGems(result):'<p>现有水晶不足以完成一次交易。</p>'}`,confirm:'确认交易',disabled:!limit};
  }
  return {title:'',body:''};
}
function mOverlay():string {
  if(mHandoff && mGame){const p=mGame.players[mGame.current];return `<div class="handoff" role="dialog" aria-modal="true" aria-labelledby="handoff-title"><span class="eyebrow">轮到下一位旅人</span><h2 id="handoff-title">请将手机交给<br>${mEsc(p.name)}</h2><p>私人手牌已遮挡。<br>接过手机后，再查看你的商队。</p>${mBtn('我是 '+mEsc(p.name)+'，开始回合','ready','','primary wide')}</div>`;}
  if(!mSheet)return '';
  const info=mSheetBody();return `<div class="scrim"><section class="action-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1"><div class="sheet-heading"><h2 id="sheet-title">${info.title}</h2>${mBtn(mSheet.kind==='discard'?'稍后':'取消','cancel','aria-label="关闭操作面板"')}</div><div class="sheet-content">${info.body}</div>${info.confirm?`<div class="sheet-footer">${mBtn(info.confirm,'confirm',info.disabled?'disabled':'','primary wide')}</div>`:''}</section></div>`;
}
function mResults():string {
  return `<section class="results"><span class="eyebrow">旅程完成</span><h2>${mEsc(ranking(mGame!)[0].name)} 获胜</h2>${ranking(mGame!).map((p,i)=>`<div class="result-row"><b>${i+1}</b><div><strong>${mEsc(p.name)}</strong><small>魔像 ${p.claimed.reduce((n,id)=>n+GOLEM_BY_ID[id].points,0)} + 铜 ${p.copper*3} + 银 ${p.silver} + 水晶 ${count(p.stock)-p.stock[0]}</small></div><strong>${score(p)} 分</strong></div>`).join('')}<p>平分时本轮后手优先。</p>${mBtn('再来一局','new','','primary')}</section>`;
}
function mRender(){
  // 保留市场/手牌各自的滚动位置，草稿更新不使用户丢失目标。
  if(mSheet||mHandoff||mPaused)mStopAI();
  const positions=[...mRoot.querySelectorAll<HTMLElement>('.rail,.players,.hand-grid,.sheet-content')].map(el=>({key:el.className,x:el.scrollLeft,y:el.scrollTop}));
  const focused=document.activeElement as HTMLElement|null,focusAction=focused?.dataset.action,focusColor=focused?.dataset.color;
  mRoot.innerHTML=mGame?`<div class="game-shell ${mExpanded?'hand-open':''}"><div class="board" ${mHandoff||mSheet?'inert':''}>${mHeader()}${mGame.phase==='finished'?mResults():mMarkets()}${mHandoff?'':mHand()}</div>${mOverlay()}${mToast?`<div class="toast" role="status">${mEsc(mToast)}</div>`:''}${mNotice?`<div class="storage-notice" role="status">${mEsc(mNotice)}</div>`:''}</div>`:`${mHome()}<div class="import-tools">${mBtn('从电脑存档复制','import-desktop')}<label class="import-file">导入备份<input type="file" accept="application/json,.json" id="importSave"></label></div>${mOverlay()}${mToast?`<div class="toast" role="status">${mEsc(mToast)}</div>`:''}${mNotice?`<p class="notice">${mEsc(mNotice)}</p>`:''}`;
  for(const pos of positions){const el=[...mRoot.querySelectorAll<HTMLElement>('.rail,.players,.hand-grid,.sheet-content')].find(el=>el.className===pos.key);if(el){el.scrollLeft=pos.x;el.scrollTop=pos.y;}}
  if(mGame && mShownCurrent!==mGame.current){const rail=mRoot.querySelector<HTMLElement>('.players'),chip=rail?.querySelector<HTMLElement>('[aria-current="true"]');if(rail&&chip)rail.scrollLeft=chip.offsetLeft-rail.offsetLeft;mShownCurrent=mGame.current;}
  if(mSheet||mHandoff){const scope=mRoot.querySelector<HTMLElement>('[role="dialog"]');const same=scope?.querySelector<HTMLElement>(`[data-action="${focusAction}"]${focusColor?`[data-color="${focusColor}"]`:''}`);(same&&!same.hasAttribute('disabled')?same:scope?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({preventScroll:true});}
  mSchedule();
}
function mResume(g:Game){mStopAI();mGame=g;mShownCurrent=-1;mExpanded=false;mArrange=false;mFilter='all';mOwner=g.players[g.current].isAI?g.players.find(p=>!p.isAI)!.id:g.current;mHandoff=g.phase!=='finished'&&!g.players[g.current].isAI&&g.players.filter(p=>!p.isAI).length>1;mSheet=g.phase==='overflow'&&!g.players[g.current].isAI?{kind:'discard',colors:[]}:null;mSave();mRender();}
function mControl(el:HTMLElement){
  const a=el.dataset.action!,i=Number(el.dataset.index),c=Number(el.dataset.color) as Color;
  if(a==='resume'&&mSaved){mResume(mSaved);return;}
  if(a==='start'){if(mSaved&&mSaved.phase!=='finished'){mSheet={kind:'new'};mRender();}else mStart();return;}
  if(a==='help'){mSheet={kind:'help'};mRender();return;}
  if(a==='import-desktop'){try{const g=parseMobileSave(localStorage.getItem(DESKTOP_KEY));if(!g)throw Error('同一来源下未找到兼容的电脑存档');if(mSaved&&!confirm('复制将覆盖手机存档，继续？'))return;mResume(g);}catch(e){mNotify(String(e));}return;}
  if(a==='ready'){mHandoff=false;if(mGame?.phase==='overflow')mSheet={kind:'discard',colors:[]};mRender();return;}
  if(a==='cancel'){mSheet=null;mRender();return;}
  if(a==='confirm'&&mSheet?.kind==='new'){mStopAI();mGame=null;mSaved=null;mSheet=null;mHandoff=false;mRender();return;}
  if(!mGame)return;
  if(a==='discard-open'&&mGame.phase==='overflow'&&mActive()){mSheet={kind:'discard',colors:[]};mRender();return;}
  if(a==='menu'||a==='log'||a==='new'){mSheet={kind:a};mRender();return;}
  if(a==='pause'){mPaused=!mPaused;mStopAI();mSheet=null;mRender();return;}
  if(a==='home'){mStopAI();mSave();mGame=null;mSheet=null;mRender();return;}
  if(a==='export'){const url=URL.createObjectURL(new Blob([JSON.stringify(mGame,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='century-mobile-v2.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
  if(a==='player'){mSheet={kind:'player',index:i};mRender();return;}
  if(mHandoff)return;
  if(a==='expand'){mExpanded=!mExpanded;mArrange=false;mRender();return;}
  if(a==='played'){mPlayed=!mPlayed;mRender();return;}
  if(a==='filter'){mFilter=el.dataset.filter!;mRender();return;}
  if(a==='arrange'){mArrange=!mArrange;mFilter='all';mRender();return;}
  const owner=mGame.players[mOwner];
  if(a==='group'||a==='move'){
    if(a==='group'){
      mOrder[owner.id]=groupOrder([...owner.hand,...owner.played],mOrder[owner.id]||[],id=>MERCHANT_BY_ID[id].kind);mSaveOrder();
    }else{
      const hand=visibleOrder(owner.hand,mOrder[owner.id]||[]);
      mUpdateHandOrder(owner,stepInOrder(hand,hand,el.dataset.id!,Number(el.dataset.delta) as -1|1));
    }
    mRender();return;
  }
  // 公共卡牌在 AI 回合也可查看，但确认行动仅允许当前人类。
  if(a==='claim'){mSheet={kind:'claim',index:i};mRender();return;}
  if(!mActive()){mNotify('请等待当前玩家完成行动');return;}
  if(mGame.phase==='overflow'){
    if(a==='confirm'&&mSheet?.kind==='discard'){mAdvance({type:'discard',colors:mSheet.colors});return;}
    if(!mSheet||mSheet.kind!=='discard'){mSheet={kind:'discard',colors:[]};mRender();return;}
  }
  if(a==='rest'){mSheet={kind:'rest'};mRender();return;}
  if(a==='acquire'){mSheet={kind:'acquire',index:i,colors:[]};mRender();return;}
  if(a==='play'){mSheet={kind:'play',id:el.dataset.id!,steps:[],repeats:1};mRender();return;}
  const s=mSheet;if(!s)return;
  if(a==='pick'&&(s.kind==='acquire'||s.kind==='discard')){const limit=s.kind==='acquire'?s.index:count(mGame.players[mGame.current].stock)-10;if(s.colors.length<limit && s.colors.filter(x=>x===c).length<mGame.players[mGame.current].stock[c])s.colors.push(c);}
  if(a==='upgrade'&&s.kind==='play'){const stock=mDraft(s.steps);if(c<3&&stock[c]>0&&s.steps.length<MERCHANT_BY_ID[s.id].steps!)s.steps.push(c);}
  if(a==='undo'){if(s.kind==='play')s.steps.pop();if(s.kind==='acquire'||s.kind==='discard')s.colors.pop();}
  if(a==='plus'&&s.kind==='play')s.repeats=Math.min(tradeLimit(mGame.players[mGame.current].stock,s.id),s.repeats+1);
  if(a==='minus'&&s.kind==='play')s.repeats=Math.max(1,s.repeats-1);
  if(a==='confirm'){
    if(s.kind==='play'){const kind=MERCHANT_BY_ID[s.id].kind;mAdvance({type:'play',cardId:s.id,...(kind==='trade'?{repeats:s.repeats}:kind==='upgrade'?{steps:s.steps}:{})});return;}
    if(s.kind==='acquire'){mAdvance({type:'acquire',index:s.index,payment:s.colors});return;}
    if(s.kind==='claim'){mAdvance({type:'claim',index:s.index});return;}
    if(s.kind==='rest'){mAdvance({type:'rest'});return;}
  }
  mRender();
}
function mFallbackAI(expected:Game){
  mStopAI();if(mGame!==expected)return;
  try{mAdvance(chooseAIAction(expected).action);}catch(e){mPaused=true;mNotify(`AI 已暂停：${e instanceof Error?e.message:String(e)}`);}
}
function mSchedule(){
  if(document.hidden||!mGame||mGame.phase==='finished'||mHandoff||mSheet||mPaused||!mGame.players[mGame.current].isAI)return;
  if(mBusy)return;mBusy=true;
  const expected=mGame,turn=mGame.turnNumber;
  mTimer=setTimeout(()=>{
    try{
      // WebKit 离线状态可能禁止新建 Blob Worker；兼容路径仍调用同一 AI 2.0。
      if(!navigator.onLine){mFallbackAI(expected);return;}
      const embedded=document.getElementById('offline-worker');
      const url=embedded?URL.createObjectURL(new Blob([embedded.textContent!],{type:'text/javascript'})):document.querySelector<HTMLMetaElement>('meta[name="worker-path"]')!.content;
      if(embedded)mWorkerURL=url;
      mWorker=new Worker(url,{type:embedded?'classic':'module'});
      mWorker.onmessage=event=>{mStopAI();if(mGame!==expected||mGame.turnNumber!==turn)return;if(event.data.error){mPaused=true;mNotify(`AI 已暂停：${event.data.error}`);return;}mAdvance(event.data.action);};
      mWorker.onerror=event=>{event.preventDefault();mFallbackAI(expected);};
      mWorker.postMessage(expected);
    }catch(e){mFallbackAI(expected);}
  },350);
}
mRoot.addEventListener('click',e=>{const el=(e.target as HTMLElement).closest<HTMLElement>('[data-action]');if(el&&!el.hasAttribute('disabled'))mControl(el);});
mRoot.addEventListener('input',e=>{const el=e.target as HTMLInputElement;if(el.dataset.name)mNames[Number(el.dataset.name)]=el.value;});
mRoot.addEventListener('change',async e=>{
  const el=e.target as HTMLInputElement;
  if(el.id==='humanCount'||el.id==='botCount'){mHumans=Number((mRoot.querySelector('#humanCount') as HTMLSelectElement).value);mBots=Number((mRoot.querySelector('#botCount') as HTMLSelectElement).value);mRender();}
  if(el.id==='importSave'&&el.files?.[0]){try{if(el.files[0].size>1000000)throw Error('备份文件过大');const g=parseMobileSave(await el.files[0].text());if(!g)throw Error('空存档');if(mSaved&&!confirm('导入将覆盖手机存档，继续？'))return;mResume(g);}catch(e){mNotify(String(e));}}
});
let mDrag:{id:string;pointer:number;x:number;y:number;target:string|null}|null=null;
mRoot.addEventListener('pointerdown',e=>{const handle=(e.target as HTMLElement).closest<HTMLElement>('[data-drag]');if(!handle||!mArrange||mSheet||mHandoff)return;mDrag={id:handle.dataset.drag!,pointer:e.pointerId,x:e.clientX,y:e.clientY,target:null};handle.setPointerCapture(e.pointerId);});
mRoot.addEventListener('pointermove',e=>{if(!mDrag||e.pointerId!==mDrag.pointer)return;const tile=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-card]');mRoot.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));mDrag.target=null;if(tile&&tile.dataset.card!==mDrag.id){mDrag.target=tile.dataset.card!;tile.classList.add('drop-target');}});
mRoot.addEventListener('pointerup',e=>{if(!mDrag||e.pointerId!==mDrag.pointer)return;const drag=mDrag;mDrag=null;if(drag.target&&mGame){const p=mGame.players[mOwner];const order=visibleOrder(p.hand,mOrder[p.id]||[]),from=order.indexOf(drag.id),to=order.indexOf(drag.target);if(from>=0&&to>=0){order.splice(from,1);order.splice(to,0,drag.id);mUpdateHandOrder(p,order);}}mRender();});
mRoot.addEventListener('pointercancel',()=>{mDrag=null;mRoot.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));});
document.addEventListener('keydown',e=>{if(!(mSheet||mHandoff))return;if(e.key==='Escape'&&!mHandoff){mSheet=null;mRender();}if(e.key==='Tab'){const buttons=[...mRoot.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled),[role="dialog"] a[href]')];const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
// 切到后台即遮挡双真人手牌；任何恢复都需要本人确认。
document.addEventListener('visibilitychange',()=>{if(document.hidden){mStopAI();if(mGame&&mGame.phase!=='finished'&&!mGame.players[mGame.current].isAI&&mGame.players.filter(p=>!p.isAI).length>1){mHandoff=true;mRender();}}else mRender();});
mRender();
