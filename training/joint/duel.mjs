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

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction, score as engineScore, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS, BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { assertInBlock, AI6_JS5_CONFIRM_SUBBLOCK, AI6_JS5_TUNE2_SUBBLOCK } from '../../ai5/lib/seed_policy.mjs';
import { firstPlaceClusterCI, pairedDiffSummary, latencySummary } from '../baseline/stats.mjs';
import { wilsonCI, meanCI } from '../evaluator/stats.mjs';
import { REPO_ROOT, engineBundleSha256 } from '../lib/paths.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { beamBaseParameters } from '../lib/opponents.mjs';
import { enumerateLegalActions } from '../../web-v1/dist/js/sim/legal.js';

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

/** 对手池（不含候选本体）：冻结冠军 + 中立基线 + 风格变体。冠军本体席位保持
 * 适配器分派（行为 = 当前冠军）；风格变体席位经 beamBaseParameters 归一化——
 * audit 修复（2026-10-24）：此前 {...CHAMPION_PARAMETERS} 浅拷贝携带 adapter，
 * 变体被静默分派到 JS5 联合搜索，权重 100% 失效（变体 ≡ 冠军本体）。
 *
 * 第五阶段任务 D2：对手池分两套，作为独立评测维度披露——
 * - classic（缺省，与 PR #26/27 一致）：冠军同族风格变体；
 * - diverse：算法结构更多样的对手——历史冠军（AI4 struct-beam-rollout 归档参数）、
 *   手调 rush/engine 风格、随机合法策略（uniform-legal，与冠军
 *   算法结构完全不同）。历史冠军参数从 training/champions/candidates/ 读取。 */
function historicalChampionParameters() {
  const path = resolve(REPO_ROOT, 'training/champions/candidates/struct-beam-rollout.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const params = doc.parameters ?? doc;
  if (!params?.id) throw new Error(`历史冠军归档缺少 parameters.id：${path}`);
  return beamBaseParameters(params);
}

function classicPool() {
  const c = CHAMPION_PARAMETERS;
  const base = beamBaseParameters(c);
  return [
    { id: c.id, parameters: c, structure: c.structure },
    { id: 'neutral-baseline', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure },
    { id: `${c.id}@tempo`, parameters: { ...base, tempoWeight: Math.min(1.5, base.tempoWeight * 1.35), restWeight: Math.max(0.5, base.restWeight * 0.8) }, structure: base.structure },
    { id: `${c.id}@contest`, parameters: { ...base, contestWeight: Math.min(2, base.contestWeight * 1.4), goalWeight: Math.min(1.5, base.goalWeight * 1.15) }, structure: base.structure },
    { id: `${c.id}@engine`, parameters: { ...base, engineWeight: Math.min(1.5, base.engineWeight * 1.3), endgameWeight: Math.min(1.5, base.endgameWeight * 1.1) }, structure: base.structure },
  ];
}

function diversePool() {
  const c = CHAMPION_PARAMETERS;
  const base = beamBaseParameters(c);
  return [
    { id: c.id, parameters: c, structure: c.structure },
    { id: 'ai4-struct-beam-rollout', parameters: historicalChampionParameters(), structure: historicalChampionParameters().structure },
    { id: 'style-rush', parameters: { ...base, tempoWeight: 1.6, restWeight: 0.5, engineWeight: 0.5, endgameWeight: 0.6 }, structure: base.structure },
    { id: 'style-engine', parameters: { ...base, engineWeight: 1.6, capacityWeight: 1.4, tempoWeight: 0.7 }, structure: base.structure },
    { id: 'random-legal', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure, randomLegal: true },
  ];
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

/** 单局：候选 + 对手混合席位，返回候选阵营指标。
 * 第五阶段扩展：simSeed = 对局种子（联合模拟随机流跨局独立——PR #27 的
 * duel 未传 simSeed，全部对局共用 0，跨局模拟噪声相关；本参数只影响
 * 联合候选的信念/对手采样熵，不改变算法语义，js0/js1 不消费该值）；
 * gated/override/回退统计（任务 E）；逐决策诊断流（任务 G，可选）。 */
function runGame({ seed, seatCount, candidateSeats, candidate, opponents, jointOptions, maxMoves = 1200, deadlineMs = 120_000, diagnostics }) {
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
      if (performance.now() - started > deadlineMs) return { status: 'anomaly', reason: `单局超时 ${deadlineMs}ms` };
      const seat = game.current;
      const version = versions[seat];
      const t0 = performance.now();
      let action;
      if (version.candidate && version.kind === 'joint') {
        const r = chooseJointAction(game, { version: version.joint, ...jointOptions, simSeed: seed, profile: seatProfile(seat) });
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
          diagnostics.push({
            seed, seatCount, direction: candidateSeats.length === 1 ? 'A' : 'B', seat,
            turnNumber: game.turnNumber, phase: game.phase,
            elapsedMs: Number(r.joint?.stats?.elapsedMs?.toFixed(3) ?? 0),
            rollouts: r.joint?.stats?.rollouts ?? 0,
            gated: r.joint?.gated ?? null,
            action: r.action, championAction: r.joint?.championAction ?? null,
            reason: r.reason,
            candidateSeats,
          });
        }
      } else if (version.candidate && version.kind === 'champion') {
        const r = chooseAIAction(game, {
          parameters: CHAMPION_PARAMETERS,
          ...(version.structure ? { structure: version.structure } : {}),
          profile: seatProfile(seat),
        });
        action = r.action;
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
export function runAblationCell({ candidateId, seatCount, seeds, seedBase, jointOptions, pool = 'classic', diagnostics }) {
  assertInBlock(seedBase, seedBase < 1_310_000_000
    ? [1_300_000_000, 1_310_000_000]
    : seedBase < 1_320_000_000 ? [1_310_000_000, 1_320_000_000]
    : seedBase < 1_330_000_000 ? [1_320_000_000, 1_330_000_000]
    : seedBase < 1_340_000_000 ? [1_330_000_000, 1_340_000_000]
    : seedBase < AI6_JS5_TUNE2_SUBBLOCK[1] ? AI6_JS5_TUNE2_SUBBLOCK
    : AI6_JS5_CONFIRM_SUBBLOCK, 'seedBase');
  const candidate = candidateVersion(candidateId);
  const opponents = pool === 'diverse' ? diversePool() : classicPool();
  const games = [];
  const seedPairs = [];
  for (let i = 0; i < seeds; i++) {
    const seed = seedBase + i;
    const seatA = [i % seatCount];
    const seatB = Array.from({ length: seatCount }, (_, s) => s).filter(s => s !== i % seatCount);
    const a = runGame({ seed, seatCount, candidateSeats: seatA, candidate, opponents, jointOptions, diagnostics });
    const b = runGame({ seed, seatCount, candidateSeats: seatB, candidate, opponents, jointOptions, diagnostics });
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

/** 汇总一个消融单元（对齐 runner.mjs 指标口径；方向分开披露）。
 * games 数组逐局披露（seed/direction/firstPlace/scoreDiff）——配对比较
 * （compare.mjs 的种子级配对 bootstrap）与审计复算必需。 */
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
 * --threshold/--cap/--claim-ranking/--margin（C3 敏感性分析选项）。 */
function parseArgs() {
  const args = {
    candidates: ['js2', 'js3'], players: [2, 5], seeds: 40, block: 'test', pool: 'classic',
    budgetMs: undefined, workUnits: undefined, horizon: undefined, worlds: undefined,
    gateMode: undefined, evaluator: undefined, overrideMargin: undefined,
    contestThreshold: undefined, candidateCap: undefined, claimRanking: undefined,
    outDir: resolve(REPO_ROOT, 'training/reports/joint-search-v1'), diagnostics: undefined,
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

async function main() {
  const args = parseArgs();
  if (args.block === 'confirm') {
    // 独立确认块：分区由 (人数, 池) 决定（见 confirmSeedBase）。
  } else if (args.block === 'tune2') {
    // 本阶段调参/敏感性块 [1.351e9,1.352e9)。
  }
  const seedBase = args.block === 'confirm'
    ? null // 按 (人数, 池) 逐 cell 决定
    : args.block === 'tune2' ? 1_351_000_000
    : args.block === 'tune' ? 1_310_000_000
    : args.block === 'test' ? 1_320_000_000
    : args.block === 'audit' ? 1_300_000_000
    : args.block === 'verify' ? 1_330_000_000
    : (() => { throw new Error(`--block 必须是 tune|tune2|test|audit|verify|confirm，实际：${args.block}`); })();
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
  };
  const diagnostics = args.diagnostics ? [] : null;
  const cells = [];
  for (const candidateId of args.candidates) {
    for (const seatCount of args.players) {
      const cellSeedBase = args.block === 'confirm' ? confirmSeedBase(seatCount, args.pool) : seedBase;
      process.stdout.write(`运行 ${candidateId} ${seatCount}人 ${args.seeds}种子(${args.block},${args.pool}) ...\n`);
      const t0 = performance.now();
      const cell = runAblationCell({ candidateId, seatCount, seeds: args.seeds, seedBase: cellSeedBase, jointOptions, pool: args.pool, diagnostics });
      const fmt = d => cell[d] ? `${(cell[d].firstPlace.point * 100).toFixed(1)}% [${(cell[d].firstPlace.lower * 100).toFixed(1)},${(cell[d].firstPlace.upper * 100).toFixed(1)}]` : '-';
      process.stdout.write(`  完成 ${Math.round(performance.now() - t0)}ms｜方向A ${fmt('directionA')} 方向B ${fmt('directionB')} 异常 ${cell.anomalies}\n`);
      cells.push(cell);
    }
  }
  const report = {
    schema: 'century-joint-search-ablation-v1',
    date: new Date().toISOString(),
    engineBundleSha256: engineBundleSha256(),
    block: args.block, seedBase: args.block === 'confirm' ? 'partitioned-by-(players,pool)' : seedBase, seeds: args.seeds,
    pool: args.pool,
    jointOptions, note: 'JS 编号为本阶段消融编号（JS0–JS5），非 PR #22 的 B0/B1/B2。confirm 块分区见 seed_policy.mjs AI6_JS5_CONFIRM_SUBBLOCK。',
    cells,
  };
  mkdirSync(args.outDir, { recursive: true });
  const suffix = `${args.block}-${args.candidates.join('_')}-${args.players.join('_')}-${args.seeds}s${args.pool === 'diverse' ? '-div' : ''}`;
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
