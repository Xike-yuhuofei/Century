#!/usr/bin/env node
/** AI9 M4 16GB 资源与推理预算报告（从证据文件汇总，不伪造测量）。
 *
 * 输入：all-modules-build.json / all-modules-game.json / 交互实验 / 资源快照。
 * 输出：training/reports/ai9/resource-report.json
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { resourceSnapshot } from '../lib/resource-scheduler.mjs';

function read(path) {
  const absolute = resolve(REPO_ROOT, path);
  return existsSync(absolute) ? JSON.parse(readFileSync(absolute, 'utf8')) : null;
}

const build = read('training/reports/ai9/all-modules-build.json');
const game = read('training/reports/ai9/all-modules-game.json');
const interaction = read('training/reports/ai9/interaction-experiment.json');
const campaign = read('training/reports/coevolution/ai9-smoke-003/state.json');
const liveCampaign = read('training/reports/coevolution/ai9-live-coevolve-2/state.json');
const artifactBytes = existsSync(resolve(REPO_ROOT, 'training/reports/ai9/all-modules-candidate.json'))
  ? statSync(resolve(REPO_ROOT, 'training/reports/ai9/all-modules-candidate.json')).size
  : null;

const decisions = [];
if (game?.metrics) {
  decisions.push({
    source: 'all-modules 2–5p',
    meanDecisionMs: game.metrics.meanDecisionMs,
    games: game.metrics.totalGames,
    anomalies: game.metrics.anomalies,
  });
}
for (const candidate of interaction?.candidates ?? []) {
  decisions.push({
    source: `interaction:${candidate.key}`,
    meanDecisionMs: candidate.metrics.meanDecisionMs,
    games: candidate.metrics.totalGames,
    anomalies: candidate.metrics.anomalies,
  });
}
const values = decisions.map(d => d.meanDecisionMs).filter(Number.isFinite);
const report = {
  schema: 'century-ai9-resource-report-v1',
  generatedAt: new Date().toISOString(),
  device: {
    platform: process.platform,
    arch: process.arch,
    cpuCount: resourceSnapshot().cpuCount,
    totalMemBytes: resourceSnapshot().totalMem,
    note: '目标设备 Apple M4 / 16GB 统一内存；本报告在开发机采集，字段为实测运行时。',
  },
  bundle: build ? {
    modules: build.build?.modules ?? null,
    compiledFiles: build.build?.compiledFiles ?? null,
    compiledBytes: build.build?.compiledBytes ?? null,
    artifactJsonBytes: artifactBytes,
    tscVersion: build.build?.compiler ?? null,
    buildElapsedMs: build.build?.elapsedMs ?? null,
    sandbox: build.build?.sandbox ?? null,
  } : null,
  inference: {
    perDecisionBudgetMsHardCap: 1000,
    observedMeanDecisionMs: values.length ? Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(3)) : null,
    samples: decisions,
    note: '均值来自真实 2–5 人对局的候选决策计时；整局墙钟受对手与机器负载影响，不作为推理预算判据。',
  },
  memory: {
    snapshotAtRuntime: resourceSnapshot(),
    campaignObserved: campaign ? {
      campaignId: 'ai9-smoke-003',
      budgetUsed: campaign.budgetUsed,
      status: campaign.status,
    } : null,
    campaignsObserved: [
      ...(campaign ? [{ campaignId: 'ai9-smoke-003', budgetUsed: campaign.budgetUsed, status: campaign.status }] : []),
      ...(liveCampaign ? [{
        campaignId: 'ai9-live-coevolve-2',
        budgetUsed: liveCampaign.budgetUsed,
        status: liveCampaign.status,
        rounds: liveCampaign.rounds?.length ?? null,
      }] : []),
    ],
  },
  limits: {
    trainingConcurrency: 1,
    maxCompiledBundleBytes: 8 * 1024 * 1024,
    maxModuleSourceBytes: 12000,
    maxMovesPerGame: 400,
  },
};
writeJSON(resolve(REPO_ROOT, 'training/reports/ai9/resource-report.json'), report);
console.log(JSON.stringify({ observedMeanDecisionMs: report.inference.observedMeanDecisionMs, compiledBytes: report.bundle?.compiledBytes, artifactBytes }, null, 2));
