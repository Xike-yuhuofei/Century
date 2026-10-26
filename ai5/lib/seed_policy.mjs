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
 * - [1.1e9, 1.2e9)           AI6 冠军基线冻结评测专用块（research/m4-baseline-freeze，
 *   账本管理见 training/baseline/seed-ledger.json）：多人（2-5 人）第一名率基准、
 *   性能基准与冻结复现对照，与训练/验证/进化各池物理隔离。
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
/** AI6 冠军基线冻结评测专用块：多人第一名率基准 / 性能基准 / 冻结复现对照。
 * 与 AI4 进化区、AI5 专用块、验证池物理隔离，账本见 training/baseline/seed-ledger.json。 */
export const AI6_BASELINE_BLOCK = [1_100_000_000, 1_200_000_000];

/** AI7 自主进化开发池（与全部既有区块物理隔离；正式验证池不在此范围）：
 * - [1.61e9, 1.62e9) 快筛窗口池（1000 种子/窗口，中央登记原子分配）；
 * - [1.62e9, 1.63e9) 深验窗口池（同上）。
 * 本区块不参与冠军晋级证据；晋级只能使用 [900M, 1.06e9) 验证池。 */
export const AI7_DEV_BLOCK = [1_610_000_000, 1_630_000_000];
export const AI7_SCREEN_BLOCK = [1_610_000_000, 1_620_000_000];
export const AI7_DEEP_BLOCK = [1_620_000_000, 1_630_000_000];

/** AI6 Joint Search V1（第四阶段）评测专用块：候选筛选消融与性能基准。
 * 与全部既有块物理隔离；本阶段为候选筛选评测，不消费正式验证池。
 * 子块布局（左右闭开）：
 * - [1.30e9, 1.301e9)  版本一致性审计（training/joint/audit.mjs）；
 * - [1.31e9, 1.32e9)   调参/开发种子（JS 消融调参，永不用于结论）；
 * - [1.32e9, 1.33e9)   主测试种子（JS0-JS4 消融第一名率结论）；
 * - [1.33e9, 1.34e9)   独立验证种子（PR #26 修复后 JS5 最终验证，与调参/主测试
 *                      物理隔离；此前未消费，2026-10-24 登记）；
 * - [1.34e9, 1.35e9)   L3 叶子评价器校准（training/joint/calibrate.mjs）；
 * - [1.35e9, 1.351e9)  性能基准（25/50/100/200ms、64-512 工作量）。 */
export const AI6_JOINT_SEARCH_BLOCK = [1_300_000_000, 1_400_000_000];
export const AI6_JOINT_AUDIT_SUBBLOCK = [1_300_000_000, 1_301_000_000];
export const AI6_JOINT_TUNE_SUBBLOCK = [1_310_000_000, 1_320_000_000];
export const AI6_JOINT_TEST_SUBBLOCK = [1_320_000_000, 1_330_000_000];
export const AI6_JOINT_VERIFY_SUBBLOCK = [1_330_000_000, 1_340_000_000];
export const AI6_JOINT_CALIB_SUBBLOCK = [1_340_000_000, 1_350_000_000];
export const AI6_JOINT_PERF_SUBBLOCK = [1_350_000_000, 1_351_000_000];

/** AI6 第五阶段（JS5 稳健性验证与晋级准备）子块（与全部既有块物理隔离；
 * 沿用 PR #26 先例：Joint Search 阶段子块只登记 .mjs，.py 镜像至基线块为止）：
 * - [1.351e9, 1.352e9)  本阶段调参/敏感性分析（js5-opt 开发专用，永不用于结论）；
 * - [1.36e9, 1.37e9)    独立确认块（全新种子，此前从未消费）。duel.mjs --block confirm
 *   分区：seedBase = 1.36e9 + (人数−2)×1e6 + (对手池 diverse ? 5e5 : 0)——每个
 *   (人数, 对手池) 组合独占 50 万种子，配对候选共享同一种子（配对设计），
 *   不同实验阶段/对手池绝不共享种子。[1.353e9,1.36e9) 与 [1.37e9,1.4e9) 预留。 */
export const AI6_JS5_TUNE2_SUBBLOCK = [1_351_000_000, 1_352_000_000];
export const AI6_JS5_CONFIRM_SUBBLOCK = [1_360_000_000, 1_370_000_000];

/** AI6 第六阶段（胜率优先的 JS5 深度强化与搜索算力扩展）子块
 *（与全部既有块物理隔离；[1.352e9,1.353e9) 与 [1.353e9,1.354e9)、
 * [1.354e9,1.355e9) 此前预留未消费，2026-10-24 登记）：
 * - [1.352e9, 1.353e9)  开发/冒烟种子（管线调试，永不用于结论）；
 * - [1.353e9, 1.354e9)  参数调优/机制消融种子（JS6 机制开发，永不用于结论）；
 * - [1.354e9, 1.355e9)  性能专用种子（固定工作量复现、负载剖面）；
 * - [1.37e9, 1.372e9)   任务 A2 双人专项独立验证（全新种子，预注册）；
 * - [1.372e9, 1.382e9)  任务 B 预算矩阵（分区：seedBase = 1.372e9 +
 *   (人数−2)×2e6 + (比较类型偏移)；比较类型：0=同算法预算阶梯、1e6=同预算算法对照）；
 * - [1.382e9, 1.4e9)    独立确认块（F 协议终局确认；分区 = 1.382e9 +
 *   (人数−2)×3e6 + (池 diverse ? 1.5e6 : 0)，每 (人数,池) 独占 150 万种子）。 */
export const AI6_PHASE6_DEV_SUBBLOCK = [1_352_000_000, 1_353_000_000];
export const AI6_PHASE6_TUNE_SUBBLOCK = [1_353_000_000, 1_354_000_000];
export const AI6_PHASE6_PERF_SUBBLOCK = [1_354_000_000, 1_355_000_000];
export const AI6_PHASE6_2P_SUBBLOCK = [1_370_000_000, 1_372_000_000];
export const AI6_PHASE6_BUDGET_SUBBLOCK = [1_372_000_000, 1_382_000_000];
export const AI6_PHASE6_CONFIRM_SUBBLOCK = [1_382_000_000, 1_400_000_000];

/** JS5 Goal 证据优化（2026-10-25，codex/js5-evidence-optimization）专用块。
 * 与既有调参/确认/正式验证池物理隔离；只用于本任务的机制消融与独立确认，
 * 不写正式验证账本。子块（左右闭开）：
 * - [1.370e9, 1.372e9)  开发/先导（机制消融与样本量估计，永不用于结论）；
 * - [1.380e9, 1.390e9)  独立确认（冻结主候选后一次性使用，不得回炉调参）。
 * [1.372e9,1.380e9) 与 [1.390e9,1.400e9) 继续预留。 */
export const AI6_JS5_GOAL_BLOCK = [1_370_000_000, 1_400_000_000];
export const AI6_JS5_GOAL_DEV_SUBBLOCK = [1_370_000_000, 1_372_000_000];
export const AI6_JS5_GOAL_CONFIRM_SUBBLOCK = [1_380_000_000, 1_390_000_000];
/** 性能验证局面生成块（只用于延迟/非法率，不进入任何胜率结论）。 */
export const AI6_JS5_GOAL_PERF_SUBBLOCK = [1_372_000_000, 1_374_000_000];

/** ⚠️ 并行会话登记重叠披露（2026-10-25 合并时发现，登记原文保留不改）：
 * 第六阶段块（research/ai6-phase6-winrate-scaling，2026-10-24 登记）与 JS5 Goal 块
 * （codex/js5-evidence-optimization，2026-10-25 合并）由两个并行会话各自登记，存在
 * 三处区间重叠：PHASE6_2P ≡ GOAL_DEV = [1.37e9,1.372e9)；PHASE6_BUDGET ⊃
 * GOAL_PERF = [1.372e9,1.374e9)；PHASE6_CONFIRM ⊃ GOAL_CONFIRM = [1.38e9,1.39e9)。
 * 双方实验均已完成、种子逐局落盘可审计（phase6 报告与 js5-goal 报告各自独立），
 * 确定性重放不受影响；重叠仅意味着「这些区间不得再被任何新块登记或消费」。
 * 纪律：后续新块一律从 [1.41e9) 之后或与既有登记逐一核对后分配。 */

/** AI6 对抗性联赛（overnight-adversarial-league，research/overnight-adversarial-league）
 * 评测专用块：独立于 JS6 搜索研发的高水平对手池 / 自动联赛 / 防过拟合双轴评估。
 * 与全部既有块物理隔离；本阶段不消费正式验证池（[900M,1.06e9)）。
 * 子块布局（左右闭开；沿用 PR #26 先例只登记 .mjs）：
 * - [1.40e9, 1.401e9)  开发/审计探针（注册表行为探针、注入审计，永不用于结论）；
 * - [1.401e9, 1.402e9) 联赛端到端冒烟（2–5 人少量种子，框架验收）；
 * - [1.402e9, 1.403e9) 夜间开发用小型胜率矩阵（候选初筛读数，非结论）；
 * - [1.403e9, 1.41e9)  预注册大规模联赛（只生成方案不夜间执行，人工批准后消费）。
 * [1.41e9, 1.5e9) 预留。 */
export const AI6_ADVERSARIAL_LEAGUE_BLOCK = [1_400_000_000, 1_500_000_000];
export const AI6_LEAGUE_DEV_SUBBLOCK = [1_400_000_000, 1_401_000_000];
export const AI6_LEAGUE_SMOKE_SUBBLOCK = [1_401_000_000, 1_402_000_000];
export const AI6_LEAGUE_MATRIX_DEV_SUBBLOCK = [1_402_000_000, 1_403_000_000];
export const AI6_LEAGUE_PREREG_SUBBLOCK = [1_403_000_000, 1_410_000_000];

/** AI7 竞技决策候选开发快筛块（research only，2026-10-25）：
 * - [1.41e9, 1.42e9) 与对抗联赛预留段物理隔离；
 * - 只用于固定工作量开发种子快速筛选（方向性读数），**不是**正式验证池：
 *   正式验证池为 [900M, 1.06e9)，本块完全在验证池之外；
 * - 任何候选晋级必须另起独立确认块并由后续实验流程批准，禁止复用本块。 */
export const AI7_CANDIDATE_DEV_SUBBLOCK = [1_410_000_000, 1_420_000_000];

/** AI6 战术基准局面库专用块（research/overnight-tactical-benchmark，PR 合并时换块）：
 * 原拟 [1.4e9,1.5e9) 与对抗性联赛块重叠（并行会话先合并），按块不重叠纪律改登记
 * [1.5e9,1.6e9)，语料随之用新种子确定性重生成（见 training/scenarios/data/）。
 * 仅用于基准局面的引擎 replay 种子与固定工作量测试，不用于任何胜率/晋级统计；
 * 与训练/验证/进化/基线/联合搜索/对抗联赛各池物理隔离。种子消耗清单随语料落盘
 * （training/scenarios/data/generation-summary.json），逐局顺序分配、可审计。 */
export const AI6_SCENARIO_BLOCK = [1_500_000_000, 1_600_000_000];

/** AI9 全决策系统协同进化（2026-10-26 登记；与全部既有块物理隔离）：
 * - [1.650e9, 1.651e9)  OpenEvolve 多模块研究评估：
 *   stage2 16 种子、stage3 48 种子、行为探针固定夹具；
 * - [1.66e9, 1.67e9)    协同进化快筛池（开发专用，永不进入正式晋级证据）；
 * - [1.67e9, 1.68e9)    协同进化深验池（开发专用，与快筛物理隔离）；
 * - [1.68e9, 1.69e9)    独立确认池（候选冻结后一次性使用，不复用调参）。
 * 正式冠军晋级仍只能使用验证池 [900M, 1.06e9)，与本块零交集。 */
export const AI9_BLOCK = [1_650_000_000, 1_700_000_000];
export const AI9_OPENEVOLVE_STAGE2_BLOCK = [1_650_000_000, 1_650_000_016];
export const AI9_OPENEVOLVE_STAGE3_BLOCK = [1_650_000_100, 1_650_000_148];
export const AI9_PROBE_BLOCK = [1_650_002_000, 1_650_003_000];
export const AI9_DEV_SCREEN_BLOCK = [1_660_000_000, 1_670_000_000];
export const AI9_DEV_DEEP_BLOCK = [1_670_000_000, 1_680_000_000];
export const AI9_CONFIRM_BLOCK = [1_680_000_000, 1_690_000_000];

/** AI10 LLM 实时玩家研究（2026-10-26 登记；与全部既有块物理隔离）：
 * - [1.700e9, 1.70001e9)   阶段 A 功能验证（每人数 1000 种子子块，仅用前若干个）；
 * - [1.70001e9, 1.70041e9) 阶段 B 探索性配对（按人数分区，每区 10 万种子）；
 * - [1.710e9, 1.720e9)     阶段 C 预注册独立确认（每人数 250 万种子；
 *   仅在 preregistration.json 锁定后消费）。
 * 本块不参与正式冠军晋级；正式晋级仍只能使用验证池 [900M, 1.06e9)。 */
export const AI10_LLM_BLOCK = [1_700_000_000, 1_720_000_000];
export const AI10_LLM_SMOKE_BLOCK = [1_700_000_000, 1_700_010_000];
export const AI10_LLM_EXPLORATORY_BLOCK = [1_700_010_000, 1_700_410_000];
export const AI10_LLM_CONFIRM_BLOCK = [1_710_000_000, 1_720_000_000];
/** 每个人数独立子块（左右闭开）： */
export const AI10_LLM_SMOKE_MODE_BASE = (mode) => 1_700_000_000 + (mode - 2) * 1_000;
export const AI10_LLM_EXPLORE_MODE_BASE = (mode) => 1_700_010_000 + (mode - 2) * 100_000;
export const AI10_LLM_CONFIRM_MODE_BASE = (mode) => 1_710_000_000 + (mode - 2) * 2_500_000;

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
