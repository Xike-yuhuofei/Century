#!/usr/bin/env node
/** 参数进化训练 CLI（含断点续训、时间预算控制与验证种子账本）。
 *
 * 用法：
 *   node training/optimizer/evolve-cli.mjs --generations 3 --population 8 \
 *     --games-per-candidate 20 --time-budget-min 40 --seed-base 20261020 \
 *     [--resume training/state/state.json] [--seed-ledger training/state/validation-ledger.json] \
 *     [--out training/reports/evolve-20261020]
 *
 * 审计整改要点：
 * - 时间预算真实生效：进化循环按墙钟截止安全退出，不再"只影响是否验证"；
 *   收尾前预留确认挑战时间，验证不足预算时宁可放弃候选也不降低证据标准。
 * - 验证种子账本：确认挑战种子块不可重复使用（lib/seeds.mjs），防止长期过拟合；
 *   账本随训练状态持久化，下次 --seed-ledger 续接；challengeCount 记录累计挑战次数，
 *   作为多重检验几何 alpha 消耗的挑战序号（长期家族误晋级率 ≤ 5% 预算）。
 * - 训练种子块分配：--seed-base 为训练池 [0, 900M) 内的绝对种子起点（块对齐），
 *   每候选固定预留 1000 种子块，绝不越过训练/验证池边界（旧版"游标×1000"语义
 *   会把日期基数乘出 2^31 以上的回绕种子，已废弃；旧断点恢复时自动迁移）。
 * - 多样化对手池：快速筛选默认引入风格变体/历史冠军（--pool-size 控制），
 *   晋级确认挑战保持"冠军独占对手"。
 * - 断点续训：--resume 读取上次 state.json，种子游标与精英池原样续接。
 *
 * 流程：进化（训练种子）→ 最佳候选用独立验证种子确认挑战 → 达标则输出候选文件供 PR。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evolve } from './evolve.mjs';
import { challengeWithDecision } from '../tournament/challenge.mjs';
import { requireBuiltEngine, REPO_ROOT, engineBundleSha256 } from '../lib/paths.mjs';
import { writeJSON, appendJSONL, readJSON, ensureDir } from '../lib/io.mjs';
import { nextValidationBase, consumeLedger, assertBlockFree, validationChallengeCount, TRAINING_POOL_MAX, TRAINING_SEED_BLOCK, VALIDATION_POOL_MAX } from '../lib/seeds.mjs';
import { buildOpponentPool } from '../lib/opponents.mjs';
import { PROMOTION_ALPHA_BUDGET } from '../evaluator/stats.mjs';
import { BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
requireBuiltEngine();

/** 当前代码版本（git commit）；非 git 环境（如纯目录分发）返回 null，仅影响溯源展示。 */
function gitHeadCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

/** 显式参数相对 cwd 解析；默认值相对仓库根解析（npm run 场景 cwd 是 training/）。 */
const fromArg = (value, fallback) => resolve(value !== undefined ? process.cwd() : REPO_ROOT, value ?? fallback);

const outDir = fromArg(args.out, 'training/reports/evolve-latest');
const startedAt = Date.now();
const timeBudgetMin = Number(args['time-budget-min'] ?? 45);
if (!Number.isFinite(timeBudgetMin) || timeBudgetMin <= 0) throw new Error('--time-budget-min 必须为正数');
const totalBudgetMs = timeBudgetMin * 60_000 - 60_000; // 预留 1 分钟收尾

const championFile = fromArg(args.champion, 'training/champions/champion.json');
const championEntry = readJSON(championFile);
const champion = championEntry.parameters ?? championEntry;
if (!champion.id) throw new Error('冠军文件缺少 id 或 parameters');
// 结构变体透传：champion.json 可选 structure 字段（缺省 beam-lineage）。
if (championEntry.structure) champion.structure = championEntry.structure;

const generations = Number(args.generations ?? 3);
const population = Number(args.population ?? 8);
const gamesPerCandidate = Number(args['games-per-candidate'] ?? 20);
// 默认 80：决定性种子下限 60，留出平局/异常余量，避免单次平局导致样本不足无法晋级。
const confirmSeeds = Number(args['confirm-seeds'] ?? 80);
// 兼容旧参数名 --min-games（按局计）：换算为按种子计的决定性样本下限。
const minSeeds = args['min-seeds'] !== undefined
  ? Number(args['min-seeds'])
  : Math.ceil(Number(args['min-games'] ?? 120) / 2);
const poolSize = Number(args['pool-size'] ?? 5);
// 训练种子基数（审计整改 P0：此前读取了 --seed-base 却未传入 evolve()，
// 导致断点缺失时总是退回默认值 100000，逐日重复同一批训练牌局）。
const seedBase = args['seed-base'] !== undefined ? Number(args['seed-base']) : undefined;
// 参数白名单校验：非法或越界的输入一律快速失败，绝不带病运行。
for (const [name, value, low, high] of [
  ['--generations', generations, 1, 100],
  ['--population', population, 1, 512],
  ['--games-per-candidate', gamesPerCandidate, 1, 1000],
  ['--confirm-seeds', confirmSeeds, 1, 2000],
  ['--pool-size', poolSize, 1, 16],
  ['--min-seeds', minSeeds, 1, 2000],
]) {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new Error(`${name} 必须为 ${low}–${high} 之间的整数，实际：${String(value)}`);
  }
}
if (seedBase !== undefined && (!Number.isSafeInteger(seedBase) || seedBase < 0 || seedBase >= TRAINING_POOL_MAX)) {
  // 训练种子必须留在 [0, 900M) 训练池内：>= 900M 属于验证种子池，绝不能用于训练。
  throw new Error(`--seed-base 必须为 [0, ${TRAINING_POOL_MAX}) 内的安全整数，实际：${String(seedBase)}`);
}
if (seedBase !== undefined && seedBase > TRAINING_POOL_MAX - TRAINING_SEED_BLOCK) {
  // 块对齐后连一个候选块都放不下的基数直接拒绝（训练池耗尽的哨兵）。
  throw new Error(`--seed-base 必须为 ≤ ${TRAINING_POOL_MAX - TRAINING_SEED_BLOCK}（训练池内至少能放一个 ${TRAINING_SEED_BLOCK} 种子的候选块），实际：${String(seedBase)}`);
}

// 对手池（审计整改：训练对手多样化）；pool-size 1 退化为仅冠军。
const opponents = poolSize > 1
  ? buildOpponentPool({
      champion,
      baseline: BASELINE_PARAMETERS,
      archiveDir: fromArg(undefined, 'training/champions/candidates'),
      maxOpponents: poolSize,
    })
  : null;

// 时间预算分配：为确认挑战预留时间，进化循环在剩余预算内安全退出。
const reserveMs = Math.min(totalBudgetMs * 0.4, confirmSeeds * 2 * 5_000 + 120_000);
const evolveBudgetMs = Math.max(60_000, totalBudgetMs - reserveMs);
const deadlineAt = startedAt + evolveBudgetMs;
const remaining = () => totalBudgetMs - (Date.now() - startedAt);

let initialState = null;
if (args.resume && existsSync(resolve(process.cwd(), args.resume))) {
  initialState = readJSON(resolve(process.cwd(), args.resume));
  console.error(`恢复断点：第 ${initialState.generation} 代之后继续`);
}

// 验证种子账本（P1：验证种子不可重复使用）。
let previousLedger = null;
if (args['seed-ledger'] && existsSync(resolve(process.cwd(), args['seed-ledger']))) {
  previousLedger = readJSON(resolve(process.cwd(), args['seed-ledger']));
}

ensureDir(outDir);
const logPath = resolve(outDir, 'experiments.jsonl');
const result = evolve({
  champion,
  initialState,
  generations,
  population,
  gamesPerCandidate,
  // P0 修复：训练种子基数必须真正传入进化器（此前只写进了报告）。
  seedBase,
  eliteKeep: Number(args['elite-keep'] ?? 3),
  sigma: Number(args.sigma ?? 0.18),
  opponents,
  deadlineAt,
  deadlineMs: args['deadline-ms'] ? Number(args['deadline-ms']) : undefined,
  onGeneration: (state, candidates) => {
    for (const c of candidates) {
      appendJSONL(logPath, {
        type: 'candidate', generation: state.generation - 1, candidateId: c.parameters.id,
        parentId: c.parentId, seedBase: c.seedBase, evaluation: c.evaluation, parameters: c.parameters,
      });
    }
    writeJSON(resolve(outDir, 'state.json'), state);
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.error(`[gen ${state.generation}/${generations}] 最佳 ${state.history.at(-1).bestId} 胜率 ${state.history.at(-1).bestWinRate} 已用 ${elapsedMin} 分钟`);
  },
});

const report = {
  champion: champion.id,
  generations: result.state.generation,
  history: result.state.history,
  improved: result.improved,
  bestCandidateId: result.bestCandidate?.id ?? null,
  interrupted: result.state.interrupted === true,
  opponents: opponents?.map(o => o.id) ?? [champion.id],
  // 报告记录实际生效的训练种子基数（断点续训时以 state.seedCursor 为准）。
  seedBase: args['seed-base'] !== undefined ? seedBase : 'default(100000)',
  // 种子分配审计（P0 整改）：训练池布局、块大小与运行后的游标位置。
  seedAllocation: {
    pool: `[0, ${TRAINING_POOL_MAX})`,
    block: TRAINING_SEED_BLOCK,
    seedCursorAfter: result.state.seedCursor,
    rngCursor: result.state.rngCursor,
    migrated: result.state.seedMigration ?? null,
  },
  // 证据溯源（P1）：本次运行使用的运行时产物指纹与代码版本。
  provenance: { engineBundleSha256: engineBundleSha256(), codeCommit: gitHeadCommit() },
};

// 时间预算允许时，用独立验证种子对最佳候选做确认挑战（训练/验证种子隔离 + 不可复用）。
// P0 多重检验防线：challengeIndex = 账本已记账挑战次数 + 1，按几何 alpha 消耗
// 收紧本次检验阈值，控制长期重复挑战的家族误晋级率 ≤ 预算（默认 5%）。
if (result.improved && remaining() > reserveMs * 0.6) {
  const validationSeedBase = nextValidationBase(previousLedger);
  // 防重断言（P1 复审）：拟消费块与账本任何已消费块重叠时拒绝挑战，绝不复用种子。
  assertBlockFree(validationSeedBase, confirmSeeds, previousLedger);
  const challengeIndex = validationChallengeCount(previousLedger) + 1;
  const { summary } = challengeWithDecision({
    champion, candidate: result.bestCandidate,
    seeds: confirmSeeds, seedBase: validationSeedBase,
    minSeeds, challengeIndex,
  });
  report.confirmation = summary;
  report.validationSeedBase = validationSeedBase;
  report.challengeIndex = challengeIndex;
  appendJSONL(logPath, { type: 'confirmation', candidateId: result.bestCandidate.id, seedBase: validationSeedBase, challengeIndex, summary });
  // 记账：该验证种子块已消费（记录块大小与累计挑战次数供防重与 alpha 消耗），写入 outDir 供工作流归档、下次续接。
  const ledger = consumeLedger(previousLedger, validationSeedBase, confirmSeeds);
  writeJSON(resolve(outDir, 'validation-ledger.json'), ledger);
  if (summary.decision.promote) {
    const candidateFile = resolve(outDir, 'candidate.json');
    writeJSON(candidateFile, {
      id: result.bestCandidate.id,
      basedOn: champion.id,
      parameters: result.bestCandidate,
      confirmation: {
        seeds: confirmSeeds, games: summary.finishedGames,
        seedBase: validationSeedBase,
        // 多重检验证据：挑战序号与 alpha 预算随证据落盘，晋级脚本据此独立重算收紧后的判定。
        challengeIndex,
        alphaBudget: PROMOTION_ALPHA_BUDGET,
        // 完整配对证据随候选归档：晋级脚本据此独立重算判定，不信任调用方给出的结论。
        paired: summary.paired,
        seedPairs: summary.seedPairs,
        firstPlace: summary.firstPlace,
        winRate: summary.candidateWinRate, pairedDiff: summary.pairedDiffCI,
        ci: summary.decision.ci, decision: summary.decision,
      },
      // 证据完整性溯源（P1）：证据生成时的运行时产物指纹与代码版本。
      // 晋级时重算当前产物指纹比对，引擎在证据生成后变更过则证据失效。
      engineBundleSha256: engineBundleSha256(),
      codeCommit: gitHeadCommit(),
      generatedAt: new Date().toISOString(),
    });
    report.candidateFile = candidateFile;
    console.error(`候选参数已通过确认挑战：${candidateFile}`);
  } else {
    console.error(`确认挑战未达标：${summary.decision.reason}`);
  }
} else if (result.improved) {
  console.error('时间预算不足，跳过确认挑战；候选仅完成快速筛选，状态已落盘可续训');
} else if (result.state.interrupted) {
  console.error('时间预算将尽，进化安全退出；最后完整代状态已落盘，下次 --resume 续训');
}

// 账本持久化（P1 修复）：即使本次未触发确认挑战，也必须把已有账本原样落盘，
// 否则工作流归集不到账本文件，下次运行会因账本丢失而重复消费验证种子块。
if (!existsSync(resolve(outDir, 'validation-ledger.json'))) {
  if (previousLedger) writeJSON(resolve(outDir, 'validation-ledger.json'), previousLedger);
  else writeJSON(resolve(outDir, 'validation-ledger.json'), { lastBase: null, challengeCount: 0, history: [] });
}

report.wallMs = Date.now() - startedAt;
writeJSON(resolve(outDir, 'report.json'), report);
console.log(JSON.stringify(report, null, 2));
console.log(`结果目录：${outDir}`);
