#!/usr/bin/env node
/** AI9 模块交叉组合真实对局证据（开发池；不用于冠军晋级）。
 *
 * 从真实协同进化 campaign 的候选库中加载至少两个模块组合不同的候选，
 * 用正式的 generateMultiModuleBatch(crossover) 生成子代候选，
 * 再让该候选真实控制 2–5 人对局焦点席位，与冻结冠军配对比较。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { createLiveGovernanceProviderAI9 } from '../evolution/governance-provider-v2.mjs';
import { generateMultiModuleBatch } from '../evolution/multi-module-generator.mjs';
import { evaluateCompiledCandidateGames } from '../evolution/compiled-game-evaluator.mjs';
import { AI9_DEV_BLOCKS } from '../evolution/core.mjs';

const CAMPAIGN_ROOT = resolve(REPO_ROOT, 'training/reports/coevolution/ai9-live-coevolve-2');
const PLAYER_COUNTS = [2, 3, 4, 5];

function loadArtifacts() {
  const state = JSON.parse(readFileSync(resolve(CAMPAIGN_ROOT, 'state.json'), 'utf8'));
  const artifacts = [];
  for (const round of state.rounds ?? []) {
    for (const candidate of round.candidates ?? []) {
      if (!candidate.artifactPath) continue;
      try {
        const artifact = JSON.parse(readFileSync(resolve(REPO_ROOT, candidate.artifactPath), 'utf8'));
        if ((artifact.source?.modules ?? []).length >= 2) {
          artifacts.push({ candidateId: candidate.candidateId, strategy: candidate.strategy, artifact });
        }
      } catch { /* 归档缺失的候选跳过 */ }
    }
  }
  return artifacts;
}

function hasDonorB(a, b) {
  const aIds = a.artifact.source.modules.map(m => m.id);
  return b.artifact.source.modules.some(m => !aIds.includes(m.id));
}

const artifacts = loadArtifacts();
if (artifacts.length < 2) throw new Error('campaign 中没有足够的模块候选用于交叉');
const pairs = [];
for (let i = 0; i < artifacts.length; i++) {
  for (let j = 0; j < artifacts.length; j++) {
    if (i === j) continue;
    if (hasDonorB(artifacts[i], artifacts[j])) pairs.push([artifacts[i], artifacts[j]]);
  }
}
if (!pairs.length) throw new Error('没有可交叉的模块集合');

const campaignId = `ai9-crossover-${Date.now().toString(36)}`;
const provider = createLiveGovernanceProviderAI9();
const seedsPerCount = 2;
const screen = provider.allocateDevSeedWindow({
  campaignId, round: 1, purpose: 'screen', count: seedsPerCount * PLAYER_COUNTS.length,
});
const deep = provider.allocateDevSeedWindow({ campaignId, round: 1, purpose: 'deep', count: 2 });
const seeds = Array.from({ length: seedsPerCount * PLAYER_COUNTS.length }, (_, i) => screen.base + i);
const seedsByPlayerCount = Object.fromEntries(PLAYER_COUNTS.map((count, index) => [
  count, seeds.slice(index * seedsPerCount, (index + 1) * seedsPerCount),
]));
const experiment = {
  configRef: 'ai9://experiment/crossover',
  configHash: '7'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: screen.windowId, base: screen.base, count: seeds.length },
    { purpose: 'deep', windowId: deep.windowId, base: deep.base, count: 2 },
  ],
};

let created = null;
let parents = null;
const rejected = [];
for (const [a, b] of pairs) {
  for (let seed = 1; seed <= 8 && !created; seed++) {
    const batch = generateMultiModuleBatch({
      count: 1,
      round: 1,
      seed: seed + 100,
      experiment,
      moduleConfig: { strategies: ['crossover'], includeControl: false },
      targetIds: ['M01', 'M05', 'M10', 'M11'],
      eliteArtifacts: [a.artifact, b.artifact],
    });
    if (batch.candidates.length === 1) {
      created = batch.candidates[0];
      parents = [a, b];
    } else {
      for (const rejection of batch.rejectedAtGeneration) {
        rejected.push({
          parentA: a.candidateId, parentB: b.candidateId, seed,
          reason: rejection.reason ?? rejection.error ?? null,
        });
      }
    }
  }
  if (created) break;
}
if (!created) throw new Error(`交叉候选生成失败：${JSON.stringify(rejected.slice(0, 6))}`);

const evidence = await evaluateCompiledCandidateGames({
  artifact: created.artifact,
  seedsByPlayerCount,
  purpose: 'screen',
  round: 1,
  playerCounts: PLAYER_COUNTS,
  maxMoves: 400,
  deadlineMs: 60_000,
  workUnits: 32,
  blocks: AI9_DEV_BLOCKS,
});

const report = {
  schema: 'century-ai9-crossover-game-v1',
  generatedAt: new Date().toISOString(),
  campaignId,
  parentA: {
    candidateId: parents[0].candidateId,
    modules: parents[0].artifact.source.modules.map(m => m.id).sort(),
  },
  parentB: {
    candidateId: parents[1].candidateId,
    modules: parents[1].artifact.source.modules.map(m => m.id).sort(),
  },
  candidateId: created.artifact.candidateId,
  artifactHash: created.artifact.artifactHash,
  modules: created.artifact.source.modules.map(m => m.id).sort(),
  probe: {
    changedModules: created.probe.changedModules,
    mismatches: created.probe.mismatchCount,
    errors: created.probe.probeErrors,
  },
  seedWindow: { screen, deep, seeds },
  playerCounts: PLAYER_COUNTS,
  workUnits: 32,
  control: 'js5-frozen-champion (immutable archive)',
  metrics: evidence.metrics,
  pairs: evidence.pairs,
  games: evidence.games,
  rejectedGeneration: rejected.slice(0, 12),
  note: '开发池方向性证据；不用于冠军晋级。交叉候选必须经过正式候选契约编译/安全检查。',
};
writeJSON(resolve(REPO_ROOT, 'training/reports/ai9/crossover-experiment.json'), report);
console.log(JSON.stringify({
  candidateId: report.candidateId,
  parents: [report.parentA, report.parentB],
  modules: report.modules,
  probe: report.probe,
  games: evidence.metrics.totalGames,
  anomalies: evidence.metrics.anomalies,
  firstPlaceDelta: evidence.metrics.firstPlaceDelta,
  ci: evidence.metrics.firstPlaceDeltaPooledCi,
}, null, 2));
