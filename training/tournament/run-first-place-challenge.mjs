#!/usr/bin/env node
/** P0：2–5 人第一名率正式挑战（唯一可产生冠军晋级证据的入口）。
 *
 * 与旧 run-formal-challenge-js5.mjs 的差异（全部为收紧/迁移）：
 * - 主统计量改为「配对第一名率增量」（旧脚本的配对得分优势率仅保留历史复现）；
 * - 一次挑战覆盖 2/3/4/5 人，每个人数使用独立种子子块（同一保留区间内切分，
 *   种子不重叠、不跨人数复用）；
 * - 读取结果前先落盘预注册计划（planHash 锁定候选/冠军/对手/种子/口径）；
 * - alpha 同时写入几何消耗账本（append-only，不可重置）；
 * - 所有席位使用正式引擎，候选与冻结冠军在同一焦点席位配对比较。
 *
 * 用法（干跑，不消费种子/不写账本）：
 *   node training/tournament/run-first-place-challenge.mjs \
 *     --candidate <candidate.json> --seeds-per-seat 250 --dry-run
 *
 * 正式执行（会消费验证池、alpha 与种子登记）：
 *   node training/tournament/run-first-place-challenge.mjs \
 *     --candidate <candidate.json> --seeds-per-seat 250 --out training/reports/fp-challenge-c12
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJSON } from '../lib/io.mjs';
import {
  REPO_ROOT, requireBuiltEngine, buildProvenance,
} from '../lib/paths.mjs';
import {
  loadSeedGovernance, nextFormalValidationBase, formalChallengeCount,
  assertFormalChallengeAllocation, reserveConsumption, completeConsumption,
  CENTRAL_REGISTRY_PATH,
} from '../lib/seed-governance.mjs';
import { VALIDATION_POOL_BASE } from '../lib/seeds.mjs';
import { reserveAlpha, completeAlpha, ALPHA_LEDGER_PATH } from '../lib/alpha-ledger.mjs';
import {
  createPreregistration, lockPreregistration, REQUIRED_SEAT_COUNTS, DEFAULT_SEARCH_WORK_UNITS,
} from '../evaluator/preregistration.mjs';
import { sha256Canonical } from '../evolution/core.mjs';
import { validateArtifact } from '../evolution/candidate-artifact.mjs';
import { loadCompiledCandidateModules } from '../evolution/multi-module-candidate.mjs';
import { buildRegistry } from '../adversarial/registry.mjs';
import { runPreregisteredFirstPlaceChallenge } from './first-place-challenge.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { championParametersSha256 } from '../../web-v1/scripts/build-hash.mjs';

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
if (!args.candidate) {
  console.error('必须提供 --candidate <candidate.json>');
  process.exit(2);
}
const dryRun = args['dry-run'] === true;
const seedsPerSeat = args['seeds-per-seat'] !== undefined ? Number(args['seeds-per-seat']) : 250;
if (!Number.isSafeInteger(seedsPerSeat) || seedsPerSeat < 2 || seedsPerSeat > 2000) {
  throw new Error(`--seeds-per-seat 必须为 2–2000 的整数，实际：${seedsPerSeat}`);
}
const seatOffset = args['seat-offset'] !== undefined ? Number(args['seat-offset']) : 0;
if (!Number.isSafeInteger(seatOffset) || seatOffset < 0 || seatOffset > 4) throw new Error('--seat-offset 必须在 0..4');
const maxMoves = args['max-moves'] !== undefined ? Number(args['max-moves']) : 1200;
const deadlineMs = args['deadline-ms'] !== undefined ? Number(args['deadline-ms']) : 300_000;
const workUnits = args['work-units'] !== undefined ? Number(args['work-units']) : DEFAULT_SEARCH_WORK_UNITS;
if (!Number.isSafeInteger(workUnits) || workUnits < 1 || workUnits > 4096) {
  throw new Error(`--work-units 必须为 1–4096 的整数，实际：${workUnits}`);
}
const outDir = resolve(process.cwd(), args.out ?? `training/reports/fp-challenge-${Date.now()}`);
const candidatePath = resolve(process.cwd(), args.candidate);

requireBuiltEngine();
const provenance = buildProvenance();
const codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT }).trim();

const championDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const champion = championDoc.parameters;
if (!champion?.id) throw new Error('冠军文件缺少 parameters.id');

const candidateDoc = JSON.parse(readFileSync(candidatePath, 'utf8'));
// AI9 编译型多模块候选：artifact 自带完整 ESM 决策包；必须独立加载为候选模块实例，
// 与官方冻结冠军模块实例互不共享状态。加载前先做 artifact 全哈希复核。
const compiledCandidate = candidateDoc.buildArtifact?.compiled === true
  && Array.isArray(candidateDoc.source?.modules) && candidateDoc.source.modules.length > 0;
let executorA = null;
let loadedExecutor = null;
if (compiledCandidate) {
  validateArtifact(candidateDoc);
  loadedExecutor = await loadCompiledCandidateModules(candidateDoc);
  executorA = { aiModule: loadedExecutor.aiModule, jointModule: loadedExecutor.jointModule };
}
const candidateParameters = compiledCandidate
  ? candidateDoc.parameters?.values
  : (candidateDoc.parameters ?? candidateDoc);
if (!candidateParameters?.id) throw new Error('候选文件缺少 parameters.id');
const validatedCandidate = validateAIParameters(candidateParameters);
// search-control 候选：联合搜索配置必须随候选进入正式挑战（否则候选与冠军同行为，
// 挑战将退化为"自己打自己"）。算法结构中的逐人数配置是候选行为的一部分。
const candidateJointOptions = candidateDoc.algorithmStructure?.jointOptionsByPlayerCount ?? null;
const candidateForRun = {
  ...validatedCandidate,
  ...(candidateJointOptions ? { jointOptionsByPlayerCount: candidateJointOptions } : {}),
};
const candidateIdentity = {
  id: validatedCandidate.id,
  parametersSha256: championParametersSha256(validatedCandidate),
  sourceHash: candidateDoc.sourceHash ?? sha256Canonical(validatedCandidate),
  artifactHash: candidateDoc.artifactHash ?? sha256Canonical(candidateDoc),
};
const championIdentity = {
  id: champion.id,
  parametersSha256: championParametersSha256(validateAIParameters(champion)),
  artifactHash: provenance.decisionArtifactSha256,
};

// 冻结对手阵容：历史冠军 + 风格族 + 中立基线（不含候选/现任冠军，不含 random-legal）。
const registry = buildRegistry();
const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const opponents = OPPONENT_IDS.map(id => {
  const descriptor = registry.versions[id];
  if (!descriptor) throw new Error(`对手未注册：${id}`);
  return { ...descriptor.parameters, id: descriptor.id };
}).filter(o => o.id !== candidateIdentity.id && o.id !== champion.id);
if (opponents.length === 0) throw new Error('对手阵容为空（候选/冠军过滤后）');

const governance = loadSeedGovernance({ strict: true });
const challengeIndex = formalChallengeCount(governance) + 1;
const totalSeeds = seedsPerSeat * REQUIRED_SEAT_COUNTS.length;
const base = nextFormalValidationBase(governance);
assertFormalChallengeAllocation({ registry: governance, base, size: totalSeeds, challengeIndex });

const seatWindows = Object.fromEntries(REQUIRED_SEAT_COUNTS.map((seatCount, index) => [
  String(seatCount),
  { base: base + index * seedsPerSeat, count: seedsPerSeat },
]));

const planId = args['plan-id'] ?? `fp-${candidateIdentity.id}-c${challengeIndex}`;
const plan = createPreregistration({
  planId,
  candidate: candidateIdentity,
  champion: championIdentity,
  opponents: opponents.map(o => ({ id: o.id, fingerprint: sha256Canonical(o) })),
  seatWindows,
  challengeIndex,
  minSeedsPerSeatCount: Math.min(seedsPerSeat, 60),
  maxSeedsPerSeatCount: seedsPerSeat,
  searchWorkUnits: workUnits,
  engine: {
    engineBundleSha256: provenance.engineBundleSha256,
    sourceClosureSha256: provenance.sourceClosureSha256,
    decisionSourceSha256: provenance.decisionSourceSha256,
    decisionArtifactSha256: provenance.decisionArtifactSha256,
    codeCommit,
  },
});

const planSummary = {
  planId: plan.planId,
  planHash: plan.planHash,
  challengeIndex,
  base,
  totalSeeds,
  seedsPerSeat,
  searchWorkUnits: workUnits,
  seatWindows,
  candidate: candidateIdentity,
  champion: championIdentity,
  opponents: plan.opponents,
  alpha: plan.alphaBudget / 2 ** challengeIndex,
  engine: plan.engine,
};

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, ...planSummary }, null, 2));
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const planPath = resolve(outDir, 'preregistration.json');
const locked = lockPreregistration({ plan, dir: outDir, writeJSON });
console.log(`预注册计划已锁定：${planPath}（alreadyLocked=${locked.alreadyLocked}）`);

// alpha 预留必须在读取正式验证结果之前；种子也必须在动用前登记。
const alphaReservation = reserveAlpha({
  challengeIndex,
  planId: plan.planId,
  candidateId: candidateIdentity.id,
  evidenceDir: outDir,
  ledgerPath: ALPHA_LEDGER_PATH,
});
console.log(`alpha 已预留：α_${challengeIndex}=${alphaReservation.alpha}（累计预算 ${alphaReservation.alphaBudget}）`);
const experimentId = `fp-formal-${candidateIdentity.id}-c${challengeIndex}`;
reserveConsumption({
  purposeClass: 'formal-challenge',
  purpose: `first-place-formal-challenge@2-5p`,
  base,
  size: totalSeeds,
  experimentId,
  challengeIndex,
  evidencePath: outDir,
  codeCommit,
  registryPath: CENTRAL_REGISTRY_PATH,
});
console.log(`验证种子区间已登记并占用：[${base}, ${base + totalSeeds})（${seedsPerSeat}/人数）`);

let evidence = null;
let runtimeError = null;
try {
  evidence = runPreregisteredFirstPlaceChallenge({
    plan,
    champion,
    candidate: candidateForRun,
    opponents,
    engine: plan.engine,
    seatOffset,
    maxMoves,
    deadlineMs,
    workUnits,
    executorA,
    recomputeIdentity: () => {
      // 编译型候选：执行前后都必须复核 artifact 全哈希（源码/模块/编译产物）。
      if (compiledCandidate) validateArtifact(candidateDoc);
      return {
        parametersSha256: championParametersSha256(validatedCandidate),
        sourceHash: candidateDoc.sourceHash ?? sha256Canonical(validatedCandidate),
        artifactHash: candidateDoc.artifactHash ?? sha256Canonical(candidateDoc),
      };
    },
  });
} catch (error) {
  runtimeError = error;
} finally {
  const decision = evidence?.decision;
  completeAlpha({
    challengeIndex,
    planId: plan.planId,
    decision: decision?.promote ? 'promote' : runtimeError ? 'aborted' : 'not-promoted',
    evidenceHash: evidence?.evidenceHash ?? null,
    ledgerPath: ALPHA_LEDGER_PATH,
  });
  completeConsumption(experimentId, {
    status: runtimeError ? 'voided' : 'completed',
    note: runtimeError ? String(runtimeError.message).slice(0, 500) : decision?.verdict ?? 'completed',
    evidencePath: outDir,
    registryPath: CENTRAL_REGISTRY_PATH,
  });
  if (loadedExecutor) loadedExecutor.cleanup();
}
if (runtimeError) throw runtimeError;

writeJSON(resolve(outDir, 'challenge-evidence.json'), evidence);
writeJSON(resolve(outDir, 'candidate.json'), {
  ...candidateDoc,
  parameters: compiledCandidate
    ? { ...candidateDoc.parameters, values: validatedCandidate }
    : validatedCandidate,
  planHash: plan.planHash,
  challengeIndex,
  decision: evidence.decision,
});

console.log(`\n判定：${evidence.decision.promote ? 'PROMOTE' : 'NOT-PROMOTED'}（${evidence.decision.verdict}）`);
for (const stratum of evidence.decision.strata) {
  const ci = stratum.ci;
  console.log(`  ${stratum.seatCount}p：delta=${ci ? ci.mean.toFixed(4) : 'n/a'} 下界=${ci ? ci.lower.toFixed(4) : 'n/a'} n=${stratum.uniqueSeeds}`);
}
if (evidence.decision.pooled?.status === 'analyzed') {
  console.log(`  加权：delta=${evidence.decision.pooled.mean.toFixed(4)} 下界=${evidence.decision.pooled.lower.toFixed(4)}`);
}
if (evidence.decision.reasons.length) console.log(`  未通过原因：${evidence.decision.reasons.join('；')}`);
console.log(`证据：${resolve(outDir, 'challenge-evidence.json')}`);

process.exit(evidence.decision.promote ? 0 : 3);
