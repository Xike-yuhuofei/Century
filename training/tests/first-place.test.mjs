/** P0 反例回归：第一名率优先的竞技评价体系。
 *
 * 每条用例都对应任务书 4.4 的必须反例之一；测试必须真实执行统计函数，
 * 不能只断言"文件存在"或"历史报告写着 PASS"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clusterFirstPlacePairs, clusterMeanCI, studentTQuantile, studentTCdf,
  firstPlacePromotionDecision, analyzeSeatStratum, pooledWeightedDelta,
  nonInferiorityDecision,
} from '../evaluator/first-place.mjs';
import {
  createPreregistration, lockPreregistration, loadPreregistration,
  assertPlanIdentity, assertValidationSeeds, assertFixedSample, assertResultsAfterLock,
} from '../evaluator/preregistration.mjs';
import {
  reserveAlpha, completeAlpha, readAlphaLedger, alphaLedgerSummary, assertAlphaLedgerIntegrity,
  initializeAlphaFamily,
} from '../lib/alpha-ledger.mjs';

const HEX = 'a'.repeat(64);

function patternPairs({ base, count, candidatePattern = [0, 0, 1, 1, 0], championPattern = [0, 0, 1, 0, 0], focusSeat = null }) {
  return Array.from({ length: count }, (_, i) => ({
    seed: base + i,
    ...(focusSeat === null ? {} : { focusSeat }),
    candidateFirst: candidatePattern[i % candidatePattern.length],
    championFirst: championPattern[i % championPattern.length],
    anomalies: 0,
  }));
}

function fourStrata({ count = 100, seats = [2, 3, 4, 5] } = {}) {
  let base = 900_000_000;
  return seats.map(seatCount => {
    const pairs = patternPairs({ base, count, focusSeat: 0 });
    base += 10_000;
    return { seatCount, pairs };
  });
}

// ---------------------------------------------------------------------------
// 分布与区间基础
// ---------------------------------------------------------------------------

test('student t 分位数与已知临界值一致', () => {
  assert.ok(Math.abs(studentTQuantile(0.975, 10) - 2.228) < 0.002);
  assert.ok(Math.abs(studentTQuantile(0.975, 30) - 2.042) < 0.002);
  assert.ok(Math.abs(studentTQuantile(0.95, 60) - 1.671) < 0.002);
  assert.ok(Math.abs(studentTCdf(2.228, 10) - 0.975) < 1e-4);
});

test('簇内多观测只作为一个独立样本（配对相关性不被忽略）', () => {
  const pairs = [];
  for (let s = 0; s < 6; s++) {
    // 同一 seed 的 4 个座位观测高度相关（簇内同值），朴素口径会低估方差。
    for (const focusSeat of [0, 1, 2, 3]) {
      pairs.push({ seed: 900_000_000 + s, focusSeat, candidateFirst: s < 3 ? 1 : 0, championFirst: 0, anomalies: 0 });
    }
  }
  const clustered = clusterFirstPlacePairs(pairs);
  assert.equal(clustered.uniqueSeeds, 6);
  assert.equal(clustered.clusters.length, 6);
  const clusterCI = clusterMeanCI(clustered, { alpha: 0.05 });

  // 朴素口径把 20 条观测当独立样本，区间会被系统性低估。
  const values = pairs.map(p => p.candidateFirst - p.championFirst);
  const n = values.length;
  const mean = values.reduce((s, x) => s + x, 0) / n;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const naive = { lower: mean - studentTQuantile(0.95, n - 1) * Math.sqrt(variance / n), upper: mean + studentTQuantile(0.95, n - 1) * Math.sqrt(variance / n) };
  assert.ok(clusterCI.upper - clusterCI.lower > naive.upper - naive.lower,
    `簇级区间宽度 ${clusterCI.upper - clusterCI.lower} 必须大于朴素区间宽度 ${naive.upper - naive.lower}`);
});

test('同一 (seed, focusSeat) 重复测量被拒绝', () => {
  assert.throws(
    () => clusterFirstPlacePairs([
      { seed: 900_000_000, focusSeat: 0, candidateFirst: 1, championFirst: 0 },
      { seed: 900_000_000, focusSeat: 0, candidateFirst: 1, championFirst: 0 },
    ]),
    /重复测量/,
  );
});

test('100 条同种子记录不构成 100 个独立样本（同种子重复统计 → 拒绝显著）', () => {
  const pairs = Array.from({ length: 100 }, () => ({
    seed: 900_000_000, candidateFirst: 1, championFirst: 0, anomalies: 0,
  }));
  const clustered = clusterFirstPlacePairs(pairs);
  assert.equal(clustered.uniqueSeeds, 1);
  const stratum = analyzeSeatStratum({ pairs, minSeeds: 60, seatCount: 2 });
  assert.equal(stratum.status, 'insufficient');
});

// ---------------------------------------------------------------------------
// 任务书 4.4 反例
// ---------------------------------------------------------------------------

test('反例1：平均得分更高但第一名率更低 → 不晋级', () => {
  const strata = fourStrata({ count: 100 }).map(s => ({
    seatCount: s.seatCount,
    // 诊断字段（平均分/资源效率）故意显示候选更优，判定必须完全忽略。
    pairs: s.pairs.map(p => ({ ...p, candidateMeanScore: 50, championMeanScore: 40, diagnosticResourceEfficiency: 2.0 })),
  }));
  // 候选从未第一，冠军经常第一 → delta 为负。
  for (const stratum of strata) {
    stratum.pairs = patternPairs({ base: stratum.pairs[0].seed, count: 100, candidatePattern: [0, 0, 0, 0, 0], championPattern: [1, 1, 0, 0, 0], focusSeat: 0 });
  }
  const decision = firstPlacePromotionDecision({ strata, margin: 0.02, minSeeds: 60 });
  assert.equal(decision.promote, false);
  assert.ok(decision.reasons.some(r => /下界/.test(r) || /非劣效/.test(r)));
});

test('反例2：资源效率更高但第一名率更低 → 不晋级', () => {
  const strata = fourStrata({ count: 100 }).map(s => ({
    seatCount: s.seatCount,
    pairs: patternPairs({ base: s.pairs[0].seed, count: 100, candidatePattern: [0, 0, 0, 0, 0], championPattern: [1, 0, 0, 0, 0], focusSeat: 0 })
      .map(p => ({ ...p, candidateCpuMs: 5, championCpuMs: 500 })),
  }));
  const decision = firstPlacePromotionDecision({ strata, margin: 0.02, minSeeds: 60 });
  assert.equal(decision.promote, false);
  assert.equal(decision.primaryObjective, 'firstPlaceWinRate');
});

test('反例3：5 人提升但 2 人显著退化 → 不晋级（非劣效失败）', () => {
  const base = { 2: 900_000_000, 3: 900_010_000, 4: 900_020_000, 5: 900_030_000 };
  const strata = [
    { seatCount: 2, pairs: patternPairs({ base: base[2], count: 100, candidatePattern: [0, 0, 1, 0, 0], championPattern: [1, 1, 1, 0, 0], focusSeat: 0 }) },
    { seatCount: 3, pairs: patternPairs({ base: base[3], count: 100, candidatePattern: [0, 0, 1, 0, 0], championPattern: [0, 0, 0, 1, 0], focusSeat: 0 }) },
    { seatCount: 4, pairs: patternPairs({ base: base[4], count: 100, candidatePattern: [0, 0, 1, 0, 0], championPattern: [0, 0, 0, 1, 0], focusSeat: 0 }) },
    { seatCount: 5, pairs: patternPairs({ base: base[5], count: 100, candidatePattern: [1, 1, 1, 0, 0], championPattern: [0, 0, 0, 0, 0], focusSeat: 0 }) },
  ];
  const decision = firstPlacePromotionDecision({ strata, margin: 0.02, minSeeds: 60 });
  assert.equal(decision.promote, false);
  const two = decision.nonInferiority.find(x => x.seatCount === 2);
  assert.equal(two.pass, false);
  assert.ok(decision.reasons.some(r => r.includes('2 人非劣效失败')));
});

test('反例4：小样本碰巧领先但不显著 → 不晋级', () => {
  const strata = fourStrata({ count: 5 });
  const decision = firstPlacePromotionDecision({ strata, margin: 0.02, minSeeds: 60 });
  assert.equal(decision.promote, false);
  assert.ok(decision.reasons.some(r => r.includes('少于下限')));
});

test('反例5：跨人数复用同一种子 → 拒绝判定', () => {
  const pairs = patternPairs({ base: 900_000_000, count: 100, focusSeat: 0 });
  const strata = [2, 3, 4, 5].map(seatCount => ({ seatCount, pairs: pairs.map(p => ({ ...p })) }));
  const decision = firstPlacePromotionDecision({ strata, margin: 0.02, minSeeds: 60 });
  assert.equal(decision.promote, false);
  assert.ok(decision.reasons.some(r => r.includes('跨人数种子复用')));
});

test('反例6：验证过程中修改候选 → 拒绝', () => {
  const plan = createPreregistration({
    planId: 'test-plan-identity',
    candidate: { id: 'cand-x', parametersSha256: HEX, sourceHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64) },
    champion: { id: 'joint-js5', parametersSha256: 'd'.repeat(64), artifactHash: 'e'.repeat(64) },
    opponents: [{ id: 'style-engine', fingerprint: 'enemy-fingerprint-1' }],
    seatWindows: {
      2: { base: 900_000_000, count: 100 }, 3: { base: 900_010_000, count: 100 },
      4: { base: 900_020_000, count: 100 }, 5: { base: 900_030_000, count: 100 },
    },
    challengeIndex: 1,
    minSeedsPerSeatCount: 60,
  });
  assert.throws(
    () => assertPlanIdentity({
      plan,
      candidate: { parametersSha256: HEX, sourceHash: 'f'.repeat(64), artifactHash: 'c'.repeat(64) },
      champion: { parametersSha256: 'd'.repeat(64), artifactHash: 'e'.repeat(64) },
      opponents: [{ id: 'style-engine', fingerprint: 'enemy-fingerprint-1' }],
    }),
    /源码哈希与预注册不一致/,
  );
});

test('反例7：研究种子混入正式验证 → 拒绝', () => {
  const plan = createPreregistration({
    planId: 'test-plan-seeds',
    candidate: { id: 'cand-x', parametersSha256: HEX, sourceHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64) },
    champion: { id: 'joint-js5', parametersSha256: 'd'.repeat(64), artifactHash: 'e'.repeat(64) },
    opponents: [{ id: 'style-engine', fingerprint: 'enemy-fingerprint-1' }],
    seatWindows: {
      2: { base: 900_000_000, count: 10 }, 3: { base: 900_010_000, count: 10 },
      4: { base: 900_020_000, count: 10 }, 5: { base: 900_030_000, count: 10 },
    },
    challengeIndex: 1,
    minSeedsPerSeatCount: 2,
  });
  assert.throws(
    () => assertValidationSeeds({
      plan,
      seedsBySeatCount: {
        2: [900_000_000, 1_300_000_001],
        3: [900_010_000], 4: [900_020_000], 5: [900_030_000],
      },
    }),
    /预注册窗口/,
  );
  assert.throws(
    () => assertValidationSeeds({
      plan,
      seedsBySeatCount: {
        2: Array.from({ length: 11 }, (_, i) => 900_000_000 + i),
        3: [900_010_000], 4: [900_020_000], 5: [900_030_000],
      },
    }),
    /超过预注册窗口/,
  );
});

test('反例8：可选停止/补样本 → 固定样本核验失败', () => {
  const plan = createPreregistration({
    planId: 'test-plan-fixed',
    candidate: { id: 'cand-x', parametersSha256: HEX, sourceHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64) },
    champion: { id: 'joint-js5', parametersSha256: 'd'.repeat(64), artifactHash: 'e'.repeat(64) },
    opponents: [{ id: 'style-engine', fingerprint: 'enemy-fingerprint-1' }],
    seatWindows: {
      2: { base: 900_000_000, count: 10 }, 3: { base: 900_010_000, count: 10 },
      4: { base: 900_020_000, count: 10 }, 5: { base: 900_030_000, count: 10 },
    },
    challengeIndex: 1,
    minSeedsPerSeatCount: 2,
  });
  assert.throws(
    () => assertFixedSample({ plan, observedSeedsBySeatCount: { 2: 10, 3: 10, 4: 10, 5: 9 } }),
    /≠ 预注册/,
  );
});

test('反例9：重复挑战不得重置 Alpha（账本严格递增）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-alpha-'));
  const ledgerPath = join(dir, 'alpha-ledger.json');
  try {
    reserveAlpha({ challengeIndex: 1, planId: 'plan-1', candidateId: 'cand-a', ledgerPath });
    completeAlpha({ challengeIndex: 1, decision: 'rejected', evidenceHash: 'hash-1', ledgerPath });
    reserveAlpha({ challengeIndex: 2, planId: 'plan-2', candidateId: 'cand-a', ledgerPath });
    assert.throws(
      () => reserveAlpha({ challengeIndex: 2, planId: 'plan-2-retry', candidateId: 'cand-a', ledgerPath }),
      /≠ 账本下一个可用序号/,
    );
    assert.throws(
      () => reserveAlpha({ challengeIndex: 1, planId: 'plan-1-rename', candidateId: 'cand-a', ledgerPath }),
      /≠ 账本下一个可用序号/,
    );
    completeAlpha({ challengeIndex: 2, decision: 'promote', evidenceHash: 'hash-2', ledgerPath });
    assert.throws(
      () => completeAlpha({ challengeIndex: 2, decision: 'promote', evidenceHash: 'hash-2-again', ledgerPath }),
      /多条结果/,
    );
    const ledger = readAlphaLedger(ledgerPath);
    const summary = alphaLedgerSummary(ledger);
    assert.equal(summary.challenges, 2);
    assert.equal(summary.completed, 2);
    assert.ok(summary.spent <= ledger.alphaBudget + 1e-12);
    // 篡改 alpha 后完整性检查必须失败。
    const tampered = JSON.parse(JSON.stringify(ledger));
    tampered.reservations[0].alpha = 0.049;
    assert.throws(() => assertAlphaLedgerIntegrity(tampered), /预注册消耗计划/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 正向：统计上合格的候选必须被接受（仅工程验收，不代表真实棋力）
// ---------------------------------------------------------------------------

test('正向：2–5 人第一名率一致提升且非劣效 → 晋级判定通过', () => {
  const strata = fourStrata({ count: 120 });
  const decision = firstPlacePromotionDecision({ strata, margin: 0.02, minSeeds: 60 });
  assert.equal(decision.promote, true, decision.reasons.join('；'));
  assert.ok(decision.pooled.lower > 0);
  for (const ni of decision.nonInferiority) assert.equal(ni.pass, true);
});

test('正向：5p 提升、2p 轻微退化但仍在 2pp 非劣效内 → 晋级判定通过', () => {
  const base = { 2: 900_000_000, 3: 900_010_000, 4: 900_020_000, 5: 900_030_000 };
  // 2p：候选 49% vs 冠军 50% → delta 均值略负但下界仍 ≥ −2pp（需要大样本）。
  const twoPairs = Array.from({ length: 400 }, (_, i) => ({
    seed: base[2] + i, focusSeat: 0,
    candidateFirst: i % 100 < 49 ? 1 : 0,
    championFirst: i % 100 < 50 ? 1 : 0,
    anomalies: 0,
  }));
  const strata = [
    { seatCount: 2, pairs: twoPairs },
    { seatCount: 3, pairs: patternPairs({ base: base[3], count: 120, focusSeat: 0 }) },
    { seatCount: 4, pairs: patternPairs({ base: base[4], count: 120, focusSeat: 0 }) },
    { seatCount: 5, pairs: patternPairs({ base: base[5], count: 120, candidatePattern: [1, 1, 1, 0, 0], championPattern: [0, 0, 0, 0, 0], focusSeat: 0 }) },
  ];
  const decision = firstPlacePromotionDecision({ strata, margin: 0.02, minSeeds: 60 });
  const two = decision.nonInferiority.find(x => x.seatCount === 2);
  assert.equal(two.pass, true);
  assert.equal(decision.promote, true, decision.reasons.join('；'));
});

test('非劣效门槛边界：下界恰低于 −margin 时失败', () => {
  const pairs = Array.from({ length: 200 }, (_, i) => ({
    seed: 900_000_000 + i, focusSeat: 0,
    candidateFirst: i % 100 < 48 ? 1 : 0,
    championFirst: i % 100 < 50 ? 1 : 0,
    anomalies: 0,
  }));
  const stratum = analyzeSeatStratum({ pairs, minSeeds: 60, seatCount: 2 });
  const ni = nonInferiorityDecision({ stratum, margin: 0.005 });
  assert.equal(ni.pass, false);
  const loose = nonInferiorityDecision({ stratum, margin: 0.05 });
  assert.equal(loose.pass, true);
});

test('加权汇总权重必须预注册且总和为 1', () => {
  const strata = fourStrata({ count: 120 });
  const analyzed = strata.map(s => analyzeSeatStratum({ pairs: s.pairs, minSeeds: 60, seatCount: s.seatCount }));
  assert.throws(
    () => pooledWeightedDelta({ strata: analyzed, weights: { 2: 0.5, 3: 0.3, 4: 0.3, 5: 0.1 }, alpha: 0.05 }),
    /权重之和必须为 1/,
  );
});

test('固定期限 Bonferroni：α 不随序号衰减，期满明确停止（可持续替代方案）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-alpha-horizon-'));
  const ledgerPath = join(dir, 'alpha-ledger.json');
  try {
    initializeAlphaFamily({
      mode: 'fixed-horizon-bonferroni',
      maxChallenges: 4,
      authorization: 'test: pre-registered horizon',
      authorizedBy: 'test-suite',
      ledgerPath,
    });
    const alphas = [];
    for (let k = 1; k <= 4; k++) {
      const entry = reserveAlpha({ challengeIndex: k, planId: `horizon-plan-${k}`, candidateId: 'cand', ledgerPath });
      alphas.push(entry.alpha);
      completeAlpha({ challengeIndex: k, decision: 'not-promoted', evidenceHash: `h-${k}`, ledgerPath });
    }
    assert.ok(alphas.every(a => Math.abs(a - 0.0125) < 1e-12), `每次 α 必须恒为 budget/horizon，实际：${alphas}`);
    assert.throws(
      () => reserveAlpha({ challengeIndex: 5, planId: 'horizon-plan-5', candidateId: 'cand', ledgerPath }),
      /预算已按预注册计划耗尽|超出预算/,
    );
    const summary = alphaLedgerSummary(readAlphaLedger(ledgerPath));
    assert.equal(summary.spendingPlan.mode, 'fixed-horizon-bonferroni');
    assert.equal(summary.challenges, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('初始化 alpha 家族必须显式授权（禁止静默重置预算）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-alpha-init-'));
  const ledgerPath = join(dir, 'ledger.json');
  try {
    assert.throws(
      () => initializeAlphaFamily({
        mode: 'fixed-horizon-bonferroni', maxChallenges: 10,
        authorization: '', authorizedBy: 'x', ledgerPath,
      }),
      /authorization/,
    );
    // 第一次初始化成功后，再次初始化同一路径必须被拒绝（禁止覆盖/重置）。
    initializeAlphaFamily({
      mode: 'fixed-horizon-bonferroni', maxChallenges: 10,
      authorization: 'ok', authorizedBy: 'x', ledgerPath,
    });
    assert.throws(
      () => initializeAlphaFamily({
        mode: 'fixed-horizon-bonferroni', maxChallenges: 10,
        authorization: 'ok', authorizedBy: 'x', ledgerPath,
      }),
      /禁止覆盖\/重置/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('预注册计划落盘后不可修改（同 planId 不同内容 → 拒绝）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'century-prereg-'));
  const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
  try {
    const plan = createPreregistration({
      planId: 'plan-lock-test',
      candidate: { id: 'cand-x', parametersSha256: HEX, sourceHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64) },
      champion: { id: 'joint-js5', parametersSha256: 'd'.repeat(64), artifactHash: 'e'.repeat(64) },
      opponents: [{ id: 'style-engine', fingerprint: 'enemy-fingerprint-1' }],
      seatWindows: {
        2: { base: 900_000_000, count: 10 }, 3: { base: 900_010_000, count: 10 },
        4: { base: 900_020_000, count: 10 }, 5: { base: 900_030_000, count: 10 },
      },
      challengeIndex: 1,
      minSeedsPerSeatCount: 2,
    });
    const locked = lockPreregistration({ plan, dir, writeJSON });
    assert.equal(locked.alreadyLocked, false);
    const reloaded = loadPreregistration(locked.path);
    assert.equal(reloaded.planHash, plan.planHash);
    // 同 planId、不同口径 → 新的 planHash，落盘时必须拒绝（禁止事后改口径）。
    const changedPlan = createPreregistration({
      planId: 'plan-lock-test',
      candidate: { id: 'cand-x', parametersSha256: HEX, sourceHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64) },
      champion: { id: 'joint-js5', parametersSha256: 'd'.repeat(64), artifactHash: 'e'.repeat(64) },
      opponents: [{ id: 'style-engine', fingerprint: 'enemy-fingerprint-1' }],
      seatWindows: {
        2: { base: 900_000_000, count: 10 }, 3: { base: 900_010_000, count: 10 },
        4: { base: 900_020_000, count: 10 }, 5: { base: 900_030_000, count: 10 },
      },
      challengeIndex: 1,
      minSeedsPerSeatCount: 2,
      nonInferiorityMargin: 0.2,
    });
    assert.throws(
      () => lockPreregistration({ plan: changedPlan, dir, writeJSON }),
      /禁止事后修改实验口径/,
    );
    assert.throws(
      () => assertResultsAfterLock({ plan: { ...reloaded, lockedAt: new Date(Date.now() + 60_000).toISOString() }, resultsProducedAt: new Date().toISOString() }),
      /早于计划锁定/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
