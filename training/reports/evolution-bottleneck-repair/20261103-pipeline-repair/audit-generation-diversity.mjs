import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {extractEvolveBlocks,extractFunction,stripLiterals} from '../../../../ai5/openevolve/node/module_registry.mjs';
import {sha256Canonical} from '../../../evolution/core.mjs';
const dir=import.meta.dirname,arms=['baseline','repaired','confirmation','final-comparison/baseline','final-comparison/repaired'];
function* walk(root){for(const e of readdirSync(root,{withFileTypes:true})){const p=join(root,e.name);if(e.isDirectory())yield* walk(p);else yield p;}}
function functions(code){return extractEvolveBlocks(code).blocks.map(b=>{const s=stripLiterals(b.text),name=[...s.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)][0][1];return {name,text:extractFunction(s,b.text,name).text.trim()};}).sort((a,b)=>a.name.localeCompare(b.name));}
const programs=new Map();
for(const arm of arms)for(const path of walk(`${dir}/${arm}`)){
 if(!path.includes('/checkpoints/')||!path.includes('/programs/')||!path.endsWith('.json'))continue;
 const p=JSON.parse(readFileSync(path));if(!p.iteration_found)continue;
 const f=functions(p.code);programs.set(p.id,{arm,programId:p.id,sourceHash:sha256Canonical(f),functionHashes:Object.fromEntries(f.map(x=>[x.name,sha256Canonical(x.text)])),compilePassed:p.metrics?.compile_ok===1});
}
const list=[...programs.values()],unique=new Set(list.map(x=>x.sourceHash));const hashes={};for(const p of list)for(const [fn,hash] of Object.entries(p.functionHashes))(hashes[fn]??=[]).push(hash);
const summary={programs:list,totalGenerated:list.length,uniqueFunctionSets:unique.size,repeatedFullFunctionSetOccurrences:list.length-unique.size,functionDiversity:Object.fromEntries(Object.entries(hashes).map(([fn,v])=>[fn,{occurrences:v.length,uniqueImplementations:new Set(v).size}])),limit:'源码重复不等于行为重复；跨run父代/窗口不同，仅作搜索材料诊断。真实同局面行为覆盖见validation-summary。'};
writeFileSync(`${dir}/GENERATION-DIVERSITY.json`,JSON.stringify(summary,null,2));console.log(summary);
