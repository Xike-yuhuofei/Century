/** 验证种子账本（审计整改：独立验证种子不可重复使用）。
 *
 * 此前确认挑战始终从 900000000 起步，长期会让候选对固定验证种子集过拟合。
 * 账本策略：
 * - 每次确认挑战消耗一个种子块，块与块之间至少间隔 VALIDATION_STRIDE；
 * - 账本随训练状态持久化（工作流 artifact 下载 → 下次 --seed-ledger 续接）；
 *   P1 复审修复：即使某次运行未触发确认挑战，CLI 也会把既有账本原样落盘，
 *   避免"无挑战 → 账本失传 → 下次重复消费"的断链；
 * - 下一次起点取「全部已消费块的最高末端」之后再空一个步长（P1 复审修复：
 *   此前只看 lastBase，历史块若大于最近一块会被跳过重叠）；
 * - 无账本（首次运行或产物丢失）时按运行身份派生盐值，保证不同运行起步不同。
 * 种子上限：900M + 80000×2000 = 1.06e9 < 2^31，引擎种子范围安全。
 */

export const VALIDATION_POOL_BASE = 900_000_000;
export const VALIDATION_STRIDE = 2_000;
/** 验证种子池上限（80_000 块 × 2000 步长），引擎种子必须 < 2^31。 */
export const VALIDATION_POOL_MAX = VALIDATION_POOL_BASE + 80_000 * VALIDATION_STRIDE;

/** 遍历账本中全部已消费块（旧账本条目缺 size 时按最大步长保守估计）。 */
function consumedBlocks(ledger) {
  if (!ledger) return [];
  const blocks = [];
  for (const entry of Array.isArray(ledger.history) ? ledger.history : []) {
    const base = Number(entry?.base);
    if (!Number.isSafeInteger(base) || base < VALIDATION_POOL_BASE) continue;
    const size = Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : VALIDATION_STRIDE;
    blocks.push({ base, size });
  }
  // lastBase 兜底：极老账本可能只有 lastBase 没有 history。
  if (blocks.length === 0 && Number.isFinite(ledger.lastBase) && ledger.lastBase >= VALIDATION_POOL_BASE) {
    blocks.push({ base: ledger.lastBase, size: VALIDATION_STRIDE });
  }
  return blocks;
}

/** 由上次账本推下一次验证种子块起点；无账本时按运行身份派生。
 * 有账本时严格落在全部已消费块之后（不再只依赖 lastBase）。 */
export function nextValidationBase(previousLedger, { runId = process.env.GITHUB_RUN_ID, now = Date.now() } = {}) {
  const blocks = consumedBlocks(previousLedger);
  if (blocks.length > 0) {
    const highestEnd = Math.max(...blocks.map(b => b.base + b.size));
    const next = highestEnd + VALIDATION_STRIDE;
    if (next >= VALIDATION_POOL_MAX) {
      throw new Error(`验证种子池已耗尽（下一块起点 ${next} ≥ 上限 ${VALIDATION_POOL_MAX}），需要扩池并升级引擎种子范围`);
    }
    return next;
  }
  const id = Number(runId);
  const salt = Number.isSafeInteger(id) && id > 0
    ? id % 80_000
    : Math.floor(now / 86_400_000) % 80_000; // 本地运行按天派生
  return VALIDATION_POOL_BASE + salt * VALIDATION_STRIDE;
}

/** 防重断言：拟消费块 [base, base+size) 不得与账本中任何已消费块重叠。
 * 违规抛错——宁可拒绝挑战也绝不复用验证种子。 */
export function assertBlockFree(base, size, ledger) {
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`非法种子块：base=${base}, size=${size}`);
  }
  const end = base + size;
  for (const block of consumedBlocks(ledger)) {
    const blockEnd = block.base + block.size;
    if (base < blockEnd && block.base < end) {
      throw new Error(`验证种子块 [${base}, ${end}) 与已消费块 [${block.base}, ${blockEnd}) 重叠，禁止复用`);
    }
  }
  return true;
}

/** 消费一个种子块后的账本记录（保留最近 100 条历史供审计）。
 * size 记录本次实际消耗的种子数，供防重校验使用。 */
export function consumeLedger(previousLedger, base, size = VALIDATION_STRIDE) {
  return {
    lastBase: base,
    history: [...(Array.isArray(previousLedger?.history) ? previousLedger.history : []).slice(-99), { base, size, at: new Date().toISOString() }],
  };
}
