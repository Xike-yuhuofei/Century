/** 公共模拟器性能基准（AI6 第二阶段·任务 F）。
 *
 * 目标设备：Mac mini M4 / 16GB 统一内存（与 AI6 第一阶段 perf.mjs 相同口径）。
 *
 * 测量项（全部独立披露，不混口径）：
 * 1. 纯转移吞吐量（transition/s，不含合法行动生成）：
 *    - 正式引擎重放（口径与 AI6 §4.1 完全一致：录制一局行动序列后重放
 *      createGame + applyAction，合法性由引擎逐条校验）；
 *    - 公共模拟器重放（同一初始局面、同一行动序列、预设翻牌 = 真实剩余牌序，
 *      逐步到达 finished）。
 * 2. 节点展开吞吐量（expansion/s，含合法行动生成 + 分支状态复制）：
 *    每个主线节点枚举全量合法行动，对每个行动 fork + tryStep（分支复制）。
 * 3. 公共状态构建 buildPublicSimState（ops/s）。
 * 4. 信念采样 BeliefDeckSampler（采样/s、卡牌/s）。
 * 5. 合法行动生成 enumerateLegalActions（枚举/s、动作/s）。
 * 6. 状态复制 fork（fork/s）。
 * 7. 内存：各工作负载 heapUsed / RSS 增量。
 * 8. 2–5 人分档差异。
 *
 * 种子纪律：使用 PERF_SEED_BASE（perf 诊断子块，非统计样本，不参与账本消费），
 * 与 AI6 第一阶段性能基准同源；不用正式验证种子做调优。
 *
 * 运行：node --expose-gc scripts/benchmark-public-sim.mjs [输出路径]
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai.js';
import {
  createSimulation, enumerateLegalActions, randomBeliefSampler,
  buildPublicSimState,
} from '../dist/js/sim/index.js';
import { simulateGame } from '../../training/simulator/simulate.mjs';
import { environmentInfo } from '../../training/baseline/perf.mjs';

/** perf 诊断种子（同 AI6 perf.mjs 约定；子块内偏移 +5000 避免逐位重合）。 */
const PERF_SEED_BASE = 1_109_000_000 + 5000;
const WARMUP = 1;
const MEASURE_ROUNDS = 3;

const gc = () => { if (global.gc) global.gc(); };

function memSnapshot() {
  const m = process.memoryUsage();
  return { heapUsedMB: Number((m.heapUsed / 2 ** 20).toFixed(1)), rssMB: Number((m.rss / 2 ** 20).toFixed(1)) };
}

function memDelta(before, after) {
  return {
    heapUsedDeltaMB: Number((after.heapUsedMB - before.heapUsedMB).toFixed(1)),
    rssDeltaMB: Number((after.rssMB - before.rssMB).toFixed(1)),
  };
}

const rate = (count, ms) => Math.round(count / (ms / 1000));

/** 录制一局行动序列（与 training/baseline/perf.mjs 的 engineReplayBenchmark 同口径）。 */
function recordGame({ seed, seatCount }) {
  const recorded = simulateGame({ seed, seatCount, collectActions: true });
  if (recorded.status !== 'finished') {
    throw new Error(`录制局异常（${recorded.reason}），无法建立重放基准`);
  }
  const actions = recorded.actions.map(a => JSON.parse(JSON.stringify(a.action)));
  const names = Array.from({ length: seatCount }, (_, i) => `席位${i}`);
  const aiSeats = Array.from({ length: seatCount - 1 }, (_, i) => i + 1);
  return { actions, names, aiSeats, moves: recorded.moves };
}

/** 正式引擎重放基准（口径 = AI6 §4.1）。 */
function engineReplay({ actions, names, aiSeats, seed, moves }) {
  const replayOnce = () => {
    let game = createGame(names, seed, aiSeats);
    game.players[0].isAI = true;
    for (const action of actions) {
      game = applyAction(game, action);
    }
    if (game.phase !== 'finished') throw new Error('引擎重放未达终局：行动序列与种子不匹配');
  };
  for (let i = 0; i < WARMUP; i++) replayOnce();
  const start = performance.now();
  for (let i = 0; i < MEASURE_ROUNDS; i++) replayOnce();
  const ms = performance.now() - start;
  return {
    transitionsPerSec: rate(moves * MEASURE_ROUNDS, ms),
    msPerTransition: Number((ms / (moves * MEASURE_ROUNDS)).toFixed(4)),
  };
}

/** 公共模拟器重放基准：同一局面、同一行动序列、预设翻牌 = 真实剩余牌序。 */
function simReplay({ actions, names, aiSeats, seed, moves }) {
  const replayOnce = () => {
    let game = createGame(names, seed, aiSeats);
    game.players[0].isAI = true;
    const sim = createSimulation(buildObservation(game, game.current), {
      sampler: {
        sampleMerchantDeck: (unseen) => {
          if (unseen.length !== game.merchantDeck.length) throw new Error('预设商人牌序与未知集合不一致');
          return [...game.merchantDeck];
        },
        sampleGolemDeck: (unseen) => [...game.golemDeck],
      },
    });
    for (const action of actions) {
      sim.step(action);
      game = applyAction(game, action);
    }
    if (game.phase !== 'finished' || !sim.finished) throw new Error('模拟器重放未达终局：预设牌序与种子不匹配');
  };
  for (let i = 0; i < WARMUP; i++) replayOnce();
  const start = performance.now();
  for (let i = 0; i < MEASURE_ROUNDS; i++) replayOnce();
  const ms = performance.now() - start;
  return {
    transitionsPerSec: rate(moves * MEASURE_ROUNDS, ms),
    msPerTransition: Number((ms / (moves * MEASURE_ROUNDS)).toFixed(4)),
  };
}

/** 节点展开基准：每主线节点全量枚举 + 每行动 fork+tryStep（分支复制）。
 * 返回 { expansionsPerSec, enumeratePerSec, meanBranchingFactor }。 */
function nodeExpansion({ actions, names, aiSeats, seed }) {
  const runOnce = () => {
    let game = createGame(names, seed, aiSeats);
    game.players[0].isAI = true;
    const sim = createSimulation(buildObservation(game, game.current), {
      sampler: {
        sampleMerchantDeck: () => [...game.merchantDeck],
        sampleGolemDeck: () => [...game.golemDeck],
      },
    });
    let expansions = 0;
    let enumerations = 0;
    for (const action of actions) {
      const branch = enumerateLegalActions(sim.view);
      enumerations += 1;
      expansions += branch.length;
      for (const candidate of branch) {
        sim.fork().tryStep(candidate);
      }
      sim.step(action);
      game = applyAction(game, action);
    }
    return { expansions, enumerations };
  };
  runOnce(); // 预热（含 JIT）
  gc();
  const memBefore = memSnapshot();
  const start = performance.now();
  const { expansions, enumerations } = runOnce();
  const ms = performance.now() - start;
  const memAfter = memSnapshot();
  return {
    expansionsPerSec: rate(expansions, ms),
    enumerationsPerSec: rate(enumerations, ms),
    meanBranchingFactor: Number((expansions / enumerations).toFixed(1)),
    memory: memDelta(memBefore, memAfter),
    measuredExpansions: expansions,
  };
}

/** 微工作负载：状态构建 / 信念采样 / 合法行动生成 / 状态复制。 */
function microWorkloads({ names, aiSeats, seed }) {
  const game = createGame(names, seed, aiSeats);
  game.players[0].isAI = true;
  // 推进 30 步形成中局（含更多手牌与更大行动集）。
  let g = game;
  for (let i = 0; i < 30; i++) {
    const sim = createSimulation(buildObservation(g, g.current), { simSeed: 7 });
    const acts = enumerateLegalActions(sim.view);
    g = applyAction(g, acts[Math.floor(acts.length / 2)]);
    if (g.phase === 'finished') break;
  }
  const obs = buildObservation(g, g.current);

  // 状态构建。
  buildPublicSimState(obs);
  gc();
  let t = performance.now();
  const BUILDS = 20000;
  for (let i = 0; i < BUILDS; i++) buildPublicSimState(obs);
  let ms = performance.now() - t;
  const buildPerSec = rate(BUILDS, ms);
  const buildUsPerOp = Number((ms / BUILDS * 1000).toFixed(2));

  // 信念采样（对中局未知集合）。
  const state = buildPublicSimState(obs);
  const sampler = randomBeliefSampler(11);
  const cardsPerSample = state.unseenMerchants.length + state.unseenGolems.length;
  sampler.sampleMerchantDeck(state.unseenMerchants);
  sampler.sampleGolemDeck(state.unseenGolems);
  gc();
  t = performance.now();
  const SAMPLES = 20000;
  for (let i = 0; i < SAMPLES; i++) {
    sampler.sampleMerchantDeck(state.unseenMerchants);
    sampler.sampleGolemDeck(state.unseenGolems);
  }
  ms = performance.now() - t;
  const beliefSamplesPerSec = rate(SAMPLES, ms);
  const beliefCardsPerSec = rate(SAMPLES * cardsPerSample, ms);

  // 合法行动生成。
  const sim = createSimulation(obs, { simSeed: 7 });
  enumerateLegalActions(sim.view);
  gc();
  t = performance.now();
  const ENUMS = 5000;
  let emitted = 0;
  for (let i = 0; i < ENUMS; i++) {
    emitted += enumerateLegalActions(sim.view).length;
  }
  ms = performance.now() - t;
  const enumeratePerSec = rate(ENUMS, ms);
  const legalActionsPerSec = rate(emitted, ms);
  const meanActions = Number((emitted / ENUMS).toFixed(1));

  // 状态复制（fork）。
  sim.fork();
  gc();
  t = performance.now();
  const FORKS = 20000;
  for (let i = 0; i < FORKS; i++) sim.fork();
  ms = performance.now() - t;
  const forkPerSec = rate(FORKS, ms);
  const forkUsPerOp = Number((ms / FORKS * 1000).toFixed(2));

  return {
    buildPublicSimState: { opsPerSec: buildPerSec, usPerOp: buildUsPerOp },
    beliefSampling: {
      samplesPerSec: beliefSamplesPerSec,
      cardsPerSec: beliefCardsPerSec,
      cardsPerSample,
    },
    legalActionGeneration: {
      enumerationsPerSec: enumeratePerSec,
      actionsPerSec: legalActionsPerSec,
      meanActionsPerPosition: meanActions,
    },
    stateCopy: { forksPerSec: forkPerSec, usPerFork: forkUsPerOp },
  };
}

/** 主流程：2–5 人分档测量。 */
function main() {
  const outputPath = process.argv[2]
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../training/reports/public-sim-perf/perf.json');
  const environment = environmentInfo();
  console.log('[public-sim-perf] 环境：', environment.cpuModel, environment.nodeVersion, 'commit', environment.repoCommit?.slice(0, 8));

  const perSeatCount = [];
  for (const seatCount of [2, 3, 4, 5]) {
    const seed = PERF_SEED_BASE + seatCount;
    const recorded = recordGame({ seed, seatCount });
    console.log(`[public-sim-perf] N=${seatCount}：录制 ${recorded.moves} 个行动（seed ${seed}）`);

    const engine = engineReplay({ ...recorded, seed, moves: recorded.moves });
    const sim = simReplay({ ...recorded, seed, moves: recorded.moves });
    const expansion = nodeExpansion({ ...recorded, seed });
    const micro = microWorkloads({ names: recorded.names, aiSeats: recorded.aiSeats, seed });

    const entry = {
      seatCount,
      seed,
      recordedMoves: recorded.moves,
      pureTransitionThroughput: {
        engineReplay: engine,
        publicSimReplay: sim,
        simVsEngine: Number((sim.transitionsPerSec / engine.transitionsPerSec).toFixed(2)),
        口径: '纯转移吞吐（不含合法行动生成）；双侧同一行动序列 + 逐条合法性校验 + 到达终局',
      },
      nodeExpansion: {
        ...expansion,
        口径: '含合法行动生成 + 每行动分支状态复制的节点展开吞吐；与纯转移吞吐分开披露',
      },
      micro,
    };
    perSeatCount.push(entry);
    console.log(`  引擎 ${engine.transitionsPerSec} t/s | 模拟器 ${sim.transitionsPerSec} t/s（×${entry.pureTransitionThroughput.simVsEngine}） | 展开 ${expansion.expansionsPerSec}/s | fork ${micro.stateCopy.forksPerSec}/s`);
  }

  const result = {
    environment,
    methodology: {
      warmupRounds: WARMUP,
      measuredRounds: MEASURE_ROUNDS,
      seedDiscipline: 'PERF 诊断子块（非统计样本，不参与账本消费），与 AI6 第一阶段 perf 基准同源',
      口径声明: '纯转移吞吐与节点展开吞吐分开披露；节点展开 = 全量合法行动枚举 + 每行动 fork 状态复制 + tryStep',
    },
    perSeatCount,
    measuredAt: new Date().toISOString(),
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`[public-sim-perf] 结果已写入 ${outputPath}`);
}

main();
