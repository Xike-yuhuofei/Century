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
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createGame, applyAction, score as engineScore, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import {
  assertInBlock, AI6_JS5_CONFIRM_SUBBLOCK, AI6_JS5_TUNE2_SUBBLOCK,
  AI6_JS5_GOAL_DEV_SUBBLOCK, AI6_JS5_GOAL_CONFIRM_SUBBLOCK, AI6_JS5_GOAL_PERF_SUBBLOCK,
  AI6_PHASE6_DEV_SUBBLOCK, AI6_PHASE6_TUNE_SUBBLOCK, AI6_PHASE6_PERF_SUBBLOCK,
  AI6_PHASE6_2P_SUBBLOCK, AI6_PHASE6_BUDGET_SUBBLOCK, AI6_PHASE6_CONFIRM_SUBBLOCK,
  AI7_CANDIDATE_DEV_SUBBLOCK,
} from '../../ai5/lib/seed_policy.mjs';
import { firstPlaceClusterCI, pairedDiffSummary, latencySummary } from '../baseline/stats.mjs';
import { wilsonCI, meanCI } from '../evaluator/stats.mjs';
import { REPO_ROOT, engineBundleSha256 } from '../lib/paths.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { resolveAlgorithmVersion, decisionOptions, describeVersionRegistry } from '../lib/version-registry.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../lib/sim-stream.mjs';
import { enumerateLegalActions } from '../../web-v1/dist/js/sim/legal.js';
// 对手池单一事实来源（AI6 第六阶段 P0 修复）：池构造集中于 pools.mjs；
// 此处 re-export 供 redteam/audit-versions.mjs 等既有调用点继续从 duel 导入。
import { classicPool, diversePool } from './pools.mjs';
export { classicPool, diversePool };

/** 进程启动时捕获代码版本（证据纪律：codeCommit 必须在启动时而非落盘时记录）。 */
function gitHead() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const GIT_HEAD = gitHead();

const MAX_SEAT_COUNT = 5;

/** 席位人格映射（与 training/simulator/simulate.mjs 完全一致）。 */
function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

/** 候选席位版本描述（P0-1 整改：身份经不可变版本注册表解析，禁止读活动冠军别名）。
 * - js0 = legacy-js0：冻结冠军基线（ai5-readiness-efficiency 晋级归档，beam-rollout）；
 * - js1 = legacy-js1：同一冻结基座 + beam-contest 结构；
 * - js2..js5：joint 适配器版本（显式 version 注入）。
 * 接受 js0 / joint-js0 两种写法。修复前缺陷：js0/js1 传 CHAMPION_PARAMETERS
 * （晋级后携带 adapter='champion-guided'）→ decision.ts 适配器分支先于 structure
 * 生效 → 基线实际执行 JS5（audit-versions V2/V3 实锤）。 */
export function candidateVersion(id) {
  const jointId = id.startsWith('joint-') ? id : `joint-${id}`;
  if (id === 'js0' || id === 'joint-js0') {
    return { kind: 'champion', id: 'js0-frozen-champion', joint: null, descriptor: resolveAlgorithmVersion('legacy-js0') };
  }
  if (id === 'js1' || id === 'joint-js1') {
    return { kind: 'champion', id: 'js1-beam-contest', joint: null, structure: 'beam-contest', descriptor: resolveAlgorithmVersion('legacy-js1') };
  }
  return { kind: 'joint', id: jointId, joint: jointId };
}

/** 随机合法对手（D2-7：与冠军算法结构完全不同的基线）：逐决策确定性均匀采样
 * 合法行动。合法集合经 sim/legal 全量枚举（与规则引擎逐条对齐的正确性基准口径）；
 * RNG 流只依赖 (seed, seat)，可复现且不接触隐藏牌序。 */
function randomLegalAction(game, rng) {
  const legal = enumerateLegalActions(buildPublicViewForRandom(game), { dedupe: false });
  if (!legal.length) return { type: 'rest' };
  return legal[Math.floor(rng() * legal.length)];
}

/** 引擎 Game → sim/legal 兼容视图（只复制公开字段；弃置由 enumerateLegalActions
 * 的规范组合枚举处理，无需自行实现）。 */
function buildPublicViewForRandom(game) {
  return {
    current: game.current,
    phase: game.phase,
    turnNumber: game.turnNumber,
    players: game.players.map(p => ({
      id: p.id, stock: [...p.stock], hand: [...p.hand], played: [...p.played], claimed: [...p.claimed],
    })),
    golemMarket: [...game.golemMarket],
    merchantMarket: game.merchantMarket.map(m => ({ id: m.id })),
  };
}

/** 对手席位 RNG 流（确定性：同 (seed, seat) 同流；跨席位独立）。 */
function seatRng(seed, seat) {
  return mulberry32(((seed >>> 0) ^ Math.imul(seat + 1, 0x9E3779B9)) >>> 0);
}

/** 席位版本分配（runner.mjs versionsForSeats 公式，池不含候选）。 */
function versionsForSeats(candidateSeats, candidate, opponents, seedIndex, seatCount) {
  const poolSize = opponents.length;
  return Array.from({ length: seatCount }, (_, seat) => {
    if (candidateSeats.includes(seat)) return { candidate: true, ...candidate };
    const opponentIndex = (poolSize - 1) * ((seedIndex + seat) % poolSize) % poolSize;
    const opponent = opponents[opponentIndex];
    return { candidate: false, id: opponent.id, parameters: opponent.parameters, structure: opponent.structure, randomLegal: opponent.randomLegal === true };
  });
}

/** 单局：候选 + 对手混合席位，返回候选阵营指标（导出供版本身份回归测试复用）。
 * 第五阶段扩展：simSeed = 对局种子（联合模拟随机流跨局独立——PR #27 的
 * duel 未传 simSeed，全部对局共用 0，跨局模拟噪声相关；本参数只影响
 * 联合候选的信念/对手采样熵，不改变算法语义，js0/js1 不消费该值）；
 * gated/override/回退统计（任务 E）；逐决策诊断流（任务 G，可选）。 */
export function runGame({ seed, seatCount, candidateSeats, candidate, opponents, jointOptions, maxMoves = 1200, deadlineMs, diagnostics }) {
  // 单局死线随搜索预算缩放（第六阶段 B 矩阵教训：120s 固定死线在 5p@1000ms
  // 下把 33% 的长对局误判为异常——高预算对局的合法墙钟更长，死线必须是
  // 预算的函数而非常数；250×budget 覆盖 5p@1000ms 的长尾对局）。
  const effectiveDeadline = deadlineMs ?? Math.max(120_000, 250 * (jointOptions?.budgetMs ?? 100));
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
  const seatRngs = new Map();
  const rngFor = seat => {
    if (!seatRngs.has(seat)) seatRngs.set(seat, seatRng(seed, seat));
    return seatRngs.get(seat);
  };
  const decisionMsSamples = [];
  const jointStats = { rollouts: 0, transitions: 0, omTimeMs: 0, decisions: 0, gated: 0, overrides: 0, starvedFallbacks: 0, championDirect: 0 };
  let moves = 0;
  const started = performance.now();
  try {
    while (game.phase !== 'finished') {
      if (moves >= maxMoves) return { status: 'anomaly', reason: `步数上限 ${maxMoves}` };
      if (performance.now() - started > effectiveDeadline) return { status: 'anomaly', reason: `单局超时 ${effectiveDeadline}ms` };
      const seat = game.current;
      const version = versions[seat];
      const t0 = performance.now();
      let action;
      if (version.candidate && version.kind === 'joint') {
        // P0-5 整改：联合模拟随机流由独立域派生（单向，不把真实对局种子暴露为
        // AI 可利用特征）；同种子同配置 ⇒ 同流（配对 CRN 保持）。修复前历史
        // （PR #29 起）simSeed=对局种子——与 confirm 历史数据的流域差异已在
        // 报告 simStream 字段披露。
        const r = chooseJointAction(game, { version: version.joint, ...jointOptions, simSeed: deriveSimStreamSeed(seed), profile: seatProfile(seat) });
        action = r.action;
        if (r.joint?.stats) {
          jointStats.rollouts += r.joint.stats.rollouts;
          jointStats.transitions += r.joint.stats.transitions;
          jointStats.omTimeMs += r.joint.stats.omTimeMs;
          jointStats.decisions += 1;
          if (r.joint.gated === true) {
            jointStats.gated += 1;
            if (r.joint.stats.rollouts === 0) jointStats.starvedFallbacks += 1;
            else if (r.joint.championAction && JSON.stringify(r.joint.championAction) !== JSON.stringify(r.action)) jointStats.overrides += 1;
            else if (r.joint.championAction) jointStats.championDirect += 1;
          }
        }
        if (diagnostics) {
          // 任务 H：诊断流含保守仲裁分数（覆盖过度/预算不足分类必需）。
          const chosen = r.joint?.chosen ?? null;
          diagnostics.push({
            seed, seatCount, direction: candidateSeats.length === 1 ? 'A' : 'B', seat,
            turnNumber: game.turnNumber, phase: game.phase,
            elapsedMs: Number(r.joint?.stats?.elapsedMs?.toFixed(3) ?? 0),
            rollouts: r.joint?.stats?.rollouts ?? 0,
            gated: r.joint?.gated ?? null,
            action: r.action, championAction: r.joint?.championAction ?? null,
            chosenMean: chosen?.mean ?? null, chosenSe: chosen?.se ?? null, chosenTrials: chosen?.trials ?? null,
            candidateCount: r.joint?.stats?.candidateCount ?? null,
            racingEliminated: r.joint?.stats?.racingEliminated ?? null,
            reason: r.reason,
            candidateSeats, candidateId: version.id,
            configHash: r.config?.hash ?? null,
          });
        }
      } else if (version.candidate && version.kind === 'champion') {
        // P0-1 整改：候选（js0/js1）经不可变版本描述符分派——冻结归档参数 +
        // 显式结构，绝不传 CHAMPION_PARAMETERS（活动冠军别名）。
        const d = version.descriptor;
        const opts = decisionOptions(d);
        const r = chooseAIAction(game, { ...opts.beam, profile: seatProfile(seat) });
        action = r.action;
        if (diagnostics) {
          diagnostics.push({
            seed, seatCount, direction: candidateSeats.length === 1 ? 'A' : 'B', seat,
            turnNumber: game.turnNumber, phase: game.phase,
            elapsedMs: 0, rollouts: 0, gated: null,
            action: r.action, championAction: r.action, reason: r.reason,
            candidateSeats, candidateId: version.id,
          });
        }
      } else if (version.randomLegal) {
        action = randomLegalAction(game, rngFor(seat));
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

/** 运行一个 (版本, 人数) 消融单元：双向配对 + 座位轮换。
 * pool：'classic'（缺省）| 'diverse'（第五阶段 D2 对手池维度）。
 * diagnostics：可选数组（任务 G 逐决策诊断流；调用方收集后落盘 JSONL）。 */
export function runAblationCell({ candidateId, seatCount, seeds, seedBase, jointOptions, pool = 'classic', diagnostics, directions = ['A', 'B'] }) {
  // 种子块链（升序）；PHASE6_* 与 JS5_GOAL_* 存在三处登记重叠（并行会话，
  // 见 seed_policy.mjs 重叠披露）——重叠区间内 assertInBlock 对两块均放行，
  // 分支顺序仅决定报告标签，不影响种子合法性断言。
  assertInBlock(seedBase, seedBase < 1_310_000_000
    ? [1_300_000_000, 1_310_000_000]
    : seedBase < 1_320_000_000 ? [1_310_000_000, 1_320_000_000]
    : seedBase < 1_330_000_000 ? [1_320_000_000, 1_330_000_000]
    : seedBase < 1_340_000_000 ? [1_330_000_000, 1_340_000_000]
    : seedBase < AI6_JS5_TUNE2_SUBBLOCK[1] ? AI6_JS5_TUNE2_SUBBLOCK
    : seedBase < AI6_PHASE6_DEV_SUBBLOCK[1] ? AI6_PHASE6_DEV_SUBBLOCK
    : seedBase < AI6_PHASE6_TUNE_SUBBLOCK[1] ? AI6_PHASE6_TUNE_SUBBLOCK
    : seedBase < AI6_PHASE6_PERF_SUBBLOCK[1] ? AI6_PHASE6_PERF_SUBBLOCK
    : seedBase < AI6_JS5_CONFIRM_SUBBLOCK[1] ? AI6_JS5_CONFIRM_SUBBLOCK
    : seedBase < AI6_PHASE6_2P_SUBBLOCK[1] ? AI6_PHASE6_2P_SUBBLOCK
    : seedBase < AI6_JS5_GOAL_PERF_SUBBLOCK[1] ? AI6_JS5_GOAL_PERF_SUBBLOCK
    : seedBase < AI6_PHASE6_BUDGET_SUBBLOCK[1] ? AI6_PHASE6_BUDGET_SUBBLOCK
    : seedBase < AI6_JS5_GOAL_CONFIRM_SUBBLOCK[1] ? AI6_JS5_GOAL_CONFIRM_SUBBLOCK
    : seedBase < AI6_PHASE6_CONFIRM_SUBBLOCK[1] ? AI6_PHASE6_CONFIRM_SUBBLOCK
    : AI7_CANDIDATE_DEV_SUBBLOCK, 'seedBase');
  const candidate = candidateVersion(candidateId);
  const opponents = pool === 'diverse' ? diversePool() : classicPool();
  const games = [];
  const seedPairs = [];
  for (let i = 0; i < seeds; i++) {
    const seed = seedBase + i;
    const seatA = [i % seatCount];
    const seatB = Array.from({ length: seatCount }, (_, s) => s).filter(s => s !== i % seatCount);
    const a = directions.includes('A')
      ? runGame({ seed, seatCount, candidateSeats: seatA, candidate, opponents, jointOptions, diagnostics })
      : null;
    const b = directions.includes('B')
      ? runGame({ seed, seatCount, candidateSeats: seatB, candidate, opponents, jointOptions, diagnostics })
      : null;
    for (const [direction, r, seats] of [['A', a, seatA], ['B', b, seatB]]) {
      if (!r) continue;
      games.push({ seed, direction, candidateSeats: seats, seatCount, ...r });
    }
    const finished = [a, b].filter(Boolean);
    if (finished.length && finished.every(r => r.status === 'finished')) {
      seedPairs.push({
        seed, status: 'finished',
        diff: Number((finished.reduce((s, r) => s + r.scoreDiff, 0) / finished.length).toFixed(4)),
        anomalies: 0,
      });
    } else {
      seedPairs.push({ seed, status: 'anomaly', diff: null, anomalies: finished.filter(r => r.status !== 'finished').length });
    }
  }
  return summarizeCell({ candidateId, seatCount, games, seedPairs, directions });
}

/** 汇总一个消融单元（对齐 runner.mjs 指标口径；方向分开披露）。
 * games 数组逐局披露（seed/direction/firstPlace/scoreDiff）——配对比较
 * （compare.mjs 的种子级配对 bootstrap）与审计复算必需。 */
function summarizeCell({ candidateId, seatCount, games, seedPairs, directions = ['A', 'B'] }) {
  const finished = games.filter(g => g.status === 'finished');
  const anomalies = games.length - finished.length;
  const summary = {
    candidateId, seatCount, directions,
    totalGames: games.length, finishedGames: finished.length, anomalies,
    anomalyReasons: Object.entries(games.filter(g => g.status !== 'finished').reduce((acc, g) => {
      const key = (g.reason ?? 'unknown').replace(/ seed.*$/, '').slice(0, 80);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})),
    games: games.map(g => ({
      seed: g.seed, direction: g.direction, candidateSeats: g.candidateSeats,
      status: g.status, won: g.won === true ? true : g.won === false ? false : null,
      meanRank: g.meanRank, meanScore: g.meanScore, scoreDiff: g.scoreDiff,
      winnerSeat: g.winnerSeat, moves: g.moves, versionsIds: g.versionsIds,
    })),
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
        gated: acc.gated + (g.jointStats.gated ?? 0),
        overrides: acc.overrides + (g.jointStats.overrides ?? 0),
        starvedFallbacks: acc.starvedFallbacks + (g.jointStats.starvedFallbacks ?? 0),
        championDirect: acc.championDirect + (g.jointStats.championDirect ?? 0),
      }), { rollouts: 0, transitions: 0, omTimeMs: 0, decisions: 0, gated: 0, overrides: 0, starvedFallbacks: 0, championDirect: 0 });
      const totalDecisionMs = latencies.reduce((s, x) => s + x, 0);
      summary.jointSearch = {
        decisions: agg.decisions,
        meanRolloutsPerDecision: Number((agg.rollouts / agg.decisions).toFixed(2)),
        meanTransitionsPerDecision: Number((agg.transitions / agg.decisions).toFixed(1)),
        omTimeMsTotal: Number(agg.omTimeMs.toFixed(1)),
        omTimeShare: totalDecisionMs > 0 ? Number((agg.omTimeMs / totalDecisionMs).toFixed(4)) : null,
        // 任务 E：门控触发率 / 覆盖（override）率 / 门控后保底冠军率 /
        // 预算饥饿回退率（门控触发但零试验 → 自然回退冠军行动）。
        gateTriggerRate: Number((agg.gated / agg.decisions).toFixed(4)),
        overrideRate: agg.gated > 0 ? Number((agg.overrides / agg.gated).toFixed(4)) : null,
        gatedChampionKeepRate: agg.gated > 0 ? Number((agg.championDirect / agg.gated).toFixed(4)) : null,
        gatedStarvedFallbackRate: agg.gated > 0 ? Number((agg.starvedFallbacks / agg.gated).toFixed(4)) : null,
      };
    }
  }
  return summary;
}

/** CLI：node training/joint/duel.mjs --candidates js2,js3 --players 2,5 --seeds 40 --block test [--budget 100] [--work 128] [--pool classic|diverse] [--diagnostics file.jsonl]
 * 第五阶段新增：--block confirm（独立确认块，按人数×池分区）/ --block tune2；
 * --pool diverse（D2 对手池维度）；--diagnostics（G 逐决策诊断 JSONL）；
 * --threshold/--cap/--claim-ranking/--margin（C3 敏感性分析选项）。
 * 第六阶段新增：--block phase6-dev|phase6-tune|phase6-perf|phase6-2p|phase6-budget|
 * phase6-confirm；--seed-base（预算矩阵分区直传）；--allocation/--racing-delta/
 * --endgame/--opponent-mode（JS6 机制选项透传）。 */
function parseArgs() {
  const args = {
    candidates: ['js2', 'js3'], players: [2, 5], seeds: 40, block: 'test', pool: 'classic',
    budgetMs: undefined, workUnits: undefined, horizon: undefined, worlds: undefined,
    gateMode: undefined, evaluator: undefined, overrideMargin: undefined,
    contestThreshold: undefined, candidateCap: undefined, claimRanking: undefined,
    allocation: undefined, racingDelta: undefined, endgameMode: undefined, opponentMode: undefined,
    nearTerminalCandidate: undefined, screenGoalScope: undefined, batchAdmission: undefined,
    directions: ['A', 'B'],
    outDir: resolve(REPO_ROOT, 'training/reports/joint-search-v1'), diagnostics: undefined,
    seedBase: undefined,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--candidates') args.candidates = argv[++i].split(',');
    else if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--block') args.block = argv[++i];
    else if (argv[i] === '--pool') args.pool = argv[++i];
    else if (argv[i] === '--budget') args.budgetMs = Number(argv[++i]);
    else if (argv[i] === '--work') args.workUnits = Number(argv[++i]);
    else if (argv[i] === '--horizon') args.horizon = Number(argv[++i]);
    else if (argv[i] === '--worlds') args.worlds = Number(argv[++i]);
    else if (argv[i] === '--gate') args.gateMode = argv[++i];
    else if (argv[i] === '--evaluator') args.evaluator = argv[++i];
    else if (argv[i] === '--margin') args.overrideMargin = Number(argv[++i]);
    else if (argv[i] === '--threshold') args.contestThreshold = Number(argv[++i]);
    else if (argv[i] === '--cap') args.candidateCap = Number(argv[++i]);
    else if (argv[i] === '--claim-ranking') args.claimRanking = argv[++i];
    else if (argv[i] === '--allocation') args.allocation = argv[++i];
    else if (argv[i] === '--racing-delta') args.racingDelta = Number(argv[++i]);
    else if (argv[i] === '--endgame') args.endgameMode = argv[++i];
    else if (argv[i] === '--opponent-mode') args.opponentMode = argv[++i];
    else if (argv[i] === '--seed-base') args.seedBase = Number(argv[++i]);
    else if (argv[i] === '--near-terminal') args.nearTerminalCandidate = argv[++i];
    else if (argv[i] === '--screen-scope') args.screenGoalScope = argv[++i];
    else if (argv[i] === '--batch-admission') args.batchAdmission = argv[++i];
    else if (argv[i] === '--directions') args.directions = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (argv[i] === '--diagnostics') args.diagnostics = resolve(argv[++i]);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

/** 独立确认块分区（ai5/lib/seed_policy.mjs AI6_JS5_CONFIRM_SUBBLOCK 布局）：
 * seedBase = 1.36e9 + (人数−2)×1e6 + (diverse 池 ? 5e5 : 0)——每个
 * (人数, 对手池) 组合独占 50 万种子；配对候选共享同一种子（配对设计），
 * 不同人数/对手池/实验阶段绝不共享种子。 */
export function confirmSeedBase(seatCount, pool) {
  if (!Number.isSafeInteger(seatCount) || seatCount < 2 || seatCount > 5) {
    throw new Error(`confirm 块人数必须为 2..5，实际：${seatCount}`);
  }
  const [blockStart] = AI6_JS5_CONFIRM_SUBBLOCK;
  return blockStart + (seatCount - 2) * 1_000_000 + (pool === 'diverse' ? 500_000 : 0);
}

/** 第六阶段确认块分区（AI6_PHASE6_CONFIRM_SUBBLOCK [1.382e9,1.4e9)）：
 * seedBase = 1.382e9 + (人数−2)×3e6 + (diverse 池 ? 1.5e6 : 0)——每
 * (人数, 对手池) 组合独占 150 万种子（本阶段实验单元更多，分区加大）。 */
export function phase6ConfirmSeedBase(seatCount, pool) {
  if (!Number.isSafeInteger(seatCount) || seatCount < 2 || seatCount > 5) {
    throw new Error(`phase6-confirm 块人数必须为 2..5，实际：${seatCount}`);
  }
  const [blockStart] = AI6_PHASE6_CONFIRM_SUBBLOCK;
  return blockStart + (seatCount - 2) * 3_000_000 + (pool === 'diverse' ? 1_500_000 : 0);
}

/** 第六阶段双人专项块分区（AI6_PHASE6_2P_SUBBLOCK [1.37e9,1.372e9)）：
 * 仅 2 人局；seedBase = 1.37e9 + (diverse 池 ? 1e6 : 0)。 */
export function phase6TwoPlayerSeedBase(pool) {
  const [blockStart] = AI6_PHASE6_2P_SUBBLOCK;
  return blockStart + (pool === 'diverse' ? 1_000_000 : 0);
}

async function main() {
  const args = parseArgs();
  if (args.block === 'confirm') {
    // 独立确认块：分区由 (人数, 池) 决定（见 confirmSeedBase）。
  } else if (args.block === 'tune2') {
    // 本阶段调参/敏感性块 [1.351e9,1.352e9)。
  }
  const seedBase = args.block === 'confirm'
    ? null // 按 (人数, 池) 逐 cell 决定
    : args.block === 'phase6-confirm'
      ? null // 按 (人数, 池) 逐 cell 决定（phase6ConfirmSeedBase）
      : args.block === 'phase6-2p'
        ? null // 按 池 逐 cell 决定（phase6TwoPlayerSeedBase）
        : args.seedBase !== undefined ? args.seedBase
        : args.block === 'phase6-budget' ? null // 预算矩阵由运行脚本计算分区后经 --seed-base 传入
        : args.block === 'goal-confirm' ? AI6_JS5_GOAL_CONFIRM_SUBBLOCK[0]
        : args.block === 'goal-dev' ? AI6_JS5_GOAL_DEV_SUBBLOCK[0]
        : args.block === 'ai7-dev' ? AI7_CANDIDATE_DEV_SUBBLOCK[0]
        : args.block === 'tune2' ? 1_351_000_000
        : args.block === 'phase6-dev' ? 1_352_000_000
        : args.block === 'phase6-tune' ? 1_353_000_000
        : args.block === 'phase6-perf' ? 1_354_000_000
        : args.block === 'tune' ? 1_310_000_000
        : args.block === 'test' ? 1_320_000_000
        : args.block === 'audit' ? 1_300_000_000
        : args.block === 'verify' ? 1_330_000_000
        : (() => { throw new Error(`--block 必须是 tune|tune2|test|audit|verify|confirm|phase6-dev|phase6-tune|phase6-perf|phase6-2p|phase6-budget|phase6-confirm|goal-dev|goal-confirm|ai7-dev，实际：${args.block}`); })();
  const jointOptions = {
    ...(args.budgetMs !== undefined ? { budgetMs: args.budgetMs } : {}),
    ...(args.workUnits !== undefined ? { workUnits: args.workUnits } : {}),
    ...(args.horizon !== undefined ? { horizon: args.horizon } : {}),
    ...(args.worlds !== undefined ? { worlds: args.worlds } : {}),
    ...(args.gateMode !== undefined ? { gateMode: args.gateMode } : {}),
    ...(args.evaluator !== undefined ? { evaluator: args.evaluator } : {}),
    ...(args.overrideMargin !== undefined ? { overrideMargin: args.overrideMargin } : {}),
    ...(args.contestThreshold !== undefined ? { contestThreshold: args.contestThreshold } : {}),
    ...(args.candidateCap !== undefined ? { candidateCap: args.candidateCap } : {}),
    ...(args.claimRanking !== undefined ? { claimRanking: args.claimRanking } : {}),
    ...(args.allocation !== undefined ? { allocation: args.allocation } : {}),
    ...(args.racingDelta !== undefined ? { racingDelta: args.racingDelta } : {}),
    ...(args.endgameMode !== undefined ? { endgameMode: args.endgameMode } : {}),
    ...(args.opponentMode !== undefined ? { opponentMode: args.opponentMode } : {}),
    ...(args.nearTerminalCandidate !== undefined ? { nearTerminalCandidate: args.nearTerminalCandidate } : {}),
    ...(args.screenGoalScope !== undefined ? { screenGoalScope: args.screenGoalScope } : {}),
    ...(args.batchAdmission !== undefined ? { batchAdmission: args.batchAdmission } : {}),
  };
  const diagnostics = args.diagnostics ? [] : null;
  const cells = [];
  for (const candidateId of args.candidates) {
    for (const seatCount of args.players) {
      const cellSeedBase = args.block === 'confirm' ? confirmSeedBase(seatCount, args.pool)
        : args.block === 'phase6-confirm' ? phase6ConfirmSeedBase(seatCount, args.pool)
        : args.block === 'phase6-2p' ? phase6TwoPlayerSeedBase(args.pool)
        : seedBase;
      process.stdout.write(`运行 ${candidateId} ${seatCount}人 ${args.seeds}种子(${args.block},${args.pool}) ...\n`);
      const t0 = performance.now();
      const cell = runAblationCell({ candidateId, seatCount, seeds: args.seeds, seedBase: cellSeedBase, jointOptions, pool: args.pool, diagnostics, directions: args.directions });
      const fmt = d => cell[d] ? `${(cell[d].firstPlace.point * 100).toFixed(1)}% [${(cell[d].firstPlace.lower * 100).toFixed(1)},${(cell[d].firstPlace.upper * 100).toFixed(1)}]` : '-';
      process.stdout.write(`  完成 ${Math.round(performance.now() - t0)}ms｜方向A ${fmt('directionA')} 方向B ${fmt('directionB')} 异常 ${cell.anomalies}\n`);
      cells.push(cell);
    }
  }
  const report = {
    schema: 'century-joint-search-ablation-v1',
    date: new Date().toISOString(),
    codeCommit: GIT_HEAD,
    engineBundleSha256: engineBundleSha256(),
    block: args.block, seedBase: args.block === 'confirm' || args.block === 'phase6-confirm' || args.block === 'phase6-2p' || args.block === 'phase6-budget'
      ? 'partitioned-by-(players,pool[,budget,compare])' : seedBase, seeds: args.seeds,
    pool: args.pool, directions: args.directions,
    // P0-1 整改：报告披露不可变版本注册表快照与候选描述符——
    // 「标签身份 = 执行身份」可由指纹独立复核（运行指纹另列）。
    versionRegistry: describeVersionRegistry(),
    simStream: { domain: 'derived-v1', salt: DEFAULT_SIM_SALT, note: 'AI 信念采样流 = sha256(salt:对局种子) 31 位（独立域，不暴露牌库洗牌种子）' },
    candidateDescriptors: args.candidates
      .filter(id => id === 'js0' || id === 'js1')
      .map(id => { const d = candidateVersion(id).descriptor; return { registryId: d.registryId, core: d.core, structure: d.structure, fingerprint: d.fingerprint, source: d.source }; }),
    jointOptions, note: 'JS 编号为本阶段消融编号（JS0–JS5），非 PR #22 的 B0/B1/B2。confirm 块分区见 seed_policy.mjs AI6_JS5_CONFIRM_SUBBLOCK；phase6-* 块见 AI6_PHASE6_*；goal-dev/goal-confirm 见 AI6_JS5_GOAL_*（研究块，不写正式账本）。',
    cells,
  };
  mkdirSync(args.outDir, { recursive: true });
  const optionTag = [
    args.workUnits !== undefined ? `w${args.workUnits}` : null,
    args.budgetMs !== undefined ? `b${args.budgetMs}` : null,
    args.allocation ? `al-${args.allocation}` : null,
    args.racingDelta !== undefined ? `rd-${args.racingDelta}` : null,
    args.endgameMode ? `eg-${args.endgameMode}` : null,
    args.opponentMode ? `om-${args.opponentMode}` : null,
    args.seedBase !== undefined ? `sb-${args.seedBase}` : null,
    args.nearTerminalCandidate ? `nt-${args.nearTerminalCandidate}` : null,
    args.screenGoalScope ? `sc-${args.screenGoalScope}` : null,
    args.batchAdmission ? `ba-${args.batchAdmission}` : null,
    args.claimRanking ? `cr-${args.claimRanking}` : null,
  ].filter(Boolean).join('-') || 'base';
  const suffix = `${args.block}-${args.candidates.join('_')}-${args.players.join('_')}-${args.seeds}s${args.pool === 'diverse' ? '-div' : ''}-${optionTag}`;
  const out = resolve(args.outDir, `ablation-${suffix}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  if (diagnostics) {
    writeFileSync(args.diagnostics, diagnostics.map(d => JSON.stringify(d)).join('\n') + '\n');
    process.stdout.write(`诊断流已写入：${args.diagnostics}（${diagnostics.length} 条决策）\n`);
  }
  process.stdout.write(`结果已写入：${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('duel.mjs')) {
  main().catch(error => { console.error(error); process.exit(1); });
}
