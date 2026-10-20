#!/usr/bin/env node
/** 冠军挑战 CLI。
 *
 * 用法：
 *   node training/tournament/challenge.mjs \
 *     --champion training/champions/champion.json \
 *     --candidate training/champions/candidates/xxx.json \
 *     --seeds 50 [--seed-base 1] [--out training/reports/challenge-latest]
 *
 * 参数文件格式：{ "id": "...", "parameters": {...} } 或直接 AIParameters 对象。
 */
import { resolve } from 'node:path';
import { challengeWithDecision } from './challenge.mjs';
import { requireBuiltEngine } from '../lib/paths.mjs';
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
const minGames = Number(args['min-games'] ?? 100);

const { summary, games } = challengeWithDecision({
  champion: champion.parameters,
  candidate: candidate.parameters,
  seeds, seedBase: Number(args['seed-base'] ?? 1),
  minGames,
  maxMoves: args['max-moves'] ? Number(args['max-moves']) : undefined,
  deadlineMs: args['deadline-ms'] ? Number(args['deadline-ms']) : undefined,
});

const outDir = resolve(process.cwd(), args.out ?? 'training/reports/challenge-latest');
ensureDir(outDir);
writeJSON(resolve(outDir, 'summary.json'), summary);
writeCSV(resolve(outDir, 'games.csv'), games.map(g => ({
  seed: g.seed, direction: g.direction, status: g.status,
  candidateWon: g.candidateWon ?? '',
  candidateMeanScore: g.candidateMeanScore ?? '',
  championMeanScore: g.championMeanScore ?? '',
  candidateMeanRank: g.candidateMeanRank ?? '',
  moves: g.moves ?? '',
})));
console.log(JSON.stringify(summary, null, 2));
console.log(`结果目录：${outDir}`);
