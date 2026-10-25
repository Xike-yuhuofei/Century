#!/usr/bin/env node
/** AI5 候选 66f6a296aa72 的正式冠军挑战编排。
 *
 * 流程（严格复用 AI 4.0 机制，不绕过任何防线）：
 * 1. 合并全部已知验证账本历史（正式 2 次 + 本地 3 次），本次 challengeIndex = 6，
 *    alpha 按几何消耗收紧（α₆ = 5%/2⁶）——宁可最严，不得伪造小序号；
 * 2. assertBlockFree 后消费下一个互不重叠的验证种子块（900M 池内）；
 * 3. 用 training/tournament/challenge.mjs 的 challengeWithDecision 跑 60 种子
 *    双向配对挑战（挑战种子全部来自验证池，与训练/快筛种子物理隔离）；
 * 4. 产出 promote-champion 兼容的 candidate.json（含 confirmation 逐种子证据 +
 *    challengeIndex + alphaBudget + engineBundleSha256 + codeCommit）与续接账本。
 *
 * 用法：node run-formal-challenge.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consumeLedger, VALIDATION_POOL_BASE } from '../../../training/lib/seeds.mjs';
import {
  loadSeedGovernance, nextFormalValidationBase, formalChallengeCount,
  assertFormalChallengeAllocation, reserveConsumption, completeConsumption,
  CENTRAL_REGISTRY_PATH,
} from '../../../training/lib/seed-governance.mjs';
import { challengeWithDecision } from '../../../training/tournament/challenge.mjs';
import { requireBuiltEngine, engineBundleSha256, buildProvenance, REPO_ROOT } from '../../../training/lib/paths.mjs';
import { validateAIParameters } from '../../../web-v1/dist/js/ai/parameters.js';
import { championParametersSha256 } from '../../../web-v1/scripts/build-hash.mjs';

const here = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const outDir = outArg
  ? resolve(process.cwd(), outArg)
  : resolve(here, '..', 'reports', 'challenge-readiness-efficiency-1000');
// AI7-A1：历史证据目录禁止被静默覆盖（重跑必须显式 --out 到新目录）。
if (!outArg && existsSync(resolve(outDir, 'candidate.json'))) {
  throw new Error('历史正式挑战证据已存在：禁止覆盖。新挑战必须显式 --out <新目录>，且经治理层分配新验证块');
}
mkdirSync(outDir, { recursive: true });
requireBuiltEngine();
const CODE_COMMIT_AT_START = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const ENGINE_BUNDLE_AT_START = engineBundleSha256();

// ---- 候选版本：官方 bundle 中的 readiness-efficiency 变体（div20 最优 17c6e43cae24） ----
const candidateParameters = {
  id: 'ai5-readiness-efficiency',
  structure: 'beam-rollout',                    // 与冠军同结构，隔离唯一变量
  acquisitionVariant: 'readiness-efficiency',
  engineWeight: 1, tempoWeight: 1, contestWeight: 1, synergyWeight: 1,
  goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
};
const validatedCandidateParameters = validateAIParameters(candidateParameters);
const CANDIDATE_PARAMETERS_SHA256 = championParametersSha256(validatedCandidateParameters);

const champion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const championParameters = champion.parameters;

// ---- 1. 统一跨系统种子治理（AI7-A1，fail-closed：任何账本缺失/冲突即拒绝） ----
const SEEDS = 1000;
const governance = loadSeedGovernance({ strict: true });
const seedBase = nextFormalValidationBase(governance);
const challengeIndex = formalChallengeCount(governance) + 1;
assertFormalChallengeAllocation({ registry: governance, base: seedBase, size: SEEDS, challengeIndex });
const experimentId = `openevolve-formal-${challengeIndex}`;
reserveConsumption({
  purposeClass: 'formal-challenge',
  purpose: 'openevolve-formal-challenge@5p',
  base: seedBase,
  size: SEEDS,
  experimentId,
  challengeIndex,
  evidencePath: outDir,
  codeCommit: CODE_COMMIT_AT_START,
  registryPath: CENTRAL_REGISTRY_PATH,
});
console.log(`治理层来源 ${governance.sources.length} 个，累计正式挑战 ${formalChallengeCount(governance)} 次 → 本次 challengeIndex=${challengeIndex}`);

// ---- 2. 分配并防重校验验证种子块 ----
// 样本量论证：α₉ ≈ 0.00977%（z≈3.89）下，按上轮正式挑战实测优势率 p≈0.567 反推，
// Wilson 下界 > 0.5 需要 n ≳ 830 决定性种子；1000 种子（含 ~2% 平局余量）是本次冲冠的最小充分样本。
console.log(`本次验证种子块：[${seedBase}, ${seedBase + SEEDS})（验证池起点 ${VALIDATION_POOL_BASE}）`);

// ---- 3. 正式挑战（500 种子 × 2 局 = 1000 局，双向配对 + 座位轮换 + 冠军独占对手） ----
const { summary, games } = challengeWithDecision({
  champion: championParameters,
  candidate: candidateParameters,
  seeds: SEEDS,
  seedBase,
  minSeeds: 60,
  challengeIndex,
});
console.log(JSON.stringify({
  verdict: summary.decision.verdict, reason: summary.decision.reason,
  paired: summary.paired, candidateWinRate: summary.candidateWinRate,
  anomalyRate: summary.anomalyRate,
}, null, 2));

// ---- 4. 产出晋级脚本兼容的 candidate.json + 续接账本 ----
const formalHistory = governance.entries
  .filter(e => e.countsTowardChallengeIndex === true)
  .map(e => ({ base: e.base, size: e.size, at: e.rawAt ?? null }));
const ledger = consumeLedger(
  { history: formalHistory, challengeCount: formalChallengeCount(governance) },
  seedBase,
  SEEDS,
  { challengeIndex, purpose: 'openevolve-formal-challenge@5p', experimentId, source: 'run-formal-challenge' },
);
completeConsumption(experimentId, {
  status: 'completed',
  evidencePath: outDir,
  note: `decision=${summary.decision.verdict} challengeIndex=${challengeIndex}`,
  registryPath: CENTRAL_REGISTRY_PATH,
});
writeFileSync(resolve(outDir, 'candidate.json'), JSON.stringify({
  id: candidateParameters.id,
  name: 'AI5 多样性轮进化候选 readiness-efficiency（17c6e43cae24）',
  description: 'OpenEvolve 多样性轮自动进化的商人卡获取估值变体：以 readiness（可负担度）为核心的多因子估值。' +
    '变体实现已注册进官方 bundle（acquisitionVariant 参数轴），挑战走 AI 4.0 正式流程。',
  basedOn: champion.id,
  parameters: candidateParameters,
  confirmation: {
    seeds: SEEDS, games: summary.finishedGames,
    seedBase,
    challengeIndex,
    alphaBudget: summary.decision.alphaBudget,
    paired: summary.paired,
    seedPairs: summary.seedPairs,
    firstPlace: summary.firstPlace,
    winRate: summary.candidateWinRate, pairedDiff: summary.pairedDiffCI,
    ci: summary.decision.ci, decision: summary.decision,
    seatCount: 5,
  },
  ...buildProvenance(),
  engineBundleSha256: ENGINE_BUNDLE_AT_START,
  championParametersSha256: CANDIDATE_PARAMETERS_SHA256,
  codeCommit: CODE_COMMIT_AT_START,
  seatCount: 5,
  seatEvidence: [{
    seatCount: 5,
    seeds: SEEDS,
    seedBase,
    challengeIndex,
    engineBundleSha256: ENGINE_BUNDLE_AT_START,
    sourceClosureSha256: buildProvenance().sourceClosureSha256,
    decisionSourceSha256: buildProvenance().decisionSourceSha256,
    decisionArtifactSha256: buildProvenance().decisionArtifactSha256,
    championParametersSha256: CANDIDATE_PARAMETERS_SHA256,
    codeCommit: CODE_COMMIT_AT_START,
    decision: summary.decision,
    seedPairs: summary.seedPairs,
  }],
  seatCoverage: {
    required: [2, 3, 4, 5],
    covered: [5],
    complete: false,
    note: '单次挑战只覆盖 5 人局；2–4 人必须独立成次挑战后才可晋级',
  },
  promotionEligible: false,
  governance: {
    schema: governance.schema,
    purposeClass: 'formal-challenge',
    challengeIndex,
    formalChallengeCount: formalChallengeCount(governance),
    registeredInCentral: true,
    experimentId,
  },
  generatedAt: new Date().toISOString(),
}, null, 2));
writeFileSync(resolve(outDir, 'validation-ledger.json'), JSON.stringify(ledger, null, 2));
writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`证据目录：${outDir}`);
