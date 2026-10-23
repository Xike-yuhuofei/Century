/** OpponentIntentModel：对手战略意图预测（AI6 第三阶段·任务 C）。
 *
 * 输出：
 * - P(target = GolemID | 公开状态, 公开历史)：对当前公开魔像的目标倾向分布；
 * - 不针对具体魔像的战略质量（noSpecificTarget：建引擎/资源准备/无明确目标）；
 * - 风格混合 StyleWeights（Rush/Engine/Coin/Contest/Balanced）：工程化的风格
 *   先验 + 公开行动历史的贝叶斯式（对数域证据累加）更新。
 *
 * 纪律约束（任务书 C）：
 * - 意图是不可直接观察的潜变量——输出必须是软概率 + 不确定性，
 *   严禁"库存接近 ⇒ 正在追逐"的硬判定（测试强制：高覆盖度 ⇒ p 上限约束）；
 * - 风格分类是初始工程假设，不宣称玩家真实心理类型；
 * - 历史为空（origin='empty'）或禁用历史（M0/M2）时回退纯先验。
 */

import { GOLEM_BY_ID } from '../data.js';
import type { PublicHistorySummary } from '../sim/index.js';
import {
  STYLE_PRIOR, coverageOf, engineAffinityOf, featurePack, gapOf,
  softmax, turnsToAfford, type FeaturePack,
} from './features.js';
import type {
  IntentDistribution, IntentEntry, PredictionContext, StyleEvidence, StyleKey, StyleWeights,
} from './types.js';
import { STYLE_KEYS } from './types.js';

/** 风格证据上界（对数域截断，防止单一证据淹没先验）。 */
const EVIDENCE_CLAMP = 2.2;

/** 从公开历史摘要提取单席位的风格证据（对数域贡献）。
 * 证据口径（全部为公开行为代理指标）：
 * - rush：首次认领早 + 认领节奏快 − 获取/建设占比高；
 * - engine：休息频率 + 获取频率 − 认领占比；
 * - coin：认领含硬币奖励（0/1 号位）占比；
 * - contest：获取频率 + "紧跟他人认领后的快速认领"（截胡代理指标）；
 * - balanced：不设证据（先验锚）。 */
export function styleEvidenceFromHistory(
  history: Readonly<PublicHistorySummary>,
  playerId: number,
): StyleEvidence {
  const evidence: StyleEvidence = { rush: 0, engine: 0, coin: 0, contest: 0, balanced: 0 };
  const agg = history.perPlayer[playerId];
  if (!agg || history.totalEvents === 0) return evidence;

  const turns = Math.max(1, agg.lastActionTurn);
  const claimsRate = agg.claims / turns;
  const acquireRate = agg.acquires / turns;
  const restRate = agg.rests / turns;

  // rush：早期认领（firstClaimTurn 越早证据越强）+ 高认领率。
  if (agg.firstClaimTurn !== null) {
    evidence.rush += 2.4 * Math.max(0, 1 - agg.firstClaimTurn / Math.max(6, history.toTurn ?? agg.firstClaimTurn));
  }
  evidence.rush += 1.2 * Math.min(1, claimsRate * 2);
  evidence.rush -= 0.7 * Math.min(1, acquireRate);

  // engine：休息与建设行为。
  evidence.engine += 1.8 * Math.min(1, restRate * 3);
  evidence.engine += 1.0 * Math.min(1, acquireRate);
  evidence.engine -= 1.2 * Math.min(1, claimsRate * 2);

  // coin：窗口内认领事件的硬币奖励占比。
  let claimsInWindow = 0;
  let coinClaims = 0;
  let snipes = 0;
  let lastOtherClaimTurn = -1;
  for (const e of history.window) {
    if (e.kind === 'claim') {
      if (e.actor === playerId) {
        claimsInWindow += 1;
        if (e.index <= 1 || e.coin !== null) coinClaims += 1;
        if (lastOtherClaimTurn >= 0 && e.turn - lastOtherClaimTurn <= 2) snipes += 1;
      } else {
        lastOtherClaimTurn = e.turn;
      }
    }
  }
  if (claimsInWindow > 0) evidence.coin += 1.6 * (coinClaims / claimsInWindow - 0.4);
  evidence.contest += 0.8 * Math.min(1, acquireRate) + 0.9 * Math.min(1, snipes * 0.7);

  for (const k of STYLE_KEYS) evidence[k] = Math.max(-EVIDENCE_CLAMP, Math.min(EVIDENCE_CLAMP, evidence[k]));
  return evidence;
}

/** 贝叶斯式风格权重：weights ∝ prior × exp(evidence)（对数域加法 + softmax）。 */
export function styleWeightsFromEvidence(evidence: StyleEvidence): StyleWeights {
  const logits = STYLE_KEYS.map(k => Math.log(STYLE_PRIOR[k]) + evidence[k]);
  const probs = softmax(logits, 1);
  const weights = {} as StyleWeights;
  STYLE_KEYS.forEach((k, i) => { weights[k] = probs[i]; });
  return weights;
}

/** 窗口事件与目标费用的匹配证据：玩家近期获取/打出中落入费用颜色的加权量 [0,1]。 */
function historyMatchOf(
  history: Readonly<PublicHistorySummary>,
  playerId: number,
  cost: readonly number[],
): number {
  let match = 0;
  for (const e of history.window) {
    if (e.actor !== playerId) continue;
    if (e.kind === 'acquire') {
      // 获取事件：随卡收回的奖励与费用的交集近似（卡的未来产出在下轮打出事件中体现）。
      match += e.bonusTaken.reduce((s, n, c) => s + Math.min(n, cost[c]) * (c + 1) * 0.4, 0);
    } else if (e.kind === 'play') {
      // 打出事件的库存增量与费用交集（产出朝费用方向 = 匹配）。
      const delta = e.stock.after.map((v, c) => v - e.stock.before[c]);
      match += delta.reduce((s, n, c) => s + Math.max(0, Math.min(n, cost[c])) * (c + 1) * 0.3, 0);
    }
  }
  return Math.min(1, match / 8);
}

/** 目标意图主入口（任务 C）。 */
export function predictIntent(
  ctx: PredictionContext,
  playerId: number,
  pack?: FeaturePack,
  style?: StyleWeights,
): IntentDistribution {
  const { state, history, config } = ctx;
  const fp = pack ?? featurePack(state);
  const feats = fp.byId.get(playerId);
  const notes: string[] = [];
  if (!feats) {
    return {
      playerId, golems: [], noSpecificTarget: 1,
      style: style ?? STYLE_PRIOR,
      styleEvidence: { rush: 0, engine: 0, coin: 0, contest: 0, balanced: 0 },
      uncertainty: 1, notes: ['席位特征缺失'],
    };
  }

  const evidence = config.useHistory && history.origin === 'recorded' && history.totalEvents > 0
    ? styleEvidenceFromHistory(history, playerId)
    : { rush: 0, engine: 0, coin: 0, contest: 0, balanced: 0 };
  const weights = config.useHistoryStyle ? styleWeightsFromEvidence(evidence) : { ...STYLE_PRIOR };
  if (history.origin === 'empty') notes.push('历史为空：风格为先验，目标为静态效用估计');

  const rivals = state.players.map(p => fp.byId.get(p.id)!).filter(p => p && p.id !== playerId);
  const contestedBy = (cost: readonly number[]) => {
    let covMax = 0;
    for (const r of rivals) covMax = Math.max(covMax, coverageOf(cost, r.reachable));
    return covMax;
  };

  const entries: (IntentEntry & { logit: number })[] = [];
  for (let index = 0; index < state.golemMarket.length; index++) {
    const golemId = state.golemMarket[index];
    const g = GOLEM_BY_ID[golemId];
    if (!g) continue;
    const coverage = coverageOf(g.cost, feats.reachable);
    const engineAffinity = engineAffinityOf(g.cost, feats);
    const gap = gapOf(g.cost, feats.reachable);
    const actionsNeeded = turnsToAfford(gap, feats.handProduction);
    const historyMatch = config.useHistory && history.origin === 'recorded'
      ? historyMatchOf(history, playerId, g.cost)
      : 0;
    const contested = contestedBy(g.cost);

    // 风格拟合（风格 → 目标类型的可解释映射）：
    // rush：高覆盖 + 快可达；engine：引擎契合；coin：前排（0/1 号位含硬币奖励）；
    // contest：竞争激烈且自身有竞争力时参与，落后时回避；balanced：微弱中性。
    const styleFit =
      1
      + weights.rush * (1.4 * (coverage - 0.5) + 0.7 / (1 + actionsNeeded))
      + weights.engine * (1.2 * engineAffinity - 0.4)
      + weights.coin * (index <= 1 && g.points <= 14 ? 0.7 : -0.2)
      + weights.contest * (1.0 * (contested - 0.35) * (coverage > 0.45 ? 1 : -0.6))
      + weights.balanced * 0.15;
    const utility =
      (0.55 + 0.03 * g.points)
      * Math.pow(coverage, 1.15)
      * (0.75 + 0.5 * engineAffinity)
      * (1 + 0.8 * historyMatch)
      * Math.max(0.15, styleFit)
      * (coverage > 0.999 ? 1.25 : 1);
    entries.push({
      golemId, p: 0, utility,
      explain: { coverage, engineAffinity, actionsNeeded, historyMatch, contested, styleFit },
      logit: utility,
    });
  }

  // 无具体目标质量：整体覆盖度低 / 无魔像时上升（意图为潜变量，保持软性）。
  const maxCoverage = entries.reduce((m, e) => Math.max(m, e.explain.coverage), 0);
  const maxUtility = entries.reduce((m, e) => Math.max(m, e.logit), -1e9);
  let noSpecificTarget = state.golemMarket.length === 0
    ? 1
    : 1 / (1 + Math.exp(4.2 * (maxUtility - 0.85)));
  if (maxCoverage < 0.2) noSpecificTarget = Math.max(noSpecificTarget, 0.45);
  noSpecificTarget = Math.min(0.95, Math.max(0.02, noSpecificTarget));

  const probs = softmax(entries.map(e => e.logit), 0.55);
  entries.forEach((e, i) => { e.p = probs[i]; });
  const pSum = entries.reduce((s, e) => s + e.p, 0);
  if (pSum > 0) {
    for (const e of entries) e.p = (e.p / pSum) * (1 - noSpecificTarget);
  }
  for (const e of entries) e.p = Math.max(1e-6, e.p);

  // 不确定性：目标分布归一化熵 + 数据量惩罚（意图为潜变量，诚实披露）。
  const K = entries.length + 1;
  let entropy = 0;
  const masses = [...entries.map(e => e.p), noSpecificTarget];
  const mSum = masses.reduce((s, v) => s + v, 0) || 1;
  for (const m of masses) {
    const p = m / mSum;
    if (p > 0) entropy -= p * Math.log(p);
  }
  const normEntropy = K > 1 ? entropy / Math.log(K) : 0;
  const dataFactor = Math.min(1, history.totalEvents / 16);
  const uncertainty = Math.min(1, 0.4 * normEntropy + 0.6 * (1 - dataFactor));

  if (maxCoverage >= 0.9) notes.push('高覆盖度不等于确定追逐：目标分布保持软概率（任务书 C 纪律）');
  return {
    playerId,
    golems: entries.map(({ logit: _logit, ...rest }) => rest),
    noSpecificTarget,
    style: weights,
    styleEvidence: evidence,
    uncertainty,
    notes,
  };
}
