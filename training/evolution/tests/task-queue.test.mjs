/** P2.2 验收：持久任务队列状态机、崩溃恢复、幂等提交、种子预留。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskQueue, TASK_STATES } from '../task-queue.mjs';

function tempQueue() {
  return openTaskQueue({ rootDir: mkdtempSync(join(tmpdir(), 'ai11-queue-')) });
}

test('状态机：PENDING→CLAIMED→RUNNING→COMMITTING→DONE', () => {
  const queue = tempQueue();
  const { task } = queue.enqueue({ kind: 'eval', payload: { seed: 1 } });
  assert.equal(task.state, 'PENDING');
  queue.claim({ taskId: task.taskId, pid: 999 });
  assert.equal(queue.list()[0].state, 'CLAIMED');
  queue.start({ taskId: task.taskId, pid: 999 });
  assert.equal(queue.list()[0].state, 'RUNNING');
  queue.beginCommit({ taskId: task.taskId, commitKey: 'k1' });
  assert.equal(queue.list()[0].state, 'COMMITTING');
  queue.commit({ taskId: task.taskId, commitKey: 'k1', result: { ok: true } });
  assert.equal(queue.list()[0].state, 'DONE');
  for (const entry of queue.list()) assert.ok(TASK_STATES.includes(entry.state));
});

test('幂等提交：同一 commitKey 第二次返回 duplicate，且不覆盖结果', () => {
  const queue = tempQueue();
  const { task } = queue.enqueue({ kind: 'commit', payload: {} });
  queue.claim({ taskId: task.taskId });
  queue.start({ taskId: task.taskId });
  queue.beginCommit({ taskId: task.taskId, commitKey: 'result-1' });
  const first = queue.commit({ taskId: task.taskId, commitKey: 'result-1', result: { value: 1 } });
  const second = queue.commit({ taskId: task.taskId, commitKey: 'result-1', result: { value: 2 } });
  assert.equal(first.committed, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.existing.result.value, 1, '重复提交不得覆盖已确认结果');
});

test('崩溃恢复：持有进程已死亡的 RUNNING 任务回到 RETRYING；存活则保持', () => {
  const queue = tempQueue();
  const { task } = queue.enqueue({ kind: 'run', payload: {}, maxAttempts: 3 });
  queue.claim({ taskId: task.taskId, pid: 111 });
  queue.start({ taskId: task.taskId, pid: 111 });
  const dead = queue.recover({ isPidAlive: () => false });
  assert.equal(dead[0].action, 'RETRYING');
  assert.equal(queue.list()[0].state, 'RETRYING');

  const other = queue.enqueue({ kind: 'run2', payload: {}, maxAttempts: 3 }).task;
  queue.claim({ taskId: other.taskId, pid: 222 });
  queue.start({ taskId: other.taskId, pid: 222 });
  const alive = queue.recover({ isPidAlive: () => true });
  assert.equal(queue.list().find(t => t.taskId === other.taskId).state, 'RUNNING',
    '存活进程持有的任务不得被抢占');
  assert.equal(alive.length, 0);
});

test('COMMITTING 崩溃 → 标记 needs-verification，不自动重做提交', () => {
  const queue = tempQueue();
  const { task } = queue.enqueue({ kind: 'commit', payload: {} });
  queue.claim({ taskId: task.taskId, pid: 333 });
  queue.start({ taskId: task.taskId, pid: 333 });
  queue.beginCommit({ taskId: task.taskId, commitKey: 'k' });
  const recovered = queue.recover({ isPidAlive: () => false });
  assert.equal(recovered[0].state, 'COMMITTING');
  assert.equal(recovered[0].action, 'needs-verification');
});

test('有界重试：attempts 达到 maxAttempts 后进入 FAILED，而不是无限 RETRYING', () => {
  const queue = tempQueue();
  const { task } = queue.enqueue({ kind: 'run', payload: {}, maxAttempts: 2 });
  queue.claim({ taskId: task.taskId });
  queue.start({ taskId: task.taskId });
  queue.fail({ taskId: task.taskId, error: 'boom', retry: true });
  assert.equal(queue.list()[0].state, 'RETRYING');
  queue.claim({ taskId: task.taskId });
  queue.start({ taskId: task.taskId });
  queue.fail({ taskId: task.taskId, error: 'boom2', retry: true });
  assert.equal(queue.list()[0].state, 'FAILED');
});

test('种子预留：执行前持久化、重叠拒绝、完成后才标记消耗', () => {
  const queue = tempQueue();
  const a = queue.reserveSeeds({ reservationId: 'r1', purpose: 'deep', base: 1000, count: 10 });
  assert.equal(a.created, true);
  assert.equal(queue.snapshot().seedReservations, 1);
  assert.throws(() => queue.reserveSeeds({ reservationId: 'r2', purpose: 'deep', base: 1005, count: 10 }),
    /重叠/);
  // 模拟崩溃：重新打开队列，预留仍在
  const reopened = openTaskQueue({ rootDir: queue.root });
  assert.equal(reopened.snapshot().seedReservations, 1);
  reopened.consumeSeeds({ reservationId: 'r1' });
  assert.equal(reopened.snapshot().seedReservations, 1);
});

test('事件日志 append-only 且包含关键状态迁移', () => {
  const queue = tempQueue();
  const { task } = queue.enqueue({ kind: 'x', payload: {} });
  queue.claim({ taskId: task.taskId });
  queue.start({ taskId: task.taskId });
  queue.commit({ taskId: task.taskId, commitKey: 'c' });
  const events = readFileSync(queue.eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
  const types = events.map(e => e.type);
  assert.deepEqual(types.slice(0, 4), ['enqueued', 'claimed', 'running', 'committed']);
  assert.ok(events.every(e => Number.isSafeInteger(e.seq)));
  assert.ok(existsSync(join(queue.root, 'commits')));
  assert.equal(readdirSync(join(queue.root, 'commits')).filter(f => f.endsWith('.json')).length, 1);
});
