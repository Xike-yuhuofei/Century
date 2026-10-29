/** AI 9.0 确定性模块变异（受控、可复现，仅作为 OpenEvolve 不可用时的降级路径）。
 *
 * 纪律：
 * - 每个变异都是单点文本替换，替换点唯一；找不到/多处出现立即抛错，
 *   绝不"尽力猜测"地改写官方函数；
 * - 变异后的函数必须仍通过 static_check_modules 与 tsc（由调用方编译验证）；
 * - 来源显式标记 deterministic-template，绝不冒充 openevolve-llm；
 * - 变异只改变 AI 决策算法，不改变规则/裁判/信息边界。
 */

import {
  officialFunctionText, moduleRegistry, stripLiterals, extractFunction, functionParams,
} from '../../ai5/openevolve/node/module_registry.mjs';
import { assertCondition } from './core.mjs';

/** 单点替换（唯一命中）。 */
function replaceOnce(text, needle, replacement, label) {
  const count = text.split(needle).length - 1;
  assertCondition(count === 1, `${label} 变异点不唯一（期望 1，实际 ${count}）——官方函数结构变更，拒绝静默变异`);
  return text.replace(needle, replacement);
}

export const MODULE_MUTATIONS = Object.freeze({
  M01: Object.freeze([
    {
      label: 'goal-points-efficiency',
      apply: text => replaceOnce(text,
        '  // 缺省：目标优先级完全由既有路线评分决定。\n  return 1;',
        '  // 变异：按公开魔像分值做温和目标优先级（0.5–2.0）。\n  const goal = GOLEM_BY_ID[goalId];\n  return goal ? Math.min(2, Math.max(0.5, goal.points / 8)) : 1;',
        'M01'),
    },
  ]),
  M02: Object.freeze([
    {
      label: 'readiness-acquisition-gain',
      apply: text => replaceOnce(text,
        'return withV2(acquisitionValueReadinessEfficiency(state, cardId, preferred, profile, pressure, params));',
        'return withV2(acquisitionValueReadinessEfficiency(state, cardId, preferred, profile, pressure, params) * 1.04);',
        'M02'),
    },
  ]),
  M03: Object.freeze([
    {
      label: 'create-output-weight',
      apply: text => replaceOnce(text,
        'return weighted(card.output!) * .32 + useful * .22;',
        'return weighted(card.output!) * .42 + useful * .22;',
        'M03'),
    },
  ]),
  M04: Object.freeze([
    {
      label: 'coverage-retention-weight',
      apply: text => replaceOnce(text,
        'return coverage * 3 + stockPotential(stock, goals) * 1.2 + weighted(stock) * .16 * params.capacityWeight;',
        'return coverage * 2.6 + stockPotential(stock, goals) * 1.2 + weighted(stock) * .16 * params.capacityWeight;',
        'M04'),
    },
  ]),
  M05: Object.freeze([
    {
      label: 'rest-recycle-bias',
      apply: text => replaceOnce(text,
        '  // 缺省：休息成本完全由 params.restWeight 与既有步数惩罚决定。\n  return 1;',
        '  // 变异：有已打出卡牌时轻微降低休息惩罚（回收循环倾向）。\n  return Math.min(2, 1 + (state.played.length > 0 ? 0.15 : 0));',
        'M05'),
    },
  ]),
  M06: Object.freeze([
    {
      label: 'public-standings-win-probability',
      apply: text => replaceOnce(text,
        '  // 缺省：终局路线只按正式得分与既有效率公式评价。\n  return 0;',
        `  // 变异：公开名次胜率模型——用公开分数与本路线预计得分估计第一名概率。
  const selfFinal = state.baseScore - state.baseStockPoints + state.gained
    + state.stock.slice(1).reduce((sum, n) => sum + n, 0);
  const rivals = state.standings.filter(s => s.seat !== state.seat);
  if (!rivals.length) return 0;
  let bestProjected = -Infinity;
  for (const rival of rivals) {
    const remaining = Math.max(0, state.claimThreshold - rival.claimed);
    const pace = rival.claimed > 0 ? rival.score / rival.claimed : 6;
    bestProjected = Math.max(bestProjected, rival.score + remaining * pace);
  }
  const margin = selfFinal - bestProjected;
  const winProbability = 1 / (1 + Math.exp(-margin / 8));
  return Math.max(-8, Math.min(8, (winProbability - 0.5) * 16));`,
        'M06'),
    },
    {
      label: 'long-route-terminal-bonus',
      apply: text => replaceOnce(text,
        '  // 缺省：终局路线只按正式得分与既有效率公式评价。\n  return 0;',
        '  // 变异：长路线到达终局获得少量确定性加分。\n  return state.terminal && state.steps > 8 ? 1 : 0;',
        'M06'),
    },
  ]),
  M07: Object.freeze([
    {
      label: 'public-goal-inference',
      apply: text => replaceOnce(text,
        '  // 缺省：对手压力完全由公开库存/引擎推导的 contestPressure / peakPressure 决定。\n  return 0;',
        `  // 变异：从公开库存/市场/手牌推断对手最可能目标，再估计该卡的边际需求。
  const opponents = view.players.filter(p => p.id !== view.playerId);
  const card = MERCHANT_BY_ID[cardId];
  if (!opponents.length || !card || !card.output) return 0;
  const deltas = [];
  for (const opponent of opponents) {
    let bestGap = Infinity;
    let bestNeed = [0, 0, 0, 0];
    let urgency = 1;
    for (const goalId of view.golemMarket) {
      const goal = GOLEM_BY_ID[goalId];
      if (!goal) continue;
      let gap = 0;
      const need = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        need[c] = Math.max(0, goal.cost[c] - opponent.stock[c]);
        gap += need[c];
      }
      if (gap < bestGap) {
        bestGap = gap;
        bestNeed = need;
        urgency = has(opponent.stock, goal.cost) ? 1.5 : 1;
      }
    }
    if (!Number.isFinite(bestGap)) continue;
    let help = 0;
    let overlap = 0;
    for (let c = 0; c < 4; c++) help += Math.min(card.output[c], bestNeed[c]);
    for (const id of [...opponent.hand, ...opponent.played]) {
      const other = MERCHANT_BY_ID[id];
      if (!other || !other.output) continue;
      for (let c = 0; c < 4; c++) overlap += Math.min(other.output[c], bestNeed[c]);
    }
    deltas.push(Math.max(0, help - overlap * 0.5) / 4 * urgency);
  }
  if (!deltas.length) return 0;
  const mean = deltas.reduce((sum, x) => sum + x, 0) / deltas.length;
  return dimension === 'peak' ? Math.max(...deltas) * 0.6 : mean * 0.4;`,
        'M07'),
    },
    {
      label: 'peak-pressure-tilt',
      apply: text => replaceOnce(text,
        '  // 缺省：对手压力完全由公开库存/引擎推导的 contestPressure / peakPressure 决定。\n  return 0;',
        '  // 变异：峰值需求轻微上调、平均需求轻微下调（关键卡竞争倾向）。\n  return dimension === \'peak\' ? 0.03 : -0.01;',
        'M07'),
    },
  ]),
  M08: Object.freeze([
    {
      label: 'goal-value-contest-tilt',
      apply: text => replaceOnce(text,
        '  // 缺省：竞争时序完全由 golemSurvivalModel 的座位感知模型决定。\n  return 1;',
        '  // 变异：高价值目标的竞争存活乘子轻微上调。\n  const goal = GOLEM_BY_ID[goalId];\n  return goal ? Math.min(1.5, 1 + goal.points / 100) : 1;',
        'M08'),
    },
  ]),
  M09: Object.freeze([
    {
      label: 'posterior-expected-support',
      apply: text => replaceOnce(text,
        '  // 缺省：未知牌只按卡牌全集均值为目标提供期望支持。\n  return 1;',
        `  // 变异：在未翻开商人卡全集上做公开后验期望——按目标缺口颜色计算边际支持，
  // 交易卡额外按净转换效率加权；不知道任何未翻开卡的具体位置。
  const me = view.players[view.playerId];
  const goal = preferred ? GOLEM_BY_ID[preferred] : null;
  if (!goal || !unseenMerchants.length) return 1;
  const need = [0, 0, 0, 0];
  let totalNeed = 0;
  for (let c = 0; c < 4; c++) {
    need[c] = Math.max(0, goal.cost[c] - me.stock[c]);
    totalNeed += need[c];
  }
  if (totalNeed === 0) return 1;
  let expected = 0;
  for (const id of unseenMerchants) {
    const card = MERCHANT_BY_ID[id];
    if (!card || !card.output) continue;
    let direct = 0;
    for (let c = 0; c < 4; c++) direct += Math.min(card.output[c], need[c]);
    let efficiency = 1;
    if (card.kind === 'trade' && card.input) {
      let cost = 0;
      for (let c = 0; c < 4; c++) cost += card.input[c];
      efficiency = Math.max(0.5, Math.min(2, 1 + (card.output.reduce((sum, n) => sum + n, 0) - cost) / 4));
    }
    expected += direct * efficiency;
  }
  const meanSupport = expected / unseenMerchants.length;
  const baseline = Math.max(1, totalNeed * 1.5);
  return Math.max(0, Math.min(3, (meanSupport / baseline) * 1.5 + 0.5));`,
        'M09'),
    },
    {
      label: 'unseen-supply-tilt',
      apply: text => replaceOnce(text,
        '  // 缺省：未知牌只按卡牌全集均值为目标提供期望支持。\n  return 1;',
        '  // 变异：未翻开卡池越大，未来支持度轻微上调。\n  return Math.min(2, 1 + unseenMerchants.length / 100);',
        'M09'),
    },
  ]),
  M10: Object.freeze([
    {
      label: 'claim-first-ranking',
      apply: text => replaceOnce(text,
        '  // 缺省：根行动顺序由规则枚举与既有根筛选先验决定。\n  return actions;',
        '  // 变异：合法认领行动优先排序（规则引擎仍最终复核）。\n  return [...actions].sort((a, b) => (a.type === \'claim\' ? 0 : 1) - (b.type === \'claim\' ? 0 : 1));',
        'M10'),
    },
    {
      label: 'root-prune-preserve-claims',
      apply: text => replaceOnce(text,
        '  // 缺省：根行动顺序由规则枚举与既有根筛选先验决定。\n  return actions;',
        '  // 变异：保留全部认领，非认领根行动最多展开 6 个（搜索剪枝结构；最终行动仍由规则复核）。\n  const claims = actions.filter(a => a.type === \'claim\');\n  const others = actions.filter(a => a.type !== \'claim\');\n  return [...claims, ...others.slice(0, 6)];',
        'M10'),
    },
  ]),
  M11: Object.freeze([
    {
      label: 'wider-candidates-lower-margin',
      apply: text => replaceOnce(text,
        '  // 缺省：联合搜索结构完全由版本注册表与调用方选项决定。\n  return {};',
        '  // 变异：扩大联合评估候选上限并降低保守覆盖边际（受 adapter 白名单裁剪）。\n  return { candidateCap: 5, overrideMargin: 0.01 };',
        'M11'),
    },
    {
      label: 'contest-structure-switch',
      apply: text => replaceOnce(text,
        '  // 缺省：联合搜索结构完全由版本注册表与调用方选项决定。\n  return {};',
        '  // 变异：把束搜索结构切换为座位感知的 beam-contest（受 adapter 白名单裁剪）。\n  return { championStructure: \'beam-contest\' };',
        'M11'),
    },
  ]),
  M12: Object.freeze([
    {
      label: 'budget-scale-1.5',
      apply: text => replaceOnce(text,
        '  // 缺省：预算完全由冠军参数 budgetMs 决定。\n  return baseMs;',
        '  // 变异：决策预算放大 1.5 倍（adapter 裁剪到 1–10000ms）。\n  return Math.round(baseMs * 1.5);',
        'M12'),
    },
  ]),
});

export function mutationLabels(moduleId) {
  const list = MODULE_MUTATIONS[moduleId];
  assertCondition(list, `模块没有确定性变异：${moduleId}`);
  return list.map(m => m.label);
}

/** 读取官方模块函数并应用指定变异（variant = 0 为缺省）。 */
export function mutateModuleFunction(moduleId, variant = 0) {
  const registry = moduleRegistry();
  const module = registry.modules.find(m => m.id === moduleId);
  assertCondition(module, `未注册模块：${moduleId}`);
  const list = MODULE_MUTATIONS[moduleId];
  assertCondition(list && list.length > 0, `模块没有确定性变异：${moduleId}`);
  const index = Number.isInteger(variant) ? ((variant % list.length) + list.length) % list.length : 0;
  const mutation = list[index];
  return {
    id: moduleId,
    label: mutation.label,
    text: mutation.apply(officialFunctionText(module)),
  };
}

/**
 * 在**父代真实源码**上应用变异（跨代继承的唯一变异入口）。
 *
 * 两类算子：
 * 1. curated：注册表内的人工审核变异；只有当父代文本仍唯一包含该变异锚点时可用
 *    （典型情况：父代尚未在该处被改写过）；
 * 2. generic-numeric / comparison：父代已偏离官方锚点时的确定性回退算子，
 *    在父代文本内定位唯一的数值字面量或比较运算符做小幅扰动。
 *
 * 纪律：绝不"从官方文本重新生成"——父代的全部已累积改动必须保留。
 * 找不到任何可用算子时抛错，由调用方记录生成失败，不得静默回落到官方基线。
 *
 * @param {string} moduleId
 * @param {string} parentText 父代模块函数文本（必须与注册表签名一致）
 * @param {number} variant 变异序号
 * @param {number} seed 确定性种子
 */
export function mutateModuleText(moduleId, parentText, variant = 0, seed = 0) {
  const registry = moduleRegistry();
  const module = registry.modules.find(m => m.id === moduleId);
  assertCondition(module, `未注册模块：${moduleId}`);
  assertCondition(typeof parentText === 'string' && parentText.trim().length > 0,
    `${moduleId} 父代源码缺失：拒绝在官方基线上假装继承`);
  const stripped = stripLiterals(parentText);
  const fn = extractFunction(stripped, parentText, module.functionName);
  assertCondition(!fn.error, `${moduleId} 父代源码解析失败：${fn.error}`);
  const params = functionParams(fn.strippedText);
  assertCondition(params && JSON.stringify(params) === JSON.stringify(module.signature),
    `${moduleId} 父代签名不符：期望 (${module.signature.join(',')})，实际 (${(params ?? []).join(',')})`);

  const list = MODULE_MUTATIONS[moduleId] ?? [];
  const index = list.length
    ? ((Number.isInteger(variant) ? variant % list.length : 0) + list.length) % list.length
    : 0;
  if (list.length) {
    try {
      return {
        id: moduleId,
        label: list[index].label,
        text: list[index].apply(parentText),
        operator: `curated:${list[index].label}`,
      };
    } catch { /* 父代已偏离该锚点：转入通用算子，保留父代全部改动 */ }
  }

  const numeric = numericTweak(parentText, stripped, seed);
  if (numeric) return { id: moduleId, label: numeric.label, text: numeric.text, operator: 'generic-numeric' };
  const compare = comparisonTweak(parentText, stripped, seed);
  if (compare) return { id: moduleId, label: compare.label, text: compare.text, operator: 'generic-comparison' };
  throw new Error(`${moduleId} 没有可用的跨代变异算子（父代既无数字字面量也无比较运算符）`);
}

const NUMERIC_RE = /(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.])/g;
const SCALE_FACTORS = [1.06, 0.94, 1.12, 0.88, 1.2, 0.8];

/** 父代文本内的确定性数值扰动（保留全部既有改动）。
 * 匹配在剥离字符串/注释后的文本上进行（位置与原文等长），避免改写字面量内容。 */
function numericTweak(original, stripped, seed) {
  const matches = [...stripped.matchAll(NUMERIC_RE)];
  if (!matches.length) return null;
  const index = ((seed % matches.length) + matches.length) % matches.length;
  const match = matches[index];
  const raw = Number(match[1]);
  if (!Number.isFinite(raw) || raw === 0) return null;
  const factor = SCALE_FACTORS[((seed * 7 + index) % SCALE_FACTORS.length + SCALE_FACTORS.length) % SCALE_FACTORS.length];
  const next = raw * factor;
  const rendered = Number.isInteger(raw)
    ? String(Math.max(1, Math.round(next)))
    : String(Number(next.toFixed(4)));
  if (rendered === match[1]) return null;
  const start = match.index;
  const end = start + match[0].length;
  return {
    label: `numeric@${start}:${match[1]}->${rendered}`,
    text: `${original.slice(0, start)}${rendered}${original.slice(end)}`,
  };
}

/** 父代文本内的确定性比较运算符扰动。 */
function comparisonTweak(original, stripped, seed) {
  const ops = [...stripped.matchAll(/(?<![<>!=])(<=|>=|<|>)(?![=])/g)];
  if (!ops.length) return null;
  const index = ((seed % ops.length) + ops.length) % ops.length;
  const op = ops[index][1];
  const replacement = op === '<' ? '<=' : op === '<=' ? '<' : op === '>' ? '>=' : '>';
  const start = ops[index].index;
  return {
    label: `comparison@${start}:${op}->${replacement}`,
    text: `${original.slice(0, start)}${replacement}${original.slice(start + op.length)}`,
  };
}

/** 生成一组互不相同的确定性模块变异（用于阶段一五模块对照实验）。 */
export function mutateModules(moduleIds, seed = 0) {
  return moduleIds.map((id, index) => mutateModuleFunction(id, seed + index));
}

/** 多变体库：为 MAP-Elites/精英池提供确定性起点。 */
export function allMutationVariants(moduleId) {
  const list = MODULE_MUTATIONS[moduleId] ?? [];
  return list.map((_, index) => mutateModuleFunction(moduleId, index));
}
