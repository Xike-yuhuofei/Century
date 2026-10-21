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
 * 3. 校验候选参数合法性（validateAIParameters）；
 * 4. 创建并归档候选到 training/champions/candidates/<id>.json；
 * 5. 同步更新 training/champions/champion.json（含挑战证据溯源），
 *    保证下一轮进化以新冠军为基准。
 *
 * 用法：node training/scripts/promote-champion.mjs --candidate <候选文件> \
 *         [--champion training/champions/champion.json] [--min-seeds 60]
 * --min-seeds：晋级时决定性种子的最低门槛（默认 60）；重算时即使候选自报
 * 更低门槛也按本门槛执行，防止用小样本证据混过晋级。
 * 之后由 apply-champion.mjs 把参数写入 web-v1/src/ai/parameters.ts。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { ensureDir } from '../lib/io.mjs';
import { requireBuiltEngine, REPO_ROOT } from '../lib/paths.mjs';
import { pairedPromotionDecision } from '../evaluator/stats.mjs';
import { VALIDATION_POOL_BASE } from '../lib/seeds.mjs';
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
if (!Number.isSafeInteger(confirmation.seedBase) || confirmation.seedBase < VALIDATION_POOL_BASE) {
  throw new Error(`确认挑战种子基数 ${confirmation.seedBase} 不在验证种子池（>= ${VALIDATION_POOL_BASE}）内，证据无效，禁止晋级`);
}
// 样本量交叉核对：种子数、完成局数必须与逐种子证据自洽。
const finishedPairs = seedPairs.filter(p => p.status === 'finished');
if (confirmation.seeds !== seedPairs.length) {
  throw new Error(`自报种子数 ${confirmation.seeds} 与配对证据 ${seedPairs.length} 不一致，疑似篡改，禁止晋级`);
}
if (confirmation.games !== finishedPairs.length * 2) {
  throw new Error(`自报完成局数 ${confirmation.games} 与配对证据（${finishedPairs.length} 种子 × 2 局 = ${finishedPairs.length * 2}）不一致，疑似篡改，禁止晋级`);
}
// 用晋级门槛（而非候选自报门槛）独立重算判定。
const recalculated = pairedPromotionDecision({ seedPairs, minSeeds: minSeedsFloor });
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
    promotionEvidence: { ...confirmation, recalculated, recalculatedAt: new Date().toISOString() },
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
