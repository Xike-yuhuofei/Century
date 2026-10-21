#!/usr/bin/env node
/** 冠军挑战 CLI。
 *
 * 用法：
 *   node training/tournament/challenge-cli.mjs \
 *     --champion training/champions/champion.json \
 *     --candidate training/champions/candidates/xxx.json \
 *     --seeds 50 [--seed-base 1] [--min-seeds 60] \
 *     [--opponents a.json,b.json] [--out training/reports/challenge-latest]
 *
 * 参数文件格式：{ "id": "...", "parameters": {...} } 或直接 AIParameters 对象。
 * --opponents：可选多样化对手池（逗号分隔参数文件）；缺省 = 仅冠军。
 * 晋级判定按种子配对统计（pairedPromotionDecision），min-seeds 为决定性种子下限。
 */
import { resolve } from 'node:path';
import { challengeWithDecision } from './challenge.mjs';
import { requireBuiltEngine, REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON, writeCSV, readJSON, ensureDir } from '../lib/io.mjs';

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
if (!args.champion || !args.candidate) throw new Error('必须提供 --champion 与 --candidate 参数文件');
requireBuiltEngine();

const loadVersion = path => {
  const data = readJSON(resolve(process.cwd(), path));
  // 版本文件两种形态：{id, parameters, structure?} 包装式，或 {id, structure?, ...params} 平铺式。
  return data.parameters
    ? { id: data.id, parameters: data.parameters, structure: data.structure }
    : { id: data.id, parameters: data, structure: data.structure };
};

const champion = loadVersion(args.champion);
const candidate = loadVersion(args.candidate);
const seeds = Number(args.seeds ?? 50);
if (!Number.isSafeInteger(seeds) || seeds < 1) throw Error('--seeds 必须为正整数');
const minSeeds = args['min-seeds'] !== undefined
  ? Number(args['min-seeds'])
  : Math.ceil(Number(args['min-games'] ?? 120) / 2);
// --challenge-index：本次挑战在系统中的累计序号（来自验证账本 challengeCount + 1）。
// 传入后按几何 alpha 消耗收紧检验阈值（多重检验防线）；不传维持 95% 单次检验，
// 但其结论缺少多重检验核验要素，不得作为晋级证据（promote-champion 会拒绝）。
const challengeIndex = args['challenge-index'] !== undefined ? Number(args['challenge-index']) : null;
if (challengeIndex !== null && (!Number.isSafeInteger(challengeIndex) || challengeIndex < 1)) {
  throw Error('--challenge-index 必须为 ≥ 1 的整数');
}
const opponents = args.opponents
  ? args.opponents.split(',').filter(Boolean).map(path => {
      const version = loadVersion(path);
      return version.parameters;
    })
  : null;

const { summary, games } = challengeWithDecision({
  champion: champion.parameters,
  candidate: candidate.parameters,
  seeds, seedBase: Number(args['seed-base'] ?? 1),
  minSeeds,
  opponents,
  challengeIndex,
  maxMoves: args['max-moves'] ? Number(args['max-moves']) : undefined,
  deadlineMs: args['deadline-ms'] ? Number(args['deadline-ms']) : undefined,
});

const outDir = resolve(args.out !== undefined ? process.cwd() : REPO_ROOT, args.out ?? 'training/reports/challenge-latest');
ensureDir(outDir);
writeJSON(resolve(outDir, 'summary.json'), summary);
writeCSV(resolve(outDir, 'games.csv'), games.map(g => ({
  seed: g.seed, direction: g.direction, status: g.status,
  candidateWon: g.candidateWon ?? '',
  candidateMeanScore: g.candidateMeanScore ?? '',
  opponentMeanScore: g.opponentMeanScore ?? '',
  candidateMeanRank: g.candidateMeanRank ?? '',
  moves: g.moves ?? '',
})));
writeCSV(resolve(outDir, 'seed-pairs.csv'), summary.seedPairs.map(p => ({
  seed: p.seed, status: p.status, diff: p.diff ?? '', anomalies: p.anomalies ?? 0,
})));
console.log(JSON.stringify(summary, null, 2));
console.log(`结果目录：${outDir}`);
