#!/usr/bin/env node
/** AI9 真实 OpenEvolve 多模块联合进化 CLI（研发期，完全离线推理）。
 *
 * 用法：
 *   node training/evolution/run-ai9-openevolve.mjs \
 *     --modules M02,M05 --iterations 1 --out ai5/openevolve/results/ai9-r001
 *
 * 产物：
 * - OpenEvolve 运行目录（best program / checkpoints / 日志）；
 * - 由 best program 编译的 Candidate Artifact（JSON）；
 * - 运行摘要（available/ok/模块/来源/耗时/探针变化）。
 *
 * 纪律：OpenEvolve 不可用时返回非零并写明原因，绝不退化后仍标记 openevolve-llm。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import {
  probeOpenEvolveAI9, runMultiModuleOpenEvolve, createCandidateFromOpenEvolveMulti,
} from './openevolve-multi-bridge.mjs';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`无法识别的参数：${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const moduleIds = args.modules ? String(args.modules).split(',').map(s => s.trim()).filter(Boolean) : null;
if (!moduleIds || moduleIds.length < 2) {
  console.error('必须提供至少两个模块（真实联合进化）：--modules M02,M05');
  process.exit(2);
}
const iterations = args.iterations !== undefined ? Number(args.iterations) : 1;
const outputDir = resolve(process.cwd(), args.out ?? `ai5/openevolve/results/ai9-openevolve-${Date.now()}`);
const experiment = {
  configRef: 'ai9://openevolve/research',
  configHash: '0'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: 'ai9-research-screen', base: 1_650_000_000, count: 16 },
    { purpose: 'deep', windowId: 'ai9-research-deep', base: 1_650_000_100, count: 48 },
  ],
};

const probe = probeOpenEvolveAI9();
const summary = {
  schema: 'century-ai9-openevolve-run-v1',
  startedAt: new Date().toISOString(),
  modules: moduleIds,
  iterations,
  probe,
  outputDir,
};
if (!probe.available) {
  summary.status = 'blocked';
  summary.reason = `OpenEvolve 不可用：${probe.blocked.join(', ')}`;
  writeFileSync(resolve(outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(3);
}

const run = runMultiModuleOpenEvolve({ moduleIds, iterations, outputDir });
summary.run = {
  ok: run.ok, status: run.status, elapsedMs: run.elapsedMs,
  bestProgramPath: run.bestProgramPath, logTail: run.logTail?.slice(-2000),
};
if (!run.ok) {
  summary.status = 'failed';
  writeFileSync(resolve(outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
}

const candidate = createCandidateFromOpenEvolveMulti({
  outputDir: run.outputDir,
  experiment,
  round: 1,
  index: 0,
  expectedModuleIds: moduleIds,
});
summary.status = 'completed';
summary.generator = candidate.provenance.generator;
summary.candidate = {
  candidateId: candidate.artifact.candidateId,
  identityDigest: candidate.artifact.identityDigest,
  artifactHash: candidate.artifact.artifactHash,
  sourceHash: candidate.artifact.sourceHash,
  modules: candidate.artifact.source.modules.map(m => m.id),
  probe: {
    changedModules: candidate.probe?.changedModules ?? [],
    identicalToOfficial: candidate.probe?.identicalToOfficial ?? null,
    mismatches: candidate.probe?.mismatchCount ?? null,
  },
  build: candidate.buildLog,
  provenance: candidate.provenance,
};
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'candidate.json'), JSON.stringify(candidate.artifact, null, 2));
writeFileSync(resolve(outputDir, 'run-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
