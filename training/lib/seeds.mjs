/** 验证种子账本（审计整改：独立验证种子不可重复使用）。
 *
 * 此前确认挑战始终从 900000000 起步，长期会让候选对固定验证种子集过拟合。
 * 账本策略：
 * - 每次确认挑战消耗一个互不重叠的种子块（VALIDATION_STRIDE）；
 * - 账本随训练状态持久化（工作流 artifact 下载 → 下次 --seed-ledger 续接）；
 * - 无账本（首次运行或产物丢失）时按运行身份派生盐值，保证不同运行起步不同。
 * 种子上限：900M + 80000×2000 = 1.06e9 < 2^31，引擎种子范围安全。
 */

export const VALIDATION_POOL_BASE = 900_000_000;
export const VALIDATION_STRIDE = 2_000;

/** 由上次账本推下一次验证种子块起点；无账本时按运行身份派生。 */
export function nextValidationBase(previousLedger, { runId = process.env.GITHUB_RUN_ID, now = Date.now() } = {}) {
  if (previousLedger && Number.isFinite(previousLedger.lastBase) && previousLedger.lastBase >= VALIDATION_POOL_BASE) {
    return previousLedger.lastBase + VALIDATION_STRIDE;
  }
  const id = Number(runId);
  const salt = Number.isSafeInteger(id) && id > 0
    ? id % 80_000
    : Math.floor(now / 86_400_000) % 80_000; // 本地运行按天派生
  return VALIDATION_POOL_BASE + salt * VALIDATION_STRIDE;
}

/** 消费一个种子块后的账本记录（保留最近 100 条历史供审计）。 */
export function consumeLedger(previousLedger, base) {
  return {
    lastBase: base,
    history: [...(Array.isArray(previousLedger?.history) ? previousLedger.history : []).slice(-99), { base, at: new Date().toISOString() }],
  };
}
