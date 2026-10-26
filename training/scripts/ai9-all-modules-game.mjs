#!/usr/bin/env node
/** 12 模块联合候选的真实对局证据（开发池，不是正式晋级证据）。
 *
 * 目的：证明"12 个模块都装进同一个候选后，候选仍能控制真实 2–5 人对局席位"，
 * 与探针/接线测试互补；不声称棋力提升。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { createLiveGovernanceProviderAI9 } from '../evolution/governance-provider-v2.mjs';
import { evaluateCompiledCandidateGames } from '../evolution/compiled-game-evaluator.mjs';
import { AI9_DEV_BLOCKS } from '../evolution/core.mjs';

const artifact = JSON.parse(readFileSync(
  resolve(REPO_ROOT, 'training/reports/ai9/all-modules-candidate.json'), 'utf8'));
const campaignId = 'ai9-all-modules-e1';
const provider = createLiveGovernanceProviderAI9();
const playerCounts = [2, 3, 4, 5];
const seedsPerCount = 2;
const screen = provider.allocateDevSeedWindow({ campaignId, round: 1, purpose: 'screen', count: seedsPerCount * playerCounts.length });
const deep = provider.allocateDevSeedWindow({ campaignId, round: 1, purpose: 'deep', count: 2 });
const seeds = Array.from({ length: seedsPerCount * playerCounts.length }, (_, i) => screen.base + i);
const seedsByPlayerCount = Object.fromEntries(playerCounts.map((count, index) => [
  count, seeds.slice(index * seedsPerCount, (index + 1) * seedsPerCount),
]));
const evidence = await evaluateCompiledCandidateGames({
  artifact,
  seedsByPlayerCount,
  purpose: 'screen',
  round: 1,
  playerCounts: [2, 3, 4, 5],
  maxMoves: 400,
  deadlineMs: 60_000,
  workUnits: 32,
  blocks: AI9_DEV_BLOCKS,
});
const report = {
  schema: 'century-ai9-all-modules-game-v1',
  generatedAt: new Date().toISOString(),
  campaignId,
  candidateId: artifact.candidateId,
  artifactHash: artifact.artifactHash,
  moduleIds: artifact.source.modules.map(m => m.id).sort(),
  seedWindow: { screen, deep, seeds },
  playerCounts: [2, 3, 4, 5],
  workUnits: 32,
  control: 'js5-frozen-champion (immutable archive)',
  note: '开发池方向性证据；不用于冠军晋级。',
  metrics: evidence.metrics,
  pairs: evidence.pairs,
  games: evidence.games,
};
writeJSON(resolve(REPO_ROOT, 'training/reports/ai9/all-modules-game.json'), report);
console.log(JSON.stringify({
  candidateId: artifact.candidateId,
  modules: report.moduleIds,
  totalGames: evidence.metrics.totalGames,
  anomalies: evidence.metrics.anomalies,
  firstPlaceDelta: evidence.metrics.firstPlaceDelta,
  candidateFirstRate: evidence.metrics.candidateFirstRate,
  championFirstRate: evidence.metrics.championFirstRate,
}, null, 2));
