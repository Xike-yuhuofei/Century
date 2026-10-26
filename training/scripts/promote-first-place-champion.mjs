#!/usr/bin/env node
/** P0/P4：冠军晋级（唯一主目标 = 2–5 人第一名率）。
 *
 * 与旧 promote-champion.mjs 的关系：
 * - 旧脚本的判据是「配对得分优势率」，已降级为历史复现工具；
 * - 本脚本只接受 run-first-place-challenge.mjs 产出的
 *   century-first-place-formal-challenge-v1 证据，且不信任自报判定——
 *   一律从逐种子原始配对证据独立重算；
 * - 晋级必须同时满足：预注册计划一致、固定样本、种子治理登记、alpha 账本
 *   预留/结果一致、构建身份一致、2–5 人主检验 + 非劣效全部通过。
 *
 * 用法：
 *   node training/scripts/promote-first-place-champion.mjs \
 *     --evidence <dir>/challenge-evidence.json \
 *     --plan <dir>/preregistration.json \
 *     --candidate <dir>/candidate.json [--dry-run]
 *     # 已落地冠军 PR 的复核模式（champion.json 已是候选本身）：
 *     --post-apply
 *
 * 退出码：0=晋级记录已写入 / post-apply 复核通过；3=不晋级（保留冠军）；1=证据/治理错误（fail-closed）。
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureDir, readJSON } from '../lib/io.mjs';
import { REPO_ROOT, buildProvenance, requireBuiltEngine } from '../lib/paths.mjs';
import { loadPreregistration, assertValidationSeeds } from '../evaluator/preregistration.mjs';
import { firstPlacePromotionDecision } from '../evaluator/first-place.mjs';
import { readAlphaLedger, ALPHA_LEDGER_PATH, assertAlphaLedgerIntegrity } from '../lib/alpha-ledger.mjs';
import {
  loadSeedGovernance, assertPromotionEvidenceRegistered, formalChallengeCount,
} from '../lib/seed-governance.mjs';
import { sha256Canonical, canonicalJSON } from '../evolution/core.mjs';
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
for (const required of ['evidence', 'plan', 'candidate']) {
  if (!args[required]) {
    console.error(`必须提供 --${required}`);
    process.exit(2);
  }
}
const dryRun = args['dry-run'] === true;
const postApply = args['post-apply'] === true;
const baseChampionPath = args['base-champion'] !== undefined
  ? resolve(process.cwd(), args['base-champion'])
  : null;
const baseChampionRef = args['base-champion-ref'] !== undefined
  ? String(args['base-champion-ref'])
  : null;
const evidencePath = resolve(process.cwd(), args.evidence);
const planPath = resolve(process.cwd(), args.plan);
const candidatePath = resolve(process.cwd(), args.candidate);
const championPath = resolve(args.champion !== undefined ? process.cwd() : REPO_ROOT, args.champion ?? 'training/champions/champion.json');
const alphaLedgerPath = args['alpha-ledger'] !== undefined
  ? resolve(process.cwd(), args['alpha-ledger'])
  : ALPHA_LEDGER_PATH;
const centralRegistryPath = args['governance-central'] !== undefined
  ? resolve(process.cwd(), String(args['governance-central']))
  : undefined;

requireBuiltEngine();
const currentProvenance = buildProvenance();
const evidence = readJSON(evidencePath);
const plan = loadPreregistration(planPath);
// 统计计划冻结的最小样本下限：任何预注册计划都不能低于 60 独立种子/人数。
// 否则 8 局全胜即可得到下界 1，但真实假阳性率 1/256 远高于 alpha 预算。
const MIN_FORMAL_SEEDS_PER_SEAT = 60;
if (!(Number(plan.minSeedsPerSeatCount) >= MIN_FORMAL_SEEDS_PER_SEAT)) {
  throw new Error(`预注册 minSeedsPerSeatCount=${String(plan.minSeedsPerSeatCount)} 低于硬下限 ${MIN_FORMAL_SEEDS_PER_SEAT}——拒绝晋级`);
}
for (const [seatCount, window] of Object.entries(plan.seatWindows ?? {})) {
  if (!(Number(window?.count) >= MIN_FORMAL_SEEDS_PER_SEAT)) {
    throw new Error(`${seatCount} 人层预注册种子数 ${String(window?.count)} 低于硬下限 ${MIN_FORMAL_SEEDS_PER_SEAT}——拒绝晋级`);
  }
}
const candidateDoc = readJSON(candidatePath);
const championDoc = readJSON(championPath);

if (evidence.schema !== 'century-first-place-formal-challenge-v1') {
  throw new Error(`证据 schema 非法：${String(evidence.schema)}（只接受第一名率正式挑战证据；旧配对得分优势率证据不得晋级）`);
}
if (evidence.planHash !== plan.planHash) {
  throw new Error(`证据 planHash ${evidence.planHash} ≠ 预注册计划 ${plan.planHash}——证据不属于该计划`);
}
if (evidence.planId !== plan.planId) throw new Error('证据 planId 与预注册计划不一致');
if (evidence.challengeIndex !== plan.challengeIndex) throw new Error('证据 challengeIndex 与预注册计划不一致');
const planWorkUnits = plan.searchWorkUnits ?? null;
if (evidence.searchWorkUnits !== planWorkUnits) {
  throw new Error(`证据 searchWorkUnits ${String(evidence.searchWorkUnits)} ≠ 预注册 ${String(planWorkUnits)}——搜索预算不得在读取结果后改变`);
}
const recomputedEvidenceHash = sha256Canonical({
  planHash: plan.planHash,
  searchWorkUnits: planWorkUnits,
  runs: evidence.runs.map(r => ({ seatCount: r.seatCount, pairs: r.pairs })),
  decision: evidence.decision,
});
if (recomputedEvidenceHash !== evidence.evidenceHash) {
  throw new Error(`证据 evidenceHash 与内容不一致（记录 ${evidence.evidenceHash} ≠ 复算 ${recomputedEvidenceHash}）——证据被篡改`);
}

const candidateParameters = candidateDoc.parameters ?? candidateDoc;
const validated = validateAIParameters(candidateParameters);
const candidate = {
  id: validated.id,
  parametersSha256: championParametersSha256(validated),
  sourceHash: candidateDoc.sourceHash ?? sha256Canonical(validated),
  artifactHash: candidateDoc.artifactHash ?? sha256Canonical(candidateDoc),
};
if (candidate.id !== plan.candidate.id) throw new Error('候选 id 与预注册不一致');
if (candidate.parametersSha256 !== plan.candidate.parametersSha256) {
  throw new Error(`候选参数哈希 ${candidate.parametersSha256.slice(0, 12)} ≠ 预注册 ${plan.candidate.parametersSha256.slice(0, 12)}`);
}
if (candidate.sourceHash !== plan.candidate.sourceHash) throw new Error('候选源码哈希与预注册不一致（候选在验证后被修改）');
if (candidate.artifactHash !== plan.candidate.artifactHash) throw new Error('候选产物哈希与预注册不一致');

// post-apply 必须能读取 origin/main 的基线冠军，防止 PR 伪造 plan/evidence/ledger
// 后把任意参数“晋级”。在 CI 中传 --base-champion-ref origin/main；测试可传文件。
function loadBaseChampion() {
  if (baseChampionPath) {
    if (!existsSync(baseChampionPath)) throw new Error(`基线冠军文件不存在：${baseChampionPath}`);
    return readJSON(baseChampionPath);
  }
  if (baseChampionRef) {
    try {
      const text = execFileSync('git', ['show', `${baseChampionRef}:training/champions/champion.json`], {
        encoding: 'utf8', cwd: REPO_ROOT,
      });
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`无法读取基线冠军 ${baseChampionRef}:training/champions/champion.json：${String(error.stderr ?? error.message).slice(0, 300)}`);
    }
  }
  return null;
}

const championParameters = championDoc.parameters ?? championDoc;
if (postApply) {
  // 已落地冠军 PR 复核模式：champion.json 已经是候选本身，不能再要求
  // 当前冠军 == 预注册冻结冠军（那是挑战前状态的检查，放在 else 分支）。
  // 这里改为验证「落地内容 == 预注册候选」以及「基线冠军 == origin/main」。
  if (championParameters.id !== candidate.id) {
    throw new Error(`落地冠军 ${String(championParameters.id)} ≠ 预注册候选 ${candidate.id}`);
  }
  const appliedSha = championParametersSha256(validateAIParameters(championParameters));
  if (appliedSha !== plan.candidate.parametersSha256) {
    throw new Error('落地冠军参数哈希与预注册候选不一致（PR 落地了错误的参数）');
  }
  if (candidate.id === plan.champion.id) {
    throw new Error('候选与基线冠军相同——禁止空晋级');
  }
  const baseDoc = loadBaseChampion();
  if (!baseDoc) {
    throw new Error('post-apply 必须提供 --base-champion 或 --base-champion-ref（禁止无基线复核）');
  }
  const baseParameters = baseDoc.parameters ?? baseDoc;
  if (baseParameters.id !== plan.champion.id) {
    throw new Error(`基线冠军 ${String(baseParameters.id)} ≠ 预注册冻结冠军 ${plan.champion.id}（main 已被替换）`);
  }
  const baseSha = championParametersSha256(validateAIParameters(baseParameters));
  if (baseSha !== plan.champion.parametersSha256) {
    throw new Error('基线冠军参数哈希与预注册不一致（plan 被伪造或 main 已变化）');
  }
  const provenance = championDoc?.provenance ?? {};
  if (provenance.basedOn !== plan.champion.id) {
    throw new Error(`落地冠军 basedOn=${String(provenance.basedOn)} ≠ 预注册基线冠军 ${plan.champion.id}`);
  }
  const pe = provenance.promotionEvidence;
  if (!pe) throw new Error('落地冠军缺少 provenance.promotionEvidence——不能证明由本证据晋级');
  if (pe.planId !== plan.planId || pe.planHash !== plan.planHash
    || pe.challengeIndex !== plan.challengeIndex || pe.evidenceHash !== evidence.evidenceHash) {
    throw new Error('落地冠军 provenance 与预注册计划/证据不一致');
  }
} else {
  const currentChampion = {
    id: championParameters.id,
    parametersSha256: championParametersSha256(validateAIParameters(championParameters)),
    artifactHash: currentProvenance.decisionArtifactSha256,
  };
  if (currentChampion.id !== plan.champion.id) {
    throw new Error(`当前冠军 ${currentChampion.id} ≠ 预注册冻结冠军 ${plan.champion.id}（冠军在挑战期间被替换）`);
  }
  if (currentChampion.parametersSha256 !== plan.champion.parametersSha256) {
    throw new Error('当前冠军参数与预注册不一致');
  }
  if (currentChampion.artifactHash !== plan.champion.artifactHash) {
    throw new Error('当前冠军决策产物与预注册不一致（构建已变化，需重新挑战）');
  }
}
if (plan.engine) {
  // 决策核心身份（不含冠军参数生成区）是晋级前后必须一致的部分；
  // 全量 bundle/源码闭包会因 apply-champion 写入参数区而合理变化，不能用于拒绝。
  if (plan.engine.decisionSourceSha256) {
    if (plan.engine.decisionSourceSha256 !== currentProvenance.decisionSourceSha256) {
      throw new Error('决策核心源码在挑战后发生变化（decisionSourceSha256 不符）——旧证据不适用');
    }
  }
  if (!postApply && plan.engine.decisionArtifactSha256) {
    if (plan.engine.decisionArtifactSha256 !== currentProvenance.decisionArtifactSha256) {
      throw new Error('决策核心产物在挑战后发生变化（decisionArtifactSha256 不符）——旧证据不适用');
    }
  }
  // 全量身份只做披露：若尚未落地参数区，必须完全一致；已落地时允许参数区差异。
  if (plan.engine.engineBundleSha256 !== currentProvenance.engineBundleSha256) {
    console.warn('提示：全量引擎 bundle 已变化（参数区落地所致属预期）；决策核心身份已单独核验。');
  }
}

// ---- 逐种子证据：必须与预注册窗口逐字节一致 ----
const strata = [];
const seedsBySeatCount = {};
for (const seatCount of plan.seatCounts) {
  const run = evidence.runs.find(r => r.seatCount === seatCount);
  if (!run) throw new Error(`证据缺少 ${seatCount} 人层`);
  const window = plan.seatWindows[String(seatCount)];
  const expectedSeeds = Array.from({ length: window.count }, (_, i) => window.base + i);
  const observedSeeds = run.pairs.map(p => p.seed).sort((a, b) => a - b);
  if (observedSeeds.length !== expectedSeeds.length || observedSeeds.some((s, i) => s !== expectedSeeds[i])) {
    throw new Error(`${seatCount} 人层种子与预注册窗口不一致（固定样本/种子治理失败）`);
  }
  seedsBySeatCount[String(seatCount)] = expectedSeeds;
  strata.push({ seatCount, pairs: run.pairs });
}
assertValidationSeeds({ plan, seedsBySeatCount });

// ---- 独立重算判定（不信任自报） ----
const alpha = plan.alphaBudget / 2 ** plan.challengeIndex;
const recomputed = firstPlacePromotionDecision({
  strata,
  weights: plan.weights,
  alpha,
  margin: plan.nonInferiorityMargin,
  minSeeds: plan.minSeedsPerSeatCount,
  requiredSeatCounts: plan.seatCounts,
});
if (!recomputed.promote) {
  console.log(JSON.stringify({ verdict: 'NOT_PROMOTED', reasons: recomputed.reasons }, null, 2));
  process.exit(3);
}
if (!evidence.decision?.promote) {
  throw new Error('证据自报不晋级但重算通过——证据内部不一致，拒绝晋级');
}
if (evidence.decision.alpha !== alpha) throw new Error('证据 alpha 与预注册 alpha 不一致');
if (Math.abs((evidence.decision.pooled?.mean ?? NaN) - (recomputed.pooled?.mean ?? NaN)) > 1e-9) {
  throw new Error('证据加权增量与独立重算不一致');
}
for (const stratum of recomputed.strata) {
  const self = evidence.decision.strata.find(s => s.seatCount === stratum.seatCount);
  if (!self?.ci || !stratum.ci) throw new Error(`${stratum.seatCount} 人层缺少区间证据`);
  if (Math.abs(self.ci.mean - stratum.ci.mean) > 1e-9 || Math.abs(self.ci.lower - stratum.ci.lower) > 1e-9) {
    throw new Error(`${stratum.seatCount} 人层自报区间与独立重算不一致`);
  }
}

// ---- alpha 账本：预留 + 结果必须一致 ----
const alphaLedger = readAlphaLedger(alphaLedgerPath);
assertAlphaLedgerIntegrity(alphaLedger);
const reservation = alphaLedger.reservations.find(r => r.challengeIndex === plan.challengeIndex);
if (!reservation) throw new Error(`alpha 账本缺少 challengeIndex=${plan.challengeIndex} 的预留——禁止晋级`);
if (reservation.planId !== plan.planId) throw new Error('alpha 预留 planId 与预注册计划不一致');
if (Math.abs(reservation.alpha - alpha) > 1e-12) throw new Error('alpha 预留值与预注册 alpha 不一致');
const outcome = alphaLedger.outcomes.find(o => o.challengeIndex === plan.challengeIndex);
if (!outcome) throw new Error('alpha 账本缺少该次挑战的结果记录——挑战未正常收尾');
if (outcome.decision !== 'promote') throw new Error(`alpha 账本结果为 ${outcome.decision}，与晋级判定冲突`);
if (outcome.evidenceHash !== evidence.evidenceHash) throw new Error('alpha 账本 evidenceHash 与证据文件不一致');

// ---- 种子治理：证据区间必须已登记且用途隔离 ----
const governance = loadSeedGovernance({
  strict: true,
  ...(centralRegistryPath ? { centralRegistryPath } : {}),
});
const seatEvidence = plan.seatCounts.map(seatCount => ({
  seatCount,
  seeds: plan.seatWindows[String(seatCount)].count,
  seedBase: plan.seatWindows[String(seatCount)].base,
  challengeIndex: plan.challengeIndex,
}));
const governanceCheck = assertPromotionEvidenceRegistered({
  registry: governance,
  seatEvidence,
  // 新协议：2–5 人同属一次预注册挑战，共享一个 challengeIndex / 一次 alpha 消耗。
  allowSharedChallengeIndex: true,
});
if (governanceCheck.totalChallenges !== plan.challengeIndex) {
  throw new Error(`治理层累计正式挑战 ${governanceCheck.totalChallenges} ≠ 本次 challengeIndex ${plan.challengeIndex}`);
}

// ---- 历史不可变：同名归档/同 id 冠军禁止覆盖 ----
const archiveDir = join(dirname(championPath), 'candidates');
const archiveFile = join(archiveDir, `${candidate.id}.json`);
if (existsSync(archiveFile)) {
  const existing = readJSON(archiveFile);
  if (canonicalJSON(existing) !== canonicalJSON(candidateDoc)) {
    throw new Error(`同名晋级归档已存在且内容不同：${archiveFile}——历史算法版本不可变`);
  }
} else if (postApply) {
  throw new Error(`落地冠军 PR 缺少候选归档：${archiveFile}`);
}
if (!postApply && (championDoc?.parameters?.id === candidate.id || championDoc?.id === candidate.id)) {
  throw new Error(`冠军 ${candidate.id} 已是当前活动冠军：禁止重新晋级覆盖 provenance`);
}

const record = {
  id: candidate.id,
  name: `Century AI 冠军 ${candidate.id}`,
  description: `由 2–5 人第一名率正式挑战晋级（基于 ${championDoc.parameters?.id ?? '上一冠军'}）；证据见 provenance.promotionEvidence。`,
  parameters: validated,
  provenance: {
    basedOn: championDoc.parameters?.id ?? null,
    promotedAt: new Date().toISOString().slice(0, 10),
    engineBundleSha256: currentProvenance.engineBundleSha256,
    sourceClosureSha256: currentProvenance.sourceClosureSha256,
    decisionSourceSha256: currentProvenance.decisionSourceSha256,
    decisionArtifactSha256: currentProvenance.decisionArtifactSha256,
    championParametersSha256: candidate.parametersSha256,
    codeCommit: plan.engine?.codeCommit ?? currentProvenance.buildGitCommit,
    build: {
      schema: currentProvenance.buildManifestSchema,
      generatedAt: currentProvenance.buildGeneratedAt,
      gitCommit: currentProvenance.buildGitCommit,
      gitDirty: currentProvenance.buildGitDirty,
      artifact: currentProvenance.engineBundleSha256,
      decisionArtifact: currentProvenance.decisionArtifactSha256,
      source: currentProvenance.sourceClosureSha256,
      decisionSource: currentProvenance.decisionSourceSha256,
      championParameters: candidate.parametersSha256,
    },
    promotionEvidence: {
      schema: evidence.schema,
      metric: 'pairedFirstPlaceRateDelta',
      primaryObjective: 'firstPlaceWinRate',
      planId: plan.planId,
      planHash: plan.planHash,
      challengeIndex: plan.challengeIndex,
      alpha,
      alphaBudget: plan.alphaBudget,
      nonInferiorityMargin: plan.nonInferiorityMargin,
      searchWorkUnits: planWorkUnits,
      weights: plan.weights,
      seatCounts: plan.seatCounts,
      seatWindows: plan.seatWindows,
      opponents: plan.opponents,
      evidenceHash: evidence.evidenceHash,
      evidencePath: evidencePath,
      decision: recomputed,
      recalculated: recomputed,
      selfReportedDecision: evidence.decision,
      artifactHash: candidate.artifactHash,
      sourceHash: candidate.sourceHash,
      engineBundleSha256: currentProvenance.engineBundleSha256,
      sourceClosureSha256: currentProvenance.sourceClosureSha256,
      decisionSourceSha256: currentProvenance.decisionSourceSha256,
      decisionArtifactSha256: currentProvenance.decisionArtifactSha256,
      championParametersSha256: candidate.parametersSha256,
      governance: {
        schema: governance.schema,
        sources: governance.sources.length,
        formalChallengeCount: formalChallengeCount(governance),
        conflicts: governance.conflicts.length,
      },
      alphaLedger: {
        challengeIndex: plan.challengeIndex,
        reservation,
        outcome,
      },
      verifiedAt: new Date().toISOString(),
    },
    candidateArchive: `candidates/${candidate.id}.json`,
  },
};

const verdict = { verdict: 'PROMOTE', candidateId: candidate.id, planHash: plan.planHash, challengeIndex: plan.challengeIndex };
if (postApply) {
  console.log(JSON.stringify({
    verdict: 'VERIFY_APPLIED',
    mode: 'post-apply',
    candidateId: candidate.id,
    appliedChampion: championParameters.id,
    basedOn: plan.champion.id,
    planHash: plan.planHash,
    evidenceHash: evidence.evidenceHash,
    challengeIndex: plan.challengeIndex,
  }, null, 2));
  process.exit(0);
}
if (dryRun) {
  console.log(JSON.stringify({ ...verdict, dryRun: true, record }, null, 2));
  process.exit(0);
}

ensureDir(archiveDir);
if (!existsSync(archiveFile)) writeFileSync(archiveFile, JSON.stringify(candidateDoc, null, 2) + '\n');
writeFileSync(championPath, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(verdict, null, 2));
console.log(`冠军记录：${championPath}`);
console.log(`候选归档：${archiveFile}`);
console.log('下一步（机器门禁，无需人工批准）：node training/scripts/apply-champion.mjs --champion training/champions/champion.json && cd web-v1 && npm run build && node training/scripts/apply-champion.mjs --check');
