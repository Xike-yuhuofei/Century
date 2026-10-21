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
 *
 * 种子全局布局（P0 可靠性整改，训练/验证物理隔离，全部 < 2^31 引擎安全上限）：
 * - [0, TRAINING_POOL_MAX=900M)     训练池：进化快速筛选用（其中 [0, 400M) 日常进化、
 *   [400M, 900M) 基准评测约定区，仅作簿记约定、不强制）；
 * - [900M, VALIDATION_POOL_MAX≈1.06e9) 验证池：确认挑战专用，账本防重；
 * - 引擎 generator 对种子做 `seed >>> 0`（mod 2^32 回绕），因此任何分配的种子必须
 *   ≤ ENGINE_SEED_MAX=2^31-1，否则名义种子与实际生效序列脱钩，破坏复现与审计。
 */

export const VALIDATION_POOL_BASE = 900_000_000;
export const VALIDATION_STRIDE = 2_000;
/** 验证种子池上限（80_000 块 × 2000 步长），引擎种子必须 < 2^31。 */
export const VALIDATION_POOL_MAX = VALIDATION_POOL_BASE + 80_000 * VALIDATION_STRIDE;

/** 训练池上限（不含）：验证池从该值起步，训练种子绝不允许到达或越过。 */
export const TRAINING_POOL_MAX = VALIDATION_POOL_BASE;
/** 每个候选固定预留的训练种子块大小（与 --games-per-candidate 上限 1000 对齐，
 * 块大小固定与游标持久化解耦：跨运行调整局数不会造成块重叠）。 */
export const TRAINING_SEED_BLOCK = 1_000;
/** 引擎安全种子上限：engine.ts 的 generator 执行 `seed >>> 0`（mod 2^32 回绕），
 * 超过 2^31-1 的名义种子会回绕到不可审计的镜像值。所有训练/验证分配必须 ≤ 此值。 */
export const ENGINE_SEED_MAX = 2 ** 31 - 1;

/** 把任意种子基数向上对齐到训练块边界（不足一块的余数跳过，保证块互不重叠）。 */
export function alignToTrainingBlock(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`非法训练种子基数：${seed}`);
  return Math.ceil(seed / TRAINING_SEED_BLOCK) * TRAINING_SEED_BLOCK;
}

/** 分配一个训练种子块：游标必须块对齐，块必须完整落在训练池内。
 * 越界一律抛错——宁可终止训练也绝不越过训练/验证池边界。 */
export function allocateTrainingBlock(cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor % TRAINING_SEED_BLOCK !== 0) {
    throw new Error(`训练种子游标必须为块对齐的非负安全整数，实际：${cursor}`);
  }
  if (cursor + TRAINING_SEED_BLOCK > TRAINING_POOL_MAX) {
    throw new Error(
      `训练种子池已耗尽：下一块 [${cursor}, ${cursor + TRAINING_SEED_BLOCK}) 越过训练池上限 ${TRAINING_POOL_MAX}。` +
      `训练与验证种子池物理隔离，禁止越界；请归档历史状态后用更低的 --seed-base 重新规划训练池（验证池 ${VALIDATION_POOL_BASE} 起绝不可用于训练）`,
    );
  }
  return { base: cursor, next: cursor + TRAINING_SEED_BLOCK };
}

/** 旧版断点状态迁移（P0 种子分配整改：旧游标语义是"块索引"，候选种子 = 游标×1000）。
 * - 小游标（旧消费名义值 = 游标×1000，落在池内）：新绝对种子从「最后已消费块之后」继续；
 * - 大游标（日期基数如 20261021，旧消费名义值 游标×1000 ≈ 2e10 已越过池外）：
 *   旧消费与池内种子无交集，直接把游标向上对齐为池内绝对种子续用；
 * - rngCursor 一律从旧游标续接（旧 rng = mulberry32(游标++)，不重复）。
 * 确定性、可审计：迁移结果随 state.seedMigration 落盘。 */
export function migrateLegacyCursor(legacyCursor) {
  if (!Number.isSafeInteger(legacyCursor) || legacyCursor < 0) {
    throw new Error(`断点状态缺少合法的 seedCursor，无法迁移：${legacyCursor}`);
  }
  const nominalEnd = legacyCursor * TRAINING_SEED_BLOCK;
  if (nominalEnd < TRAINING_POOL_MAX) {
    return { seedCursor: nominalEnd, rngCursor: legacyCursor };
  }
  return { seedCursor: alignToTrainingBlock(legacyCursor + 1), rngCursor: legacyCursor };
}

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
    : Math.floor(now / 3_600_000) % 80_000; // 本地运行按小时派生（按天会让同日多次无账本运行撞同一块）
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
 * size 记录本次实际消耗的种子数，供防重校验使用。
 * challengeCount 记录累计确认挑战次数（多重检验 alpha 消耗的输入，
 * P0 可靠性整改：长期重复挑战的误晋级风险必须随挑战次数收紧检验阈值）。 */
export function consumeLedger(previousLedger, base, size = VALIDATION_STRIDE) {
  return {
    lastBase: base,
    challengeCount: validationChallengeCount(previousLedger) + 1,
    history: [...(Array.isArray(previousLedger?.history) ? previousLedger.history : []).slice(-99), { base, size, at: new Date().toISOString() }],
  };
}

/** 已执行的确认挑战总次数（alpha 消耗的挑战序号来源）。
 * 旧账本无 challengeCount 字段时按 history 条数兜底（history 上限 100 条，
 * 保守起见宁少勿多——首次升级后的首次挑战阈值与旧制一致）。 */
export function validationChallengeCount(ledger) {
  if (!ledger) return 0;
  if (Number.isSafeInteger(ledger.challengeCount) && ledger.challengeCount >= 0) return ledger.challengeCount;
  return consumedBlocks(ledger).length;
}
