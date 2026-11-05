import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLiveGovernanceProvider,createAutonomousGovernanceAdapter} from '../../../evolution/governance-provider-v2.mjs';
import {AI9_DEV_BLOCKS,sha256Canonical} from '../../../evolution/core.mjs';
import {moduleTextsFromArtifact} from '../../../evolution/multi-module-generator.mjs';
import {createCompiledModuleCandidate} from '../../../evolution/multi-module-candidate.mjs';
import {buildResearchBrief,writeBriefConfig} from '../../../evolution/research-context.mjs';
import {computeCodeVersion} from '../../../lib/code-version.mjs';
const dir=import.meta.dirname, arm=process.argv[2];
if(!['baseline','repaired'].includes(arm))throw Error('arm');
const source=arm==='baseline'?resolve(dir,'baseline-runtime'):resolve(dir,'../../../evolution');
const {CampaignController}=await import(pathToFileURL(`${source}/campaign-controller.mjs`));
const {runMultiModuleOpenEvolve,createCandidateFromOpenEvolveMulti}=await import(pathToFileURL(`${source}/openevolve-multi-bridge.mjs`));
const rootDir=`${dir}/final-comparison/${arm}`;mkdirSync(rootDir,{recursive:true});
process.env.CENTURY_OPENEVOLVE_STAGE2_SEED_FILE=`${dir}/final-comparison/${arm}-screen-seeds.json`;
process.env.CENTURY_OPENEVOLVE_STAGE3_SEED_FILE=`${dir}/final-comparison/${arm}-deep-seeds.json`;
const initial=JSON.parse(readFileSync(`${dir}/initial-parent.json`));
const provider=createLiveGovernanceProvider({blocks:AI9_DEV_BLOCKS,windowPrefix:'ai9',experimentPrefix:'repair'});
provider.requestFormalChallenge=()=>{throw Error('本实验未授权正式挑战')};
const governance=createAutonomousGovernanceAdapter({provider,blocks:AI9_DEV_BLOCKS,label:'AI9'});
const started=Date.now();let attempts=0;const runs=[];
const config={configRef:`ai9://repair/final-${arm}`,rounds:1,playerCounts:[2,3,4,5],quickSeeds:4,deepSeeds:8,retainTopK:2,deepConfirmations:1,continueFromSelected:true,maxMoves:500,deadlineMs:90000,generation:{mode:'multi-module',count:2,includeControl:true,allowInheritance:false,targetIds:['M02','M05'],openevolveConfigPath:`${dir}/experiment-config.yaml`},budget:{maxCandidates:2,maxGames:32,maxWallMs:900000,maxConcurrent:1,maxDeepConfirmations:1}};
const controller=new CampaignController({campaignId:`repair-final-${arm}`,rootDir,governance,config,generator:options=>{
 const priorState=options.round>1?JSON.parse(readFileSync(`${rootDir}/state.json`)):null;
 const selectedParent=priorState?.rounds?.[options.round-2]?.selectedIds?.find(id=>!id.includes('-control-'));
 const parent=options.parentArtifact??(selectedParent?controller.store.get(selectedParent):initial);
 const texts=moduleTextsFromArtifact(parent);const selected=['M02','M05'];const ids=arm==='baseline'?selected:[...new Set([...Object.keys(texts),...selected])].sort();
 const brief=buildResearchBrief({round:options.round,parentArtifact:parent,moduleIds:selected,memory:{testedHypotheses:controller.memory.testedHypotheses(),positiveModules:controller.memory.positiveModules()}});
 const cfg=writeBriefConfig({baseConfigPath:`${dir}/experiment-config.yaml`,brief,outPath:`${rootDir}/r${options.round}.yaml`});
 const candidates=[],rejectedAtGeneration=[];
 const control=createCompiledModuleCandidate({moduleIds:['M01'],candidateId:`cand-repair-final-${arm}-control-r${options.round}`,experiment:options.experiment,sourceOrigin:'deterministic-template'});candidates.push({...control,strategy:'control'});
 if(attempts>=1||Date.now()-started>=900000)return {candidates,rejectedAtGeneration};
 attempts++;
 try{
 const run=runMultiModuleOpenEvolve({moduleIds:ids,editableModuleIds:selected,moduleTexts:texts,parameters:parent.parameters.values,iterations:1,outputDir:`${rootDir}/llm-r${options.round}`,configPath:cfg.path,briefFile:cfg.briefPath,timeoutMs:Math.max(1000,900000-(Date.now()-started))});
 runs.push(run);writeFileSync(`${rootDir}/llm-runs.json`,JSON.stringify(runs,null,2));
 if(!run.ok)throw Error(`OpenEvolve失败 ${run.logTail}`);
 const created=createCandidateFromOpenEvolveMulti({outputDir:run.outputDir,experiment:options.experiment,round:options.round,parentArtifact:parent,parentModuleTexts:arm==='baseline'?Object.fromEntries(selected.filter(id=>texts[id]).map(id=>[id,texts[id]])):texts,expectedModuleIds:ids,run});
 candidates.push({...created,strategy:'openevolve'});
 }catch(error){rejectedAtGeneration.push({strategy:'openevolve',reason:error.message});}
 return {candidates,rejectedAtGeneration};
}});
controller.store.put(initial);
writeFileSync(`${rootDir}/resolved-config.json`,JSON.stringify({config,configHash:sha256Canonical(config),codeVersion:computeCodeVersion(),armSource:source,startedAt:new Date(started).toISOString()},null,2));
try{const result=await controller.run();writeFileSync(`${rootDir}/experiment-result.json`,JSON.stringify({result,attempts,elapsedMs:Date.now()-started,runs},null,2));console.log(JSON.stringify({arm,status:result.status,attempts,elapsedMs:Date.now()-started}));}catch(error){writeFileSync(`${rootDir}/experiment-error.json`,JSON.stringify({error:error.stack,attempts,elapsedMs:Date.now()-started,runs},null,2));throw error;}
