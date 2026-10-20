#!/usr/bin/env node
/** 冠军晋级脚本（审计整改 P0）。
 *
 * 此前工作流只把候选复制到 training/champions/candidates/（目录还不存在，
 * 直接失败），且从不更新 training/champions/champion.json——新参数落地网页后，
 * 下一轮进化仍以旧冠军为基准，训练与正式游戏长期脱节。
 *
 * 本脚本在晋级 PR 流程中按顺序完成：
 * 1. 校验候选文件携带 promote=true 的确认挑战判定（无证据拒绝晋级）；
 * 2. 创建并归档候选到 training/champions/candidates/<id>.json；
 * 3. 同步更新 training/champions/champion.json（含挑战证据溯源），
 *    保证下一轮进化以新冠军为基准。
 *
 * 用法：node training/scripts/promote-champion.mjs --candidate <候选文件> \
 *         [--champion training/champions/champion.json]
 * 之后由 apply-champion.mjs 把参数写入 web-v1/src/ai/parameters.ts。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { ensureDir } from '../lib/io.mjs';
import { requireBuiltEngine, REPO_ROOT } from '../lib/paths.mjs';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[arg.slice(2)] = true;
    else { values[arg.slice(2)] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (!args.candidate) {
  console.error('必须提供 --candidate <候选文件>');
  process.exit(2);
}
const candidatePath = resolve(process.cwd(), args.candidate);
const championPath = resolve(args.champion !== undefined ? process.cwd() : REPO_ROOT, args.champion ?? 'training/champions/champion.json');

requireBuiltEngine();
const candidate = readJSONSafe(candidatePath);
const parameters = candidate.parameters ?? candidate;
if (!parameters?.id) throw new Error('候选文件缺少 parameters.id');
const decision = candidate.confirmation?.decision;
if (!decision?.promote) {
  throw new Error(`候选 ${parameters.id} 缺少 promote=true 的确认挑战判定，禁止晋级（证据必须来自独立验证种子）`);
}

// 1. 归档候选（P0：目录不存在时必须先创建）。
const archiveDir = join(dirname(championPath), 'candidates');
ensureDir(archiveDir);
const archiveFile = join(archiveDir, `${parameters.id}.json`);
writeFileSync(archiveFile, JSON.stringify(candidate, null, 2) + '\n');

// 2. 同步冠军记录（P0：下一轮训练基准与正式游戏参数共用同一来源）。
const record = {
  id: parameters.id,
  name: `AI 4.0 冠军 ${parameters.id}`,
  description: `由自动进化训练晋级（基于 ${candidate.basedOn ?? '上一冠军'}）；确认挑战证据见 provenance.promotionEvidence。`,
  parameters,
  provenance: {
    basedOn: candidate.basedOn ?? null,
    promotedAt: new Date().toISOString().slice(0, 10),
    promotionEvidence: candidate.confirmation ?? null,
    candidateArchive: `candidates/${parameters.id}.json`,
  },
};
writeFileSync(championPath, JSON.stringify(record, null, 2) + '\n');

console.log(`冠军已晋级：${parameters.id}`);
console.log(`  冠军记录：${championPath}`);
console.log(`  候选归档：${archiveFile}`);
console.log('后续步骤：node training/scripts/apply-champion.mjs --champion ' + championPath);
console.log(`晋级判定：${decision.reason}`);

function readJSONSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`候选文件不可读或非法 JSON：${path}（${error.message}）`);
  }
}
