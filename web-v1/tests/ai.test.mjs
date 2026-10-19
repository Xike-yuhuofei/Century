import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, count } from '../dist/js/engine.js';
import { chooseAIAction } from '../dist/js/ai.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
const make=(bots,seed=42)=>createGame(['人类',...Array.from({length:bots},(_,i)=>'AI'+(i+1))],seed,Array.from({length:bots},(_,i)=>i+1));
test('支持 1–4 位 AI 且必须至少 1 名人类',()=>{
 for(let bots=1;bots<=4;bots++){const g=make(bots);assert.equal(g.players.filter(p=>p.isAI).length,bots);}
 const traditional=createGame(['甲','乙'],42,[]);
 assert.equal(traditional.players.some(p=>p.isAI),false);
 assert.throws(()=>createGame(['甲','乙'],42,[0,1]),/至少 1 名人类/);
 assert.throws(()=>createGame(['甲','乙'],42,[1,1]),/参数无效/);
});
test('AI 决策不应直接修改原始状态',()=>{
 const g=make(1);
 const next=applyAction(g,{type:'play',cardId:'S1C'});
 const snapshot=JSON.stringify(next);
 const choice=chooseAIAction(next);
 assert.equal(JSON.stringify(next),snapshot);
 assert.doesNotThrow(()=>applyAction(next,choice.action));
});
test('AI 超额水晶必须弃置到十颗',()=>{
 const g=make(1);
 g.current=1;g.phase='overflow';g.players[1].stock=[6,4,3,2];
 const action=chooseAIAction(g).action;
 assert.equal(action.type,'discard');assert.equal(action.colors.length,5);
 const after=applyAction(g,action);
 assert.equal(count(after.players[1].stock),10);
});
test('AI 优先认领能支付的魔像',()=>{
 const g=make(1);g.current=1;
 g.players[1].stock=[...GOLEM_BY_ID[g.golemMarket[0]].cost];
 const choice=chooseAIAction(g);
 assert.equal(choice.action.type,'claim');
 assert.equal(applyAction(g,choice.action).players[1].claimed.length,1);
});
test('AI 在不同人数下可连续执行合法动作直到整局完成',()=>{
 for(let bots=1;bots<=4;bots++){
  for(let seed=1;seed<=8;seed++){
   let g=make(bots,seed);
   g.players[0].isAI=true; // 自动对局压力测试，正式对局至少一名人类
   let n=0;
   for(;n<650&&g.phase!=='finished';n++){
     const choice=chooseAIAction(g);
     g=applyAction(g,choice.action);
   }
   assert.equal(g.phase,'finished',`人数${bots+1}，牌序${seed}，迭代${n}`);
   assert.ok(g.players.every(p=>count(p.stock)<=10));
  }
 }
});
