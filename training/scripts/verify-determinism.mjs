#!/usr/bin/env node
/** P3：确定性验收（固定源码 + 参数 + 种子 + 席位 + 对手 + workUnits）。
 *
 * 口径：
 * - 决策搜索使用固定 workUnits（不是墙钟预算），消除机器负载对展开顺序的影响；
 * - 每种人数使用独立种子子块（同一种子不跨人数复用）；
 * - 每个世界完整执行两轮，逐局比对：状态、排名、分数、行动轨迹哈希。
 *
 * 用法：
 *   node training/scripts/verify-determinism.mjs [--worlds 50] [--seat-counts 2,3,4,5] \
 *     [--seed-base 1600000000] [--out training/reports/determinism/report.json]
 *
 * 注意：完整 50 世界 × 4 人数 × 2 轮 = 400 局；小样本运行只用于脚本自检。
 */

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir, writeJSON } from '../lib/io.mjs';
import { REPO_ROOT, requireBuiltEngine } from '../lib/paths.mjs';
import { simulateGame } from '../simulator/simulate.mjs';
import { sha256Canonical } from '../evolution/core.mjs';
import { buildRegistry } from '../adversarial/registry.mjs';
import { readFileSync } from 'node:fs';

requireBuiltEngine();

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const worlds = args.worlds !== undefined ? Number(args.worlds) : 50;
const seatCounts = args['seat-counts'] ? String(args['seat-counts']).split(',').map(Number) : [2, 3, 4, 5];
const seedBase = args['seed-base'] !== undefined ? Number(args['seed-base']) : 1_600_000_000;
const outPath = resolve(process.cwd(), args.out ?? 'training/reports/determinism/report.json');
const WORK_UNITS = 32;

const championDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const champion = championDoc.parameters;
const registry = buildRegistry();

function versionsForTest(seatCount) {
  // 候选与三个对手都显式使用固定 workUnits（确定性优先），焦点席位轮换。
  const opponentParams = [
    { ...registry.versions['ai5-readiness-efficiency'].parameters, id: 'det-opponent-ai5' },
    { ...registry.versions['style-engine'].parameters, id: 'det-opponent-engine' },
    { ...registry.versions['neutral-baseline'].parameters, id: 'det-opponent-neutral' },
  ];
  const championVersion = {
    id: champion.id,
    parameters: champion,
    ...(champion.adapter ? {
      adapter: champion.adapter,
      jointVersion: champion.jointVersion,
      budgetMs: champion.budgetMs,
      jointOptions: { workUnits: WORK_UNITS },
    } : {}),
  };
  const opponents = opponentParams.map(p => ({
    id: p.id, parameters: p,
    ...(p.adapter ? { adapter: p.adapter, jointVersion: p.jointVersion, jointOptions: { workUnits: WORK_UNITS } } : {}),
  }));
  return { championVersion, opponents };
}

function traceHash(result) {
  return createHash('sha256').update(JSON.stringify(result.actions ?? [])).digest('hex');
}

function runWorld({ seed, seatCount, worldIndex }) {
  const { championVersion, opponents } = versionsForTest(seatCount);
  const focusSeat = worldIndex % seatCount;
  const versions = Array.from({ length: seatCount }, (_, seat) => {
    if (seat === focusSeat) return championVersion;
    const before = seat < focusSeat ? seat : seat - 1;
    return opponents[before % opponents.length];
  });
  const result = simulateGame({
    seed,
    versions,
    seatCount,
    maxMoves: 1200,
    deadlineMs: 600_000,
    collectActions: true,
  });
  return {
    seed,
    seatCount,
    focusSeat,
    status: result.status,
    reason: result.reason ?? null,
    winnerSeat: result.winnerSeat ?? null,
    ranking: result.ranking.map(r => ({ seat: r.seat, score: r.score, golems: r.golems })),
    moves: result.moves,
    actions: result.actions ?? [],
    traceHash: traceHash(result),
  };
}

/** 确定性证据必须绑定到实际执行代码：commit、工作区状态与决策/模拟器文本身份。 */
function codeIdentity() {
  const files = [
    'training/scripts/verify-determinism.mjs',
    'training/simulator/simulate.mjs',
    'training/evolution/core.mjs',
    'training/adversarial/registry.mjs',
    'training/champions/champion.json',
    'web-v1/dist/build-manifest.json',
  ];
  const hashes = {};
  for (const path of files) {
    hashes[path] = createHash('sha256').update(readFileSync(resolve(REPO_ROOT, path))).digest('hex');
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  }).trim().length > 0;
  return { commit, dirty, files: hashes };
}

const code = codeIdentity();
const report = {
  schema: 'century-determinism-report-v1',
  generatedAt: new Date().toISOString(),
  code,
  engine: {
    commit: requireBuiltEngine().manifest.gitCommit,
    artifact: requireBuiltEngine().manifest.artifact.sha256,
    source: requireBuiltEngine().manifest.source.sha256,
  },
  workUnits: WORK_UNITS,
  worldsPerSeatCount: worlds,
  seatCounts,
  seedBase,
  strata: [],
  mismatches: [],
};

for (const [seatIndex, seatCount] of seatCounts.entries()) {
  const base = seedBase + seatIndex * 10_000;
  const seeds = Array.from({ length: worlds }, (_, i) => base + i);
  const round1 = seeds.map((seed, i) => runWorld({ seed, seatCount, worldIndex: i }));
  const round2 = seeds.map((seed, i) => runWorld({ seed, seatCount, worldIndex: i }));
  const stratumMismatches = [];
  for (let i = 0; i < seeds.length; i++) {
    const a = round1[i];
    const b = round2[i];
    const comparable = {
      status: a.status === b.status,
      reason: a.reason === b.reason,
      winnerSeat: a.winnerSeat === b.winnerSeat,
      ranking: sha256Canonical(a.ranking) === sha256Canonical(b.ranking),
      moves: a.moves === b.moves,
      trace: a.traceHash === b.traceHash,
    };
    if (Object.values(comparable).some(v => v === false)) {
      stratumMismatches.push({ seed: a.seed, mismatches: Object.entries(comparable).filter(([, v]) => !v).map(([k]) => k) });
    }
  }
  report.strata.push({
    seatCount,
    seeds,
    games: seeds.length * 2,
    finished: round1.filter(r => r.status === 'finished').length,
    mismatches: stratumMismatches.length,
    traceHashes: round1.slice(0, 3).map(r => r.traceHash),
  });
  report.mismatches.push(...stratumMismatches.map(m => ({ seatCount, ...m })));
}

report.verdict = report.mismatches.length === 0 ? 'PASS' : 'FAIL';
ensureDir(resolve(outPath, '..'));
writeJSON(outPath, report);
console.log(JSON.stringify({
  verdict: report.verdict,
  worldsPerSeatCount: worlds,
  strata: report.strata.map(s => ({ seatCount: s.seatCount, games: s.games, mismatches: s.mismatches })),
  mismatches: report.mismatches.slice(0, 5),
  out: outPath,
}, null, 2));
process.exit(report.verdict === 'PASS' ? 0 : 1);
