/** JS0–JS4 消融对决运行器（AI6 第四阶段·任务 G）。
 *
 * 版本隔离方案（基于 version-audit 结论：冠军执行路径在 HEAD dist 上逐位
 * 一致 ⇒ 单宇宙对局公平性成立）：
 * - 全部席位经同一正式规则引擎（HEAD dist，engine.ts 自冠军提交 b029567 起
 *   零变更）推进；
 * - JS0（冻结冠军）：冻结参数 + 正式冠军入口（beam-rollout）——经审计与
 *   冠军原始产物决策逐位一致；
 * - JS1：冻结参数 + beam-contest 结构（冠军 + 静态目标存活折扣）；
 * - JS2–JS4：joint 适配器版本（显式 version 注入）。
 *
 * 配对协议（沿用 PR #22 runner 语义，泛化到单宇宙）：
 * - 方向 A：候选占 1 席（席位随 seedIndex 轮转，覆盖全部座位）；
 * - 方向 B：候选占 N−1 席（同 seed 配对）；
 * - 两方向指标分开披露（§任务 G.12：禁止把合并 50% 基准误称单候选第一名率）；
 * - 对手池轮换公式与 versionsForSeats 一致（只依赖 seedIndex+seat）。
 *
 * 种子纪律：AI6_JOINT_TEST_SUBBLOCK [1.32e9,1.33e9)（结论）/ TUNE（调参），
 * 训练-测试隔离由调用方通过 --block 指定；断言越界即抛错。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction, score as engineScore, ranking, count } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS, BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { assertInBlock } from '../../ai5/lib/seed_policy.mjs';
import { firstPlaceClusterCI, pairedDiffSummary, latencySummary } from '../baseline/stats.mjs';
import { wilsonCI, meanCI } from '../evaluator/stats.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const MAX_SEAT_COUNT = 5;

/** 席位人格映射（与 training/simulator/simulate.mjs 完全一致）。 */
function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

/** 候选席位版本描述（kind 决定决策分派路径）。接受 js2 / joint-js2 两种写法。 */
function candidateVersion(id) {
  const jointId = id.startsWith('joint-') ? id : `joint-${id}`;
  if (id === 'js0' || id === 'joint-js0') {
    return { kind: 'champion', id: 'js0-frozen-champion', joint: null };
  }
  if (id === 'js1' || id === 'joint-js1') {
    return { kind: 'champion', id: 'js1-beam-contest', joint: null, structure: 'beam-contest' };
  }
  return { kind: 'joint', id: jointId, joint: jointId };
}

/** 对手池（不含候选本体）：冻结冠军 + 中立基线 + 风格变体。全部经
 * 正式冠军入口运行（对手行为与 PR #22 基准完全同口径）。 */
function opponentPool() {
  const c = CHAMPION_PARAMETERS;
  return [
    { id: c.id, parameters: c, structure: c.structure },
    { id: 'neutral-baseline', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure },
    { id: `${c.id}@tempo`, parameters: { ...c, tempoWeight: Math.min(1.5, c.tempoWeight * 1.35), restWeight: Math.max(0.5, c.restWeight * 0.8) }, structure: c.structure },
    { id: `${c.id}@contest`, parameters: { ...c, contestWeight: Math.min(2, c.contestWeight * 1.4), goalWeight: Math.min(1.5, c.goalWeight * 1.15) }, structure: c.structure },
    { id: `${c.id}@engine`, parameters: { ...c, engineWeight: Math.min(1.5, c.engineWeight * 1.3), endgameWeight: Math.min(1.5, c.endgameWeight * 1.1) }, structure: c.structure },
  ];
}

/** 席位版本分配（runner.mjs versionsForSeats 公式，池不含候选）。 */
function versionsForSeats(candidateSeats, candidate, opponents, seedIndex, seatCount) {
  const poolSize = opponents.length;
  return Array.from({ length: seatCount }, (_, seat) => {
    if (candidateSeats.includes(seat)) return { candidate: true, ...candidate };
    const opponentIndex = (poolSize - 1) * ((seedIndex + seat) % poolSize) % poolSize;
    const opponent = opponents[opponentIndex];
    return { candidate: false, id: opponent.id, parameters: opponent.parameters, structure: opponent.structure };
  });
}

/** 单局：候选 + 对手混合席位，返回候选阵营指标。 */
function runGame({ seed, seatCount, candidateSeats, candidate, opponents, jointOptions, maxMoves = 1200, deadlineMs = 120_000 }) {
  const versions = versionsForSeats(candidateSeats, candidate, opponents, seed % 100000, seatCount);
  let game;
  try {
    game = createGame(
      Array.from({ length: seatCount }, (_, i) => `席位${i}`),
      seed,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
    );
    game.players[0].isAI = true;
  } catch (error) {
    return { status: 'anomaly', reason: `createGame 失败：${error.message}` };
  }
  const decisionMsSamples = [];
  const jointStats = { rollouts: 0, transitions: 0, omTimeMs: 0, decisions: 0 };
  let moves = 0;
  const started = performance.now();
  try {
    while (game.phase !== 'finished') {
      if (moves >= maxMoves) return { status: 'anomaly', reason: `步数上限 ${maxMoves}` };
      if (performance.now() - started > deadlineMs) return { status: 'anomaly', reason: `单局超时 ${deadlineMs}ms` };
      const seat = game.current;
      const version = versions[seat];
      const t0 = performance.now();
      let action;
      if (version.candidate && version.kind === 'joint') {
        const r = chooseJointAction(game, { version: version.joint, ...jointOptions, profile: seatProfile(seat) });
        action = r.action;
        if (r.joint?.stats) {
          jointStats.rollouts += r.joint.stats.rollouts;
          jointStats.transitions += r.joint.stats.transitions;
          jointStats.omTimeMs += r.joint.stats.omTimeMs;
          jointStats.decisions += 1;
        }
      } else if (version.candidate && version.kind === 'champion') {
        const r = chooseAIAction(game, {
          parameters: CHAMPION_PARAMETERS,
          ...(version.structure ? { structure: version.structure } : {}),
          profile: seatProfile(seat),
        });
        action = r.action;
      } else {
        const r = chooseAIAction(game, {
          ...(version.parameters ? { parameters: version.parameters } : {}),
          ...(version.structure ? { structure: version.structure } : {}),
          profile: seatProfile(seat),
        });
        action = r.action;
      }
      decisionMsSamples.push(performance.now() - t0);
      game = applyAction(game, action);
      moves += 1;
    }
  } catch (error) {
    return { status: 'anomaly', reason: `对局异常：${error.message}` };
  }
  const turnCounts = new Set(game.players.map(p => p.turns));
  if (turnCounts.size !== 1) return { status: 'anomaly', reason: '终局回合数不一致' };
  const ranked = ranking(game);
  const rankOfSeat = new Map(ranked.map((p, idx) => [p.id, idx + 1]));
  const scoreOfSeat = new Map(ranked.map(p => [p.id, engineScore(p)]));
  const candidateRanks = candidateSeats.map(s => rankOfSeat.get(s));
  const candidateScores = candidateSeats.map(s => scoreOfSeat.get(s));
  const opponentSeats = Array.from({ length: seatCount }, (_, i) => i).filter(s => !candidateSeats.includes(s));
  const opponentScores = opponentSeats.map(s => scoreOfSeat.get(s));
  const oppMean = opponentScores.reduce((s, x) => s + x, 0) / Math.max(1, opponentScores.length);
  return {
    status: 'finished',
    won: candidateRanks.includes(1),
    meanRank: candidateRanks.reduce((s, x) => s + x, 0) / candidateRanks.length,
    meanScore: candidateScores.reduce((s, x) => s + x, 0) / candidateScores.length,
    scoreDiff: candidateScores.reduce((s, x) => s + x, 0) / candidateScores.length - oppMean,
    winnerSeat: ranked[0].id,
    moves,
    decisionMsSamples,
    jointStats,
    versionsIds: versions.map(v => v.id),
  };
}

/** 运行一个 (版本, 人数) 消融单元：双向配对 + 座位轮换。 */
export function runAblationCell({ candidateId, seatCount, seeds, seedBase, jointOptions }) {
  assertInBlock(seedBase, seedBase < 1_310_000_000
    ? [1_300_000_000, 1_310_000_000]
    : seedBase < 1_320_000_000 ? [1_310_000_000, 1_320_000_000] : [1_320_000_000, 1_330_000_000], 'seedBase');
  const candidate = candidateVersion(candidateId);
  const opponents = opponentPool();
  const games = [];
  const seedPairs = [];
  for (let i = 0; i < seeds; i++) {
    const seed = seedBase + i;
    const seatA = [i % seatCount];
    const seatB = Array.from({ length: seatCount }, (_, s) => s).filter(s => s !== i % seatCount);
    const a = runGame({ seed, seatCount, candidateSeats: seatA, candidate, opponents, jointOptions });
    const b = runGame({ seed, seatCount, candidateSeats: seatB, candidate, opponents, jointOptions });
    for (const [direction, r, seats] of [['A', a, seatA], ['B', b, seatB]]) {
      games.push({ seed, direction, candidateSeats: seats, seatCount, ...r });
    }
    if (a.status === 'finished' && b.status === 'finished') {
      seedPairs.push({ seed, status: 'finished', diff: Number(((a.scoreDiff + b.scoreDiff) / 2).toFixed(4)), anomalies: 0 });
    } else {
      seedPairs.push({ seed, status: 'anomaly', diff: null, anomalies: (a.status !== 'finished') + (b.status !== 'finished') });
    }
  }
  return summarizeCell({ candidateId, seatCount, games, seedPairs });
}

/** 汇总一个消融单元（对齐 runner.mjs 指标口径；方向分开披露）。 */
function summarizeCell({ candidateId, seatCount, games, seedPairs }) {
  const finished = games.filter(g => g.status === 'finished');
  const anomalies = games.length - finished.length;
  const summary = {
    candidateId, seatCount,
    totalGames: games.length, finishedGames: finished.length, anomalies,
    anomalyReasons: Object.entries(games.filter(g => g.status !== 'finished').reduce((acc, g) => {
      const key = (g.reason ?? 'unknown').replace(/ seed.*$/, '').slice(0, 80);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})),
  };
  if (finished.length) {
    const gamesForCI = finished.map(g => ({ seed: g.seed, firstPlace: g.won, direction: g.direction, candidateSeats: g.candidateSeats }));
    // 一级指标：候选席位第一名率（方向分开 + 逐座位分解）。
    for (const direction of ['A', 'B']) {
      const dGames = gamesForCI.filter(g => g.direction === direction);
      if (!dGames.length) continue;
      summary[`direction${direction}`] = {
        games: dGames.length,
        firstPlace: firstPlaceClusterCI(dGames),
        bySeat: Object.fromEntries(Object.entries(
          dGames.reduce((acc, g) => {
            const key = g.candidateSeats.join('+');
            (acc[key] ??= { games: 0, wins: 0 });
            acc[key].games += 1;
            if (g.firstPlace) acc[key].wins += 1;
            return acc;
          }, {}),
        ).map(([seat, b]) => [seat, { games: b.games, firstPlaceRate: Number((b.wins / b.games).toFixed(4)), wilson: wilsonCI(b.wins, b.games) }])),
      };
    }
    summary.firstPlaceCombined = firstPlaceClusterCI(gamesForCI);
    summary.meanRank = meanCI(finished.map(g => g.meanRank));
    summary.meanScoreDiff = meanCI(finished.map(g => g.scoreDiff));
    summary.pairedScoreAdvantage = pairedDiffSummary(seedPairs);
    // 延迟与联合搜索统计（候选席位决策）。
    const latencies = finished.flatMap(g => g.decisionMsSamples ?? []);
    if (latencies.length) summary.latency = latencySummary(latencies);
    const joint = finished.filter(g => g.jointStats?.decisions > 0);
    if (joint.length) {
      const agg = joint.reduce((acc, g) => ({
        rollouts: acc.rollouts + g.jointStats.rollouts,
        transitions: acc.transitions + g.jointStats.transitions,
        omTimeMs: acc.omTimeMs + g.jointStats.omTimeMs,
        decisions: acc.decisions + g.jointStats.decisions,
      }), { rollouts: 0, transitions: 0, omTimeMs: 0, decisions: 0 });
      const totalDecisionMs = latencies.reduce((s, x) => s + x, 0);
      summary.jointSearch = {
        decisions: agg.decisions,
        meanRolloutsPerDecision: Number((agg.rollouts / agg.decisions).toFixed(2)),
        meanTransitionsPerDecision: Number((agg.transitions / agg.decisions).toFixed(1)),
        omTimeMsTotal: Number(agg.omTimeMs.toFixed(1)),
        omTimeShare: totalDecisionMs > 0 ? Number((agg.omTimeMs / totalDecisionMs).toFixed(4)) : null,
      };
    }
  }
  return summary;
}

/** CLI：node training/joint/duel.mjs --candidates js2,js3 --players 2,5 --seeds 40 --block test [--budget 100] [--work 128] */
function parseArgs() {
  const args = {
    candidates: ['js2', 'js3'], players: [2, 5], seeds: 40, block: 'test',
    budgetMs: undefined, workUnits: undefined, horizon: undefined,
    outDir: resolve(REPO_ROOT, 'training/reports/joint-search-v1'),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--candidates') args.candidates = argv[++i].split(',');
    else if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--block') args.block = argv[++i];
    else if (argv[i] === '--budget') args.budgetMs = Number(argv[++i]);
    else if (argv[i] === '--work') args.workUnits = Number(argv[++i]);
    else if (argv[i] === '--horizon') args.horizon = Number(argv[++i]);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const seedBaseByBlock = {
    tune: 1_310_000_000, test: 1_320_000_000, audit: 1_300_000_000,
  };
  const seedBase = seedBaseByBlock[args.block]
    ?? (() => { throw new Error(`--block 必须是 tune|test|audit，实际：${args.block}`); })();
  const jointOptions = {
    ...(args.budgetMs !== undefined ? { budgetMs: args.budgetMs } : {}),
    ...(args.workUnits !== undefined ? { workUnits: args.workUnits } : {}),
    ...(args.horizon !== undefined ? { horizon: args.horizon } : {}),
  };
  const cells = [];
  for (const candidateId of args.candidates) {
    for (const seatCount of args.players) {
      process.stdout.write(`运行 ${candidateId} ${seatCount}人 ${args.seeds}种子(${args.block}) ...\n`);
      const t0 = performance.now();
      const cell = runAblationCell({ candidateId, seatCount, seeds: args.seeds, seedBase, jointOptions });
      const fmt = d => cell[d] ? `${(cell[d].firstPlace.point * 100).toFixed(1)}% [${(cell[d].firstPlace.lower * 100).toFixed(1)},${(cell[d].firstPlace.upper * 100).toFixed(1)}]` : '-';
      process.stdout.write(`  完成 ${Math.round(performance.now() - t0)}ms｜方向A ${fmt('directionA')} 方向B ${fmt('directionB')} 异常 ${cell.anomalies}\n`);
      cells.push(cell);
    }
  }
  const report = {
    schema: 'century-joint-search-ablation-v1',
    date: new Date().toISOString(),
    block: args.block, seedBase, seeds: args.seeds,
    jointOptions, note: 'JS 编号为本阶段消融编号（JS0–JS4），非 PR #22 的 B0/B1/B2。',
    cells,
  };
  mkdirSync(args.outDir, { recursive: true });
  const suffix = `${args.block}-${args.candidates.join('_')}-${args.players.join('_')}-${args.seeds}s`;
  const out = resolve(args.outDir, `ablation-${suffix}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(`结果已写入：${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('duel.mjs')) {
  main().catch(error => { console.error(error); process.exit(1); });
}
