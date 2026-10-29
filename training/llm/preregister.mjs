#!/usr/bin/env node
/** 阶段 C 预注册计划生成器（锁定后不得看结果再改）。
 *
 * 只生成计划与种子清单，不运行对局、不消费正式冠军验证池。
 * 样本量由预注册效应量/α/功效计算；若当前时间或预算不足，执行方必须如实报告
 * BLOCKED，不得用更小样本冒充正式确认。
 *
 * --block v1：原始计划（variance=1 极保守上界；sol 模型时代生成，已被 v2 supersede）。
 * --block v2：2026-10-27 修订（variance 上界来自阶段 B pilot 实测；luna 模型；
 *   新种子子块 [1.720e9, 1.725e9)，v1 种子保留不消费）。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requiredSeeds, minimumDetectableEffect } from '../evaluator/power.mjs';
import {
  AI10_LLM_BLOCK,
  AI10_LLM_CONFIRM_BLOCK, AI10_LLM_CONFIRM_MODE_BASE,
  AI10_LLM_CONFIRM_V2_BLOCK, AI10_LLM_CONFIRM_V2_MODE_BASE,
} from '../../ai5/lib/seed_policy.mjs';
import { loadChampion, MODES, REPO_ROOT } from './config.mjs';

const argv = process.argv.slice(2);
const value = (flag, fallback = undefined) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法: node training/llm/preregister.mjs [options]
  --effect 0.30              目标第一名率增量（预注册）
  --alpha 0.0125             每个人数层单侧 alpha（默认 Bonferroni 0.05/4）
  --power 0.8                目标统计功效
  --variance 1               配对 delta 方差上界（v1 保守=1；v2 建议 0.5）
  --block v1|v2              种子块版本（v2 使用 [1.720e9,1.725e9) 并声明 supersedes v1）
  --modes 2,3,4,5            人数层
  --experiment-id ID         默认 ai10-llm-confirm-<block>
  --provider-model MODEL     冻结模型（默认 gpt-5.6-sol；v2 用 gpt-5.6-luna）
  --decisions-per-game N     预算估算：单局决策数（默认 45；luna 实测 41）
  --tokens-per-decision N    预算估算：单决策 Token（默认 20000；luna 实测 18300）
  --median-decision-seconds S 预算估算：单决策延迟（默认 20；luna 实测 10.3）
  --out PATH                 输出计划 JSON`);
  process.exit(0);
}

const effect = Number(value('--effect', 0.30));
const alpha = Number(value('--alpha', 0.05 / 4));
const power = Number(value('--power', 0.8));
const variance = Number(value('--variance', 1));
if (!(variance > 0 && variance <= 1)) throw new Error(`variance 必须在 (0,1]：${variance}`);
const block = value('--block', 'v1');
if (!['v1', 'v2'].includes(block)) throw new Error(`--block 只支持 v1|v2：${block}`);
const modes = String(value('--modes', '2,3,4,5')).split(',').map(Number);
if (modes.some(m => !MODES.includes(m))) throw new Error(`人数非法：${modes}`);
const model = value('--provider-model', 'gpt-5.6-sol');
const decisionsPerGame = Math.max(1, Number(value('--decisions-per-game', 45)));
const tokensPerDecision = Math.max(1, Number(value('--tokens-per-decision', 20_000)));
const medianDecisionSeconds = Math.max(0.1, Number(value('--median-decision-seconds', 20)));
const experimentId = value('--experiment-id', `ai10-llm-confirm-${block}`);
const n = requiredSeeds({ effect, alpha, power, variance });
const mde = minimumDetectableEffect({ n, alpha, power, variance });
const champion = loadChampion();

const confirmBlock = block === 'v2' ? AI10_LLM_CONFIRM_V2_BLOCK : AI10_LLM_CONFIRM_BLOCK;
const modeBase = block === 'v2' ? AI10_LLM_CONFIRM_V2_MODE_BASE : AI10_LLM_CONFIRM_MODE_BASE;

let supersedes = null;
if (block === 'v2') {
  const v1Path = resolve(REPO_ROOT, 'training/llm/preregistrations/ai10-llm-confirm-v1.json');
  if (!existsSync(v1Path)) throw new Error(`v2 计划必须引用 v1：未找到 ${v1Path}`);
  const v1 = JSON.parse(readFileSync(v1Path, 'utf8'));
  supersedes = {
    plan: 'training/llm/preregistrations/ai10-llm-confirm-v1.json',
    planHash: v1.planHash,
    reason: 'v1 以 variance=1 极保守上界计算样本量（106/人数），且默认模型 gpt-5.6-sol 已触发配额上限；'
      + 'v2 方差上界 0.5 来自阶段 B pilot 实测（16 对样本方差 0.383，未使用任何确认种子），'
      + '模型固定为阶段 B 实测可用的 gpt-5.6-luna；v1 种子块未消费任何种子，保留不使用',
  };
}

const strata = {};
for (const mode of modes) {
  const base = modeBase(mode);
  const seeds = Array.from({ length: n }, (_, i) => base + i);
  if (seeds.at(-1) >= confirmBlock[1]) throw new Error(`${mode} 人层种子越界（${confirmBlock.join('..')}）`);
  for (const seed of seeds) {
    if (seed < AI10_LLM_BLOCK[0] || seed >= AI10_LLM_BLOCK[1]) throw new Error(`种子越出 AI10 总块：${seed}`);
  }
  strata[String(mode)] = {
    seatCount: mode,
    seedCount: n,
    seeds,
    focusSeats: seeds.map((_, i) => i % mode),
    seedBlock: [base, base + n],
    pairedDesign: '同一 seed 两局：LLM 焦点席 vs 冻结冠军同焦点席；其余席位冻结冠军',
  };
}
// 各人数子块互不重叠
const ranges = modes.map(mode => {
  const base = modeBase(mode);
  return [base, base + n];
});
for (let i = 0; i < ranges.length; i++) {
  for (let j = i + 1; j < ranges.length; j++) {
    if (ranges[i][1] > ranges[j][0] && ranges[j][1] > ranges[i][0]) {
      throw new Error('人数子块重叠');
    }
  }
}

const llmGames = n * modes.length;
const estimatedTokens = llmGames * decisionsPerGame * tokensPerDecision;
const estimatedSerialHours = (llmGames * decisionsPerGame * medianDecisionSeconds) / 3600;
const plan = {
  schema: 'century-llm-preregistration-v1',
  experimentId,
  stage: 'confirm',
  planVersion: block,
  lockedAt: new Date().toISOString(),
  objective: '比较 LLM 实时玩家与冻结冠军 joint-js5 的配对第一名率（唯一主指标）',
  primaryMetric: 'pairedFirstPlaceRateDelta（焦点席位是否取得唯一第一名）',
  design: {
    modes,
    commonRandomNumbers: true,
    focusSeatRotation: 'pairIndex % seatCount',
    opponentPool: 'frozen-champion-all-non-focus-seats',
    rulesVersion: 'engine-v2',
    haltOnFallback: '确认阶段启用 --halt-on-fallback：LLM 回退即暂停对局保留断点，防止回退污染配对；跨 5h 配额窗口 --resume 续跑',
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
    quotaModel: 'ChatGPT/Codex 5 小时滚动窗口；按窗口分批运行并用 --resume 续跑',
    note: 'ChatGPT 订阅内运行；无逐 token API 账单；不得替换为未预注册模型',
  },
  statistics: {
    effect, alpha, power, variance,
    varianceBasis: variance < 1
      ? `variance=${variance} 上界来自阶段 B pilot（16 对，实测样本方差 0.383）；未使用任何确认种子`
      : 'variance=1 保守上界（未用 pilot 校准）',
    requiredSeedsPerMode: n,
    minimumDetectableEffectAtN: mde,
    multipleTestingControl: 'Bonferroni α/4（2–5 人四层）',
    confidenceMethod: '种子簇级 paired delta 的 Student-t 单侧区间',
    minValidPairsPerMode: n,
    maxAnomalyRate: 0.02,
    maxFallbackAffectedPairRate: 0.10,
    decisionRule: '仅当样本完整、异常/回退率达标且四层联合区间支持时才可称正式确认；否则标记功效不足/阻塞',
  },
  ...(supersedes ? { supersedes } : {}),
  strata,
  execution: {
    status: 'not-started',
    budgetEstimate: {
      llmGames,
      decisionsPerGameAssumption: decisionsPerGame,
      tokensPerDecisionAssumption: tokensPerDecision,
      medianDecisionSecondsAssumption: medianDecisionSeconds,
      estimatedTokens,
      estimatedSerialHours,
      estimatedWindows5h: Math.max(1, Math.ceil(estimatedSerialHours / 3)),
      note: '基于阶段 B（gpt-5.6-luna）实测：41 决策/局、18.3k Token/决策、10.3s/决策。'
        + 'estimatedWindows5h 按 5h 滚动窗口内约 3 有效小时估算，实际用 --resume 跨窗口分批完成',
    },
    blockedReason: '阶段 C 尚未开始执行；Codex 5h 滚动额度需跨多窗口分批消费，执行时使用 --resume 续跑并如实记录每窗口进度',
  },
  files: {
    outputRoot: 'training/reports/llm-player',
    seedBlock: confirmBlock,
  },
};
const { planHash: _ignored, ...rest } = plan;
plan.planHash = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
const out = resolve(value('--out', resolve(REPO_ROOT, `training/llm/preregistrations/${experimentId}.json`)));
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify({
  out,
  planHash: plan.planHash,
  block,
  experimentId,
  model,
  effect, alpha, power, variance,
  requiredSeedsPerMode: n,
  mdeAtN: mde,
  totalPairs: n * modes.length,
  estimatedTokens,
  estimatedSerialHours: Number(estimatedSerialHours.toFixed(1)),
  estimatedWindows5h: plan.execution.budgetEstimate.estimatedWindows5h,
  supersedes: supersedes ? supersedes.planHash.slice(0, 12) : null,
  status: plan.execution.status,
}, null, 2));
