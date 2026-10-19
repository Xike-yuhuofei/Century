#!/usr/bin/env node
// Deterministic generator. --check exits with error if local cards drift from canonical data.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const source=JSON.parse(readFileSync(resolve(repo,'data/cards.json'),'utf8'));
const generate=function generate(c){const cols=["yellow","green","blue","pink"],v=x=>cols.map(k=>x?.[k]??0);
 const starters=c.starters.flatMap(x=>Array.from({length:x.copies},()=>x.type==="创造"?{id:x.id,kind:"create",output:v(x.output),starter:true}:{id:x.id,kind:"upgrade",steps:x.upgrade_steps,starter:true}));
 const merchants=c.merchants.map(x=>x.type==="创造"?{id:x.id,kind:"create",output:v(x.output)}:x.type==="升级"?{id:x.id,kind:"upgrade",steps:x.upgrade_steps}:{id:x.id,kind:"trade",input:v(x.input),output:v(x.output)});
 const golems=c.golems.map(x=>({id:x.id,points:x.points,cost:v(x.need)}));
 return `// Generated from root data/cards.json by web-v1/scripts/sync-cards.mjs. DO NOT EDIT.
export type Stock = [number,number,number,number];
export type Merchant = {id:string;kind:'create'|'upgrade'|'trade';output?:Stock;input?:Stock;steps?:number;starter?:boolean};
export type Golem = {id:string;points:number;cost:Stock};
export const STARTER_CARDS: Merchant[] = ${JSON.stringify(starters)};
export const MERCHANT_DECK: Merchant[] = ${JSON.stringify(merchants)};
export const GOLEM_DECK: Golem[] = ${JSON.stringify(golems)};
export const MERCHANT_BY_ID = Object.fromEntries([...STARTER_CARDS,...MERCHANT_DECK].map(m=>[m.id,m])) as Record<string,Merchant>;
export const GOLEM_BY_ID = Object.fromEntries(GOLEM_DECK.map(g=>[g.id,g])) as Record<string,Golem>;
if(STARTER_CARDS.length!==10||MERCHANT_DECK.length!==43||GOLEM_DECK.length!==36)throw Error('Wrong card count');
if(new Set(STARTER_CARDS.map(x=>x.id)).size!==2||new Set(MERCHANT_DECK.map(x=>x.id)).size!==43||new Set(GOLEM_DECK.map(x=>x.id)).size!==36)throw Error('Duplicate card ID');
`;
};
const path=resolve(repo,'web-v1/src/data.ts'),output=generate(source);
if(process.argv.includes('--check')){
 if(readFileSync(path,'utf8')!==output){console.error('Mismatch with root card data; run node scripts/sync-cards.mjs');process.exit(1);}
 console.log('Canonical card table: OK');
}else{writeFileSync(path,output);console.log('Canonical card table generated');}
