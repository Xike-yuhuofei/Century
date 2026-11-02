/**
 * AI13 保真度蒸馏数据采集（纠正协议；开发池；本地离线）。
 *
 * 相对 AI12 `collect-plan-data.mjs` 的纠正（见 training/reports/ai13/AI12-DISTILLATION-AUDIT.md）：
 * 1. 种子唯一：seed = seedBase + shard*shardStride + seatCount*countStride + g，
 *    分片不再复用同一世界；每个世界只产生一条焦点席位轨迹（统计单位 = 世界）。
 * 2. 分层：每个 split 内 2–5 人各自独立生成，人数由显式循环决定而非 g%4。
 * 3. 三窗口：train/dev/test 由调用方传入不同 seed-base（AI13 块 1.800e9/1.8003e9/1.8004e9）。
 * 4. 特征：原 54 维 legacy 特征逐名保留（用于与 AI12 结论直接对照）+ 新增公开
 *    结构化特征（逐对手、魔像成本/覆盖/存活、手牌/已打出的引擎结构、市场槽位）。
 * 5. 标签：同时记录冠军 choosePlan 首步（labelPlan）与 JS5 实际行动（labelJs5），
 *    用于区分“复现规划器”与“复现真实策略”两个不同任务。
 *
 * 信息边界：只使用 AIObservation / PublicSimState（公开可推导）；不读取隐藏牌库。
 *
 * 用法（单个分片）：
 *   node .../collect-plan-data-v2.mjs --split train --shard 0 --shards 4 \
 *     --games-per-count 30 --seed-base 1800000000 --wu 32 --out /tmp/ai13-train-0.jsonl
 */
import { writeFileSync } from 'node:fs';
import { createGame, applyAction } from '../../../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { choosePlan } from '../../../../web-v1/dist/js/ai/planner.js';
import { buildObservation } from '../../../../web-v1/dist/js/ai/observation.js';
import { createSimulation } from '../../../../web-v1/dist/js/sim/session.js';
import { enumerateLegalActions } from '../../../../web-v1/dist/js/sim/legal.js';
import { chooseJointAction } from '../../../../web-v1/dist/js/js/adapter.js';
import { heuristicContext, myRankedActions, actionValue } from '../../../../web-v1/dist/js/js/rollout-policy.js';
import { golemSurvivalModel } from '../../../../web-v1/dist/js/ai/opponent-model.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID, MERCHANT_DECK } from '../../../../web-v1/dist/js/data.js';
import { mulberry32 } from '../../../../web-v1/dist/js/sim/rng.js';
import { buildRegistry } from '../../../adversarial/registry.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../../../lib/sim-stream.mjs';

const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const registry = buildRegistry();
const CH = registry.versions['js5-frozen-champion'].parameters;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const split = String(arg('split', 'train'));
const shard = Number(arg('shard', 0));
const shards = Number(arg('shards', 1));
const gamesPerCount = Number(arg('games-per-count', 30));
const seedBase = Number(arg('seed-base', 1800000000));
const WU = Number(arg('wu', 32));
const TOP = Number(arg('top', 12));
// AI13e：policy 模式在 top-K 外再抽 sampleNegatives 个合法行动（确定性 RNG），
// 用于全合法行动策略的可行性训练；缺省 top12 = 原纠正协议，行为不变。
const sampleMode = String(arg('sample-mode', 'top12'));
const sampleNegatives = Math.max(0, Number(arg('sample-negatives', 0)));
const SHARD_STRIDE = Number(arg('shard-stride', 40000));
const COUNT_STRIDE = Number(arg('count-stride', 8000));
const out = arg('out', `/tmp/ai13-plan-${split}-${shard}.jsonl`);
const SEATS = [2, 3, 4, 5];
const CARD_IDS = [...MERCHANT_DECK.map(c => c.id), 'S01', 'S02'];

const seatProfile = (seat) => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);
const key = a => JSON.stringify(a);

/** 原 54 维特征名（AI12 `FEATURE_NAMES`，顺序逐项不变）。 */
export const LEGACY_FEATURE_NAMES = [
  'turn50', 'trigger', 'seats', 'myScore20', 'oppBestScore20', 'scoreDiff10',
  'myClaimed6', 'oppBestClaimed6', 'remainingClaims6', 'hand10', 'played10',
  'stockTotal10', 'myCoins10', 'copperPool10', 'silverPool10', 'marketGolems6',
  'bestGoalPoints20', 'goalCoverageDiff', 'gapPreferred10',
  'isPlay', 'isAcquire', 'isClaim', 'isRest',
  'value10', 'rank5',
  'claimPoints20', 'claimCoverage', 'claimSurvival', 'claimNetDelta10', 'claimCopperSlot',
  'acqIndex3', 'acqBonusSum5', 'acqOutputSum5', 'acqKindCreate', 'acqKindUpgrade', 'acqKindTrade',
  'playOutputSum5', 'playInputSum5', 'playKindCreate', 'playKindUpgrade', 'playKindTrade',
  'playSteps2', 'playHandAfter0',
  'restPlayed10', 'restHandEmpty', 'restHand10',
  'value_isPlay', 'value_isAcquire', 'value_isClaim', 'value_isRest',
  'value_remainingClaims', 'value_trigger', 'isClaim_remainingClaims', 'claimPoints_remainingClaims',
];

/** 新增结构化特征名（全部来自公开状态；顺序固定）。 */
export const RICH_FEATURE_NAMES = [
  // 上下文扩展
  'ctx_rank', 'ctx_gapLeader10', 'ctx_myTurns50', 'ctx_stockY5', 'ctx_stockG5', 'ctx_stockB5', 'ctx_stockP5',
  'ctx_copper3', 'ctx_silver2', 'ctx_claimableCount5', 'ctx_bestClaimPoints20',
  'ctx_myBestCoverage', 'ctx_rivalBestCoverage', 'ctx_coverageDiff',
  'ctx_unseenMerchants43', 'ctx_unseenGolems36', 'ctx_seatPos',
  // 逐对手（按座位序，含顺序距离；最多 4 名）
  ...Array.from({ length: 4 }, (_, i) => [
    `opp${i}_present`, `opp${i}_score20`, `opp${i}_claimed6`, `opp${i}_stockTotal10`,
    `opp${i}_hand10`, `opp${i}_played10`, `opp${i}_maxClaimPoints20`, `opp${i}_orderDist5`,
  ]).flat(),
  // 魔像市场（6 槽）
  ...Array.from({ length: 6 }, (_, i) => [
    `goal${i}_present`, `goal${i}_points20`, `goal${i}_costTotal10`,
    `goal${i}_myCoverage`, `goal${i}_rivalCoverage`, `goal${i}_survival`, `goal${i}_rivalClaimCount4`,
  ]).flat(),
  // 己方手牌/已打出引擎结构（13 + 13）
  'hand_count10', 'hand_create', 'hand_upgrade', 'hand_trade',
  'hand_inY5', 'hand_inG5', 'hand_inB5', 'hand_inP5', 'hand_outY5', 'hand_outG5', 'hand_outB5', 'hand_outP5',
  'hand_maxRepeat3',
  'played_count10', 'played_create', 'played_upgrade', 'played_trade',
  'played_inY5', 'played_inG5', 'played_inB5', 'played_inP5',
  'played_outY5', 'played_outG5', 'played_outB5', 'played_outP5', 'played_maxRepeat3',
  // 商人市场（6 槽）
  ...Array.from({ length: 6 }, (_, i) => [
    `mkt${i}_present`, `mkt${i}_bonusSum5`, `mkt${i}_outputSum5`,
    `mkt${i}_create`, `mkt${i}_upgrade`, `mkt${i}_trade`, `mkt${i}_affordable`,
  ]).flat(),
  // 行动扩展
  'act_claimPoints20', 'act_claimCoverage', 'act_claimSurvival', 'act_claimNet10', 'act_claimCopperSlot',
  'act_acqSlot3', 'act_acqBonus5', 'act_acqOutput5', 'act_acqCreate', 'act_acqUpgrade', 'act_acqTrade', 'act_acqAffordable',
  'act_playOutput5', 'act_playInput5', 'act_playCreate', 'act_playUpgrade', 'act_playTrade', 'act_playSteps2', 'act_playHandEmpty',
  'act_restPlayed10', 'act_restHandEmpty', 'act_restHand10',
  'act_value_isPlay', 'act_value_isAcquire', 'act_value_isClaim', 'act_value_isRest',
  'act_remainingClaims5', 'act_trigger', 'act_claim_remaining5', 'act_claimPoints_remaining5',
  // 手牌/已打出的卡牌存在位（45 + 45；顺序 = MERCHANT_DECK + S01/S02）
  ...CARD_IDS.map(id => `has_hand_${id}`),
  ...CARD_IDS.map(id => `has_played_${id}`),
];

export const FEATURE_NAMES = [...LEGACY_FEATURE_NAMES, ...RICH_FEATURE_NAMES];
const IDX = new Map(FEATURE_NAMES.map((n, i) => [n, i]));

function publicScore(p) {
  return p.claimed.reduce((s, id) => s + (GOLEM_BY_ID[id]?.points ?? 0), 0)
    + p.copper * 3 + p.silver + p.stock[1] + p.stock[2] + p.stock[3];
}

function coverageOf(stock, goal) {
  const total = goal.cost.reduce((s, x) => s + x, 0);
  if (!total) return 1;
  return goal.cost.reduce((s, x, c) => s + Math.min(x, stock[c]), 0) / total;
}

function canPay(stock, goal) {
  return goal.cost.every((n, c) => stock[c] >= n);
}

/** 上下文特征（公开）。返回与 FEATURE_NAMES 同长度的 0 基线 + 已填字段。 */
function contextFeatures(state, seat, preferred, survival, unseen) {
  const players = state.players;
  const n = players.length;
  const threshold = n >= 4 ? 5 : 6;
  const scores = players.map(publicScore);
  const claimed = players.map(p => p.claimed.length);
  const me = players[seat];
  const mine = scores[seat];
  let bestScore = -Infinity, bestClaimed = 0;
  const rivals = players.filter(p => p.id !== seat);
  for (const p of rivals) {
    bestScore = Math.max(bestScore, scores[p.id]);
    bestClaimed = Math.max(bestClaimed, claimed[p.id]);
  }
  const aboveMe = scores.filter(s => s > mine).length;
  const lower = scores.filter(s => s < mine).map(s => s);
  const gapLeader = Math.max(0, bestScore - mine);
  let bestGoalPoints = 0;
  let myBestCov = 0, rivalBestCov = 0;
  for (const id of state.golemMarket) {
    const goal = GOLEM_BY_ID[id];
    if (!goal) continue;
    if (goal.points > bestGoalPoints) bestGoalPoints = goal.points;
    myBestCov = Math.max(myBestCov, coverageOf(me.stock, goal));
    for (const p of rivals) rivalBestCov = Math.max(rivalBestCov, coverageOf(p.stock, goal));
  }
  const goal = preferred ? GOLEM_BY_ID[preferred] : null;
  const gapPreferred = goal ? goal.cost.reduce((s, x, c) => s + Math.max(0, x - me.stock[c]), 0) : 0;
  const legalClaims = state.golemMarket.filter(id => GOLEM_BY_ID[id] && canPay(me.stock, GOLEM_BY_ID[id]));
  const bestClaimPoints = legalClaims.reduce((m, id) => Math.max(m, GOLEM_BY_ID[id].points), 0);
  const stockTotal = me.stock.reduce((a, b) => a + b, 0);

  const values = new Array(FEATURE_NAMES.length).fill(0);
  const set = (name, v) => { const i = IDX.get(name); if (i !== undefined) values[i] = Number.isFinite(v) ? v : 0; };
  set('turn50', state.turnNumber / 50);
  set('trigger', state.triggerPlayer !== null ? 1 : 0);
  set('seats', n);
  set('myScore20', mine / 20);
  set('oppBestScore20', bestScore / 20);
  set('scoreDiff10', (mine - bestScore) / 10);
  set('myClaimed6', claimed[seat] / 6);
  set('oppBestClaimed6', bestClaimed / 6);
  set('remainingClaims6', (threshold - claimed[seat]) / 6);
  set('hand10', me.hand.length / 10);
  set('played10', me.played.length / 10);
  set('stockTotal10', stockTotal / 10);
  set('myCoins10', (me.copper * 3 + me.silver) / 10);
  set('copperPool10', state.copper / 10);
  set('silverPool10', state.silver / 10);
  set('marketGolems6', state.golemMarket.length / 6);
  set('bestGoalPoints20', bestGoalPoints / 20);
  set('goalCoverageDiff', myBestCov - rivalBestCov);
  set('gapPreferred10', gapPreferred / 10);

  set('ctx_rank', aboveMe / 5);
  set('ctx_gapLeader10', gapLeader / 10);
  set('ctx_myTurns50', me.turns / 50);
  set('ctx_stockY5', me.stock[0] / 5); set('ctx_stockG5', me.stock[1] / 5);
  set('ctx_stockB5', me.stock[2] / 5); set('ctx_stockP5', me.stock[3] / 5);
  set('ctx_copper3', me.copper / 3); set('ctx_silver2', me.silver / 2);
  set('ctx_claimableCount5', legalClaims.length / 5);
  set('ctx_bestClaimPoints20', bestClaimPoints / 20);
  set('ctx_myBestCoverage', myBestCov);
  set('ctx_rivalBestCoverage', rivalBestCov);
  set('ctx_coverageDiff', myBestCov - rivalBestCov);
  set('ctx_unseenMerchants43', (unseen?.merchants ?? 43) / 43);
  set('ctx_unseenGolems36', (unseen?.golems ?? 36) / 36);
  set('ctx_seatPos', n > 1 ? seat / (n - 1) : 0);

  // 逐对手（按座位序，不含自己；座位顺序距离 = 我之后第几个行动）
  const others = players.filter(p => p.id !== seat).sort((a, b) => a.id - b.id).slice(0, 4);
  others.forEach((p, i) => {
    const orderDist = (p.id - seat + n) % n;
    const oppClaims = state.golemMarket.filter(id => GOLEM_BY_ID[id] && canPay(p.stock, GOLEM_BY_ID[id]));
    set(`opp${i}_present`, 1);
    set(`opp${i}_score20`, scores[p.id] / 20);
    set(`opp${i}_claimed6`, claimed[p.id] / 6);
    set(`opp${i}_stockTotal10`, p.stock.reduce((a, b) => a + b, 0) / 10);
    set(`opp${i}_hand10`, p.hand.length / 10);
    set(`opp${i}_played10`, p.played.length / 10);
    set(`opp${i}_maxClaimPoints20`, oppClaims.reduce((m, id) => Math.max(m, GOLEM_BY_ID[id].points), 0) / 20);
    set(`opp${i}_orderDist5`, orderDist / 5);
  });

  // 魔像市场
  state.golemMarket.slice(0, 6).forEach((id, i) => {
    const g = GOLEM_BY_ID[id];
    if (!g) return;
    const total = g.cost.reduce((s, x) => s + x, 0);
    let rivalClaims = 0;
    for (const p of rivals) if (canPay(p.stock, g)) rivalClaims += 1;
    set(`goal${i}_present`, 1);
    set(`goal${i}_points20`, g.points / 20);
    set(`goal${i}_costTotal10`, total / 10);
    set(`goal${i}_myCoverage`, coverageOf(me.stock, g));
    set(`goal${i}_rivalCoverage`, Math.max(0, ...rivals.map(p => coverageOf(p.stock, g))));
    set(`goal${i}_survival`, survival[id] ?? 1);
    set(`goal${i}_rivalClaimCount4`, rivalClaims / 4);
  });
  return values;
}

/** 手牌/已打出引擎结构摘要。 */
function engineSummary(ids, prefix, values, set) {
  let create = 0, upgrade = 0, trade = 0, maxRepeat = 0;
  const inS = [0, 0, 0, 0], outS = [0, 0, 0, 0];
  for (const id of ids) {
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') create += 1;
    else if (card.kind === 'upgrade') upgrade += 1;
    else trade += 1;
    maxRepeat = Math.max(maxRepeat, card.repeats ?? card.steps ?? 0);
    (card.input ?? []).forEach((n, c) => { inS[c] += n; });
    (card.output ?? []).forEach((n, c) => { outS[c] += n; });
  }
  const colors = ['Y', 'G', 'B', 'P'];
  set(`${prefix}_count10`, ids.length / 10);
  set(`${prefix}_create`, create ? 1 : 0);
  set(`${prefix}_upgrade`, upgrade ? 1 : 0);
  set(`${prefix}_trade`, trade ? 1 : 0);
  colors.forEach((c, i) => set(`${prefix}_in${c}5`, inS[i] / 5));
  colors.forEach((c, i) => set(`${prefix}_out${c}5`, outS[i] / 5));
  set(`${prefix}_maxRepeat3`, maxRepeat / 3);
}

/** 完整单行动特征（legacy 54 + rich；长度 = FEATURE_NAMES）。 */
function actionFeatures(state, seat, action, search, preferred, ctx, value, rank, survival) {
  const players = state.players;
  const n = players.length;
  const threshold = n >= 4 ? 5 : 6;
  const remaining = threshold - players[seat].claimed.length;
  const isPlay = action.type === 'play' ? 1 : 0;
  const isAcquire = action.type === 'acquire' ? 1 : 0;
  const isClaim = action.type === 'claim' ? 1 : 0;
  const isRest = action.type === 'rest' ? 1 : 0;
  const out = [...ctx];
  const set = (name, v) => { const i = IDX.get(name); if (i !== undefined) out[i] = Number.isFinite(v) ? v : 0; };
  set('isPlay', isPlay); set('isAcquire', isAcquire); set('isClaim', isClaim); set('isRest', isRest);
  set('value10', Number.isFinite(value) ? value / 10 : -5);
  set('rank5', rank < 0 ? -1 : Math.min(rank, 9) / 5);

  // 认领
  let claimPoints = 0, claimCoverage = 0, claimSurvival = 0, claimNet = 0, claimCopper = 0;
  if (isClaim) {
    const id = state.golemMarket[action.index];
    const goal = id ? GOLEM_BY_ID[id] : null;
    if (goal) {
      claimPoints = goal.points / 20;
      claimCoverage = coverageOf(players[seat].stock, goal);
      claimNet = (goal.points + (action.index === 0 ? (players[seat].copper ? 3 : players[seat].silver ? 1 : 0) : 0)) / 10;
      claimSurvival = survival[id] ?? 1;
      claimCopper = action.index === 0 ? 1 : 0;
    }
  }
  set('claimPoints20', claimPoints); set('claimCoverage', claimCoverage);
  set('claimSurvival', claimSurvival); set('claimNetDelta10', claimNet); set('claimCopperSlot', claimCopper);
  set('act_claimPoints20', claimPoints); set('act_claimCoverage', claimCoverage);
  set('act_claimSurvival', claimSurvival); set('act_claimNet10', claimNet); set('act_claimCopperSlot', claimCopper);

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
  set('acqIndex3', acqIndex); set('acqBonusSum5', acqBonus); set('acqOutputSum5', acqOutput);
  set('acqKindCreate', acqCreate); set('acqKindUpgrade', acqUpgrade); set('acqKindTrade', acqTrade);
  set('act_acqSlot3', acqIndex); set('act_acqBonus5', acqBonus); set('act_acqOutput5', acqOutput);
  set('act_acqCreate', acqCreate); set('act_acqUpgrade', acqUpgrade); set('act_acqTrade', acqTrade);
  set('act_acqAffordable', isAcquire ? 1 : 0);

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
  set('playOutputSum5', playOutput); set('playInputSum5', playInput);
  set('playKindCreate', playCreate); set('playKindUpgrade', playUpgrade); set('playKindTrade', playTrade);
  set('playSteps2', playSteps); set('playHandAfter0', handAfter0);
  set('act_playOutput5', playOutput); set('act_playInput5', playInput);
  set('act_playCreate', playCreate); set('act_playUpgrade', playUpgrade); set('act_playTrade', playTrade);
  set('act_playSteps2', playSteps); set('act_playHandEmpty', handAfter0);

  // 休息
  const restPlayed = isRest ? players[seat].played.length / 10 : 0;
  const restHandEmpty = isRest && players[seat].hand.length === 0 ? 1 : 0;
  const restHand = isRest ? players[seat].hand.length / 10 : 0;
  set('restPlayed10', restPlayed); set('restHandEmpty', restHandEmpty); set('restHand10', restHand);
  set('act_restPlayed10', restPlayed); set('act_restHandEmpty', restHandEmpty); set('act_restHand10', restHand);

  // 交互
  const v = Number.isFinite(value) ? value / 10 : 0;
  set('value_isPlay', v * isPlay); set('value_isAcquire', v * isAcquire);
  set('value_isClaim', v * isClaim); set('value_isRest', v * isRest);
  set('value_remainingClaims', v * remaining / 6); set('value_trigger', v * (state.triggerPlayer !== null ? 1 : 0));
  set('isClaim_remainingClaims', isClaim * remaining / 6);
  set('claimPoints_remainingClaims', claimPoints * remaining / 6);
  set('act_value_isPlay', v * isPlay); set('act_value_isAcquire', v * isAcquire);
  set('act_value_isClaim', v * isClaim); set('act_value_isRest', v * isRest);
  set('act_remainingClaims5', remaining / 6); set('act_trigger', state.triggerPlayer !== null ? 1 : 0);
  set('act_claim_remaining5', isClaim * remaining / 6);
  set('act_claimPoints_remaining5', claimPoints * remaining / 6);

  // 商人市场槽位（状态级，重复于每个候选行；推理侧同口径）
  state.merchantMarket.slice(0, 6).forEach((offer, i) => {
    const card = MERCHANT_BY_ID[offer.id];
    set(`mkt${i}_present`, 1);
    set(`mkt${i}_bonusSum5`, (offer.bonus[0] + offer.bonus[1] + offer.bonus[2] + offer.bonus[3]) / 5);
    set(`mkt${i}_outputSum5`, card?.output ? card.output.reduce((s, x) => s + x, 0) / 5 : 0);
    set(`mkt${i}_create`, card?.kind === 'create' ? 1 : 0);
    set(`mkt${i}_upgrade`, card?.kind === 'upgrade' ? 1 : 0);
    set(`mkt${i}_trade`, card?.kind === 'trade' ? 1 : 0);
    set(`mkt${i}_affordable`, players[seat].stock.reduce((s, x) => s + x, 0) >= i ? 1 : 0);
  });
  // 手牌/已打出存在位（精确卡牌身份）
  for (const id of players[seat].hand) {
    const i = IDX.get(`has_hand_${id}`);
    if (i !== undefined) out[i] = 1;
  }
  for (const id of players[seat].played) {
    const i = IDX.get(`has_played_${id}`);
    if (i !== undefined) out[i] = 1;
  }
  return out;
}

const lines = [];
const stats = {
  split, shard, shards, seedBase, games: 0, decisions: 0, rows: 0,
  uniqueSeeds: 0, labelPlanMissing: 0, labelJs5Missing: 0,
  planInTop: 0, js5InTop: 0, greedyPlanAgree: 0, greedyJs5Agree: 0,
  js5PlanAgree: 0, labelJs5OutOfTop: 0,
  actionCounts: { play: 0, acquire: 0, claim: 0, rest: 0, discard: 0 },
  bySeats: {},
};
const seenSeeds = new Set();
for (const seatCount of SEATS) {
  stats.bySeats[seatCount] = { games: 0, decisions: 0 };
  for (let g = 0; g < gamesPerCount; g++) {
    const seed = seedBase + shard * SHARD_STRIDE + seatCount * COUNT_STRIDE + g;
    if (seenSeeds.has(seed)) throw new Error(`种子重复（分片配置错误）：${seed}`);
    seenSeeds.add(seed);
    const focusSeat = (g * 7 + 3) % seatCount;
    let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
    game.players[0].isAI = true;
    while (game.phase !== 'finished') {
      const seat = game.current;
      let action;
      if (seat === focusSeat) {
        if (game.phase === 'turn') {
          const obs = buildObservation(game, seat);
          const profile = seatProfile(seat);
          const plan = choosePlan(obs, CH, profile, 'beam-rollout');
          const sim = createSimulation(obs, { simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT) });
          const ctxH = heuristicContext(sim.view, CH, profile);
          const { search, preferred, ranked } = myRankedActions(sim.view, seat, ctxH);
          const legal = enumerateLegalActions(sim.view, { dedupe: true });
          const rankOf = new Map(ranked.map((x, i) => [key(x.action), i]));
          const survival = golemSurvivalModel(obs, 6);
          const ctx = contextFeatures(sim.view, seat, preferred, survival, {
            merchants: sim.view.unseenMerchants?.length,
            golems: sim.view.unseenGolems?.length,
          });
          const scored = legal.map(a => {
            const v = actionValue(search, a, preferred, ctxH);
            return { action: a, value: v, row: actionFeatures(sim.view, seat, a, search, preferred, ctx, v, rankOf.has(key(a)) ? rankOf.get(key(a)) : -1, survival) };
          });
          const planKey = plan?.first ? key(plan.first) : null;
          const js5 = chooseJointAction(game, {
            version: 'joint-js5', workUnits: WU, championParameters: CH, profile,
            simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
          });
          const js5Key = key(js5.action);
          // 推理侧候选 = 贪心价值前 TOP ∪ 两个标签行动（标签在 TOP 外则不可选）。
          const byValue = scored.slice().sort((x, y) => (Number.isFinite(y.value) ? y.value : -Infinity)
            - (Number.isFinite(x.value) ? x.value : -Infinity) || key(x.action).localeCompare(key(y.action)));
          const kept = byValue.slice(0, TOP);
          const topKeys = new Set(kept.map(x => key(x.action)));
          for (const x of scored) {
            if ((planKey && key(x.action) === planKey) || key(x.action) === js5Key) {
              if (!topKeys.has(key(x.action))) { kept.push(x); topKeys.add(key(x.action)); }
            }
          }
          if (sampleMode === 'policy' && sampleNegatives > 0) {
            const remaining = scored.filter(x => !topKeys.has(key(x.action)));
            const rng = mulberry32((seed ^ Math.imul(game.turnNumber, 2654435761) ^ (seat + 1)) >>> 0);
            for (let i = remaining.length - 1; i > 0; i--) {
              const j = Math.floor(rng() * (i + 1));
              [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
            }
            for (const x of remaining.slice(0, sampleNegatives)) {
              kept.push(x);
              topKeys.add(key(x.action));
            }
          }
          const keptKeys = kept.map(x => key(x.action));
          const planIdx = planKey ? keptKeys.indexOf(planKey) : -1;
          const js5Idx = keptKeys.indexOf(js5Key);
          const planInTop = planKey ? byValue.slice(0, TOP).some(x => key(x.action) === planKey) : false;
          const js5InTop = byValue.slice(0, TOP).some(x => key(x.action) === js5Key);
          const planRank = planKey && rankOf.has(planKey) ? rankOf.get(planKey) : -1;
          const js5Rank = rankOf.has(js5Key) ? rankOf.get(js5Key) : -1;
          stats.decisions += 1;
          if (planIdx < 0) stats.labelPlanMissing += 1; else if (planInTop) stats.planInTop += 1;
          if (js5Idx < 0) stats.labelJs5Missing += 1; else if (js5InTop) stats.js5InTop += 1;
          if (!js5InTop) stats.labelJs5OutOfTop += 1;
          if (planRank === 0) stats.greedyPlanAgree += 1;
          if (js5Rank === 0) stats.greedyJs5Agree += 1;
          if (planIdx >= 0 && planIdx === js5Idx) stats.js5PlanAgree += 1;
          stats.bySeats[seatCount].decisions += 1;
          stats.actionCounts[js5.action.type] = (stats.actionCounts[js5.action.type] ?? 0) + 1;
          lines.push(JSON.stringify({
            schema: 'ai13-plan-data-v2',
            seed, seats: seatCount, focusSeat, turn: game.turnNumber,
            labelPlan: planIdx, labelJs5: js5Idx, planRank, js5Rank, planInTop, js5InTop,
            legalCount: legal.length, sampleMode, sampleCount: kept.length,
            rows: kept.map(x => x.row),
          }));
          stats.rows += kept.length;
          action = js5.action;
        } else {
          action = chooseJointAction(game, {
            version: 'joint-js5', workUnits: WU, championParameters: CH, profile: seatProfile(seat),
            simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
          }).action;
        }
      } else {
        action = chooseAIAction(game, { parameters: registry.versions[OPPONENT_IDS[(g + seat) % OPPONENT_IDS.length]].parameters, profile: seatProfile(seat) }).action;
      }
      game = applyAction(game, action);
    }
    stats.games += 1;
    stats.bySeats[seatCount].games += 1;
  }
}
stats.uniqueSeeds = seenSeeds.size;
const meta = {
  schema: 'ai13-plan-features-v1',
  split, shard, shards, seedBase, gamesPerCount, workUnits: WU,
  sampleMode, sampleNegatives, topK: TOP,
  featureNames: FEATURE_NAMES,
  legacyFeatureNames: LEGACY_FEATURE_NAMES,
  targetFeatureCount: FEATURE_NAMES.length,
  ...stats,
  greedyPlanAgreement: +(stats.greedyPlanAgree / Math.max(1, stats.decisions)).toFixed(4),
  greedyJs5Agreement: +(stats.greedyJs5Agree / Math.max(1, stats.decisions)).toFixed(4),
  js5PlanAgreement: +(stats.js5PlanAgree / Math.max(1, stats.decisions)).toFixed(4),
};
writeFileSync(out, [JSON.stringify({ meta: true, ...meta }), ...lines].join('\n') + '\n');
console.log(JSON.stringify({ split, shard, targetFeatures: FEATURE_NAMES.length, ...stats, out }));
