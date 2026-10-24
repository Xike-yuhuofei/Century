/** AI 决策客户端生命周期测试（夜间任务 C）。
 *
 * 覆盖任务书"生命周期"要求：
 * - 初始化握手（含超时）；
 * - 取消未完成任务：结果永不暴露行动；
 * - 状态更新废弃旧任务：invalidate + 迟到响应双重防线；
 * - Worker 故障安全恢复：崩溃重生重试一次；二次失败回退；AI 异常不卡页面；
 * - 看门狗：预算超时强制终止 + 回退；
 * - 协议防火墙（真实 worker 路径）：越权载荷被拒且客户端仍可继续服务。
 *
 * 全部使用受控 fake worker（除防火墙端到端用真实 worker_threads），确定性、
 * 零真实搜索开销。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, applyAction } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai/observation.js';
import { createAIDecisionClient } from '../dist/js/ai-runtime/client.js';
import { spawnNodeAIWorker } from './ai-runtime-helpers.mjs';

/** 受控 fake worker：测试脚本手动投递响应/崩溃。 */
const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeWorker() {
  const w = {
    inbox: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(message) { w.inbox.push(message); },
    terminate() { w.terminated = true; },
    respond(data) { w.onmessage?.({ data }); },
    crash(message) { w.onerror?.({ message, preventDefault() {} }); },
    decisionRequests() { return w.inbox.filter(m => m.kind === 'decision'); },
  };
  return w;
}

function fakeSpawner(log, { autoReady = true } = {}) {
  const spawned = [];
  return {
    spawned,
    spawn() {
      const w = fakeWorker();
      const rawPost = w.postMessage.bind(w);
      w.postMessage = message => {
        rawPost(message);
        if (autoReady && message?.kind === 'init') {
          queueMicrotask(() => w.respond({ kind: 'ready', protocolVersion: '1.0.0' }));
        }
      };
      spawned.push(w);
      log?.push(w);
      return w;
    },
  };
}

const sampleObservation = () => buildObservation(createGame(['A', 'B', 'C'], 42, [1, 2]), 0);

const fakeDiagnostics = requestId => ({
  protocolVersion: '1.0.0', requestId, gameStateVersion: 0,
  ai: { jointVersion: 'joint-js5' }, budget: { mode: 'fixed-work', workUnits: 2 }, simSeed: 0,
  elapsedMs: 1, reason: 'fake', action: { type: 'rest' },
  stats: { rollouts: 1, transitions: 1, elapsedMs: 1, budgetExhausted: false, rootActions: 1, candidateCount: 1, worldsUsed: 1, omTimeMs: 0, cloneMs: 0, legalGenMs: 0 },
  gated: false, topEvaluations: [],
});

const decisionRequest = overrides => ({
  gameStateVersion: 1,
  observation: sampleObservation(),
  ai: { jointVersion: 'joint-js5' },
  budget: { mode: 'fixed-work', workUnits: 2 },
  simSeed: 1,
  expectedMs: 200,
  ...overrides,
});

test('初始化握手：init → ready；就绪后请求直达', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn });
  const readyPromise = client.ready();
  const first = spawner.spawned[0];
  assert.equal(first.inbox[0]?.kind, 'init');
  first.respond({ kind: 'ready', protocolVersion: '1.0.0' });
  await readyPromise;
  const outcomePromise = client.requestDecision(decisionRequest());
  await flush();
  const [request] = first.decisionRequests();
  assert.equal(request.kind, 'decision');
  assert.equal(request.payload.observation.merchantDeck, undefined, '请求载荷不得包含隐藏牌库');
  first.respond({ kind: 'decision', protocolVersion: '1.0.0', requestId: request.requestId, gameStateVersion: 1, diagnostics: fakeDiagnostics(request.requestId) });
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'decision');
  assert.deepEqual(outcome.action, { type: 'rest' });
  client.dispose();
});

test('握手超时：重生一次仍失败 → 显式失败而非悬挂', async () => {
  const spawner = fakeSpawner(null, { autoReady: false });
  const client = createAIDecisionClient({ spawn: spawner.spawn, initTimeoutMs: 60 });
  await assert.rejects(() => client.ready(), /握手超时/);
  assert.equal(spawner.spawned[0].terminated, true);
  client.dispose();
});

test('取消未完成任务：结果永不包含行动', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn });
  await client.ready();
  const outcomePromise = client.requestDecision(decisionRequest());
  await flush();
  const w = spawner.spawned[0];
  client.cancel('测试取消');
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.action, undefined, '取消结果不得携带行动');
  assert.equal(w.inbox.some(m => m.kind === 'cancel'), true, '应向 worker 发送 cancel');
  assert.equal(w.terminated, true, '取消应终止忙碌 worker');
  client.dispose();
});

test('状态更新废弃旧任务：invalidate 后迟到响应不暴露行动', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn });
  await client.ready();
  const w = spawner.spawned[0];
  const stalePromise = client.requestDecision(decisionRequest({ gameStateVersion: 1 }));
  await flush();
  client.invalidate(7);
  const stale = await stalePromise;
  assert.equal(stale.status, 'superseded');
  assert.equal(stale.action, undefined);
  // 旧 worker 已被终止；迟到的"决策结果"无人接收（client 侧 handler 已断开）。
  const staleRequest = w.decisionRequests()[0];
  assert.doesNotThrow(() => w.respond({ kind: 'decision', protocolVersion: '1.0.0', requestId: staleRequest.requestId, gameStateVersion: 1, diagnostics: fakeDiagnostics(staleRequest.requestId) }));
  client.dispose();
});

test('新请求替代旧请求：旧请求 superseded，新请求正常完成', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn });
  await client.ready();
  const oldWorker = spawner.spawned[0];
  const oldPromise = client.requestDecision(decisionRequest({ gameStateVersion: 1 }));
  await flush();
  const newPromise = client.requestDecision(decisionRequest({ gameStateVersion: 2, budget: { mode: 'fixed-work', workUnits: 2 } }));
  await flush();
  const old = await oldPromise;
  assert.equal(old.status, 'superseded');
  assert.equal(oldWorker.terminated, true, '被替代的忙碌 worker 应被终止');
  const newWorker = spawner.spawned[1];
  assert.ok(newWorker, '替代后应重生 worker');
  newWorker.respond({ kind: 'ready', protocolVersion: '1.0.0' });
  await flush();
  const [newRequest] = newWorker.decisionRequests();
  assert.equal(newRequest.gameStateVersion, 2);
  newWorker.respond({ kind: 'decision', protocolVersion: '1.0.0', requestId: newRequest.requestId, gameStateVersion: 2, diagnostics: fakeDiagnostics(newRequest.requestId) });
  const fresh = await newPromise;
  assert.equal(fresh.status, 'decision');
  client.dispose();
});

test('看门狗：预算超时强制终止并回退（AI 异常不卡页面）', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn, watchdogGraceMs: 40 });
  await client.ready();
  const t0 = performance.now();
  const outcome = await client.requestDecision(decisionRequest({
    budget: { mode: 'wall-clock', budgetMs: 30 },
  }));
  const elapsed = performance.now() - t0;
  assert.equal(outcome.status, 'fallback');
  assert.equal(outcome.cause, 'watchdog');
  assert.ok(outcome.action, '看门狗回退必须给出合法行动');
  assert.ok(elapsed >= 60, `看门狗过早触发：${elapsed.toFixed(0)}ms`);
  assert.ok(elapsed < 5000, '看门狗必须按时止损');
  assert.equal(spawner.spawned[0].terminated, true);
  const stats = client.stats();
  assert.equal(stats.watchdogKills, 1);
  client.dispose();
});

test('崩溃恢复：首次崩溃重生重试成功', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn });
  const readyPromise = client.ready();
  spawner.spawned[0].respond({ kind: 'ready', protocolVersion: '1.0.0' });
  await readyPromise;
  const outcomePromise = client.requestDecision(decisionRequest());
  await flush();
  // 第一个 worker 在决策中崩溃。
  spawner.spawned[0].crash('模拟 worker 崩溃');
  // 重生 worker 完成握手并响应决策。
  await flush();
  const reborn = spawner.spawned[1];
  assert.ok(reborn, '应重生新 worker');
  reborn.respond({ kind: 'ready', protocolVersion: '1.0.0' });
  await flush();
  const [retryRequest] = reborn.decisionRequests();
  assert.ok(retryRequest, '重生 worker 应收到重试决策请求');
  reborn.respond({ kind: 'decision', protocolVersion: '1.0.0', requestId: retryRequest.requestId, gameStateVersion: 1, diagnostics: fakeDiagnostics(retryRequest.requestId) });
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'decision', `崩溃恢复失败：${outcome.status}`);
  client.dispose();
});

test('连续故障：二次崩溃后回退合法行动，客户端不悬挂', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn });
  const readyPromise = client.ready();
  spawner.spawned[0].respond({ kind: 'ready', protocolVersion: '1.0.0' });
  await readyPromise;
  const outcomePromise = client.requestDecision(decisionRequest());
  await flush();
  spawner.spawned[0].crash('第一次崩溃');
  await flush();
  spawner.spawned[1].respond({ kind: 'ready', protocolVersion: '1.0.0' });
  await flush();
  spawner.spawned[1].crash('第二次崩溃');
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'fallback');
  assert.ok(outcome.cause === 'worker-error' || outcome.cause === 'spawn-failure');
  assert.ok(outcome.action, '连续故障仍须给出合法回退行动');
  client.dispose();
});

test('决策类异常：重试一次后回退（fallback action 合法）', async () => {
  const spawner = fakeSpawner();
  const client = createAIDecisionClient({ spawn: spawner.spawn });
  await client.ready();
  const w = spawner.spawned[0];
  const outcomePromise = client.requestDecision(decisionRequest());
  await flush();
  const [request] = w.decisionRequests();
  w.respond({ kind: 'error', protocolVersion: '1.0.0', requestId: request.requestId, message: '决策核心异常', category: 'decision' });
  await flush();
  const reborn = spawner.spawned[1];
  reborn.respond({ kind: 'ready', protocolVersion: '1.0.0' });
  await flush();
  const [retry] = reborn.decisionRequests();
  reborn.respond({ kind: 'error', protocolVersion: '1.0.0', requestId: retry.requestId, message: '决策核心仍异常', category: 'decision' });
  const outcome = await outcomePromise;
  assert.equal(outcome.status, 'fallback');
  assert.equal(outcome.cause, 'worker-error');
  assert.doesNotThrow(() => applyAction(createGame(['A', 'B', 'C'], 42, [1, 2]), outcome.action), '回退行动必须合法');
  client.dispose();
});

test('协议防火墙（真实 worker）：越权载荷被拒，客户端继续可用', async () => {
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  try {
    await client.ready();
    const poisoned = { ...sampleObservation(), merchantDeck: ['M01', 'M02'] };
    const bad = await client.requestDecision(decisionRequest({ observation: poisoned, expectedMs: 3000 }));
    assert.equal(bad.status, 'fallback', '越权载荷必须走回退');
    assert.match(bad.error ?? '', /防火墙/);
    assert.doesNotThrow(() => applyAction(createGame(['A', 'B', 'C'], 42, [1, 2]), bad.action), '回退行动必须合法');
    // 客户端未损坏：干净请求仍然成功。
    const good = await client.requestDecision(decisionRequest({ expectedMs: 3000 }));
    assert.equal(good.status, 'decision');
    client.dispose();
  } finally {
    client.dispose();
  }
});
