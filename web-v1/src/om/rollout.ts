/** 竞争 rollout 引擎：ClaimETA 与 TargetSurvival 共享的按座位顺序推进的
 * 规则式随机模拟（AI6 第三阶段·任务 D/E）。
 *
 * 语义（严格区分两类时间）：
 * - "自身行动序数 k"：某玩家未来第 k 次自身行动（1 起始）——ETA 的时间轴；
 * - "观察席位决策点 τ"：观察席位未来第 k 次自身行动的时刻——Survival 的时间轴；
 * - 全部 rollout 从当前公开状态出发、按真实行动顺序（state.current 起轮转）
 *   推进，公共目标被唯一认领、其余玩家行为相互依赖——避免"独立概率相乘"。
 *
 * 公平性与可复现性：
 * - 模拟会话只从 PublicSimState 构造（stateToObservation 投影 + 历史摘要附加）；
 * - 未来翻牌来自信念采样（sim 模块 randomBeliefSampler），与真实隐藏牌序零关联；
 * - 每条 rollout 的种子由 (config.seed, 状态键, 目标魔像, rollout 序号) 确定性
 *   派生：相同公开状态 + 相同种子 ⇒ 逐位一致的预测。
 */

import {
  createSimulation, enumerateLegalActions, hashPublicState, mulberry32,
  type PublicHistorySummary, type PublicSimState,
} from '../sim/index.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../data.js';
import { VALUES } from '../ai/knowledge.js';
import { featurePack, stateToObservation, STYLE_PRIOR } from './features.js';
import { predictIntent } from './intent.js';
import { predictActionDistribution, sampleAction } from './policy.js';
import type { PredictionContext, StyleWeights } from './types.js';

/** 确定性种子混合（FNV-1a 32 位）。 */
export function mixSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const p of parts) feed(String(p));
  return h >>> 0;
}

/** 单条 rollout 记录：目标魔像的认领者（若有）与各席位每个自身行动时点的市场在场性。 */
export type RaceRolloutRecord = {
  /** 目标魔像被认领：[{playerId, k}]（恰一条；k = 认领者的自身行动序数）。 */
  claims: { playerId: number; k: number }[];
  /** presence[playerId][k-1] = 该玩家第 k 次自身行动前目标魔像是否仍在市场。 */
  presence: boolean[][];
  finished: boolean;
  steps: number;
};

export type RaceRolloutBatch = {
  records: RaceRolloutRecord[];
  /** 各席位风格与意图（root 一次计算，rollout 内静态近似——文档口径）。 */
  styles: Map<number, StyleWeights>;
};

const MAX_ROLLOUT_STEPS = 200;

/** 运行一批竞争 rollout（任务 D/E 共享）。 */
export function runRaceRollouts(
  state: Readonly<PublicSimState>,
  history: Readonly<PublicHistorySummary>,
  golemId: string,
  ctx: PredictionContext,
  count: number,
  deadline?: number,
): RaceRolloutBatch {
  const n = state.playerCount;
  // root 一次计算风格与意图（静态近似：rollout 内意图不随状态漂移重估）。
  const pack = featurePack(state);
  const styles = new Map<number, StyleWeights>();
  for (const p of state.players) {
    const intent = predictIntent({ state, history, config: ctx.config }, p.id, pack);
    styles.set(p.id, intent.style);
  }
  const stateKey = String(hashPublicState(state));
  const records: RaceRolloutRecord[] = [];

  for (let r = 0; r < count; r++) {
    if (deadline !== undefined && performance.now() > deadline) break;
    const simSeed = mixSeed('race', stateKey, golemId, ctx.config.seed, r);
    const sim = createSimulation(stateToObservation(state), { simSeed, historySummary: history });
    const presence: boolean[][] = Array.from({ length: n }, () => []);
    const claims: { playerId: number; k: number }[] = [];
    const own = new Array<number>(n).fill(0);
    const rng = mulberry32(simSeed ^ 0x9e3779b9);
    let steps = 0;
    let claimedBy = -1;

    while (!sim.finished && steps < MAX_ROLLOUT_STEPS) {
      const view = sim.view;
      const actor = view.current;
      // 记录该行动者本自身行动时点的目标在场性（决策点语义：行动前时刻）。
      presence[actor].push(view.golemMarket.includes(golemId));
      own[actor] += 1;
      const legal = enumerateLegalActions(view, { dedupe: true });
      if (!legal.length) break;
      const dist = predictActionDistribution({
        state: view,
        history: view.historySummary,
        temperature: ctx.config.temperature,
        style: styles.get(actor) ?? STYLE_PRIOR,
        pack: featurePack(view),
      });
      const picked = sampleAction(dist, rng());
      if (!picked) break;
      // 认领目标即记录并停止后续（同一魔像不可被二次认领）。
      if (picked.action.type === 'claim' && view.golemMarket[picked.action.index] === golemId) {
        claims.push({ playerId: actor, k: own[actor] });
        claimedBy = actor;
      }
      sim.step(picked.action);
      steps += 1;
      // 目标已被认领后：ETA 窗口已解决；Survival 需要的后续在场性恒为 false，
      // 继续模拟到各席位越过预测窗口即提前截断（性能保护，不改变语义）。
      if (claimedBy >= 0 && Math.min(...own) >= Math.max(ctx.config.horizon, ctx.config.etaHorizon)) break;
    }
    records.push({ claims, presence, finished: sim.finished, steps });
  }
  return { records, styles };
}

// === 最早规则可达时间（贪心直线规划；与概率分布严格分离） ===

const BEELINE_CAP = 8;

/** 贪心直线估计：目标玩家每自身行动都朝目标魔像推进（可认领立即认领），
 * 其余玩家按策略 Top-1 行动。返回达成认领所需的自身行动序数（1 起始）。
 * 这是一条合法可实现路径的长度估计（可达时间的诚实近似，非数学下界）；
 * 被抢/终局/超过 BEELINE_CAP 未达成时返回 null 并说明原因。 */
export function greedyBeelineEstimate(
  state: Readonly<PublicSimState>,
  history: Readonly<PublicHistorySummary>,
  playerId: number,
  golemId: string,
  ctx: PredictionContext,
): { k: number | null; blockedBy: 'stolen' | 'ended' | 'unreachable' | null } {
  if (!state.golemMarket.includes(golemId)) return { k: null, blockedBy: 'stolen' };
  if (state.phase === 'finished') return { k: null, blockedBy: 'ended' };
  const stateKey = String(hashPublicState(state));
  const simSeed = mixSeed('beeline', stateKey, golemId, ctx.config.seed);
  const sim = createSimulation(stateToObservation(state), { simSeed, historySummary: history });
  let own = 0;
  let steps = 0;

  while (!sim.finished && steps < MAX_ROLLOUT_STEPS) {
    const view = sim.view;
    const actor = view.current;
    if (!view.golemMarket.includes(golemId)) return { k: null, blockedBy: 'stolen' };
    const legal = enumerateLegalActions(view, { dedupe: true });
    if (!legal.length) break;
    let action = legal[0];
    if (actor === playerId) {
      own += 1;
      const claimNow = legal.find(a => a.type === 'claim' && view.golemMarket[a.index] === golemId);
      if (claimNow) return { k: own, blockedBy: null };
      if (own >= BEELINE_CAP) return { k: null, blockedBy: 'unreachable' };
      action = beelineAction(view, legal, playerId, golemId);
    } else {
      const pack = featurePack(view);
      const dist = predictActionDistribution({
        state: view, history: view.historySummary, temperature: ctx.config.temperature,
        style: STYLE_PRIOR, pack,
      });
      const best = dist.entries.reduce((b, e) => (e.p > b.p ? e : b), dist.entries[0] ?? null);
      if (!best) break;
      action = best.action;
    }
    sim.step(action);
    steps += 1;
  }
  return { k: null, blockedBy: sim.finished ? 'ended' : 'unreachable' };
}

/** 直线行动选择：使目标魔像费用覆盖度增长最大的合法行动（平局按族优先）。 */
function beelineAction(
  view: Readonly<PublicSimState>,
  legal: ReturnType<typeof enumerateLegalActions>,
  playerId: number,
  golemId: string,
): ReturnType<typeof enumerateLegalActions>[number] {
  const goal = GOLEM_BY_ID[golemId];
  if (!goal) return legal[0];
  const pack = featurePack(view);
  const feats = pack.byId.get(playerId)!;
  let best = legal[0];
  let bestGain = -1e9;
  const familyRank: Record<string, number> = { claim: 0, produce: 1, trade: 2, upgrade: 3, acquire: 4, rest: 5, discard: 6 };
  for (const a of legal) {
    if (a.type === 'discard') continue;
    // 一步后可达库存的确定性近似（打出/获取/休息的即时产出）。
    let gain = -1e9;
    if (a.type === 'rest') {
      const engineGain = feats.engineProduction.reduce((s, n, c) => s + Math.min(Math.max(0, goal.cost[c] - feats.stock[c]), Math.max(0, n)) * VALUES[c], 0);
      gain = feats.playedCount > 0 ? engineGain : -1e8;
    } else if (a.type === 'play') {
      const card = MERCHANT_BY_ID[a.cardId];
      if (!card) continue;
      const delta = card.kind === 'create'
        ? card.output!
        : card.kind === 'trade'
          ? tradeDelta(card.input!, card.output!, a.repeats ?? 1)
          : upgradeDelta(a.steps ?? []);
      gain = deltaGain(delta, goal.cost, feats.stock);
    } else if (a.type === 'acquire') {
      const slot = view.merchantMarket[a.index];
      const card = slot ? MERCHANT_BY_ID[slot.id] : null;
      if (!card) continue;
      const paymentCost = a.payment.length;
      const bonus = slot ? slot.bonus : [0, 0, 0, 0];
      const delta = [0, 1, 2, 3].map(c => (card.output?.[c] ?? 0) + (bonus[c] ?? 0));
      gain = deltaGain(delta, goal.cost, feats.stock) - paymentCost * 0.12;
    }
    gain -= (familyRank[a.type === 'play' ? familyOfPlay(a.cardId) : a.type] ?? 9) * 1e-6;
    if (gain > bestGain) { bestGain = gain; best = a; }
  }
  return best;
}

function familyOfPlay(cardId: string): string {
  const card = MERCHANT_BY_ID[cardId];
  if (card?.kind === 'create') return 'produce';
  if (card?.kind === 'upgrade') return 'upgrade';
  return 'trade';
}

function tradeDelta(input: readonly number[], output: readonly number[], repeats: number): number[] {
  return [0, 1, 2, 3].map(c => (output[c] - input[c]) * repeats);
}

function upgradeDelta(steps: readonly number[]): number[] {
  const delta = [0, 0, 0, 0];
  for (const s of steps) { delta[s] -= 1; delta[s + 1] += 1; }
  return delta;
}

function deltaGain(delta: readonly number[], cost: readonly number[], stock: readonly number[]): number {
  return delta.reduce((s, d, c) => s + Math.min(Math.max(0, cost[c] - stock[c]), Math.max(0, d)) * VALUES[c], 0);
}
