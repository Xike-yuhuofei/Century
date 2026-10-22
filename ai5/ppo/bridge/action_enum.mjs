/** AI 5.0 合法行动枚举（任务书第六节·动态合法行动集合）。
 *
 * 结构性信息公平保证：
 * - 本模块唯一输入是 AIObservation（buildObservation 产物，仅公开信息）与公开卡表，
 *   函数签名上不存在完整 Game，隐藏牌库顺序在结构上不可达。
 * - 枚举出的每个候选都是引擎 applyAction 会接受的合法行动
 *   （tests/node/enum-legality.test.mjs 在随机对局上逐候选拟真验证）。
 *
 * 与 AI 4.0 planner 的关键差异（任务书明确要求）：
 * - 支付顺序：engine.applyAcquire 按 payment[i] 给第 i 个市场槽位加奖励水晶，
 *   不同顺序产生不同后继状态，因此同色组合的不同排列是不同候选，不得折叠。
 *   （AI 4.0 的 payments() 只取升序一种排列，属于其搜索近似。）
 * - 触发终局后获取商人卡：引擎允许，本枚举保留（AI 4.0 规划器在终局触发后
 *   关闭 acquire 分支，属于其搜索剪枝）。
 * - 休息：引擎恒合法（含空操作的 no-op rest）；空操作 rest 严格劣于任何其他行动
 *   （同样结束回合且一无所获），仅在无其他合法行动时保留，避免候选集被无信息行动淹没。
 *
 * 组合复杂度控制（任务书第六节）：
 * - 枚举全量后若超过 maxCandidates（默认 512），对 acquire 支付序列做确定性分层剪枝：
 *   非_acquire 候选全部保留；每个槽位保留升序规范支付 + 由状态键派生种子的确定性抽样。
 *   剪枝事实与覆盖率（fullCount/keptCount）随决策消息上报，绝不伪称为全量合法集合。
 */

import { has, tradeLimit } from '../../../web-v1/dist/js/engine.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../../../web-v1/dist/js/data.js';

const clone = (s) => [...s];
const total = (s) => s.reduce((a, b) => a + b, 0);

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/** 公开状态键：决定剪枝抽样种子（同一公开局面必然同一候选集合与顺序）。 */
export function publicStateKey(view) {
  return [
    view.players.map(p => `${p.stock.join(',')}|${[...p.hand].sort().join(',')}|${[...p.played].sort().join(',')}|${[...p.claimed].sort().join(',')}|${p.copper},${p.silver},${p.turns}`).join(';'),
    view.merchantMarket.map(m => `${m.id}:${m.bonus.join(',')}`).join(';'),
    view.golemMarket.join(';'),
    view.current, view.copper, view.silver, view.phase, view.triggerPlayer, view.turnNumber,
  ].join('||');
}

/** 升级卡变体：按"后继水晶库存"去重（同一后继库存的行动等价，保留最短步序）。
 * 与 AI 4.0 planner.upgradeVariants 同构；DFS 确定性（颜色升序）。 */
export function upgradeVariants(stock, maxSteps) {
  const variants = new Map();
  const search = (s, steps) => {
    if (steps.length) {
      const key = s.join(',');
      const prev = variants.get(key);
      if (!prev || prev.length > steps.length) variants.set(key, steps);
    }
    if (steps.length === maxSteps) return;
    for (let c = 0; c < 3; c++) {
      if (!s[c]) continue;
      const next = clone(s);
      next[c]--; next[c + 1]++;
      search(next, [...steps, c]);
    }
  };
  search(clone(stock), []);
  return [...variants.values()];
}

/** 单个市场槽位的全部合法支付序列（有序、去重）。
 * 位置 index 需要支付 index 颗水晶；不同顺序给上方槽位留下不同奖励分布。 */
export function paymentSequences(stock, index) {
  if (index === 0) return [[]];
  if (total(stock) < index) return [];
  const result = [];
  const walk = (pos, remaining, seq, avail) => {
    if (pos === index) { result.push(seq); return; }
    for (let c = 0; c < 4; c++) {
      if (!avail[c]) continue;
      const next = clone(avail);
      next[c]--;
      walk(pos + 1, remaining - 1, [...seq, c], next);
    }
  };
  walk(0, index, [], clone(stock));
  return result;
}

/** 从公开观察枚举当前行动者的全部合法行动候选（描述符形式）。
 * 返回 { candidates, stats }；candidates 顺序确定性（同观察必同序列）。 */
export function enumerateCandidates(view, options = {}) {
  const maxCandidates = options.maxCandidates ?? 512;
  const me = view.players[view.current];
  const stock = me.stock;
  const candidates = [];

  if (view.phase === 'overflow') {
    const excess = total(stock) - 10;
    if (excess > 0) {
      // 弃置：引擎逐色扣减，顺序不影响结果 → 按颜色多重集去重（升序枚举）。
      const walk = (color, left, counts) => {
        if (color === 4) {
          if (left === 0) candidates.push(['D', [...counts]]);
          return;
        }
        for (let n = 0; n <= Math.min(stock[color], left); n++) {
          const next = [...counts];
          next[color] = n;
          walk(color + 1, left - n, next);
        }
      };
      walk(0, excess, [0, 0, 0, 0]);
    }
    return { candidates, stats: { fullCount: candidates.length, keptCount: candidates.length, pruned: false, fullCounts: { discard: candidates.length } } };
  }

  // —— 认领魔像 ——
  let claimCount = 0;
  view.golemMarket.forEach((id, index) => {
    if (has(stock, GOLEM_BY_ID[id].cost)) {
      candidates.push(['C', index]);
      claimCount++;
    }
  });

  // —— 打出商人卡（手牌按 id 去重：同 id 多张的行动完全等价） ——
  const seenIds = new Set();
  let createCount = 0, upgradeCount = 0, tradeCount = 0;
  for (const id of me.hand) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const card = MERCHANT_BY_ID[id];
    if (!card) continue;
    if (card.kind === 'create') {
      candidates.push(['P', id]);
      createCount++;
    } else if (card.kind === 'upgrade') {
      for (const steps of upgradeVariants(stock, card.steps)) {
        candidates.push(['U', id, steps]);
        upgradeCount++;
      }
    } else {
      const limit = tradeLimit(stock, id);
      for (let repeats = 1; repeats <= limit; repeats++) {
        candidates.push(['T', id, repeats]);
        tradeCount++;
      }
    }
  }

  // —— 休息（已打出卡可收回时；否则仅当无其他行动时兜底） ——
  let restCount = 0;
  if (me.played.length > 0) {
    candidates.push(['R']);
    restCount++;
  }

  // —— 获取商人卡：全部有序支付序列（终局触发后引擎仍允许 acquire，保留） ——
  const acquireBySlot = [];
  let acquireCount = 0;
  view.merchantMarket.forEach((offer, index) => {
    const seqs = paymentSequences(stock, index);
    acquireBySlot.push(seqs);
    acquireCount += seqs.length;
  });

  const fullCount = candidates.length + acquireCount;
  const fullCounts = { claim: claimCount, create: createCount, upgrade: upgradeCount, trade: tradeCount, rest: restCount, acquire: acquireCount };

  if (fullCount <= maxCandidates) {
    for (let index = 0; index < acquireBySlot.length; index++) {
      for (const payment of acquireBySlot[index]) candidates.push(['A', index, payment]);
    }
    return { candidates, stats: { fullCount, keptCount: candidates.length, pruned: false, fullCounts } };
  }

  // —— 确定性分层剪枝（仅裁 acquire 支付排列；其余候选全保留） ——
  const rng = mulberry32(fnv1a(publicStateKey(view)));
  const nonAcquireKept = candidates.length;
  const budget = Math.max(0, maxCandidates - nonAcquireKept);
  const weights = acquireBySlot.map(seqs => seqs.length);
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  let keptAcquire = 0;
  const keptCounts = [];
  for (let index = 0; index < acquireBySlot.length; index++) {
    const seqs = acquireBySlot[index];
    if (!seqs.length) { keptCounts.push(0); continue; }
    const slotBudget = Math.max(1, Math.floor(budget * weights[index] / weightSum));
    const canonical = [...seqs].map(p => p.join('')).sort();
    const chosen = new Set();
    // 1) 升序规范支付（与 AI 4.0 的唯一排列对齐，保证与基线可比）。
    chosen.add(canonical[0]);
    // 2) 确定性均匀抽样补充。
    let guard = 0;
    while (chosen.size < Math.min(slotBudget, seqs.length) && guard < slotBudget * 20) {
      guard++;
      const pick = seqs[Math.floor(rng() * seqs.length)];
      chosen.add(pick.join(''));
    }
    for (const key of chosen) candidates.push(['A', index, key.split('').map(Number)]);
    keptAcquire += chosen.size;
    keptCounts.push(chosen.size);
  }
  // 兜底：极端情况下（非 acquire 候选已超上限）截断并如实上报。
  if (candidates.length > maxCandidates) candidates.length = maxCandidates;
  return {
    candidates,
    stats: {
      fullCount, keptCount: candidates.length, pruned: true, fullCounts,
      prunedKeep: { acquire: keptAcquire, perSlot: keptCounts },
    },
  };
}

/** 弃置描述符 → Action（counts → 升序颜色序列，引擎逐色扣减语义等价）。 */
export function discardDescriptorToAction(descriptor) {
  const colors = [];
  descriptor[1].forEach((n, c) => { for (let i = 0; i < n; i++) colors.push(c); });
  return { type: 'discard', colors };
}

/** 描述符 → 正式引擎 Action（唯一出口；行动最终由引擎验证）。 */
export function descriptorToEngineAction(descriptor) {
  const [type, a, b] = descriptor;
  switch (type) {
    case 'P': return { type: 'play', cardId: a };
    case 'U': return { type: 'play', cardId: a, steps: b };
    case 'T': return { type: 'play', cardId: a, repeats: b };
    case 'A': return { type: 'acquire', index: a, payment: b };
    case 'C': return { type: 'claim', index: a };
    case 'R': return { type: 'rest' };
    case 'D': return discardDescriptorToAction(descriptor);
    default: throw new Error(`未知候选描述符：${JSON.stringify(descriptor)}`);
  }
}
