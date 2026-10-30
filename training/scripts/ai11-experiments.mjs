#!/usr/bin/env node
/** 对照实验 A / B / C（真实 campaign 运行 + 原始证据保存 + 不确定性披露）。
 *
 * A：跨代继承有效性
 *   A0：旧路径（allowInheritance=false，每代从官方源码开始）
 *   A1：真实父代源码继承（allowInheritance=true）
 *
 * B：失败反馈有效性（需要真实 LLM）
 *   B0：仅综合分数（research-context=off，无简报）
 *   B1：分数 + 结构化 artifacts（research-context=artifacts）
 *   B2：结构化失败归因 + 可证伪假设（research-context=brief）
 *
 * C：研究效率
 *   C0：旧版直接变异（无 OpenEvolve、无简报）
 *   C1：科研闭环（简报 + 编排 + OpenEvolve，OpenEvolve 默认级联预算 stage2=16/stage3=48）
 *   C2：科研闭环 + 经实测有效的预算分配（6h 运行验证的 stage2=8/stage3=8 级联预算）
 *
 * 用法：
 *   node training/scripts/ai11-experiments.mjs --experiment A [--rounds 2 --candidates 3]
 *   node training/scripts/ai11-experiments.mjs --experiment B [--iterations 1]
 *
 * 纪律：每个 arm 使用独立 campaign 目录；正式验证池零接触；结果不明确时报告 inconclusive。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { wilsonCI } from '../evaluator/stats.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const experiment = String(arg('experiment', 'A')).toUpperCase();
const rounds = Number(arg('rounds', 2));
const candidates = Number(arg('candidates', 3));
const quickSeeds = Number(arg('quick-seeds', 4));
const deepSeeds = Number(arg('deep-seeds', 4));
const stamp = arg('stamp', new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12));
const outRoot = resolve(REPO_ROOT, 'training/reports/ai11-experiments', `${experiment}-${stamp}`);

const ARMS = {
  A: [
    { id: 'A0', flags: ['--no-inherit', '--research-context', 'off'], strategies: 'single,pair', useOpenEvolve: false, researchContext: 'off' },
    { id: 'A1', flags: ['--research-context', 'brief'], strategies: 'single,pair', useOpenEvolve: false, researchContext: 'brief' },
  ],
  B: [
    { id: 'B0', flags: ['--research-context', 'off'], strategies: 'openevolve', useOpenEvolve: true, researchContext: 'off' },
    { id: 'B1', flags: ['--research-context', 'artifacts'], strategies: 'openevolve', useOpenEvolve: true, researchContext: 'artifacts' },
    { id: 'B2', flags: ['--research-context', 'brief'], strategies: 'openevolve', useOpenEvolve: true, researchContext: 'brief' },
  ],
  C: [
    { id: 'C0', flags: ['--research-context', 'off', '--no-inherit'], strategies: 'single,pair', useOpenEvolve: false, researchContext: 'off' },
    { id: 'C1', flags: ['--research-context', 'brief'], strategies: 'single,pair,openevolve', useOpenEvolve: true, researchContext: 'brief' },
    {
      id: 'C2', flags: ['--research-context', 'brief'], strategies: 'single,pair,openevolve',
      useOpenEvolve: true, researchContext: 'brief',
      // 6h v4 实测可用：级联 stage2/3 各 8 种子，避免 16/48 默认预算拖垮长跑。
      env: { CENTURY_OPENEVOLVE_STAGE2_SEEDS: '8', CENTURY_OPENEVOLVE_STAGE3_SEEDS: '8' },
    },
  ],
};

const arms = ARMS[experiment];
if (!arms) {
  console.error(`未知实验：${experiment}（可选 A/B/C）`);
  process.exit(2);
}
mkdirSync(outRoot, { recursive: true });

function runArm(arm) {
  const campaign = `ai11-exp-${experiment}-${arm.id}-${stamp}`;
  const campaignRoot = resolve(REPO_ROOT, 'training/reports/coevolution', campaign);
  if (existsSync(campaignRoot)) return { arm: arm.id, status: 'skipped-existing', campaign };
  const cliArgs = [
    resolve(REPO_ROOT, 'training/evolution/autonomous-run.mjs'),
    'start', '--coevolve', '--campaign', campaign,
    '--rounds', String(rounds), '--candidates', String(candidates),
    '--quick-seeds', String(quickSeeds), '--deep-seeds', String(deepSeeds),
    '--deep-confirmations', '1', '--max-deep-confirmations', String(rounds * 2),
    '--player-counts', '2,3,4,5',
    '--strategies', arm.strategies,
    ...(arm.useOpenEvolve ? ['--openevolve-iterations', '1'] : []),
    '--max-candidates', String(rounds * candidates + 4),
    '--max-games', String(rounds * candidates * 200),
    '--max-wall-ms', String(3 * 3600_000),
    '--generation-seed', '20261101',
    '--no-auto-challenge',
    ...arm.flags,
  ];
  const result = spawnSync(process.execPath, cliArgs, {
    cwd: resolve(REPO_ROOT, 'training'), encoding: 'utf8', timeout: 3 * 3600_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(arm.env ?? {}) },
  });
  const resultsPath = join(campaignRoot, 'results.json');
  if (!existsSync(resultsPath)) {
    return { arm: arm.id, status: 'failed', campaign, stderr: (result.stderr ?? '').slice(-800) };
  }
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const launch = resolve(outRoot, arm.id);
  mkdirSync(launch, { recursive: true });
  copyFileSync(resultsPath, join(launch, 'results.json'));
  for (const name of ['research-index.jsonl', 'research-memory.jsonl']) {
    const source = join(campaignRoot, name);
    if (existsSync(source)) copyFileSync(source, join(launch, name));
  }
  const indexLines = existsSync(join(campaignRoot, 'research-index.jsonl'))
    ? readFileSync(join(campaignRoot, 'research-index.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const candidatesAll = results.rounds.flatMap(r => r.candidates ?? []);
  // 继承的判据是 parentId（真实父代 artifact），不是 lineage 字段存在与否：
  // A0 的"引导代"也会写 lineage（parentCandidateId=null），不能被误算成继承。
  const inherited = candidatesAll.filter(c => c.parentId);
  const lineage = candidatesAll.filter(c => c.lineage);
  const modulesChanged = inherited.filter(c => (c.lineage?.modulesChanged ?? []).length > 0).length;
  const parentMap = new Map(candidatesAll.map(c => [c.candidateId, c.parentId ?? null]));
  const depthOf = (id) => {
    let depth = 1;
    let cursor = parentMap.get(id) ?? null;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = parentMap.get(cursor) ?? null;
    }
    return depth;
  };
  const maxGenerationDepth = candidatesAll.length ? Math.max(...candidatesAll.map(c => depthOf(c.candidateId))) : 0;
  const distinctParents = new Set(inherited.map(c => c.parentId)).size;
  const behaviorHashes = new Set();
  const deep = candidatesAll.filter(c => c.deep?.status === 'done' && Number.isFinite(c.deep?.metrics?.firstPlaceDelta));
  const deltaValues = deep.map(c => c.deep.metrics.firstPlaceDelta);
  const positive = deltaValues.filter(d => d > 0).length;
  const tokens = indexLines.filter(e => e.llm && Number.isFinite(e.llm.totalTokens))
    .reduce((sum, e) => sum + e.llm.totalTokens, 0);
  const llmCandidates = indexLines.filter(e => e.generator === 'openevolve-llm').length;
  const summary = {
    arm: arm.id, campaign, status: results.status,
    rounds: results.rounds.length,
    candidates: results.budgetUsed.candidates,
    games: results.budgetUsed.games,
    wallMs: results.budgetUsed.wallMs,
    lineageCandidates: lineage.length,
    inheritedCandidates: inherited.length,
    distinctParents,
    maxGenerationDepth,
    modulesChangedCandidates: modulesChanged,
    inheritedChangeRate: inherited.length ? Number((modulesChanged / inherited.length).toFixed(4)) : null,
    deepConfirmed: deep.length,
    meanFirstPlaceDelta: deltaValues.length
      ? Number((deltaValues.reduce((s, x) => s + x, 0) / deltaValues.length).toFixed(4)) : null,
    positiveDeepSignals: positive,
    positiveSignalRateCI: deep.length ? wilsonCI(positive, deep.length) : null,
    llmCandidates,
    totalTokens: tokens,
    gamesPerPositiveSignal: positive ? Number((results.budgetUsed.games / positive).toFixed(2)) : null,
    tokensPerPositiveSignal: positive ? Number((tokens / positive).toFixed(0)) : null,
  };
  writeFileSync(join(launch, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

const summaries = [];
for (const arm of arms) {
  console.log(`running ${experiment}/${arm.id} ...`);
  summaries.push(runArm(arm));
}

const report = {
  schema: 'century-ai11-experiment-report-v1',
  experiment, stamp,
  config: { rounds, candidates, quickSeeds, deepSeeds },
  generatedAt: new Date().toISOString(),
  arms: summaries,
  note: '结果不确定时必须报告 inconclusive；不得以单点估计宣称新版获胜',
};
writeFileSync(join(outRoot, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
