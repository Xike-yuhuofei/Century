#!/usr/bin/env node
/** P0：冻结统计计划（功效/样本量/阈值）。
 *
 * 用法：
 *   node training/scripts/statistical-plan.mjs --write
 *   node training/scripts/statistical-plan.mjs --check
 *
 * 规则：计划一经写出即冻结；--check 只校验当前 alpha 账本/阈值与冻结文件一致，
 * 绝不在看到正式结果后自动放宽。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import {
  ALPHA_LEDGER_PATH, readAlphaLedger, alphaForChallenge, alphaLedgerSummary,
} from '../lib/alpha-ledger.mjs';
import { buildPowerTable } from '../evaluator/power.mjs';
import { sha256Canonical } from '../evolution/core.mjs';
import { execFileSync } from 'node:child_process';

const PLAN_PATH = resolve(REPO_ROOT, 'training/readiness/statistical-plan.json');
const args = process.argv.slice(2);
const write = args.includes('--write');
const check = args.includes('--check');
if (!write && !check) {
  console.error('必须指定 --write 或 --check');
  process.exit(2);
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT }).trim();
const ledger = readAlphaLedger(ALPHA_LEDGER_PATH);
const summary = alphaLedgerSummary(ledger);
const nextIndex = summary.nextChallengeIndex;
const current = alphaForChallenge(nextIndex, ledger.alphaBudget, ledger.spendingPlan);
const sustainable = alphaForChallenge(1, ledger.alphaBudget, {
  mode: 'fixed-horizon-bonferroni',
  maxChallenges: 100,
});

const frozen = {
  schema: 'century-statistical-plan-v1',
  generatedAt: new Date().toISOString(),
  commit,
  primaryObjective: 'firstPlaceWinRate',
  primaryMetric: 'pairedFirstPlaceRateDelta',
  decisionMetric: 'weightedPairedFirstPlaceRateDelta',
  seatCounts: [2, 3, 4, 5],
  weights: { '2': 0.25, '3': 0.25, '4': 0.25, '5': 0.25 },
  nonInferiorityMargin: 0.02,
  alphaBudget: ledger.alphaBudget,
  alphaSpendingPlan: ledger.spendingPlan,
  multiplicity: 'IUT（主检验 + 各人数非劣效）；跨挑战由 alpha 账本控制',
  fixedSample: true,
  optionalStopping: false,
  minSeedsPerSeatCount: 60,
  maxSeedsPerSeatCount: 5000,
  powerTarget: 0.8,
  varianceAssumptions: {
    conservativeUpperBound: 1,
    typicalIndependent: 0.5,
    note: 'Var(delta)=pA(1−pA)+pB(1−pB)−2(p11−pA·pB)；未观测 p11 时使用上界 1',
  },
  currentChallenge: {
    challengeIndex: nextIndex,
    alpha: current.alpha,
    z: current.z,
    remainingBudget: summary.remaining,
    powerAt250: buildPowerTable({ alpha: current.alpha, power: 0.8 }),
  },
  sustainableScenario: {
    note: '预注册固定期限 Bonferroni：最多 100 次正式挑战，每次 α=0.05/100；需显式治理授权，不得静默切换',
    maxChallenges: 100,
    alpha: sustainable.alpha,
    z: sustainable.z,
    powerAt250: buildPowerTable({ alpha: sustainable.alpha, power: 0.8 }),
  },
  decisionRule: [
    '主检验：2–5 人加权第一名率增量单侧下界 > 0',
    '非劣效：每个人数单侧下界 ≥ −0.02',
    '跨人数种子不得复用；固定样本；禁止中途显著提前晋级',
    '任一条件不通过 → 保留冠军，不晋级',
  ],
  freezeDiscipline: [
    '本文件在读取正式验证结果之前写出；--check 只允许完全一致',
    '不得根据正式结果放宽 margin / alpha / 权重 / 最小样本',
    '统计预算耗尽时明确停止；新家族必须由 initializeAlphaFamily 显式授权并留痕',
  ],
};
const frozenHash = sha256Canonical(frozen);
const plan = { ...frozen, frozenHash };

if (write) {
  if (existsSync(PLAN_PATH)) {
    const existing = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
    if (existing.frozenHash !== frozenHash) {
      console.error(`拒绝覆盖已冻结统计计划：${PLAN_PATH}\n现有 ${existing.frozenHash} ≠ 新 ${frozenHash}`);
      console.error('如确需变更阈值，必须新建计划并写明治理授权；禁止在看到结果后放宽。');
      process.exit(3);
    }
  }
  writeJSON(PLAN_PATH, plan);
  console.log(JSON.stringify({
    written: PLAN_PATH,
    frozenHash,
    currentChallenge: {
      challengeIndex: nextIndex,
      alpha: current.alpha,
      mdeAt250: plan.currentChallenge.powerAt250.mdeAt250,
      mdeAt500: plan.currentChallenge.powerAt250.mdeAt500,
    },
    sustainableScenario: {
      alpha: sustainable.alpha,
      mdeAt250: plan.sustainableScenario.powerAt250.mdeAt250,
      mdeAt500: plan.sustainableScenario.powerAt250.mdeAt500,
    },
  }, null, 2));
  process.exit(0);
}

if (!existsSync(PLAN_PATH)) {
  console.error(`统计计划不存在：${PLAN_PATH}（先运行 --write）`);
  process.exit(1);
}
const existing = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
if (existing.frozenHash !== frozenHash) {
  console.error(`统计计划与当前账本/阈值不一致：记录 ${existing.frozenHash} ≠ 复算 ${frozenHash}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, frozenHash, plan: PLAN_PATH }, null, 2));
