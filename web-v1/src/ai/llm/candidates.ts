/** LLM 候选行动生成（公开信息唯一输入）。
 *
 * 复用 `sim/legal.ts` 的权威合法行动枚举（与正式引擎逐条对齐），在其上做
 * 面向 LLM 上下文窗口的确定性裁剪：
 * - 认领 / 打出 / 休息 / 弃置全部保留；
 * - 获取商人卡的支付排列在超过上限时按公开状态派生种子确定性抽样
 *   （与 ai5/ppo/bridge/action_enum.mjs 同一设计原则，但此处不复制规则实现）；
 * - 裁剪事实（全量数/保留数/每类计数）随候选集记录，绝不伪称全量。
 *
 * 候选 ID 只由行动本身决定；同公开局面 ⇒ 同 ID 序列。隐藏牌库顺序不参与。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../../data.js';
import { count, tradeLimit, type Action, type Color } from '../../engine.js';
import { createSimulation } from '../../sim/session.js';
import { enumerateLegalActions } from '../../sim/legal.js';
import type { AIObservation } from '../observation.js';
import type { LLMActionCandidate, LLMActionKind, LLMCandidateSet } from './types.js';

const COLOR_NAMES = ['黄', '绿', '蓝', '粉'] as const;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/** 行动规范键：支付顺序与升级步序均保留（它们是引擎语义的一部分）。 */
export function actionKey(action: Action): string {
  switch (action.type) {
    case 'play':
      return stableStringify({
        type: 'play', cardId: action.cardId,
        ...(action.steps !== undefined ? { steps: action.steps } : {}),
        ...(action.repeats !== undefined ? { repeats: action.repeats } : {}),
      });
    case 'acquire':
      return stableStringify({ type: 'acquire', index: action.index, payment: action.payment });
    case 'claim':
      return stableStringify({ type: 'claim', index: action.index });
    case 'rest':
      return stableStringify({ type: 'rest' });
    case 'discard':
      return stableStringify({ type: 'discard', colors: action.colors });
  }
}

export function observationHash(view: AIObservation): string {
  return fnv1a(stableStringify(view)).toString(16).padStart(8, '0');
}

function stockText(stock: readonly number[]): string {
  const text = stock.map((n, i) => n > 0 ? `${COLOR_NAMES[i]}${n}` : '').filter(Boolean).join('、');
  return text || '无';
}

function paymentText(payment: readonly number[]): string {
  return payment.length ? payment.map(c => COLOR_NAMES[c]).join('→') : '免费';
}

function actionKind(action: Action): LLMActionKind {
  if (action.type === 'claim') return 'claim';
  if (action.type === 'acquire') return 'acquire';
  if (action.type === 'rest') return 'rest';
  if (action.type === 'discard') return 'discard';
  const card = MERCHANT_BY_ID[action.cardId];
  if (!card) throw new Error(`未知商人卡：${action.cardId}`);
  if (card.kind === 'create') return 'play-create';
  if (card.kind === 'upgrade') return 'play-upgrade';
  return 'play-trade';
}

function coinBonusText(view: AIObservation, index: number): string {
  if (index === 0 && view.copper > 0) return '铜币+3';
  if (index === 0 && view.copper === 0 && view.silver > 0) return '银币+1';
  if (index === 1 && view.copper > 0 && view.silver > 0) return '银币+1';
  return '无硬币';
}

function summarize(view: AIObservation, action: Action): string {
  switch (action.type) {
    case 'claim': {
      const id = view.golemMarket[action.index];
      const golem = GOLEM_BY_ID[id];
      return `认领市场第${action.index + 1}张 ${id}：${golem.points}分，费用 ${stockText(golem.cost)}，${coinBonusText(view, action.index)}`;
    }
    case 'acquire': {
      const offer = view.merchantMarket[action.index];
      const card = MERCHANT_BY_ID[offer.id];
      const effect = card.kind === 'create'
        ? `创造 ${stockText(card.output!)}`
        : card.kind === 'upgrade'
        ? `升级最多${card.steps}次`
        : `交易 ${stockText(card.input!)}→${stockText(card.output!)}`;
      return `获取市场第${action.index + 1}张 ${offer.id}（${effect}）：支付 ${paymentText(action.payment)}，回收卡上 ${stockText(offer.bonus)}，槽位成本${action.index}`;
    }
    case 'rest':
      return `休息：收回已打出的 ${view.players[view.current].played.length} 张商人卡，本回合结束`;
    case 'discard':
      return `弃置 ${action.colors.map(c => COLOR_NAMES[c]).join('、')}，然后结束回合`;
    case 'play': {
      const card = MERCHANT_BY_ID[action.cardId];
      if (card.kind === 'create') return `打出 ${action.cardId}（创造）：获得 ${stockText(card.output!)}`;
      if (card.kind === 'upgrade') {
        const steps = (action.steps ?? []).map(c => `${COLOR_NAMES[c]}→${COLOR_NAMES[c + 1]}`).join('、');
        return `打出 ${action.cardId}（升级 ${action.steps?.length ?? 0} 次）：${steps || '不升级'}`;
      }
      return `打出 ${action.cardId}（交易 ${action.repeats ?? 1} 次）：${stockText(card.input!)}→${stockText(card.output!)}`;
    }
  }
}

function emptyCounts(): Record<LLMActionKind, number> {
  return {
    claim: 0, 'play-create': 0, 'play-upgrade': 0, 'play-trade': 0,
    acquire: 0, rest: 0, discard: 0,
  };
}

/** 全量合法枚举 + 确定性裁剪。candidateLimit 至少 8。 */
export function buildCandidateSet(view: AIObservation, options: { candidateLimit?: number } = {}): LLMCandidateSet {
  const limit = Math.max(8, Math.floor(options.candidateLimit ?? 64));
  const hash = observationHash(view);
  if (view.phase === 'finished') {
    return {
      version: 'llm-candidates-v1', observationHash: hash, candidates: [],
      fullLegalCount: 0, keptCount: 0, pruned: false,
      fullCounts: emptyCounts(), keptCounts: emptyCounts(),
      paymentOrderPolicy: 'ordered-preserved-pruned-deterministic', notes: ['游戏已结束，无候选'],
    };
  }
  const sim = createSimulation(view, { simSeed: 0 });
  const legal = enumerateLegalActions(sim.view, { dedupe: true });
  const kinds = legal.map(actionKind);
  const fullCounts = emptyCounts();
  kinds.forEach(kind => { fullCounts[kind] += 1; });
  const fullLegalCount = legal.length;

  let keep = legal.map(() => true);
  let pruned = false;
  let notes: string[] = [];
  if (fullLegalCount > limit) {
    keep = kinds.map(kind => kind !== 'acquire');
    const acquireIndices = legal.flatMap((action, index) => action.type === 'acquire' ? [index] : []);
    const nonAcquireCount = keep.filter(Boolean).length;
    const budget = Math.max(0, limit - nonAcquireCount);
    if (budget > 0 && acquireIndices.length > 0) {
      const bySlot = new Map<number, number[]>();
      for (const index of acquireIndices) {
        const action = legal[index];
        if (action.type !== 'acquire') continue;
        const list = bySlot.get(action.index) ?? [];
        list.push(index);
        bySlot.set(action.index, list);
      }
      const weights = [...bySlot.entries()].map(([slot, list]) => ({ slot, list, weight: list.length }));
      const weightSum = weights.reduce((sum, x) => sum + x.weight, 0) || 1;
      for (const { slot, list, weight } of weights) {
        const slotBudget = Math.max(1, Math.floor((budget * weight) / weightSum));
        const canonical = [...list].sort((a, b) => actionKey(legal[a]).localeCompare(actionKey(legal[b])));
        const chosen = new Set<number>();
        chosen.add(canonical[0]);
        const rng = mulberry32(fnv1a(`${hash}:${slot}`));
        let guard = 0;
        while (chosen.size < Math.min(slotBudget, list.length) && guard < slotBudget * 20) {
          guard++;
          chosen.add(list[Math.floor(rng() * list.length)]);
        }
        for (const index of chosen) keep[index] = true;
      }
      pruned = true;
      notes.push(`合法行动 ${fullLegalCount} 个超过上限 ${limit}：非获取行动全保留，获取支付排列按公开状态确定性抽样 ${budget} 个`);
    } else {
      notes.push(`合法行动 ${fullLegalCount} 个超过上限 ${limit}：仅保留前 ${limit} 个非获取行动`);
      let remaining = limit;
      keep = keep.map((value, index) => {
        if (!value || remaining <= 0) return false;
        if (kinds[index] === 'acquire') return false;
        remaining--;
        return true;
      });
      pruned = true;
    }
  }

  const seenIds = new Map<string, number>();
  const candidates: LLMActionCandidate[] = [];
  const keptCounts = emptyCounts();
  legal.forEach((action, index) => {
    if (!keep[index]) return;
    const key = actionKey(action);
    const base = `a${fnv1a(key).toString(36).padStart(7, '0')}`;
    const duplicate = seenIds.get(base) ?? 0;
    seenIds.set(base, duplicate + 1);
    const id = duplicate === 0 ? base : `${base}-${duplicate + 1}`;
    const kind = kinds[index];
    keptCounts[kind] += 1;
    candidates.push({ id, action, kind, summary: summarize(view, action) });
  });

  if (candidates.length === 0) throw new Error('公开合法行动集为空，无法生成 LLM 候选');
  if (candidates.length > limit) {
    // 极端局面下的最后防线：保留前 limit 个，并如实记录。
    candidates.length = limit;
    notes.push(`候选最终截断到 ${limit} 个`);
  }
  return {
    version: 'llm-candidates-v1', observationHash: hash, candidates,
    fullLegalCount, keptCount: candidates.length, pruned,
    fullCounts, keptCounts,
    paymentOrderPolicy: 'ordered-preserved-pruned-deterministic',
    notes,
  };
}

export function candidateById(candidateSet: LLMCandidateSet, id: string): LLMActionCandidate | null {
  return candidateSet.candidates.find(c => c.id === id) ?? null;
}

/** 空候选集（仅用于记录/测试的失败路径）。 */
export function emptyCandidateSet(hash = ''): LLMCandidateSet {
  return {
    version: 'llm-candidates-v1', observationHash: hash, candidates: [],
    fullLegalCount: 0, keptCount: 0, pruned: false,
    fullCounts: emptyCounts(), keptCounts: emptyCounts(),
    paymentOrderPolicy: 'ordered-preserved-pruned-deterministic',
    notes: ['无候选（失败路径记录）'],
  };
}

export function actionSummary(view: AIObservation, action: Action): string {
  return summarize(view, action);
}

export function sameAction(a: Action, b: Action): boolean {
  return actionKey(a) === actionKey(b);
}

/** 仅用于诊断：候选集中是否存在某行动（支付顺序差异视为不同行动）。 */
export function containsAction(candidateSet: LLMCandidateSet, action: Action): boolean {
  const key = actionKey(action);
  return candidateSet.candidates.some(c => actionKey(c.action) === key);
}

/** 交易上限（导出给回退/测试使用；规则权威仍在 engine）。 */
export function tradeLimitFor(view: AIObservation, cardId: string): number {
  return tradeLimit(view.players[view.current].stock, cardId);
}

/** 当前商队水晶总数（公开）。 */
export function stockCount(view: AIObservation): number {
  return count(view.players[view.current].stock);
}

export type { Color };
