import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {completeConsumption} from '../../../lib/seed-governance.mjs';
const dir=import.meta.dirname,a=JSON.parse(readFileSync(`${dir}/BOUNDARY-AUDIT.json`));
const used=new Set(a.usedExperimentIds),closed=[];
for(const entry of a.addedSeedEntries){
 if(entry.status!=='reserved')continue;
 const consumed=used.has(entry.experimentId);
 closed.push(completeConsumption(entry.experimentId,{status:consumed?'completed':'voided',note:consumed?'本任务开发对局已结束；实际逐局种子见报告归档，其余窗口继续占用，不复用。':'已预留但未启动该窗口对局；按停止条件作废，不退回种子池。',evidencePath:'training/reports/evolution-bottleneck-repair/20261103-pipeline-repair/FINAL-REPORT.md'}));
}
if(closed.length){
 const prior=existsSync(`${dir}/SEED-CLOSURE.json`)?JSON.parse(readFileSync(`${dir}/SEED-CLOSURE.json`)):[];
 writeFileSync(`${dir}/SEED-CLOSURE.json`,JSON.stringify([...prior,...closed],null,2));
}console.log(`收尾 ${closed.length} 条本任务登记；不修改原有条目或正式挑战账本`);
