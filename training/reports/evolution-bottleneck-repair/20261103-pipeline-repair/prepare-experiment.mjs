import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,relative,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLiveGovernanceProvider} from '../../../evolution/governance-provider-v2.mjs';
import {AI9_DEV_BLOCKS,sha256Canonical} from '../../../evolution/core.mjs';
import {sequentialSeeds} from '../../../../ai5/lib/seed_policy.mjs';
const dir=import.meta.dirname, root=resolve(dir,'../../../..');
const provider=createLiveGovernanceProvider({blocks:AI9_DEV_BLOCKS,windowPrefix:'ai9',experimentPrefix:'repair'});
const manifest={sharedInstrumentation:'两臂共用新开发种子传递与当前安全编译链；A-D 控制逻辑分别读取基线快照和修复代码。基线并非未插桩二进制。',arms:{}};
for(const arm of ['baseline','repaired']){
 const refs={};for(const purpose of ['screen','deep']){
  const w=provider.allocateDevSeedWindow({campaignId:`repair-${arm}-llm`,round:1,purpose,count:8});
  const seeds=sequentialSeeds(AI9_DEV_BLOCKS[purpose],w.base,8);refs[purpose]={...w,seeds};
  writeFileSync(`${dir}/${arm}-${purpose}-seeds.json`,JSON.stringify(seeds));
 }manifest.arms[arm]=refs;
}
writeFileSync(`${dir}/seed-manifest.json`,JSON.stringify(manifest,null,2));
const files=['multi-module-generator','openevolve-multi-bridge','campaign-controller','research-orchestrator','research-memory','research-context','failure-diagnosis','selection','compiled-game-evaluator'];
mkdirSync(`${dir}/baseline-runtime`,{recursive:true});
for(const file of files){
 const original=resolve(root,`training/evolution/${file}.mjs`);
 let text=readFileSync(`${dir}/baseline-source/training/evolution/${file}.mjs`,'utf8');
 text=text.replace(/from (['"])(\.[^'"]+)\1/g,(all,q,spec)=>{
 const target=resolve(dirname(original),spec);const name=target.split('/').pop().replace('.mjs','');
 const mapped=dirname(target)===dirname(original)&&files.includes(name)?resolve(dir,`baseline-runtime/${name}.mjs`):target;
 return `from ${q}${pathToFileURL(mapped).href}${q}`;
 });writeFileSync(`${dir}/baseline-runtime/${file}.mjs`,text);
}
let config=readFileSync(`${root}/ai5/openevolve/config-ai9.yaml`,'utf8');
const start=config.indexOf('  models:');const end=config.indexOf('  temperature:',start);
config=config.slice(0,start)+`  models:\n    - name: "gpt-5.6-sol"\n      weight: 1.0\n      timeout: 600\n      retries: 0\n      reasoning_effort: "medium"\n`+config.slice(end);
writeFileSync(`${dir}/experiment-config.yaml`,config);
writeFileSync(`${dir}/experiment-config-hash.json`,JSON.stringify({hash:sha256Canonical(config),model:'gpt-5.6-sol',callsPerArm:2,wallLimitMs:2700000}));
