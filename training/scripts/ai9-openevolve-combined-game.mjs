#!/usr/bin/env node
/** OpenEvolve + 确定性模块组合：双模块候选的真实对局证据（开发池）。
 *
 * 组合方式：
 * - M05 来自真实 OpenEvolve r001 best program（LLM 生成并已通过静态/编译/探针）；
 * - M02 来自确定性单点变异（另一算法模块）；
 * - 两模块装入同一个 Candidate Artifact，真实控制 2–5 人对局焦点席位。
 *
 * 这不是"LLM 独自改对两个模块"的证据，而是"LLM 模块 + 另一模块组合"的真实
 * 联合候选证据；报告必须如实区分。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { createLiveGovernanceProviderAI9 } from '../evolution/governance-provider-v2.mjs';
import { createCompiledModuleCandidate } from '../evolution/multi-module-candidate.mjs';
import { mutateModuleFunction } from '../evolution/module-mutations.mjs';
import { evaluateCompiledCandidateGames } from '../evolution/compiled-game-evaluator.mjs';
import { loadMultiModuleBestProgram } from '../evolution/openevolve-multi-bridge.mjs';
import { AI9_DEV_BLOCKS } from '../evolution/core.mjs';

const r001 = resolve(REPO_ROOT, 'ai5/openevolve/results/ai9-r001');
const loaded = loadMultiModuleBestProgram({ outputDir: r001, expectedModuleIds: ['M02', 'M05'] });
if (!loaded.available) throw new Error(`r001 best program 不可用：${loaded.reason}`);
const byId = Object.fromEntries(loaded.modules.map(m => [m.id, m.text]));
const deterministicM02 = mutateModuleFunction('M02', 0);
const modules = [
  { id: 'M02', text: deterministicM02.text },
  { id: 'M05', text: byId.M05 },
];

const campaignId = `ai9-oe-combined-${Date.now().toString(36)}`;
const provider = createLiveGovernanceProviderAI9();
const playerCounts = [2, 3, 4, 5];
const seedsPerCount = 2;
const screen = provider.allocateDevSeedWindow({ campaignId, round: 1, purpose: 'screen', count: seedsPerCount * playerCounts.length });
const deep = provider.allocateDevSeedWindow({ campaignId, round: 1, purpose: 'deep', count: 2 });
const seeds = Array.from({ length: seedsPerCount * playerCounts.length }, (_, i) => screen.base + i);
const seedsByPlayerCount = Object.fromEntries(playerCounts.map((count, index) => [
  count, seeds.slice(index * seedsPerCount, (index + 1) * seedsPerCount),
]));
const experiment = {
  configRef: 'ai9://experiment/openevolve-combined',
  configHash: '9'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: screen.windowId, base: screen.base, count: seeds.length },
    { purpose: 'deep', windowId: deep.windowId, base: deep.base, count: 2 },
  ],
};
const created = createCompiledModuleCandidate({
  modules,
  moduleIds: ['M02', 'M05'],
  experiment,
  round: 1,
  index: 0,
  candidateId: 'cand-ai9-oe-combined-m02m05',
  sourceOrigin: 'openevolve-llm+crossover',
  mutationLabel: `openevolve-M05+deterministic-M02:${deterministicM02.label}`,
});
const evidence = await evaluateCompiledCandidateGames({
  artifact: created.artifact,
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
  schema: 'century-ai9-openevolve-combined-game-v1',
  generatedAt: new Date().toISOString(),
  campaignId,
  sources: {
    M05: { origin: 'openevolve-llm', run: 'ai5/openevolve/results/ai9-r001', changed: true },
    M02: { origin: 'deterministic-template', mutation: deterministicM02.label },
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
  playerCounts: [2, 3, 4, 5],
  workUnits: 32,
  control: 'js5-frozen-champion (immutable archive)',
  metrics: evidence.metrics,
  pairs: evidence.pairs,
  games: evidence.games,
  note: '开发池方向性证据；不用于冠军晋级。',
};
writeJSON(resolve(REPO_ROOT, 'training/reports/ai9/openevolve-combined-game.json'), report);
console.log(JSON.stringify({
  candidateId: report.candidateId,
  modules: report.modules,
  probe: report.probe,
  games: evidence.metrics.totalGames,
  anomalies: evidence.metrics.anomalies,
  firstPlaceDelta: evidence.metrics.firstPlaceDelta,
}, null, 2));
