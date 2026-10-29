/** P2.2：持久化任务队列与状态机（崩溃安全、幂等提交、种子预留）。
 *
 * 状态机：PENDING → CLAIMED → RUNNING → COMMITTING → DONE
 * 异常分支：FAILED / CANCELLED / RETRYING；进程崩溃后由 recover() 依据 pid 存活
 * 状态把 CLAIMED/RUNNING 任务恢复为 PENDING 或标记 FAILED（不重复提交）。
 *
 * 持久化方式：
 * - `queue/state.json`：任务快照（原子写：tmp + rename）；
 * - `queue/events.jsonl`：append-only 事件日志（审计与崩溃后续接）；
 * - `queue/commits/<key>.json`：幂等提交标记（同一 taskId+commitKey 只允许一次）。
 *
 * 种子预留：`reserveSeeds()` 在**执行前**记录预留区间；`consumeSeeds()` 只在
 * 任务真正完成后标记消耗。崩溃后预留仍然有效，禁止当作"全新样本"再次使用。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertCondition, sha256Canonical } from './core.mjs';

export const TASK_STATES = Object.freeze([
  'PENDING', 'CLAIMED', 'RUNNING', 'COMMITTING', 'DONE', 'FAILED', 'CANCELLED', 'RETRYING',
]);

function atomicWrite(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 打开任务队列。
 *
 * @param {object} options
 * @param {string} options.rootDir 队列根目录（<campaign>/queue）
 */
export function openTaskQueue({ rootDir }) {
  const root = resolve(rootDir);
  const statePath = join(root, 'state.json');
  const eventsPath = join(root, 'events.jsonl');
  const commitsDir = join(root, 'commits');
  const reservationsPath = join(root, 'seed-reservations.json');
  mkdirSync(commitsDir, { recursive: true });

  function load() {
    if (!existsSync(statePath)) {
      return { schema: 'century-task-queue-v1', createdAt: nowIso(), updatedAt: nowIso(), tasks: [], seedReservations: [] };
    }
    const state = readJSON(statePath);
    assertCondition(state.schema === 'century-task-queue-v1', '任务队列 schema 非法');
    return state;
  }

  function save(state) {
    state.updatedAt = nowIso();
    atomicWrite(statePath, state);
  }

  function event(state, taskId, type, payload = {}) {
    const record = { at: nowIso(), taskId, type, payload, seq: (state.seq = (state.seq ?? 0) + 1) };
    const line = `${JSON.stringify(record)}\n`;
    // append-only：直接追加，不重写历史（崩溃最多丢弃最后一行不完整记录）
    if (!existsSync(eventsPath)) writeFileSync(eventsPath, line);
    else writeFileSync(eventsPath, line, { flag: 'a' });
    return record;
  }

  return {
    root,
    eventsPath,

    /** 幂等入队：同一 dedupeKey 只创建一个任务。 */
    enqueue({ kind, payload = {}, dedupeKey = null, maxAttempts = 3 }) {
      assertCondition(typeof kind === 'string' && kind.length > 0, '任务必须提供 kind');
      const state = load();
      if (dedupeKey) {
        const existing = state.tasks.find(t => t.dedupeKey === dedupeKey);
        if (existing) return { task: existing, created: false };
      }
      const taskId = `task-${sha256Canonical({ kind, payload, dedupeKey, seq: state.tasks.length + 1 }).slice(0, 16)}`;
      const task = {
        taskId, kind, payload, dedupeKey, maxAttempts, attempts: 0,
        state: 'PENDING', createdAt: nowIso(), updatedAt: nowIso(),
        pid: null, claimedAt: null, startedAt: null, committedAt: null,
        lastError: null, commitKey: null,
      };
      state.tasks.push(task);
      event(state, taskId, 'enqueued', { kind });
      save(state);
      return { task, created: true };
    },

    /** 认领：原子地把 PENDING → CLAIMED（单写者进程模型下用文件锁略）。 */
    claim({ taskId, pid = null }) {
      const state = load();
      const task = state.tasks.find(t => t.taskId === taskId);
      assertCondition(task, `任务不存在：${taskId}`);
      assertCondition(task.state === 'PENDING' || task.state === 'RETRYING',
        `任务 ${taskId} 状态 ${task.state} 不可认领`);
      task.state = 'CLAIMED';
      task.pid = pid;
      task.claimedAt = nowIso();
      task.attempts += 1;
      task.updatedAt = nowIso();
      event(state, taskId, 'claimed', { pid, attempt: task.attempts });
      save(state);
      return task;
    },

    start({ taskId, pid = null }) {
      const state = load();
      const task = state.tasks.find(t => t.taskId === taskId);
      assertCondition(task && task.state === 'CLAIMED', `任务 ${taskId} 不能从 ${task?.state} 进入 RUNNING`);
      task.state = 'RUNNING';
      task.pid = pid ?? task.pid;
      task.startedAt = nowIso();
      task.updatedAt = nowIso();
      event(state, taskId, 'running', { pid: task.pid });
      save(state);
      return task;
    },

    /** 进入提交阶段（对外部副作用已经发生但结果尚未确认的窗口）。 */
    beginCommit({ taskId, commitKey }) {
      const state = load();
      const task = state.tasks.find(t => t.taskId === taskId);
      assertCondition(task && task.state === 'RUNNING', `任务 ${taskId} 不能从 ${task?.state} 进入 COMMITTING`);
      task.state = 'COMMITTING';
      task.commitKey = commitKey;
      task.updatedAt = nowIso();
      event(state, taskId, 'committing', { commitKey });
      save(state);
      return task;
    },

    /**
     * 幂等提交：同一 commitKey 只允许一次；重复调用返回已有结果。
     * 用于"实验结果入库/冠军请求"等外部副作用。
     */
    commit({ taskId, commitKey, result = null }) {
      assertCondition(typeof commitKey === 'string' && commitKey.length > 0, 'commit 必须提供 commitKey');
      const state = load();
      const task = state.tasks.find(t => t.taskId === taskId);
      assertCondition(task, `任务不存在：${taskId}`);
      const markerPath = join(commitsDir, `${sha256Canonical({ taskId, commitKey }).slice(0, 32)}.json`);
      if (existsSync(markerPath)) {
        return { committed: false, duplicate: true, existing: readJSON(markerPath) };
      }
      const marker = { taskId, commitKey, result, committedAt: nowIso() };
      atomicWrite(markerPath, marker);
      task.state = 'DONE';
      task.committedAt = marker.committedAt;
      task.updatedAt = marker.committedAt;
      event(state, taskId, 'committed', { commitKey });
      save(state);
      return { committed: true, duplicate: false, existing: marker };
    },

    fail({ taskId, error, retry = true }) {
      const state = load();
      const task = state.tasks.find(t => t.taskId === taskId);
      assertCondition(task, `任务不存在：${taskId}`);
      task.lastError = String(error).slice(0, 800);
      task.state = retry && task.attempts < task.maxAttempts ? 'RETRYING' : 'FAILED';
      task.updatedAt = nowIso();
      event(state, taskId, 'failed', { error: task.lastError, retry: task.state === 'RETRYING' });
      save(state);
      return task;
    },

    cancel({ taskId, reason = 'operator' }) {
      const state = load();
      const task = state.tasks.find(t => t.taskId === taskId);
      assertCondition(task, `任务不存在：${taskId}`);
      task.state = 'CANCELLED';
      task.updatedAt = nowIso();
      event(state, taskId, 'cancelled', { reason });
      save(state);
      return task;
    },

    /**
     * 崩溃恢复：CLAIMED/RUNNING 且持有进程已死亡的 
     * → 若仍可重试则 RETRYING，否则 FAILED；COMMITTING 保持等待人工/自动核对。
     */
    recover(options = {}) {
      const isPidAlive = options.isPidAlive ?? (pid => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      const state = load();
      const recovered = [];
      for (const task of state.tasks) {
        if (!['CLAIMED', 'RUNNING', 'COMMITTING'].includes(task.state)) continue;
        if (task.pid && isPidAlive(task.pid)) continue;
        if (task.state === 'COMMITTING') {
          recovered.push({ taskId: task.taskId, state: 'COMMITTING', action: 'needs-verification' });
          continue;
        }
        const next = task.attempts < task.maxAttempts ? 'RETRYING' : 'FAILED';
        task.state = next;
        task.updatedAt = nowIso();
        event(state, task.taskId, 'recovered', { from: 'CLAIMED/RUNNING', to: next });
        recovered.push({ taskId: task.taskId, action: next });
      }
      save(state);
      return recovered;
    },

    /** 执行前持久预留种子区间（崩溃后仍然占用，绝不复用）。 */
    reserveSeeds({ reservationId, purpose, base, count, taskId = null }) {
      assertCondition(Number.isSafeInteger(base) && Number.isSafeInteger(count) && count > 0,
        '种子预留需要合法 base/count');
      const state = load();
      if (!state.seedReservations) state.seedReservations = [];
      const existing = state.seedReservations.find(r => r.reservationId === reservationId);
      if (existing) return { reservation: existing, created: false };
      const overlap = state.seedReservations.find(r => base < r.base + r.count && r.base < base + count);
      assertCondition(!overlap, `种子预留与 ${overlap?.reservationId} 重叠（禁止重复使用区间）`);
      const reservation = {
        reservationId, purpose, base, count, taskId,
        reservedAt: nowIso(), consumed: false, consumedAt: null,
      };
      state.seedReservations.push(reservation);
      event(state, taskId ?? 'seed', 'seed-reserved', { reservationId, base, count });
      save(state);
      return { reservation, created: true };
    },

    consumeSeeds({ reservationId }) {
      const state = load();
      const reservation = (state.seedReservations ?? []).find(r => r.reservationId === reservationId);
      assertCondition(reservation, `种子预留不存在：${reservationId}`);
      if (reservation.consumed) return reservation;
      reservation.consumed = true;
      reservation.consumedAt = nowIso();
      event(state, reservation.taskId ?? 'seed', 'seed-consumed', { reservationId });
      save(state);
      return reservation;
    },

    list({ state: filterState = null } = {}) {
      const state = load();
      return filterState ? state.tasks.filter(t => t.state === filterState) : state.tasks;
    },

    snapshot() {
      const state = load();
      return {
        schema: state.schema,
        tasks: state.tasks.length,
        byState: state.tasks.reduce((acc, t) => ({ ...acc, [t.state]: (acc[t.state] ?? 0) + 1 }), {}),
        seedReservations: (state.seedReservations ?? []).length,
        commits: existsSync(commitsDir) ? readdirSync(commitsDir).filter(f => f.endsWith('.json')).length : 0,
      };
    },

    clearCommitMarker({ commitKey, taskId }) {
      const markerPath = join(commitsDir, `${sha256Canonical({ taskId, commitKey }).slice(0, 32)}.json`);
      if (existsSync(markerPath)) unlinkSync(markerPath);
      return true;
    },
  };
}
