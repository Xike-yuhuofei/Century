import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {createLiveGovernanceProvider} from '../../../evolution/governance-provider-v2.mjs';
import {AI9_DEV_BLOCKS} from '../../../evolution/core.mjs';
import {sequentialSeeds} from '../../../../ai5/lib/seed_policy.mjs';
const dir=`${import.meta.dirname}/final-comparison`;if(existsSync(`${dir}/seed-manifest.json`))throw Error('已登记');mkdirSync(dir,{recursive:true});
const provider=createLiveGovernanceProvider({blocks:AI9_DEV_BLOCKS,windowPrefix:'ai9',experimentPrefix:'repair'});const manifest={recordedAt:new Date().toISOString(),arms:{}};
for(const arm of ['baseline','repaired']){
 manifest.arms[arm]={};for(const purpose of ['screen','deep']){
  const ref=provider.allocateDevSeedWindow({campaignId:`final-comparison-${arm}-llm`,round:1,purpose,count:8});
  const seeds=sequentialSeeds(AI9_DEV_BLOCKS[purpose],ref.base,8);manifest.arms[arm][purpose]={...ref,seeds};
  writeFileSync(`${dir}/${arm}-${purpose}-seeds.json`,JSON.stringify(seeds));
 }
}
writeFileSync(`${dir}/seed-manifest.json`,JSON.stringify(manifest,null,2));console.log('最终比较种子已预登记');
