#!/usr/bin/env node
/** Century 自对战并行吞吐量基准（任务三）。
 *
 * 使用正式训练模拟器（web-v1/dist 编译产物 + AI 4.0 冠军参数），逐级测量 1/2/4/8 worker 的
 * 对局吞吐、CPU 占用与内存占用，评估多进程扩展效率。
 * 纪律：不修改 AI 4.0 算法代码；结果记录 Git Commit SHA 便于后续对比。
 *
 * 运行：node exp3_selfplay_benchmark.mjs [--games-per-worker 30]
 */

import { spawn, spawnSync, fork } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAINING_ROOT = resolve(HERE, '..', '..', 'training');
const SEED_BASE = 5_000_000; // 独立种子段，避开 900M 确认挑战账本与既有 3000 基准段

const args = process.argv.slice(2);
const gpwIdx = args.indexOf('--games-per-worker');
const GAMES_PER_WORKER = gpwIdx >= 0 ? Number(args[gpwIdx + 1]) : 30;
const WORKER_LEVELS = [1, 2, 4, 8];

if (!Number.isSafeInteger(GAMES_PER_WORKER) || GAMES_PER_WORKER < 1) throw new Error('--games-per-worker 必须为正整数');

// 编译产物存在性检查（与训练系统同一约定）
const fs = await import('node:fs');
for (const f of ['engine.js', 'ai.js']) {
  if (!fs.existsSync(resolve(TRAINING_ROOT, '..', 'web-v1', 'dist', 'js', f))) {
    throw new Error(`缺少 web-v1/dist/js/${f}，请先构建`);
  }
}

function gitSha() {
  try {
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(HERE, '..', '..'), encoding: 'utf8' }).stdout.trim();
  } catch { return 'unknown'; }
}

/** 周期性异步采样各 worker 的 ps %cpu 与 rss（不阻塞事件循环，保证 IPC 消息可被处理）。 */
async function sampleProcesses(pids, stopFlagRef) {
  const samples = [];
  const psArgs = ['-o', '%cpu=,rss=', '-p', pids.join(',')];
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  let failCount = 0, lastErr = '';
  while (!stopFlagRef.stop) {
    try {
      const out = await new Promise((res, rej) => {
        const proc = spawn('ps', psArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
        let buf = '';
        proc.stdout.on('data', d => { buf += d; });
        proc.on('close', code => code === 0 ? res(buf) : rej(new Error(`ps 退出码 ${code}`)));
        proc.on('error', rej);
      });
      let cpu = 0, rssKB = 0, rows = 0;
      for (const line of out.split('\n')) {
        const m = line.trim().split(/\s+/);
        if (m.length >= 2) { cpu += Number(m[0]) || 0; rssKB += Number(m[1]) || 0; rows++; }
      }
      if (rows > 0) samples.push({ cpuPercent: cpu, rssMB: rssKB / 1024 });
    } catch (e) { failCount++; lastErr = e.message; }
    await sleep(500);
  }
  sampleProcesses.lastDebug = { failCount, lastErr, ok: samples.length };
  return samples;
}

// —— 主流程 ——
const commit = gitSha();
console.log(`Git Commit: ${commit}`);
console.log(`每 worker 对局数: ${GAMES_PER_WORKER}，种子段: ${SEED_BASE}+`);

const levels = [];
for (const n of WORKER_LEVELS) {
  const stopFlagRef = { stop: false };
  const t0 = performance.now();

  // 启动 workers
  const children = [];
  const pids = [];
  const donePayloads = [];
  const exitPromises = [];
  let finished = 0;
  let endTs = null;
  for (let w = 0; w < n; w++) {
    const child = fork(resolve(HERE, 'exp3_worker.mjs'), [], {
      env: {
        ...process.env,
        games: String(GAMES_PER_WORKER),
        seedBase: String(SEED_BASE + w * 1000),
        workerId: String(w),
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    pids.push(child.pid);
    exitPromises.push(new Promise(res => child.on('exit', res)));
    child.on('message', (msg) => {
      if (msg.type === 'done') {
        donePayloads.push(msg);
        finished++;
        if (finished === n) {
          endTs = performance.now();
          stopFlagRef.stop = true;
        }
      }
    });
    children.push(child);
  }

  const samplingPromise = sampleProcesses(pids, stopFlagRef);
  await Promise.all(exitPromises);
  if (endTs === null) throw new Error(`workers=${n} 有 worker 未上报完成结果`);
  const wallMs = endTs - t0;
  const samples = await samplingPromise;

  const allGames = donePayloads.flatMap(d => d.games);
  const totalGames = allGames.length;
  const anomalies = allGames.filter(g => g.status !== 'finished').length;
  const meanWallMs = totalGames ? allGames.reduce((s, g) => s + g.wallMs, 0) / totalGames : 0;
  const meanMoves = totalGames ? allGames.reduce((s, g) => s + g.moves, 0) / totalGames : 0;
  const meanCpu = samples.length ? samples.reduce((s, x) => s + x.cpuPercent, 0) / samples.length : 0;
  const maxRss = samples.length ? Math.max(...samples.map(x => x.rssMB)) : 0;
  const meanRssSum = samples.length ? samples.reduce((s, x) => s + x.rssMB, 0) / samples.length : 0;
  const workerRss = donePayloads.map(d => d.rssMB);

  const level = {
    workers: n,
    totalGames,
    anomalies,
    wallMs: Math.round(wallMs),
    gamesPerMinute: Number((totalGames / (wallMs / 60000)).toFixed(1)),
    gamesPerHour: Math.round(totalGames / (wallMs / 3.6e6)),
    meanGameWallMs: Math.round(meanWallMs),
    meanMovesPerGame: Number(meanMoves.toFixed(1)),
    meanCpuPercent: Number(meanCpu.toFixed(1)),
    cpuCoresEquivalent: Number((meanCpu / 100).toFixed(2)),
    aggregateRssMB_mean: Math.round(meanRssSum),
    aggregateRssMB_max: Math.round(maxRss),
    workerRssMB_reported: workerRss,
  };
  levels.push(level);
  console.log(`${n} worker: ${totalGames} 局（异常 ${anomalies}），${level.gamesPerMinute} 局/分，` +
    `CPU ${level.cpuCoresEquivalent} 核当量，RSS 均值 ${level.aggregateRssMB_mean}MB ` +
    `[采样 ok=${sampleProcesses.lastDebug?.ok} fail=${sampleProcesses.lastDebug?.failCount} ${sampleProcesses.lastDebug?.lastErr}]`);
}

const single = levels.find(l => l.workers === 1);
for (const l of levels) {
  l.scalingEfficiency = single ? Number((l.gamesPerHour / single.gamesPerHour / l.workers * 100).toFixed(1)) : null;
}

const summary = {
  generated_at: new Date().toISOString(),
  git_commit: commit,
  gamesPerWorker: GAMES_PER_WORKER,
  seedBase: SEED_BASE,
  engine: 'web-v1/dist/js（与正式游戏同一编译产物）+ AI 4.0 冠军参数',
  levels,
  notes: 'CPU% 来自 ps 周期采样（500ms），macOS ps %cpu 单进程可超过 100（每核 100%）；RSS 为采样期聚合值。',
};

const outDir = resolve(HERE, 'results');
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, 'selfplay_benchmark.json');
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\n结果已写入: ${out}`);
console.table(levels.map(l => ({
  workers: l.workers, gamesPerHour: l.gamesPerHour, cpuCores: l.cpuCoresEquivalent,
  rssMB: l.aggregateRssMB_mean, efficiency: l.scalingEfficiency + '%',
})));
