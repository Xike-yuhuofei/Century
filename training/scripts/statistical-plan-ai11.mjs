#!/usr/bin/env node
/** P0.4：AI 11.0 预注册统计计划（固定期限 Bonferroni 家族 + 分组顺序检验）。
 *
 * 背景：历史几何 alpha 家族在第 12 次挑战时 α=1.22e-5，保守方差下 500 种子/人数
 * 的功效只有 0.599，正式挑战被永久 BLOCKED（统计功效死锁）。本脚本给出**可执行**
 * 的替代计划：
 * - 固定期限家族：最多 K 次正式挑战，每次 α = alphaBudget / K（FWER ≤ alphaBudget）；
 * - 单次挑战内两次查看（interim 50% / final 100%），边界由 H0 模拟校准；
 * - 保守方差上界 1.0（不依赖"典型 0.5"的乐观假设）；
 * - 最小有意义效应（MDE）在计划中冻结，不允许看结果后调整。
 *
 * 用法：
 *   node training/scripts/statistical-plan-ai11.mjs --write
 *   node training/scripts/statistical-plan-ai11.mjs --check
 *   node training/scripts/statistical-plan-ai11.mjs --authorize <governance-record-id>
 *
 * --authorize 是**显式治理动作**：创建新家族账本并登记到 alpha-families.json，
 * 旧几何账本保持不变、继续可审计。没有 authorize 时只生成计划，不改账本。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import {
  ALPHA_FAMILIES_PATH, initializeAlphaFamily, readAlphaFamilies,
} from '../lib/alpha-ledger.mjs';
import { calibrateSequentialBoundaries, requiredSequentialSeeds } from '../evaluator/sequential.mjs';
import { sha256Canonical } from '../evolution/core.mjs';

const PLAN_PATH = resolve(REPO_ROOT, 'training/readiness/statistical-plan-ai11.json');
const FAMILY_ID = 'century-fixed-horizon-ai11';
const FAMILY_LEDGER = 'training/governance/alpha-ledger-ai11.json';
const MAX_CHALLENGES = 12;
const ALPHA_BUDGET = 0.05;
const LOOKS = [1.0];   // 当前 challenge runner 为固定样本单次检验；两次查看作为已评估的备选方案记录在 alternativeDesign
const VARIANCE = 1.0;               // 保守上界（paired delta ∈ {−1,0,1} 的最大方差口径）
const EFFECTS = [0.10, 0.15, 0.20, 0.25, 0.30];
const PRIMARY_EFFECT = 0.20;        // 冻结的最小有意义效应（20pp）
const MAX_GAMES_PER_CHALLENGE = 4000;   // M4 上约 12 小时；超出即报告"不可行"
const MEASURED_GAMES_PER_MINUTE = 5.5;  // 36h campaign 实测（12960 局 / 39.24h）

const args = process.argv.slice(2);
const write = args.includes('--write');
const check = args.includes('--check');
const authorizeIndex = args.indexOf('--authorize');
const authorization = authorizeIndex >= 0 ? args[authorizeIndex + 1] : null;
if (!write && !check && authorization === null) {
  console.error('必须指定 --write / --check / --authorize <governance-record-id>');
  process.exit(2);
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT }).trim();
const alpha = ALPHA_BUDGET / MAX_CHALLENGES;

/** 备选：两次查看（interim 50% / final 100%）的模拟结果（仅记录，不启用）。 */
function buildAlternativeDesign() {
  const calibration = calibrateSequentialBoundaries({
    alpha, lookFractions: [0.5, 1.0], variance: VARIANCE, trials: 30000, seed: 20261103,
  });
  const required = requiredSequentialSeeds({
    boundaries: calibration.boundaries, lookFractions: [0.5, 1.0], effect: PRIMARY_EFFECT,
    variance: VARIANCE, targetPower: 0.8, trials: 20000, seed: 20261104,
  });
  return {
    lookFractions: [0.5, 1.0],
    boundaries: calibration.boundaries.map(x => Number(x.toFixed(6))),
    h0Fwer: calibration.h0Fwer,
    seedsPerSeat: required.nMax,
    totalGames: required.nMax === null ? null : required.nMax * 4 * 2,
    expectedSeedsPerSeat: required.expectedN === null ? null : Number(required.expectedN.toFixed(1)),
    power: Number(required.achievedPower?.toFixed(4) ?? 0),
    note: '效果大时可在 50% 信息量提前成功停止；实现 interim 后才能切换',
  };
}

function buildPlan() {
  const calibration = calibrateSequentialBoundaries({
    alpha, lookFractions: LOOKS, variance: VARIANCE, trials: 50000, seed: 20261101,
  });
  const grid = EFFECTS.map(effect => {
    const required = requiredSequentialSeeds({
      boundaries: calibration.boundaries, lookFractions: LOOKS, effect, variance: VARIANCE,
      targetPower: 0.8, trials: 30000, seed: 20261102,
    });
    const seedsPerSeat = required.nMax;
    const games = seedsPerSeat === null ? null : seedsPerSeat * 4 * 2;
    return {
      effect,
      seedsPerSeat,
      totalGames: games,
      estimatedHours: games === null ? null : Number((games / (MEASURED_GAMES_PER_MINUTE * 60)).toFixed(2)),
      achievablePower: Number(required.achievedPower?.toFixed(4) ?? 0),
      expectedSeedsPerSeat: required.expectedN ?? null,
      feasibleWithinBudget: games !== null && games <= MAX_GAMES_PER_CHALLENGE,
    };
  });
  const primary = grid.find(g => Math.abs(g.effect - PRIMARY_EFFECT) < 1e-9);
  if (!primary || !primary.feasibleWithinBudget) {
    throw new Error(`最小有意义效应 ${PRIMARY_EFFECT} 在当前预算下不可行——必须报告挑战不可行，不得放宽阈值`);
  }
  return {
    schema: 'century-statistical-plan-ai11-v1',
    generatedAt: new Date().toISOString(),
    commit,
    primaryObjective: 'firstPlaceWinRate',
    primaryMetric: 'pairedFirstPlaceRateDelta',
    seatCounts: [2, 3, 4, 5],
    weights: { '2': 0.25, '3': 0.25, '4': 0.25, '5': 0.25 },
    nonInferiorityMargin: 0.02,
    family: {
      familyId: FAMILY_ID,
      ledgerPath: FAMILY_LEDGER,
      mode: 'fixed-horizon-bonferroni',
      maxChallenges: MAX_CHALLENGES,
      alphaBudget: ALPHA_BUDGET,
      alphaPerChallenge: alpha,
      note: `最多 ${MAX_CHALLENGES} 次正式挑战，每次 α=${alpha}；期满必须停止或显式重新授权新家族`,
    },
    sequentialDesign: {
      active: false,
      note: '当前按固定样本单次 final look 执行；两次查看的顺序设计已模拟验证，需 runner 支持 interim 后才能启用',
      lookFractions: LOOKS,
      boundaries: calibration.boundaries.map(x => Number(x.toFixed(6))),
      nominalAlphaSpent: calibration.alphaSpentNominal.map(x => Number(x.toFixed(6))),
      h0Fwer: calibration.h0Fwer,
      calibrationTrials: calibration.trials,
      calibrationSeed: calibration.seed,
      recheckSeed: calibration.recheckSeed,
      model: 'Z(t) = mean(t)/SE(t)，look 相关 ρ=sqrt(t_min/t_max)，非中心 λ=effect*sqrt(n*t/variance)',
      discipline: '边界由 H0 模拟校准并复算；不得在查看正式结果后调整',
    },
    alternativeDesign: buildAlternativeDesign(),
    varianceModel: {
      used: VARIANCE,
      note: '保守上界：配对 delta ∈ {−1,0,+1} 且未知 p11 时取方差上界 1；不采用"典型 0.5"乐观假设',
    },
    minimumMeaningfulEffect: PRIMARY_EFFECT,
    powerTarget: 0.8,
    grid,
    primaryDesign: primary,
    throughput: {
      measuredGamesPerMinute: MEASURED_GAMES_PER_MINUTE,
      source: 'training/reports/coevolution/ai9-36h-endurance-2（12,960 局 / 39.24h）',
      note: '计划中的小时数只是资源可行性估计，不是验收标准',
    },
    maxGamesPerChallenge: MAX_GAMES_PER_CHALLENGE,
    decisionRule: [
      '主检验：2–5 人加权第一名率增量在顺序边界下越过临界值',
      '非劣效：每个人数单侧下界 ≥ −0.02（final look）',
      '跨人数种子不得复用；interim 只允许"提前成功"，不允许"提前失败"后放宽样本',
      '任一条不满足 → 保留冠军，不晋级；不得复用正式验证种子重跑',
    ],
    feasibility: {
      note: '若真实效应小于 MDE，计划会明确报告"挑战不可行"，而不是伪造通过',
      maxGamesPerChallenge: MAX_GAMES_PER_CHALLENGE,
    },
    freezeDiscipline: [
      '本文件在读取任何正式验证结果之前写出；--check 只允许完全一致',
      '不得根据正式结果放宽 effect / alpha / 方差 / 边界 / 样本量',
      '新 alpha 家族必须由 --authorize 显式创建并登记，旧账本永久保留',
    ],
  };
}

/** 冻结哈希只覆盖统计内容：生成时间与 commit 是审计元数据，不参与一致性校验
 * （否则每次提交/重新生成都会让 --check 失败）。 */
function hashInput(value) {
  const { generatedAt: _generatedAt, commit: _commit, frozenHash: _frozenHash, ...rest } = value;
  return rest;
}

const frozen = buildPlan();
const frozenHash = sha256Canonical(hashInput(frozen));
const plan = { ...frozen, frozenHash };

if (authorization !== null) {
  if (authorization.trim().length < 8) {
    console.error('--authorize 必须提供非空治理记录 id（≥8 字符）');
    process.exit(2);
  }
  if (existsSync(resolve(REPO_ROOT, FAMILY_LEDGER))) {
    console.error(`家族账本已存在：${FAMILY_LEDGER}——禁止重建；如确需新家族必须使用新路径`);
    process.exit(3);
  }
  initializeAlphaFamily({
    mode: 'fixed-horizon-bonferroni',
    maxChallenges: MAX_CHALLENGES,
    alphaBudget: ALPHA_BUDGET,
    authorization,
    authorizedBy: 'Xike-yuhuofei',
    familyId: FAMILY_ID,
    ledgerPath: resolve(REPO_ROOT, FAMILY_LEDGER),
  });
  const registry = {
    schema: 'century-alpha-families-v1',
    updatedAt: new Date().toISOString(),
    active: FAMILY_ID,
    families: [
      {
        familyId: 'century-formal-challenges-v1',
        ledgerPath: 'training/governance/alpha-ledger.json',
        mode: 'geometric',
        legacy: true,
        note: '历史几何家族：11 次消耗，剩余 2.44e-5；只读保留审计',
      },
      {
        familyId: FAMILY_ID,
        ledgerPath: FAMILY_LEDGER,
        mode: 'fixed-horizon-bonferroni',
        maxChallenges: MAX_CHALLENGES,
        alphaBudget: ALPHA_BUDGET,
        alphaPerChallenge: alpha,
        authorization,
        authorizedBy: 'Xike-yuhuofei',
        createdAt: new Date().toISOString(),
        note: 'P0.4：仿真校准顺序检验 + 保守方差 + 冻结 MDE；旧家族不删除',
      },
    ],
  };
  writeJSON(ALPHA_FAMILIES_PATH, registry);
  writeJSON(PLAN_PATH, plan);
  console.log(JSON.stringify({
    authorized: FAMILY_ID,
    ledger: FAMILY_LEDGER,
    registry: ALPHA_FAMILIES_PATH,
    plan: PLAN_PATH,
    frozenHash,
    primaryDesign: plan.primaryDesign,
    h0Fwer: plan.sequentialDesign.h0Fwer,
    boundaries: plan.sequentialDesign.boundaries,
  }, null, 2));
  process.exit(0);
}

if (write) {
  if (existsSync(PLAN_PATH)) {
    const existing = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
    if (existing.frozenHash !== frozenHash) {
      console.error(`拒绝覆盖已冻结计划：${PLAN_PATH}\n现有 ${existing.frozenHash} ≠ 新 ${frozenHash}`);
      process.exit(3);
    }
  }
  writeJSON(PLAN_PATH, plan);
  console.log(JSON.stringify({ written: PLAN_PATH, frozenHash, primaryDesign: plan.primaryDesign }, null, 2));
  process.exit(0);
}

if (!existsSync(PLAN_PATH)) {
  console.error(`计划不存在：${PLAN_PATH}（先 --write）`);
  process.exit(1);
}
const existing = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
if (existing.frozenHash !== frozenHash) {
  console.error(`计划与当前输入不一致：记录 ${existing.frozenHash} ≠ 复算 ${frozenHash}`);
  process.exit(1);
}
const families = readAlphaFamilies();
if (!families.families.some(f => f.familyId === FAMILY_ID)) {
  console.error(`计划已冻结但家族未登记：${FAMILY_ID}（需 --authorize）`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, frozenHash, active: families.active, plan: PLAN_PATH }, null, 2));
