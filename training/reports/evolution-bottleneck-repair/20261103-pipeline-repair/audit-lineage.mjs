import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {ArtifactStore} from '../../../evolution/artifact-store.mjs';
import {sha256Canonical} from '../../../evolution/core.mjs';
const dir=import.meta.dirname;
const result=[];
for(const arm of ['baseline','repaired','confirmation','confirmation-final','final-comparison/baseline','final-comparison/repaired']){
 if(!existsSync(`${dir}/${arm}/state.json`))continue;
 const state=JSON.parse(readFileSync(`${dir}/${arm}/state.json`)),store=new ArtifactStore({root:`${dir}/${arm}/artifacts`});
 for(const round of state.rounds){for(const item of round.candidates){
  if(!item.artifactPath||!item.parentId)continue;
  const child=store.get(item.candidateId),parent=store.get(item.parentId);
  const before=Object.fromEntries(parent.source.modules.map(m=>[m.id,m.functionSha256])),after=Object.fromEntries(child.source.modules.map(m=>[m.id,m.functionSha256]));
  const retained=Object.keys(before).filter(id=>before[id]===after[id]),removed=Object.keys(before).filter(id=>!(id in after)),modified=Object.keys(before).filter(id=>id in after&&before[id]!==after[id]),added=Object.keys(after).filter(id=>!(id in before));
  const stripId=({id,...values})=>values;
  result.push({arm,round:round.round,id:child.candidateId,parent:parent.candidateId,retained,removed,modified,added,parametersInherited:sha256Canonical(stripId(child.parameters.values))===sha256Canonical(stripId(parent.parameters.values)),engineWeight:child.parameters.values.engineWeight,parentEngineWeight:parent.parameters.values.engineWeight,lineageChangedMatches:JSON.stringify([...(child.lineage?.modulesChanged??[])].sort())===JSON.stringify([...modified,...added].sort()),sourceHash:child.sourceHash,buildHash:child.buildArtifact.sha256,quickEvidence:item.quick?.evidencePath,deepEvidence:item.deep?.evidencePath});
 }}
}
writeFileSync(`${dir}/lineage-audit.json`,JSON.stringify(result,null,2));console.log(result.map(x=>({arm:x.arm,round:x.round,retained:x.retained,removed:x.removed,params:x.parametersInherited,changedMatches:x.lineageChangedMatches})));
