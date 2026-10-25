/** 战术基准库 · 决策可复现与冻结行为基准测试（固定工作量抽样）。
 *
 * 覆盖任务书 D 节后三类自动测试：
 * 4. 决策可复现：同一局面同一冻结版本重复决策逐位一致（workUnits 固定工作量口径）。
 * 5. 冻结 JS5 行为基准：语料中记录的 js5-w128 建议行动与当前运行时重算逐位一致
 *    （漂移报警口径——引擎/搜索代码演进必须显式重录语料并评审）。
 * 6. 预算比较接口：compare-budgets 在同一局面多档 workUnits 下输出结构完备、
 *    同档逐位可复现。
 * 附：oracle 精确口径抽样复算一致；分歧矩阵与决策记录自洽。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { actionKey } from '../lib/classify.mjs';
import { decideWithVersion, frozenVersions, seatProfile } from '../lib/versions.mjs';
import { solveEndgame } from '../lib/oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data', 'scenarios.jsonl');
const scenarios = readFileSync(DATA, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function revive(s) {
  const game = structuredClone(s.engineState.position);
  for (const p of game.players) p.isAI = true;
  return game;
}

/** 确定性抽样：每个主分类首条 + 每个人数首条（去重，固定工作量 ≤ 10）。 */
function pickSamples() {
  const seen = new Set();
  const picks = [];
  for (const s of scenarios) {
    const key = s.classification.category;
    if (!seen.has(key)) { seen.add(key); picks.push(s); }
  }
  for (const s of scenarios) {
    const key = `P${s.classification.playerCount}`;
    if (!seen.has(key)) { seen.add(key); picks.push(s); }
  }
  return picks.slice(0, 10);
}

test('决策可复现：冻结版本重复决策逐位一致（抽样）', { timeout: 120_000 }, () => {
  const versions = frozenVersions();
  for (const s of pickSamples()) {
    for (const v of versions) {
      const profile = seatProfile(s.currentSeat);
      const a = decideWithVersion(revive(s), v, profile);
      const b = decideWithVersion(revive(s), v, profile);
      assert.equal(actionKey(a.action), actionKey(b.action), `${s.id}/${v.key} 行动不可复现`);
      assert.equal(a.reason, b.reason, `${s.id}/${v.key} 理由不可复现`);
    }
  }
});

test('冻结 JS5 行为基准：记录值与运行时重算逐位一致（抽样）', { timeout: 120_000 }, () => {
  for (const s of pickSamples()) {
    const recorded = s.decisions['js5-w128'];
    assert.ok(recorded, `${s.id} 缺少 js5-w128 记录`);
    const version = frozenVersions().find(v => v.key === 'js5-w128');
    const fresh = decideWithVersion(revive(s), version, seatProfile(s.currentSeat));
    assert.equal(actionKey(fresh.action), recorded.actionKey, `${s.id} JS5 冻结行为漂移（若为有意变更，须重录语料并评审）`);
    assert.equal(fresh.reason, recorded.reason, `${s.id} JS5 决策理由漂移`);
    // 束搜索冻结版本同步抽查（classic）
    const recClassic = s.decisions['classic-beam-rollout'];
    const vClassic = frozenVersions().find(v => v.key === 'classic-beam-rollout');
    const freshClassic = decideWithVersion(revive(s), vClassic, seatProfile(s.currentSeat));
    assert.equal(actionKey(freshClassic.action), recClassic.actionKey, `${s.id} classic 冠军冻结行为漂移`);
  }
});

test('分歧矩阵与决策记录自洽（全语料，无搜索）', () => {
  for (const s of scenarios) {
    const keys = Object.values(s.decisions).map(d => d.actionKey);
    assert.deepEqual(s.disagreement.actionKeys, keys, s.id);
    const unique = [...new Set(keys)];
    assert.equal(s.disagreement.uniqueCount, unique.length, s.id);
    assert.equal(s.disagreement.allAgree, unique.length === 1, s.id);
    for (const [k, d] of Object.entries(s.decisions)) {
      assert.ok(d.action && d.reason && d.profile, `${s.id}/${k} 决策记录不完整`);
    }
    assert.equal(Object.keys(s.decisions).length, 4, `${s.id} 应记录 4 个冻结版本`);
  }
});

test('oracle 精确结论抽样复算一致（仅 exact/partial 局面）', { timeout: 120_000 }, () => {
  const withOracle = scenarios.filter(s => s.oracle && (s.oracle.status === 'exact' || s.oracle.status === 'partial'));
  assert.ok(withOracle.length > 0, '语料应包含至少一个 oracle 结论');
  // 固定工作量抽样：穷举量最大的 2 条（非平凡验证）+ 最小 1 条（平凡路径覆盖）。
  const byNodes = (s) => s.oracle.stats?.nodes ?? 0;
  const sorted = [...withOracle].sort((a, b) => byNodes(b) - byNodes(a));
  const sample = [...new Set([sorted[0], sorted[1], sorted[sorted.length - 1]])];
  for (const s of sample) {
    const fresh = solveEndgame(s.engineState.position, { nodeCap: 120_000, timeCapMs: 10_000 });
    assert.equal(fresh.status, s.oracle.status, `${s.id} oracle 状态漂移`);
    const byKey = a => JSON.stringify(a);
    assert.deepEqual(fresh.actions.map(byKey), s.oracle.actions.map(byKey), `${s.id} oracle 结论漂移`);
  }
});

test('预算比较接口：多档 workUnits 结构完备且同档逐位可复现', { timeout: 120_000 }, () => {
  const target = scenarios.find(s => s.legalActionCount <= 80) ?? scenarios[0];
  const run = (budgets) => JSON.parse(execFileSync(process.execPath, [
    join(HERE, '..', 'scripts', 'compare-budgets.mjs'),
    `--id=${target.id}`, `--budgets=${budgets}`, '--in=' + DATA,
  ], { encoding: 'utf8' }));
  const r1 = run('8,16');
  assert.equal(r1.scenarios.length, 1);
  const row = r1.scenarios[0];
  assert.equal(row.id, target.id);
  assert.equal(row.runs.length, 2);
  for (const r of row.runs) assert.ok(r.action && r.actionKey && typeof r.ms === 'number');
  const r2 = run('8,16');
  assert.deepEqual(r1.scenarios[0].runs.map(x => [x.workUnits, x.actionKey, x.reason]),
    r2.scenarios[0].runs.map(x => [x.workUnits, x.actionKey, x.reason]), '同档预算两次运行不一致');
});
