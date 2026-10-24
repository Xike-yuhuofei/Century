/** Joint Search V1 性能基准（AI6 第四阶段·任务 F）。
 *
 * 测量矩阵：
 * - 决策预算 25/50/100/200ms × 版本 js2/js3/js4/js5 × 人数 2/3/5；
 * - 固定工作量 64/128/256/512（确定性模式，逐位复放）；
 * - 指标：p50/p95/p99 决策延迟、rollouts/s、transitions/s、合法行动生成成本、
 *   对手预测耗时占比、状态复制（fork+step）成本、RSS/heap、预算耗尽返回行为。
 *
 * 种子：AI6_JOINT_PERF_SUBBLOCK [1.35e9, 1.351e9)（无统计结论诉求，仅性能）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction } from '../../web-v1/dist/js/engine.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { createSimulation, simulatePublicAction } from '../../web-v1/dist/js/sim/session.js';
import { enumerateLegalActions } from '../../web-v1/dist/js/sim/legal.js';
import { buildObservation } from '../../web-v1/dist/js/ai/observation.js';
import { NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { REPO_ROOT } from '../lib/paths.mjs';

/** 观察到最小 Game 代理（chooseJointAction 合法性复核 applyAction 所需的
 * 完整字段集：log/version/triggerPlayer 等；字段投影自公开观察，无隐藏信息）。 */
function gameProxyOf(view) {
  return {
    version: 2,
    log: [],
    players: view.players.map(p => ({ ...p, stock: [...p.stock], hand: [...p.hand], played: [...p.played], claimed: [...p.claimed] })),
    current: view.current,
    merchantMarket: view.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] })),
    golemMarket: [...view.golemMarket],
    copper: view.copper, silver: view.silver,
    phase: view.phase, triggerPlayer: view.triggerPlayer, turnNumber: view.turnNumber,
  };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/** 采集中局观察（性能路径用 champion 快速推进到指定步数）。 */
function midgameObservations(players, count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    let g = createGame(Array.from({ length: players }, (_, k) => `P${k}`), 1_350_000_000 + i, Array.from({ length: players - 1 }, (_, k) => k + 1));
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 40 + i * 15) {
      const r = chooseJointAction(g, { version: 'joint-js2', workUnits: 4, horizon: 30 });
      g = applyAction(g, r.action);
      moves++;
    }
    if (g.phase === 'finished') continue;
    list.push(buildObservation(g, g.current));
  }
  return list;
}

/** 微基准：合法行动生成 / fork+step 成本。 */
function microBenchmarks(observations) {
  let legalMs = 0, forkStepMs = 0, legalN = 0, forkN = 0;
  for (const view of observations) {
    const t0 = performance.now();
    const legal = enumerateLegalActions(createSimulation(view, { simSeed: 1 }).view, { dedupe: true });
    legalMs += performance.now() - t0;
    legalN += legal.length;
    const sim = createSimulation(view, { simSeed: 1 });
    const t1 = performance.now();
    for (const a of legal.slice(0, 20)) {
      simulatePublicAction(sim, a);
      forkN++;
    }
    forkStepMs += performance.now() - t1;
  }
  return {
    legalActionsMeanPerState: Number((legalN / observations.length).toFixed(1)),
    legalGenUsPerState: Number((legalMs / observations.length * 1000).toFixed(1)),
    forkStepUsPerAction: Number((forkStepMs / forkN * 1000).toFixed(1)),
  };
}

async function main() {
  const outDir = resolve(REPO_ROOT, 'training/reports/joint-search-v1');
  mkdirSync(outDir, { recursive: true });
  const report = { schema: 'century-joint-search-perf-v1', date: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version, note: 'Mac mini M4 16GB 目标环境；本机为开发机时如实披露' }, cells: [] };

  report.micro = microBenchmarks(midgameObservations(5, 8));

  for (const players of [2, 3, 5]) {
    const observations = midgameObservations(players, 12);
    for (const version of ['joint-js2', 'joint-js3', 'joint-js4', 'joint-js5']) {
      for (const budget of [25, 50, 100, 200]) {
        const samples = [];
        let budgetExhausted = 0;
        let omMs = 0, totalMs = 0, rollouts = 0, transitions = 0;
        for (const view of observations) {
          const t0 = performance.now();
          const r = chooseJointAction(gameProxyOf(view), { version, budgetMs: budget, profile: NEUTRAL_PROFILE });
          const ms = performance.now() - t0;
          samples.push(ms);
          totalMs += ms;
          omMs += r.joint?.stats?.omTimeMs ?? 0;
          rollouts += r.joint?.stats?.rollouts ?? 0;
          transitions += r.joint?.stats?.transitions ?? 0;
          if (r.joint?.stats?.budgetExhausted) budgetExhausted++;
        }
        samples.sort((a, b) => a - b);
        report.cells.push({
          players, version, budgetMs: budget, decisions: samples.length,
          p50: +percentile(samples, 0.50).toFixed(2),
          p95: +percentile(samples, 0.95).toFixed(2),
          p99: +percentile(samples, 0.99).toFixed(2),
          max: +samples[samples.length - 1].toFixed(2),
          budgetExhaustedRate: +(budgetExhausted / samples.length).toFixed(3),
          rolloutsPerDecision: +(rollouts / samples.length).toFixed(1),
          transitionsPerDecision: +(transitions / samples.length).toFixed(1),
          rolloutsPerSec: +(rollouts / (totalMs / 1000)).toFixed(0),
          omTimeShare: totalMs > 0 ? +(omMs / totalMs).toFixed(3) : null,
        });
      }
      // 固定工作量模式（确定性）。
      for (const work of [64, 128, 256, 512]) {
        const samples = [];
        for (const view of observations.slice(0, 6)) {
          const t0 = performance.now();
          chooseJointAction(gameProxyOf(view), { version, workUnits: work, profile: NEUTRAL_PROFILE });
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        report.cells.push({
          players, version, workUnits: work, decisions: samples.length,
          p50: +percentile(samples, 0.50).toFixed(2),
          p95: +percentile(samples, 0.95).toFixed(2),
          p99: +percentile(samples, 0.99).toFixed(2),
        });
      }
      process.stdout.write(`${version} ${players}人 完成\n`);
    }
  }

  // 内存（RSS/heap）。
  report.memory = process.memoryUsage();

  // 完整对局吞吐（js2 @100ms，5 人）。
  {
    const t0 = performance.now();
    let g = createGame(['P0', 'P1', 'P2', 'P3', 'P4'], 1_350_000_999, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 500) {
      const r = chooseJointAction(g, { version: 'joint-js2', budgetMs: 100, profile: NEUTRAL_PROFILE });
      g = applyAction(g, r.action);
      moves++;
    }
    const wall = (performance.now() - t0) / 1000;
    report.gameThroughput = {
      version: 'joint-js2', budgetMs: 100, players: 5,
      moves, finished: g.phase === 'finished', wallSec: +wall.toFixed(1),
      gamesPerHourSingleCore: +(3600 / wall).toFixed(2),
    };
  }

  const out = resolve(outDir, 'perf.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`性能报告已写入：${out}`);
  // 摘要打印
  for (const c of report.cells.filter(c => c.budgetMs === 100 && c.players === 5)) {
    console.log(`${c.version} 100ms/5p: p50=${c.p50} p95=${c.p95} p99=${c.p99} rollouts/决策=${c.rolloutsPerDecision} om占比=${c.omTimeShare}`);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
