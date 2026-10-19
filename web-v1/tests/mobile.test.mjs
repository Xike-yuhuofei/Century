import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../dist/js/engine.js';
import { parseMobileSave } from '../dist/js/mobile/storage.js';

test('手机 v2 存档支持所有授权配置及旧版缺省 isAI',()=>{
  for(const [h,a] of [[1,1],[2,0],[2,3],[2,4]]){
    const g=createGame(Array.from({length:h+a},(_,i)=>`P${i}`),17,Array.from({length:a},(_,i)=>h+i));
    assert.deepEqual(parseMobileSave(JSON.stringify(g)),g);
  }
  const old=createGame(['P1','P2'],17);old.players.forEach(p=>delete p.isAI);
  assert.equal(parseMobileSave(JSON.stringify(old)).version,2);
});
test('拒绝损坏、越界或不适合手机版的存档',()=>{
  const original=createGame(['P1','P2'],17);
  for(const mutate of [g=>g.version=1,g=>g.current=99,g=>g.players[0].stock[0]=-1,g=>g.players[0].hand=['FAKE'],g=>g.players[0].hand=['S01','S01'],g=>g.players[0].name='',g=>g.merchantMarket[0].bonus=[1],g=>g.log=[{}]]){
    const g=structuredClone(original);mutate(g);assert.throws(()=>parseMobileSave(JSON.stringify(g)));
  }
  assert.throws(()=>parseMobileSave(JSON.stringify(createGame(['P1','P2','P3'],17))));
  assert.equal(parseMobileSave(null),null);
});
test('已执行行动的超额弃置可存档并继续同一规则引擎',()=>{
  let g=createGame(['P1','P2'],17);g.players[0].stock=[10,0,0,0];
  g=applyAction(g,{type:'play',cardId:'S01'});
  const loaded=parseMobileSave(JSON.stringify(g));
  assert.equal(loaded.phase,'overflow');
  const next=applyAction(loaded,{type:'discard',colors:[0,0]});
  assert.equal(next.current,1);assert.deepEqual(next.players[0].stock,[10,0,0,0]);
});
test('阶段与容量不一致的存档不会进入无法完成的弃置界面',()=>{
  const original=createGame(['P1','P2'],17);
  for(const mutate of [g=>g.phase='overflow',g=>g.players[0].stock=[11,0,0,0],g=>g.phase='finished',g=>g.turnNumber=0]){
    const g=structuredClone(original);mutate(g);assert.throws(()=>parseMobileSave(JSON.stringify(g)),/阶段与商队容量/);
  }
});
test('独立手机产物使用指纹目录，所有静态资源和 Worker 存在',()=>{
  const root=fileURLToPath(new URL('../dist/mobile/',import.meta.url)),html=readFileSync(resolve(root,'modules.html'),'utf8');
  assert.ok(!html.includes('styles.css?'));assert.ok(!html.includes('src/styles.css'));
  for(const match of html.matchAll(/(?:src|href|content)="(\.\/assets\/[^"]+)"/g)) assert.ok(existsSync(resolve(root,match[1])),match[1]);
  assert.match(html,/assets\/[a-f0-9]{12}\/mobile\/app.js/);
  assert.match(html,/assets\/[a-f0-9]{12}\/mobile\/worker.js/);
  const offline=readFileSync(resolve(root,'standalone.html'),'utf8');
  assert.equal(readFileSync(resolve(root,'index.html'),'utf8'),offline);
  assert.ok(offline.includes('id="offline-worker"'));assert.ok(!offline.includes('src="./app.js"'));
});
