#!/usr/bin/env node
/** AI9 跨模块交互实验（开发池；不是正式晋级证据）。
 *
 * 同一组种子下比较：
 *   control（官方模块）
 *   single-M02（获取估值）
 *   single-M11（联合搜索结构）
 *   pair-M02+M11（双模块联合变异）
 *   multi-M02+M05+M11（多模块联合变异）
 *   ablation-M02（= pair 移除 M11；用于识别 M11 的边际贡献）
 *
 * 指标：2–5 人焦点席位配对第一名率增量（候选 vs 冻结冠军），同一随机世界。
 * 交互判定：pairDelta − (singleM02Delta + singleM11Delta)；>0 协同，<0 相互抵消。
 * 只在开发池运行；正式晋级仍必须走预注册 2–5 人验证池挑战。
 */

import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { createLiveGovernanceProviderAI9 } from '../evolution/governance-provider-v2.mjs';
import { createCompiledModuleCandidate } from '../evolution/multi-module-candidate.mjs';
import { mutateModuleFunction } from '../evolution/module-mutations.mjs';
import { evaluateCompiledCandidateGames } from '../evolution/compiled-game-evaluator.mjs';
import { AI9_DEV_BLOCKS } from '../evolution/core.mjs';

const campaignId = `ai9-interaction-${Date.now().toString(36)}`;
const outPath = resolve(REPO_ROOT, 'training/reports/ai9/interaction-experiment.json');
const provider = createLiveGovernanceProviderAI9();
const playerCounts = [2, 3, 4, 5];
const seedsPerCount = 4;
const screenWindow = provider.allocateDevSeedWindow({
  campaignId, round: 1, purpose: 'screen', count: seedsPerCount * playerCounts.length,
});
const deepWindow = provider.allocateDevSeedWindow({
  campaignId, round: 1, purpose: 'deep', count: 4,
});
const seeds = Array.from({ length: seedsPerCount * playerCounts.length }, (_, i) => screenWindow.base + i);
const seedsByPlayerCount = Object.fromEntries(playerCounts.map((count, index) => [
  count, seeds.slice(index * seedsPerCount, (index + 1) * seedsPerCount),
]));
const experiment = {
  configRef: 'ai9://experiment/module-interaction',
  configHash: 'e'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: screenWindow.windowId, base: screenWindow.base, count: seeds.length },
    { purpose: 'deep', windowId: deepWindow.windowId, base: deepWindow.base, count: 4 },
  ],
};
const workUnits = 32;

function modulesFor(ids) {
  return ids.map(id => mutateModuleFunction(id, 0));
}

const candidates = [
  { key: 'control', label: '官方模块（行为基线）', moduleIds: ['M02'], mutate: false, strategy: 'control' },
  { key: 'single-M02', label: '单模块：获取估值', moduleIds: ['M02'], mutate: true, strategy: 'single' },
  { key: 'single-M11', label: '单模块：联合搜索结构', moduleIds: ['M11'], mutate: true, strategy: 'single' },
  { key: 'pair-M02+M11', label: '双模块联合变异', moduleIds: ['M02', 'M11'], mutate: true, strategy: 'pair' },
  { key: 'multi-M02+M05+M11', label: '三模块联合变异', moduleIds: ['M02', 'M05', 'M11'], mutate: true, strategy: 'multi' },
  { key: 'ablation-M02', label: '消融：pair 移除 M11（仅保留 M02）', moduleIds: ['M02'], mutate: true, strategy: 'ablation' },
];

const results = [];
for (const candidate of candidates) {
  const created = createCompiledModuleCandidate({
    ...(candidate.mutate
      ? { modules: modulesFor(candidate.moduleIds) }
      : { moduleIds: candidate.moduleIds }),
    moduleIds: candidate.moduleIds,
    experiment,
    round: 1,
    index: results.length,
    candidateId: `cand-ai9-interaction-${candidate.key.replace(/\+/g, '-')}`,
    sourceOrigin: 'deterministic-template',
    mutationLabel: `interaction:${candidate.key}`,
  });
  const evidence = await evaluateCompiledCandidateGames({
    artifact: created.artifact,
    seedsByPlayerCount,
    purpose: 'screen',
    round: 1,
    playerCounts,
    maxMoves: 400,
    deadlineMs: 60_000,
    workUnits,
    blocks: AI9_DEV_BLOCKS,
  });
  results.push({
    key: candidate.key,
    label: candidate.label,
    strategy: candidate.strategy,
    moduleIds: candidate.moduleIds,
    candidateId: created.artifact.candidateId,
    artifactHash: created.artifact.artifactHash,
    probe: {
      changedModules: created.probe.changedModules,
      mismatches: created.probe.mismatchCount,
    },
    metrics: {
      totalGames: evidence.metrics.totalGames,
      finishedGames: evidence.metrics.finishedGames,
      anomalies: evidence.metrics.anomalies,
      candidateFirstRate: evidence.metrics.candidateFirstRate,
      championFirstRate: evidence.metrics.championFirstRate,
      firstPlaceDelta: evidence.metrics.firstPlaceDelta,
      firstPlaceDeltaCi: evidence.metrics.firstPlaceDeltaCi,
      firstPlaceDeltaPooledCi: evidence.metrics.firstPlaceDeltaPooledCi,
      byPlayerCount: evidence.metrics.byPlayerCount,
      meanDecisionMs: evidence.metrics.meanDecisionMs,
    },
    pairs: evidence.pairs,
  });
  console.log(JSON.stringify({
    key: candidate.key,
    delta: evidence.metrics.firstPlaceDelta,
    ci: evidence.metrics.firstPlaceDeltaCi,
    anomalies: evidence.metrics.anomalies,
  }));
}

const byKey = Object.fromEntries(results.map(r => [r.key, r]));
const delta = key => byKey[key]?.metrics?.firstPlaceDelta ?? null;
const pairDelta = delta('pair-M02+M11');
const singleSum = (delta('single-M02') ?? 0) + (delta('single-M11') ?? 0);
const interaction = pairDelta === null ? null : Number((pairDelta - singleSum).toFixed(4));

const report = {
  schema: 'century-ai9-interaction-experiment-v1',
  generatedAt: new Date().toISOString(),
  campaignId,
  seedWindow: screenWindow,
  seeds: { byPlayerCount: seedsByPlayerCount },
  playerCounts,
  workUnits,
  control: 'js5-frozen-champion (immutable archive)',
  metric: 'pairedFirstPlaceRateDelta',
  note: '开发池小样本方向性实验；不得作为冠军晋级证据。正式晋级必须使用预注册 2–5 人验证池正式挑战。',
  candidates: results,
  interaction: {
    pairDelta,
    singleSum: Number(singleSum.toFixed(4)),
    synergyDelta: interaction,
    verdict: interaction === null ? 'insufficient-data' : interaction > 0.02 ? 'synergy' : interaction < -0.02 ? 'negative-interaction' : 'additive/inconclusive',
    ablation: {
      pairWithM11: pairDelta,
      pairWithoutM11: delta('ablation-M02'),
      m11Marginal: pairDelta === null || delta('ablation-M02') === null
        ? null : Number((pairDelta - delta('ablation-M02')).toFixed(4)),
    },
  },
};
writeJSON(outPath, report);
console.log(JSON.stringify({ outPath, interaction: report.interaction, candidates: results.map(r => ({ key: r.key, delta: r.metrics.firstPlaceDelta, anomalies: r.metrics.anomalies })) }, null, 2));
