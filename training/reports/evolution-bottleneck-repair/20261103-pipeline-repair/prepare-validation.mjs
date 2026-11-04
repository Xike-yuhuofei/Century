import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createLiveGovernanceProvider} from '../../../evolution/governance-provider-v2.mjs';
import {AI9_DEV_BLOCKS} from '../../../evolution/core.mjs';
import {sequentialSeeds} from '../../../../ai5/lib/seed_policy.mjs';
const out=new URL('./validation-seeds.json',import.meta.url);
if(existsSync(out))throw Error('已登记，禁止重新分配');
const provider=createLiveGovernanceProvider({blocks:AI9_DEV_BLOCKS,windowPrefix:'ai9',experimentPrefix:'repair'});
const cases=[['replication','deep',32],['M12-fixed','screen',4],['M12-time','screen',4]];
const manifest={registeredAt:new Date().toISOString(),selection:'最后一代入选的非对照候选；无候选则记不可运行',windows:{}};
for(const [name,purpose,count] of cases){const ref=provider.allocateDevSeedWindow({campaignId:`repair-${name}`,round:1,purpose,count});manifest.windows[name]={...ref,seeds:sequentialSeeds(AI9_DEV_BLOCKS[purpose],ref.base,count)};}
writeFileSync(out,JSON.stringify(manifest,null,2));
console.log(Object.fromEntries(Object.entries(manifest.windows).map(([k,v])=>[k,v.windowId])));
