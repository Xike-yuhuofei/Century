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
  return data.parameters ? data : { id: data.id, parameters: data };
};

const champion = loadVersion(args.champion);
const candidate = loadVersion(args.candidate);
const seeds = Number(args.seeds ?? 50);
if (!Number.isSafeInteger(seeds) || seeds < 1) throw Error('--seeds 必须为正整数');
const minSeeds = args['min-seeds'] !== undefined
  ? Number(args['min-seeds'])
  : Math.ceil(Number(args['min-games'] ?? 120) / 2);
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
