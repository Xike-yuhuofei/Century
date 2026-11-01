/**
 * AI12 保真度蒸馏数据采集（开发池；本地离线）。
 *
 * 目的：rollout 内己方策略当前是 1-ply 贪心（与冠军计划首步仅 56.5% 一致）。
 * 本采集在真实对局轨迹上记录「公开状态 + 全部合法行动」的廉价特征与
 * 「冠军 choosePlan 首步」标签，用于离线训练快速再排序策略。
 *
 * 标签采集不读取任何隐藏信息：choosePlan 只消费 buildObservation 的公开观察。
 * 种子窗口与既有 AI7/AI12 研究窗口、正式验证池 [900M,1.06e9) 互不相交。
 *
 * 用法：
 *   node .../collect-plan-data.mjs --shard 0 --shards 4 --games 60 --seed-base 1739000000
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createGame, applyAction } from '../../../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { choosePlan } from '../../../../web-v1/dist/js/ai/planner.js';
import { buildObservation } from '../../../../web-v1/dist/js/ai/observation.js';
import { createSimulation } from '../../../../web-v1/dist/js/sim/session.js';
import { enumerateLegalActions } from '../../../../web-v1/dist/js/sim/legal.js';
import { chooseJointAction } from '../../../../web-v1/dist/js/js/adapter.js';
import { heuristicContext, myRankedActions, actionValue } from '../../../../web-v1/dist/js/js/rollout-policy.js';
import { golemSurvivalModel } from '../../../../web-v1/dist/js/ai/opponent-model.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../../../../web-v1/dist/js/data.js';
import { buildRegistry } from '../../../adversarial/registry.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../../../lib/sim-stream.mjs';

const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const registry = buildRegistry();
const CH = registry.versions['js5-frozen-champion'].parameters;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const shard = Number(arg('shard', 0));
const shards = Number(arg('shards', 4));
const games = Number(arg('games', 60));
const seedBase = Number(arg('seed-base', 1739000000));
const WU = Number(arg('wu', 32));
const TOP = Number(arg('top', 12));
const out = arg('out', `/tmp/ai12-plan-shard-${shard}.jsonl`);

const seatProfile = (seat) => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);
const key = a => JSON.stringify(a);

export const FEATURE_NAMES = [
  // 状态（公开）
  'turn50', 'trigger', 'seats', 'myScore20', 'oppBestScore20', 'scoreDiff10',
  'myClaimed6', 'oppBestClaimed6', 'remainingClaims6', 'hand10', 'played10',
  'stockTotal10', 'myCoins10', 'copperPool10', 'silverPool10', 'marketGolems6',
  'bestGoalPoints20', 'goalCoverageDiff', 'gapPreferred10',
  // 行动族
  'isPlay', 'isAcquire', 'isClaim', 'isRest',
  'value10', 'rank5',
  // 认领
  'claimPoints20', 'claimCoverage', 'claimSurvival', 'claimNetDelta10', 'claimCopperSlot',
  // 获取
  'acqIndex3', 'acqBonusSum5', 'acqOutputSum5', 'acqKindCreate', 'acqKindUpgrade', 'acqKindTrade',
  // 打出
  'playOutputSum5', 'playInputSum5', 'playKindCreate', 'playKindUpgrade', 'playKindTrade',
  'playSteps2', 'playHandAfter0',
  // 休息
  'restPlayed10', 'restHandEmpty', 'restHand10',
  // 交互
  'value_isPlay', 'value_isAcquire', 'value_isClaim', 'value_isRest',
  'value_remainingClaims', 'value_trigger', 'isClaim_remainingClaims', 'claimPoints_remainingClaims',
];

function ctxFeatures(state, seat, preferred, search) {
  const players = state.players;
  const n = players.length;
  const threshold = n >= 4 ? 5 : 6;
  const scoreOf = p => p.claimed.reduce((s, id) => s + (GOLEM_BY_ID[id]?.points ?? 0), 0)
    + p.copper * 3 + p.silver + p.stock[1] + p.stock[2] + p.stock[3];
  const scores = players.map(scoreOf);
  const claimed = players.map(p => p.claimed.length);
  let bestScore = -Infinity, bestClaimed = 0;
  for (const p of players) {
    if (p.id === seat) continue;
    bestScore = Math.max(bestScore, scores[p.id]);
    bestClaimed = Math.max(bestClaimed, claimed[p.id]);
  }
  const me = players[seat];
  const mine = scores[seat];
  let bestGoalPoints = 0, myCov = 0, rivalCov = 0;
  for (const id of state.golemMarket) {
    const goal = GOLEM_BY_ID[id];
    if (!goal || goal.points <= bestGoalPoints) continue;
    bestGoalPoints = goal.points;
    const total = goal.cost.reduce((s, x) => s + x, 0);
    myCov = total ? goal.cost.reduce((s, x, c) => s + Math.min(x, me.stock[c]), 0) / total : 0;
    rivalCov = Math.max(...players.filter(p => p.id !== seat).map(p => (total
      ? goal.cost.reduce((s, x, c) => s + Math.min(x, p.stock[c]), 0) / total : 0)));
  }
  const goal = preferred ? GOLEM_BY_ID[preferred] : null;
  const gap = goal ? goal.cost.reduce((s, x, c) => s + Math.max(0, x - me.stock[c]), 0) : 0;
  return [
    state.turnNumber / 50, state.triggerPlayer !== null ? 1 : 0, n,
    mine / 20, bestScore / 20, (mine - bestScore) / 10,
    claimed[seat] / 6, bestClaimed / 6, (threshold - claimed[seat]) / 6,
    me.hand.length / 10, me.played.length / 10,
    (me.stock[0] + me.stock[1] + me.stock[2] + me.stock[3]) / 10,
    (me.copper * 3 + me.silver) / 10, state.copper / 10, state.silver / 10,
    state.golemMarket.length / 6, bestGoalPoints / 20, myCov - rivalCov, gap / 10,
  ];
}

/** 单行动特征。ctx = ctxFeatures 前缀；价值来自冠军同源 actionValue。 */
function actionFeatures(state, seat, action, search, preferred, ctx, value, rank, survival) {
  const players = state.players;
  const n = players.length;
  const threshold = n >= 4 ? 5 : 6;
  const remaining = threshold - players[seat].claimed.length;
  const isPlay = action.type === 'play' ? 1 : 0;
  const isAcquire = action.type === 'acquire' ? 1 : 0;
  const isClaim = action.type === 'claim' ? 1 : 0;
  const isRest = action.type === 'rest' ? 1 : 0;
  const out = [
    ...ctx,
    isPlay, isAcquire, isClaim, isRest,
    Number.isFinite(value) ? value / 10 : -5, rank < 0 ? -1 : Math.min(rank, 9) / 5,
  ];
  // 认领
  let claimPoints = 0, claimCoverage = 0, claimSurvival = 0, claimNet = 0, claimCopper = 0;
  if (isClaim) {
    const id = state.golemMarket[action.index];
    const goal = id ? GOLEM_BY_ID[id] : null;
    if (goal) {
      claimPoints = goal.points / 20;
      const total = goal.cost.reduce((s, x) => s + x, 0);
      claimCoverage = total ? goal.cost.reduce((s, x, c) => s + Math.min(x, players[seat].stock[c]), 0) / total : 1;
      claimNet = (goal.points + (action.index === 0 ? (players[seat].copper ? 3 : players[seat].silver ? 1 : 0) : 0)) / 10;
      claimSurvival = survival[id] ?? 1;
      claimCopper = action.index === 0 ? 1 : 0;
    }
  }
  out.push(claimPoints, claimCoverage, claimSurvival, claimNet, claimCopper);
  // 获取
  let acqIndex = 0, acqBonus = 0, acqOutput = 0, acqCreate = 0, acqUpgrade = 0, acqTrade = 0;
  if (isAcquire) {
    const offer = state.merchantMarket[action.index];
    const card = offer ? MERCHANT_BY_ID[offer.id] : null;
    acqIndex = action.index / 3;
    acqBonus = offer ? (offer.bonus[0] + offer.bonus[1] + offer.bonus[2] + offer.bonus[3]) / 5 : 0;
    acqOutput = card?.output ? card.output.reduce((s, x) => s + x, 0) / 5 : 0;
    acqCreate = card?.kind === 'create' ? 1 : 0;
    acqUpgrade = card?.kind === 'upgrade' ? 1 : 0;
    acqTrade = card?.kind === 'trade' ? 1 : 0;
  }
  out.push(acqIndex, acqBonus, acqOutput, acqCreate, acqUpgrade, acqTrade);
  // 打出
  let playOutput = 0, playInput = 0, playCreate = 0, playUpgrade = 0, playTrade = 0, playSteps = 0, handAfter0 = 0;
  if (isPlay) {
    const card = MERCHANT_BY_ID[action.cardId];
    playOutput = card?.output ? card.output.reduce((s, x) => s + x, 0) / 5 : 0;
    playInput = card?.input ? card.input.reduce((s, x) => s + x, 0) / 5 : 0;
    playCreate = card?.kind === 'create' ? 1 : 0;
    playUpgrade = card?.kind === 'upgrade' ? 1 : 0;
    playTrade = card?.kind === 'trade' ? 1 : 0;
    playSteps = (action.steps?.length ?? 0) / 2;
    handAfter0 = players[seat].hand.length === 1 ? 1 : 0;
  }
  out.push(playOutput, playInput, playCreate, playUpgrade, playTrade, playSteps, handAfter0);
  // 休息
  const restPlayed = isRest ? players[seat].played.length / 10 : 0;
  const restHandEmpty = isRest && players[seat].hand.length === 0 ? 1 : 0;
  const restHand = isRest ? players[seat].hand.length / 10 : 0;
  out.push(restPlayed, restHandEmpty, restHand);
  // 交互
  const v = Number.isFinite(value) ? value / 10 : 0;
  out.push(
    v * isPlay, v * isAcquire, v * isClaim, v * isRest,
    v * remaining / 6, v * (state.triggerPlayer !== null ? 1 : 0),
    isClaim * remaining / 6, claimPoints * remaining / 6,
  );
  return out;
}

const lines = [];
const stats = { games: 0, decisions: 0, rows: 0, labelMissing: 0, labelAgreesGreedy: 0 };
for (let g = 0; g < games; g++) {
  const seatCount = 2 + (g % 4);
  const seed = seedBase + seatCount * 1000 + g;
  const focusSeat = (g + shard) % seatCount;
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  while (game.phase !== 'finished') {
    const seat = game.current;
    let action;
    if (seat === focusSeat && game.phase === 'turn') {
      const obs = buildObservation(game, seat);
      const profile = seatProfile(seat);
      const plan = choosePlan(obs, CH, profile, 'beam-rollout');
      const sim = createSimulation(obs, { simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT) });
      const ctxH = heuristicContext(sim.view, CH, profile);
      const { search, preferred, ranked } = myRankedActions(sim.view, seat, ctxH);
      const legal = enumerateLegalActions(sim.view, { dedupe: true });
      const rankOf = new Map(ranked.map((x, i) => [key(x.action), i]));
      const survival = golemSurvivalModel(obs, 6);
      const ctx = ctxFeatures(sim.view, seat, preferred, search);
      const scored = legal.map(a => {
        const v = actionValue(search, a, preferred, ctxH);
        return {
          action: a,
          value: v,
          row: actionFeatures(
            sim.view, seat, a, search, preferred, ctx,
            v, rankOf.has(key(a)) ? rankOf.get(key(a)) : -1, survival,
          ),
        };
      });
      const label = plan?.first ? scored.findIndex(x => key(x.action) === key(plan.first)) : -1;
      // 候选子集：按贪心价值降序前 TOP ∪ 标签行动（推理侧同口径，标签缺失率即性能上限）。
      const kept = scored
        .slice()
        .sort((x, y) => (Number.isFinite(y.value) ? y.value : -Infinity) - (Number.isFinite(x.value) ? x.value : -Infinity)
          || key(x.action).localeCompare(key(y.action)))
        .slice(0, TOP);
      if (label >= 0) {
        const labelAction = scored[label].action;
        if (!kept.some(x => key(x.action) === key(labelAction))) kept.push(scored[label]);
      }
      const keptRows = kept.map(x => x.row);
      const newLabel = label >= 0 ? kept.findIndex(x => key(x.action) === key(scored[label].action)) : -1;
      stats.decisions++;
      if (newLabel < 0) stats.labelMissing++;
      const labelRank = label >= 0 ? (rankOf.has(key(scored[label].action)) ? rankOf.get(key(scored[label].action)) : 99) : -1;
      if (labelRank === 0) stats.labelAgreesGreedy++;
      lines.push(JSON.stringify({ seed, seats: seatCount, turn: game.turnNumber, label: newLabel, labelRank, rows: keptRows }));
      stats.rows += keptRows.length;
      const js5 = chooseJointAction(game, {
        version: 'joint-js5', workUnits: WU, championParameters: CH, profile,
        simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
      });
      action = js5.action;
    } else if (seat === focusSeat) {
      action = chooseJointAction(game, {
        version: 'joint-js5', workUnits: WU, championParameters: CH, profile: seatProfile(seat),
        simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
      }).action;
    } else {
      action = chooseAIAction(game, { parameters: registry.versions[OPPONENT_IDS[(g + seat) % OPPONENT_IDS.length]].parameters, profile: seatProfile(seat) }).action;
    }
    game = applyAction(game, action);
  }
  stats.games++;
}
mkdirSync('/tmp', { recursive: true });
writeFileSync(out, lines.join('\n') + '\n');
console.log(JSON.stringify({ shard, shards, seedBase, featureNames: FEATURE_NAMES.length, ...stats, labelGreedyAgreement: +(stats.labelAgreesGreedy / Math.max(1, stats.decisions)).toFixed(4), out }));
