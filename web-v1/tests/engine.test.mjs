import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, score, ranking, tradeLimit, count, has } from '../dist/js/engine.js';
import { STARTER_CARDS, MERCHANT_DECK, GOLEM_DECK, MERCHANT_BY_ID, GOLEM_BY_ID } from '../dist/js/data.js';

const make = (n = 2) => createGame(Array.from({length:n},(_,i)=>`玩家${i+1}`),12345);
const copy = x => JSON.parse(JSON.stringify(x));
function moveTo(g,index){g.current=index;return g;}

test('89 张牌结构正确，魔像分值由水晶费用核算', () => {
  assert.equal(STARTER_CARDS.length,10);
  assert.equal(MERCHANT_DECK.length,43);
  assert.equal(GOLEM_DECK.length,36);
  assert.equal(MERCHANT_DECK.filter(x=>x.kind==='trade').length,34);
  assert.equal(MERCHANT_DECK.filter(x=>x.kind==='create').length,8);
  assert.equal(MERCHANT_DECK.filter(x=>x.kind==='upgrade').length,1);
  assert.equal(new Set([...STARTER_CARDS,...MERCHANT_DECK].map(x=>x.id)).size,45);
  assert.deepEqual(STARTER_CARDS.map(x=>x.id).sort(),[...Array(5).fill('S01'),...Array(5).fill('S02')]);
  assert.equal(new Set(GOLEM_DECK.map(x=>x.id)).size,36);
  assert.equal(MERCHANT_DECK.some(x=>x.kind==='trade' && String(x.input)==='0,0,0,1' && String(x.output)==='0,2,0,0'),false);
});

test('开局 2–5 人，第一轮商队和市场配置正确',()=>{
  for(let n=2;n<=5;n++){
    const g=make(n);
    assert.deepEqual(g.players.map(x=>x.stock), [[3,0,0,0],[4,0,0,0],[4,0,0,0],[3,1,0,0],[3,1,0,0]].slice(0,n));
    assert.equal(g.merchantMarket.length,6);
    assert.equal(g.golemMarket.length,5);
    assert.equal(g.merchantDeck.length,37);
    assert.equal(g.golemDeck.length,31);
    assert.equal(g.copper,n*2); assert.equal(g.silver,n*2);
    assert.equal(g.players.every(p=>p.hand.length===2),true);
  }
  assert.deepEqual(make(4).merchantMarket.map(x=>x.id),make(4).merchantMarket.map(x=>x.id));
  assert.throws(()=>createGame(['甲']),/人数/);
  assert.throws(()=>createGame(['甲','']),/姓名/);
});

test('玩家每回合打出一次创造卡，卡牌进入已打出区且推进到下一玩家',()=>{
  const before=make();
  const after=applyAction(before,{type:'play',cardId:'S01'});
  assert.deepEqual(before.players[0].stock,[3,0,0,0]);
  assert.deepEqual(after.players[0].stock,[5,0,0,0]);
  assert.deepEqual(after.players[0].played,['S01']);
  assert.deepEqual(after.players[0].hand,['S02']);
  assert.equal(after.players[0].turns,1);
  assert.equal(after.current,1);
  assert.throws(()=>applyAction(moveTo(copy(after),0),{type:'play',cardId:'S01'}),/只能打出/);
});

test('升级卡可以同一颗黄→绿→蓝、可以不使用满额',()=>{
  let g=make();
  g=applyAction(g,{type:'play',cardId:'S02',steps:[0,1]});
  assert.deepEqual(g.players[0].stock,[2,0,1,0]);
  assert.throws(()=>applyAction(moveTo(copy(g),1),{type:'play',cardId:'S02',steps:[0,1,2]}),/最多升级/);
  const before=make();
  const zero=applyAction(before,{type:'play',cardId:'S02',steps:[]});
  assert.deepEqual(zero.players[0].stock,[3,0,0,0]);
  assert.throws(()=>applyAction(make(),{type:'play',cardId:'S02',steps:[2]}),/没有可升级/);
});

test('交易卡可以重复交易，必须每次都支付足够水晶',()=>{
  const g=make();
  const card=MERCHANT_DECK.find(x=>x.kind==='trade' && String(x.input)==='2,0,0,0' && String(x.output)==='0,2,0,0');
  assert.ok(card);
  g.players[0].hand.push(card.id);
  g.players[0].stock=[6,0,0,0];
  assert.equal(tradeLimit(g.players[0].stock,card.id),3);
  const result=applyAction(g,{type:'play',cardId:card.id,repeats:3});
  assert.deepEqual(result.players[0].stock,[0,6,0,0]);
  assert.throws(()=>applyAction(g,{type:'play',cardId:card.id,repeats:4}),/水晶不足/);
  assert.deepEqual(g.players[0].stock,[6,0,0,0]);
});

test('获取卡需向左侧逐张压入水晶，并取走目标卡累计奖励',()=>{
  let g=make();
  const initialTarget=g.merchantMarket[2].id;
  g.merchantMarket[2].bonus=[0,1,1,0];
  const nextCard=g.merchantMarket[3].id;
  g=applyAction(g,{type:'acquire',index:2,payment:[0,0]});
  assert.equal(g.players[0].hand.includes(initialTarget),true);
  assert.deepEqual(g.players[0].stock,[1,1,1,0]);
  assert.deepEqual(g.merchantMarket[0].bonus,[1,0,0,0]);
  assert.deepEqual(g.merchantMarket[1].bonus,[1,0,0,0]);
  assert.equal(g.merchantMarket[2].id,nextCard);
  assert.throws(()=>applyAction(make(),{type:'acquire',index:3,payment:[0,0]}),/需要支付/);
});

test('上限只在回合结束检查，需精确弃置后才能推进',()=>{
  const g=make(); g.players[0].stock=[10,0,0,0];
  const over=applyAction(g,{type:'play',cardId:'S01'});
  assert.equal(count(over.players[0].stock),12);
  assert.equal(over.current,0);
  assert.equal(over.phase,'overflow');
  assert.throws(()=>applyAction(over,{type:'rest'}),/先弃置/);
  assert.throws(()=>applyAction(over,{type:'discard',colors:[0]}),/恰好 2/);
  const after=applyAction(over,{type:'discard',colors:[0,0]});
  assert.equal(after.current,1);
  assert.deepEqual(after.players[0].stock,[10,0,0,0]);
  assert.equal(after.players[0].turns,1);
});

test('认领精准支付，铜银币位置及铜币耗尽后前移正确',()=>{
  const g=make();
  const first=GOLEM_BY_ID[g.golemMarket[0]];
  g.players[0].stock=[...first.cost];
  const after=applyAction(g,{type:'claim',index:0});
  assert.deepEqual(after.players[0].stock,[0,0,0,0]);
  assert.equal(after.players[0].copper,1);
  assert.equal(after.copper,g.copper-1);
  assert.equal(score(after.players[0]),first.points+3);
  const b=make();
  const second=GOLEM_BY_ID[b.golemMarket[1]];
  b.players[0].stock=[...second.cost];
  const afterSecond=applyAction(b,{type:'claim',index:1});
  assert.equal(afterSecond.players[0].silver,1);
  const depleted=make();
  depleted.copper=0;
  depleted.players[0].stock=[...GOLEM_BY_ID[depleted.golemMarket[0]].cost];
  const changed=applyAction(depleted,{type:'claim',index:0});
  assert.equal(changed.players[0].silver,1);
  assert.equal(changed.silver,depleted.silver-1);
  assert.throws(()=>applyAction(make(),{type:'claim',index:0}),/不足/);
});

test('休息收回全部已打出卡并消费一回合',()=>{
  const g=make(); g.players[0].hand=[]; g.players[0].played=['S01','S02'];
  const after=applyAction(g,{type:'rest'});
  assert.deepEqual(after.players[0].hand,['S01','S02']);
  assert.deepEqual(after.players[0].played,[]);
  assert.equal(after.current,1);
});

test('终局在当前整轮结束后结算，确保各玩家行动回合数相同',()=>{
  for(const n of [3,4]) {
    let g=make(n);
    // 模拟第二位玩家刚认领终局卡：先手此前已完成本轮行动。
    g.current=1;
    g.players.forEach((p,i)=>p.turns=i===0 ? 5:4);
    const target=n>=4?5:6;
    g.players[1].claimed=GOLEM_DECK.slice(0,target-1).map(x=>x.id);
    g.players[1].stock=[...GOLEM_BY_ID[g.golemMarket[0]].cost];
    g=applyAction(g,{type:'claim',index:0});
    assert.equal(g.triggerPlayer,1);
    assert.equal(g.phase,'turn');
    assert.equal(g.current,2);
    while(g.phase!=='finished') g=applyAction(g,{type:'rest'});
    assert.deepEqual(g.players.map(p=>p.turns),new Array(n).fill(5));
    assert.equal(g.current,n-1);
    assert.throws(()=>applyAction(g,{type:'rest'}),/已经结束/);
  }
});

test('最终计分包含魔像、铜币、银币、非黄水晶；同分后手胜出',()=>{
  const g=make();
  g.players[0].claimed=[GOLEM_DECK[0].id];
  g.players[0].copper=2;
  g.players[0].silver=1;
  g.players[0].stock=[7,1,1,1];
  assert.equal(score(g.players[0]),GOLEM_DECK[0].points+6+1+3);
  g.players[1].claimed=[];g.players[1].stock=[0,0,0,0];g.players[1].copper=0;
  assert.equal(ranking(g)[0].id,0);
  g.players[0].claimed=[];g.players[0].copper=0;g.players[0].silver=0;g.players[0].stock=[3,0,0,0];
  assert.equal(ranking(g)[0].id,1);
});

test('牌库存量守恒：获取/打出/休息仍保证所有可用卡牌唯一',()=>{
  let g=make();
  for(let k=0;k<8;k++) {
    const p=g.players[g.current];
    if(k%3===0)g=applyAction(g,{type:'acquire',index:0,payment:[]});
    else if(p.hand.some(id=>MERCHANT_BY_ID[id].kind==='create')) {
      const id=p.hand.find(id=>MERCHANT_BY_ID[id].kind==='create');
      g=applyAction(g,{type:'play',cardId:id});
    } else g=applyAction(g,{type:'rest'});
    if(g.phase==='overflow') {
      const xs=[];
      while(xs.length<count(g.players[g.current].stock)-10)xs.push(0);
      g=applyAction(g,{type:'discard',colors:xs});
    }
  }
  const merchantIds=[...g.merchantDeck,...g.merchantMarket.map(m=>m.id),...g.players.flatMap(p=>[...p.hand,...p.played].filter(id=>id.startsWith('M')))];
  assert.equal(merchantIds.length,43);
  assert.equal(new Set(merchantIds).size,43);
  g.players.forEach(p=>assert.deepEqual([...p.hand,...p.played].filter(id=>id.startsWith('S')).sort(),['S01','S02']));
  const golemCardIds=[...g.golemDeck,...g.golemMarket,...g.players.flatMap(p=>p.claimed)];
  assert.equal(golemCardIds.length,36);
  assert.equal(new Set(golemCardIds).size,36);
});

test('M29 与核校卡表一致：黄×4 → 蓝×2',()=>{
  const card=MERCHANT_BY_ID.M29;
  assert.equal(card.kind,'trade');
  assert.deepEqual(card.input,[4,0,0,0]);
  assert.deepEqual(card.output,[0,0,2,0]);
  const g=make();g.players[0].hand.push('M29');g.players[0].stock=[4,0,0,0];
  const after=applyAction(g,{type:'play',cardId:'M29',repeats:1});
  assert.deepEqual(after.players[0].stock,[0,0,2,0]);
  assert.deepEqual(after.players[0].played,['M29']);
});