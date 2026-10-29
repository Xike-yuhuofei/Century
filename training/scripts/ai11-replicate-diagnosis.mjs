#!/usr/bin/env node
/** P1.3：失败归因的独立新种子复现（replication）。
 *
 * 取一个 campaign 的既有候选 artifact，在一个**从未使用过**的 AI9 开发深验窗口上
 * 重新做配对评估（同种子/同对手/同焦点席位，A=候选 B=冻结冠军），再用同一套
 * 预注册阈值（minSamplesPerStratum）重新判定。用途：
 * - 验证 6h 运行中"样本不足 → inconclusive"的某层弱点是否能被独立种子复现；
 * - 复现结论写入研究索引与跨进程研究记忆，供下一代研究检索。
 *
 * 边界：
 * - 只使用开发池（AI9 deep block），不触碰正式验证种子；
 * - 种子窗口在动用前原子登记；已登记窗口不会被再次使用；
 * - 结论只针对配对观测；单场胜负不升级为因果。
 *
 * 用法：
 *   node training/scripts/ai11-replicate-diagnosis.mjs \
 *     --campaign ai11-6h-v4 --candidate cand-ai9-crossover-r30c4-031feb \
 *     --seeds-per-count 8 [--out training/reports/ai11-replication]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { createLiveGovernanceProviderAI9 } from '../evolution/governance-provider-v2.mjs';
import { evaluateCompiledCandidateGames } from '../evolution/compiled-game-evaluator.mjs';
import { diagnosePairedEvidence } from '../evolution/failure-diagnosis.mjs';
import { createResearchIndex } from '../evolution/research-index.mjs';
import { openResearchMemory } from '../evolution/research-memory.mjs';
import { AI9_DEV_BLOCKS } from '../evolution/core.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}
const campaign = String(arg('campaign', ''));
const candidateArg = String(arg('candidate', ''));
if (!campaign || !candidateArg) {
  console.error('必须指定 --campaign 与 --candidate');
  process.exit(2);
}
const seedsPerCount = Number(arg('seeds-per-count', 8));
if (!Number.isSafeInteger(seedsPerCount) || seedsPerCount < 4 || seedsPerCount > 64) {
  console.error('--seeds-per-count 必须为 4..64 的整数');
  process.exit(2);
}
const workUnits = Number(arg('work-units', 32));
const replicationRound = Number(arg('round', 500));
const playerCounts = [2, 3, 4, 5];

const root = resolve(REPO_ROOT, 'training/reports/coevolution', campaign);
const statePath = join(root, 'state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const candidate = state.rounds.flatMap(r => r.candidates ?? []).find(c => c.candidateId === candidateArg);
if (!candidate) {
  console.error(`campaign ${campaign} 中找不到候选 ${candidateArg}`);
  process.exit(2);
}
const artifactPath = resolve(REPO_ROOT, candidate.artifactPath);
if (!existsSync(artifactPath)) {
  console.error(`候选 artifact 不存在：${artifactPath}`);
  process.exit(2);
}
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

const usedDeepWindows = state.rounds
  .map(r => r.seedWindows?.deep?.windowId)
  .filter(Boolean);
const provider = createLiveGovernanceProviderAI9();
const window = provider.allocateDevSeedWindow({
  campaignId: `${campaign}-replication`,
  round: replicationRound,
  purpose: 'deep',
  count: seedsPerCount * playerCounts.length,
  excludeWindowIds: usedDeepWindows,
});

const seedsByPlayerCount = {};
let offset = 0;
for (const count of playerCounts) {
  seedsByPlayerCount[count] = Array.from({ length: seedsPerCount }, (_, i) => window.base + offset + i);
  offset += seedsPerCount;
}

console.log(JSON.stringify({
  campaign, candidateId: candidateArg, window: window.windowId, base: window.base,
  seedsPerCount, games: seedsPerCount * playerCounts.length * 2,
}, null, 2));

const started = Date.now();
const evidence = await evaluateCompiledCandidateGames({
  artifact,
  seedsByPlayerCount,
  purpose: 'deep',
  round: replicationRound,
  playerCounts,
  blocks: AI9_DEV_BLOCKS,
  workUnits,
  deadlineMs: 60_000,
  maxMoves: 500,
});
const elapsedMs = Date.now() - started;

const { summary } = diagnosePairedEvidence({
  evidence,
  candidateId: candidateArg,
  minSamplesPerStratum: seedsPerCount,
});

const outDir = arg('out', null)
  ? resolve(REPO_ROOT, String(arg('out')))
  : resolve(root, 'replication');
mkdirSync(outDir, { recursive: true });
const evidencePath = join(outDir, `replication-evidence-${candidateArg}.json`);
const diagnosisPath = join(outDir, `replication-diagnosis-${candidateArg}.json`);
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
writeFileSync(diagnosisPath, JSON.stringify(summary, null, 2));

const index = createResearchIndex({ path: join(root, 'research-index.jsonl'), campaignId: campaign });
index.evaluation({
  candidateId: candidateArg,
  stage: 'replication',
  evidence,
  seedWindow: { ...window, replicationOf: candidate.deep?.evidencePath ?? null },
});
for (const failureCase of summary.failureCases) {
  index.failureCase({
    candidateId: candidateArg,
    stage: 'replication',
    category: failureCase.category,
    status: failureCase.status,
    detail: failureCase.detail,
    evidencePath,
  });
}

const memory = openResearchMemory({ path: join(root, 'research-memory.jsonl') });
for (const failureCase of summary.failureCases) {
  memory.recordFailure({
    candidateId: candidateArg,
    seatCount: failureCase.seatCount,
    phase: null,
    category: `replication:${failureCase.category}`,
    detail: failureCase.detail,
    status: failureCase.status,
    reproducible: summary.strata[String(failureCase.seatCount)]?.verdict === 'supported',
  });
}

const verdicts = Object.fromEntries(
  Object.entries(summary.strata).map(([seatCount, s]) => [seatCount, {
    pairs: s.pairs,
    verdict: s.verdict,
    championWinFlips: s.championWinFlips,
    candidateWinFlips: s.candidateWinFlips,
    meanActionDistance: s.meanActionDistance,
  }]),
);
const supported = Object.values(summary.strata).some(s => s.verdict === 'supported');
const report = {
  schema: 'century-ai11-replication-v1',
  generatedAt: new Date().toISOString(),
  campaign,
  candidateId: candidateArg,
  artifactPath: candidate.artifactPath,
  sourceHash: candidate.sourceHash,
  seedWindow: { ...window, replicationOf: candidate.deep?.evidencePath ?? null },
  seedsPerCount,
  playerCounts,
  pairs: summary.pairs,
  games: evidence.metrics?.totalGames ?? null,
  elapsedMs,
  evidencePath,
  diagnosisPath,
  verdicts,
  supported,
  failureCases: summary.failureCases,
  note: '独立开发池新种子复现；结论只针对配对观测，不构成因果；不触碰正式验证种子',
};
const reportPath = join(outDir, `replication-report-${candidateArg}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, verdicts, supported }, null, 2));
