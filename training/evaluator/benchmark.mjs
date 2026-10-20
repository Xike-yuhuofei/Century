/** 性能基准（任务书第十二节）：分别衡量单步决策、单局模拟、每小时局数与训练资源估算。 */

import { performance } from 'node:perf_hooks';
import { simulateGame } from '../simulator/simulate.mjs';
import { requireBuiltEngine } from '../lib/paths.mjs';
import { writeJSON, ensureDir, readJSONL } from '../lib/io.mjs';
import { resolve } from 'node:path';

export function runBenchmark({ warmup = 2, measured = 10, seedBase = 3000 } = {}) {
  requireBuiltEngine();
  // 预热（JIT 稳定后才开始计量）。
  for (let i = 0; i < warmup; i++) simulateGame({ seed: seedBase + i });

  const games = [];
  let totalDecisionMs = 0, totalDecisions = 0, maxDecisionMs = 0;
  const wallStart = performance.now();
  for (let i = 0; i < measured; i++) {
    const r = simulateGame({ seed: seedBase + 100 + i });
    games.push(r);
    totalDecisionMs += r.metrics.totalDecisionMs;
    totalDecisions += r.metrics.seats.reduce((s, x) => s + x.decisionCount, 0);
    maxDecisionMs = Math.max(maxDecisionMs, r.metrics.maxDecisionMs);
  }
  const wallMs = performance.now() - wallStart;

  const msPerGame = wallMs / measured;
  const result = {
    measuredGames: measured,
    msPerGame: Number(msPerGame.toFixed(1)),
    gamesPerHourSingleCore: Math.floor(3_600_000 / msPerGame),
    meanMovesPerGame: Number((games.reduce((s, g) => s + g.moves, 0) / measured).toFixed(1)),
    decision: {
      meanMsPerDecision: Number((totalDecisionMs / totalDecisions).toFixed(3)),
      maxMsPerDecision: Number(maxDecisionMs.toFixed(2)),
      decisionsPerGame: Number((totalDecisions / measured).toFixed(1)),
    },
    estimates: {
      '100局': { minutes: Number((msPerGame * 100 / 60000).toFixed(1)) },
      '1000局': { minutes: Number((msPerGame * 1000 / 60000).toFixed(1)), hours: Number((msPerGame * 1000 / 3.6e6).toFixed(2)) },
      '10000局': { hours: Number((msPerGame * 10000 / 3.6e6).toFixed(1)) },
      // GitHub 标准 2 核 runner 经验系数约 0.5–0.7（实测为准）。
      ciRunnerFactorAssumption: 0.6,
      '1000局_CI估算小时': Number((msPerGame * 1000 / 3.6e6 / 0.6).toFixed(2)),
    },
  };
  return result;
}

const isMain = process.argv[1] && process.argv[1].endsWith('benchmark.mjs');
if (isMain) {
  const result = runBenchmark({});
  console.log(JSON.stringify(result, null, 2));
  const out = resolve(process.cwd(), 'training/reports/perf-latest');
  ensureDir(out);
  writeJSON(resolve(out, 'benchmark.json'), { ...result, measuredAt: new Date().toISOString() });
  console.log(`结果目录：${out}`);
}
