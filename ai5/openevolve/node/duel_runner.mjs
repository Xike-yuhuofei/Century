/** AI5 同局双版本对战运行器：候选代码与冠军代码按席位隔离注入。
 *
 * 这是 AI5 区别于 AI 4.0 模拟器的核心机制：
 * - 规则引擎只有一份：官方编译产物 web-v1/dist/js/engine.js（与网页版相同）；
 * - 冠军 AI 代码：官方编译产物 web-v1/dist/js/ai.js（永不修改）；
 * - 候选 AI 代码：独立编译的候选树 <workdir>/dist/js/ai.js（只替换了
 *   acquisitionValue 函数）；
 * - 两个 AI 模块在进程内是两个互不共享状态的 ESM 模块实例，按席位分别
 *   引用 —— 候选算法绝不替换公共编译产物，对照组冠军运行的永远是官方代码。
 *
 * 配对语义（与 AI 4.0 挑战一致的角色匹配配对）：
 * - 每个种子打两局：局 1 候选@席位 0（中立代理位），局 2 候选@席位 4（战术大师位）；
 * - 配对分差 = [(cand@0局1 − champ@0局2) + (cand@4局2 − champ@4局1)] / 2，
 *   即候选与冠军在相同人格席位上的得分对比，共享同种子洗牌序列；
 * - 输出 seedPairs 与 training/evaluator/stats.mjs 的 pairedPromotionDecision /
 *   firstPlaceStats 直接兼容（统计实现复用 AI 4.0，不另起炉灶）。
 *
 * 用法：
 *   node duel_runner.mjs --candidate <workdir>/dist/js/ai.js \
 *     --seed-base 300000000 --seeds 24 --out <results.json>
 *   node duel_runner.mjs --candidate-official ...   # 候选=官方代码（实验 A 用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGame, applyAction, score, ranking, count } from '../../../web-v1/dist/js/engine.js';
import * as officialAI from '../../../web-v1/dist/js/ai.js';
import { pairedPromotionDecision, firstPlaceStats } from '../../../training/evaluator/stats.mjs';
import { analyzeSeatStratum } from '../../../training/evaluator/first-place.mjs';
import { ENGINE_SEED_MAX } from '../../../training/lib/seeds.mjs';
import { parseSeedList, AI5_BLOCK } from '../../lib/seed_policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_MAX_MOVES = 1200;
const DEFAULT_DEADLINE_MS = 60_000;

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const candidatePath = arg('candidate');          // 候选 ai.js 路径
const candidateOfficial = args.includes('--candidate-official');
const seedBase = Number(arg('seed-base', '300000000'));
const seedCount = Number(arg('seeds', '24'));
const seedListFile = arg('seed-list');           // 可选：显式种子列表（每行一个）
const outPath = arg('out');
const maxMoves = Number(arg('max-moves', String(DEFAULT_MAX_MOVES)));
const deadlineMs = Number(arg('deadline-ms', String(DEFAULT_DEADLINE_MS)));
// P3 确定性：固定 workUnits 让同一 (seed, 席位, 版本) 的决策逐位可复现；
// 不给定时保持官方冠军冻结行为（budgetMs 墙钟），仅作历史复现/诊断。
const workUnitsArg = arg('work-units');
const workUnits = workUnitsArg === null ? null : Number(workUnitsArg);
if (workUnits !== null && (!Number.isSafeInteger(workUnits) || workUnits < 1 || workUnits > 4096)) {
  console.error(`--work-units 必须为 1–4096 的整数，实际：${String(workUnitsArg)}`);
  process.exit(2);
}
// P0 迁移：研究 fitness 的主指标也改为「焦点席位配对第一名率增量」。
// score-advantage 保留为历史复现/诊断口径。
const primary = arg('primary', 'score-advantage');
if (!['score-advantage', 'first-place'].includes(primary)) {
  console.error(`--primary 必须为 score-advantage|first-place，实际：${primary}`);
  process.exit(2);
}
const firstPlaceMode = primary === 'first-place';
if (!candidatePath && !candidateOfficial) { console.error('缺少 --candidate 或 --candidate-official'); process.exit(2); }

// 种子纪律：AI5 快速筛选只使用训练池 [300M, 400M) 内的 AI5 专用子块，
// 不触碰 AI 4.0 日常进化 [0, 300M)、基准评测 [400M, 900M) 与验证池 [900M, ∞)。
// （常量定义移入 ai5/lib/seed_policy.mjs，与 Python 侧逐值对齐。）

/** P0 可靠性整改：种子列表解析统一走 seed_policy.parseSeedList——
 * 严格十进制整数（拒绝科学计数法）、区间校验、唯一种子强制。
 * 事故背景：旧实现 Number() 会静默接受 "3.00001e+08"，101 行重复种子
 * 让 101 个"独立"配对样本实为 1 个，独立验证结论失真（已废止归档）。 */
function loadSeeds() {
  if (seedListFile) {
    const text = readFileSync(seedListFile, 'utf8');
    return parseSeedList(text, { block: AI5_BLOCK, requireUnique: true });
  }
  const list = [];
  for (let i = 0; i < seedCount; i++) {
    const s = seedBase + i;
    if (s < AI5_BLOCK[0] || s >= AI5_BLOCK[1]) {
      throw new Error(`种子 ${s} 超出 AI5 训练子块 ${AI5_BLOCK.join('..')}（调整 --seed-base）`);
    }
    list.push(s);
  }
  return list;
}

// 冠军参数：显式传给两个 AI 模块的每个席位（belt-and-braces，即使参数区默认值
// 漂移，对战配置也逐字节锁定在 champion.json 上）。
const champion = JSON.parse(readFileSync(join(repoRoot, 'training/champions/champion.json'), 'utf8'));
const championParams = champion.parameters;

const { PROFILES, NEUTRAL_PROFILE } = officialAI;
const seatProfile = seat => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

/** 单局执行（复刻 training/simulator/simulate.mjs 的循环与异常语义，
 * 差异仅在于每个席位可引用不同的 AI 模块实例）。 */
async function playOne(aiModules, candSeat, seed) {
  const started = performance.now();
  const seats = Array.from({ length: 5 }, () => ({
    decisionCount: 0, totalDecisionMs: 0, maxDecisionMs: 0,
  }));
  const base = { seed, seatCount: 5, candidateSeat: candSeat, status: 'anomaly', reason: null };
  let game;
  try {
    game = createGame(Array.from({ length: 5 }, (_, i) => `席位${i}`), seed, [1, 2, 3, 4]);
    game.players[0].isAI = true; // 训练专用：人类席位由 AI 代理（与正式模拟器一致）
  } catch (error) {
    return { ...base, reason: `createGame 失败：${error.message}` };
  }
  let moves = 0;
  try {
    while (game.phase !== 'finished') {
      if (moves >= maxMoves) return { ...base, reason: `达到行动步数上限 ${maxMoves}`, moves };
      if (performance.now() - started > deadlineMs) return { ...base, reason: `超出单局时间预算 ${deadlineMs}ms`, moves };
      const seat = game.current;
      const ai = aiModules[seat];
      const decisionStart = performance.now();
      const response = ai.chooseAIAction(game, {
        parameters: championParams,
        profile: seatProfile(seat),
        ...(workUnits !== null ? { workUnits } : {}),
      });
      const decisionMs = performance.now() - decisionStart;
      const stats = seats[seat];
      stats.decisionCount += 1;
      stats.totalDecisionMs += decisionMs;
      if (decisionMs > stats.maxDecisionMs) stats.maxDecisionMs = decisionMs;
      game = applyAction(game, response.action); // 非法行动由正式引擎抛出 → 异常局
      moves += 1;
    }
  } catch (error) {
    return { ...base, reason: `对局异常：${error.message}`, moves };
  }
  const turnCounts = new Set(game.players.map(p => p.turns));
  if (turnCounts.size !== 1) {
    return { ...base, reason: '终局各席位回合数不一致，违反终局结算规则', moves };
  }
  const ranked = ranking(game);
  return {
    ...base,
    status: 'finished',
    moves,
    wallMs: Number((performance.now() - started).toFixed(2)),
    winnerSeat: ranked[0].id,
    ranking: ranked.map(p => ({ seat: p.id, score: score(p), golems: p.claimed.length, crystals: count(p.stock) })),
    metrics: {
      totalDecisionMs: Number(seats.reduce((s, x) => s + x.totalDecisionMs, 0).toFixed(2)),
      meanDecisionMs: Number((seats.reduce((s, x) => s + x.totalDecisionMs, 0) / Math.max(1, seats.reduce((s, x) => s + x.decisionCount, 0))).toFixed(3)),
      maxDecisionMs: Math.max(...seats.map(x => x.maxDecisionMs)),
    },
  };
}

const seatScore = (g, seat) => g.ranking?.find(r => r.seat === seat)?.score ?? null;

async function main() {
  // 候选模块动态加载（路径来自参数）；官方模块静态加载。两者必然是独立实例。
  const candidateAI = candidateOfficial
    ? officialAI
    : await import(pathToFileURL(resolve(candidatePath)).href);
  if (candidateAI === officialAI && !candidateOfficial) {
    console.error('警告：候选模块与官方模块是同一实例（不应发生）');
  }
  const modulesOf = candSeat => {
    const mods = Array.from({ length: 5 }, () => officialAI);
    mods[candSeat] = candidateAI;
    return mods;
  };

  const seeds = loadSeeds();
  const games = [];
  const seedPairs = [];
  const firstPlacePairs = [];
  const decisionMs = [];

  for (const [seedIndex, seed] of seeds.entries()) {
    if (firstPlaceMode) {
      // 焦点席位配对：A=候选控制焦点席位，B=冻结冠军控制同一焦点席位；
      // 其余席位在两局中都是官方冠军，种子/对手/席位完全一致。
      const focusSeat = seedIndex % 5;
      const gA = await playOne(modulesOf(focusSeat), focusSeat, seed);
      const gB = await playOne(Array.from({ length: 5 }, () => officialAI), focusSeat, seed);
      games.push({ direction: 'A', arm: 'candidate', focusSeat, ...gA },
        { direction: 'B', arm: 'champion', focusSeat, ...gB });
      const anomalies = (gA.status !== 'finished' ? 1 : 0) + (gB.status !== 'finished' ? 1 : 0);
      firstPlacePairs.push({
        seed,
        focusSeat,
        candidateFirst: gA.status === 'finished' && gA.winnerSeat === focusSeat ? 1 : 0,
        championFirst: gB.status === 'finished' && gB.winnerSeat === focusSeat ? 1 : 0,
        anomalies,
      });
      if (gA.status === 'finished' && gB.status === 'finished') {
        decisionMs.push(gA.metrics.meanDecisionMs, gB.metrics.meanDecisionMs);
        seedPairs.push({
          seed, status: 'finished',
          diff: seatScore(gA, focusSeat) - seatScore(gB, focusSeat),
          anomalies: 0,
          detail: { focusSeat },
        });
      } else {
        seedPairs.push({
          seed, status: 'anomaly', diff: 0, anomalies,
          reason: [gA.reason, gB.reason].filter(Boolean).join(' | '),
        });
      }
      continue;
    }
    // 局 1：候选@席位 0（中立代理位）；冠军占席位 1-4（各自人格位）。
    const g1 = await playOne(modulesOf(0), 0, seed);
    // 局 2：候选@席位 4（战术大师位）；冠军占席位 0-3（含中立位）。
    const g2 = await playOne(modulesOf(4), 4, seed);
    games.push({ direction: 'A', ...g1 }, { direction: 'B', ...g2 });

    const anomalies = (g1.status !== 'finished' ? 1 : 0) + (g2.status !== 'finished' ? 1 : 0);
    if (g1.status === 'finished' && g2.status === 'finished') {
      // 角色匹配配对分差（见文件头注释）。
      const pairA = seatScore(g1, 0) - seatScore(g2, 0); // 中立位：cand vs champ
      const pairB = seatScore(g2, 4) - seatScore(g1, 4); // 战术大师位：cand vs champ
      decisionMs.push(g1.metrics.meanDecisionMs, g2.metrics.meanDecisionMs);
      seedPairs.push({ seed, status: 'finished', diff: (pairA + pairB) / 2, anomalies: 0,
        detail: { pairNeutral: pairA, pairTactician: pairB } });
    } else {
      seedPairs.push({ seed, status: 'anomaly', diff: 0, anomalies,
        reason: [g1.reason, g2.reason].filter(Boolean).join(' | ') });
    }
  }

  const finishedGames = games.filter(g => g.status === 'finished');
  const anomalyGames = games.length - finishedGames.length;
  const sortedMs = decisionMs.sort((a, b) => a - b);
  const p95 = sortedMs.length ? sortedMs[Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * 0.95))] : null;

  const stats = {
    totalGames: games.length,
    uniqueSeedCount: seeds.length,
    finishedGames: finishedGames.length,
    anomalyGames,
    anomalyRate: Number((anomalyGames / Math.max(1, games.length)).toFixed(4)),
    paired: null, firstPlace: null,
    meanDecisionMs: sortedMs.length ? Number((sortedMs.reduce((a, b) => a + b, 0) / sortedMs.length).toFixed(2)) : null,
    p95DecisionMs: p95,
    meanScoreDiffPerSeed: null,
  };
  try {
    stats.paired = pairedPromotionDecision({ seedPairs, minSeeds: 8, maxAnomalyRate: 0.05 });
  } catch (e) { stats.paired = { verdict: 'error', reason: e.message }; }
  try {
    stats.firstPlace = firstPlaceStats(games.filter(g => g.status === 'finished'), { z: 1.959964 });
  } catch (e) { stats.firstPlace = { error: e.message }; }
  if (firstPlaceMode) {
    try {
      stats.firstPlaceDelta = analyzeSeatStratum({
        pairs: firstPlacePairs, minSeeds: 2, maxAnomalyRate: 0.5, seatCount: 5,
      });
    } catch (e) {
      stats.firstPlaceDelta = { status: 'error', reason: e.message };
    }
    stats.firstPlacePairs = firstPlacePairs;
    stats.primaryMetric = 'pairedFirstPlaceRateDelta';
  } else {
    stats.primaryMetric = 'pairedScoreAdvantage';
  }
  const diffs = seedPairs.filter(p => p.status === 'finished');
  if (diffs.length) {
    stats.meanScoreDiffPerSeed = Number((diffs.reduce((s, p) => s + p.diff, 0) / diffs.length).toFixed(3));
  }

  const result = {
    config: {
      candidate: candidateOfficial ? 'official-baseline' : resolve(candidatePath),
      paired: true, primary,
      seeds: seedListFile ? `file:${seedListFile}` : `${seedBase}..${seedBase + seedCount - 1}`,
      seedBlock: AI5_BLOCK,
      uniqueSeedCount: seeds.length,
      maxMoves, deadlineMs, workUnits,
      championId: champion.id, championParameters: championParams,
    },
    modules: { engine: 'web-v1/dist/js/engine.js (official)', championAI: 'web-v1/dist/js/ai.js (official)', candidateAI: candidateOfficial ? 'official' : resolve(candidatePath) },
    games, seedPairs, stats,
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, stats: { ...stats, paired: stats.paired?.verdict ?? null } }));
}

main().catch(error => { console.error(`duel_runner 失败：${error.message}`); process.exit(1); });
