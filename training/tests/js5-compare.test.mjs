/** compare.mjs 配对数据完整性测试（AI6 第五阶段·任务 A2）。
 *
 * 覆盖（全部为"拒绝性"断言——A2 纪律的核心是绝不静默丢弃/取交集/覆盖）：
 * 1. 重复 (seed, direction, candidate) 记录拒绝；
 * 2. 非 finished 局拒绝；
 * 3. 配对缺失拒绝（一侧有一侧无——不得自动取交集）；
 * 4. 座位分配协议不一致拒绝；
 * 5. 对手版本配置不一致拒绝；
 * 6. 方向分离：A/B 口径分别报告（方向 A=单席位、B=阵营），合并值必须标注 caveat；
 * 7. 零胜场附 Clopper–Pearson 精确上界；
 * 8. Bonferroni family 调整 CI 水平；
 * 9. 自对照差 = 0（配对实现无偏的健全性检查，沿用 PR #27 口径）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairedComparison, pairedComparisonByDirection, pairedComparisonDirectional } from '../joint/compare.mjs';
import { clopperPearsonBound } from '../joint/exact-bounds.mjs';

function fixtureGame(seed, direction, over = {}) {
  return {
    seed, direction, candidateSeats: direction === 'A' ? [seed % 2] : [0, 1].filter(s => s !== seed % 2),
    status: 'finished', won: over.won ?? false, meanRank: over.meanRank ?? 1,
    meanScore: over.meanScore ?? 10, scoreDiff: over.scoreDiff ?? 0,
    winnerSeat: over.winnerSeat ?? 0, moves: 90,
    versionsIds: over.versionsIds ?? ['cand', 'op1', 'op2'],
    ...over,
  };
}

function writeFixture(dir, name, cells) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ schema: 'century-joint-search-ablation-v1', date: '2026-10-24', block: 'fixture', cells }, null, 2));
  return path;
}

/** 生成一个候选 / 基准文件对：nSeeds × 双方向；wins 指定每方向候选胜局数。 */
function makePair(dir, { nSeeds = 20, candAWins = 12, candBWins = 12, baseAWins = 8, baseBWins = 8, mutate } = {}) {
  const mk = (candidateId, aWins, bWins, mutateGames) => {
    const games = [];
    for (let i = 0; i < nSeeds; i++) {
      const seed = 1_400_000_000 + i;
      games.push(fixtureGame(seed, 'A', { won: i < aWins, ...mutateGames?.(seed, 'A') }));
      games.push(fixtureGame(seed, 'B', { won: i < bWins, ...mutateGames?.(seed, 'B') }));
    }
    return { candidateId, seatCount: 2, totalGames: games.length, finishedGames: games.length, anomalies: 0, games };
  };
  const candPath = writeFixture(dir, 'cand.json', [mk('js5', candAWins, candBWins, mutate?.cand)]);
  const basePath = writeFixture(dir, 'base.json', [mk('js0', baseAWins, baseBWins, mutate?.base)]);
  return { candPath, basePath };
}

test('A2 自对照差 = 0（配对实现健全性）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath } = makePair(dir);
    const r = pairedComparison(candPath, candPath, { seatCount: 2, candidateId: 'js5', baselineId: 'js5', iterations: 200 });
    assert.equal(r.firstPlaceDiff, 0);
    assert.deepEqual(r.firstPlaceDiffCI, [0, 0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 拒绝重复 (seed, direction) 记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath, basePath } = makePair(dir, { mutate: { cand: (seed, direction) => (seed === 1_400_000_003 && direction === 'A' ? { __dup: true } : {}) } });
    // 向 cand 文件追加一条重复记录（同 seed 同方向）。
    const doc = JSON.parse(readFileSync(candPath, 'utf8'));
    const dup = { ...doc.cells[0].games.find(g => g.seed === 1_400_000_003 && g.direction === 'A'), won: true };
    doc.cells[0].games.push(dup);
    writeFileSync(candPath, JSON.stringify(doc));
    assert.throws(() => pairedComparison(candPath, basePath, { seatCount: 2, candidateId: 'js5' }), /重复 \(seed, direction, candidate\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 拒绝非 finished（异常局）记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath, basePath } = makePair(dir, { mutate: { cand: (seed) => (seed === 1_400_000_005 ? { status: 'anomaly', reason: '对局异常：测试注入' } : {}) } });
    assert.throws(() => pairedComparison(candPath, basePath, { seatCount: 2, candidateId: 'js5' }), /非 finished/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 拒绝配对缺失（不得静默取交集）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath, basePath } = makePair(dir);
    // 从基准文件删除 seed 7 的两条记录 → 配对缺失。
    const doc = JSON.parse(readFileSync(basePath, 'utf8'));
    doc.cells[0].games = doc.cells[0].games.filter(g => g.seed !== 1_400_000_007);
    writeFileSync(basePath, JSON.stringify(doc));
    assert.throws(() => pairedComparison(candPath, basePath, { seatCount: 2, candidateId: 'js5' }), /配对缺失/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 拒绝座位分配协议不一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath, basePath } = makePair(dir, { mutate: { base: (seed, direction) => (seed === 1_400_000_002 && direction === 'A' ? { candidateSeats: [1] } : {}) } });
    assert.throws(() => pairedComparison(candPath, basePath, { seatCount: 2, candidateId: 'js5' }), /座位分配协议不一致/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 拒绝对手版本配置不一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath, basePath } = makePair(dir, { mutate: { base: (seed) => (seed === 1_400_000_002 ? { versionsIds: ['cand', 'opX', 'op2'] } : {}) } });
    assert.throws(() => pairedComparison(candPath, basePath, { seatCount: 2, candidateId: 'js5' }), /对手版本配置不一致/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 方向分离：A/B 口径独立报告，合并值带 caveat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    // A 方向候选强（18/20 vs 6/20），B 方向候选弱（4/20 vs 16/20）——
    // 合并值必须不等于单方向口径，且两个方向分别给出。
    const { candPath, basePath } = makePair(dir, { candAWins: 18, baseAWins: 6, candBWins: 4, baseBWins: 16 });
    const r = pairedComparisonByDirection(candPath, basePath, { seatCount: 2, candidateId: 'js5', baselineId: 'js0', iterations: 400 });
    assert.ok(r.A, '方向 A 结果缺失');
    assert.ok(r.B, '方向 B 结果缺失');
    assert.ok(r.combined?.caveat?.includes('阵营混合'), '合并口径未标注 caveat');
    assert.ok(r.A.firstPlaceDiff > 0.3, `方向 A 差值异常：${r.A.firstPlaceDiff}`);
    assert.ok(r.B.firstPlaceDiff < -0.3, `方向 B 差值异常：${r.B.firstPlaceDiff}`);
    // 方向 A 的单席位口径与方向 B 的阵营口径不得混用（数值上可区分）。
    assert.notEqual(r.A.candidateFirstPlace, r.combined.candidateFirstPlace);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 零胜场附 Clopper–Pearson 精确上界', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath, basePath } = makePair(dir, { candAWins: 0, candBWins: 0 });
    const r = pairedComparison(candPath, basePath, { seatCount: 2, candidateId: 'js5', baselineId: 'js0', iterations: 200 });
    assert.equal(r.candidateWins, 0);
    const n = r.games;
    assert.equal(r.candidateZeroWinsExactUpper, clopperPearsonBound(n, 'upper'));
    assert.ok(r.candidateZeroWinsExactUpper > 0 && r.candidateZeroWinsExactUpper < 0.2, '精确上界量级异常');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A2 Bonferroni family 调整 CI 水平（区间不窄于 family=1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js5cmp-'));
  try {
    const { candPath, basePath } = makePair(dir, { candAWins: 14, candBWins: 10, baseAWins: 8, baseBWins: 9 });
    const f1 = pairedComparisonDirectional(candPath, basePath, { seatCount: 2, candidateId: 'js5', baselineId: 'js0', directionFilter: 'A', iterations: 1500, familySize: 1 });
    const f4 = pairedComparisonDirectional(candPath, basePath, { seatCount: 2, candidateId: 'js5', baselineId: 'js0', directionFilter: 'A', iterations: 1500, familySize: 4 });
    assert.equal(f1.ciLevel, 0.95);
    assert.equal(f4.ciLevel, 0.9875);
    const w1 = f1.firstPlaceDiffCI[1] - f1.firstPlaceDiffCI[0];
    const w4 = f4.firstPlaceDiffCI[1] - f4.firstPlaceDiffCI[0];
    assert.ok(w4 >= w1 - 1e-9, `Bonferroni 区间反而更窄：${w4} < ${w1}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
