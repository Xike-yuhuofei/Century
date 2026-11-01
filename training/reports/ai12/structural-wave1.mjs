// AI12 structural wave 1: single-module candidates M01/M06/M08 via sanctioned pipeline.
// Dev-only paired evaluation on AI9 deep block (w292/w293/w294), workUnits=64 (formal-aligned).
import { createCompiledModuleCandidate } from '/Volumes/Extreme SSD/Projects/Century-ai12/training/evolution/multi-module-candidate.mjs';
import { evaluateCompiledCandidateGames } from '/Volumes/Extreme SSD/Projects/Century-ai12/training/evolution/compiled-game-evaluator.mjs';
import { writeFileSync } from 'node:fs';

const REPO = '/Volumes/Extreme SSD/Projects/Century-ai12';
const WU = Number(process.env.WU ?? 64);
const SEEDS_PER_COUNT = Number(process.env.N ?? 30);

const MODULE_TEXTS = {
  M01: `export function goalPriority(view: AIObservation, goalId: string, params: AIParameters): number {
  const threshold = view.players.length >= 4 ? 5 : 6;
  let maxClaimed = 0;
  for (const p of view.players) if (p.claimed.length > maxClaimed) maxClaimed = p.claimed.length;
  if (view.triggerPlayer !== null || maxClaimed < threshold - 2) return 1;
  const goal = GOLEM_BY_ID[goalId];
  if (!goal) return 1;
  const costValue = weighted(goal.cost);
  const pace = goal.points / (costValue + 2);
  const boost = Math.min(0.8, Math.max(0, (pace - 1.0) * 0.8));
  return 1 + boost;
}`,
  M06: `export function endgameBonus(state: EvolveStateView, params: AIParameters): number {
  if (!state.terminal) return 0;
  const myScore = state.baseScore + state.gained;
  let best = -Infinity;
  for (const s of state.standings) if (s.seat !== state.seat && s.score > best) best = s.score;
  if (!Number.isFinite(best)) return 0;
  const margin = myScore - best;
  if (margin < 0) return Math.min(6, -margin * 0.35);
  if (margin < 3) return 1.5;
  return 0;
}`,
  M08: `export function seatContestFactor(view: AIObservation, goalId: string, params: AIParameters): number {
  if (view.players.length < 4) return 1;
  const threshold = 5;
  let maxClaimed = 0;
  for (const p of view.players) if (p.claimed.length > maxClaimed) maxClaimed = p.claimed.length;
  if (maxClaimed >= threshold - 2) return 0.9;
  return 1;
}`,
};

const WINDOWS = { M01: 1670292000, M06: 1670293000, M08: 1670294000 };

const id = process.argv[2];
const text = MODULE_TEXTS[id];
if (!text) throw new Error(`unknown module ${id}`);

import { createHash } from 'node:crypto';
const experiment = {
  configRef: 'ai9://ai12-structural-wave1',
  configHash: createHash('sha256').update(`ai12-structural-wave1-${id}-wu${WU}`).digest('hex'),
  seedRefs: [{ purpose: 'deep', windowId: `ai12-struct-w${id}`, base: WINDOWS[id], count: 1000 }],
};
console.log(`[${id}] compiling candidate...`);
const created = createCompiledModuleCandidate({
  modules: [{ id, text }],
  moduleIds: [id],
  experiment,
  round: 1,
  index: 0,
  sourceOrigin: 'deterministic-template',
  mutationLabel: `ai12-structural-${id}`,
  applicablePlayerCounts: [2, 3, 4, 5],
});
console.log(`[${id}] compiled: artifactHash=${created.artifact.artifactHash} probe changed=${JSON.stringify(created.probe.changedModules)}`);

const base = WINDOWS[id];
const seedsByPlayerCount = {};
for (const count of [2, 3, 4, 5]) {
  seedsByPlayerCount[count] = Array.from({ length: SEEDS_PER_COUNT }, (_, i) => base + count * 100 + i);
}

const started = Date.now();
const partial = { module: id, WU, seedsPerCount: SEEDS_PER_COUNT, artifactHash: created.artifact.artifactHash,
  probe: created.probe.changedModules, perCount: {} };
const outPath = `/tmp/ai12-struct-${id}-result.json`;
writeFileSync(outPath, JSON.stringify(partial, null, 1));

let weightedSum = 0, nCounts = 0;
for (const count of [2, 3, 4, 5]) {
  const evaluation = await evaluateCompiledCandidateGames({
    artifact: created.artifact, seeds: seedsByPlayerCount[count], purpose: 'deep', round: 1,
    playerCounts: [count], workUnits: WU, maxMoves: 1200, deadlineMs: 300_000,
  });
  const pairs = (evaluation.pairs ?? []).filter(p => p.status === 'finished');
  const deltas = pairs.map(p => p.candidateFirst - p.championFirst);
  const n = deltas.length;
  const mean = n ? deltas.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const se = n > 1 ? Math.sqrt(variance / n) : 0;
  partial.perCount[count] = { n, meanFirstDelta: +mean.toFixed(4), se: +se.toFixed(4),
    aFirst: pairs.filter(p => p.candidateFirst === 1).length, bFirst: pairs.filter(p => p.championFirst === 1).length,
    behaviorHash: evaluation.behaviorHash, meanDecisionMs: evaluation.metrics?.meanDecisionMs };
  weightedSum += mean; nCounts++;
  writeFileSync(outPath, JSON.stringify(partial, null, 1));
}
const weighted = weightedSum / nCounts;
partial.weightedDelta = +weighted.toFixed(4);
partial.wallMin = +((Date.now() - started) / 60000).toFixed(1);
writeFileSync(outPath, JSON.stringify(partial, null, 1));
console.log(JSON.stringify(partial, null, 1));
