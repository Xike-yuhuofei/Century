#!/usr/bin/env node
/** AI5 候选 66f6a296aa72 的正式冠军挑战编排。
 *
 * 流程（严格复用 AI 4.0 机制，不绕过任何防线）：
 * 1. 合并全部已知验证账本历史（正式 2 次 + 本地 3 次），本次 challengeIndex = 6，
 *    alpha 按几何消耗收紧（α₆ = 5%/2⁶）——宁可最严，不得伪造小序号；
 * 2. assertBlockFree 后消费下一个互不重叠的验证种子块（900M 池内）；
 * 3. 用 training/tournament/challenge.mjs 的 challengeWithDecision 跑 60 种子
 *    双向配对挑战（挑战种子全部来自验证池，与训练/快筛种子物理隔离）；
 * 4. 产出 promote-champion 兼容的 candidate.json（含 confirmation 逐种子证据 +
 *    challengeIndex + alphaBudget + engineBundleSha256 + codeCommit）与续接账本。
 *
 * 用法：node run-formal-challenge.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextValidationBase, consumeLedger, assertBlockFree, validationChallengeCount, VALIDATION_POOL_BASE } from '../../../training/lib/seeds.mjs';
import { challengeWithDecision } from '../../../training/tournament/challenge.mjs';
import { requireBuiltEngine, engineBundleSha256, REPO_ROOT } from '../../../training/lib/paths.mjs';
import { validateAIParameters } from '../../../web-v1/dist/js/ai/parameters.js';

const here = fileURLToPath(import.meta.url);
const outDir = resolve(here, '..', 'reports', 'challenge-ai5-goal-remaining');
mkdirSync(outDir, { recursive: true });
requireBuiltEngine();

// ---- 候选版本：官方 bundle 中的 goal-remaining 变体（66f6a296aa72） ----
const candidateParameters = {
  id: 'ai5-goal-remaining',
  structure: 'beam-rollout',                    // 与冠军同结构，隔离唯一变量
  acquisitionVariant: 'goal-remaining',
  engineWeight: 1, tempoWeight: 1, contestWeight: 1, synergyWeight: 1,
  goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
};
validateAIParameters(candidateParameters);

const champion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const championParameters = champion.parameters;

// ---- 1. 合并全部已知验证账本（防伪造小序号：累计全部已记账挑战） ----
const ledgerSources = [
  'training/reports/structure-challenge-rollout-confirm/validation-ledger.json', // PR #11 晋级挑战（2 次）
  'training/reports/evolve-latest/validation-ledger.json',                       // 本地进化确认挑战（3 次）
];
const merged = { history: [] };
for (const rel of ledgerSources) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) { console.error(`账本缺失（跳过）：${rel}`); continue; }
  const ledger = JSON.parse(readFileSync(p, 'utf8'));
  for (const entry of ledger.history ?? []) {
    if (!merged.history.some(e => e.base === entry.base)) merged.history.push(entry);
  }
}
merged.challengeCount = validationChallengeCount({ history: merged.history });
const challengeIndex = merged.challengeCount + 1;
console.log(`历史已消费块 ${merged.history.length} 个，累计确认挑战 ${merged.challengeCount} 次 → 本次 challengeIndex=${challengeIndex}`);

// ---- 2. 分配并防重校验验证种子块 ----
const seedBase = nextValidationBase(merged);
assertBlockFree(seedBase, 60, merged);
console.log(`本次验证种子块：[${seedBase}, ${seedBase + 60})（验证池起点 ${VALIDATION_POOL_BASE}）`);

// ---- 3. 正式挑战（60 种子 × 2 局 = 120 局，双向配对 + 座位轮换 + 冠军独占对手） ----
const SEEDS = 60;
const { summary, games } = challengeWithDecision({
  champion: championParameters,
  candidate: candidateParameters,
  seeds: SEEDS,
  seedBase,
  minSeeds: 60,
  challengeIndex,
});
console.log(JSON.stringify({
  verdict: summary.decision.verdict, reason: summary.decision.reason,
  paired: summary.paired, candidateWinRate: summary.candidateWinRate,
  anomalyRate: summary.anomalyRate,
}, null, 2));

// ---- 4. 产出晋级脚本兼容的 candidate.json + 续接账本 ----
const ledger = consumeLedger(merged, seedBase, SEEDS);
writeFileSync(resolve(outDir, 'candidate.json'), JSON.stringify({
  id: candidateParameters.id,
  name: 'AI5 进化候选 goal-remaining（66f6a296aa72）',
  description: 'OpenEvolve 自动进化的商人卡获取估值变体：goalFit 只统计目标魔像还缺的水晶。' +
    '变体实现已注册进官方 bundle（acquisitionVariant 参数轴），挑战走 AI 4.0 正式流程。',
  basedOn: champion.id,
  parameters: candidateParameters,
  confirmation: {
    seeds: SEEDS, games: summary.finishedGames,
    seedBase,
    challengeIndex,
    alphaBudget: summary.decision.alphaBudget,
    paired: summary.paired,
    seedPairs: summary.seedPairs,
    firstPlace: summary.firstPlace,
    winRate: summary.candidateWinRate, pairedDiff: summary.pairedDiffCI,
    ci: summary.decision.ci, decision: summary.decision,
  },
  engineBundleSha256: engineBundleSha256(),
  codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  generatedAt: new Date().toISOString(),
}, null, 2));
writeFileSync(resolve(outDir, 'validation-ledger.json'), JSON.stringify(ledger, null, 2));
writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`证据目录：${outDir}`);
