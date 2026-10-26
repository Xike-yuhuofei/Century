/** AI 9.0 可进化决策模块（M01、M05–M12）。
 *
 * 本文件只包含受控的纯函数钩子，每个函数是一个独立进化单元：
 * - 缺省实现返回中性值，保证冠军行为逐位不变（乘性钩子返回 1，加性钩子返回 0，
 *   排序/策略钩子返回输入本身或空覆盖）；
 * - 候选编译树（OpenEvolve 多模块候选）按模块注册表替换单个函数，官方源码
 *   只读、冠军产物零污染；
 * - 全部函数只消费 AIObservation（公开信息）与纯卡牌数据，禁止隐藏牌库、
 *   随机数、时钟、网络、文件系统与全局可变状态。
 *
 * 模块契约（training/evolution/module-registry.json 为权威身份表）：
 *   M01 goalPriority           目标选择优先级乘子（缺省 1）
 *   M05 restMultiplier         休息调度惩罚乘子（缺省 1）
 *   M06 endgameBonus           终局路线价值增量（缺省 0）
 *   M07 opponentPressureDelta  对手需求压力增量（mean/peak，缺省 0）
 *   M08 seatContestFactor      座位竞争/目标存活乘子（缺省 1）
 *   M09 unknownSupportFactor   未知牌支持度乘子（缺省 1）
 *   M10 rankRootActions        根行动候选排序/剪枝（缺省原序）
 *   M11 searchPolicyOverrides  联合搜索结构策略覆盖（缺省空对象）
 *   M12 budgetForDecision      自适应计算预算（缺省原预算）
 *
 * 作用域内可用依赖：GOLEM_BY_ID / MERCHANT_BY_ID（卡牌全集）、has / tradeLimit
 * （规则事实）、VALUES / weighted / stockCount（水晶价值与容量）、类型
 * AIObservation / Action / AIParameters。
 */

import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../../data.js';
import { has, tradeLimit, type Action } from '../../engine.js';
import type { AIObservation } from '../observation.js';
import type { AIParameters } from '../parameters.js';
import { VALUES, weighted, stockCount } from '../knowledge.js';

/** 搜索状态的最小只读视图（planner 的 SearchState 结构子集）。 */
export type EvolveStateView = {
  readonly stock: readonly number[];
  readonly hand: readonly string[];
  readonly played: readonly string[];
  readonly golemMarket: readonly string[];
  readonly steps: number;
  readonly terminal: boolean;
};

/* EVOLVE-BLOCK-START */
/** M01 魔像目标选择优先级。
 *
 * 输入：当前公开观察、候选魔像 id、参数集。
 * 输出：非负乘子（建议 0.25–4）。上层按目标逐一乘进路线期望，默认 1 = 冻结口径。
 * 只能使用：view（公开观察）、goalId、GOLEM_BY_ID、VALUES、weighted、stockCount。
 */
export function goalPriority(view: AIObservation, goalId: string, params: AIParameters): number {
  // 缺省：目标优先级完全由既有路线评分决定。
  return 1;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M05 休息调度价值乘子。
 *
 * 输入：搜索状态视图、当前目标魔像、参数集。
 * 输出：休息路线惩罚乘子（建议 0.2–3）。默认 1 = 冻结 restWeight 口径。
 * 只能使用：state、preferred、MERCHANT_BY_ID、GOLEM_BY_ID、VALUES、weighted、
 * stockCount、has、tradeLimit。
 */
export function restMultiplier(state: EvolveStateView, preferred: string | null, params: AIParameters): number {
  // 缺省：休息成本完全由 params.restWeight 与既有步数惩罚决定。
  return 1;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M06 终局与胜率调整。
 *
 * 输入：搜索状态视图（terminal 表示本路线已完成最后一次认领）、参数集。
 * 输出：加到终局路线评分上的分值（建议 -20–20）。默认 0 = 冻结得分口径。
 * 只能使用：state、GOLEM_BY_ID、VALUES、weighted、stockCount。
 */
export function endgameBonus(state: EvolveStateView, params: AIParameters): number {
  // 缺省：终局路线只按正式得分与既有效率公式评价。
  return 0;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M07 对手行为预测增量。
 *
 * 输入：公开观察、市场商人卡 id、维度（mean=平均需求 / peak=最强对手需求）、参数集。
 * 输出：压力增量（建议 -0.5–0.5，调用方裁剪到 [0,1]）。默认 0 = 冻结压力模型。
 * 只能使用：view、cardId、dimension、MERCHANT_BY_ID、VALUES、weighted、stockCount、has。
 */
export function opponentPressureDelta(
  view: AIObservation,
  cardId: string,
  dimension: 'mean' | 'peak',
  params: AIParameters,
): number {
  // 缺省：对手压力完全由公开库存/引擎推导的 contestPressure / peakPressure 决定。
  return 0;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M08 多人竞争与时序乘子。
 *
 * 输入：公开观察、市场魔像 id、参数集。
 * 输出：目标存活/竞争乘子（建议 0–2；调用方裁剪）。默认 1 = 冻结座位模型。
 * 只能使用：view、goalId、GOLEM_BY_ID、VALUES、weighted、stockCount、has。
 */
export function seatContestFactor(view: AIObservation, goalId: string, params: AIParameters): number {
  // 缺省：竞争时序完全由 golemSurvivalModel 的座位感知模型决定。
  return 1;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M09 未知牌概率/支持度乘子。
 *
 * 输入：公开观察、当前目标魔像、未翻开商人卡 id 列表、参数集。
 * 输出：未来牌库支持度乘子（建议 0–3）。默认 1 = 冻结 futureDeckSupport 口径。
 * 只能使用：view、preferred、unseenMerchants、MERCHANT_BY_ID、GOLEM_BY_ID、
 * VALUES、weighted、stockCount。
 */
export function unknownSupportFactor(
  view: AIObservation,
  preferred: string | null,
  unseenMerchants: readonly string[],
  params: AIParameters,
): number {
  // 缺省：未知牌只按卡牌全集均值为目标提供期望支持。
  return 1;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M10 行动候选生成/排序。
 *
 * 输入：公开观察、规则引擎给出的合法根行动全集、参数集。
 * 输出：重排/剪枝后的行动列表（只能包含输入中的行动；空列表由调用方回退原序）。
 * 默认原样返回 = 冻结枚举顺序。
 * 只能使用：view、actions、GOLEM_BY_ID、MERCHANT_BY_ID、VALUES、weighted、
 * stockCount、has、tradeLimit。
 */
export function rankRootActions(view: AIObservation, actions: readonly Action[], params: AIParameters): readonly Action[] {
  // 缺省：根行动顺序由规则枚举与既有根筛选先验决定。
  return actions;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M11 多人联合搜索结构策略。
 *
 * 输入：公开观察、调用方基础联合搜索选项、参数集。
 * 输出：受控选项覆盖（调用方只接受白名单键并做边界裁剪）；默认空对象 = 冻结配置。
 * 只能使用：view、baseOptions、GOLEM_BY_ID、VALUES、weighted、stockCount。
 */
export function searchPolicyOverrides(
  view: AIObservation,
  baseOptions: Readonly<Record<string, unknown>>,
  params: AIParameters,
): Record<string, unknown> {
  // 缺省：联合搜索结构完全由版本注册表与调用方选项决定。
  return {};
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
/** M12 自适应计算预算。
 *
 * 输入：公开观察、基础决策预算（毫秒）、参数集。
 * 输出：本决策预算毫秒数（调用方裁剪到 0–1000 的生产硬上限；0 = 回退冠军）。默认原值 = 冻结预算。
 * 只能使用：view、baseMs、GOLEM_BY_ID、VALUES、weighted、stockCount。
 */
export function budgetForDecision(view: AIObservation, baseMs: number, params: AIParameters): number {
  // 缺省：预算完全由冠军参数 budgetMs 决定。
  return baseMs;
}
/* EVOLVE-BLOCK-END */
