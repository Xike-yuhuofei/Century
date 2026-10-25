/** AI 决策入口（对外唯一 API）。
 *
 * 信息边界：完整 Game 只在入口处用于构造 AIObservation 与合法性核验；
 * 决策本身只消费公开观察，无法访问隐藏牌库顺序。
 * 正式网页版（桌面/Worker）与训练模拟器共用本函数。
 */

import type { Game, Action, Color } from '../engine.js';
import { applyAction } from '../engine.js';
import { buildObservation } from './observation.js';
import { resolveAIParameters, type AIParameters } from './parameters.js';
import { choosePlan, initialState, actions } from './planner.js';
import { trimStock } from './evaluator.js';
import { normalizeStructure, type AIStructure } from './structures.js';
import { chooseJointAction } from '../js/adapter.js';
import type { Profile } from './profiles.js';

export type AIOptions = {
  /** 覆盖参数：对象、已注册版本 id，或缺省使用当前激活参数（冠军）。 */
  parameters?: AIParameters | string;
  /** 显式人格：训练模拟器按正式游戏席位映射注入；缺省按席位结构自动推导。 */
  profile?: Profile;
  /** 结构变体：beam-lineage（冠军基线）/ beam-adaptive / beam-rollout / beam-contest。 */
  structure?: AIStructure | string;
};

export type AIDecision = {
  action: Action;
  reason: string;
  plan?: { goal: string; steps: number; actions: Action[] };
};

export function chooseAIAction(game: Game, options?: AIOptions): AIDecision {
  const params = resolveAIParameters(options?.parameters);
  // 结构化冠军分派（AI6 第五阶段）：激活参数携带 adapter 字段时，决策核心在
  // 适配器内（如 JS5 冠军引导选择性联合搜索）——信息边界、溢出口径与"正式引擎
  // 复核"纪律由适配器承担；无 adapter 字段的参数走束搜索路径（行为逐字节不变）。
  if (params.adapter === 'champion-guided') {
    if (game.phase === 'finished') throw new Error('游戏结束，AI 无法行动');
    const p = game.players[game.current];
    if (!p?.isAI) throw new Error('当前行动者不是 AI');
    const joint = chooseJointAction(game, {
      version: params.jointVersion ?? 'joint-js5',
      ...(params.budgetMs !== undefined ? { budgetMs: params.budgetMs } : {}),
      // AI6 第六阶段 P0 版本身份透传：完整参数对象进入适配器——冠军本体传入
      // 自身（= CHAMPION_PARAMETERS 归一化结果，行为逐位不变），风格变体的
      // 权重修改从此真实影响冠军基座规划（此前被适配器忽略，变体 ≡ 本体）。
      championParameters: params,
      profile: options?.profile,
    });
    return { action: joint.action, reason: joint.reason };
  }
  // 结构来源优先级：显式 options.structure > 参数内嵌 structure > 冠军基线。
  const structure = normalizeStructure((options?.structure ?? params.structure) as string | undefined);
  if (game.phase === 'finished') throw new Error('游戏结束，AI 无法行动');
  const p = game.players[game.current];
  if (!p?.isAI) throw new Error('当前行动者不是 AI');
  if (game.phase === 'overflow') {
    const discarded = trimStock(p.stock, game.golemMarket, null, params).discarded as Color[];
    return { action: { type: 'discard', colors: discarded }, reason: '保留目标水晶，弃置超额水晶' };
  }
  // 决策只使用公开观察；隐藏牌库顺序在观察中不存在。
  const view = buildObservation(game);
  const plan = choosePlan(view, params, options?.profile, structure);
  const action = plan?.first ?? { type: 'rest' };
  // 搜索转移为快速本地模型；真正的第一步必须由正式规则引擎再次核实。
  try {
    applyAction(game, action);
  } catch (error) {
    const fallback = actions(initialState(view), null, false, params).find((a: Action) => {
      try { applyAction(game, a); return true; } catch { return false; }
    });
    if (!fallback) throw error;
    return { action: fallback, reason: '合法动作保底选择' };
  }
  const goal = plan?.preferred;
  const structureTag = structure === 'beam-lineage' ? '' : `·${structure}`;
  return {
    action,
    reason: goal
      ? `AI 4.0 ${plan!.profile}（${params.id}${structureTag}）：公开目标 ${goal}，规划${plan!.steps}步；未知商人/魔像各${plan!.unseenCounts.join('/')}张`
      : '公开市场暂无可规划目标',
    plan: plan && goal ? { goal, steps: plan.steps, actions: plan.path } : undefined,
  };
}
