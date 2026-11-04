import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inheritanceDiff} from '../module-inheritance.mjs';
import {generateMultiModuleBatch,moduleTextsFromArtifact} from '../multi-module-generator.mjs';
import {createCandidateFromOpenEvolveMulti,prepareOpenEvolveSeeds} from '../openevolve-multi-bridge.mjs';
import {mutateModuleFunction} from '../module-mutations.mjs';
import {createCompiledModuleCandidate,candidateParametersFor} from '../multi-module-candidate.mjs';
import {composeProgramFromTexts} from '../../../ai5/openevolve/node/module_registry.mjs';
import {decideNextResearch} from '../research-orchestrator.mjs';
import {buildResearchBrief} from '../research-context.mjs';
import {openResearchMemory} from '../research-memory.mjs';
const experiment={configRef:'ai9://repair/regression',configHash:'a'.repeat(64),seedRefs:[]};
test('OpenEvolve 默认先登记独立开发窗口，显式协议文件不重复分配',()=>{
 const outputDir=mkdtempSync(join(tmpdir(),'repair-seeds-')),calls=[];
 const governance={allocateDevSeedWindow(request){calls.push(request);return {base:request.purpose==='screen'?1660000000:1670000000,windowId:`test-${request.purpose}`};}};
 const result=prepareOpenEvolveSeeds({outputDir,env:{},governance});
 assert.deepEqual(calls.map(c=>c.count),[16,48]);
 assert.equal(JSON.parse(readFileSync(result.seedEnv.CENTURY_OPENEVOLVE_STAGE2_SEED_FILE)).length,16);
 const reused=prepareOpenEvolveSeeds({outputDir,env:result.seedEnv,governance});
 assert.equal(calls.length,2);assert.deepEqual(reused.seedRefs,[]);
 assert.throws(()=>prepareOpenEvolveSeeds({outputDir,env:{CENTURY_OPENEVOLVE_STAGE2_SEEDS:'4'},governance}),/至少两对/);
});
test('非法模块丢失拒绝，显式消融准确记录保留与移除',()=>{
 assert.throws(()=>inheritanceDiff({M01:'a',M03:'b'},{M01:'a'}),/非法丢失/);
 const d=inheritanceDiff({M01:'a',M03:'b'},{M01:'a'},{allowRemoval:true});
 assert.deepEqual(d.modulesRetained,['M01']);assert.deepEqual(d.modulesRemoved,['M03']);
});
test('真实编译：普通变异和完整 LLM 产物累积父模块与参数；局部产物拒绝',()=>{
 const parameters=candidateParametersFor('cand-test-parent');parameters.engineWeight=1.03;
 const parent=createCompiledModuleCandidate({candidateId:'cand-test-parent',parameters,experiment,modules:['M01','M03'].map(id=>({id,text:mutateModuleFunction(id,0).text}))}).artifact;
 const child=generateMultiModuleBatch({count:1,seed:1,experiment,parentArtifact:parent,targetIds:['M05'],moduleConfig:{strategies:['single'],includeControl:false}}).candidates[0].artifact;
 assert.equal(child.parameters.values.engineWeight,1.03);assert.deepEqual(child.source.modules.map(m=>m.id),['M01','M03','M05']);
 const dir=mkdtempSync(join(tmpdir(),'repair-best-'));mkdirSync(join(dir,'best'));
 const texts=moduleTextsFromArtifact(parent);const changed=mutateModuleFunction('M05',0).text;
 writeFileSync(join(dir,'best/best_program.ts'),composeProgramFromTexts(['M05'],{M05:changed}));
 assert.throws(()=>createCandidateFromOpenEvolveMulti({outputDir:dir,experiment,parentArtifact:parent,parentModuleTexts:texts}),/非法丢失/);
 writeFileSync(join(dir,'best/best_program.ts'),composeProgramFromTexts(['M01','M03','M05'],{...texts,M05:changed}));
 const llm=createCandidateFromOpenEvolveMulti({outputDir:dir,experiment,parentArtifact:parent,parentModuleTexts:texts}).artifact;
 assert.equal(llm.parameters.values.engineWeight,1.03);assert.deepEqual(llm.lineage.modulesRetained,['M01','M03']);
});
test('停滞诊断最多连续一轮，之后预算内重新探索',()=>{
 const plans=[2,3,4,5,6].map(stagnantRounds=>decideNextResearch({trend:{rounds:stagnantRounds,meanDelta:0,stagnantRounds},modules:['M01'],hasElites:true}));
 assert.equal(plans[0].decision,'ablate');assert.ok(plans[1].strategies.includes('openevolve'));assert.ok(plans[2].strategies.includes('openevolve'));
});
test('相同机制与干预跨轮身份稳定',()=>{
 const a=buildResearchBrief({round:1,moduleIds:['M02','M06']});const b=buildResearchBrief({round:2,moduleIds:['M02','M06']});
 assert.deepEqual(a.hypotheses.map(h=>h.id),b.hypotheses.map(h=>h.id));
});
test('跨零正读数不构成正向模块，后续翻负撤销历史复现',()=>{
 const memory=openResearchMemory({path:join(mkdtempSync(join(tmpdir(),'repair-memory-')),'memory.jsonl')});
 memory.recordExperiment({hypothesisId:'h',candidateId:'a',stage:'deep',metrics:{firstPlaceDelta:0.2,firstPlaceLower:-0.1},verdict:'supported',moduleScope:['M06']});
 assert.deepEqual(memory.positiveModules(),[]);
 memory.recordExperiment({hypothesisId:'h',candidateId:'a',stage:'replication',metrics:{firstPlaceDelta:0.2,firstPlaceLower:0.05},verdict:'supported',moduleScope:['M06'],independentlyReplicated:true});
 assert.equal(memory.positiveModules().length,1);
 memory.recordExperiment({hypothesisId:'h',candidateId:'a',stage:'replication',metrics:{firstPlaceDelta:-0.1},verdict:'inconclusive',moduleScope:['M06']});assert.deepEqual(memory.positiveModules(),[]);
});

test('多模块预算种子已分层，不重复乘人数；普通评估维持笛卡尔积',async()=>{
 const {expectedGames}=await import('../campaign-controller.mjs');
 assert.equal(expectedGames({evidenceMode:'game',seeds:Array(8),playerCounts:[2,3,4,5],pairedArms:2}),16);
 assert.equal(expectedGames({evidenceMode:'game',seeds:Array(8),playerCounts:[2,3,4,5],pairedArms:1}),32);
});

test('同模块交叉保留另一父代模块，记录捐赠者；消融不删除被依赖模块',()=>{
 const make=(id,variant)=>createCompiledModuleCandidate({candidateId:id,experiment,modules:['M01','M03','M02'].map(mid=>({id:mid,text:mutateModuleFunction(mid,0).text.replace('goal.points / 8',variant ? 'goal.points / 9' : 'goal.points / 8')}))}).artifact;
 const a=make('cand-cross-a',0),b=make('cand-cross-b',1);
 const batch=generateMultiModuleBatch({count:1,seed:19,experiment,eliteArtifacts:[a,b],targetIds:['M01'],moduleConfig:{strategies:['crossover'],includeControl:false}});
 assert.equal(batch.candidates.length,1,JSON.stringify(batch.rejectedAtGeneration));
 const c=batch.candidates[0].artifact;
 assert.deepEqual(c.source.modules.map(m=>m.id),['M01','M02','M03']);assert.equal(c.lineage.donors.length,2);
 assert.ok(c.lineage.modulesChanged.length);assert.equal(Object.keys(c.lineage.moduleDonors).length,3);
 const ablation=generateMultiModuleBatch({count:1,seed:19,experiment,eliteArtifacts:[a],targetIds:['M01'],moduleConfig:{strategies:['ablation'],includeControl:false}}).candidates[0].artifact;
 assert.ok(!ablation.lineage.modulesRemoved.includes('M03'));assert.deepEqual(ablation.lineage.modulesRemoved,ablation.lineage.fallbackToOfficial);
});

test('LLM 锁定模块修改与初始程序原样返回都拒绝',()=>{
 const parent=createCompiledModuleCandidate({candidateId:'cand-lock-parent',experiment,modules:[{id:'M01',text:mutateModuleFunction('M01',0).text}]}).artifact;
 const texts=moduleTextsFromArtifact(parent),dir=mkdtempSync(join(tmpdir(),'repair-locked-'));mkdirSync(join(dir,'best'));
 const program=composeProgramFromTexts(['M01'],texts);writeFileSync(join(dir,'input.ts'),program);writeFileSync(join(dir,'best/best_program.ts'),program);
 assert.throws(()=>createCandidateFromOpenEvolveMulti({outputDir:dir,experiment,parentArtifact:parent,parentModuleTexts:texts,run:{programPath:join(dir,'input.ts')}}),/identical-to-input/);
 writeFileSync(join(dir,'best/best_program.ts'),composeProgramFromTexts(['M01'],{M01:mutateModuleFunction('M01',0).text.replace('goal.points / 8','goal.points / 9')}));
 assert.throws(()=>createCandidateFromOpenEvolveMulti({outputDir:dir,experiment,parentArtifact:parent,parentModuleTexts:texts,run:{lockedModuleHashes:{M01:parent.source.modules[0].functionSha256}}}),/锁定模块/);
});

test('M12 固定工作量下不接受新探索，仍保留父代该模块',()=>{
 assert.throws(()=>generateMultiModuleBatch({count:1,seed:1,experiment,targetIds:['M12']}),/没有可用模块/);
 const p=createCompiledModuleCandidate({candidateId:'cand-time-parent',experiment,moduleIds:['M12']}).artifact;
 const c=generateMultiModuleBatch({count:1,seed:1,experiment,parentArtifact:p,targetIds:['M01','M12'],moduleConfig:{strategies:['single'],includeControl:false}}).candidates[0].artifact;
 assert.ok(c.lineage.modulesRetained.includes('M12'));assert.ok(!c.lineage.modulesChanged.includes('M12'));
});

test('行为差异比较公开状态的具体动作，不把不同模块或无公共状态算新行为',async()=>{
 const {behaviorDistance}=await import('../selection.mjs');
 const a={kind:'compiled-public-action-v2',mode:'workUnits',workUnits:32,decisions:{x:'acquire-card-a'}};
 assert.equal(behaviorDistance(a,null),0);
 assert.equal(behaviorDistance(a,{kind:'compiled-module-behavior-v1',actions:{play:1}}),0);
 assert.equal(behaviorDistance(a,{...a,decisions:{x:'acquire-card-b'}}),1);
 assert.equal(behaviorDistance(a,{...a,decisions:{y:'claim'}}),0);
 assert.equal(behaviorDistance({kind:'compiled-module-behavior-v1',actions:{play:1},modules:['M01']},{kind:'compiled-module-behavior-v1',actions:{play:1},modules:['M05']}),0);
});

test('竞技排序统一使用总体区间，五人层只作分层诊断',async()=>{
 const {scoreCandidate}=await import('../selection.mjs');
 const artifact={candidateId:'test',safety:{status:'passed'},algorithmStructure:{evaluationMode:'game',targetIds:['M01']}};
 const score=scoreCandidate({artifact,evidence:{metrics:{firstPlaceDelta:0.1,firstPlaceDeltaCi:{oneSidedLower:-0.9},firstPlaceDeltaPooledCi:{oneSidedLower:-0.2}}}});
 assert.equal(score.rankKey,-0.2);
});

test('深验配额耗尽、趋势固定时，按真实轮次恢复探索；有弱点也不能锁死',()=>{
 const trend={rounds:2,meanDelta:-0.1,stagnantRounds:2};
 for(const diagnosis of [null,{failureCases:[{seatCount:2,status:'supported'}]}]){
  const plans=[2,3,4,5,6].map(researchRound=>decideNextResearch({trend,diagnosis,modules:['M01'],hasElites:true,researchRound}));
  assert.ok(plans[1].strategies.includes('openevolve'));assert.equal(plans[1].strategies[0],'openevolve');assert.equal(plans[4].strategies[0],'openevolve');
  assert.ok(plans.every(p=>p.targetIds.every(id=>id==='M01')));
 }
});

test('缺少后续深验证据和正点估计跨零不重置停滞周期',async()=>{
 const {summarizeTrend}=await import('../research-orchestrator.mjs');
 assert.equal(summarizeTrend([{delta:0.1,lower:-0.2},{delta:null}]).stagnantRounds,2);
 assert.equal(summarizeTrend([{delta:null},{delta:null}]).stagnantRounds,2);
});

test('抽中整数舍入不变时继续寻找可变小数，不误报整函数无变异',async()=>{
 const {mutateModuleText}=await import('../module-mutations.mjs');
 const text='export function restMultiplier(state: EvolveStateView, preferred: string | null, params: AIParameters): number { const total = state.hand.length + state.played.length; return total ? 1.15 - .45 * state.played.length / total : 1; }';
 const a=mutateModuleText('M05',text,0,1),b=mutateModuleText('M05',text,0,1);
 assert.equal(a.operator,'generic-numeric');assert.notEqual(a.text,text);assert.equal(a.text,b.text);
});

test('深验配额已耗尽时不为不会执行的对局申请预算，不误停 campaign',async()=>{
 const {CampaignController}=await import('../campaign-controller.mjs');
 const controller=Object.create(CampaignController.prototype);
 controller.config={generation:{mode:'multi-module'},deepConfirmations:1,playerCounts:[2,3,4,5],budget:{maxDeepConfirmations:1,maxGames:48}};
 controller._event=()=>{};
 const item={candidateId:'cand-quota',stage:'selected',evaluationMode:'game',quick:{score:{rankKey:0}}};
 const round={candidates:[item],selectedIds:[item.candidateId],deepSeeds:Array(8),deepDone:false};
 const state={status:'running',budgetUsed:{games:40,deepConfirmations:1}};
 await controller._deepNext(state,round);
 assert.equal(state.status,'running');assert.equal(item.stage,'deep-quota-skipped');assert.equal(round.deepDone,true);
});
