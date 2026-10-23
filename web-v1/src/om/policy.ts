/** OpponentPolicyV1：规则驱动的对手下一步行动预测（AI6 第三阶段·任务 B）。
 *
 * 输出 P(action | 公开状态, 公开历史, 对手席位)：
 * - 合法行动集合来自公共模拟器 enumerateLegalActions（与正式引擎逐条对齐）；
 * - 全部非法行动概率严格为零（不在输出列表中），合法行动概率总和为 1；
 * - 第一版 = 规则特征 + 轻量 softmax 概率模型，不训练任何网络；
 * - 允许借鉴 golemSurvivalModel / 商人竞争压力特征（经公开特征函数），
 *   但不把旧启发式公式当作已验证的真实概率——V1 的竞争时序来自
 *   座位顺序感知的覆盖度/威胁特征，而非旧公式。
 *
 * 行为族（任务书 B）：立即认领 / 打出创造 / 升级交易 / 获取商人卡 / 休息 /
 * 终局准备 / 规避被锁定目标（以"竞争紧迫度"进入认领与获取的打分）。
 *
 * 可解释性：每个行动携带 explain（主要特征贡献），风格混合与温度显式披露。
 */

import { enumerateLegalActions, type PublicHistorySummary, type PublicSimState } from '../sim/index.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../data.js';
import { VALUES, cardEngineValue } from '../ai/knowledge.js';
import type { Action } from '../engine.js';
import {
  featurePack, familyOf, gapOf, coverageOf, coinValueOf, softmax, safeNumber,
  contestedOf, type FeaturePack, type PlayerFeatures,
} from './features.js';
import type {
  ActionDistribution, ActionFamily, IntentDistribution, PredictionContext, ScoredAction, StyleWeights,
} from './types.js';

/** 策略输入：可预计算的特征与意图（rollout 内跨步复用，控制成本）。 */
export type PolicyInput = {
  state: Readonly<PublicSimState>;
  history: Readonly<PublicHistorySummary>;
  temperature: number;
  style: StyleWeights;
  /** 行动者对当前公开魔像的目标倾向（任务 C 产物；缺省 = 内部静态估计）。 */
  intent?: IntentDistribution;
  /** 预计算特征包（跨步复用）。 */
  pack?: FeaturePack;
};

const styleW = (style: StyleWeights, key: keyof StyleWeights): number =>
  Number.isFinite(style[key]) ? style[key] : 0;

/** 请求席位"若为当前行动者"的全部合法行动（非当前席位时克隆状态假设分支）。 */
function legalActionsFor(state: Readonly<PublicSimState>, playerId: number): { state: PublicSimState; actions: Action[] } {
  if (playerId === state.current) {
    return { state: state as PublicSimState, actions: enumerateLegalActions(state, { dedupe: true }) };
  }
  // 假设分支：克隆状态并把行动者切到目标席位（overflow 阶段仅溢出玩家有合法行动）。
  const hypothetical = structuredClone(state) as PublicSimState;
  hypothetical.current = playerId;
  if (hypothetical.phase === 'overflow') hypothetical.phase = 'turn';
  return { state: hypothetical, actions: enumerateLegalActions(hypothetical, { dedupe: true }) };
}

/** 玩家目标倾向的静态估计（未提供 intent 时的内部回退：覆盖度 × 引擎契合）。 */
function staticIntentTop(state: Readonly<PublicSimState>, feats: PlayerFeatures): { golemId: string | null; coverage: number } {
  let best: { golemId: string | null; coverage: number } = { golemId: null, coverage: 0 };
  for (const id of state.golemMarket) {
    const g = GOLEM_BY_ID[id];
    if (!g) continue;
    const coverage = coverageOf(g.cost, feats.reachable);
    if (coverage > best.coverage) best = { golemId: id, coverage };
  }
  return best;
}

/** 目标匹配增益：行动产出对首要目标的费用贡献 [0,1]（无目标时中性 0.5）。 */
function goalNeedOf(gain: readonly number[], top: { golemId: string | null }): number {
  const goal = top.golemId ? GOLEM_BY_ID[top.golemId] : null;
  if (!goal) return 0.5;
  const useful = goal.cost.reduce((s, n, c) => s + Math.min(n, Math.max(0, gain[c])) * VALUES[c], 0);
  const denom = goal.cost.reduce((s, n, c) => s + n * VALUES[c], 0);
  return denom > 0 ? 0.4 + 0.9 * Math.min(1, useful / denom) : 0.5;
}

/** 单个行动的规则特征得分。 */
export function scoreAction(
  action: Action,
  state: Readonly<PublicSimState>,
  actor: PlayerFeatures,
  pack: FeaturePack,
  style: StyleWeights,
  top: { golemId: string | null },
): { score: number; explain: string } {
  const family = familyOf(action);
  const engineW = styleW(style, 'engine');
  const rushW = styleW(style, 'rush');
  const contestW = styleW(style, 'contest');

  if (action.type === 'claim') {
    const g = GOLEM_BY_ID[state.golemMarket[action.index]];
    if (!g) return { score: -1e9, explain: '无效魔像' };
    const coin = coinValueOf(action.index, { copper: state.copper, silver: state.silver });
    const rivals = pack.state.players.map(p => pack.byId.get(p.id)!).filter(p => p && p.id !== actor.id);
    const contested = contestedOf(g.cost, rivals);
    // 竞争紧迫度：能先于我行动且覆盖度高的对手构成现实抢夺威胁。
    const ahead = pack.rivalsAhead(actor.id)
      .map(id => pack.byId.get(id)!)
      .filter(Boolean)
      .map(p => coverageOf(g.cost, p.reachable));
    const aheadThreat = ahead.length ? Math.max(...ahead) : 0;
    const base = (g.points + coin) / (1 + g.cost.reduce((s, n, c) => s + n * VALUES[c], 0) / 6);
    const urgency = contested * (0.7 + 1.1 * rushW) + aheadThreat * 0.8;
    const endgame = state.triggerPlayer !== null ? 1.35 + 0.15 * rushW : 1;
    const affordability = coverageOf(g.cost, actor.reachable) >= 0.999 ? 1.1 : 1;
    const score = base * (1 + urgency) * endgame * affordability;
    return { score, explain: `分值${g.points}+硬币${coin}｜费用效率${base.toFixed(2)}｜竞争度${contested.toFixed(2)}｜前位威胁${aheadThreat.toFixed(2)}` };
  }

  if (action.type === 'play') {
    const card = MERCHANT_BY_ID[action.cardId];
    if (!card) return { score: -1e9, explain: '未知商人卡' };
    if (card.kind === 'create') {
      const need = goalNeedOf(card.output!, top);
      const score = card.output!.reduce((s, n, c) => s + n * VALUES[c], 0) * 0.55 * (1 + 0.5 * engineW) * need;
      return { score, explain: `创造产出 ${card.output!.join('/')}｜目标增益${need.toFixed(2)}` };
    }
    if (card.kind === 'upgrade') {
      const steps = action.steps?.length ?? 0;
      // 升级价值：低色库存可转化的量 × 目标缺口中的高色需求。
      const lower = actor.stock[0] + actor.stock[1] + actor.stock[2];
      const goal = top.golemId ? GOLEM_BY_ID[top.golemId] : null;
      const highNeed = goal ? Math.min(1, (goal.cost[2] + goal.cost[3]) / 4 + 0.3) : 0.5;
      const score = steps * 0.5 * (1 + 0.6 * engineW) * Math.min(1, lower / Math.max(1, steps)) * (0.6 + 0.8 * highNeed);
      return { score, explain: `升级${steps}步｜低色库存${lower}｜高色需求${highNeed.toFixed(2)}` };
    }
    const repeats = action.repeats ?? 1;
    const gain = card.output!.reduce((s, n, c) => s + n * VALUES[c], 0)
      - card.input!.reduce((s, n, c) => s + n * VALUES[c], 0);
    const affordable = actor.stock.every((v, c) => v >= (card.input![c] ?? 0) * Math.min(1, repeats)) ? 1 : 0.6;
    const need = goalNeedOf(card.output!, top);
    const score = gain * repeats * 0.5 * (1 + 0.4 * engineW) * affordable * need;
    return { score, explain: `交易×${repeats} 净增${gain.toFixed(2)}｜目标增益${need.toFixed(2)}` };
  }

  if (action.type === 'acquire') {
    const slot = state.merchantMarket[action.index];
    if (!slot) return { score: -1e9, explain: '无效市场位置' };
    const card = MERCHANT_BY_ID[slot.id];
    if (!card) return { score: -1e9, explain: '未知商人卡' };
    const value = cardEngineValue(card, actor.stock, top.golemId ? GOLEM_BY_ID[top.golemId] : null);
    const burden = action.index * 0.16;
    // 竞争紧迫度：先于我行动的对手对该卡的契合压力。
    const ahead = pack.rivalsAhead(actor.id).map(id => pack.byId.get(id)!).filter(Boolean);
    let aheadAffinity = 0;
    for (const r of ahead) {
      const outputs = [...r.hand, ...r.played].reduce((tot, id) => {
        const c = MERCHANT_BY_ID[id];
        if (c?.output) c.output.forEach((n, i) => { tot[i] += n; });
        return tot;
      }, [0, 0, 0, 0] as number[]);
      const need = card.kind === 'trade'
        ? card.input!.reduce((v, n, i) => v + Math.min(n, r.stock[i] + outputs[i]) * VALUES[i], 0)
        : card.kind === 'create' ? card.output!.reduce((s, n, i) => s + n * VALUES[i], 0) / 10 : 0.5;
      aheadAffinity = Math.max(aheadAffinity, Math.min(1, need));
    }
    const urgency = aheadAffinity * (0.7 + 1.0 * contestW);
    const score = (value * 0.9 + urgency * 0.5) * (1 + 0.5 * engineW) - burden;
    return { score, explain: `卡价值${value.toFixed(2)}｜位置负担${burden.toFixed(2)}｜前位需求${aheadAffinity.toFixed(2)}` };
  }

  if (action.type === 'rest') {
    // 引擎再激活：已打出卡越富、手牌越空，休息价值越高。
    const reactivation = actor.playedCount >= 2
      ? actor.engineProduction.reduce((s, n, c) => s + n * VALUES[c], 0) / 6
      : 0;
    const emptyHand = actor.handCount === 0 && actor.playedCount > 0 ? 0.8 : 0;
    const waste = actor.playedCount === 0 ? -0.9 : 0;
    const score = (reactivation * (1 + 0.9 * engineW)) + emptyHand + waste;
    return { score, explain: `再激活${reactivation.toFixed(2)}｜已打出${actor.playedCount}｜手牌${actor.handCount}` };
  }

  // discard（overflow）：弃置损失最小化——弃最低价值色。
  const loss = action.colors.reduce((s: number, c) => s + VALUES[c], 0);
  return { score: -loss * 0.25, explain: `弃置损失 ${loss.toFixed(2)}` };
}

/** 生成行动分布（任务 B 主入口）。 */
export function predictActionDistribution(input: PolicyInput): ActionDistribution {
  const { state, history } = input;
  const actorId = state.current;
  const pack = input.pack ?? featurePack(state);
  const actor = pack.byId.get(actorId);
  const notes: string[] = [];
  if (!actor) {
    return { playerId: actorId, entries: [], temperature: input.temperature, style: input.style, notes: ['席位特征缺失'] };
  }
  let top: { golemId: string | null };
  if (input.intent && input.intent.golems.length) {
    let best = input.intent.golems[0];
    for (const e of input.intent.golems) if (e.p > best.p) best = e;
    top = { golemId: best.golemId };
  } else {
    top = staticIntentTop(state, actor);
  }
  const { actions } = legalActionsFor(state, actorId);
  if (!actions.length) {
    notes.push('目标席位当前无合法行动（overflow 归属其他席位或终局）');
    return { playerId: actorId, entries: [], temperature: input.temperature, style: input.style, notes };
  }
  const scored: ScoredAction[] = actions.map(action => {
    const { score, explain } = scoreAction(action, state, actor, pack, input.style, top);
    return { action, family: familyOf(action), score: safeNumber(score, -1e9), p: 0, explain };
  });
  const probs = softmax(scored.map(s => s.score), input.temperature);
  const eps = 1e-6;
  let sum = 0;
  for (let i = 0; i < scored.length; i++) {
    scored[i].p = Math.max(eps, probs[i]);
    sum += scored[i].p;
  }
  for (const s of scored) s.p /= sum; // 数值防线：精确归一
  if (history.origin === 'empty') notes.push('历史摘要为空（中途接入/未记录）：策略不使用历史特征');
  return { playerId: actorId, entries: scored, temperature: input.temperature, style: input.style, notes };
}

/** 按分布采样一个行动（rng ∈ [0,1)）。分布为空返回 null。 */
export function sampleAction(dist: ActionDistribution, rng: number): ScoredAction | null {
  if (!dist.entries.length) return null;
  let acc = 0;
  const target = rng * dist.entries.reduce((s, e) => s + e.p, 0);
  for (const e of dist.entries) {
    acc += e.p;
    if (target <= acc) return e;
  }
  return dist.entries[dist.entries.length - 1];
}

/** 按分布取 Top-1。 */
export function topAction(dist: ActionDistribution): ScoredAction | null {
  if (!dist.entries.length) return null;
  return dist.entries.reduce((b, e) => (e.p > b.p ? e : b), dist.entries[0]);
}

/** 面向 rollout 的轻量策略门面（每步只做打分 + 采样；意图/特征外部预计算）。 */
export function policySampleAction(
  state: Readonly<PublicSimState>,
  history: Readonly<PublicHistorySummary>,
  styles: Map<number, StyleWeights>,
  intents: Map<number, IntentDistribution>,
  pack: FeaturePack,
  temperature: number,
  rng: number,
): { action: Action; family: ActionFamily } | null {
  const dist = predictActionDistribution({
    state, history, temperature,
    style: styles.get(state.current) ?? { rush: 0, engine: 0, coin: 0, contest: 0, balanced: 1 },
    intent: intents.get(state.current),
    pack,
  });
  const picked = sampleAction(dist, rng);
  return picked ? { action: picked.action, family: picked.family } : null;
}

export type { PredictionContext };
