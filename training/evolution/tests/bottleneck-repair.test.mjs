import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inheritanceDiff} from '../module-inheritance.mjs';
import {prepareOpenEvolveSeeds} from '../openevolve-multi-bridge.mjs';
import {decideNextResearch} from '../research-orchestrator.mjs';
import {buildResearchBrief} from '../research-context.mjs';
import {openResearchMemory} from '../research-memory.mjs';
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
