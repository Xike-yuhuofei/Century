/** AI 9.0 确定性模块变异（受控、可复现，仅作为 OpenEvolve 不可用时的降级路径）。
 *
 * 纪律：
 * - 每个变异都是单点文本替换，替换点唯一；找不到/多处出现立即抛错，
 *   绝不"尽力猜测"地改写官方函数；
 * - 变异后的函数必须仍通过 static_check_modules 与 tsc（由调用方编译验证）；
 * - 来源显式标记 deterministic-template，绝不冒充 openevolve-llm；
 * - 变异只改变 AI 决策算法，不改变规则/裁判/信息边界。
 */

import { officialFunctionText, moduleRegistry } from '../../ai5/openevolve/node/module_registry.mjs';
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
      label: 'long-route-terminal-bonus',
      apply: text => replaceOnce(text,
        '  // 缺省：终局路线只按正式得分与既有效率公式评价。\n  return 0;',
        '  // 变异：长路线到达终局获得少量确定性加分。\n  return state.terminal && state.steps > 8 ? 1 : 0;',
        'M06'),
    },
  ]),
  M07: Object.freeze([
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

/** 生成一组互不相同的确定性模块变异（用于阶段一五模块对照实验）。 */
export function mutateModules(moduleIds, seed = 0) {
  return moduleIds.map((id, index) => mutateModuleFunction(id, seed + index));
}

/** 多变体库：为 MAP-Elites/精英池提供确定性起点。 */
export function allMutationVariants(moduleId) {
  const list = MODULE_MUTATIONS[moduleId] ?? [];
  return list.map((_, index) => mutateModuleFunction(moduleId, index));
}
