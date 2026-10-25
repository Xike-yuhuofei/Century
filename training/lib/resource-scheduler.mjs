/** P5：M4 资源感知调度（CPU / 内存 / 磁盘 / 并发）。
 *
 * 原则：资源不足时安全降载或停止，绝不以"跑得更久"冒充更强算法；
 * 成功指标是单位计算成本获得的真实第一名率改进，而不是 GPU 利用率或代数。
 */

import os from 'node:os';
import { statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

/** macOS 的 os.freemem() 只统计完全空闲页；inactive/speculative/purgeable 页
 * 可被立即回收。直接用 free 会在内存充足时误判（实测 2.5%），因此用 vm_stat
 * 计算「可回收可用内存」。非 darwin 平台退回 os.freemem()。 */
function availableMemoryBytes() {
  if (os.platform() !== 'darwin') return os.freemem();
  try {
    const output = execFileSync('vm_stat', { encoding: 'utf8', timeout: 5000 });
    const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 4096);
    const pages = key => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(output)?.[1] ?? 0);
    const free = pages('Pages free');
    const inactive = pages('Pages inactive');
    const speculative = pages('Pages speculative');
    const purgeable = pages('Pages purgeable');
    return (free + inactive + speculative + purgeable) * pageSize;
  } catch {
    return os.freemem();
  }
}

export function resourceSnapshot() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const availableMem = availableMemoryBytes();
  let freeDisk = null;
  try {
    const stats = statfsSync(REPO_ROOT);
    freeDisk = stats.bavail * stats.bsize;
  } catch { /* 非 POSIX/受限环境：磁盘检查降级为未知 */ }
  return {
    at: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    totalMem,
    freeMem,
    availableMem,
    freeMemRatio: totalMem > 0 ? Number((freeMem / totalMem).toFixed(4)) : 0,
    availableMemRatio: totalMem > 0 ? Number((availableMem / totalMem).toFixed(4)) : 0,
    usedMem: totalMem - availableMem,
    freeDisk,
    processRss: process.memoryUsage().rss,
  };
}

/**
 * 容量判定。
 *
 * @param {object} [options]
 * @param {number} [options.requestedConcurrency]
 * @param {number} [options.minFreeMemRatio] 最低空闲内存比例（默认 12%）
 * @param {number} [options.maxLoadPerCore] 每个逻辑核允许的 1 分钟负载（默认 1.6）
 * @param {number} [options.minFreeDiskBytes] 最低磁盘剩余（默认 2 GiB）
 */
export function evaluateCapacity({
  requestedConcurrency = 1,
  minFreeMemRatio = 0.12,
  maxLoadPerCore = 1.6,
  minFreeDiskBytes = 2 * 1024 ** 3,
  snapshot: injectedSnapshot = null,
} = {}) {
  const snapshot = injectedSnapshot ?? resourceSnapshot();
  const reasons = [];
  const perCoreLoad = snapshot.cpuCount > 0 ? snapshot.loadAverage[0] / snapshot.cpuCount : 99;
  const freeMemRatio = snapshot.availableMemRatio ?? (snapshot.totalMem > 0 ? snapshot.availableMem / snapshot.totalMem : 0);
  let capacity = Math.max(1, snapshot.cpuCount - 2);

  if (perCoreLoad > maxLoadPerCore) reasons.push(`1 分钟负载 ${perCoreLoad.toFixed(2)}/核 超过 ${maxLoadPerCore}`);
  if (freeMemRatio < minFreeMemRatio) reasons.push(`空闲内存比例 ${(freeMemRatio * 100).toFixed(1)}% 低于 ${(minFreeMemRatio * 100).toFixed(0)}%`);
  if (snapshot.freeDisk !== null && snapshot.freeDisk < minFreeDiskBytes) {
    reasons.push(`磁盘剩余 ${(snapshot.freeDisk / 1024 ** 3).toFixed(1)} GiB 低于 ${(minFreeDiskBytes / 1024 ** 3).toFixed(0)} GiB`);
  }
  if (freeMemRatio < 0.06) capacity = 1;

  const allowedConcurrency = Math.max(1, Math.min(requestedConcurrency, capacity));
  const action = reasons.length === 0
    ? 'run'
    : (freeMemRatio < 0.06 ? 'stop' : 'reduce');
  return {
    ok: action !== 'stop',
    action,
    allowedConcurrency,
    requestedConcurrency,
    reasons,
    perCoreLoad,
    freeMemRatio,
    snapshot,
  };
}

/** 长时间运行前的硬检查：不满足安全条件直接抛错（fail-closed）。 */
export function assertResourceBudget(options = {}) {
  const verdict = evaluateCapacity(options);
  if (!verdict.ok) {
    throw new Error(`资源预算不足，拒绝启动长时间训练：${verdict.reasons.join('；')}`);
  }
  return verdict;
}
