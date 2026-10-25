/** AI7 C3 联合仲裁稳健性回归（独立测试）。
 *
 * 复现审计 §5.2–§5.5 的四类危险覆盖（固定工作量 128 轨迹，确定性）：
 * - TS-2P-MCL-001：冻结 js5 覆盖 20 分认领为 M39；候选必须保留认领。
 * - TS-4P-MCL-001：候选必须保留 16+3 分认领（不得换成低分认领/休息）。
 * - TS-4P-AVS-001：冻结 js5 覆盖 12+1 分认为休息；候选必须保留认领。
 * - TS-3P-AVS-001：候选必须保持冠军认领。
 *
 * 机制断言（不是记住局面）：
 * - 配对差只使用双方共同 (world, replica) 键；覆盖需通过单侧置信下界；
 * - 高价值认领保护提高非认领/低分挑战者的覆盖边际；
 * - 冻结 js5 输出不新增仲裁字段（生产行为与输出形状不变）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { applyAction } from '../dist/js/engine.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { PROFILES, NEUTRAL_PROFILE } from '../dist/js/ai.js';

const TRAIN_DATA = resolve(import.meta.dirname, '../../training/scenarios/data/scenarios.jsonl');
const SCENARIOS = readFileSync(TRAIN_DATA, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

/** 席位人格映射（与正式游戏/训练模拟器逐席一致）。 */
const seatProfile = seat => seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];

function scenarioGame(id) {
  const scenario = SCENARIOS.find(s => s.id === id);
  assert.ok(scenario, `缺少基准局面 ${id}`);
  const game = structuredClone(scenario.engineState.position);
  for (const p of game.players) p.isAI = true;
  return game;
}

const key = a => JSON.stringify(a);
const OPTIONS = { workUnits: 128, worlds: 4, simSeed: 0 };

function decide(id, version, extra = {}) {
  const game = scenarioGame(id);
  const t0 = performance.now();
  const r = chooseJointAction(game, { ...OPTIONS, ...extra, version, profile: seatProfile(game.current) });
  return { ...r, ms: performance.now() - t0, game };
}

/** 四个审计局面的冻结 js5 行为锚点（workUnits=128，与语料 js5-w128 一致）。 */
const CASES = [
  { id: 'TS-2P-MCL-001', js5: { type: 'play', cardId: 'M39' }, champion: { type: 'claim', index: 0 }, gross: 23 },
  { id: 'TS-4P-MCL-001', js5: { type: 'claim', index: 3 }, champion: { type: 'claim', index: 0 }, gross: 19 },
  { id: 'TS-4P-AVS-001', js5: { type: 'rest' }, champion: { type: 'claim', index: 1 }, gross: 13 },
  { id: 'TS-3P-AVS-001', js5: { type: 'claim', index: 0 }, champion: { type: 'claim', index: 0 }, gross: 15 },
];

test('冻结 js5 行为与语料一致，且不输出 AI7 仲裁字段', () => {
  for (const c of CASES) {
    const r = decide(c.id, 'joint-js5');
    assert.deepEqual(r.action, c.js5, `${c.id} 冻结 js5 行为漂移`);
    assert.deepEqual(r.joint.championAction, c.champion, `${c.id} 冠军锚点漂移`);
    assert.equal(r.joint.stats.arbitration, undefined, `${c.id} 冻结 js5 不得新增 arbitration 字段`);
    assert.equal(r.joint.stats.claimGuard, undefined, `${c.id} 冻结 js5 不得新增 claimGuard 字段`);
    assert.doesNotThrow(() => applyAction(structuredClone(r.game), r.action));
  }
});

test('js7 候选：四个审计局面都保持冠军/受保护认领，不再被低置信度覆盖', () => {
  for (const c of CASES) {
    const r = decide(c.id, 'joint-js7-arb');
    assert.deepEqual(r.action, c.champion, `${c.id} js7 仍覆盖了冠军认领`);
    assert.doesNotThrow(() => applyAction(structuredClone(r.game), r.action), `${c.id} js7 决策非法`);
    assert.equal(r.joint.gated, true, `${c.id} js7 应进入联合仲裁（否则无法验证保护机制）`);
    const arb = r.joint.stats.arbitration;
    assert.ok(arb, `${c.id} js7 缺少 arbitration 遥测`);
    assert.equal(arb.mode, 'paired');
    assert.equal(arb.minTrials, 4);
    assert.equal(arb.pairedZ, 1.645);
    assert.equal(arb.championProtected, true, `${c.id} 冠军认领应受保护（毛分 ${c.gross} ≥ 10）`);
    assert.ok(arb.protectedClaims.includes(key(c.champion)), `${c.id} 冠军行动应在受保护认领集合中`);

    // 每个候选都有统一配对样本（同一 world/replica 键集）。
    for (const cand of arb.candidates) {
      assert.equal(cand.pairedTrials, cand.trials, `${c.id} 配对样本与试验数不一致`);
      assert.ok(cand.requiredMargin >= 0.02, `${c.id} 覆盖边际低于基础值`);
    }
    // 认领候选补全：最佳当步净分认领必须在候选集中。
    const guard = r.joint.stats.claimGuard;
    assert.ok(guard, `${c.id} js7 缺少 claimGuard 遥测`);
    assert.equal(guard.bestClaim?.inCandidates, true, `${c.id} 最佳认领未进入候选集`);
  }
});

test('配对置信下界是保护机制而非偶然：关闭保护后覆盖重新出现', () => {
  const base = decide('TS-2P-MCL-001', 'joint-js7-arb');
  assert.deepEqual(base.action, { type: 'claim', index: 0 });
  const r = decide('TS-2P-MCL-001', 'joint-js7-arb', {
    claimProtection: false, pairedZ: 0, minPairedTrials: 2,
  });
  assert.deepEqual(r.action, { type: 'play', cardId: 'M39' }, '关闭保护后应重现冻结覆盖（机制可证伪）');
});

test('已知反例边界：3P-AVS 冠军认领毛分 15 / 净分 11，属于受保护认领', () => {
  const r = decide('TS-3P-AVS-001', 'joint-js7-arb');
  assert.deepEqual(r.action, { type: 'claim', index: 0 });
  const guard = r.joint.stats.claimGuard;
  assert.equal(guard.bestClaim.gross, 15, 'G22 毛分应为 12+3 铜');
  assert.equal(guard.bestClaim.delta, 11, 'G22 净分应为 12+3−4 非黄费用');
  assert.equal(r.joint.stats.arbitration.championProtected, true);
});
