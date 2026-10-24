/** 对抗性联赛·预注册大规模实验方案生成器（overnight-adversarial-league）。
 *
 * 夜间纪律：大规模联赛不擅自启动。本模块只生成经过测试的执行方案
 * （plan JSON + 一条可复制的人工执行命令），由人工批准后消费
 * AI6_LEAGUE_PREREG_SUBBLOCK [1.403e9, 1.41e9)。
 *
 * 方案内容：
 * - 参赛版本 = 完整注册表 + 候选文件（可选 --candidates）；
 * - 人数 = 2 / 3 / 5（覆盖头对头、多人有向场；4 人局由 3/5 人结果插值，
 *   不进入首轮预注册以控制算力——可在 --players 显式加入）；
 * - 种子分区：每场 matchId 独占连续种子段（planMatrix 顺序切片保证不重叠），
 *   双轴评估（若有候选）按 run-league.mjs evaluate 模式的块内分区执行；
 * - 算力估算：js5 席位按 budgetMs=100 × 每局决策数（按人数经验值）估算，
 *   非 js5 束搜索席位按 2ms/决策估算——估算只用于批准决策，实际以运行报告为准。
 *
 * 用法：
 *   node training/adversarial/preregistered-plan.mjs --seeds 30 \
 *     [--candidates training/adversarial/candidates.json] [--players 2,3,5] \
 *     --out training/reports/adversarial-league/prereg
 *   node training/adversarial/preregistered-plan.mjs --verify <plan.json>
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildRegistry } from './registry.mjs';
import { registerCandidates } from './candidate.mjs';
import { planMatrix } from './league.mjs';
import {
  AI6_LEAGUE_PREREG_SUBBLOCK, AI6_LEAGUE_MATRIX_DEV_SUBBLOCK,
} from '../../ai5/lib/seed_policy.mjs';

/** 每局决策数经验值（AI6 基线/第五阶段实测：平均步数 × 席位数）。 */
const MEAN_DECISIONS_PER_SEAT = { 2: 220, 3: 200, 4: 175, 5: 160 };
const BEAM_MS_PER_DECISION = 2; // 束搜索 p50 实测 1–3ms
const JS5_BUDGET_MS = 100;      // 冻结冠军归档 budgetMs

/** 算力估算（秒）：js5 席位数 × 决策数 × 预算 + 其余席位 × 决策数 × 束搜索耗时。 */
export function estimateRuntimeSeconds(plan, registry) {
  let seconds = 0;
  for (const match of plan.matches) {
    const js5Seats = match.focusId === 'js5-frozen-champion' ? 1
      : match.opponentId === 'js5-frozen-champion' ? match.seatCount - 1 : 0;
    const decisionsPerSeat = MEAN_DECISIONS_PER_SEAT[match.seatCount] ?? 160;
    const js5Ms = js5Seats * decisionsPerSeat * JS5_BUDGET_MS;
    const beamMs = (match.seatCount - js5Seats) * decisionsPerSeat * BEAM_MS_PER_DECISION;
    seconds += ((js5Ms + beamMs) / 1000) * match.seeds.length;
  }
  return Math.round(seconds);
}

function parseArgs() {
  const args = {
    seeds: 30, candidates: null, players: [2, 3, 5],
    out: resolve('training/reports/adversarial-league/prereg'), verify: null,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--candidates') args.candidates = resolve(argv[++i]);
    else if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--out') args.out = resolve(argv[++i]);
    else if (argv[i] === '--verify') args.verify = resolve(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

/** 方案校验（人工批准前的机械核验）：种子不越块、场间不重叠、版本全注册。 */
export function verifyPreregPlan(plan, registry) {
  const errors = [];
  const seen = new Set();
  for (const match of plan.matches) {
    for (const seed of match.seeds) {
      if (seed < plan.block[0] || seed >= plan.block[1]) errors.push(`${match.matchId} 种子 ${seed} 越块`);
      if (seen.has(seed)) errors.push(`种子 ${seed} 重复分配（场间重叠）`);
      seen.add(seed);
    }
    for (const id of [match.focusId, match.opponentId]) {
      if (registry && !registry.versions[id]) errors.push(`${match.matchId} 引用未注册版本 ${id}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function buildPlan({ registry, players, seeds }) {
  const block = AI6_LEAGUE_PREREG_SUBBLOCK;
  const versionIds = Object.keys(registry.versions);
  const plan = planMatrix({
    versionIds, seatCounts: players, seedsPerPair: seeds, seedBase: block[0], block,
  });
  return { registry, plan, block };
}

function main() {
  const args = parseArgs();
  if (args.verify) {
    const plan = JSON.parse(readFileSync(args.verify, 'utf8'));
    const registry = buildRegistry({ jointOptions: null });
    const result = verifyPreregPlan(plan.plan ?? plan, registry);
    if (!result.valid) {
      console.error(`方案校验失败：\n${result.errors.join('\n')}`);
      process.exit(1);
    }
    process.stdout.write(`方案校验通过：${(plan.plan ?? plan).matches.length} 场，种子无重叠、无越块、版本全注册。\n`);
    return;
  }
  const baseRegistry = buildRegistry({ jointOptions: null });
  let registry = baseRegistry;
  if (args.candidates) {
    const doc = JSON.parse(readFileSync(args.candidates, 'utf8'));
    registry = registerCandidates(baseRegistry, Array.isArray(doc) ? doc : [doc]);
  }
  const { plan, block } = buildPlan({ registry, players: args.players, seeds: args.seeds });
  const runtimeSeconds = estimateRuntimeSeconds(plan, registry);
  const prereg = {
    schema: 'century-adversarial-prereg-v1',
    status: 'DRAFT-AWAITING-APPROVAL（夜间不执行，人工批准后运行）',
    date: new Date().toISOString(),
    seedBlock: [...block],
    players: args.players,
    seedsPerPair: args.seeds,
    totalGames: plan.matches.reduce((s, m) => s + m.seeds.length, 0),
    estimatedRuntimeHours: Number((runtimeSeconds / 3600).toFixed(1)),
    estimatedRuntimeBasis: 'js5 席位 budgetMs=100 × 每局决策数经验值 + 束搜索 2ms/决策（估算仅用于批准决策）',
    registryFingerprint: registry.snapshot.registryFingerprint,
    versionFingerprints: registry.snapshot.versionFingerprints,
    executionCommand: [
      'node training/adversarial/run-league.mjs --mode matrix',
      `--players ${args.players.join(',')}`, `--seeds ${args.seeds}`,
      '--block prereg', '--joint official',
      args.candidates ? `--candidates ${args.candidates}` : null,
      `--out ${args.out}`,
    ].filter(Boolean).join(' '),
    acceptanceCriteria: [
      '异常局率 < 2%（异常局绝不计入胜率）',
      '全部对局指纹与 plan 版本指纹一致（版本漂移即作废）',
      '轴 A（vs 冻结冠军）与轴 G（泛化池）读数分开披露，禁止合并口径',
      '强对手判定：轴 A Wilson 下界 ≥ 0.5 且轴 G 下界 ≥ 0.2、泛化分差 ≥ -3',
    ],
    plan,
  };
  mkdirSync(args.out, { recursive: true });
  const out = resolve(args.out, `prereg-plan-${args.seeds}s.json`);
  writeFileSync(out, JSON.stringify(prereg, null, 2));
  process.stdout.write(`预注册方案已写入：${out}\n`);
  process.stdout.write(`规模：${prereg.totalGames} 局 / ${plan.matches.length} 场｜估算 ${prereg.estimatedRuntimeHours}h\n`);
  process.stdout.write(`人工批准后执行：\n  ${prereg.executionCommand}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main();
