#!/usr/bin/env node
/** AI9 M10/M11 结构级搜索候选验证（开发池；不用于冠军晋级）。
 *
 * 目的：证明 M10/M11 不只是调整系数，而是能编译并真实运行不同的搜索结构：
 * - M10：根行动剪枝结构（保留认领、限制非认领展开）；
 * - M11：束搜索结构切换（beam-rollout → beam-contest，经 adapter 白名单）；
 * - M10+M11：双模块结构联合候选。
 * 同时编译中性对照，比较行为签名，确认结构确实改变决策而非空操作。
 */

import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { createLiveGovernanceProviderAI9 } from '../evolution/governance-provider-v2.mjs';
import { createCompiledModuleCandidate } from '../evolution/multi-module-candidate.mjs';
import { mutateModuleFunction } from '../evolution/module-mutations.mjs';
import { evaluateCompiledCandidateGames } from '../evolution/compiled-game-evaluator.mjs';
import { AI9_DEV_BLOCKS } from '../evolution/core.mjs';

const PLAYER_COUNTS = [2, 3, 4, 5];
const SEEDS_PER_COUNT = 2;
const WORK_UNITS = 32;
const campaignId = `ai9-structural-${Date.now().toString(36)}`;

const provider = createLiveGovernanceProviderAI9();
const screen = provider.allocateDevSeedWindow({
  campaignId, round: 1, purpose: 'screen', count: SEEDS_PER_COUNT * PLAYER_COUNTS.length,
});
const seedList = Array.from({ length: SEEDS_PER_COUNT * PLAYER_COUNTS.length }, (_, i) => screen.base + i);
const seedsByPlayerCount = Object.fromEntries(PLAYER_COUNTS.map((count, index) => [
  count, seedList.slice(index * SEEDS_PER_COUNT, (index + 1) * SEEDS_PER_COUNT),
]));

const experiment = {
  configRef: 'ai9://experiment/structural-search',
  configHash: '9'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: screen.windowId, base: screen.base, count: seedList.length },
  ],
};

const m10Structural = mutateModuleFunction('M10', 1);
const m11Structural = mutateModuleFunction('M11', 1);

const definitions = [
  {
    id: 'cand-ai9-struct-m10-neutral',
    label: 'neutral M10 control',
    kind: 'control',
    moduleIds: ['M10'],
    modules: null,
    structural: false,
    neutralFor: null,
  },
  {
    id: 'cand-ai9-struct-m10-prune',
    label: m10Structural.label,
    kind: 'structural',
    moduleIds: ['M10'],
    modules: [m10Structural],
    structural: true,
    neutralFor: 'cand-ai9-struct-m10-neutral',
  },
  {
    id: 'cand-ai9-struct-m11-neutral',
    label: 'neutral M11 control',
    kind: 'control',
    moduleIds: ['M11'],
    modules: null,
    structural: false,
    neutralFor: null,
  },
  {
    id: 'cand-ai9-struct-m11-contest',
    label: m11Structural.label,
    kind: 'structural',
    moduleIds: ['M11'],
    modules: [m11Structural],
    structural: true,
    neutralFor: 'cand-ai9-struct-m11-neutral',
  },
  {
    id: 'cand-ai9-struct-m10m11',
    label: 'dual-module structural candidate',
    kind: 'structural',
    moduleIds: ['M10', 'M11'],
    modules: [m10Structural, m11Structural],
    structural: true,
    neutralFor: null,
  },
];

const results = [];
for (let index = 0; index < definitions.length; index++) {
  const definition = definitions[index];
  console.log(JSON.stringify({ phase: 'compile', id: definition.id }));
  const created = createCompiledModuleCandidate({
    modules: definition.modules,
    moduleIds: definition.moduleIds,
    experiment,
    round: 1,
    index,
    candidateId: definition.id,
    sourceOrigin: definition.kind === 'control' ? 'deterministic-template' : 'deterministic-template',
    mutationLabel: definition.label,
  });
  console.log(JSON.stringify({ phase: 'evaluate', id: definition.id, artifact: created.artifact.artifactHash.slice(0, 12) }));
  const evidence = await evaluateCompiledCandidateGames({
    artifact: created.artifact,
    seedsByPlayerCount,
    purpose: 'screen',
    round: 1,
    playerCounts: PLAYER_COUNTS,
    maxMoves: 400,
    deadlineMs: 60_000,
    workUnits: WORK_UNITS,
    blocks: AI9_DEV_BLOCKS,
  });
  results.push({
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    modules: definition.moduleIds,
    structural: definition.structural,
    neutralFor: definition.neutralFor,
    artifactHash: created.artifact.artifactHash,
    identityDigest: created.artifact.identityDigest,
    buildArtifactHash: created.artifact.buildArtifact.sha256,
    probe: {
      changedModules: created.probe.changedModules,
      mismatches: created.probe.mismatchCount,
      errors: created.probe.probeErrors,
    },
    behavior: {
      hash: evidence.behaviorHash,
      actions: evidence.behaviorSignature.actions,
    },
    metrics: evidence.metrics,
  });
}

function byId(id) {
  return results.find(item => item.id === id) ?? null;
}

const structuralChecks = results.filter(item => item.structural).map(item => {
  const probeChanged = item.probe.mismatches > 0;
  let behaviorChanged = false;
  if (item.neutralFor) {
    const neutral = byId(item.neutralFor);
    behaviorChanged = Boolean(neutral?.behavior?.hash) && item.behavior.hash !== neutral.behavior.hash;
  } else if (item.id === 'cand-ai9-struct-m10m11') {
    // 双模块候选没有同模块集合的中性对照：与 M11 单层比较聚合行动分布，
    // 若相同则只以探针证明 M10 层也改变了决策，不宣称额外行为差异。
    const m11Single = byId('cand-ai9-struct-m11-contest');
    behaviorChanged = Boolean(m11Single?.behavior?.actions)
      && JSON.stringify(m11Single.behavior.actions) !== JSON.stringify(item.behavior.actions);
  }
  return {
    id: item.id,
    neutral: item.neutralFor,
    probeMismatches: item.probe.mismatches,
    behaviorChanged,
    status: probeChanged || behaviorChanged ? 'PASS' : 'FAIL-NO-DIVERGENCE',
    note: behaviorChanged
      ? '真实对局聚合行动分布与对照不同'
      : '受控探针已改变决策；本样本聚合行动分布未观察到差异',
  };
});

const gamesOk = results.every(item =>
  item.metrics.totalGames === SEEDS_PER_COUNT * PLAYER_COUNTS.length * 2
  && item.metrics.anomalies === 0
  && item.metrics.finishedGames === item.metrics.totalGames);
const compileOk = results.every(item => item.probe.errors === 0);
const structuralOk = structuralChecks.every(item => item.status === 'PASS');

const verdict = compileOk && gamesOk && structuralOk ? 'PASS' : 'FAIL';
const report = {
  schema: 'century-ai9-structural-search-v1',
  generatedAt: new Date().toISOString(),
  campaignId,
  seedWindow: { screen, seeds: seedList, seedsByPlayerCount },
  playerCounts: PLAYER_COUNTS,
  workUnits: WORK_UNITS,
  control: 'js5-frozen-champion (immutable archive)',
  candidates: results,
  structuralChecks,
  summary: {
    totalCandidates: results.length,
    compiled: results.length,
    realGames: results.reduce((sum, item) => sum + item.metrics.totalGames, 0),
    anomalies: results.reduce((sum, item) => sum + item.metrics.anomalies, 0),
    gamesOk,
    compileOk,
    structuralOk,
    verdict,
  },
  note: '开发池结构级搜索候选验证；只证明结构可编译、可执行、真实改变决策，不作为冠军晋级证据。',
};

writeJSON(resolve(REPO_ROOT, 'training/reports/ai9/structural-search-candidates.json'), report);
console.log(JSON.stringify({
  out: 'training/reports/ai9/structural-search-candidates.json',
  verdict,
  structuralChecks,
  summary: report.summary,
}, null, 2));
if (verdict !== 'PASS') process.exit(1);
