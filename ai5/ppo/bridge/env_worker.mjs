/** AI 5.0 对局宿主进程（Node 持久化子进程，任务书 4.1）。
 *
 * 职责：
 * - 使用正式引擎编译产物（web-v1/dist/js，与网页版同一份）执行全部游戏状态转移；
 * - 每个席位可配置策略：mlp（交由 Python 决策）/ champion / neutral / profile-N / random；
 * - MLP 席位在决策点暂停：发送公开观察编码 + 合法候选集合，等待 Python 回传行动序号；
 * - 非 MLP 席位在进程内直接调用正式 chooseAIAction（AI 4.0 冠军决策核心）；
 * - 全部行动最终由正式引擎 applyAction 验证，非法行动记为异常对局，绝不静默重试。
 *
 * 通信协议（stdin/stdout 逐行 JSON；向量字段为 {b64, len} f32LE base64）：
 * → {"type":"game", gameId, seed, seatCount, seats:[{kind,variant?}...]}
 * ← {"type":"decision", gameId, seat, turnNumber, phase, obs:{b64,len},
 *    candMat:{b64,len,rows}, candidates:[descriptor...], enum:{fullCount,keptCount,pruned,...}}
 * → {"type":"action", gameId, index}
 * ← {"type":"terminal", gameId, status, scores, ranks, winnerSeat, moves, wallMs,
 *    seatStats, enumAgg}
 * → {"type":"close"}
 *
 * 复现性：同 seed + 同席位配置 ⇒ 同一局逐位复现（引擎洗牌种子固定；random 策略
 * 由 seed+move 派生 rng；MLP 决策由 Python 侧保证确定性采样）。
 */

import { createGame, applyAction, score, ranking, count } from '../../../web-v1/dist/js/engine.js';
import { chooseAIAction, buildObservation, PROFILES, NEUTRAL_PROFILE, BASELINE_PARAMETERS, CHAMPION_PARAMETERS } from '../../../web-v1/dist/js/ai.js';
import { enumerateCandidates, descriptorToEngineAction } from './action_enum.mjs';
import { encodeDecision, packF32, ACTION_DIM } from './encode.mjs';

const MAX_MOVES_DEFAULT = 1200;
const MAX_CANDIDATES_DEFAULT = 512;

/** 席位人格映射：与 training/simulator/simulate.mjs 完全一致
 *（席位 0 中立代理，席位 1-4 依次四种人格），保证与既有训练环境逐席对齐。 */
function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function vecField(arr) {
  return { b64: packF32(arr), len: arr.length };
}

/** 非 MLP 席位决策（AI 4.0 冠军核心或确定性随机合法策略）。 */
function nodeSeatAction(game, seat, spec, moveIndex, rngSource) {
  if (spec.variant === 'random') {
    const view = buildObservation(game);
    const { candidates } = enumerateCandidates(view, { maxCandidates: Infinity });
    const rng = rngSource(seat, moveIndex);
    const pick = candidates[Math.floor(rng() * candidates.length)];
    return { action: descriptorToEngineAction(pick), reason: 'random-legal' };
  }
  const options = { profile: seatProfile(seat) };
  switch (spec.variant) {
    case 'champion': break; // 当前激活参数即冠军（struct-beam-rollout）
    case 'champion-params': options.parameters = CHAMPION_PARAMETERS; break;
    case 'neutral': options.parameters = BASELINE_PARAMETERS; break;
    default: {
      const m = /^profile-(\d)$/.exec(spec.variant ?? '');
      if (!m) throw new Error(`未知 node 席位变体：${spec.variant}`);
      options.parameters = { ...BASELINE_PARAMETERS, id: `ai5-ref-profile-${m[1]}` };
      options.profile = PROFILES[Number(m[1]) % PROFILES.length];
    }
  }
  return chooseAIAction(game, options);
}

/** 运行一局直到 MLP 决策点或终局。返回待发送消息；MLP 决策点挂起等待回传。 */
function runGame(state, rngSource) {
  const { config, agg } = state;
  let game = state.game;
  const started = state.started;
  let moves = state.moves;
  try {
    while (game.phase !== 'finished') {
      if (moves >= (config.maxMoves ?? MAX_MOVES_DEFAULT)) {
        return terminal(state, 'anomaly', `达到行动步数上限（疑似死循环）`, moves);
      }
      if (performance.now() - started > (config.deadlineMs ?? 60_000)) {
        return terminal(state, 'anomaly', '超出单局时间预算', moves);
      }
      const seat = game.current;
      const spec = config.seats[seat];
      if (spec.kind === 'mlp') {
        const view = buildObservation(game);
        const { candidates, stats } = enumerateCandidates(view, { maxCandidates: config.maxCandidates ?? MAX_CANDIDATES_DEFAULT });
        if (!candidates.length) {
          return terminal(state, 'anomaly', 'MLP 席位无合法候选（枚举为空）', moves);
        }
        if (!stats.pruned) agg.fullDecisions += 1; else agg.prunedDecisions += 1;
        agg.enumFullSum += stats.fullCount; agg.enumKeptSum += stats.keptCount;
        const { obs, candMat } = encodeDecision(view, candidates);
        state.moves = moves;
        state.pending = { candidates, seat };
        return {
          type: 'decision', gameId: config.gameId, seat,
          turnNumber: game.turnNumber, phase: game.phase,
          obs: vecField(obs),
          candMat: { b64: packF32(candMat), len: candMat.length, rows: candidates.length, cols: ACTION_DIM },
          candidates,
          enum: stats,
        };
      }
      const decisionStart = performance.now();
      const response = nodeSeatAction(game, seat, spec, moves, rngSource);
      const ms = performance.now() - decisionStart;
      state.seatStats[seat].decisionCount += 1;
      state.seatStats[seat].totalDecisionMs += ms;
      state.seatStats[seat].maxDecisionMs = Math.max(state.seatStats[seat].maxDecisionMs, ms);
      game = applyAction(game, response.action);
      state.game = game;
      moves += 1;
    }
    return terminal(state, 'finished', null, moves);
  } catch (error) {
    const stack = String(error.stack ?? '').split('\n').slice(0, 4).join(' | ');
    return terminal(state, 'anomaly', `对局异常：${error.message} @ ${stack}`, moves, game);
  }
}

function terminal(state, status, reason, moves, gameAtError) {
  const { game, config, seatStats, agg } = state;
  const finalGame = gameAtError ?? game;
  const scores = finalGame.players.map(p => score(p));
  const ranked = status === 'finished' ? ranking(finalGame) : null;
  return {
    type: 'terminal', gameId: config.gameId, status, reason,
    scores, ranks: ranked ? ranked.map(p => p.id) : null,
    winnerSeat: ranked ? ranked[0].id : null,
    moves, wallMs: Number((performance.now() - state.started).toFixed(1)),
    seatStats: seatStats.map(s => ({
      decisionCount: s.decisionCount,
      meanDecisionMs: s.decisionCount ? Number((s.totalDecisionMs / s.decisionCount).toFixed(3)) : null,
      maxDecisionMs: Number(s.maxDecisionMs.toFixed(3)),
    })),
    enumAgg: {
      fullDecisions: agg.fullDecisions, prunedDecisions: agg.prunedDecisions,
      meanFull: agg.fullDecisions + agg.prunedDecisions ? Number((agg.enumFullSum / (agg.fullDecisions + agg.prunedDecisions)).toFixed(1)) : 0,
      meanKept: agg.fullDecisions + agg.prunedDecisions ? Number((agg.enumKeptSum / (agg.fullDecisions + agg.prunedDecisions)).toFixed(1)) : 0,
    },
    partial: status !== 'finished' ? finalGame.players.map(p => ({ claimed: p.claimed.length, crystals: count(p.stock) })) : undefined,
  };
}

/** 处理一条命令；返回要回传的消息（可能为 null）。 */
function handleMessage(state, msg, rngSource) {
  switch (msg.type) {
    case 'game': {
      const seatCount = msg.seatCount ?? msg.seats.length;
      const game = createGame(
        Array.from({ length: seatCount }, (_, i) => `席位${i}`),
        msg.seed,
        Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
      );
      game.players[0].isAI = true; // 训练环境：人类席位由 AI 代理（与正式模拟器一致）
      state.game = game;
      state.config = { ...msg, seatCount };
      state.moves = 0;
      state.pending = null;
      state.started = performance.now();
      state.seatStats = Array.from({ length: seatCount }, () => ({ decisionCount: 0, totalDecisionMs: 0, maxDecisionMs: 0 }));
      state.agg = { fullDecisions: 0, prunedDecisions: 0, enumFullSum: 0, enumKeptSum: 0 };
      return runGame(state, rngSource);
    }
    case 'action': {
      if (!state.pending) throw new Error('收到 action 但无挂起决策');
      const index = msg.index;
      const { candidates, seat } = state.pending;
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        // Python 回传非法序号：如实记为异常对局（不静默修正）。
        state.pending = null;
        return terminal({ ...state, game: state.game }, 'anomaly', `回传行动序号越界：${index} / ${candidates.length}`, state.moves);
      }
      const action = descriptorToEngineAction(candidates[index]);
      state.seatStats[seat].decisionCount += 1;
      try {
        state.game = applyAction(state.game, action);
      } catch (error) {
        state.pending = null;
        return terminal(state, 'anomaly', `MLP 行动被引擎拒绝：${error.message}（${JSON.stringify(action)}）`, state.moves);
      }
      state.pending = null;
      state.moves += 1;
      return runGame(state, rngSource);
    }
    case 'close':
      return null;
    default:
      throw new Error(`未知命令：${msg.type}`);
  }
}

function main() {
  const state = { game: null, config: null, pending: null, moves: 0 };
  const runSeedBase = Number(process.env.AI5_WORKER_SEED ?? 0);
  const rngSource = (seat, move) => mulberry32((runSeedBase ^ (seat * 0x9e3779b9) ^ (move * 0x85ebca6b)) >>> 0);
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (error) {
        send({ type: 'fatal', reason: `命令解析失败：${error.message}` });
        continue;
      }
      try {
        const reply = handleMessage(state, msg, rngSource);
        if (reply) send(reply);
        if (msg.type === 'close') process.exit(0);
      } catch (error) {
        send({ type: 'fatal', reason: `命令处理失败：${error.message}`, command: msg.type });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
