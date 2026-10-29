#!/usr/bin/env node
/** 研究/统计报告与候选谱系导出（统一只读入口）。
 *
 * 用法：
 *   node training/scripts/research-report.mjs --campaign ai11-6h-v3
 *   node training/scripts/research-report.mjs --campaign ai11-6h-v3 --out training/reports/ai11-6h-v3-report.json
 *   node training/scripts/research-report.mjs --latest
 *
 * 输出：
 * - 运行状态与预算；
 * - 候选谱系树（父代 → 子代、深度、修改模块）；
 * - 研究索引（candidate/lineage/evaluation/failureCase/formalChallenge 计数）；
 * - 研究记忆（假设状态、正向模块、失败）；
 * - 统计摘要（每轮深验配对增量、区间、无人值守恢复记录）。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const rootBase = resolve(REPO_ROOT, 'training/reports/coevolution');
let campaign = arg('campaign', null);
if (!campaign && args.includes('--latest')) {
  const dirs = existsSync(rootBase)
    ? readdirSync(rootBase).filter(d => existsSync(join(rootBase, d, 'state.json')))
    : [];
  const latest = dirs
    .map(d => ({ d, at: JSON.parse(readFileSync(join(rootBase, d, 'state.json'), 'utf8')).updatedAt ?? '' }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  campaign = latest?.d ?? null;
}
if (!campaign) {
  console.error('必须指定 --campaign <id> 或 --latest');
  process.exit(2);
}

const root = join(rootBase, campaign);
if (!existsSync(join(root, 'state.json'))) {
  console.error(`campaign state 不存在：${root}`);
  process.exit(2);
}
const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
const readJSON = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const readLines = path => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean)
  : []);

const index = readLines(join(root, 'research-index.jsonl'));
const memory = readLines(join(root, 'research-memory.jsonl'));
const supervisor = readJSON(join(root, 'supervisor-report.json'));

const candidates = state.rounds.flatMap(round =>
  (round.candidates ?? []).map(c => ({ ...c, round: round.round })));
const byId = new Map(candidates.map(c => [c.candidateId, c]));
const childrenOf = new Map();
for (const candidate of candidates) {
  if (!candidate.parentId) continue;
  if (!childrenOf.has(candidate.parentId)) childrenOf.set(candidate.parentId, []);
  childrenOf.get(candidate.parentId).push(candidate.candidateId);
}
const depthOf = (id) => {
  let depth = 1;
  let cursor = byId.get(id)?.parentId ?? null;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return depth;
};
const roots = candidates.filter(c => !c.parentId);

const lineageLines = [];
function render(nodeId, indent = 0) {
  const node = byId.get(nodeId);
  if (!node) return;
  const changed = node.lineage?.modulesChanged ?? [];
  const delta = node.deep?.metrics?.firstPlaceDelta;
  lineageLines.push(`${'  '.repeat(indent)}- ${nodeId} [${node.strategy ?? '?'}]` +
    `${changed.length ? ` changed=${changed.join(',')}` : ''}` +
    `${Number.isFinite(delta) ? ` delta=${delta}` : ''} stage=${node.stage}`);
  for (const child of childrenOf.get(nodeId) ?? []) render(child, indent + 1);
}
for (const root of roots) render(root.candidateId);

const deepByRound = state.rounds.map(round => {
  const confirmed = (round.candidates ?? [])
    .filter(c => c.deep?.status === 'done' && Number.isFinite(c.deep?.metrics?.firstPlaceDelta))
    .map(c => ({
      candidateId: c.candidateId,
      strategy: c.strategy ?? null,
      delta: c.deep.metrics.firstPlaceDelta,
      lower: c.deep.metrics.firstPlaceLower ?? null,
      pairs: c.deep.metrics.pairs ?? null,
    }));
  return { round: round.round, decision: round.researchPlan?.decision ?? null, confirmed };
}).filter(r => r.confirmed.length || r.decision);

const report = {
  schema: 'century-research-report-v1',
  generatedAt: new Date().toISOString(),
  campaign,
  status: state.status,
  codeVersion: state.codeVersion ? { codeDigest: state.codeVersion.codeDigest, head: state.codeVersion.headCommit } : null,
  budgetUsed: state.budgetUsed,
  budget: state.config?.budget ?? null,
  counts: {
    rounds: state.rounds.length,
    candidates: candidates.length,
    stageRoots: roots.length,
    maxLineageDepth: candidates.length ? Math.max(...candidates.map(c => depthOf(c.candidateId))) : 0,
    inheritedCandidates: candidates.filter(c => c.parentId).length,
    llmCandidates: candidates.filter(c => c.lineage?.operator === 'openevolve-llm').length,
    lineageRejected: candidates.filter(c => c.stage === 'lineage-rejected').length,
  },
  researchIndex: {
    total: index.length,
    bySchema: index.reduce((acc, e) => ({ ...acc, [e.schema]: (acc[e.schema] ?? 0) + 1 }), {}),
    llmTokens: index.reduce((sum, e) => sum + (Number.isFinite(e.llm?.totalTokens) ? e.llm.totalTokens : 0), 0),
    llmCalls: index.reduce((sum, e) => sum + (Number.isFinite(e.llm?.calls) ? e.llm.calls : 0), 0),
  },
  researchMemory: {
    entries: memory.length,
    hypotheses: memory.filter(e => e.kind === 'hypothesis'),
    updates: memory.filter(e => e.kind === 'hypothesis-update'),
    experiments: memory.filter(e => e.kind === 'experiment'),
    failures: memory.filter(e => e.kind === 'failure'),
  },
  deepByRound,
  lineage: lineageLines,
  supervisor: supervisor ? {
    startedAt: supervisor.startedAt,
    endedAt: supervisor.endedAt,
    actualHours: supervisor.actualHours,
    runs: supervisor.runs?.length ?? 0,
    failures: supervisor.failures?.length ?? 0,
    recoveries: supervisor.recoveries?.length ?? 0,
    modelFailover: supervisor.modelFailover?.length ?? 0,
    stopReason: supervisor.stopReason,
  } : null,
};

const text = JSON.stringify(report, null, 2);
const outPath = arg('out', null);
if (outPath) {
  writeFileSync(resolve(REPO_ROOT, String(outPath)), text);
  console.log(JSON.stringify({ written: resolve(REPO_ROOT, String(outPath)), campaign, counts: report.counts }, null, 2));
} else {
  console.log(text);
}
