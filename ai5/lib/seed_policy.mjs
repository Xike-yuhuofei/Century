/** AI5 种子全局政策（P0 可靠性整改：跨系统种子分配的唯一权威定义）。
 *
 * 全部种子 < 2^31（引擎 `seed >>> 0` 回绕安全上限，见 training/lib/seeds.mjs）。
 * 区间布局（左右闭开）：
 * - [0, 300M)                AI 4.0 日常进化（AI5 绝不使用）；
 * - [300M, 400M)             AI5 专用块，内部再分：
 *   - [300,000,000, 300,000,016)  OpenEvolve stage2 快筛（16 种子，固定）；
 *   - [300,000,100, 300,000,148)  OpenEvolve stage3 深评（48 种子，固定）；
 *   - [300,001,000, 300,002,000)  OpenEvolve 深度独立验证（账本管理，见
 *     ai5/openevolve/results/deep-validation-ledger.json）；
 *   - [300,100,000, 350,000,000)  PPO 训练对局种子（derive_seed 强制约束于此）；
 *   - [350,000,000, 400,000,000)  AI5 竞技评估训练池（arena --seed-pool training，
 *     账本管理）；此前账本从 5M 起步与 AI4 进化区仅是簿记重叠，本次整改后
 *     新分配一律从 350M 起步，与 PPO 训练块物理隔离；
 * - [400M, 900M)             AI 4.0 基准评测约定区（AI5 绝不使用）；
 * - [900M, 1.06e9)           验证池：AI4 确认挑战 + AI5 arena 独立验证共用，
 *   账本防重 + 原子分配（flock），AI5 对 AI4 账本只读核对。
 *
 * 纪律：任何系统的种子消费不得越过自己的区间；训练种子与验证/评测种子交集
 * 必须为零。越界一律抛错（宁可终止也不污染）。
 */

export const ENGINE_SEED_MAX = 2 ** 31 - 1;

export const AI4_EVO_BLOCK = [0, 300_000_000];
export const AI5_BLOCK = [300_000_000, 400_000_000];
export const OPENEVOLVE_STAGE2_BLOCK = [300_000_000, 300_000_016];
export const OPENEVOLVE_STAGE3_BLOCK = [300_000_100, 300_000_148];
export const OPENEVOLVE_DEEP_VALIDATION_BLOCK = [300_001_000, 300_002_000];
export const PPO_TRAINING_BLOCK = [300_100_000, 350_000_000];
export const AI5_EVAL_TRAINING_BLOCK = [350_000_000, 400_000_000];
export const AI4_BENCHMARK_BLOCK = [400_000_000, 900_000_000];
export const VALIDATION_POOL_BLOCK = [900_000_000, 1_060_000_000];

/** 断言种子落在指定区间内（含头不含尾）。 */
export function assertInBlock(seed, block, name = 'seed') {
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`${name} 必须为安全整数，实际：${seed}`);
  }
  if (seed < block[0] || seed >= block[1]) {
    throw new Error(`${name} ${seed} 越界：必须在 ${block[0]}..${block[1] - 1}（区间纪律违规）`);
  }
  return seed;
}

/** 种子列表解析（P0 整改：duel_runner 事故根因防御）。
 *
 * 事故背景：旧链路用 Number() 解析种子文件，科学计数法文本（"3.00001e+08"）
 * 被静默接受，且 101 行重复种子未被察觉——101 个"独立"配对样本实为 1 个。
 * 防御规则：
 * 1. 每行必须完整匹配 /^[0-9]+$/（拒绝科学计数法/浮点/正负号/空白混杂）；
 * 2. 解析值必须是安全整数且落在指定区间；
 * 3. 不同配对样本不得重复（同一配对内的双向共享由 duel_runner 结构保证，
 *    本函数按"每种子一个配对样本"语义强制唯一）。
 */
export function parseSeedList(text, { block = AI5_BLOCK, requireUnique = true } = {}) {
  if (typeof text !== 'string') throw new Error('种子列表必须是文本');
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('种子列表为空');
  const seeds = [];
  const seen = new Set();
  for (const line of lines) {
    if (!/^[0-9]+$/.test(line)) {
      throw new Error(`种子行格式非法（只允许十进制整数，拒绝科学计数法/浮点）："${line.slice(0, 40)}"`);
    }
    const seed = Number(line);
    if (!Number.isSafeInteger(seed)) {
      throw new Error(`种子行不是安全整数："${line.slice(0, 40)}"`);
    }
    assertInBlock(seed, block, '种子');
    if (requireUnique) {
      if (seen.has(seed)) {
        throw new Error(`种子 ${seed} 重复出现——不同配对样本禁止共享种子（统计独立性违规）`);
      }
      seen.add(seed);
    }
    seeds.push(seed);
  }
  return seeds;
}

/** 生成 [block 区间内) count 个唯一种子的确定性方案：顺序切片（无随机性 =
 * 可审计、天然唯一、永不与同块其它顺序切片重叠——重叠由调用方账本防重保证）。 */
export function sequentialSeeds(block, base, count) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`count 必须为正整数，实际：${count}`);
  if (!Number.isSafeInteger(base) || base < block[0] || base + count > block[1]) {
    throw new Error(`种子块 [${base}, ${base + count}) 越界（块 ${block.join('..')}）`);
  }
  return Array.from({ length: count }, (_, i) => base + i);
}
