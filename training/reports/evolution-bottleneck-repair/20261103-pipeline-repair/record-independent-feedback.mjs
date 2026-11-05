import {readFileSync,writeFileSync} from 'node:fs';
import {ArtifactStore} from '../../../evolution/artifact-store.mjs';
import {openResearchMemory} from '../../../evolution/research-memory.mjs';
const dir=import.meta.dirname,e=JSON.parse(readFileSync(`${dir}/confirmation-independent-replication.json`));
const store=new ArtifactStore({root:`${dir}/confirmation/artifacts`}),artifact=store.get(e.candidateId);
const memory=openResearchMemory({path:`${dir}/confirmation/research-memory.jsonl`});
const actual=new Set([...(artifact.lineage.modulesChanged??[]),...(artifact.lineage.modulesRemoved??[])]);
const hypotheses=memory.readAll().filter(x=>x.kind==='hypothesis'&&x.moduleScope.some(id=>actual.has(id)));
const evidenceRef='confirmation-independent-replication.json',existing=memory.readAll();
for(const h of hypotheses){
 if(existing.some(x=>x.kind==='experiment'&&x.candidateId===e.candidateId&&x.stage==='independent-replication'))break;
 memory.recordExperiment({hypothesisId:h.hypothesisId,candidateId:e.candidateId,stage:'independent-replication',metrics:{...e.metrics,firstPlaceLower:e.metrics.firstPlaceDeltaPooledCi.oneSidedLower},verdict:'inconclusive',seeds:e.pairs.map(x=>x.seed),notes:`独立开发复验已完成；区间跨零，未复现竞技收益，不能证明机制。证据 ${evidenceRef}`,moduleScope:h.moduleScope.filter(id=>actual.has(id)),independentlyReplicated:false});
 memory.updateHypothesis({hypothesisId:h.hypothesisId,status:'inconclusive',evidenceRef,note:'独立32对总体增量0，层区间均跨零；不转化为正向模块'});
}
writeFileSync(`${dir}/INDEPENDENT-FEEDBACK.json`,JSON.stringify({candidateId:e.candidateId,actualModules:[...actual],records:memory.readAll().filter(x=>x.candidateId===e.candidateId&&x.stage==='independent-replication'),positiveModules:memory.positiveModules()},null,2));
