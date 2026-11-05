import {existsSync,writeFileSync} from 'node:fs';
import {createLiveGovernanceProvider} from '../../../evolution/governance-provider-v2.mjs';
import {AI9_DEV_BLOCKS} from '../../../evolution/core.mjs';
import {sequentialSeeds} from '../../../../ai5/lib/seed_policy.mjs';
const out=new URL('./confirmation-seeds.json',import.meta.url);if(existsSync(out))throw Error('已登记');
const provider=createLiveGovernanceProvider({blocks:AI9_DEV_BLOCKS,windowPrefix:'ai9',experimentPrefix:'repair'});
const windows={};
for(const [name,purpose,count] of [['replication','deep',32],['llm-screen','screen',8],['llm-deep','deep',8]]){
 const window=provider.allocateDevSeedWindow({campaignId:`confirmation-${name}`,round:1,purpose,count});windows[name]={...window,seeds:sequentialSeeds(AI9_DEV_BLOCKS[purpose],window.base,count)};
}
writeFileSync(out,JSON.stringify({registeredAt:new Date().toISOString(),windows},null,2));
console.log(Object.fromEntries(Object.entries(windows).map(([name,w])=>[name,w.windowId])));
