#!/usr/bin/env node
/** AI9 12 模块实现/进化状态矩阵（从真实证据文件生成，不手填）。
 *
 * 输入（存在才读取）：
 * - training/reports/ai9/all-modules-probe.json（12 模块编译+探针）
 * - training/reports/coevolution/<campaign>/state.json（真实对局候选/模块/精英）
 * - training/reports/ai9/interaction-experiment.json（跨模块交互）
 * - ai5/openevolve/results/<ai9-run>/run-summary.json（真实 LLM 运行）
 *
 * 输出：training/reports/ai9/module-matrix.json
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { moduleRegistry } from '../../ai5/openevolve/node/module_registry.mjs';
import { mutationLabels } from '../evolution/module-mutations.mjs';

const outPath = resolve(REPO_ROOT, 'training/reports/ai9/module-matrix.json');
const reports = resolve(REPO_ROOT, 'training/reports');
const registry = moduleRegistry();

function readJsonIf(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}

const probe = readJsonIf(resolve(reports, 'ai9/all-modules-probe.json'));
const build = readJsonIf(resolve(reports, 'ai9/all-modules-build.json'));
const interaction = readJsonIf(resolve(reports, 'ai9/interaction-experiment.json'));
const allModulesGame = readJsonIf(resolve(reports, 'ai9/all-modules-game.json'));
const combinedGame = readJsonIf(resolve(reports, 'ai9/openevolve-combined-game.json'));
const crossoverGame = readJsonIf(resolve(reports, 'ai9/crossover-experiment.json'));
const executionAudit = readJsonIf(resolve(reports, 'ai9/module-execution-audit.json'));
const wiringAudit = readJsonIf(resolve(reports, 'ai9/module-wiring-audit.json'));
const structuralSearch = readJsonIf(resolve(reports, 'ai9/structural-search-candidates.json'));

const campaignStates = [];
const coevolveRoot = resolve(reports, 'coevolution');
if (existsSync(coevolveRoot)) {
  for (const name of readdirSync(coevolveRoot)) {
    const state = readJsonIf(join(coevolveRoot, name, 'state.json'));
    // 运行中的 campaign 目录通常尚未归档；矩阵只引用已完成/已停止且可复核的证据。
    if (state && state.status !== 'running') campaignStates.push({ campaignId: name, state });
  }
}

const openEvolveRuns = [];
const oeRoot = resolve(REPO_ROOT, 'ai5/openevolve/results');
if (existsSync(oeRoot)) {
  for (const name of readdirSync(oeRoot)) {
    if (!name.startsWith('ai9-')) continue;
    const summary = readJsonIf(join(oeRoot, name, 'run-summary.json'));
    if (summary) openEvolveRuns.push({ run: name, summary });
  }
}
// 归档证据：ai5 结果目录是临时产物，矩阵必须也能从版本库内的 run-summary 生成。
const oeArchiveRoot = resolve(reports, 'ai9');
if (existsSync(oeArchiveRoot)) {
  for (const name of readdirSync(oeArchiveRoot)) {
    if (!/^openevolve-.*-run$/.test(name)) continue;
    const summary = readJsonIf(join(oeArchiveRoot, name, 'run-summary.json'));
    if (summary) openEvolveRuns.push({ run: name, summary });
  }
}

function campaignEvidenceFor(moduleId) {
  const evidence = [];
  for (const { campaignId, state } of campaignStates) {
    for (const round of state.rounds ?? []) {
      for (const candidate of round.candidates ?? []) {
        if (!(candidate.modules ?? []).includes(moduleId)) continue;
        if (candidate.stage === 'deep-done' || candidate.stage === 'promotion-queued') {
          evidence.push({
            campaignId,
            candidateId: candidate.candidateId,
            strategy: candidate.strategy,
            stage: candidate.stage,
            deep: candidate.deep?.metrics ?? null,
            quick: candidate.quick?.metrics ?? null,
            modules: candidate.modules,
          });
        }
      }
    }
  }
  return evidence;
}

function interactionEvidenceFor(moduleId) {
  if (!interaction) return [];
  return (interaction.candidates ?? [])
    .filter(c => (c.moduleIds ?? []).includes(moduleId))
    .map(c => ({
      experiment: interaction.campaignId ?? 'ai9-interaction',
      candidateId: c.candidateId,
      label: c.label,
      moduleIds: c.moduleIds,
      firstPlaceDelta: c.metrics.firstPlaceDelta,
      ciLower: c.metrics.firstPlaceDeltaPooledCi?.lower ?? c.metrics.firstPlaceDeltaCi?.lower ?? null,
      games: c.metrics.totalGames,
    }));
}

/** 联合候选真实对局证据：候选包内全部模块一起控制候选席位。 */
function jointCandidateEvidenceFor(moduleId) {
  const evidence = [];
  if (allModulesGame && (allModulesGame.moduleIds ?? []).includes(moduleId)) {
    evidence.push({
      experiment: allModulesGame.campaignId,
      candidateId: allModulesGame.candidateId,
      kind: 'twelve-module-joint',
      modules: allModulesGame.moduleIds,
      firstPlaceDelta: allModulesGame.metrics?.firstPlaceDelta ?? null,
      ciLower: allModulesGame.metrics?.firstPlaceDeltaPooledCi?.lower ?? null,
      games: allModulesGame.metrics?.totalGames ?? null,
      anomalies: allModulesGame.metrics?.anomalies ?? null,
      note: '该模块随 12 模块联合候选一同注入候选席位；不等同于该模块单独强度贡献。',
    });
  }
  if (combinedGame && (combinedGame.modules ?? []).includes(moduleId)) {
    evidence.push({
      experiment: combinedGame.campaignId,
      candidateId: combinedGame.candidateId,
      kind: 'openevolve-combined',
      modules: combinedGame.modules,
      firstPlaceDelta: combinedGame.metrics?.firstPlaceDelta ?? null,
      ciLower: combinedGame.metrics?.firstPlaceDeltaPooledCi?.lower ?? null,
      games: combinedGame.metrics?.totalGames ?? null,
      anomalies: combinedGame.metrics?.anomalies ?? null,
      changed: combinedGame.probe?.changedModules ?? null,
    });
  }
  if (crossoverGame && (crossoverGame.modules ?? []).includes(moduleId)) {
    evidence.push({
      experiment: crossoverGame.campaignId,
      candidateId: crossoverGame.candidateId,
      kind: 'module-crossover',
      modules: crossoverGame.modules,
      parents: [crossoverGame.parentA?.candidateId, crossoverGame.parentB?.candidateId],
      firstPlaceDelta: crossoverGame.metrics?.firstPlaceDelta ?? null,
      ciLower: crossoverGame.metrics?.firstPlaceDeltaPooledCi?.lower ?? null,
      games: crossoverGame.metrics?.totalGames ?? null,
      anomalies: crossoverGame.metrics?.anomalies ?? null,
      changed: crossoverGame.probe?.changedModules ?? null,
    });
  }
  return evidence;
}

function llmEvidenceFor(moduleId) {
  return openEvolveRuns
    .filter(({ summary }) => (summary.modules ?? []).includes(moduleId))
    .map(({ run, summary }) => ({
      run,
      status: summary.status,
      generator: summary.generator ?? 'openevolve-llm',
      changedModules: summary.candidate?.probe?.changedModules ?? null,
      identicalToOfficial: summary.candidate?.probe?.identicalToOfficial ?? null,
      modules: summary.modules,
    }));
}

function structuralEvidenceFor(moduleId) {
  if (!structuralSearch) return null;
  const candidates = (structuralSearch.candidates ?? []).filter(item =>
    (item.modules ?? []).includes(moduleId) && item.structural);
  if (!candidates.length) return null;
  const checks = (structuralSearch.structuralChecks ?? []).filter(item =>
    candidates.some(candidate => candidate.id === item.id));
  return {
    status: structuralSearch.summary?.verdict === 'PASS' && checks.every(item => item.status === 'PASS')
      ? 'PASS' : 'FAIL',
    experiment: structuralSearch.campaignId,
    source: 'training/reports/ai9/structural-search-candidates.json',
    candidates: candidates.map(item => ({
      id: item.id,
      modules: item.modules,
      label: item.label,
      probeMismatches: item.probe?.mismatches ?? null,
      behaviorChanged: checks.find(check => check.id === item.id)?.behaviorChanged ?? null,
      games: item.metrics?.totalGames ?? null,
      anomalies: item.metrics?.anomalies ?? null,
      firstPlaceDelta: item.metrics?.firstPlaceDelta ?? null,
    })),
  };
}

const modules = registry.modules.map(module => {
  const probeSummary = probe?.modules?.[module.id] ?? null;
  const built = build ? true : false;
  const campaigns = campaignEvidenceFor(module.id);
  const interactions = interactionEvidenceFor(module.id);
  const llm = llmEvidenceFor(module.id);
  const execution = executionAudit?.modules?.find(m => m.id === module.id) ?? null;
  const wiring = wiringAudit?.modules?.find(m => m.id === module.id) ?? null;
  const compiled = Boolean(probeSummary) && Boolean(built);
  const probeChanged = Boolean(probeSummary && probeSummary.mismatches > 0 && probeSummary.errors === 0);
  const realDecisionPath = module.realDecisionPath;
  const deterministicMutations = mutationLabels(module.id);
  const realGameEvidence = [...campaigns, ...interactions, ...jointCandidateEvidenceFor(module.id)];
  let status = 'FAIL';
  if (compiled && probeChanged && realDecisionPath && execution?.status === 'EXECUTED') {
    status = realGameEvidence.length > 0 ? 'PASS' : 'PASS-WIRING-ONLY';
  }
  if (!compiled) status = 'BLOCKED-NO-BUILD-EVIDENCE';
  if (compiled && probeChanged && execution && execution.status !== 'EXECUTED') {
    status = 'FAIL-NOT-EXECUTED';
  }
  return {
    id: module.id,
    label: module.label,
    functionName: module.functionName,
    file: module.file,
    kind: module.kind,
    dependsOn: module.dependsOn,
    interfaceVersion: registry.interfaceVersion,
    realDecisionPath,
    immutableBoundaries: ['规则引擎/合法行动枚举', '隐藏牌库/私有信息', '正式冠军归档'],
    compiledInAllModulesCandidate: compiled,
    probeChanged,
    probeCases: probeSummary?.cases ?? 0,
    probeMismatches: probeSummary?.mismatches ?? null,
    execution: execution ? {
      status: execution.status,
      counts: execution.counts,
      total: execution.total,
      source: 'training/reports/ai9/module-execution-audit.json',
    } : null,
    decisionDivergence: wiring ? {
      status: wiring.status,
      path: wiring.path,
      divergence: wiring.divergence ?? null,
      source: 'training/reports/ai9/module-wiring-audit.json',
    } : null,
    deterministicMutations,
    structuralSearch: structuralEvidenceFor(module.id),
    openEvolveEvidence: llm,
    realGameEvidence,
    status,
  };
});

const report = {
  schema: 'century-ai9-module-matrix-v1',
  generatedAt: new Date().toISOString(),
  registry: {
    path: 'training/evolution/module-registry.json',
    version: registry.version,
    interfaceVersion: registry.interfaceVersion,
    protocol: registry.artifactProtocol,
  },
  evidenceSources: {
    allModulesProbe: probe ? 'training/reports/ai9/all-modules-probe.json' : null,
    allModulesBuild: build,
    campaigns: campaignStates.map(c => c.campaignId),
    interaction: interaction ? 'training/reports/ai9/interaction-experiment.json' : null,
    structuralSearch: structuralSearch ? 'training/reports/ai9/structural-search-candidates.json' : null,
    openEvolveRuns: openEvolveRuns.map(r => r.run),
  },
  modules,
  summary: {
    total: modules.length,
    compiledAndProbeChanged: modules.filter(m => m.compiledInAllModulesCandidate && m.probeChanged).length,
    executedInRealGames: modules.filter(m => m.execution?.status === 'EXECUTED').length,
    decisionDivergenceObserved: modules.filter(m => m.decisionDivergence?.status === 'WIRED').length,
    withRealGameEvidence: modules.filter(m => m.realGameEvidence.length > 0).length,
    withOpenEvolveEvidence: modules.filter(m => m.openEvolveEvidence.length > 0).length,
    withStructuralSearchEvidence: modules.filter(m => m.structuralSearch?.status === 'PASS').length,
    statuses: modules.reduce((acc, m) => { acc[m.status] = (acc[m.status] ?? 0) + 1; return acc; }, {}),
  },
};
writeJSON(outPath, report);
console.log(JSON.stringify({
  outPath,
  summary: report.summary,
  missingEvidence: modules.filter(m => !m.compiledInAllModulesCandidate || !m.probeChanged).map(m => m.id),
}, null, 2));
