/** Century 五人自动对战模拟器。
 *
 * 设计约束（对应任务书第五节）：
 * - 使用正式游戏规则引擎（web-v1/dist/js/engine.js，与网页版同一编译产物）执行全部行动，训练侧不实现任何规则副本。
 * - 每个席位可配置独立的 AI 版本（参数集）；未配置时使用当前冠军基线。
 * - 固定随机种子 + 座位配置即可完全复现一局。
 * - 人类席位约束：正式引擎要求至少 1 名人类、最多 4 名 AI。训练中人类席位由某个
 *   AI 版本代理（players[0].isAI = true），只影响训练环境，不影响正式游戏。
 * - 死循环 / 无进展 / 异常一律标记为 anomaly，绝不伪装成正常完成的对局，
 *   且聚合统计时与正常对局严格分离。
 */

import { createGame, applyAction, score, ranking, count } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE, validateAIParameters } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { ENGINE_SEED_MAX } from '../lib/seeds.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../lib/sim-stream.mjs';

export const DEFAULT_MAX_MOVES = 1200;
export const DEFAULT_DEADLINE_MS = 60_000;

/** 席位人格映射：与正式游戏（1 人类 + 4 AI）的 profileFor 结果逐席一致。
 * 正式游戏中 profileFor 只统计 isAI 玩家，第 n 个行动的 AI 得到第 n 种人格；
 * 训练模拟把席位 0 的人类替换为中立代理（NEUTRAL_PROFILE，全部乘子 1.0），
 * 席位 1-4 因此与正式游戏完全对齐（引擎大师/速攻专家/精算大师/战术大师），
 * 不再出现"代理席挤占人格序号"导致的错位与重复。 */
export function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

/** 每席位统计容器。 */
function seatStats(seatCount) {
  return Array.from({ length: seatCount }, () => ({
    acquireActions: 0, claimActions: 0, restActions: 0, playActions: 0,
    decisionCount: 0, totalDecisionMs: 0, maxDecisionMs: 0,
  }));
}

function emptyResult(seed, versions, seatCount) {
  return {
    status: 'anomaly', reason: null, seed, seatCount,
    versions: versions?.map(v => v?.id ?? 'baseline') ?? Array(seatCount).fill('baseline'),
    moves: 0, wallMs: 0, winnerSeat: null,
    ranking: [], metrics: null,
  };
}

/**
 * 模拟一局完整对局。
 * @param {object} options
 * @param {number} options.seed 引擎随机种子（洗牌与起始配置全部由此决定）
 * @param {Array<{id?:string, parameters?:object, structure?:string, adapter?:'champion-guided', jointVersion?:string, budgetMs?:number, gateMode?:string}|null>} [options.versions] 每席位 AI 版本（可带结构变体或显式适配器）；null 使用当前激活参数
 * @param {number} [options.seatCount] 席位数，默认 5（1 人类代理席 + 4 AI）
 * @param {number} [options.maxMoves] 单局行动步数上限（防死循环）
 * @param {number} [options.deadlineMs] 单局墙钟时间预算（毫秒，防长时间无进展）
 * @param {boolean} [options.collectReplay] 是否附带完整复盘数据
 * @param {boolean} [options.collectActions] 是否附带逐行动记录（诊断用）
 * @param {boolean} [options.collectDecisions] 是否逐决策采样耗时（基线评测 p50/p95/p99 用；
 *   纯遥测，默认关闭，不影响决策逻辑与对局结果）
 */
export function simulateGame(options) {
  const {
    seed, versions = null, seatCount = 5,
    maxMoves = DEFAULT_MAX_MOVES, deadlineMs = DEFAULT_DEADLINE_MS,
    collectReplay = false, collectActions = false, collectDecisions = false,
  } = options;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed 必须为非负安全整数');
  // P0 可靠性整改：引擎 generator 对种子做 `seed >>> 0`（mod 2^32 回绕），
  // 超过 2^31-1 的名义种子会回绕成镜像值——名义与实际序列脱钩，破坏复现与审计，
  // 且镜像可能落进验证种子池。训练系统所有种子分配必须留在安全范围内。
  if (seed > ENGINE_SEED_MAX) throw new Error(`seed ${seed} 超出引擎安全种子上限 ${ENGINE_SEED_MAX}（mod 2^32 回绕会破坏复现与训练/验证隔离）`);
  if (versions && versions.length !== seatCount) throw new Error('versions 数组长度必须等于 seatCount');

  const started = performance.now();
  const result = emptyResult(seed, versions, seatCount);
  let game;
  try {
    game = createGame(
      Array.from({ length: seatCount }, (_, i) => `席位${i}`),
      seed,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
    );
    // 训练专用：人类席位由 AI 版本代理，正式游戏与网页版不受影响。
    game.players[0].isAI = true;
  } catch (error) {
    return { ...result, reason: `createGame 失败：${error.message}` };
  }

  const seats = seatStats(seatCount);
  const actions = [];
  const decisionSamples = collectDecisions ? [] : null;
  let moves = 0;
  const tick = () => performance.now() - started;

  try {
    while (game.phase !== 'finished') {
      if (moves >= maxMoves) {
        return { ...result, reason: `达到行动步数上限 ${maxMoves}（疑似死循环或无进展）`, moves, wallMs: tick() };
      }
      if (tick() > deadlineMs) {
        return { ...result, reason: `超出单局时间预算 ${deadlineMs}ms`, moves, wallMs: tick() };
      }
      const seat = game.current;
      const version = versions?.[seat] ?? null;
      const decisionStart = performance.now();
      // 人格按正式游戏席位映射显式注入（席位 0 为中立人类代理），
      // 结构变体按版本配置透传（beam-lineage/beam-adaptive/beam-rollout），
      // 决策核心与正式游戏共用同一实现。
      // 显式适配器分派（AI6 第五阶段）：version.adapter === 'champion-guided' 时
      // 该席位走联合规划适配器（joint-js5：冠军引导选择性联合搜索，budgetMs 缺省
      // 100ms 墙钟）——与结构变体同一"一等公民候选"注入模式；冠军路径（无
      // adapter 字段）的决策分派逐字节不变，两版本同进程按席位隔离。
      // P0-5 整改（独立模拟随机流）：AI 信念采样流由独立域派生
      // （deriveSimStreamSeed，单向 + 域分离），不再把真实对局种子（=牌库洗牌
      // 种子）原样暴露给 AI——候选无法从 simSeed 反推牌库序；同盐同种子 ⇒ 同流
      // （配对 CRN 保持）；version.simSeed 显式覆盖仅供专项实验（留痕）。
      // AI9：编译型多模块候选按席位注入独立模块实例（候选/冠军代码互不共享）。
      // 未提供时逐字节走原官方入口（全部既有实验行为不变）。
      const aiChoose = version?.aiModule?.chooseAIAction ?? chooseAIAction;
      const jointChoose = version?.jointModule?.chooseJointAction ?? chooseJointAction;
      const response = version?.adapter === 'champion-guided'
        ? jointChoose(game, {
            version: version.jointVersion ?? 'joint-js5',
            ...(version.gateMode !== undefined ? { gateMode: version.gateMode } : {}),
            ...(version.budgetMs !== undefined ? { budgetMs: version.budgetMs } : {}),
            // P1：候选的联合搜索配置（search-control 目标）必须真实进入决策；
            // 不传时行为与旧路径逐字节一致。
            ...(version.jointOptions ? { ...version.jointOptions } : {}),
            // AI7-A2：席位描述符的参数必须显式传入并通过校验——冻结版本
            // （如 joint-js5 归档快照）不得回退读取活动 CHAMPION_PARAMETERS。
            ...(version.parameters ? { championParameters: validateAIParameters(version.parameters) } : {}),
            simSeed: version.simSeed ?? deriveSimStreamSeed(seed, version.simSalt ?? DEFAULT_SIM_SALT),
            profile: seatProfile(seat),
          })
        : aiChoose(game, {
            ...(version?.parameters ? { parameters: version.parameters } : {}),
            ...(version?.structure ? { structure: version.structure } : {}),
            profile: seatProfile(seat),
          });
      const decisionMs = performance.now() - decisionStart;
      const stats = seats[seat];
      stats.decisionCount += 1;
      stats.totalDecisionMs += decisionMs;
      if (decisionMs > stats.maxDecisionMs) stats.maxDecisionMs = decisionMs;
      if (decisionSamples) decisionSamples.push(Number(decisionMs.toFixed(3)));
      if (collectActions) actions.push({ move: moves, seat, action: response.action, reason: response.reason });

      const type = response.action.type;
      if (type === 'acquire') seats[seat].acquireActions += 1;
      else if (type === 'claim') seats[seat].claimActions += 1;
      else if (type === 'rest') seats[seat].restActions += 1;
      else if (type === 'play') seats[seat].playActions += 1;

      // 行动合法性由正式引擎强制校验：非法行动在此抛出 → 记为异常对局。
      game = applyAction(game, response.action);
      moves += 1;
    }
  } catch (error) {
    return {
      ...result,
      reason: `对局异常：${error.message}`,
      moves, wallMs: tick(),
      partialScores: game.players.map(p => score(p)),
    };
  }

  // 正常终局校验：各席位回合数必须一致（终局整轮结算规则）。
  const turnCounts = new Set(game.players.map(p => p.turns));
  if (turnCounts.size !== 1) {
    return { ...result, reason: '终局各席位回合数不一致，违反终局结算规则', moves, wallMs: tick() };
  }

  const ranked = ranking(game);
  const final = {
    ...result,
    status: 'finished',
    moves,
    wallMs: Number(tick().toFixed(2)),
    winnerSeat: ranked[0].id,
    ranking: ranked.map(p => ({
      seat: p.id, score: score(p), golems: p.claimed.length,
      copper: p.copper, silver: p.silver, crystals: count(p.stock),
      turns: p.turns,
    })),
    metrics: {
      seats,
      totalDecisionMs: Number(seats.reduce((s, x) => s + x.totalDecisionMs, 0).toFixed(2)),
      meanDecisionMs: Number(
        (seats.reduce((s, x) => s + x.totalDecisionMs, 0) /
          Math.max(1, seats.reduce((s, x) => s + x.decisionCount, 0))).toFixed(3),
      ),
      maxDecisionMs: Math.max(...seats.map(x => x.maxDecisionMs)),
    },
  };
  if (collectReplay) final.replay = game.replay;
  if (collectActions) final.actions = actions;
  if (decisionSamples) final.decisionSamplesMs = decisionSamples;
  return final;
}

/** 确定性指纹：剔除一切计时字段，同种子同配置必然相同。 */
export function deterministicKey(result) {
  const slim = {
    seed: result.seed, status: result.status, winnerSeat: result.winnerSeat,
    moves: result.moves,
    ranking: result.ranking.map(r => [r.seat, r.score, r.golems]),
    versions: result.versions,
  };
  return JSON.stringify(slim);
}

/** 聚合一批对局结果；正常局与异常局严格分开统计。 */
export function summarizeResults(results) {
  const finished = results.filter(r => r.status === 'finished');
  const anomalies = results.filter(r => r.status !== 'finished');
  const seatCount = finished[0]?.seatCount ?? results[0]?.seatCount ?? 5;
  const wins = Array(seatCount).fill(0);
  const scoreSum = Array(seatCount).fill(0);
  const golemSum = Array(seatCount).fill(0);
  for (const r of finished) {
    wins[r.winnerSeat] += 1;
    for (const row of r.ranking) {
      scoreSum[row.seat] += row.score;
      golemSum[row.seat] += row.golems;
    }
  }
  const games = finished.length;
  return {
    totalGames: results.length,
    finishedGames: games,
    anomalyGames: anomalies.length,
    anomalyRate: results.length ? Number((anomalies.length / results.length).toFixed(4)) : 0,
    anomalyReasons: Object.entries(anomalies.reduce((acc, r) => {
      const key = r.reason?.replace(/ seed.*$/, '').slice(0, 80) ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})),
    wins, winRates: wins.map(w => games ? Number((w / games).toFixed(4)) : 0),
    meanScores: scoreSum.map(s => games ? Number((s / games).toFixed(2)) : 0),
    meanGolems: golemSum.map(s => games ? Number((s / games).toFixed(2)) : 0),
    meanMoves: games ? Number((finished.reduce((s, r) => s + r.moves, 0) / games).toFixed(1)) : 0,
    meanWallMs: games ? Number((finished.reduce((s, r) => s + r.wallMs, 0) / games).toFixed(1)) : 0,
    totalDecisionMs: Number(results.reduce((s, r) => s + (r.metrics?.totalDecisionMs ?? 0), 0).toFixed(1)),
  };
}
