// AI9 多模块联合进化程序
// 模块：M05:restMultiplier / M01:goalPriority / M11:searchPolicyOverrides / M10:rankRootActions
// 每个 EVOLVE-BLOCK 对应一个模块；不得增删 block、不得改签名。
// 只能使用各模块的 scope 列出的作用域内依赖；禁止 import/eval/网络/文件/进程/
// 随机数/时钟/隐藏牌库字段；函数必须纯且确定性。
// ===== M05 打出与休息调度 =====
// 函数：restMultiplier（ai/evolve/modules.ts）
// 签名：(state, preferred, params)
// 真实决策接线：planner.searchGrade：休息路线惩罚乘子（缺省 1）
// 依赖模块：无
// 作用域内可用依赖：GOLEM_BY_ID、MERCHANT_BY_ID、has、tradeLimit、VALUES、weighted、stockCount、types: AIObservation/Action/AIParameters/EvolveStateView
// ===== M01 魔像目标选择 =====
// 函数：goalPriority（ai/evolve/modules.ts）
// 签名：(view, goalId, params)
// 真实决策接线：planner.choosePlan：每个目标路线期望乘以 goalPriority（缺省 1）
// 依赖模块：无
// 作用域内可用依赖：GOLEM_BY_ID、MERCHANT_BY_ID、has、tradeLimit、VALUES、weighted、stockCount、types: AIObservation/Action/AIParameters/EvolveStateView
// ===== M11 多人联合搜索结构 =====
// 函数：searchPolicyOverrides（ai/evolve/modules.ts）
// 签名：(view, baseOptions, params)
// 真实决策接线：adapter.chooseJointAction：白名单/边界内的联合搜索选项覆盖（缺省空）
// 依赖模块：无
// 作用域内可用依赖：GOLEM_BY_ID、MERCHANT_BY_ID、has、tradeLimit、VALUES、weighted、stockCount、types: AIObservation/Action/AIParameters/EvolveStateView
// ===== M10 行动候选生成/排序 =====
// 函数：rankRootActions（ai/evolve/modules.ts）
// 签名：(view, actions, params)
// 真实决策接线：champion-guided: 根筛选与认领候选重排/剪枝（只允许合法行动子集）
// 依赖模块：无
// 作用域内可用依赖：GOLEM_BY_ID、MERCHANT_BY_ID、has、tradeLimit、VALUES、weighted、stockCount、types: AIObservation/Action/AIParameters/EvolveStateView

/* EVOLVE-BLOCK-START */
export function restMultiplier(state: EvolveStateView, preferred: string | null, params: AIParameters): number {
  // 缺省：休息成本完全由 params.restWeight 与既有步数惩罚决定。
  return 1;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
export function goalPriority(view: AIObservation, goalId: string, params: AIParameters): number {
  // 缺省：目标优先级完全由既有路线评分决定。
  return 1;
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
export function searchPolicyOverrides(
  view: AIObservation,
  baseOptions: Readonly<Record<string, unknown>>,
  params: AIParameters,
): Record<string, unknown> {
  return { nearTerminalCandidate: 'replace' };
}
/* EVOLVE-BLOCK-END */

/* EVOLVE-BLOCK-START */
export function rankRootActions(view: AIObservation, actions: readonly Action[], params: AIParameters): readonly Action[] {
  // 缺省：根行动顺序由规则枚举与既有根筛选先验决定。
  return actions;
}
/* EVOLVE-BLOCK-END */
