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

function configFromArgs() {
  const playerCounts = args['player-counts']
    ? String(args['player-counts']).split(',').map(Number)
    : [2, 3, 4, 5];
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
      openevolveIterations: args['openevolve-iterations'] !== undefined
        ? Number(args['openevolve-iterations']) : 2,
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

async function main() {
  if (command === 'status') {
    const statePath = resolve(rootDir, 'state.json');
    if (!existsSync(statePath)) {
      console.log(JSON.stringify({ campaignId, status: 'not-found', statePath }, null, 2));
      return;
    }
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
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

  const capacity = command === 'start'
    ? assertResourceBudget({ requestedConcurrency: configFromArgs().budget.maxConcurrent })
    : evaluateCapacity({ requestedConcurrency: configFromArgs().budget.maxConcurrent });
  if (!capacity.ok) {
    console.log(JSON.stringify({ campaignId, status: 'blocked-by-resource', reasons: capacity.reasons, snapshot: capacity.snapshot }, null, 2));
    process.exit(3);
  }

  const autoChallenge = args['no-auto-challenge'] !== true;
  const controller = new CampaignController({
    campaignId,
    rootDir,
    governance,
    config: configFromArgs(),
    ...(autoChallenge ? { promotionHandler: createPromotionHandler() } : {}),
  });
  const started = Date.now();
  const results = await controller.run({ resume: command === 'resume' });
  // 总墙钟从 campaign 创建时刻计（resume 不得把已运行时长清零，否则 12h
  // 压力测试可通过重启伪造时长）。
  const stateDoc = JSON.parse(readFileSync(resolve(rootDir, 'state.json'), 'utf8'));
  const campaignStartedAt = stateDoc.createdAt ?? new Date(started).toISOString();
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
    candidates: results.rounds.flatMap(r => r.candidates).map(c => ({
      candidateId: c.candidateId,
      stage: c.stage,
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
