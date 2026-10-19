// @ts-nocheck
/** 离线启发式 AI。候选动作须通过 applyAction 模拟，不读取隐藏牌库顺序。 */
import { GOLEM_BY_ID, MERCHANT_BY_ID } from './data.js';
import { applyAction, count, has, tradeLimit } from './engine.js';

const COLORS=[0,1,2,3];
const VALUES=[1,1.5,2.05,2.65];
const weighted=stock=>stock.reduce((s,n,i)=>s+n*VALUES[i],0);

function targetValue(g,stock){
  if(!g.golemMarket.length)return 0;
  return Math.max(...g.golemMarket.map((id,i)=>{
    const card=GOLEM_BY_ID[id];
    const shortage=card.cost.reduce((s,n,k)=>s+Math.max(0,n-stock[k])*VALUES[k],0);
    const matched=card.cost.reduce((s,n,k)=>s+Math.min(n,stock[k])*VALUES[k],0);
    return card.points*.24+matched*.12+(i===0&&g.copper?1.3:0)-shortage*1.33;
  }));
}
const fitness=(g,stock)=>targetValue(g,stock)+weighted(stock)*.10-Math.max(0,count(stock)-10)*3;

function chooseDiscard(g){
  const stock=[...g.players[g.current].stock],picked=[];
  while(count(stock)>10){
    let color=-1,best=-Infinity;
    for(const c of COLORS){
      if(stock[c]===0)continue;
      stock[c]--;const value=fitness(g,stock);stock[c]++;
      if(value>best){color=c;best=value;}
    }
    if(color<0)throw Error('无法弃置超额水晶');
    stock[color]--;picked.push(color);
  }
  return picked;
}
function paymentVariants(stock,n){
  const result=[];
  const search=(color,left,selected)=>{
    if(color===4){if(left===0)result.push(selected);return;}
    for(let k=0;k<=Math.min(left,stock[color]);k++)
      search(color+1,left-k,selected.concat(Array(k).fill(color)));
  };
  search(0,n,[]);
  return result;
}
function upgradeVariants(stock,max){
  const result=[];
  const search=(s,steps)=>{
    if(steps.length)result.push(steps);
    if(steps.length===max)return;
    for(const c of [0,1,2]){
      if(!s[c])continue;
      const next=[...s];next[c]--;next[c+1]++;
      search(next,steps.concat(c));
    }
  };
  search([...stock],[]);
  return result;
}
function engineStrength(card,stock){
  if(card.kind==='create')return weighted(card.output)*.7;
  if(card.kind==='upgrade')return card.steps*1.24;
  return Math.max(0,weighted(card.output)-weighted(card.input))*.65+1+(has(stock,card.input)?.45:0);
}
export function chooseAIAction(game){
  const g=game;
  if(g.phase==='finished')throw Error('游戏结束，AI 无法行动');
  const p=g.players[g.current];
  if(!p?.isAI)throw Error('当前行动者不是 AI');
  if(g.phase==='overflow')return {action:{type:'discard',colors:chooseDiscard(g)},reason:'弃置超额水晶'};
  const canClaim=g.golemMarket.flatMap((id,index)=>{
    const c=GOLEM_BY_ID[id];
    if(!has(p.stock,c.cost))return [];
    const coin=index===0?(g.copper?3:g.silver?1:0):index===1&&g.silver&&g.copper?1:0;
    return [{index,quality:c.points+coin*1.6}];
  });
  if(canClaim.length){
    canClaim.sort((a,b)=>b.quality-a.quality);
    return {action:{type:'claim',index:canClaim[0].index},reason:'认领魔像'};
  }
  const candidates=[],before=fitness(g,p.stock);
  const offer=(action,bonus,reason)=>{
    try{
      let sim=applyAction(g,action);
      if(sim.phase==='overflow')sim=applyAction(sim,{type:'discard',colors:chooseDiscard(sim)});
      const next=sim.players[g.current];
      let value=fitness(g,next.stock)-before+bonus;
      if(action.type==='acquire')value-=Math.max(0,next.hand.length+next.played.length-6)*.6;
      candidates.push({action,value,reason});
    }catch{}
  };
  for(const id of p.hand){
    const card=MERCHANT_BY_ID[id];
    if(!card)continue;
    if(card.kind==='create')offer({type:'play',cardId:id},.34,'创造水晶');
    else if(card.kind==='upgrade'){
      for(const steps of upgradeVariants(p.stock,card.steps))
        offer({type:'play',cardId:id,steps},.3+steps.length*.17,'升级水晶');
    }else{
      for(let repeats=1;repeats<=tradeLimit(p.stock,id);repeats++)
        offer({type:'play',cardId:id,repeats},.4,'交易水晶');
    }
  }
  if(g.triggerPlayer===null&&p.hand.length+p.played.length<9){
    const stage=Math.max(.04,1-p.turns/18);
    g.merchantMarket.forEach((m,index)=>{
      if(index>count(p.stock))return;
      const card=MERCHANT_BY_ID[m.id];
      const bonus=engineStrength(card,p.stock)*stage-index*.05;
      for(const payment of paymentVariants(p.stock,index))
        offer({type:'acquire',index,payment},bonus,'获取商人卡');
    });
  }
  const reclaim=p.played.reduce((s,id)=>s+engineStrength(MERCHANT_BY_ID[id],p.stock),0);
  offer({type:'rest'},p.played.length?.22+Math.min(2.6,reclaim*.23):-2,'休息取回卡牌');
  candidates.sort((a,b)=>b.value-a.value);
  if(!candidates.length)throw Error('AI 无法选择合法行动');
  return {action:candidates[0].action,reason:candidates[0].reason};
}
