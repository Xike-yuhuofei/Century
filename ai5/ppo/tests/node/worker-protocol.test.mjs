/** 对局宿主进程协议测试：真实子进程完整对局、决策-行动往返、异常上报、复现性。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, '../../bridge/env_worker.mjs');

class WorkerHarness {
  constructor() {
    this.proc = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.queue = [];
    this.waiters = [];
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter(msg); else this.queue.push(msg);
      }
    });
  }
  send(msg) { this.proc.stdin.write(JSON.stringify(msg) + '\n'); }
  next(timeoutMs = 90_000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker 响应超时')), timeoutMs);
      this.waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  }
  close() { this.send({ type: 'close' }); return new Promise(r => setTimeout(r, 200)); }
}

test('全 node 席位完整对局并按种子复现', async () => {
  const w = new WorkerHarness();
  const seats = Array.from({ length: 5 }, () => ({ kind: 'node', variant: 'champion' }));
  const run = async (seed) => {
    w.send({ type: 'game', gameId: seed, seed, seats });
    const msg = await w.next();
    assert.equal(msg.type, 'terminal');
    return msg;
  };
  const a = await run(20260321);
  assert.equal(a.status, 'finished');
  assert.ok(a.moves > 20 && a.moves < 1200, `步数异常：${a.moves}`);
  const b = await run(20260321);
  assert.deepEqual(b.scores, a.scores, '同种子必须逐位复现');
  assert.equal(b.winnerSeat, a.winnerSeat);
  assert.equal(b.moves, a.moves);
  await w.close();
});

test('MLP 席位往返：决策→行动→终局，随机合法策略零异常', async () => {
  const w = new WorkerHarness();
  w.send({
    type: 'game', gameId: 1, seed: 777,
    seats: [{ kind: 'mlp' }, { kind: 'mlp' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'profile-2' }, { kind: 'node', variant: 'neutral' }],
  });
  let decisions = 0;
  for (;;) {
    const msg = await w.next();
    assert.equal(msg.type !== 'fatal', true, `fatal：${msg.reason}`);
    if (msg.type === 'terminal') {
      assert.equal(msg.status, 'finished', `异常局：${msg.reason}`);
      assert.ok(decisions > 10);
      assert.equal(msg.scores.length, 5);
      assert.ok(msg.enumAgg.meanFull > 0);
      break;
    }
    assert.equal(msg.obs.len, 1419);
    assert.equal(msg.candMat.rows, msg.candidates.length);
    assert.equal(msg.candMat.cols, 84);
    // 随机合法行动。
    w.send({ type: 'action', gameId: msg.gameId, index: (decisions * 11 + 5) % msg.candidates.length });
    decisions++;
  }
  await w.close();
});

test('回传越界序号被如实记为异常对局（不静默修正）', async () => {
  const w = new WorkerHarness();
  w.send({ type: 'game', gameId: 1, seed: 5, seats: [{ kind: 'mlp' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'champion' }] });
  const decision = await w.next();
  assert.equal(decision.type, 'decision');
  w.send({ type: 'action', gameId: 1, index: decision.candidates.length + 100 });
  const msg = await w.next();
  assert.equal(msg.type, 'terminal');
  assert.equal(msg.status, 'anomaly');
  assert.match(msg.reason, /越界/);
  await w.close();
});
