import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, count } from '../dist/js/engine.js';
import { MERCHANT_BY_ID, MERCHANT_DECK, GOLEM_DECK } from '../dist/js/data.js';
import { chooseAIAction } from '../dist/js/ai.js';

const duelWithAI=(bots,seed=99)=>createGame(['玩家 1','玩家 2',...Array.from({length:bots},(_,i)=>`AI ${i+1}`)],seed,Array.from({length:bots},(_,i)=>i+2));
test('2 位真人 + 1–4 AI：真人索引固定在左右座次（0、1）',()=>{
  for(let n=1;n<=4;n++) {
    const game=duelWithAI(n);
    assert.equal(game.players.length,n+2);
    assert.deepEqual(game.players.map(p=>!!p.isAI),[false,false,...Array(n).fill(true)]);
    assert.equal(game.players[0].id,0);
    assert.equal(game.players[1].id,1);
    assert.equal(game.copper,2*(n+2));
    assert.equal(game.silver,2*(n+2));
  }
});
test('6 人为非官方 2 真人 + 4 AI 扩展，其它 6 人混搭被拒绝',()=>{
  const g=duelWithAI(4);
  assert.deepEqual(g.players[5].stock,[3,1,0,0]);
  assert.deepEqual(g.players[5].hand,['S6C','S6U']);
  assert.equal(MERCHANT_BY_ID.S6C.kind,'create');
  assert.equal(MERCHANT_BY_ID.S6U.kind,'upgrade');
  assert.equal(MERCHANT_DECK.length,43);
  assert.equal(GOLEM_DECK.length,36);
  assert.throws(()=>createGame(['a','b','c','d','e','f'],42,[1,2,3,4]),/六人扩展/);
  assert.throws(()=>createGame(['a','b','c','d','e','f'],42,[]),/六人扩展/);
});
test('六人循环保持回合顺序、先后手一致与终局整轮公平',()=>{
  let g=duelWithAI(4);
  for(let i=0;i<6;i++) {
    assert.equal(g.current,i);
    g=applyAction(g,{type:'rest'});
  }
  assert.equal(g.current,0);
  assert.ok(g.players.every(p=>p.turns===1));
  g.current=2;
  g.players.forEach((p,i)=>p.turns=i<2 ? 6 : 5);
  g.players[2].claimed=GOLEM_DECK.slice(0,4).map(x=>x.id);
  g.players[2].stock=[...GOLEM_DECK.find(x=>x.id===g.golemMarket[0]).cost];
  g=applyAction(g,{type:'claim',index:0});
  assert.equal(g.triggerPlayer,2);
  assert.equal(g.current,3);
  while(g.phase!=='finished') g=applyAction(g,{type:'rest'});
  assert.deepEqual(g.players.map(p=>p.turns),[6,6,6,6,6,6]);
});
test('2 人类 + 4 AI：60 组全自动合法行动可正常触发终局',()=>{
  for(let seed=1;seed<=60;seed++) {
    let g=duelWithAI(4,seed);
    g.players[0].isAI=true;g.players[1].isAI=true;
    let steps=0;
    while(g.phase!=='finished' && steps<750) {
      g=applyAction(g,chooseAIAction(g).action);
      steps++;
    }
    assert.equal(g.phase,'finished',`seed=${seed} steps=${steps}`);
    assert.equal(new Set(g.players.map(p=>p.turns)).size,1);
    assert.ok(g.players.every(p=>count(p.stock)<=10));
  }
});
