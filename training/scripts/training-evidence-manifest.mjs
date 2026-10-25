#!/usr/bin/env node
/** 训练证据清单：为一次 autonomous campaign 的完整产物生成 sha256 清单。
 *
 * 用途：仓库只提交摘要/清单，不把数百 MB 的逐局 JSON 全量入库；清单记录
 * 每个证据文件的相对路径、大小与 sha256，任何人可用本地原始产物复核。
 *
 * 用法：
 *   node training/scripts/training-evidence-manifest.mjs \
 *     --campaign ai8-12h-v2 [--out training/reports/autonomous/ai8-12h-v2/evidence-manifest.json]
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const campaign = arg('campaign');
if (!campaign || !/^[a-z0-9][a-z0-9._-]{2,95}$/i.test(campaign)) {
  console.error('必须提供合法的 --campaign <id>');
  process.exit(2);
}
const root = resolve(REPO_ROOT, 'training/reports/autonomous', campaign);
if (!existsSync(root)) {
  console.error(`campaign 目录不存在：${root}`);
  process.exit(2);
}
const outPath = resolve(process.cwd(), arg('out', join('training/reports/autonomous', campaign, 'evidence-manifest.json')));

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

const files = walk(root)
  .filter(path => !path.endsWith('evidence-manifest.json'))
  .sort()
  .map(path => ({
    path: relative(root, path).split('\\').join('/'),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  }));
const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

const state = existsSync(join(root, 'state.json'))
  ? JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  : null;
const summary = existsSync(join(root, 'run-summary.json'))
  ? JSON.parse(readFileSync(join(root, 'run-summary.json'), 'utf8'))
  : null;

const manifest = {
  schema: 'century-training-evidence-manifest-v1',
  generatedAt: new Date().toISOString(),
  campaignId: campaign,
  campaignStatus: state?.status ?? summary?.status ?? null,
  campaignCreatedAt: state?.createdAt ?? summary?.startedAt ?? null,
  elapsedMs: summary?.elapsedMs ?? null,
  rounds: summary?.rounds ?? state?.rounds?.length ?? null,
  games: summary?.budgetUsed?.games ?? state?.budgetUsed?.games ?? null,
  files: files.length,
  totalBytes,
  evidence: files,
  note: '清单覆盖该 campaign 目录下全部文件；原始逐局证据保留在生成机器上，仓库提交清单与摘要即可复核未篡改',
};
writeJSON(outPath, manifest);
console.log(JSON.stringify({
  ok: true, outPath, files: files.length, totalBytes,
  campaignStatus: manifest.campaignStatus, rounds: manifest.rounds, games: manifest.games,
}, null, 2));
