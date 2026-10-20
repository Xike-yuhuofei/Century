#!/usr/bin/env node
/** 五人自动对战模拟器 CLI。
 *
 * 用法：
 *   node training/simulator/cli.mjs --games 100 --seed-base 1 [--out <dir>] [--versions <a.json,b.json,...>]
 *
 * versions 文件格式：JSON 数组，长度等于席位数，元素为 {id, parameters} 或 null（基线）。
 * 输出：<out>/summary.json 与 results.jsonl（逐局结果）。
 */
import { resolve } from 'node:path';
import { simulateGame, summarizeResults } from './simulate.mjs';
import { requireBuiltEngine, REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON, appendJSONL, ensureDir, readJSON, readJSONL } from '../lib/io.mjs';

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
const games = Number(args.games ?? 100);
const seedBase = Number(args['seed-base'] ?? 1);
const maxMoves = Number(args['max-moves'] ?? 1200);
const deadlineMs = Number(args['deadline-ms'] ?? 60000);
const outArg = args.out ?? 'training/reports/sim-latest';
if (!Number.isSafeInteger(games) || games < 1) throw new Error('--games 必须为正整数');
if (!Number.isSafeInteger(seedBase) || seedBase < 0) throw new Error('--seed-base 必须为非负整数');

requireBuiltEngine();

let versions = null;
if (args.versions) {
  versions = args.versions.split(',').map(path => {
    if (!path || path === 'none' || path === 'baseline') return null;
    return readJSON(resolve(process.cwd(), path));
  });
}

const outDir = resolve(args.out !== undefined ? process.cwd() : REPO_ROOT, outArg);
ensureDir(outDir);
const resultsPath = resolve(outDir, 'results.jsonl');
const started = performance.now();
for (let i = 0; i < games; i++) {
  const seed = seedBase + i;
  const result = simulateGame({
    seed, versions, maxMoves, deadlineMs,
    collectReplay: args['collect-replay'] === true || args['collect-replay'] === 'true'
      ? i < 5 : false, // 仅前几局附带完整复盘，控制体积
  });
  appendJSONL(resultsPath, result);
  process.stdout.write(`\r${i + 1}/${games} 局（最近一局 ${result.status}）`);
}
process.stdout.write('\n');
const summary = summarizeResults(readJSONL(resultsPath));
summary.wallMs = Number((performance.now() - started).toFixed(1));
summary.config = {
  games, seedBase, maxMoves, deadlineMs,
  versions: versions?.map(v => v?.id ?? 'baseline') ?? 'baseline',
};
writeJSON(resolve(outDir, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
console.log(`结果目录：${outDir}`);
