/** 预算有效性与遥测回归（P1-D）。
 *
 * 覆盖：
 * 1. 纯函数批次准入：W×M 成本、2.5ms/5ms 保底、可容纳世界数；
 * 2. 固定工作量模式确定性 + 遥测语义（budgetExhausted=false、trialWindowMs=null）；
 * 3. 极小墙钟预算：零试验必须如实给出原因、budgetExhausted=true 且回退冠军；
 * 4. balanced 缩减批次：候选试验数相等、(world,replica) 键集一致；
 * 5. 阶段计时互斥（rootSim 不包含 legalGen），accounting+unaccounted ≈ elapsed。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAction } from '../dist/js/engine.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai.js';
import { batchFloors, fitWorlds } from '../dist/js/js/budget.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(readFileSync(resolve(HERE, 'fixtures', name), 'utf8')).game;
const clone = v => JSON.parse(JSON.stringify(v));

test('批次准入纯函数：W×M 成本与缩减世界数', () => {
  const legacy = batchFloors('legacy', 4, 4);
  assert.equal(legacy.trialFloorMs, 5);
  assert.equal(legacy.fullBatchFloorMs, 80);
  assert.equal(legacy.minBatchFloorMs, 20);
  const balanced = batchFloors('balanced', 4, 4);
  assert.equal(balanced.trialFloorMs, 2.5);
  assert.equal(balanced.fullBatchFloorMs, 40);
  assert.equal(balanced.minBatchFloorMs, 10);
  assert.equal(fitWorlds(100, 4, 4), 4);
  assert.equal(fitWorlds(32, 4, 4), 3);
  assert.equal(fitWorlds(20, 4, 4), 2);
  assert.equal(fitWorlds(9.9, 4, 4), 0);
  assert.equal(fitWorlds(10, 4, 4), 1);
});

test('固定工作量：确定性 + 遥测语义（不假装墙钟耗尽）', () => {
  const base = load('js5-budget-c12.json');
  const a = chooseJointAction(clone(base), { version: 'joint-js5', workUnits: 32, worlds: 4, horizon: 48, simSeed: 0, gateMode: 'always', profile: NEUTRAL_PROFILE, collectTrials: true });
  const b = chooseJointAction(clone(base), { version: 'joint-js5', workUnits: 32, worlds: 4, horizon: 48, simSeed: 0, gateMode: 'always', profile: NEUTRAL_PROFILE, collectTrials: true });
  assert.deepEqual(a.action, b.action);
  assert.deepEqual(a.joint.trials, b.joint.trials);
  assert.equal(a.joint.stats.budgetExhausted, false);
  assert.equal(a.joint.stats.overBudget, false);
  assert.equal(a.joint.stats.trialWindowMs, null);
  assert.equal(a.joint.stats.zeroTrialReason, null);
  assert.equal(a.joint.stats.batchesStarted, 2);
  assert.equal(a.joint.stats.worldsUsed, 4);
  assert.equal(a.joint.stats.worldsConfigured, 4);
  // 每候选 8 试验且 (world,replica) 键集一致。
  const by = new Map();
  for (const t of a.joint.trials) {
    if (!by.has(t.actionIndex)) by.set(t.actionIndex, new Set());
    by.get(t.actionIndex).add(`${t.world}:${t.replica}`);
  }
  const keysets = [...by.values()].map(s => [...s].sort().join(','));
  assert.equal(new Set(keysets).size, 1, '固定工作量候选键集必须一致');
  assert.equal(a.joint.stats.overrideMinTrials, 2);
});

test('极小墙钟预算：零试验原因准确、budgetExhausted=true、回退冠军', () => {
  for (const mode of ['legacy', 'balanced']) {
    const base = load('js5-budget-c04.json');
    const r = chooseJointAction(clone(base), {
      version: 'joint-js5', budgetMs: 1, worlds: 4, horizon: 48, simSeed: 0,
      gateMode: 'always', profile: NEUTRAL_PROFILE, batchAdmission: mode,
    });
    assert.equal(r.joint.stats.rollouts, 0, `${mode}: 1ms 不应有试验`);
    assert.equal(r.joint.stats.budgetExhausted, true, `${mode}: 零试验必须标记预算耗尽`);
    assert.ok(['plan-and-screen-exhausted', 'batch-floor-not-met'].includes(r.joint.stats.zeroTrialReason), `${mode}: 零试验原因=${r.joint.stats.zeroTrialReason}`);
    // 1ms 预算必然被冠军规划本身超过；overBudget 与 elapsed 必须自洽。
    assert.equal(r.joint.stats.overBudget, r.joint.stats.elapsedMs > 1, `${mode}: overBudget 与 elapsed 必须自洽`);
    if (r.joint.championAction) assert.deepEqual(r.action, r.joint.championAction, `${mode}: 零试验必须回退冠军`);
    assert.doesNotThrow(() => applyAction(clone(base), r.action));
  }
});

test('墙钟 balanced：缩减批次仍保持全候选共同键集（若发生试验）', () => {
  let checked = 0;
  // 墙钟批次是否启动取决于机器负载：100ms 预算在 CI 高负载下可能全部饿死
  // （plan+screen 已耗尽 95ms 窗口）。此时不判逻辑失败，先用更大预算重试；
  // 仍无批次则只记录诊断——键集不变量仅需在发生试验时成立。
  for (const budgetMs of [100, 500]) {
    for (const f of ['js5-budget-c04.json', 'js5-budget-c09.json', 'js5-budget-c12.json']) {
      for (let i = 0; i < 4; i++) {
        const base = load(f);
        const r = chooseJointAction(clone(base), {
          version: 'joint-js5', budgetMs, worlds: 4, horizon: 48, simSeed: 0,
          gateMode: 'always', profile: NEUTRAL_PROFILE, batchAdmission: 'balanced',
          screenGoalScope: 'preferred', collectTrials: true,
        });
        const s = r.joint.stats;
        assert.ok(s.worldsUsed <= s.worldsConfigured);
        if (s.rollouts === 0) {
          assert.ok(s.zeroTrialReason, '零试验必须有原因');
          assert.equal(s.budgetExhausted, true);
          continue;
        }
        assert.equal(s.zeroTrialReason, null);
        assert.equal(s.batchesStarted >= 1, true);
        const by = new Map();
        for (const t of r.joint.trials) {
          if (!by.has(t.actionIndex)) by.set(t.actionIndex, new Set());
          by.get(t.actionIndex).add(`${t.world}:${t.replica}`);
        }
        const counts = [...by.values()].map(x => x.size);
        const keys = [...by.values()].map(x => [...x].sort().join(','));
        assert.equal(new Set(counts).size, 1, `${f}/${budgetMs}ms: 全候选试验数必须相等（${counts.join(',')}）`);
        assert.equal(new Set(keys).size, 1, `${f}/${budgetMs}ms: 全候选键集必须一致`);
        // 缩减批次（worldsUsed<4）最低 3 试验；完整批次保持 2。
        assert.equal(s.overrideMinTrials, s.worldsUsed < s.worldsConfigured ? 3 : 2);
        checked += 1;
      }
    }
    if (checked > 0) break;
  }
  if (checked === 0) console.log('  [墙钟诊断] 两档预算均未启动批次（环境负载过高），键集断言未执行');
});

test('非法准入/筛选/候选策略在规划器层显式拒绝', () => {
  const base = load('js5-budget-c04.json');
  assert.throws(() => chooseJointAction(clone(base), { version: 'joint-js5', workUnits: 2, batchAdmission: 'fast' }), /未知 batchAdmission/);
  assert.throws(() => chooseJointAction(clone(base), { version: 'joint-js5', workUnits: 2, screenGoalScope: 'some' }), /未知 screenGoalScope/);
  assert.throws(() => chooseJointAction(clone(base), { version: 'joint-js5', workUnits: 2, nearTerminalCandidate: 'always' }), /未知 nearTerminalCandidate/);
});

test('阶段计时互斥：rootSim 不含 legalGen，accounting 与 elapsed 不重复相加', () => {
  const base = load('js5-budget-c09.json');
  const r = chooseJointAction(clone(base), { version: 'joint-js5', workUnits: 32, worlds: 4, horizon: 48, simSeed: 0, gateMode: 'always', profile: NEUTRAL_PROFILE });
  const s = r.joint.stats;
  for (const key of ['planMs', 'rootSimMs', 'legalGenMs', 'gateMs', 'screenMs', 'rolloutMs', 'aggregateMs']) {
    assert.equal(typeof s[key], 'number', `stats.${key} 未披露`);
    assert.ok(s[key] >= 0, `stats.${key} 为负`);
  }
  assert.ok(s.rootSimMs < 5, `rootSimMs=${s.rootSimMs} 疑似仍包含 legalGen`);
  assert.ok(s.accountingMs >= s.rootSimMs + s.legalGenMs);
  assert.ok(Math.abs(s.accountingMs + s.unaccountedMs - s.elapsedMs) < 0.5, 'accounting + unaccounted 应约等于 elapsed');
  assert.equal(s.cloneMs, 0);
  assert.equal(s.cloneMsMeasured, false, 'cloneMs 未测量时必须显式披露');
});
