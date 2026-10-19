import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction } from '../dist/js/ai.js';

function scenario({ stock=[4,0,0,0], hand=['M20','M23','S01','S02'], played=[] } = {}) {
  const g=createGame(['人类','AI'],20261019,[1]);
  g.current=1;
  const wanted=['G14','G03','G09','G18','G04'];
  const fullGolems=[...g.golemMarket,...g.golemDeck];
  g.golemMarket=wanted;
  g.golemDeck=fullGolems.filter(id=>!wanted.includes(id));
  const wantedMerchants=[...new Set([...hand,...played])].filter(id=>id.startsWith('M'));
  const fullMerchants=[...g.merchantMarket.map(m=>m.id),...g.merchantDeck];
  const remaining=fullMerchants.filter(id=>!wantedMerchants.includes(id));
  g.merchantMarket=remaining.slice(0,6).map(id=>({id,bonus:[0,0,0,0]}));
  g.merchantDeck=remaining.slice(6);
  Object.assign(g.players[1],{stock,hand,played});
  return g;
}

test('V2.0 发现两张真实交易卡的三步认领路线',()=>{
  const g=scenario();
  const before=JSON.stringify(g);
  const {action,plan}=chooseAIAction(g);
  assert.deepEqual(action,{type:'play',cardId:'M20',repeats:2});
  assert.equal(plan.goal,'G14');
  assert.equal(plan.steps,3);
  assert.deepEqual(plan.actions,[
    {type:'play',cardId:'M20',repeats:2},
    {type:'play',cardId:'M23',repeats:2},
    {type:'claim',index:0},
  ]);
  assert.equal(JSON.stringify(g),before);
  let sim=g;
  for(const move of plan.actions){
    sim=applyAction(sim,move);
    if(sim.phase!=='finished')sim.current=1;
  }
  assert.ok(sim.players[1].claimed.includes('G14'));
});

test('V2.0 将休息回合计入认领路线',()=>{
  const g=scenario({hand:[],played:['M20','M23']});
  const chosen=chooseAIAction(g);
  assert.deepEqual(chosen.action,{type:'rest'});
  assert.equal(chosen.plan.goal,'G14');
  assert.equal(chosen.plan.steps,4);
});

test('更换隐藏牌库顺序不改变离线 AI 首步',()=>{
  const a=scenario();
  const b=structuredClone(a);
  b.merchantDeck.reverse();
  b.golemDeck.reverse();
  assert.deepEqual(chooseAIAction(a).action,chooseAIAction(b).action);
});

test('终局轮次不规划不存在的后续回合',()=>{
  const g=scenario({stock:[0,0,4,0]});
  g.triggerPlayer=0;
  const chosen=chooseAIAction(g);
  assert.deepEqual(chosen.action,{type:'claim',index:0});
  assert.equal(chosen.plan.steps,1);
});
