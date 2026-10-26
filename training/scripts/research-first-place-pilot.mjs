#!/usr/bin/env node
/** 研究池独立复现工具（P0 诊断；不产生正式晋级证据）。
 *
 * 用途：正式挑战前，用正式配对设计（A/B 同焦点席位、同 seed、同冻结对手、
 * 固定 workUnits）在 AI5 研究块 [300M,400M) 上检查候选/冠军的第一名率增量。
 *
 * 纪律：
 * - 只允许研究块，拒绝正式验证池 [900M,∞) 与 AI7 开发池；
 * - 不消费 alpha、不写 alpha 账本、不登记正式挑战种子、不触发晋级；
 * - 输出明确 formalEvidence=false；候选与冠军身份/对手池指纹全部记录；
 * - 同一候选应使用互不重叠的独立种子块做复现，避免选择偏差假阳性。
 *
 * 用法：
 *   node training/scripts/research-first-place-pilot.mjs \
 *     --candidate <artifact.json> --seed-base 300010120 --seeds-per-seat 30 \
 *     --out training/reports/first-place-promotion/research-pilot.json
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT, requireBuiltEngine } from '../lib/paths.mjs';
import { AI5_RESEARCH_BLOCK } from '../lib/seeds.mjs';
import { buildRegistry } from '../adversarial/registry.mjs';
import { sha256Canonical } from '../evolution/core.mjs';
import { runFirstPlaceChallengeBundle } from '../tournament/first-place-challenge.mjs';

const DEFAULT_WORK_UNITS = 64;
const MIN_SEEDS = 10;
const MAX_SEEDS = 500;

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`无法识别的参数：${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (!args.candidate) {
  console.error('必须提供 --candidate <candidate.json>');
  process.exit(2);
}
const seedsPerSeat = args['seeds-per-seat'] !== undefined ? Number(args['seeds-per-seat']) : 30;
if (!Number.isSafeInteger(seedsPerSeat) || seedsPerSeat < MIN_SEEDS || seedsPerSeat > MAX_SEEDS) {
  throw new Error(`--seeds-per-seat 必须为 ${MIN_SEEDS}–${MAX_SEEDS} 的整数`);
}
const seedBase = args['seed-base'] !== undefined ? Number(args['seed-base']) : 300_010_120;
if (!Number.isSafeInteger(seedBase)) throw new Error('--seed-base 必须为整数');
const totalSeeds = seedsPerSeat * 4;
const [RESEARCH_START, RESEARCH_END] = AI5_RESEARCH_BLOCK;
if (seedBase < RESEARCH_START || seedBase + totalSeeds > RESEARCH_END) {
  throw new Error(`研究种子区间 [${seedBase}, ${seedBase + totalSeeds}) 超出 AI5 研究块 [${RESEARCH_START}, ${RESEARCH_END})`);
}
const workUnits = args['work-units'] !== undefined ? Number(args['work-units']) : DEFAULT_WORK_UNITS;
if (!Number.isSafeInteger(workUnits) || workUnits < 1 || workUnits > 4096) {
  throw new Error('--work-units 必须为 1–4096 的整数');
}
const maxMoves = args['max-moves'] !== undefined ? Number(args['max-moves']) : 1200;
const deadlineMs = args['deadline-ms'] !== undefined ? Number(args['deadline-ms']) : 300_000;
const outPath = resolve(process.cwd(), args.out ?? 'training/reports/first-place-promotion/research-pilot.json');
const candidatePath = resolve(process.cwd(), args.candidate);

requireBuiltEngine();
const championDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const champion = championDoc.parameters;
if (!champion?.id) throw new Error('冠军文件缺少 parameters.id');

const candidateDoc = JSON.parse(readFileSync(candidatePath, 'utf8'));
const candidate = candidateDoc.parameters?.values ?? candidateDoc.parameters ?? candidateDoc;
if (!candidate?.id) throw new Error('候选文件缺少 parameters.id');
const candidateJointOptions = candidateDoc.algorithmStructure?.jointOptionsByPlayerCount ?? null;
const candidateForRun = {
  ...candidate,
  ...(candidateJointOptions ? { jointOptionsByPlayerCount: candidateJointOptions } : {}),
};

const registry = buildRegistry();
const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const opponents = OPPONENT_IDS.map(id => {
  const descriptor = registry.versions[id];
  if (!descriptor) throw new Error(`对手未注册：${id}`);
  return { ...descriptor.parameters, id: descriptor.id };
}).filter(o => o.id !== candidateForRun.id && o.id !== champion.id);

const seatPlans = [2, 3, 4, 5].map((seatCount, i) => ({
  seatCount,
  seeds: Array.from({ length: seedsPerSeat }, (_, j) => seedBase + i * seedsPerSeat + j),
}));
const started = Date.now();
const { runs, decision } = runFirstPlaceChallengeBundle({
  champion, candidate: candidateForRun, opponents, seatPlans,
  weights: { 2: 0.25, 3: 0.25, 4: 0.25, 5: 0.25 },
  alpha: 0.05, margin: 0.02, minSeeds: seedsPerSeat,
  maxMoves, deadlineMs, workUnits,
});
const elapsedMs = Date.now() - started;
const doc = {
  schema: 'century-research-first-place-pilot-v1',
  generatedAt: new Date().toISOString(),
  formalEvidence: false,
  purpose: '研究池独立复现：检查候选/冻结冠军在正式配对设计下的加权第一名率增量是否可在独立种子块复现',
  candidateId: candidateForRun.id,
  candidateSourceHash: candidateDoc.sourceHash ?? null,
  candidateArtifactHash: candidateDoc.artifactHash ?? null,
  championId: champion.id,
  championParametersSha256: sha256Canonical(champion),
  design: {
    seatCounts: [2, 3, 4, 5],
    seedsPerSeatCount: seedsPerSeat,
    seedBase,
    seedBlocks: Object.fromEntries(seatPlans.map(p => [String(p.seatCount), [p.seeds[0], p.seeds.at(-1)]])),
    seedPool: `AI5 研究块 [${RESEARCH_START},${RESEARCH_END})；非正式验证池`,
    workUnits,
    maxMoves,
    deadlineMs,
    primaryMetric: 'pairedFirstPlaceRateDelta',
    opponents: opponents.map(o => ({ id: o.id, fingerprint: sha256Canonical(o) })),
  },
  elapsedMs,
  totalGames: runs.reduce((s, r) => s + r.totalGames, 0),
  seatCounts: runs.map(run => ({
    seatCount: run.seatCount,
    totalGames: run.totalGames,
    uniqueSeeds: run.uniqueSeeds,
    anomalyGames: run.anomalyGames,
    anomalyRate: run.anomalyRate,
    pairs: run.pairs,
  })),
  decision,
  note: '研究筛查，不消费正式 alpha/验证种子，不写正式账本，不参与冠军晋级；formalEvidence=false',
};
writeJSON(outPath, doc);
console.log(JSON.stringify({
  out: outPath, elapsedMs, candidateId: candidateForRun.id, totalGames: doc.totalGames,
  perSeat: decision.strata.map(s => ({ seatCount: s.seatCount, mean: s.mean, lower: s.lower, status: s.status })),
  pooled: decision.pooled,
  nonInferiority: decision.nonInferiority,
  promote: decision.promote,
  verdict: decision.verdict,
  reasons: decision.reasons,
}, null, 2));
