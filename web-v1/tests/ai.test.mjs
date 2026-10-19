import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, count } from '../dist/js/engine.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
import { chooseAIAction } from '../dist/js/ai.js';

const gameWithBots = (bots, seed=42) => createGame(['人类', ...Array.from({length:bots},(_,i)=>`AI${i+1}`)], seed, Array.from({length:bots},(_,i)=>i+1));

test('1 名人类可以选择 1–4 名 AI；0 AI 保持传统双人模式', () => {
  for(let bots=1;bots<=4;bots++) {
    const g=gameWithBots(bots);
    assert.equal(g.players.length, 1+bots);
    assert.equal(g.players.filter(p=>p.isAI).length, bots);
    assert.equal(g.players[0].isAI, false);
    assert.equal(g.copper, 2*(1+bots));
  }
  const zero=createGame(['玩家1','玩家2'],42,[]);
  assert.equal(zero.players.filter(p=>p.isAI).length, 0);
  assert.throws(()=>createGame(['人类'],42,[]),/2–6/);
  assert.throws(()=>createGame(['A','B'],42,[0,1]),/至少有 1 名/);
  assert.throws(()=>createGame(['A','B'],42,[1,1]),/AI 席位/);
});

test('AI 必须是当前行动玩家，决策不得修改原局面', () => {
  const g=gameWithBots(1);
  assert.throws(()=>chooseAIAction(g),/不是 AI/);
  const aiTurn=applyAction(g,{type:'play',cardId:'S01'});
  const old=JSON.stringify(aiTurn);
  const {action}=chooseAIAction(aiTurn);
  assert.equal(JSON.stringify(aiTurn),old);
  const after=applyAction(aiTurn,action);
  assert.equal(after.turnNumber,3);
});

test('AI 超额弃置能精确满足 10 颗限制', () => {
  const g=gameWithBots(1);
  g.current=1;
  g.phase='overflow';
  g.players[1].stock=[6,4,3,2];
  const ai=chooseAIAction(g);
  assert.equal(ai.action.type,'discard');
  assert.equal(ai.action.colors.length,5);
  const next=applyAction(g,ai.action);
  assert.equal(count(next.players[1].stock),10);
});

test('AI 能在可认领时优先认领魔像', () => {
  const g=gameWithBots(1);
  g.current=1;
  const firstCost = g.golemMarket[0];
  // 给 AI 恰好符合市场第一张魔像的水晶，其他必须支付条件由引擎核验。
  g.players[1].stock = [...GOLEM_BY_ID[firstCost].cost];
  const choice=chooseAIAction(g);
  assert.equal(choice.action.type,'claim');
  const after=applyAction(g,choice.action);
  assert.equal(after.players[1].claimed.length,1);
});

test('所有 1–4 AI 人数组合能持续合法行动并完成整局', () => {
  for(let bots=1;bots<=4;bots++) {
    for(let seed=1;seed<=16;seed++) {
      let g=gameWithBots(bots,seed);
      // 测试全程自动行动：临时把人类座位当作自动测试玩家，不改变产品规则。
      g.players[0].isAI = true;
      let turns=0;
      while(g.phase!=='finished' && turns<550) {
        const c=chooseAIAction(g);
        g=applyAction(g,c.action);
        turns++;
      }
      assert.equal(g.phase,'finished',`bots=${bots}, seed=${seed}, turns=${turns}, score=${g.players.map(p=>p.claimed.length)}`);
      assert.equal(new Set(g.players.map(p=>p.turns)).size,1);
      assert.ok(g.players.every(p=>count(p.stock)<=10));
    }
  }
});
