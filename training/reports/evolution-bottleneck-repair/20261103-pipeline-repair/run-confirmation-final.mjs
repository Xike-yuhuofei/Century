import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {CampaignController} from '../../../evolution/campaign-controller.mjs';
import {createLiveGovernanceProvider,createAutonomousGovernanceAdapter} from '../../../evolution/governance-provider-v2.mjs';
import {createCandidateFromOpenEvolveMulti} from '../../../evolution/openevolve-multi-bridge.mjs';
import {moduleTextsFromArtifact} from '../../../evolution/multi-module-generator.mjs';
import {AI9_DEV_BLOCKS} from '../../../evolution/core.mjs';
const dir=import.meta.dirname,rootDir=`${dir}/confirmation-final`,started=Date.now();mkdirSync(rootDir,{recursive:true});
const seeds=JSON.parse(readFileSync(`${dir}/confirmation-seeds.json`)).windows;
for(const [stage,key] of [[2,'llm-screen'],[3,'llm-deep']]){const path=`${rootDir}/stage${stage}-seeds.json`;writeFileSync(path,JSON.stringify(seeds[key].seeds));process.env[`CENTURY_OPENEVOLVE_STAGE${stage}_SEED_FILE`]=path;}
const sourceDir=`${dir}/repaired/llm-r1/checkpoints/checkpoint_1/programs`;
const proposals=readdirSync(sourceDir).map(name=>({name,program:JSON.parse(readFileSync(`${sourceDir}/${name}`))})).filter(x=>x.program.iteration_found===1);
if(proposals.length!==1)throw Error('预注册提案无法唯一识别，不按指标改选');
const original=proposals[0],importDir=`${rootDir}/checkpoint-proposal`;mkdirSync(`${importDir}/best`,{recursive:true});
writeFileSync(`${importDir}/best/best_program.ts`,original.program.code);writeFileSync(`${importDir}/best/best_program_info.json`,JSON.stringify(original.program,null,2));
writeFileSync(`${rootDir}/proposal-origin.json`,JSON.stringify({sourceFile:`${sourceDir}/${original.name}`,selection:'唯一 iteration_found=1，无论其得分是否优于初始程序',programId:original.program.id,metrics:original.program.metrics},null,2));
const initial=JSON.parse(readFileSync(`${dir}/initial-parent.json`)),priorRun=JSON.parse(readFileSync(`${dir}/repaired/llm-runs.json`))[0];
const provider=createLiveGovernanceProvider({blocks:AI9_DEV_BLOCKS,windowPrefix:'ai9',experimentPrefix:'repair'});provider.requestFormalChallenge=()=>{throw Error('未授权正式挑战')};
const governance=createAutonomousGovernanceAdapter({provider,blocks:AI9_DEV_BLOCKS,label:'AI9'});
const config={configRef:'ai9://repair/confirmation-final',rounds:3,playerCounts:[2,3,4,5],quickSeeds:4,deepSeeds:8,retainTopK:1,deepConfirmations:1,continueFromSelected:true,maxMoves:500,deadlineMs:30000,diagnosticsPath:null,generation:{mode:'multi-module',count:1,includeControl:false,allowInheritance:true,targetIds:['M02','M05'],openevolveIterations:1,maxOpenEvolvePerBatch:0,openevolveConfigPath:`${dir}/experiment-config.yaml`,openevolveOutputDir:`${rootDir}/llm`},budget:{maxCandidates:3,maxGames:40,maxWallMs:300000,maxConcurrent:1,maxDeepConfirmations:1}};
const controller=new CampaignController({campaignId:'repair-confirmation-final',rootDir,governance,config,generator:options=>{
 if(options.round!==1)throw Error('第一轮之后应使用默认生成器');
 const proposal=createCandidateFromOpenEvolveMulti({outputDir:importDir,experiment:options.experiment,round:1,parentArtifact:initial,parentModuleTexts:moduleTextsFromArtifact(initial),expectedModuleIds:priorRun.lockedModuleHashes?['M01','M02','M03','M05','M06']:null,run:priorRun});
 controller.generator=null;
 return {candidates:[{...proposal,strategy:'openevolve'}],rejectedAtGeneration:[]};
}});controller.store.put(initial);
writeFileSync(`${rootDir}/protocol-config.json`,JSON.stringify(config,null,2));
try{const result=await controller.run();writeFileSync(`${rootDir}/run-result.json`,JSON.stringify({result,elapsedMs:Date.now()-started},null,2));console.log(JSON.stringify({status:result.status,elapsedMs:Date.now()-started}));}catch(error){writeFileSync(`${rootDir}/run-error.json`,JSON.stringify({error:error.stack,elapsedMs:Date.now()-started}));throw error;}
