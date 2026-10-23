import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { ARCHIVE_KEY, ARCHIVE_LIMIT, archiveKey, makeEntry, pushArchive, loadArchive, saveArchive } from '../dist/js/archive.js';

const fakeStore = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; };
const make = () => createGame(['甲', '乙'], 71);

test('归档指纹跨刷新稳定；不同对局指纹不同', () => {
  const g = make();
  const snapshot = JSON.parse(JSON.stringify(g));
  assert.equal(archiveKey(g), archiveKey(snapshot));
  const next = applyAction(g, { type: 'rest' });
  assert.notEqual(archiveKey(g), archiveKey(next));
});

test('makeEntry：结束局标题含获胜者与分数，未完成局标记未完成', () => {
  const g = make();
  const finished = makeEntry({ ...g, phase: 'finished' }, '2026-10-23T10:00:00.000Z');
  assert.equal(finished.finished, true);
  assert.match(finished.title, /获胜者：/);
  assert.match(finished.title, /分/);
  assert.equal(finished.players, 2);
  assert.equal(finished.savedAt, '2026-10-23T10:00:00.000Z');
  const unfinished = makeEntry({ ...g, phase: 'turn', turnNumber: 7 }, '2026-10-23T10:00:00.000Z');
  assert.equal(unfinished.finished, false);
  assert.match(unfinished.title, /第 7 手 · 未完成/);
});

test('pushArchive：新条目置顶、同指纹去重、超过上限丢弃最旧', () => {
  const g = make();
  let list = [];
  for (let i = 0; i < ARCHIVE_LIMIT + 3; i++) list = pushArchive(list, makeEntry({ ...g, turnNumber: i + 1 }, `2026-10-23T10:0${i % 10}:00.000Z`));
  assert.equal(list.length, ARCHIVE_LIMIT);
  assert.equal(list[0].turns, ARCHIVE_LIMIT + 3);
  const again = makeEntry({ ...g, turnNumber: ARCHIVE_LIMIT + 3 });
  const deduped = pushArchive(list, again);
  assert.equal(deduped.length, ARCHIVE_LIMIT);
  assert.equal(deduped.filter(e => e.id === again.id).length, 1);
});

test('saveArchive/loadArchive：完整往返保留复盘记录，坏条目被剔除', () => {
  let g = make();
  g = applyAction(g, { type: 'rest' });
  const store = fakeStore();
  const entry = makeEntry(g, '2026-10-23T12:00:00.000Z');
  saveArchive([entry], store);
  const loaded = loadArchive(store);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, entry.id);
  assert.equal(loaded[0].savedAt, entry.savedAt);
  assert.equal(loaded[0].title, entry.title);
  assert.equal(loaded[0].game.replay.turns.length, 1);
  const bad = JSON.parse(JSON.stringify(entry));
  bad.id = 'bad-1';
  bad.game.replay.turns[0].turnNumber = 999;
  const bad2 = { id: 'bad-2', savedAt: 'x', finished: true, title: 't', turns: 1, players: 2, game: { version: 2 } };
  saveArchive([bad, bad2, entry], store);
  assert.deepEqual(loadArchive(store).map(e => e.id), [entry.id]);
  const empty = fakeStore();
  assert.deepEqual(loadArchive(empty), []);
  empty.setItem(ARCHIVE_KEY, '{oops');
  assert.deepEqual(loadArchive(empty), []);
  assert.deepEqual(loadArchive(undefined), []);
});

test('saveArchive：存储配额不足时降级重试且不抛错', () => {
  const entry = makeEntry(make());
  const angry = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.doesNotThrow(() => saveArchive([entry], angry));
  let calls = 0;
  const alwaysFull = { getItem: () => null, setItem: () => { calls++; throw new Error('quota'); } };
  saveArchive(Array.from({ length: ARCHIVE_LIMIT }, (_, i) => makeEntry({ ...make(), turnNumber: i + 1 }, `2026-10-23T10:0${i % 10}:00.000Z`)), alwaysFull);
  assert.equal(calls, 2);
});

test('存储拒绝访问（隐私模式 / 嵌入式 about:blank）：属性访问本身抛错时绝不阻断页面', () => {
  // CI 复现根因：Playwright set_content 页面拒绝 localStorage——
  // globalThis.localStorage 的 getter 本身抛 SecurityError（在 try 之外），
  // loadArchive 在模块顶层调用，直接让整个应用初始化崩溃（设置屏不渲染）。
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error("Failed to read the 'localStorage' property from 'Window': Access is denied for this document."); },
  });
  try {
    assert.doesNotThrow(() => loadArchive(), 'loadArchive 必须兜住存储属性访问');
    assert.deepEqual(loadArchive(), []);
    const entry = makeEntry(make());
    assert.doesNotThrow(() => saveArchive([entry]), 'saveArchive 必须兜住存储属性访问');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
  // 恢复后既有行为不变：显式注入 store 仍正常工作。
  const store = fakeStore();
  saveArchive([makeEntry(make(), '2026-10-23T12:30:00.000Z')], store);
  assert.equal(loadArchive(store).length, 1);
});
