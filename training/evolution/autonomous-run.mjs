#!/usr/bin/env node
/** P2/P5：无人值守自主进化 CLI（真实种子治理 + 真实开发池对局）。
 *
 * 子命令：
 *   start   --campaign <id> [--rounds N] [--quick-seeds N] [--deep-seeds N]
 *   resume  --campaign <id>
 *   stop    --campaign <id>
 *   status  --campaign <id>
 *
 * 说明：
 * - 使用 AI7 开发池 [1.61e9, 1.63e9)，中央登记原子分配；绝不消费验证池；
 * - 训练/快筛/深验种子互不重叠；checkpoint/恢复/停止/预算上限全部走控制器；
 * - 候选进入机器门禁队列后，默认由 promotion-handler 自动评估「是否值得发起
 *   预注册第一名率正式挑战」；alpha/功效不足时明确 BLOCKED，不消费验证种子；
 * - 晋级落地/发布仍由 CI 的 promotion-machine-gate 独立复核并 auto-merge。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureDir, writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { assertResourceBudget, evaluateCapacity, resourceSnapshot } from '../lib/resource-scheduler.mjs';
import { CampaignController } from './campaign-controller.mjs';
import {
  createLiveGovernanceProvider, createAutonomousGovernanceAdapter,
  createLiveGovernanceProviderAI9, createAutonomousGovernanceAdapterAI9,
} from './governance-provider-v2.mjs';
import { createPromotionHandler } from './promotion-handler.mjs';
import { createOpenEvolveCampaignGenerator, writeOpenEvolveEvidence } from './openevolve-campaign.mjs';
import { sha256Hex } from './core.mjs';

function parseArgs(argv) {
  const values = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { values._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const campaignId = args.campaign ? String(args.campaign) : null;
if (!campaignId) {
  console.error('必须提供 --campaign <id>');
  process.exit(2);
}
const coevolve = args.coevolve === true;
const rootDir = resolve(REPO_ROOT, coevolve ? 'training/reports/coevolution' : 'training/reports/autonomous', campaignId);
const governance = coevolve
  ? createAutonomousGovernanceAdapterAI9({ provider: createLiveGovernanceProviderAI9() })
  : createAutonomousGovernanceAdapter({ provider: createLiveGovernanceProvider() });
const CODE_VERSION_PATH = resolve(rootDir, 'code-version.json');
/** 12h/R09 证据必须能绑定到具体代码版本：commit + 干净工作区 + 训练核心模块哈希。 */
const CODE_MODULES = [
  'training/evolution/autonomous-run.mjs',
  'training/evolution/campaign-controller.mjs',
  'training/evolution/dev-evaluator.mjs',
  'training/evolution/candidate-generator.mjs',
  'training/evolution/selection.mjs',
  'training/evolution/safety-check.mjs',
  'training/lib/seed-governance.mjs',
  'web-v1/dist/js/engine.js',
  'web-v1/dist/js/ai.js',
  'web-v1/dist/js/js/adapter.js',
  'web-v1/dist/js/ai/decision.js',
  'web-v1/dist/js/js/champion-guided.js',
  'web-v1/dist/js/js/joint-rollout.js',
  'web-v1/dist/js/js/planner.js',
  'web-v1/dist/js/js/config.js',
  'web-v1/dist/js/ai-runtime/decision-core.js',
];

function computeCodeVersion() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  }).trim().length > 0;
  const modules = {};
  for (const path of CODE_MODULES) {
    modules[path] = sha256Hex(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
  }
  return {
    schema: 'century-code-version-v1',
    commit,
    dirty,
    modules,
    recordedAt: new Date().toISOString(),
    note: 'campaign 启动时冻结；resume 必须完全一致；R09 验收要求 dirty=false 且模块哈希与当前代码一致',
  };
}

function assertResumeCodeVersion() {
  if (!existsSync(CODE_VERSION_PATH)) {
    throw new Error(`resume 缺少 code-version.json（${CODE_VERSION_PATH}）——无法证明与启动时同一代码版本，拒绝恢复`);
  }
  const recorded = JSON.parse(readFileSync(CODE_VERSION_PATH, 'utf8'));
  const current = computeCodeVersion();
  if (recorded.dirty !== false) {
    throw new Error('启动时工作区不干净（dirty=true），该 campaign 不能作为可复现证据');
  }
  // 运行过程中会写入种子登记、证据与检查点，工作区 dirty 必然从 false 变为 true；
  // 恢复时只要求 commit 与训练核心/构建产物哈希一致，不要求当前工作区干净。
  if (recorded.commit !== current.commit) {
    throw new Error(`resume 代码版本不一致：启动=${recorded.commit}，当前=${current.commit}`);
  }
  for (const [path, hash] of Object.entries(recorded.modules ?? {})) {
    if (current.modules[path] !== hash) {
      throw new Error(`resume 训练模块已变化：${path}（启动 ${String(hash).slice(0, 12)} ≠ 当前 ${String(current.modules[path]).slice(0, 12)}）`);
    }
  }
  return recorded;
}

function configFromArgs() {
  const playerCounts = args['player-counts']
    ? String(args['player-counts']).split(',').map(Number)
    : [2, 3, 4, 5];
  const generatorMode = args.generator ? String(args.generator) : 'bounded';
  const sourceEvolution = generatorMode === 'openevolve-hybrid' || generatorMode === 'openevolve-only';
  return {
    rounds: args.rounds !== undefined ? Number(args.rounds) : 1,
    ...(coevolve ? { configRef: 'ai9://campaign/coevolution' } : {}),
    playerCounts,
    quickSeeds: args['quick-seeds'] !== undefined ? Number(args['quick-seeds']) : 4,
    deepSeeds: args['deep-seeds'] !== undefined ? Number(args['deep-seeds']) : 6,
    maxMoves: args['max-moves'] !== undefined ? Number(args['max-moves']) : 400,
    deadlineMs: args['deadline-ms'] !== undefined ? Number(args['deadline-ms']) : 60_000,
    retainTopK: args['retain-top-k'] !== undefined ? Number(args['retain-top-k']) : 3,
    deepConfirmations: args['deep-confirmations'] !== undefined ? Number(args['deep-confirmations']) : 2,
    generation: {
      count: args['candidates'] !== undefined ? Number(args['candidates']) : 6,
      seed: args['generation-seed'] !== undefined ? Number(args['generation-seed']) : 20_261_025,
      targetIds: args.targets
        ? String(args.targets).split(',')
        : (args.modules ? String(args.modules).split(',') : null),
      mode: coevolve ? 'multi-module' : 'descriptor',
      strategies: args.strategies ? String(args.strategies).split(',') : null,
      generator: generatorMode,
      openevolveIterations: args['openevolve-iterations'] !== undefined
        ? Number(args['openevolve-iterations']) : 2,
      openevolve: sourceEvolution ? {
        iterations: args['openevolve-iterations'] !== undefined ? Number(args['openevolve-iterations']) : 1,
        timeoutMs: args['openevolve-timeout-ms'] !== undefined
          ? Number(args['openevolve-timeout-ms']) : 3_600_000,
        outputDir: args['openevolve-output'] ? resolve(REPO_ROOT, String(args['openevolve-output'])) : null,
        onLlmUnavailable: args['on-llm-unavailable'] ? String(args['on-llm-unavailable']) : 'fallback',
      } : null,
      includeControl: args['no-control'] !== true,
      allowDeterministicFallback: args['no-deterministic-fallback'] !== true,
    },
    budget: {
      maxCandidates: args['max-candidates'] !== undefined ? Number(args['max-candidates']) : 24,
      maxGames: args['max-games'] !== undefined ? Number(args['max-games']) : 600,
      maxWallMs: args['max-wall-ms'] !== undefined ? Number(args['max-wall-ms']) : 6 * 3600_000,
      maxConcurrent: args['max-concurrent'] !== undefined ? Number(args['max-concurrent']) : 2,
      maxDeepConfirmations: args['max-deep-confirmations'] !== undefined ? Number(args['max-deep-confirmations']) : 4,
    },
    continueFromSelected: args['continue-from-selected'] === true,
  };
}

/** 依据配置构建生成器；bounded 走控制器默认的确定性变异。 */
function generatorFromConfig(config) {
  if (config.generation.generator === 'bounded') return null;
  const source = config.generation.openevolve;
  return createOpenEvolveCampaignGenerator({
    mode: config.generation.generator,
    iterations: source.iterations,
    timeoutMs: source.timeoutMs,
    outputDir: source.outputDir,
    onLlmUnavailable: source.onLlmUnavailable,
  });
}

async function main() {
  if (command === 'status') {
    const statePath = resolve(rootDir, 'state.json');
    if (!existsSync(statePath)) {
      console.log(JSON.stringify({ campaignId, status: 'not-found', statePath }, null, 2));
      return;
    }
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const codeVersion = existsSync(CODE_VERSION_PATH)
      ? JSON.parse(readFileSync(CODE_VERSION_PATH, 'utf8'))
      : null;
    console.log(JSON.stringify({
      campaignId,
      status: state.status,
      phase: state.phase,
      rounds: state.rounds?.length ?? 0,
      currentRound: state.rounds?.[state.currentRoundIndex]?.round ?? null,
      budgetUsed: state.budgetUsed,
      promotionQueue: state.promotionQueue?.length ?? 0,
      promotionOutcomes: state.promotionOutcomes ?? [],
      checkpointSeq: state.checkpointSeq,
      updatedAt: state.updatedAt,
      codeVersion,
      resource: resourceSnapshot(),
    }, null, 2));
    return;
  }
  if (command === 'stop') {
    ensureDir(rootDir);
    writeJSON(resolve(rootDir, '.stop'), { reason: 'operator-request', at: new Date().toISOString() });
    console.log(JSON.stringify({ campaignId, status: 'stop-requested' }, null, 2));
    return;
  }
  if (command !== 'start' && command !== 'resume') {
    console.error(`未知子命令：${String(command)}（支持 start|resume|stop|status）`);
    process.exit(2);
  }

  const config = configFromArgs();
  const capacity = command === 'start'
    ? assertResourceBudget({ requestedConcurrency: config.budget.maxConcurrent })
    : evaluateCapacity({ requestedConcurrency: config.budget.maxConcurrent });
  if (!capacity.ok) {
    console.log(JSON.stringify({ campaignId, status: 'blocked-by-resource', reasons: capacity.reasons, snapshot: capacity.snapshot }, null, 2));
    process.exit(3);
  }

  const autoChallenge = args['no-auto-challenge'] !== true;
  ensureDir(rootDir);
  if (command === 'start') {
    if (existsSync(CODE_VERSION_PATH)) {
      throw new Error(`code-version.json 已存在（${CODE_VERSION_PATH}）——同一 campaign 重复 start 被拒绝；恢复请用 resume`);
    }
    writeJSON(CODE_VERSION_PATH, computeCodeVersion());
  } else {
    assertResumeCodeVersion();
  }
  const codeVersion = JSON.parse(readFileSync(CODE_VERSION_PATH, 'utf8'));
  const controller = new CampaignController({
    campaignId,
    rootDir,
    governance,
    config,
    generator: generatorFromConfig(config),
    ...(autoChallenge ? { promotionHandler: createPromotionHandler() } : {}),
  });
  const started = Date.now();
  const results = await controller.run({ resume: command === 'resume' });
  // 总墙钟从 campaign 创建时刻计（resume 不得把已运行时长清零，否则 12h
  // 压力测试可通过重启伪造时长）。
  const stateDoc = JSON.parse(readFileSync(resolve(rootDir, 'state.json'), 'utf8'));
  const campaignStartedAt = stateDoc.createdAt ?? new Date(started).toISOString();
  const sourceEvolution = config.generation.generator !== 'bounded';
  const openEvolveEvidence = [];
  if (sourceEvolution) {
    for (const round of results.rounds) {
      if (!round.generatorMeta) continue;
      const written = writeOpenEvolveEvidence({
        dir: resolve(rootDir, 'openevolve'), round: round.round, generatorMeta: round.generatorMeta,
      });
      if (written) openEvolveEvidence.push(written);
    }
  }
  const summary = {
    schema: 'century-autonomous-run-summary-v1',
    campaignId,
    command,
    startedAt: campaignStartedAt,
    elapsedMs: Math.max(0, Date.now() - Date.parse(campaignStartedAt)),
    status: results.status,
    phase: results.phase,
    rounds: results.rounds.length,
    budgetUsed: results.budgetUsed,
    promotionQueue: results.promotionQueue,
    promotionOutcomes: results.promotionOutcomes,
    codeVersion,
    generator: {
      mode: config.generation.generator,
      sourceEvolution,
      openevolve: config.generation.openevolve,
      sourceCandidates: results.rounds.flatMap(r => r.candidates)
        .filter(c => c.generator === 'openevolve-llm')
        .map(c => ({ candidateId: c.candidateId, stage: c.stage, buildKind: c.buildKind, sourceHash: c.sourceHash })),
      evidenceFiles: openEvolveEvidence,
    },
    candidates: results.rounds.flatMap(r => r.candidates).map(c => ({
      candidateId: c.candidateId,
      stage: c.stage,
      generator: c.generator ?? null,
      quick: c.quick?.metrics ?? null,
      deep: c.deep?.metrics ?? null,
    })),
    resourceAfter: resourceSnapshot(),
    autoChallenge,
    note: '候选进入机器门禁队列后自动评估正式挑战资格；冠军落地/发布由 CI 机器门禁完成，本 CLI 不直接改冠军',
  };
  writeJSON(resolve(rootDir, 'run-summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(`自主进化运行失败：${error.stack ?? error.message}`);
  process.exit(1);
});
