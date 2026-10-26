/** 异步 LLM 对局运行器（Node-only）。
 *
 * - 使用正式引擎执行每一步（web-v1/dist/js/engine.js），不复制规则；
 * - 焦点席位在 llm 组由 LLM 决策，在 champion 组由冻结冠军决策；
 * - 其余席位使用同一冻结对手版本与席位人格；
 * - 每个 LLM 决策即时写入哈希链 JSONL，每回合写 turn 记录；
 * - 支持从已完成回合恢复，异常局保留真实原因，绝不伪装完成。
 */

import {
  applyAction, createGame, ranking, score, count,
} from '../../web-v1/dist/js/engine.js';
import { buildObservation, chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { createLLMPlayer, summarizeAction, observationHash } from '../../web-v1/dist/js/ai/llm/index.js';
import { GAME_SCHEMA } from './store.mjs';

export const DEFAULT_MAX_MOVES = 1200;
export const DEFAULT_MAX_WALL_MS = 3 * 60 * 60 * 1000;

export function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

function configureGame(seed, seatCount) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`seed 必须是非负安全整数：${seed}`);
  if (![2, 3, 4, 5].includes(seatCount)) throw new Error(`seatCount 必须为 2–5：${seatCount}`);
  const names = Array.from({ length: seatCount }, (_, i) => `席位${i}`);
  const aiSeats = Array.from({ length: seatCount - 1 }, (_, i) => i + 1);
  const game = createGame(names, seed, aiSeats);
  // 训练/实验专用：引擎要求至少一名人类，实验将第 0 席代理为 AI。
  game.players[0].isAI = true;
  return game;
}

function versionFor(versions, seat) {
  return versions?.[seat] ?? null;
}

function offlineDecision(game, versions) {
  const seat = game.current;
  const version = versionFor(versions, seat);
  return chooseAIAction(game, {
    ...(version?.parameters ? { parameters: version.parameters } : {}),
    ...(version?.structure ? { structure: version.structure } : {}),
    profile: seatProfile(seat),
  });
}

function rankingRows(game) {
  return ranking(game).map(player => ({
    seat: player.id,
    score: score(player),
    golems: player.claimed.length,
    copper: player.copper,
    silver: player.silver,
    crystals: count(player.stock),
    turns: player.turns,
    claimed: [...player.claimed],
  }));
}

/** 从 replay 的起点逐动作重放，校验终局与引擎记录一致。 */
export function verifyReplay(game) {
  if (!game.replay) return { ok: false, reason: '缺少 replay', checkedActions: 0 };
  try {
    let replayGame = JSON.parse(JSON.stringify(game.replay.initial));
    let actions = 0;
    for (const turn of game.replay.turns) {
      for (const action of turn.actions) {
        replayGame = applyAction(replayGame, action);
        actions++;
      }
    }
    const actual = ranking(game).map(p => [p.id, score(p), [...p.claimed], [...p.stock], p.copper, p.silver, p.turns]);
    const replayed = ranking(replayGame).map(p => [p.id, score(p), [...p.claimed], [...p.stock], p.copper, p.silver, p.turns]);
    const same = replayGame.phase === game.phase && JSON.stringify(actual) === JSON.stringify(replayed);
    return {
      ok: same,
      reason: same ? null : '重放终局与实时终局不一致',
      checkedActions: actions,
      finalPhase: replayGame.phase,
      livePhase: game.phase,
    };
  } catch (error) {
    return { ok: false, reason: `重放异常：${error.message}`, checkedActions: null };
  }
}

/**
 * 运行或恢复一局。
 *
 * @param {object} options
 * @param {import('./store.mjs').RunStore} options.store
 * @param {string} options.gameId 安全字符 id（目录名与记录一致）
 * @param {number} options.seed
 * @param {number} options.seatCount
 * @param {number} options.focusSeat
 * @param {'llm'|'champion'} options.arm
 * @param {object} options.llmProvider Codex/Mock Provider（champion 组可省略）
 * @param {object} [options.llmConfig]
 * @param {Array<object|null>} options.versions 每席位冻结版本（含 parameters）
 * @param {object|null} [options.championParameters] 焦点冠军参数（影子/回退）
 * @param {string} options.experimentId
 * @param {string} options.pairId
 * @param {number} [options.maxMoves]
 * @param {number} [options.maxWallMs]
 * @param {boolean} [options.retryAnomaly]
 */
export async function runGame(options) {
  const {
    store, gameId, seed, seatCount, focusSeat, arm, llmProvider, llmConfig,
    versions, championParameters = null, experimentId, pairId,
    maxMoves = DEFAULT_MAX_MOVES, maxWallMs = DEFAULT_MAX_WALL_MS,
    channel = 'experiment', retryAnomaly = false,
  } = options;
  if (!['llm', 'champion'].includes(arm)) throw new Error(`未知 arm：${arm}`);
  if (!Number.isInteger(focusSeat) || focusSeat < 0 || focusSeat >= seatCount) {
    throw new Error(`focusSeat 非法：${focusSeat}`);
  }
  const meta = {
    schema: GAME_SCHEMA,
    mode: seatCount, seatCount, seed, focusSeat, arm, pairId, experimentId, channel,
    rulesVersion: 'engine-v2',
    aiSeats: Array.from({ length: seatCount }, (_, i) => i),
    opponentVersionIds: versions.map(v => v?.id ?? null),
  };
  store.ensureGame(gameId, meta);
  const existing = store.readResult(gameId);
  if (existing?.status === 'finished') return existing;
  if (existing && existing.status !== 'finished' && !retryAnomaly) return existing;

  const started = Date.now();
  let resumedTurns = 0;
  let game = configureGame(seed, seatCount);
  for (let seat = 0; seat < seatCount; seat++) {
    game.players[seat].aiKind = arm === 'llm' && seat === focusSeat ? 'llm' : 'offline';
  }

  // —— 恢复：重放已落盘回合 ——
  const existingTurns = store.loadEnvelopes(gameId, 'turn');
  const existingDecisions = store.loadEnvelopes(gameId, 'decision');
  let resumeError = null;
  if (existingTurns.length > 0) {
    try {
      for (const envelope of existingTurns) {
        const t = envelope.record;
        if (!t || t.applied === false) throw new Error(`第 ${envelope.seq} 回合未成功应用`);
        if (game.turnNumber !== t.turnNumber || game.current !== t.seat) {
          throw new Error(`恢复状态不符：期望第${t.turnNumber}手座位${t.seat}，实际第${game.turnNumber}手座位${game.current}`);
        }
        game = applyAction(game, t.action);
        resumedTurns++;
      }
    } catch (error) {
      resumeError = error.message;
      // 保留原始文件，改名后从干净状态重开，避免把损坏/半回合当成正常恢复。
      store.archivePartial(gameId, 'resume-invalid');
      existingTurns.length = 0;
      existingDecisions.length = 0;
      resumedTurns = 0;
      game = configureGame(seed, seatCount);
      for (let seat = 0; seat < seatCount; seat++) {
        game.players[seat].aiKind = arm === 'llm' && seat === focusSeat ? 'llm' : 'offline';
      }
    }
  }

  // —— LLM 玩家（含恢复预算/历史） ——
  let llmPlayer = null;
  const decisionIds = [];
  if (arm === 'llm') {
    if (!llmProvider) throw new Error('LLM 组缺少 Provider');
    llmPlayer = createLLMPlayer({
      provider: llmProvider,
      config: { ...llmConfig, shadowChampion: llmConfig?.shadowChampion ?? true },
      ...(championParameters ? { championParameters } : {}),
      record: record => {
        store.appendDecision(gameId, record, { gameMeta: meta });
        decisionIds.push(record.decisionId);
      },
    });
    if (existingDecisions.length > 0) {
      const appliedIds = new Set(existingTurns.map(t => t.record?.decisionId).filter(Boolean));
      const appliedDecisions = existingDecisions.filter(d => appliedIds.has(d.record?.decisionId));
      const calls = appliedDecisions.reduce((sum, d) => sum + (d.record?.attempts?.length ?? 0), 0);
      const tokens = appliedDecisions.reduce((sum, d) => sum + (d.record?.usage?.totalTokens ?? 0), 0);
      llmPlayer.restoreUsage({
        calls, tokens,
        decisions: appliedDecisions.filter(d => d.record?.source === 'llm').length,
        fallbacks: appliedDecisions.filter(d => d.record?.source === 'fallback').length,
      });
      const history = appliedDecisions
        .filter(d => d.record?.seat === focusSeat)
        .map(d => ({
          turnNumber: d.record.turnNumber,
          actionSummary: summarizeAction(d.record.observation, d.record.executedAction),
          primaryGoal: d.record.parsed?.primaryGoal ?? '离线冠军回退',
          reason: d.record.parsed?.reason ?? d.record.fallbackReason ?? '',
        }));
      llmPlayer.seedHistory(focusSeat, history);
    }
  }

  const startTurn = game.turnNumber;
  let moves = 0;
  let anomalyReason = resumeError ? `恢复失败后重开：${resumeError}` : null;
  let status = 'finished';
  const turnDecisionIds = [];

  try {
    while (game.phase !== 'finished') {
      if (moves >= maxMoves) throw new Error(`达到行动步数上限 ${maxMoves}（疑似死循环）`);
      if (Date.now() - started > maxWallMs) throw new Error(`超出单局墙钟预算 ${maxWallMs}ms`);
      const seat = game.current;
      const beforeView = buildObservation(game, seat);
      const beforeHash = observationHash(beforeView);
      const turnNumber = game.turnNumber;
      let action;
      let reason;
      let decisionId = null;
      let source = 'offline';
      let llmFallbackCause = null;
      if (arm === 'llm' && seat === focusSeat) {
        const decision = await llmPlayer.decide(game, {
          gameId, seed, seatCount, focusSeat, experimentId, channel,
        });
        action = decision.action;
        reason = decision.reason;
        decisionId = decision.record.decisionId;
        source = decision.source;
        llmFallbackCause = decision.record.fallbackCause;
        turnDecisionIds.push(decisionId);
      } else {
        const decision = offlineDecision(game, versions);
        action = decision.action;
        reason = decision.reason;
      }
      let nextGame;
      try {
        nextGame = applyAction(game, action);
      } catch (error) {
        store.appendTurn(gameId, {
          schema: 'century-llm-turn-record-v1',
          gameId, turnNumber, round: Math.floor((turnNumber - 1) / seatCount) + 1,
          seat, focusSeat, phase: game.phase, action, source, decisionId,
          offlineVersionId: versionFor(versions, seat)?.id ?? null,
          llmFallbackCause, reason: String(reason).slice(0, 600),
          beforeHash, afterHash: null, applied: false,
          error: error.message,
        }, { gameMeta: meta });
        throw new Error(`正式引擎拒绝行动：${error.message}`);
      }
      const afterView = buildObservation(nextGame, seat);
      const afterHash = observationHash(afterView);
      store.appendTurn(gameId, {
        schema: 'century-llm-turn-record-v1',
        gameId, turnNumber, round: Math.floor((turnNumber - 1) / seatCount) + 1,
        seat, focusSeat, phase: game.phase, action, source, decisionId,
        offlineVersionId: versionFor(versions, seat)?.id ?? null,
        llmFallbackCause, reason: String(reason ?? '').slice(0, 600),
        beforeHash, afterHash, applied: true,
        beforeScore: score(game.players[seat]), afterScore: score(nextGame.players[seat]),
        beforeScores: game.players.map(p => score(p)), afterScores: nextGame.players.map(p => score(p)),
        triggersEnd: game.triggerPlayer === null && nextGame.triggerPlayer !== null,
        completed: nextGame.phase !== 'overflow',
      }, { gameMeta: meta });
      game = nextGame;
      moves += 1;
    }
  } catch (error) {
    status = 'anomaly';
    anomalyReason = error instanceof Error ? error.message : String(error);
  }

  // 正常终局校验：各席位回合数一致（终局整轮结算）。
  if (status === 'finished') {
    const turnCounts = new Set(game.players.map(p => p.turns));
    if (turnCounts.size !== 1) {
      status = 'anomaly';
      anomalyReason = '终局各席位回合数不一致，违反终局结算规则';
    }
  }

  const ranked = ranking(game);
  const focusPlayer = game.players[focusSeat];
  const focusRank = ranked.findIndex(p => p.id === focusSeat) + 1;
  const focusFirst = status === 'finished' ? ranked[0]?.id === focusSeat : null;
  const replayConsistency = verifyReplay(game);
  const finalDecisions = store.loadEnvelopes(gameId, 'decision')
    .filter(d => d.record?.gameId === gameId)
    .map(d => d.record);
  const fallbackCount = finalDecisions.filter(d => d.source === 'fallback').length;
  const llmCount = finalDecisions.filter(d => d.source === 'llm').length;
  const usage = finalDecisions.reduce((sum, d) => ({
    promptTokens: sum.promptTokens + (d.usage?.promptTokens ?? 0),
    completionTokens: sum.completionTokens + (d.usage?.completionTokens ?? 0),
    totalTokens: sum.totalTokens + (d.usage?.totalTokens ?? 0),
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });

  const result = {
    schema: GAME_SCHEMA,
    gameId, experimentId, pairId, arm, seed, seatCount, focusSeat,
    status,
    anomaly: status !== 'finished',
    anomalyReason,
    resumedFromTurns: resumedTurns,
    startTurn,
    moves,
    wallMs: Date.now() - started,
    winnerSeat: status === 'finished' ? ranked[0]?.id ?? null : null,
    focusFirst,
    focusRank: status === 'finished' ? focusRank : null,
    focusScore: score(focusPlayer),
    focusGolems: focusPlayer.claimed.length,
    ranking: rankingRows(game),
    decisionIds: [...new Set(finalDecisions.map(d => d.decisionId))],
    llmDecisionCount: llmCount,
    fallbackCount,
    fallbackRate: finalDecisions.length ? fallbackCount / finalDecisions.length : null,
    llmUsage: usage,
    provider: arm === 'llm' ? llmProvider.info() : null,
    rulesVersion: 'engine-v2',
    opponentVersionIds: versions.map(v => v?.id ?? null),
    replay: game.replay ?? null,
    replayConsistency,
    completedAt: new Date().toISOString(),
    gameMeta: meta,
  };
  store.writeResult(gameId, result);
  return result;
}
