import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
import { chooseAIAction } from '../dist/js/ai.js';
import { replayMarkdown, replayJSON, validateReplay } from '../dist/js/replay.js';
import { parseMobileSave } from '../dist/js/mobile/storage.js';

const make = () => createGame(['甲', '乙'], 71);
const position = ({replay, ...g}) => g;

test('完整保存超过 45 条的玩家回合，轮次正确且不修改先前状态', () => {
  let g = createGame(['甲','乙','AI 1','AI 2','AI 3','AI 4'], 71, [2,3,4,5]);
  const original = JSON.stringify(g);
  const first = g;
  for (let i = 0; i < 72; i++) g = applyAction(g, {type:'rest'});
  assert.equal(JSON.stringify(first), original);
  assert.equal(g.log.length, 45);
  assert.equal(g.replay.turns.length, 72);
  assert.ok(g.replay.turns.every((t,i) => t.turnNumber === i+1 && t.playerId === i%6 && t.round === Math.floor(i/6)+1 && t.playerTurn === Math.floor(i/6)+1));
  assert.ok(g.players.every(p => p.turns === 12));
  assert.equal(parseMobileSave(JSON.stringify(g)).replay.turns.length, 72);
  assert.match(replayMarkdown(g), /第 12 轮 · 第 72 手/);
});

test('超额弃置并入同一回合，支持中途存档和导出，错误行动不污染历史', () => {
  let g = make(); g.players[0].stock = [10,0,0,0];
  g = applyAction(g, {type:'play',cardId:'S01'});
  const pending = JSON.stringify(g);
  assert.match(replayMarkdown(g), /回合未完成/);
  assert.equal(g.replay.turns.length, 1);
  assert.throws(() => applyAction(g, {type:'discard',colors:[3,3]}));
  assert.equal(JSON.stringify(g), pending);
  const next = applyAction(parseMobileSave(pending), {type:'discard',colors:[0,0]});
  assert.equal(JSON.stringify(g), pending);
  const t = next.replay.turns[0];
  assert.equal(next.replay.turns.length, 1);
  assert.equal(t.actions.length, 2);
  assert.equal(t.completed, true);
  assert.deepEqual(t.before.stock, [10,0,0,0]);
  assert.deepEqual(t.after.stock, [10,0,0,0]);
  assert.equal(t.after.turns, 1);
});

test('记录获取的具体卡号与付款顺序、升级路径、重复交易及认领硬币', () => {
  let g = make();
  const merchant = g.merchantMarket[2].id;
  g = applyAction(g, {type:'acquire',index:2,payment:[0,0]});
  assert.equal(g.replay.turns[0].cardId, merchant);
  assert.deepEqual(g.replay.turns[0].actions[0].payment, [0,0]);
  g = applyAction(g, {type:'play',cardId:'S02',steps:[0,1]});
  assert.match(replayMarkdown(g), /黄→绿、绿→蓝/);
  g.players[0].hand.push('M20'); g.players[0].stock = [6,0,0,0];
  g = applyAction(g, {type:'play',cardId:'M20',repeats:3});
  assert.match(replayMarkdown(g), /交易 3 次/);
  const id = g.golemMarket[0];
  g.players[1].stock = [...GOLEM_BY_ID[id].cost];
  g = applyAction(g, {type:'claim',index:0});
  const t = g.replay.turns.at(-1);
  assert.equal(t.cardId, id);
  assert.equal(t.after.copper - t.before.copper, 1);
  assert.match(replayMarkdown(g), new RegExp(`认领魔像 ${id}`));
});

test('旧版存档从接续点记录，旧的待弃置回合和已结束对局均可导出', () => {
  let g = make();
  for (let i=0;i<6;i++) g = applyAction(g, {type:'rest'});
  delete g.replay;
  assert.match(replayMarkdown(g), /没有完整回合记录/);
  g = applyAction(g, {type:'rest'});
  assert.equal(g.replay.fromStart, false);
  assert.equal(g.replay.initial.turnNumber, 7);
  assert.equal(g.replay.turns.length, 1);
  assert.match(replayMarkdown(g), /之前行动无法恢复/);
  let overflow = make(); overflow.players[0].stock = [10,0,0,0];
  overflow = applyAction(overflow, {type:'play',cardId:'S01'}); delete overflow.replay;
  overflow = applyAction(overflow, {type:'discard',colors:[0,0]});
  assert.equal(overflow.replay.initial.phase, 'overflow');
  assert.equal(overflow.replay.turns[0].actions[0].type, 'discard');
  const finished = {...g, phase:'finished', triggerPlayer:0}; delete finished.replay;
  assert.match(replayMarkdown(finished), /已结束/);
  assert.equal(JSON.parse(replayJSON(finished)).replay, null);
});

test('完整对局可从 JSON 起点和全部行动重放到相同结局，覆盖真人和 AI 席位', () => {
  let g = createGame(['甲','乙','AI'], 19, [2]);
  let actions = 0;
  while (g.phase !== 'finished' && actions++ < 750) g = applyAction(g, chooseAIAction({...g, players:g.players.map(p => ({...p,isAI:true}))}).action);
  assert.equal(g.phase, 'finished');
  validateReplay(g.replay, g);
  const exported = JSON.parse(replayJSON(g));
  let replayed = exported.replay.initial;
  for (const t of exported.replay.turns) {
    for (const a of t.actions) replayed = applyAction(replayed, a);
    assert.deepEqual(replayed.players[t.playerId], t.after);
  }
  assert.deepEqual(position(replayed), exported.current);
  assert.equal(g.replay.turns.length, g.players.reduce((n,p) => n+p.turns, 0));
  assert.equal(g.replay.turns.filter(t => t.triggersEnd).length, 1);
  assert.match(replayMarkdown(g), /触发终局/);
});

test('导入拒绝损坏的历史字段和起点；姓名不会注入 Markdown 结构', () => {
  const g = applyAction(make(), {type:'rest'});
  for (const mutate of [r => r.turns = {}, r => r.initial.players = [], r => r.initial.replay = {}, r => r.turns[0].after.stock = [-1,0,0,0], r => r.turns[0].actions = [{type:'play',cardId:'FAKE'}], r => r.turns[0].playerId = 99]) {
    const broken = structuredClone(g); mutate(broken.replay);
    assert.throws(() => parseMobileSave(JSON.stringify(broken)), /复盘|存档/);
  }
  const named = createGame(['<script>|甲', '乙'], 71);
  assert.ok(!replayMarkdown(named).includes('<script>'));
});
