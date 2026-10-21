#!/usr/bin/env node
/** 自对战基准 worker（任务三）：由 exp3_selfplay_benchmark.mjs 通过 fork 启动。
 * 运行 1 局预热 + N 局正式计量对局，逐局上报墙钟与步数，不修改任何 AI 4.0 代码。
 */
import { simulateGame } from '../../training/simulator/simulate.mjs';

const { games, seedBase, workerId } = process.env;
const gameCount = Number(games);
const base = Number(seedBase);
if (!Number.isSafeInteger(gameCount) || gameCount < 1) throw new Error('games 必须为正整数');
if (!Number.isSafeInteger(base) || base < 0) throw new Error('seedBase 必须为非负整数');

// 预热 1 局（JIT 稳定），不计入统计
simulateGame({ seed: base + 999 });

const perGame = [];
const started = performance.now();
for (let i = 0; i < gameCount; i++) {
  const r = simulateGame({ seed: base + i });
  perGame.push({
    seed: r.seed,
    status: r.status,
    moves: r.moves,
    wallMs: Math.round(r.wallMs * 10) / 10,
    decisionMs: r.metrics ? Math.round(r.metrics.totalDecisionMs * 10) / 10 : null,
  });
  process.send?.({ type: 'progress', workerId: Number(workerId), done: i + 1 });
}
const wallMs = performance.now() - started;

process.send?.({
  type: 'done',
  workerId: Number(workerId),
  games: perGame,
  wallMs: Math.round(wallMs),
  rssMB: Math.round(process.memoryUsage().rss / 1e6),
});
