/** 性能基准（AI6 第一阶段任务 D：Mac mini M4 / 16GB 环境标定）。
 *
 * 测量项（全部注明 commit、环境、玩家人数、worker 数与配置）：
 * - engine transition/s：纯引擎微基准——录制一局行动序列后重放
 *   createGame + applyAction（不含 AI 决策），迁移数 ÷ 纯引擎时间；
 * - search 决策吞吐：AI 决策/秒（ 决策数 ÷ 总决策时间；
 *   搜索节点展开率未在冻结 bundle 中暴露，列为下一阶段接口建议，见报告）；
 * - games/h：单核每玩家数局/小时；
 * - 单次 AI 决策时间：均值 + p50/p95/p99（collectDecisions 遥测）；
 * - CPU / 内存：process.cpuUsage 与 process.memoryUsage（Node 单进程，无 GPU 参与计算，
 *   GPU 列为 N/A）。
 *
 * 预热后计量（JIT 稳定）；对局结果确定性不受计时影响。
 */

import { performance } from 'node:perf_hooks';
import os_ from 'node:os';
import { execSync } from 'node:child_process';
import { createGame, applyAction } from '../../web-v1/dist/js/engine.js';
import { simulateGame } from '../simulator/simulate.mjs';
import { requireBuiltEngine, REPO_ROOT, engineBundleSha256 } from '../lib/paths.mjs';
import { latencySummary } from './stats.mjs';
import { writeJSON, ensureDir } from '../lib/io.mjs';
import { resolve } from 'node:path';

/** 性能基准固定诊断种子（perf 子块头部偏移；非统计样本，不参与账本消费，
 * 结果不用于胜率/第一名率断言，只用于吞吐与延迟标定）。 */
export const PERF_SEED_BASE = 1_109_000_000;

/** 纯引擎重放微基准：录制行动序列 → 重放 createGame+applyAction 计时。
 * 行动合法性由正式引擎逐条校验（重放失败直接抛错，不出假吞吐）。 */
export function engineReplayBenchmark({ seed, seatCount, warmup = 1, replays = 3 }) {
  requireBuiltEngine();
  // 录制：默认版本（当前冠军参数区）跑一局，collectActions 拿逐行动记录。
  const recorded = simulateGame({ seed, seatCount, collectActions: true });
  if (recorded.status !== 'finished') {
    throw new Error(`录制局异常（${recorded.reason}），无法建立引擎重放基准`);
  }
  const actions = recorded.actions.map(a => a.action);
  const names = Array.from({ length: seatCount }, (_, i) => `席位${i}`);
  const aiSeats = Array.from({ length: seatCount - 1 }, (_, i) => i + 1);

  const replayOnce = () => {
    let game = createGame(names, seed, aiSeats);
    game.players[0].isAI = true; // 与训练模拟一致的席位语义（不影响引擎计时）
    for (const action of actions) {
      game = applyAction(game, action);
    }
    if (game.phase !== 'finished') throw new Error('重放未达终局：行动序列与种子不匹配');
  };

  for (let i = 0; i < warmup; i++) replayOnce();
  const start = performance.now();
  for (let i = 0; i < replays; i++) replayOnce();
  const elapsedMs = performance.now() - start;
  return {
    seed, seatCount,
    recordedMoves: recorded.moves,
    replays,
    engineTransitionsPerSec: Math.round((recorded.moves * replays) / (elapsedMs / 1000)),
    msPerTransition: Number((elapsedMs / (recorded.moves * replays)).toFixed(4)),
  };
}

/** 运行环境元数据（所有结果必须随附）。 */
export function environmentInfo() {
  const cpu = os_.cpus()[0];
  let repoCommit = null;
  try {
    repoCommit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch { /* 非 git 环境容忍 */ }
  return {
    nodeVersion: process.version,
    platform: `${os_.platform()} ${os_.arch()}`,
    cpuModel: cpu?.model?.trim() ?? 'unknown',
    cpuCores: os_.cpus().length,
    memoryTotalGB: Number((os_.totalmem() / 2 ** 30).toFixed(1)),
    loadavg1m: os_.loadavg()[0].toFixed(2),
    workers: 1,
    repoCommit,
    engineBundleSha256: engineBundleSha256(),
    measuredAt: new Date().toISOString(),
  };
}

/** 每玩家数的完整性能画像：games/h、决策吞吐、延迟分位数、CPU/内存。
 * cpuPercent 为单进程 CPU 时间 / 墙钟（单核 ≈ 100%）；Node 栈不使用 GPU。 */
export function seatCountBenchmark({ champion, seatCount, seeds, seedBase, warmup = 1 }) {
  for (let i = 0; i < warmup; i++) simulateGame({ seed: seedBase + i, seatCount, collectDecisions: false });

  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const wallStart = performance.now();

  const decisionSamples = [];
  let totalDecisionMs = 0, totalDecisions = 0, totalMoves = 0;
  const finishedSeeds = [];
  for (let i = 0; i < seeds; i++) {
    const r = simulateGame({ seed: seedBase + 1000 + i, seatCount, collectDecisions: true });
    if (r.status !== 'finished') continue;
    finishedSeeds.push(r.seed);
    totalDecisionMs += r.metrics.totalDecisionMs;
    totalDecisions += r.metrics.seats.reduce((s, x) => s + x.decisionCount, 0);
    totalMoves += r.moves;
    decisionSamples.push(...(r.decisionSamplesMs ?? []));
  }

  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const cpuMs = (cpu.user + cpu.system) / 1000;

  return {
    seatCount,
    seeds: finishedSeeds.length,
    gamesPerHourSingleCore: Math.floor(3_600_000 / (wallMs / Math.max(1, finishedSeeds.length))),
    meanMovesPerGame: Number((totalMoves / Math.max(1, finishedSeeds.length)).toFixed(1)),
    decision: {
      ...latencySummary(decisionSamples),
      decisionsPerSecond: Math.round(totalDecisions / (totalDecisionMs / 1000)),
      aiTimeSharePercent: Number((100 * totalDecisionMs / wallMs).toFixed(1)),
    },
    cpu: {
      cpuMs: Number(cpuMs.toFixed(1)),
      wallMs: Number(wallMs.toFixed(1)),
      utilizationPercent: Number((100 * cpuMs / wallMs).toFixed(1)),
    },
    memory: {
      rssMB: Number((memAfter.rss / 2 ** 20).toFixed(1)),
      heapUsedMB: Number((memAfter.heapUsed / 2 ** 20).toFixed(1)),
      externalMB: Number((memAfter.external / 2 ** 20).toFixed(1)),
      rssDeltaMB: Number(((memAfter.rss - memBefore.rss) / 2 ** 20).toFixed(1)),
    },
    gpu: 'N/A（Node 单进程决策核心，无 GPU 参与计算）',
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('perf.mjs');
if (isMain) {
  const outDir = resolve(import.meta.dirname, '..', 'reports', 'baseline-perf');
  const env = environmentInfo();
  console.log('运行环境：', JSON.stringify(env, null, 2));
  const engineReplay = engineReplayBenchmark({ seed: PERF_SEED_BASE, seatCount: 5 });
  console.log('引擎重放微基准：', JSON.stringify(engineReplay, null, 2));
  const perSeatCount = [];
  for (const seatCount of [2, 3, 4, 5]) {
    const bench = seatCountBenchmark({ seatCount, seeds: 8, seedBase: PERF_SEED_BASE + 1000 });
    perSeatCount.push(bench);
    console.log(`N=${seatCount}:`, JSON.stringify(bench, null, 2));
  }
  ensureDir(outDir);
  writeJSON(resolve(outDir, 'perf.json'), { environment: env, engineReplay, perSeatCount });
  console.log(`结果目录：${outDir}`);
}
