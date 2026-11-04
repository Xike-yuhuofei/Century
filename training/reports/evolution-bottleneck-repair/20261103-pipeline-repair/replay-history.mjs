import {readFileSync,writeFileSync} from 'node:fs';
import {decideNextResearch,summarizeTrend} from '../../../evolution/research-orchestrator.mjs';
const state=JSON.parse(readFileSync(new URL('../../../reports/coevolution/ai11-6h-v4/state.json',import.meta.url)));
const candidates=new Map(state.rounds.flatMap(r=>r.candidates).map(c=>[c.candidateId,c]));
const history=[]; const rows=[]; const lost=[];
for(const r of state.rounds){
 const llm=r.candidates.filter(c=>c.strategy==='openevolve');
 for(const c of llm){const p=candidates.get(c.parentId); if(p){const missing=p.modules.filter(m=>!c.modules.includes(m));if(missing.length)lost.push({round:r.round,id:c.candidateId,parent:c.parentId,missing});}}
 const eligible=r.candidates.filter(c=>r.selectedIds.includes(c.candidateId)&&c.quick?.score);
 const old=[...eligible].sort((a,b)=>b.quick.score.composite-a.quick.score.composite)[0];
 const next=[...eligible].filter(c=>c.strategy!=='control').sort((a,b)=>(b.quick.score.rankKey??-9)-(a.quick.score.rankKey??-9))[0];
 const plan=decideNextResearch({trend:summarizeTrend(history),modules:Array.from({length:11},(_,i)=>`M${String(i+1).padStart(2,'0')}`),hasElites:r.round>1,memory:{positiveModules:[]}});
 rows.push({round:r.round,oldDecision:r.researchPlan?.decision,oldStrategies:r.researchPlan?.strategies,newDecision:plan.decision,newStrategies:plan.strategies,oldDeep:old?.candidateId,newDeep:next?.candidateId,controlWasFirst:old?.strategy==='control',orderChanged:old?.candidateId!==next?.candidateId});
 const best=r.candidates.filter(c=>c.deep?.status==='done').sort((a,b)=>(b.deep.metrics.firstPlaceLower??-9)-(a.deep.metrics.firstPlaceLower??-9))[0];if(best)history.push({delta:best.deep.metrics.firstPlaceDelta});
}
const report={historicalCodeVersion:state.codeVersion,disclaimer:'静态重排，不推断未执行候选的胜负；新策略输入固定无正向已验证模块、精英从第二轮存在。',rounds:rows.length,llmCandidates:[...candidates.values()].filter(c=>c.strategy==='openevolve').length,lost,oldAblateRounds:rows.filter(r=>r.oldDecision==='ablate').length,changedDeep:rows.filter(r=>r.orderChanged).length,controlFirst:rows.filter(r=>r.controlWasFirst).length,rows};
writeFileSync(new URL('./history-replay.json',import.meta.url),JSON.stringify(report,null,2));console.log({rounds:report.rounds,llm:report.llmCandidates,lost:lost.length,ablate:report.oldAblateRounds,changedDeep:report.changedDeep,controlFirst:report.controlFirst});
