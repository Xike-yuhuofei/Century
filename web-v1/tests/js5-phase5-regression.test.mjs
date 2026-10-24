/** JS5 第五阶段回归测试（AI6 第五阶段·任务 A1/C1/A3/B/C2）。
 *
 * 覆盖（全部针对 js5 = champion-guided；js2–js4 保持 PR #26/27 历史语义不动）：
 * 1. C1 平衡批次提交：预算截断时各候选试验数严格相等 + (world,replica) 键集
 *    一致（修复 v1 网格中途截断时早排候选多试验的系统性偏差）；
 * 2. C1 固定工作量逐位可复现 + collectTrials 披露（js5 补齐 P1-1 通道，
 *    v1 中该选项在 js5 上被静默忽略）；
 * 3. 零预算严格回退：门控触发但零试验时必须返回冠军行动（冻结冠军保底）；
 * 4. A3 语义：gated 决策 reason 不得宣称"预期第一名率"——叶子聚合值是
 *    未校准联合模拟评价值；
 * 5. B root 延迟创建：非门控决策只建 1 个根模拟（决策不变、省 W−1 次构造），
 *    gate=never ≡ js0 逐决策一致（training/joint/equivalence-audit.mjs 的
 *    单元级快查版；js0 = 前任束搜索冠军，显式钉定 legacy-champion.json——
 *    JS5 晋级后 CHAMPION_PARAMETERS 走适配器分派，不再是束搜索基线）；
 * 6. B 分相计时：plan/rootSim/gate/screen/rollout/aggregate 披露；
 * 7. C2 冠军行动始终参与竞争 + claimRanking 选项合法性。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction, NEUTRAL_PROFILE } from '../dist/js/ai.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';

// 前任冠军（束搜索权重参数，无 adapter）：gate=never 等价性断言的 js0 基线。
// 晋级后默认 CHAMPION_PARAMETERS 携带 adapter='champion-guided'，chooseAIAction
// 会分派到 JS5 auto——与本断言的"束搜索逐位一致"语义不同路，禁止混用。
const LEGACY_CHAMPION = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/legacy-champion.json'), 'utf8'));

/** 采集中局位置（champion 快速推进采样；与 joint-fairness 同法，种子段独立）。 */
function midgamePositions(count, seedStart = 7100) {
  const positions = [];
  for (let seed = seedStart; seed <= seedStart + 40 && positions.length < count; seed++) {
    let g = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 400 && positions.length < count) {
      if (g.phase === 'turn' && g.turnNumber % 9 === 4 && g.players[g.current].claimed.length === 0) {
        positions.push(JSON.parse(JSON.stringify(g)));
      }
      const r = chooseAIAction(g, { parameters: CHAMPION_PARAMETERS, profile: NEUTRAL_PROFILE });
      g = applyAction(g, r.action);
      moves++;
    }
  }
  return positions;
}

test('C1 平衡批次：预算截断时各候选试验数与 (world,replica) 键集严格一致', () => {
  const positions = midgamePositions(4);
  assert.ok(positions.length >= 3, `采集中局位置不足：${positions.length}`);
  for (const g0 of positions) {
    const g = JSON.parse(JSON.stringify(g0));
    // 60ms 预算：通常完成 ≥1 个完整批次且在网格中途截断（v1 在此产生偏差）。
    const r = chooseJointAction(g, { version: 'joint-js5', budgetMs: 60, worlds: 4, collectTrials: true, simSeed: 17 });
    // evaluations 通道的均衡断言（不依赖 collectTrials——v1 代码也可观察，
    // 构成 C1 修复"先红后绿"证据：修复前代码在预算中途截断时为红）。
    const evalTrials = (r.joint.evaluations ?? []).filter(e => e.trials > 0).map(e => e.trials);
    if (evalTrials.length >= 2) {
      for (const t of evalTrials) assert.equal(t, evalTrials[0], `评估通道候选试验数不等：${evalTrials.join(',')}（C1 平衡批次违规）`);
    }
    const trials = r.joint.trials ?? [];
    if (!trials.length) continue; // 无披露（v1）或零批次（严格回退）时跳过细粒度断言
    const byCandidate = new Map();
    for (const t of trials) {
      const key = `${t.world}:${t.replica}`;
      if (!byCandidate.has(t.actionIndex)) byCandidate.set(t.actionIndex, new Set());
      byCandidate.get(t.actionIndex).add(key);
    }
    assert.equal(r.joint.stats.rollouts, trials.length, 'rollouts 与披露试验数不一致');
    const counts = [...byCandidate.values()].map(s => s.size);
    for (const c of counts) assert.equal(c, counts[0], `批次截断后候选试验数不等：${counts.join(',')}（C1 平衡批次违规）`);
    // 键集跨候选完全一致（CRN 配对成立的前提）。
    const keysets = [...byCandidate.values()].map(s => [...s].sort().join(','));
    for (const ks of keysets) assert.equal(ks, keysets[0], '候选间 (world,replica) 键集不一致');
  }
});

test('C1 固定工作量逐位可复现 + collectTrials 披露（js5）', () => {
  const positions = midgamePositions(2, 7200);
  for (const g0 of positions) {
    const g1 = JSON.parse(JSON.stringify(g0));
    const g2 = JSON.parse(JSON.stringify(g0));
    const a = chooseJointAction(g1, { version: 'joint-js5', workUnits: 32, worlds: 4, collectTrials: true, simSeed: 11 });
    const b = chooseJointAction(g2, { version: 'joint-js5', workUnits: 32, worlds: 4, collectTrials: true, simSeed: 11 });
    assert.deepEqual(b.action, a.action, '固定工作量两次调用决策不一致');
    assert.deepEqual(b.joint.trials, a.joint.trials, '固定工作量试验序列不一致');
    assert.equal(a.joint.trials.length, a.joint.stats.rollouts, 'collectTrials 披露数 ≠ rollouts');
    // 平衡性：workUnits=32, worlds=4 → 每候选试验数严格相等。
    const perCandidate = new Map();
    for (const t of a.joint.trials) perCandidate.set(t.actionIndex, (perCandidate.get(t.actionIndex) ?? 0) + 1);
    const counts = [...perCandidate.values()];
    for (const c of counts) assert.equal(c, counts[0], `固定工作量下候选试验数不等：${counts.join(',')}`);
  }
});

test('零预算严格回退：门控触发但零试验必须返回冠军行动', () => {
  const positions = midgamePositions(3, 7300);
  for (const g0 of positions) {
    const g = JSON.parse(JSON.stringify(g0));
    // gate=always 强制进入联合路径；1ms 预算 → 零批次 → 必须回退冠军行动。
    const r = chooseJointAction(g, { version: 'joint-js5', gateMode: 'always', budgetMs: 1, worlds: 4, simSeed: 5 });
    assert.equal(r.joint.stats.rollouts, 0, '1ms 预算不应有批次完成');
    if (r.joint.championAction) {
      assert.deepEqual(r.action, r.joint.championAction, '零试验时未回退冠军行动');
    }
    assert.doesNotThrow(() => applyAction(g, r.action), '零预算回退决策非法');
  }
});

test('A3 语义：gated 决策 reason 不得宣称"预期第一名率"', () => {
  const positions = midgamePositions(3, 7400);
  let checked = 0;
  for (const g0 of positions) {
    const g = JSON.parse(JSON.stringify(g0));
    const r = chooseJointAction(g, { version: 'joint-js5', gateMode: 'always', workUnits: 24, worlds: 4, simSeed: 7 });
    if (r.joint?.gated && r.joint.stats.rollouts > 0) {
      checked += 1;
      assert.doesNotMatch(r.reason, /预期第一名率/, 'reason 宣称了未校准评价值为"预期第一名率"（A3 语义违规）');
      assert.match(r.reason, /联合模拟评价值/, 'reason 未标注"联合模拟评价值"口径');
      for (const rej of r.joint.rejected ?? []) {
        assert.doesNotMatch(rej.why, /预期第一名率/, 'rejected.why 宣称"预期第一名率"');
      }
    }
  }
  assert.ok(checked >= 1, '未采到任何 gated 决策（测试覆盖失效）');
});

test('B root 延迟创建 + gate=never ≡ js0（单元级快查）', () => {
  const positions = midgamePositions(5, 7500);
  for (const g0 of positions) {
    const seat = g0.current;
    const g1 = JSON.parse(JSON.stringify(g0));
    const g2 = JSON.parse(JSON.stringify(g0));
    const r0 = chooseAIAction(g1, { parameters: LEGACY_CHAMPION, profile: NEUTRAL_PROFILE });
    const r5 = chooseJointAction(g2, { version: 'joint-js5', gateMode: 'never', simSeed: 3, profile: NEUTRAL_PROFILE });
    assert.deepEqual(r5.action, r0.action, `gate=never 决策与 js0 不一致：${JSON.stringify(r5.action)} vs ${JSON.stringify(r0.action)}`);
    // B 优化披露：非门控决策只创建 1 个根模拟（v1 预创建 worlds=4 个）。
    assert.equal(r5.joint.stats.rootSimulationsCreated, 1, '非门控决策应只创建 1 个根模拟');
    assert.equal(r5.joint.stats.rollouts, 0, '非门控决策不应有联合试验');
  }
});

test('B 分相计时披露（plan/rootSim/gate/screen/rollout/aggregate）', () => {
  const g0 = midgamePositions(1, 7600)[0];
  const g = JSON.parse(JSON.stringify(g0));
  const r = chooseJointAction(g, { version: 'joint-js5', gateMode: 'always', workUnits: 16, worlds: 4, simSeed: 9 });
  const s = r.joint.stats;
  for (const key of ['planMs', 'rootSimMs', 'gateMs', 'screenMs', 'rolloutMs', 'aggregateMs']) {
    assert.equal(typeof s[key], 'number', `stats.${key} 未披露`);
    assert.ok(s[key] >= 0, `stats.${key} 为负`);
  }
  // 门控路径创建了 worlds 个根模拟。
  assert.equal(s.rootSimulationsCreated, 4, '门控路径应创建 4 个根模拟');
});

test('C2 冠军行动始终参与竞争 + claimRanking 选项合法', () => {
  const positions = midgamePositions(4, 7700);
  for (const g0 of positions) {
    const g = JSON.parse(JSON.stringify(g0));
    const r = chooseJointAction(g, { version: 'joint-js5', gateMode: 'always', workUnits: 16, worlds: 4, simSeed: 13 });
    if (r.joint.championAction && r.joint.stats.rollouts > 0) {
      const championInEvals = r.joint.evaluations.some(e => JSON.stringify(e.action) === JSON.stringify(r.joint.championAction));
      assert.ok(championInEvals, '冠军行动未参与联合评估（C2 违规）');
      assert.equal(r.joint.evaluations.find(e => JSON.stringify(e.action) === JSON.stringify(r.joint.championAction)).trials,
        Math.max(...r.joint.evaluations.map(e => e.trials)), '冠军行动试验数少于其他候选（平衡批次违规）');
    }
    const g2 = JSON.parse(JSON.stringify(g0));
    const r2 = chooseJointAction(g2, { version: 'joint-js5', gateMode: 'always', claimRanking: 'prior', workUnits: 16, worlds: 4, simSeed: 13 });
    assert.doesNotThrow(() => applyAction(g2, r2.action), 'claimRanking=prior 决策非法');
  }
});
