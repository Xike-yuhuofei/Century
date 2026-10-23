/** Opponent Model V1 独立预测质量评估（AI6 第三阶段·任务 G）。
 *
 * 数据与信息纪律：
 * - 数据集由正式规则引擎（dist/js/engine.js）+ 真实 AI 版本驱动的完整对局生成；
 * - 每个预测样本只使用预测时点之前的公开信息（公开观察 + 公开历史摘要）；
 * - 未来实际行动只用于构造离线标签，绝不进入预测输入；
 * - 训练/调参/测试按完整对局种子分组隔离（种子块互不重叠）；
 * - 评测种子块 OM_EVAL_BLOCK [1.25e9, 1.26e9)：与训练/验证/AI6 基线块物理隔离，
 *   不消费任何种子账本（离线评测，非正式挑战）。
 *
 * 对照模型（同一测试集、相同信息边界、可比较的计算预算）：
 * - M0：无历史规则先验（行动/意图同 M2 头部但无历史；存活/ETA 为闭式先验）；
 * - M1：既有 golemSurvivalModel / pressureModel 启发式（独立适配器）；
 * - M2：规则式行动与 ETA（rollout 驱动，无历史特征）；
 * - M3：M2 + 公开历史特征；
 * - M4：M3 + 风格贝叶斯混合（完整模型）。
 *
 * 指标（按任务书）：
 * - 行动：NLL、Top-1/Top-3；
 * - 意图：Brier Score、ECE（行为代理标签 = 该玩家实际下一次认领目标；
 *   无认领记为 none——代理指标的局限性在报告中注明）；
 * - ETA：已认领样本 MAE + CDF 覆盖；删失样本（被抢/未认领/终局）pBeyond 校准；
 * - 存活：Brier Score、ECE；
 * - 算法性能：p50/p95/p99 延迟、吞吐、内存。
 *
 * 统计不确定性：按对局种子聚类的 bootstrap 置信区间（相关样本修正）。
 *
 * 用法：node scripts/om-eval.mjs [--quick] [--out 路径]
 *   --quick：小样本冒烟口径（CI 用）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction, score as engineScore } from '../dist/js/engine.js';
import {
  chooseAIAction, buildObservation, golemSurvivalModel, PROFILES, NEUTRAL_PROFILE,
  BASELINE_PARAMETERS,
} from '../dist/js/ai.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
import {
  buildPublicSimState, enumerateLegalActions, createEmptyHistory, appendEvent,
  derivePublicEvent, snapshotFromObservation, hashPublicState,
} from '../dist/js/sim/index.js';
import { createOpponentModel } from '../dist/js/om/index.js';
import { coverageOf, featurePack, turnsToAfford, gapOf, reachableStock, STYLE_PRIOR } from '../dist/js/om/features.js';

// === 配置 ===

const OM_EVAL_BLOCK_BASE = 1.25e9; // 评测专用种子块（不与任何已定义块重叠）
const SPLIT_OFFSETS = { tune: 0, test: 200_000 }; // 块内偏移：调参/测试物理隔离
const SEAT_COUNTS = [2, 3, 4, 5];

/** 席位版本配方（覆盖冠军/历史冠军/结构变体/固定启发式风格）。 */
const SEAT_RECIPES = {
  champion: null, // 全冠军席位（chooseAIAction 缺省 = 当前冠军）
  mixed: (seat, n) => {
    // 混编：历史冠军基线参数 / 结构变体 / 启发式风格轮转
    const roster = [
      { parameters: BASELINE_PARAMETERS },
      { structure: 'beam-contest' },
      { structure: 'beam-lineage' },
      { structure: 'beam-adaptive' },
      null, // 冠军缺省
    ];
    const pick = roster[(seat + n) % roster.length];
    return pick ?? {};
  },
  styles: (seat) => ({ profile: seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length] }),
};

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const outIdx = args.indexOf('--out');
const OUT_PATH = outIdx >= 0 ? resolve(args[outIdx + 1]) : null;

const CFG = QUICK
  ? { gamesPerCell: 1, sampleStride: 6, maxSamples: 48, raceSamples: 12, rollouts: 6, etaHorizon: 3, survHorizon: 2, golemsPerSample: 1, budgetMs: 600 }
  : { gamesPerCell: 3, sampleStride: 4, maxSamples: 260, raceSamples: 90, rollouts: 8, etaHorizon: 4, survHorizon: 3, golemsPerSample: 2, budgetMs: 1500 };

// === 数据集生成：完整对局 + 逐决策样本（公开边界内） ===

function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

/** 生成一局完整对局并抽取预测样本。
 * 返回 samples: [{ seatCount, seed, decisionIndex, obs, history, action, seat,
 *                  ownActionIndex, future: {claims, endTurn} }]
 * 信息纪律：history 为"该决策时点之前"的公开事件快照（不含未来），未来行动
 * 只出现在标签字段（claims）。 */
function collectSamples(seatCount, recipeName, seed, cfg) {
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  const history = createEmptyHistory(seatCount, { origin: 'recorded' });
  const samples = [];
  const own = new Array(seatCount).fill(0);
  // 未来事件账本：走完一局后回填标签。
  const decisions = [];
  let moves = 0;
  while (game.phase !== 'finished' && moves < 600) {
    const before = buildObservation(game, game.current);
    const seat = game.current;
    const version = recipeName === 'champion' ? {} : (typeof SEAT_RECIPES[recipeName] === 'function' ? SEAT_RECIPES[recipeName](seat, seatCount) : {});
    const { action } = chooseAIAction(game, {
      ...(version.parameters ? { parameters: version.parameters } : {}),
      ...(version.structure ? { structure: version.structure } : {}),
      ...(version.profile ? { profile: version.profile } : { profile: seatProfile(seat) }),
    });
    const ownIdx = ++own[seat];
    // 决策时点的公开历史快照（此刻 summary 恰含本决策之前的全部事件）。
    const historySnapshot = structuredClone(history);
    decisions.push({ before, action, seat, ownIdx, turn: game.turnNumber, historySnapshot });
    const after = applyAction(game, action);
    appendEvent(history, derivePublicEvent(
      snapshotFromObservation(before), action,
      snapshotFromObservation(buildObservation(after, after.current)),
    ));
    game = after;
    moves += 1;
  }
  if (game.phase !== 'finished') return samples; // 异常局不入集
  // 回填标签：每席位的认领序列（目标魔像 → 实际自身行动序数）。
  const claimOrder = Array.from({ length: seatCount }, () => []); // [{golemId, k}]
  for (const d of decisions) {
    if (d.action.type === 'claim') {
      const golemId = d.before.golemMarket[d.action.index];
      claimOrder[d.seat].push({ golemId, k: d.ownIdx });
    }
  }
  for (let di = 0; di < decisions.length; di += cfg.sampleStride) {
    const d = decisions[di];
    samples.push({
      seatCount, seed, recipe: recipeName, decisionIndex: di,
      obs: d.before, history: d.historySnapshot,
      action: d.action, seat: d.seat, ownActionIndex: d.ownIdx,
      claims: claimOrder.map(arr => arr.filter(c => c.k >= d.ownIdx)),
      totalDecisions: decisions.length,
    });
  }
  return samples;
}

// === 模型注册（M0–M4 + M1 适配器） ===

function makeModels(cfg) {
  const shared = { rollouts: cfg.rollouts, etaHorizon: cfg.etaHorizon, horizon: cfg.survHorizon, budgetMs: cfg.budgetMs, cacheSize: 512 };
  return {
    // M0：无历史规则先验（行动/意图头与 M2 相同的无历史配置；存活/ETA 用闭式先验，无 rollout）。
    M0: { kind: 'M0', model: createOpponentModel({ ...shared, useHistory: false, useHistoryStyle: false, seed: 11 }) },
    M1: { kind: 'M1', model: null }, // 既有启发式闭式适配器
    // M2：规则式行动与 ETA（rollout 驱动，无历史特征）。
    M2: { kind: 'M2', model: createOpponentModel({ ...shared, useHistory: false, useHistoryStyle: false, seed: 11 }) },
    // M3：M2 + 公开历史特征。
    M3: { kind: 'M3', model: createOpponentModel({ ...shared, useHistory: true, useHistoryStyle: false, seed: 11 }) },
    // M4：M3 + 风格贝叶斯混合（完整模型）。
    M4: { kind: 'M4', model: createOpponentModel({ ...shared, useHistory: true, useHistoryStyle: true, seed: 11 }) },
  };
}

const actionKey = (a) => JSON.stringify(a, (k, v) => (v === undefined ? null : v));

/** 行动分布 → {p(action), top1..3}。 */
function actionMetrics(dist, actual) {
  const key = actionKey(actual);
  const entries = dist.entries;
  const exact = entries.find(e => actionKey(e.action) === key);
  const nll = exact ? -Math.log(Math.max(exact.p, 1e-12)) : 20.0; // 缺失 = 非法预测（重罚并计数）
  const sorted = [...entries].sort((a, b) => b.p - a.p).map(e => actionKey(e.action));
  return { nll, p: exact?.p ?? 0, top1: sorted[0] === key ? 1 : 0, top3: sorted.slice(0, 3).includes(key) ? 1 : 0, missing: exact ? 0 : 1 };
}

/** 意图分布 → Brier（行为代理标签）/ ECE 分箱。 */
function intentVector(intent, golemMarket) {
  const classes = [...golemMarket, '__none__'];
  const p = Object.fromEntries(classes.map(id => [id, 0]));
  for (const e of intent.golems) p[e.golemId] = e.p;
  p.__none__ = intent.noSpecificTarget;
  return { classes, p };
}

function brierScore(p, actualClass, classes) {
  return classes.reduce((s, c) => s + (p[c] - (c === actualClass ? 1 : 0)) ** 2, 0) / classes.length;
}

// === M1 适配器（既有启发式；独立于 M2–M4 的概率模型） ===

function m1ActionDistribution(state, history) {
  // 以公开特征近似冠军侧启发式：压力模型驱动的获取紧迫度 + 卡牌价值。
  const legal = enumerateLegalActions(state, { dedupe: true });
  const pack = featurePack(state);
  const feats = pack.byId.get(state.current);
  const view = { ...state, playerId: state.current, players: state.players, current: state.current,
    merchantMarket: state.merchantMarket, golemMarket: state.golemMarket,
    copper: state.copper, silver: state.silver, phase: state.phase,
    triggerPlayer: state.triggerPlayer, turnNumber: state.turnNumber };
  const survival = golemSurvivalModel(view, 6);
  const entries = legal.map(action => {
    let score = 0;
    if (action.type === 'claim') {
      const g = GOLEM_BY_ID[state.golemMarket[action.index]];
      const coin = action.index === 0 ? (state.copper > 0 ? 3 : state.silver > 0 ? 1 : 0) : 0;
      score = (g.points + coin) / 6 * (0.4 + 1.2 * (survival[state.golemMarket[action.index]] ?? 1));
    } else if (action.type === 'play') {
      score = 0.8;
    } else if (action.type === 'acquire') {
      score = 1.0;
    } else if (action.type === 'rest') {
      score = feats.playedCount >= 2 ? 0.7 : -0.5;
    } else {
      score = -0.4;
    }
    return { action, family: action.type === 'claim' ? 'claim' : action.type, score, p: 0, explain: 'M1 heuristic' };
  });
  // softmax T=0.8（与 V1 同温度口径）。
  const max = Math.max(...entries.map(e => e.score));
  const exps = entries.map(e => Math.exp((e.score - max) / 0.8));
  const sum = exps.reduce((s, e) => s + e, 0) || 1;
  entries.forEach((e, i) => { e.p = exps[i] / sum; });
  return { playerId: state.current, entries, temperature: 0.8, style: { ...STYLE_PRIOR }, notes: ['M1 legacy adapter'] };
}

function m1Intent(state, playerId) {
  const pack = featurePack(state);
  const feats = pack.byId.get(playerId);
  const entries = state.golemMarket.map(golemId => {
    const g = GOLEM_BY_ID[golemId];
    return { golemId, p: 0, utility: coverageOf(g.cost, feats.reachable), explain: { coverage: coverageOf(g.cost, feats.reachable), engineAffinity: 0, actionsNeeded: 0, historyMatch: 0, contested: 0, styleFit: 1 } };
  });
  const probs = softmaxProbs(entries.map(e => e.utility), 0.3);
  entries.forEach((e, i) => { e.p = probs[i] * 0.85; });
  return { playerId, golems: entries, noSpecificTarget: 0.15, style: { ...STYLE_PRIOR }, styleEvidence: { rush: 0, engine: 0, coin: 0, contest: 0, balanced: 0 }, uncertainty: 0.8, notes: ['M1 legacy adapter'] };
}

function softmaxProbs(logits, t) {
  const max = Math.max(...logits);
  const exps = logits.map(l => Math.exp((l - max) / t));
  const sum = exps.reduce((s, e) => s + e, 0) || 1;
  return exps.map(e => e / sum);
}

/** M0/M1 的闭式 ETA（无 rollout）：贪心覆盖缺口轮数 + 常数不确定带。 */
function closedFormETA(state, playerId, golemId, horizon) {
  const pack = featurePack(state);
  const feats = pack.byId.get(playerId);
  const g = GOLEM_BY_ID[golemId];
  const cov = coverageOf(g.cost, feats.reachable);
  const gap = gapOf(g.cost, feats.reachable);
  const turns = turnsToAfford(gap, feats.handProduction);
  const k = cov >= 0.999 ? 1 : (turns >= 99 ? null : turns + 1);
  const pClaimAt = new Array(horizon).fill(0);
  if (k !== null && k <= horizon) pClaimAt[k - 1] = 0.5;
  const cumulative = [];
  let acc = 0;
  for (const p of pClaimAt) { acc += p; cumulative.push(acc); }
  return { playerId, golemId, horizon, earliestRuleEstimate: k, earliestRuleBlockedBy: k === null ? 'unreachable' : null,
    pClaimAt, cumulative, pBeyond: 1 - acc, pStolenBefore: 0, pGameEnded: 0, samples: 0, notes: ['closed-form'] };
}

/** M0/M1 的闭式存活（无 rollout）：座位无关的独立衰减先验。 */
function closedFormSurvival(state, golemId, horizon, viewerId) {
  // 独立先验：每轮每对手 0.15 概率抢走（座位不感知——这正是 M0/M1 的局限）。
  const nRivals = state.playerCount - 1;
  const pSurvivePerRound = Math.max(0, 1 - (0.15 * nRivals) / Math.max(1, state.golemMarket.length));
  const pPresentAt = [state.golemMarket.includes(golemId) ? 1 : 0];
  const reachRate = [1];
  for (let k = 1; k <= horizon; k++) {
    pPresentAt.push(state.golemMarket.includes(golemId) ? pPresentAt[k - 1] * pSurvivePerRound : 0);
    reachRate.push(1);
  }
  return { golemId, viewerId, horizon, pPresentAt, reachRate,
    jointReachPresent: pPresentAt.map((p, k) => p * reachRate[k]),
    perRival: state.players.filter(p => p.id !== viewerId).map(p => ({ playerId: p.id, pClaimWithin: 0 })),
    samples: 0, notes: ['closed-form'] };
}

// === 评测主流程 ===

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function bootstrapCI(values, iterations = 800) {
  if (!values.length) return { lo: 0, hi: 0 };
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[(Math.random() * values.length) | 0];
    means.push(s / values.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[(iterations * 0.025) | 0], hi: means[(iterations * 0.975) | 0] };
}

function groupMeanBySeed(samples, metricFn) {
  // （保留给非对齐场景）按对局（seed+recipe）分组求均值 → 组级样本。
  const groups = new Map();
  for (const s of samples) {
    const key = `${s.seed}|${s.recipe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.values()].map(group => {
    let sum = 0;
    let n = 0;
    for (const s of group) { sum += metricFn(s); n += 1; }
    return n ? sum / n : 0;
  });
}
void groupMeanBySeed;

function eceOf(pairs, bins = 10) {
  // pairs: [{p, y}] — 期望校准误差。
  if (!pairs.length) return 0;
  const bucket = Array.from({ length: bins }, () => ({ sum: 0, n: 0, pos: 0 }));
  for (const { p, y } of pairs) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    bucket[b].sum += p; bucket[b].n += 1; bucket[b].pos += y;
  }
  let ece = 0;
  for (const b of bucket) {
    if (!b.n) continue;
    ece += (b.n / pairs.length) * Math.abs(b.pos / b.n - b.sum / b.n);
  }
  return ece;
}

async function main() {
  const cfg = CFG;
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const models = makeModels(cfg);
  const latencies = { action: {}, eta: {}, survival: {}, intent: {} };
  const record = { generatedAt: new Date().toISOString(), config: cfg, seatCounts: SEAT_COUNTS, splits: {} };

  for (const split of ['tune', 'test']) {
    const samples = [];
    let gameCount = 0;
    for (const seatCount of SEAT_COUNTS) {
      for (const recipe of ['champion', 'mixed', 'styles']) {
        for (let g = 0; g < cfg.gamesPerCell; g++) {
          const seed = OM_EVAL_BLOCK_BASE + SPLIT_OFFSETS[split] + seatCount * 1000 + g * 137 + (recipe === 'champion' ? 0 : recipe === 'mixed' ? 50000 : 90000);
          const s = collectSamples(seatCount, recipe, seed, cfg);
          samples.push(...s);
          gameCount += 1;
        }
      }
    }
    console.error(`[om-eval] split=${split} games=${gameCount} samples=${samples.length}`);

    // === 行动预测评估（全部样本；M0–M4 + M1） ===
    const actionStats = {};
    for (const [name, m] of Object.entries(models)) {
      const rows = []; // 与 samples 同序
      for (const s of samples) {
        const t = performance.now();
        const dist = m.kind === 'M1' ? m1ActionDistribution(buildPublicSimState(s.obs), s.history) : m.model.predictAction(buildPublicSimState(s.obs), s.seat, s.history);
        (latencies.action[name] ??= []).push(performance.now() - t);
        rows.push(actionMetrics(dist, s.action));
      }
      const mean = fn => rows.reduce((s, r) => s + fn(r), 0) / rows.length;
      // 种子聚类 bootstrap：按 (seed|recipe) 分组重采样。
      const groups = new Map();
      rows.forEach((r, i) => {
        const key = `${samples[i].seed}|${samples[i].recipe}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r.nll);
      });
      const groupMeans = [...groups.values()].map(g => g.reduce((s, v) => s + v, 0) / g.length);
      actionStats[name] = {
        n: rows.length,
        nll: mean(r => r.nll),
        nllCI: bootstrapCI(groupMeans),
        top1: mean(r => r.top1),
        top3: mean(r => r.top3),
        illegalPredictionRate: mean(r => r.missing),
      };
    }

    // === 意图预测评估（行为代理标签：实际下一次认领目标；无认领 = none） ===
    const intentStats = {};
    for (const [name, m] of Object.entries(models)) {
      const briers = [];
      const calibPairs = [];
      for (const s of samples) {
        const t = performance.now();
        const state = buildPublicSimState(s.obs);
        const target = state.golemMarket;
        if (!target.length) continue;
        const intent = m.kind === 'M1' ? m1Intent(state, s.seat) : m.model.predictIntent(state, s.seat, s.history);
        (latencies.intent[name] ??= []).push(performance.now() - t);
        const { classes, p } = intentVector(intent, target);
        const actual = s.claims[s.seat]?.[0]?.golemId ?? '__none__';
        if (!classes.includes(actual)) continue;
        briers.push(brierScore(p, actual, classes));
        calibPairs.push({ p: p[actual] ?? 0, y: 1 });
        for (const c of classes) if (c !== actual) calibPairs.push({ p: p[c] ?? 0, y: 0 });
        void latencies;
      }
      intentStats[name] = {
        n: briers.length,
        brier: briers.reduce((s, v) => s + v, 0) / Math.max(1, briers.length),
        ece: eceOf(calibPairs),
      };
    }

    // === ETA / 存活评估（race 样本子集） ===
    const raceSamples = samples.filter(s => s.obs.golemMarket.length > 0).slice(0, cfg.raceSamples);
    const etaStats = {};
    const survStats = {};
    for (const [name, m] of Object.entries(models)) {
      const mae = [];
      const maeInWindow = []; // 实际认领落在窗口附近的子集（k ≤ horizon+2）——有意义的 MAE 口径
      const cdfAtObserved = [];
      const beyondOnCensored = [];
      const brier = [];
      const calibPairs = [];
      for (const s of raceSamples) {
        const state = buildPublicSimState(s.obs);
        const golems = state.golemMarket.slice(0, cfg.golemsPerSample);
        for (const golemId of golems) {
          // 标签：该席位是否在真实未来认领了该魔像（自身行动序数，含当前决策 k=ownIdx）；
          // 被他人抢走 / 从未认领 = 删失样本。
          const actual = s.claims[s.seat].find(c => c.golemId === golemId) ?? null;
          const stolenByOther = s.claims.some((arr, seat) => seat !== s.seat && arr.some(c => c.golemId === golemId));
          const t = performance.now();
          const closedForm = m.kind === 'M0' || m.kind === 'M1';
          const eta = closedForm
            ? closedFormETA(state, s.seat, golemId, cfg.etaHorizon)
            : m.model.predictClaimETA(state, s.seat, golemId, cfg.etaHorizon);
          (latencies.eta[name] ??= []).push(performance.now() - t);
          if (actual) {
            // 分布口径：E[k]（窗口内按位置求和 + 窗口外质量记 horizon+1）。
            const ek = eta.pClaimAt.reduce((acc, p, i) => acc + p * (i + 1), 0) + eta.pBeyond * (cfg.etaHorizon + 1);
            mae.push(Math.abs(ek - actual.k));
            if (actual.k <= cfg.etaHorizon + 2) maeInWindow.push(Math.abs(ek - actual.k));
            const cdf = eta.cumulative[Math.min(actual.k, cfg.etaHorizon) - 1] ?? 0;
            cdfAtObserved.push(cdf);
          } else if (stolenByOther) {
            beyondOnCensored.push(eta.pStolenBefore);
          } else {
            beyondOnCensored.push(eta.pBeyond);
          }
          // 存活标签：观察席位决策点 τ_k（其第 ownIdx+k-1 次自身行动之前，
          // k=0 即当前决策时刻）该魔像是否仍在市场。
          const claimTurnOfGolem = s.claims.reduce((best, arr) => {
            for (const c of arr) if (c.golemId === golemId) best = Math.min(best, c.k);
            return best;
          }, Infinity);
          const t2 = performance.now();
          const surv = closedForm
            ? closedFormSurvival(state, golemId, cfg.survHorizon, s.seat)
            : m.model.predictSurvivalFor(state, golemId, cfg.survHorizon, s.seat);
          (latencies.survival[name] ??= []).push(performance.now() - t2);
          for (let k = 0; k <= cfg.survHorizon; k++) {
            const ownK = s.ownActionIndex + Math.max(0, k - 1); // τ_k 对应的自身行动序数
            const y = claimTurnOfGolem >= ownK ? 1 : 0;
            brier.push((surv.pPresentAt[Math.min(k, surv.pPresentAt.length - 1)] - y) ** 2);
            calibPairs.push({ p: surv.pPresentAt[Math.min(k, surv.pPresentAt.length - 1)], y });
          }
        }
      }
      etaStats[name] = {
        n: mae.length,
        mae: Number((mae.reduce((s, v) => s + v, 0) / Math.max(1, mae.length)).toFixed(4)),
        maeInWindow: Number((maeInWindow.reduce((s, v) => s + v, 0) / Math.max(1, maeInWindow.length)).toFixed(4)),
        nInWindow: maeInWindow.length,
        meanCdfAtObserved: Number((cdfAtObserved.reduce((s, v) => s + v, 0) / Math.max(1, cdfAtObserved.length)).toFixed(4)),
        meanBeyondOnCensored: Number((beyondOnCensored.reduce((s, v) => s + v, 0) / Math.max(1, beyondOnCensored.length)).toFixed(4)),
        censoredN: beyondOnCensored.length,
      };
      survStats[name] = {
        n: brier.length,
        brier: Number((brier.reduce((s, v) => s + v, 0) / Math.max(1, brier.length)).toFixed(4)),
        ece: Number(eceOf(calibPairs).toFixed(4)),
      };
    }

    record.splits[split] = { gameCount, sampleCount: samples.length, action: actionStats, intent: intentStats, eta: etaStats, survival: survStats };
    if (split === 'tune') {
      // 调参结论：温度选择（按 NLL 最小）——本版本固定 0.8，调参集仅验证该选择。
      const best = Object.entries(actionStats).filter(([n]) => n.startsWith('M')).sort((a, b) => a[1].nll - b[1].nll);
      console.error(`[om-eval] tune NLL ranking: ${best.map(([n, s]) => `${n}=${s.nll.toFixed(3)}`).join(' ')}`);
    }
  }

  // === 性能基准（独立于数据集：M4 端到端按座位数实测） ===
  record.perf = await perfBenchmark();

  record.totalWallMs = Number((performance.now() - t0).toFixed(1));
  record.peakHeapDeltaMb = Number(((process.memoryUsage().heapUsed - heapBefore) / 1048576).toFixed(2));
  record.latency = Object.fromEntries(Object.entries(latencies).map(([k, perModel]) => [k, Object.fromEntries(Object.entries(perModel).map(([m, arr]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return [m, { n: sorted.length, p50: Number(percentile(sorted, 0.5).toFixed(2)), p95: Number(percentile(sorted, 0.95).toFixed(2)), p99: Number(percentile(sorted, 0.99).toFixed(2)) }];
  }))]));

  if (OUT_PATH) {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(record, null, 2));
    console.error(`[om-eval] 结果已写入 ${OUT_PATH}`);
  } else {
    console.log(JSON.stringify(record, null, 2));
  }
}

/** race 批次延迟已改为内联计时（measureRaceLatency 废弃）。 */
void measureRaceLatency;
function measureRaceLatency(model, state, playerId, golemId, horizon) {
  const t = performance.now();
  if (playerId === null) model.predictSurvivalFor(state, golemId, horizon, state.current);
  else model.predictClaimETA(state, playerId, golemId, horizon);
  return performance.now() - t;
}

/** M4 性能基准：2–5 人 × 四接口端到端延迟与内存。 */
async function perfBenchmark() {
  const out = {};
  for (const seatCount of SEAT_COUNTS) {
    // 生成中局状态（冠军驱动）。
    let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), OM_EVAL_BLOCK_BASE + 900_000 + seatCount, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
    game.players[0].isAI = true;
    let moves = 0;
    while (game.phase !== 'finished' && moves < 40) {
      const { action } = chooseAIAction(game);
      game = applyAction(game, action);
      moves++;
    }
    const state = buildPublicSimState(buildObservation(game, game.current));
    const model = createOpponentModel({ seed: 42, rollouts: 16, budgetMs: 2000, cacheSize: 0 });
    const stats = { action: [], intent: [], eta: [], survival: [] };
    const memBefore = process.memoryUsage().heapUsed;
    const reps = QUICK ? 2 : 5;
    for (let r = 0; r < reps; r++) {
      for (const gid of state.golemMarket) {
        let t = performance.now(); model.predictAction(state, state.current); stats.action.push(performance.now() - t);
        t = performance.now(); model.predictIntent(state, (state.current + 1) % seatCount); stats.intent.push(performance.now() - t);
        t = performance.now(); model.predictClaimETA(state, (state.current + 1) % seatCount, gid); stats.eta.push(performance.now() - t);
        t = performance.now(); model.predictSurvival(state, gid); stats.survival.push(performance.now() - t);
      }
    }
    const memAfter = process.memoryUsage().heapUsed;
    out[`n${seatCount}`] = {
      rollouts: 16,
      latencyMs: Object.fromEntries(Object.entries(stats).map(([k, arr]) => {
        const sorted = [...arr].sort((a, b) => a - b);
        return [k, { n: sorted.length, p50: Number(percentile(sorted, 0.5).toFixed(2)), p95: Number(percentile(sorted, 0.95).toFixed(2)), p99: Number(percentile(sorted, 0.99).toFixed(2)) }];
      })),
      heapDeltaMb: Number(((memAfter - memBefore) / 1048576).toFixed(2)),
    };
  }
  return out;
}

main().catch(err => { console.error(err); process.exit(1); });
