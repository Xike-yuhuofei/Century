#!/usr/bin/env node
/** 冠军晋级脚本（审计整改 P0；P1 复审：独立核验证据）。
 *
 * 此前工作流只把候选复制到 training/champions/candidates/（目录还不存在，
 * 直接失败），且从不更新 training/champions/champion.json——新参数落地网页后，
 * 下一轮进化仍以旧冠军为基准，训练与正式游戏长期脱节。
 *
 * 本脚本在晋级 PR 流程中按顺序完成：
 * 1. 校验候选文件携带 promote=true 的确认挑战判定（无证据拒绝晋级）；
 * 2. P1 复审：独立重算晋级判定——不信任调用方写好的 decision，而是用候选归档
 *    携带的逐种子配对证据（seedPairs）重新执行 pairedPromotionDecision，
 *    并交叉核对样本量、验证种子池归属与 CI 一致性；证据缺失、被篡改或
 *    重算结论不一致一律拒绝晋级；
 * 3. P0 多重检验核验：证据必须携带挑战序号 challengeIndex 与 alphaBudget，
 *    按几何 alpha 消耗（α_k = 预算/2^k）重算收紧后的判定；随附验证账本时
 *    交叉核对挑战序号与账本 challengeCount 一致，防伪造小序号换宽松阈值；
 * 4. P1 证据完整性核验：确认挑战证据的运行时产物指纹（engineBundleSha256）
 *    必须与当前编译产物一致——引擎在证据生成后变更过则旧证据失效，必须重新挑战；
 *    codeCommit 缺失时警告（溯源降级）；
 * 5. 校验候选参数合法性（validateAIParameters）；
 * 6. 创建并归档候选到 training/champions/candidates/<id>.json；
 * 7. 同步更新 training/champions/champion.json（含挑战证据、引擎/代码版本溯源），
 *    保证下一轮进化以新冠军为基准。
 *
 * 用法：node training/scripts/promote-champion.mjs --candidate <候选文件> \
 *         [--champion training/champions/champion.json] [--min-seeds 60]
 * --min-seeds：晋级时决定性种子的最低门槛（默认 60）；重算时即使候选自报
 * 更低门槛也按本门槛执行，防止用小样本证据混过晋级。
 * 之后由 apply-champion.mjs 把参数写入 web-v1/src/ai/parameters.ts。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { ensureDir, readJSON } from '../lib/io.mjs';
import { requireBuiltEngine, REPO_ROOT, engineBundleSha256 } from '../lib/paths.mjs';
import { pairedPromotionDecision, alphaSpendingThreshold, PROMOTION_ALPHA_BUDGET } from '../evaluator/stats.mjs';
import { VALIDATION_POOL_BASE, VALIDATION_POOL_MAX, validationChallengeCount } from '../lib/seeds.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[arg.slice(2)] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (!args.candidate) {
  console.error('必须提供 --candidate <候选文件>');
  process.exit(2);
}
const minSeedsFloor = args['min-seeds'] !== undefined ? Number(args['min-seeds']) : 60;
if (!Number.isSafeInteger(minSeedsFloor) || minSeedsFloor < 1) {
  throw new Error('--min-seeds 必须为正整数');
}
const championPath = resolve(args.champion !== undefined ? process.cwd() : REPO_ROOT, args.champion ?? 'training/champions/champion.json');
const candidatePath = resolve(process.cwd(), args.candidate);

requireBuiltEngine();
const candidate = readJSONSafe(candidatePath);
const parameters = candidate.parameters ?? candidate;
if (!parameters?.id) throw new Error('候选文件缺少 parameters.id');
validateAIParameters(parameters); // 参数越界/缺字段一律拒绝，绝不带病晋级

const confirmation = candidate.confirmation;
const decision = confirmation?.decision;
if (!decision?.promote) {
  throw new Error(`候选 ${parameters.id} 缺少 promote=true 的确认挑战判定，禁止晋级（证据必须来自独立验证种子）`);
}

// ---- P1 复审：独立重算晋级判定，不信任自报结论 ----
const seedPairs = confirmation.seedPairs;
if (!Array.isArray(seedPairs) || seedPairs.length === 0) {
  throw new Error(`候选 ${parameters.id} 的确认挑战缺少逐种子配对证据（confirmation.seedPairs），无法独立核验，禁止晋级`);
}
for (const pair of seedPairs) {
  if (!Number.isSafeInteger(pair?.seed) || (pair.status !== 'finished' && pair.status !== 'anomaly')) {
    throw new Error(`confirmation.seedPairs 含非法条目：${JSON.stringify(pair)?.slice(0, 120)}`);
  }
  if (pair.status === 'finished' && typeof pair.diff !== 'number') {
    throw new Error(`confirmation.seedPairs 种子 ${pair.seed} 缺少分差字段 diff`);
  }
}
// 证据必须来自独立验证种子池，训练种子上的"胜过冠军"不构成晋级证据。
if (!Number.isSafeInteger(confirmation.seedBase) || confirmation.seedBase < VALIDATION_POOL_BASE || confirmation.seedBase >= VALIDATION_POOL_MAX) {
  throw new Error(`确认挑战种子基数 ${confirmation.seedBase} 不在验证种子池（[${VALIDATION_POOL_BASE}, ${VALIDATION_POOL_MAX})）内，证据无效，禁止晋级`);
}
// ---- P0 多重检验核验：按证据自报的挑战序号独立重算收紧后的判定 ----
// 长期重复挑战下，单次 95% 检验必然累积误晋级；晋级证据必须携带挑战序号
// （challengeIndex，来自验证账本 challengeCount），按几何 alpha 消耗重算。
const challengeIndex = confirmation.challengeIndex;
if (!Number.isSafeInteger(challengeIndex) || challengeIndex < 1) {
  throw new Error(`确认挑战证据缺少合法的 challengeIndex（多重检验 alpha 消耗防线），禁止晋级；请用新版 evolve-cli 重新生成证据`);
}
const alphaBudget = confirmation.alphaBudget;
if (alphaBudget !== PROMOTION_ALPHA_BUDGET) {
  throw new Error(`确认挑战证据的 alphaBudget ${alphaBudget} 与系统预算 ${PROMOTION_ALPHA_BUDGET} 不一致，无法核验，禁止晋级`);
}
// 账本交叉核对：候选文件同目录若带有账本（工作流归档的 evolve 产物必带），
// 挑战序号必须与账本 challengeCount 一致——防伪造更小的序号换取更宽松阈值。
const siblingLedgerPath = join(dirname(candidatePath), 'validation-ledger.json');
if (existsSync(siblingLedgerPath)) {
  const ledgerCount = validationChallengeCount(readJSON(siblingLedgerPath));
  if (ledgerCount !== challengeIndex) {
    throw new Error(`challengeIndex ${challengeIndex} 与随附验证账本的累计挑战次数 ${ledgerCount} 不一致，疑似伪造挑战序号，禁止晋级`);
  }
}
// 引擎指纹核验（P1 证据完整性）：证据必须产自与当前晋级环境一致的运行时产物。
// 引擎在证据生成后变更过 → 旧证据不适用，必须用新引擎重新确认挑战。
// 字段位置兼容：evolve-cli（权威生产者）把指纹/代码版本写在 candidate.json 顶层，
// confirmation 内写入为合法兼容布局；两处都缺失时按证据缺失处理（核验必然失败）。
const evidenceSha = confirmation.engineBundleSha256 ?? candidate.engineBundleSha256;
const evidenceCommit = confirmation.codeCommit ?? candidate.codeCommit;
const currentBundleSha256 = engineBundleSha256();
if (evidenceSha !== currentBundleSha256) {
  throw new Error(
    `确认挑战证据的运行时产物指纹与当前编译产物不一致` +
    `（证据 ${evidenceSha ?? '缺失'} ≠ 当前 ${currentBundleSha256}），` +
    `引擎已在证据生成后变更，旧证据不适用，须重新确认挑战后晋级`,
  );
}
if (!evidenceCommit) {
  console.error('警告：确认挑战证据缺少 codeCommit（代码版本），溯源能力降级；建议升级 evolve-cli 后重新生成证据');
}
// 样本量交叉核对：种子数、完成局数必须与逐种子证据自洽。
const finishedPairs = seedPairs.filter(p => p.status === 'finished');
if (confirmation.seeds !== seedPairs.length) {
  throw new Error(`自报种子数 ${confirmation.seeds} 与配对证据 ${seedPairs.length} 不一致，疑似篡改，禁止晋级`);
}
if (confirmation.games !== finishedPairs.length * 2) {
  throw new Error(`自报完成局数 ${confirmation.games} 与配对证据（${finishedPairs.length} 种子 × 2 局 = ${finishedPairs.length * 2}）不一致，疑似篡改，禁止晋级`);
}
// 用晋级门槛（而非候选自报门槛）+ 按挑战序号收紧的检验阈值，独立重算判定。
const threshold = alphaSpendingThreshold(challengeIndex, { alphaBudget });
const recalculated = pairedPromotionDecision({ seedPairs, minSeeds: minSeedsFloor, z: threshold.z });
if (!recalculated.promote) {
  throw new Error(`独立重算晋级判定未通过（${recalculated.verdict}）：${recalculated.reason}`);
}
// 自报结论与重算结论必须一致（CI 点估计逐位可复现，允差仅吸收浮点表示）。
if (decision.ci && recalculated.ci && Math.abs(decision.ci.point - recalculated.ci.point) > 1e-9) {
  throw new Error(`自报优势率 ${decision.ci.point} 与重算 ${recalculated.ci.point} 不一致，疑似篡改，禁止晋级`);
}
if (decision.verdict !== recalculated.verdict) {
  throw new Error(`自报判定 ${decision.verdict} 与重算 ${recalculated.verdict} 不一致，禁止晋级`);
}
// 自报检验阈值必须与按挑战序号重算的阈值一致（防自报宽松 z 混过判定）。
if (Number.isFinite(decision.z) && Math.abs(decision.z - threshold.z) > 1e-6) {
  throw new Error(`自报检验阈值 z=${decision.z} 与按挑战序号重算 z=${threshold.z.toFixed(6)} 不一致，禁止晋级`);
}

// ---- 归档候选（P0：目录不存在时必须先创建）----
const archiveDir = join(dirname(championPath), 'candidates');
ensureDir(archiveDir);
const archiveFile = join(archiveDir, `${parameters.id}.json`);
writeFileSync(archiveFile, JSON.stringify(candidate, null, 2) + '\n');

// ---- 同步冠军记录（P0：下一轮训练基准与正式游戏参数共用同一来源）----
const record = {
  id: parameters.id,
  name: `AI 4.0 冠军 ${parameters.id}`,
  description: `由自动进化训练晋级（基于 ${candidate.basedOn ?? '上一冠军'}）；确认挑战证据见 provenance.promotionEvidence。`,
  parameters,
  provenance: {
    basedOn: candidate.basedOn ?? null,
    promotedAt: new Date().toISOString().slice(0, 10),
    // 证据溯源（P1）：引擎/代码版本随冠军记录落盘，任何争议可按指纹重建复现。
    engineBundleSha256: currentBundleSha256,
    codeCommit: evidenceCommit ?? null,
    promotionEvidence: {
      ...confirmation,
      recalculated,
      verified: { challengeIndex, alpha: threshold.alpha, z: threshold.z, ledgerCrossChecked: existsSync(siblingLedgerPath) },
      recalculatedAt: new Date().toISOString(),
    },
    candidateArchive: `candidates/${parameters.id}.json`,
  },
};
writeFileSync(championPath, JSON.stringify(record, null, 2) + '\n');

console.log(`冠军已晋级：${parameters.id}`);
console.log(`  独立核验：${recalculated.reason}`);
console.log(`  冠军记录：${championPath}`);
console.log(`  候选归档：${archiveFile}`);
console.log('后续步骤：node training/scripts/apply-champion.mjs --champion ' + championPath);

function readJSONSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`候选文件不可读或非法 JSON：${path}（${error.message}）`);
  }
}
