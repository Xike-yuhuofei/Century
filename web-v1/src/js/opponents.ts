/** 联合搜索的对手行动策略（AI6 第四阶段·任务 B.2 + 任务 E）。
 *
 * 三种模式（任务 E：至少三种模式）：
 * - random：全量合法行动（等价去重后）均匀采样——信息公平的行为基线；
 * - rule：对手按自身进度效用贪心决策（ NEUTRAL 人格 + 冠军启发式候选集的
 *   轻量变体），softmax 温度采样保留多样性——每个对手只优化自己的局面，
 *   绝不实现"针对当前玩家的敌对联盟"（任务书 §任务 B 特别注意项）；
 * - om-v1：Opponent Model V1 predictAction 分布采样；模型内部按状态键 LRU
 *   缓存（任务 E.2），轨迹内重复状态不重复计费。
 *
 * 成本纪律（任务 E）：本模块绝不调用 predictClaimETA / predictSurvival
 * 的完整 Monte Carlo——ETA/Survival 只允许在根节点风险评估（planner.ts）
 * 与选择性预算分配中使用。轨迹内对手节点只消费轻量行动分布。
 */

import { type PublicSimState } from '../sim/state.js';
import { enumerateLegalActions } from '../sim/legal.js';
import type { Action } from '../engine.js';
import type { OpponentModel, ActionDistribution } from '../om/index.js';
import { mulberry32 } from '../sim/rng.js';
import { NEUTRAL_PROFILE } from '../ai/profiles.js';
import { CHAMPION_PARAMETERS, type AIParameters } from '../ai/parameters.js';
import { discardDecision, myRankedActions, heuristicContext } from './rollout-policy.js';
import type { JointOpponentMode } from './types.js';

/** 对手决策上下文。 */
export type OpponentContext = {
  mode: JointOpponentMode;
  om: OpponentModel | null;
  /** rule 模式 softmax 温度（缺省 0.6：接近贪心但保留行为方差）。 */
  temperature: number;
  params: AIParameters;
};

/** 创建对手上下文（参数固定为冻结冠军参数集——对手策略与候选 AI 共享同一
 * 启发式基线，保证消融对照只改变"对手行为来源"这一个因子）。
 * 温度 0.2：近确定性贪心而保留少量行为方差（τ=0.6→0.35→0.2 实测递减单轨迹
 * 叶值方差；CRN 配对下根行动间差异的信噪比随之上升）。 */
export function createOpponentContext(mode: JointOpponentMode, om: OpponentModel | null): OpponentContext {
  return { mode, om, temperature: 0.2, params: CHAMPION_PARAMETERS };
}

/** 对手溢出弃置：所有模式统一走冠军 trimStock 口径（强制行动，选择空间小，
 * 三模式分支无行为差异——在代码与报告中的显式口径声明）。 */
function opponentDiscard(state: PublicSimState): Action {
  const player = state.players[state.current];
  return { type: 'discard', colors: discardDecision(player.stock, state.golemMarket, CHAMPION_PARAMETERS) };
}

/** 规则对手的轻量候选集：在冠军候选生成之上做成本压缩——
 * acquire 每槽位只保留 keepValue 最优的 1 个支付（冠军口径 top-3），
 * 升级变体保留 ≤2 个。剪枝仅作用于对手轨迹内策略（非根行动可达性）。 */
function ruleOpponentRanked(state: PublicSimState, ctx: OpponentContext) {
  const actorCtx = heuristicContext(state, ctx.params, NEUTRAL_PROFILE);
  const ranked = myRankedActions(state, state.current, actorCtx).ranked;
  // 每个市场槽位只保留最优 acquire；其余类型全保留（认领/打牌/休息）。
  const seenSlots = new Set<number>();
  const out: { action: Action; value: number }[] = [];
  for (const entry of ranked) {
    if (entry.action.type === 'acquire') {
      if (seenSlots.has(entry.action.index)) continue;
      seenSlots.add(entry.action.index);
    }
    out.push(entry);
  }
  return out;
}

/** softmax 采样（logit 数组；确定性给定 rng）。 */
function softmaxSample(logits: number[], temperature: number, rng: () => number): number {
  const max = Math.max(...logits);
  const weights = logits.map(l => Math.exp((l - max) / Math.max(0.05, temperature)));
  const total = weights.reduce((s, w) => s + w, 0);
  let pick = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return i;
  }
  return weights.length - 1;
}

/** 从行动分布采样（分布条目携带 p；rng 确定性）。 */
function sampleDistribution(entries: { action: Action; p: number }[], rng: () => number): Action | null {
  let total = 0;
  for (const e of entries) total += e.p;
  if (!(total > 0)) return null;
  let pick = rng() * total;
  for (const e of entries) {
    pick -= e.p;
    if (pick <= 0) return e.action;
  }
  return entries[entries.length - 1]?.action ?? null;
}

/** 行动家族标签（轨迹解释用）。 */
export function familyOf(action: Action): string {
  if (action.type === 'play') {
    // 家族细分在解释中不重要，统一 play 前缀。
    return `play`;
  }
  return action.type;
}

/** 采样的对手行动 + 解释摘要（轨迹输出用）。 */
export type OpponentSample = { action: Action; family: string; label: string; p: number };

/** 对手行动生成主入口：在 state.current == actor 的合法节点调用。
 * 返回 null 表示无合法行动（理论不可达：rest 恒合法）——调用方回退 rest。 */
export function sampleOpponentAction(
  state: PublicSimState,
  rng: () => number,
  ctx: OpponentContext,
  omTimeAccountant?: (ms: number) => void,
): OpponentSample | null {
  if (state.phase === 'overflow') {
    const action = opponentDiscard(state);
    return { action, family: 'discard', label: '溢出弃置', p: 1 };
  }
  if (ctx.mode === 'om-v1' && ctx.om) {
    const t0 = performance.now();
    let dist: ActionDistribution | null = null;
    try {
      dist = ctx.om.predictAction(state, state.current);
    } catch {
      dist = null;
    }
    omTimeAccountant?.(performance.now() - t0);
    if (dist && dist.entries.length) {
      const action = sampleDistribution(dist.entries, rng);
      if (action) {
        const entry = dist.entries.find(e =>
          e.action.type === action.type &&
          (action.type === 'play' ? e.action.type === 'play' && e.action.cardId === action.cardId : true) &&
          (action.type === 'acquire' ? e.action.type === 'acquire' && e.action.index === action.index : true) &&
          (action.type === 'claim' ? e.action.type === 'claim' && e.action.index === action.index : true));
        return { action, family: familyOf(action), label: describe(action), p: entry?.p ?? 0 };
      }
    }
    // 分布为空（理论不可达）→ 回退规则模式。
  }
  if (ctx.mode === 'random') {
    const legal = enumerateLegalActions(state, { dedupe: true });
    if (!legal.length) return null;
    const action = legal[Math.floor(rng() * legal.length)];
    return { action, family: familyOf(action), label: describe(action), p: 1 / legal.length };
  }
  // rule 模式（及 om-v1 回退）：自身效用 softmax 采样。
  const ranked = ruleOpponentRanked(state, ctx);
  if (!ranked.length) return null;
  const index = softmaxSample(ranked.map(x => x.value), ctx.temperature, rng);
  const chosen = ranked[index];
  // p 近似：温度化概率（解释用，非严格归一）。
  const max = Math.max(...ranked.map(x => x.value));
  const weights = ranked.map(x => Math.exp((x.value - max) / ctx.temperature));
  const total = weights.reduce((s, w) => s + w, 0);
  return { action: chosen.action, family: familyOf(chosen.action), label: describe(chosen.action), p: weights[index] / total };
}

/** 行动的人类可读摘要（轨迹输出）。 */
export function describe(action: Action): string {
  switch (action.type) {
    case 'claim': return `claim@${action.index}`;
    case 'acquire': return `acquire@${action.index}`;
    case 'play': return `play:${action.cardId}${action.repeats ? `×${action.repeats}` : ''}`;
    case 'rest': return 'rest';
    case 'discard': return `discard×${action.colors.length}`;
  }
}
