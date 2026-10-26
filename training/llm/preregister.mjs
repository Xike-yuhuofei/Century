#!/usr/bin/env node
/** 阶段 C 预注册计划生成器（锁定后不得看结果再改）。
 *
 * 只生成计划与种子清单，不运行对局、不消费正式冠军验证池。
 * 样本量由预注册效应量/α/功效计算；若当前时间或预算不足，执行方必须如实报告
 * BLOCKED，不得用更小样本冒充正式确认。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requiredSeeds, minimumDetectableEffect } from '../evaluator/power.mjs';
import {
  AI10_LLM_CONFIRM_BLOCK, AI10_LLM_CONFIRM_MODE_BASE,
} from '../../ai5/lib/seed_policy.mjs';
import { loadChampion, MODES, REPO_ROOT } from './config.mjs';

const argv = process.argv.slice(2);
const value = (flag, fallback = undefined) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法: node training/llm/preregister.mjs [options]
  --effect 0.30          目标第一名率增量（预注册）
  --alpha 0.0125         每个人数层单侧 alpha（默认 Bonferroni 0.05/4）
  --power 0.8            目标统计功效
  --variance 1           配对 delta 方差上界（1 为保守）
  --modes 2,3,4,5        人数层
  --out PATH             输出计划 JSON
  --provider-model MODEL 冻结模型（默认 gpt-5.6-sol）`);
  process.exit(0);
}

const effect = Number(value('--effect', 0.30));
const alpha = Number(value('--alpha', 0.05 / 4));
const power = Number(value('--power', 0.8));
const variance = Number(value('--variance', 1));
const modes = String(value('--modes', '2,3,4,5')).split(',').map(Number);
if (modes.some(m => !MODES.includes(m))) throw new Error(`人数非法：${modes}`);
const model = value('--provider-model', 'gpt-5.6-sol');
const n = requiredSeeds({ effect, alpha, power, variance });
const mde = minimumDetectableEffect({ n, alpha, power, variance });
const champion = loadChampion();
const strata = {};
for (const mode of modes) {
  const base = AI10_LLM_CONFIRM_MODE_BASE(mode);
  const seeds = Array.from({ length: n }, (_, i) => base + i);
  if (seeds.at(-1) >= AI10_LLM_CONFIRM_BLOCK[1]) throw new Error(`${mode} 人层种子越界`);
  strata[String(mode)] = {
    seatCount: mode,
    seedCount: n,
    seeds,
    focusSeats: seeds.map((_, i) => i % mode),
    seedBlock: [base, base + n],
    pairedDesign: '同一 seed 两局：LLM 焦点席 vs 冻结冠军同焦点席；其余席位冻结冠军',
  };
}
const plan = {
  schema: 'century-llm-preregistration-v1',
  experimentId: 'ai10-llm-confirm-v1',
  stage: 'confirm',
  lockedAt: new Date().toISOString(),
  objective: '比较 LLM 实时玩家与冻结冠军 joint-js5 的配对第一名率（唯一主指标）',
  primaryMetric: 'pairedFirstPlaceRateDelta（焦点席位是否取得唯一第一名）',
  design: {
    modes,
    commonRandomNumbers: true,
    focusSeatRotation: 'pairIndex % seatCount',
    opponentPool: 'frozen-champion-all-non-focus-seats',
    rulesVersion: 'engine-v2',
  },
  champion: {
    id: champion.id,
    fingerprint: champion.fingerprint,
    sourceSha256: champion.sourceSha256,
    sourcePath: champion.sourcePath,
  },
  provider: {
    kind: 'codex-cli',
    model,
    transport: 'codex exec --json',
    reasoningEffort: 'low',
    note: 'ChatGPT 订阅内运行；无逐 token API 账单；不得替换为未预注册模型',
  },
  statistics: {
    effect, alpha, power, variance,
    requiredSeedsPerMode: n,
    minimumDetectableEffectAtN: mde,
    multipleTestingControl: 'Bonferroni α/4（2–5 人四层）',
    confidenceMethod: '种子簇级 paired delta 的 Student-t 单侧区间',
    minValidPairsPerMode: n,
    maxAnomalyRate: 0.02,
    maxFallbackAffectedPairRate: 0.10,
    decisionRule: '仅当样本完整、异常/回退率达标且四层联合区间支持时才可称正式确认；否则标记功效不足/阻塞',
  },
  strata,
  execution: {
    status: 'not-started',
    budgetEstimate: {
      llmGames: n * modes.length,
      decisionsPerGameAssumption: 45,
      tokensPerDecisionAssumption: 20_000,
      estimatedTokens: n * modes.length * 45 * 20_000,
      medianDecisionSecondsAssumption: 20,
      estimatedSerialHours: (n * modes.length * 45 * 20) / 3600,
      note: '基于阶段 A/B 实测的单局决策数、单决策延迟与 Token 估算；并发可缩短墙钟但受 Codex 并发/配额限制',
    },
    blockedReason: '当前本地 ChatGPT/Codex 配额与墙钟预算不足以完成预注册样本；未开始阶段 C，不得用阶段 B 小样本冒充正式确认',
  },
  files: {
    outputRoot: 'training/reports/llm-player',
    seedBlock: AI10_LLM_CONFIRM_BLOCK,
  },
};
const { planHash: _ignored, ...rest } = plan;
plan.planHash = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
const out = resolve(value('--out', resolve(REPO_ROOT, 'training/llm/preregistrations/ai10-llm-confirm-v1.json')));
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify({
  out,
  planHash: plan.planHash,
  effect, alpha, power, variance,
  requiredSeedsPerMode: n,
  mdeAtN: mde,
  totalPairs: n * modes.length,
  estimatedTokens: plan.execution.budgetEstimate.estimatedTokens,
  estimatedSerialHours: plan.execution.budgetEstimate.estimatedSerialHours,
  status: plan.execution.status,
  blockedReason: plan.execution.blockedReason,
}, null, 2));
