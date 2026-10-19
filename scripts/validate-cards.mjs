#!/usr/bin/env node
import {readFileSync} from "node:fs";
import assert from "node:assert/strict";

const cards=JSON.parse(readFileSync(new URL("../data/cards.json",import.meta.url),"utf8"));
const md=readFileSync(new URL("../02-卡牌总表.md",import.meta.url),"utf8");
const keys=["yellow","green","blue","pink"], weights=[1,2,3,4];
const count=v=>keys.reduce((s,k)=>s+v[k],0);
const val=v=>keys.reduce((s,k,i)=>s+v[k]*weights[i],0);
const clean=v=>{assert.deepEqual(Object.keys(v),keys);for(const k of keys)assert(Number.isInteger(v[k])&&v[k]>=0)};
const unique=(list,field)=>assert.equal(new Set(list.map(x=>x[field])).size,list.length,`duplicate ${field}`);
assert.deepEqual(cards.color_order,keys);
assert.deepEqual(cards.valuation_weights,{yellow:1,green:2,blue:3,pink:4});
assert.equal(cards.starters.length,2);
assert.equal(cards.starters.reduce((s,c)=>s+c.copies,0),10);
assert.equal(cards.merchants.length,43);
assert.equal(cards.golems.length,36);
unique([...cards.starters,...cards.merchants,...cards.golems],"id");

const typeCount={创造:0,升级:0,交易:0};
const signatures=new Set();
for(const c of cards.merchants){
 clean(c.input);clean(c.output);
 assert(["创造","升级","交易"].includes(c.type));
 typeCount[c.type]++;
 const sig=JSON.stringify([c.type,c.input,c.output,c.upgrade_steps]);
 assert(!signatures.has(sig),`duplicate card: ${c.id}`);
 signatures.add(sig);
 if(c.type==="升级"){
  assert.equal(count(c.input)+count(c.output),0);
  assert.equal(c.value_delta,c.upgrade_steps);
  assert.equal(c.max_trades_10_crystals,null);
 }else if(c.type==="创造"){
  assert.equal(count(c.input),0);
  assert.equal(c.upgrade_steps,0);
  assert.equal(c.value_delta,val(c.output));
  assert.equal(c.max_trades_10_crystals,null);
 }else{
  assert(count(c.input)>0&&count(c.output)>0);
  assert.equal(c.upgrade_steps,0);
  assert.equal(c.value_delta,val(c.output)-val(c.input),`bad gain: ${c.id}`);
  assert.equal(c.max_trades_10_crystals,Math.floor(10/Math.max(count(c.input),count(c.output))),`bad capacity: ${c.id}`);
 }
 assert(md.includes(`| ${c.id} |`),`not documented: ${c.id}`);
}
assert.deepEqual(typeCount,{创造:8,升级:1,交易:34});
const tradeGroups={yellow:0,green:0,blue:0,pink:0,mixed:0};
for(const c of cards.merchants.filter(c=>c.type==="交易")){
 const input=keys.filter(k=>c.input[k]>0);
 tradeGroups[input.length===1?input[0]:"mixed"]++;
}
assert.deepEqual(tradeGroups,{yellow:9,green:8,blue:8,pink:7,mixed:2});
assert(!cards.merchants.some(c=>c.type==="交易"&&c.input.pink===1&&count(c.input)===1&&c.output.green===2&&count(c.output)===2),"phantom pink=>green");
for(const s of cards.starters){clean(s.input);clean(s.output);assert.equal(s.copies,5)}
for(const g of cards.golems){
 clean(g.need);
 const colorCount=keys.filter(k=>g.need[k]>0).length;
 assert.equal(g.points,val(g.need)+Math.max(0,colorCount-2),`golem score: ${g.id}`);
 assert(md.includes(`| ${g.id} |`),`golem not documented: ${g.id}`);
}
console.log("PASS: 10 starting, 43 merchant (8/1/34), 36 golem cards; no duplicates; valuation and capacity; markdown IDs.");
