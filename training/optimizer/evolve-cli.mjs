#!/usr/bin/env node
/** 参数进化训练 CLI（含断点续训与时间预算控制）。
 *
 * 用法：
 *   node training/optimizer/evolve-cli.mjs --generations 3 --population 8 \
 *     --games-per-candidate 20 --time-budget-min 40 [--resume training/reports/evolve-latest/state.json]
 *
 * 流程：进化（训练种子）→ 最佳候选用独立验证种子确认挑战 → 达标则输出候选文件供 PR。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { evolve } from './evolve.mjs';
import { challengeWithDecision } from '../tournament/challenge.mjs';
import { requireBuiltEngine } from '../lib/paths.mjs';
import { writeJSON, appendJSONL, readJSON, ensureDir } from '../lib/io.mjs';

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

const outDir = resolve(process.cwd(), args.out ?? 'training/reports/evolve-latest');
const startedAt = Date.now();
const timeBudgetMs = (Number(args['time-budget-min'] ?? 45) * 60 - 60) * 1000; // 预留 1 分钟收尾
const remaining = () => timeBudgetMs - (Date.now() - startedAt);

const championFile = resolve(process.cwd(), args.champion ?? 'training/champions/champion.json');
const championEntry = readJSON(championFile);
const champion = championEntry.parameters ?? championEntry;
if (!champion.id) throw new Error('冠军文件缺少 id 或 parameters');

const generations = Number(args.generations ?? 3);
const population = Number(args.population ?? 8);
const gamesPerCandidate = Number(args['games-per-candidate'] ?? 20);
const confirmSeeds = Number(args['confirm-seeds'] ?? 50);

let initialState = null;
if (args.resume && existsSync(resolve(process.cwd(), args.resume))) {
  initialState = readJSON(resolve(process.cwd(), args.resume));
  console.error(`恢复断点：第 ${initialState.generation} 代之后继续`);
}

ensureDir(outDir);
const logPath = resolve(outDir, 'experiments.jsonl');
const result = evolve({
  champion,
  initialState,
  generations,
  population,
  gamesPerCandidate,
  eliteKeep: Number(args['elite-keep'] ?? 3),
  sigma: Number(args.sigma ?? 0.18),
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
};

// 时间预算允许时，用独立验证种子对最佳候选做确认挑战（训练/验证种子隔离）。
if (result.improved && remaining() > 120_000) {
  const validationSeedBase = 900000000;
  const { summary } = challengeWithDecision({
    champion, candidate: result.bestCandidate,
    seeds: confirmSeeds, seedBase: validationSeedBase,
    minGames: Number(args['min-games'] ?? 100),
  });
  report.confirmation = summary;
  appendJSONL(logPath, { type: 'confirmation', candidateId: result.bestCandidate.id, seedBase: validationSeedBase, summary });
  if (summary.decision.promote) {
    const candidateFile = resolve(outDir, 'candidate.json');
    writeJSON(candidateFile, {
      id: result.bestCandidate.id,
      basedOn: champion.id,
      parameters: result.bestCandidate,
      confirmation: {
        seeds: confirmSeeds, games: summary.finishedGames,
        winRate: summary.candidateWinRate, ci: summary.winCI,
        decision: summary.decision,
      },
      generatedAt: new Date().toISOString(),
    });
    report.candidateFile = candidateFile;
    console.error(`候选参数已通过确认挑战：${candidateFile}`);
  } else {
    console.error(`确认挑战未达标：${summary.decision.reason}`);
  }
} else if (result.improved) {
  console.error('时间预算不足，跳过确认挑战；候选仅完成快速筛选');
}

report.wallMs = Date.now() - startedAt;
writeJSON(resolve(outDir, 'report.json'), report);
console.log(JSON.stringify(report, null, 2));
console.log(`结果目录：${outDir}`);
