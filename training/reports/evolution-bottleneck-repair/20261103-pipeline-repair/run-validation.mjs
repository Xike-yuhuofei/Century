import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {ArtifactStore} from '../../../evolution/artifact-store.mjs';
import {evaluateCandidate} from '../../../evolution/dev-evaluator.mjs';
import {evaluateCompiledCandidateGames} from '../../../evolution/compiled-game-evaluator.mjs';
import {createCompiledModuleCandidate,loadCompiledCandidateModules} from '../../../evolution/multi-module-candidate.mjs';
import {mutateModuleFunction} from '../../../evolution/module-mutations.mjs';
import {sha256Canonical} from '../../../evolution/core.mjs';
import {computeCodeVersion} from '../../../lib/code-version.mjs';
import {createGame} from '../../../../web-v1/dist/js/engine.js';
import {chooseJointAction} from '../../../../web-v1/dist/js/js/adapter.js';
import {seatProfile} from '../../../simulator/simulate.mjs';
import {deriveSimStreamSeed,DEFAULT_SIM_SALT} from '../../../lib/sim-stream.mjs';
const dir=import.meta.dirname,started=Date.now(),manifest=JSON.parse(readFileSync(`${dir}/validation-seeds.json`));
const state=JSON.parse(readFileSync(`${dir}/repaired/state.json`));
if(!['completed','budget-exhausted'].includes(state.status))throw Error(`campaign 尚未结束: ${state.status}`);
const store=new ArtifactStore({root:`${dir}/repaired/artifacts`});
const summary={startedAt:new Date().toISOString(),codeVersion:computeCodeVersion(),stages:[],games:0,elapsedMs:0};
function checkpoint(row){summary.stages.push(row);summary.games+=row.games??0;summary.elapsedMs=Date.now()-started;writeFileSync(`${dir}/validation-summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(row));}
function save(name,evidence){writeFileSync(`${dir}/${name}.json`,JSON.stringify(evidence,null,2));return evidence;}
function guard(){if(Date.now()-started>1700000)throw Error('达到验证停止预算，保存现有检查点');}
const last=state.rounds.at(-1);const selected=last?.selectedIds?.find(id=>last.candidates.some(c=>c.candidateId===id&&c.strategy!=='control'));
if(selected){
 guard();const artifact=store.get(selected);save('replication-frozen-candidate',{candidateId:selected,artifactHash:artifact.artifactHash,identityDigest:artifact.identityDigest,seeds:manifest.windows.replication});
 const e=save('independent-replication',await evaluateCandidate({artifact,seeds:manifest.windows.replication.seeds,purpose:'deep',round:1,playerCounts:[2,3,4,5],maxMoves:500,deadlineMs:12000}));
 checkpoint({stage:'replication',candidateId:selected,games:e.metrics.totalGames,metrics:e.metrics,verdict:'开发样本；区间跨零为证据不足，综合胜负不证明具体机制'});
}else checkpoint({stage:'replication',status:'unavailable',reason:'最后一代无非对照入选候选，按协议不补抽'});
for(const round of state.rounds){
 const child=round.candidates.find(c=>c.strategy==='openevolve'&&c.quick?.evidencePath);if(!child)continue;
 guard();const artifact=store.get(child.parentId);const parent=save(`parent-behavior-r${round.round}`,await evaluateCandidate({artifact,seeds:round.screenSeeds,purpose:'screen',round:round.round,playerCounts:[2,3,4,5],maxMoves:500,deadlineMs:12000}));
 const current=JSON.parse(readFileSync(resolve(child.quick.evidencePath)));const a=parent.behaviorSignature.decisions,b=current.behaviorSignature.decisions;
 const shared=Object.keys(a).filter(k=>k in b),changed=shared.filter(k=>a[k]!==b[k]);
 checkpoint({stage:'parent-behavior',round:round.round,parentId:artifact.candidateId,childId:child.candidateId,games:parent.metrics.totalGames,sharedStates:shared.length,differentActions:changed.length,changedStateHashes:changed,scope:'同公开状态、同模拟流；只诊断代际行为变化'});
}
// 后续流程确认的第二代已在结果前指定，独立于原受控臂。
if(existsSync(`${dir}/confirmation/state.json`)){
 const cs=JSON.parse(readFileSync(`${dir}/confirmation/state.json`));
 const cstore=new ArtifactStore({root:`${dir}/confirmation/artifacts`});
 const candidate=cs.rounds[1]?.selectedIds?.[0];
 if(candidate){
  guard();const artifact=cstore.get(candidate),refs=JSON.parse(readFileSync(`${dir}/confirmation-seeds.json`)).windows.replication;
  save('confirmation-replication-frozen',{candidateId:candidate,artifactHash:artifact.artifactHash,identityDigest:artifact.identityDigest,seeds:refs});
  const e=save('confirmation-independent-replication',await evaluateCandidate({artifact,seeds:refs.seeds,purpose:'deep',round:1,playerCounts:[2,3,4,5],maxMoves:500,deadlineMs:12000}));
  checkpoint({stage:'confirmation-replication',candidateId:candidate,games:e.metrics.totalGames,metrics:e.metrics});
 }else checkpoint({stage:'confirmation-replication',status:'unavailable',reason:'预指定第二代没有入选候选'});
 for(const round of cs.rounds.slice(0,2)){
  const child=round.candidates.find(c=>c.parentId&&c.quick?.evidencePath);if(!child)continue;
  guard();const artifact=cstore.get(child.parentId);
  const parent=save(`confirmation-parent-behavior-r${round.round}`,await evaluateCandidate({artifact,seeds:round.screenSeeds,purpose:'screen',round:round.round,playerCounts:[2,3,4,5],maxMoves:500,deadlineMs:12000}));
  const current=JSON.parse(readFileSync(resolve(child.quick.evidencePath)));const a=parent.behaviorSignature.decisions,b=current.behaviorSignature.decisions;
  const shared=Object.keys(a).filter(k=>k in b),changed=shared.filter(k=>a[k]!==b[k]);
  checkpoint({stage:'confirmation-parent-behavior',round:round.round,parentId:artifact.candidateId,childId:child.candidateId,games:parent.metrics.totalGames,sharedStates:shared.length,differentActions:changed.length,changedStateHashes:changed});
 }
}
// 最终两臂也只在各自 quick 原窗口比较父子同公开状态；不计独立复验。
for(const arm of ['baseline','repaired']){
 const root=`${dir}/final-comparison/${arm}`;
 if(!existsSync(`${root}/state.json`))continue;
 const s=JSON.parse(readFileSync(`${root}/state.json`)),st=new ArtifactStore({root:`${root}/artifacts`});
 for(const round of s.rounds){
  const child=round.candidates.find(c=>c.parentId&&c.quick?.evidencePath);if(!child)continue;
  guard();const artifact=st.get(child.parentId);
  const parent=save(`final-${arm}-parent-behavior`,await evaluateCandidate({artifact,seeds:round.screenSeeds,purpose:'screen',round:round.round,playerCounts:[2,3,4,5],maxMoves:500,deadlineMs:12000}));
  const current=JSON.parse(readFileSync(resolve(child.quick.evidencePath)));
  if(current.behaviorSignature?.kind!=='compiled-public-action-v2'){
   checkpoint({stage:`final-${arm}-parent-behavior`,games:parent.metrics.totalGames,status:'incomparable',reason:'历史臂原评估器仅记录粗粒度签名，不补造行为证据'});continue;
  }
  const a=parent.behaviorSignature.decisions,b=current.behaviorSignature.decisions,shared=Object.keys(a).filter(k=>k in b),changed=shared.filter(k=>a[k]!==b[k]);
  checkpoint({stage:`final-${arm}-parent-behavior`,games:parent.metrics.totalGames,parentId:artifact.candidateId,childId:child.candidateId,sharedStates:shared.length,differentActions:changed.length});
 }
}
const experiment={configRef:'ai9://repair/M12-modes',configHash:sha256Canonical({protocol:'M12-mode-separation-v1',windows:manifest.windows}),seedRefs:[]};
const created=createCompiledModuleCandidate({candidateId:'cand-repair-m12-modes',experiment,modules:[{id:'M12',text:mutateModuleFunction('M12',0).text}]});
save('M12-candidate',created.artifact);
for(const name of ['M12-fixed','M12-time']){
 guard();const win=manifest.windows[name],workUnits=name==='M12-fixed'?32:null;
 const seedsByPlayerCount=Object.fromEntries([2,3,4,5].map((count,i)=>[count,[win.seeds[i]]]));
 const loaded=await loadCompiledCandidateModules(created.artifact);const configs=[];
 try{
  for(const [i,count] of [2,3,4,5].entries()){
   const game=createGame(Array.from({length:count},(_,j)=>`席位${j}`),win.seeds[i],Array.from({length:count-1},(_,j)=>j+1));game.players[0].isAI=true;
   const opts={version:'joint-js5',championParameters:created.artifact.parameters.values,simSeed:deriveSimStreamSeed(win.seeds[i],DEFAULT_SIM_SALT),profile:seatProfile(0),...(workUnits===null?{}:{workUnits})};
   const candidate=loaded.jointModule.chooseJointAction(game,opts),official=chooseJointAction(game,opts);
   configs.push({seatCount:count,candidate:candidate.config,official:official.config});
  }
 }finally{loaded.cleanup();}
 const e=save(name,await evaluateCompiledCandidateGames({artifact:created.artifact,seedsByPlayerCount,purpose:'screen',round:1,playerCounts:[2,3,4,5],workUnits,maxMoves:500,deadlineMs:30000}));
 save(`${name}-resolved-configs`,configs);
 checkpoint({stage:name,games:e.metrics.totalGames,metrics:e.metrics,configs,scope:'模式内对照；各模式种子独立，禁止跨模式比较胜率'});
}
summary.status='completed';summary.elapsedMs=Date.now()-started;writeFileSync(`${dir}/validation-summary.json`,JSON.stringify(summary,null,2));
