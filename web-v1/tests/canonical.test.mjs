import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {STARTER_CARDS,MERCHANT_DECK,GOLEM_DECK} from '../dist/js/data.js';
const root=JSON.parse(readFileSync(new URL('../../data/cards.json',import.meta.url),'utf8'));
const toVec=s=>root.color_order.map(c=>s?.[c]??0);
test('V1 all 89 cards match root data/cards.json by ID and effect',()=>{
 assert.equal(STARTER_CARDS.length,10);
 for(const source of root.starters){
  const copies=STARTER_CARDS.filter(c=>c.id===source.id);
  assert.equal(copies.length,source.copies);
  for(const c of copies){assert.equal(c.kind,source.type==='创造'?'create':'upgrade');if(c.kind==='upgrade')assert.equal(c.steps,source.upgrade_steps);else assert.deepEqual(c.output,toVec(source.output));}
 }
 assert.equal(MERCHANT_DECK.length,root.merchants.length);
 for(let i=0;i<root.merchants.length;i++){
  const a=MERCHANT_DECK[i],b=root.merchants[i];assert.equal(a.id,b.id);
  assert.equal(a.kind,({创造:'create',升级:'upgrade',交易:'trade'})[b.type]);
  if(a.kind==='trade'){assert.deepEqual(a.input,toVec(b.input));assert.deepEqual(a.output,toVec(b.output));}
  else if(a.kind==='create')assert.deepEqual(a.output,toVec(b.output));
  else assert.equal(a.steps,b.upgrade_steps);
 }
 assert.equal(GOLEM_DECK.length,root.golems.length);
 for(let i=0;i<root.golems.length;i++){const a=GOLEM_DECK[i],b=root.golems[i];assert.equal(a.id,b.id);assert.deepEqual(a.cost,toVec(b.need));assert.equal(a.points,b.points);}
});
