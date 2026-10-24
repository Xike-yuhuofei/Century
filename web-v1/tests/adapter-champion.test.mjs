/** 适配器冠军接线回归测试（AI6 第五阶段：JS5 晋级前置）。
 *
 * 覆盖：
 * 1. validateAIParameters 对适配器描述符的接受/拒绝口径；
 * 2. chooseAIAction 携带 adapter 参数时分派到联合规划适配器（决策合法、
 *    行为与 chooseJointAction 同源）；
 * 3. 无 adapter 字段的冠军路径行为不变（既有束搜索路径不被分派干扰）；
 * 4. apply-champion.mjs 对适配器冠军生成区 --check 的往返一致性。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction } from '../dist/js/ai.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { validateAIParameters } from '../dist/js/ai/parameters.js';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const js5Descriptor = { id: 'joint-js5', adapter: 'champion-guided', jointVersion: 'joint-js5', budgetMs: 100 };
// 前任冠军（权重参数，无 adapter）：分派零干扰断言用。
const LEGACY_CHAMPION = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/legacy-champion.json'), 'utf8'));

test('validateAIParameters：适配器描述符权重缺省补 1.0，jointVersion/budgetMs 校验', () => {
  const validated = validateAIParameters(js5Descriptor);
  assert.equal(validated.adapter, 'champion-guided');
  assert.equal(validated.jointVersion, 'joint-js5');
  assert.equal(validated.budgetMs, 100);
  for (const key of ['engineWeight', 'tempoWeight', 'contestWeight', 'synergyWeight', 'goalWeight', 'capacityWeight', 'restWeight', 'endgameWeight']) {
    assert.equal(validated[key], 1, `适配器冠军权重 ${key} 应缺省为 1.0`);
  }
  assert.throws(() => validateAIParameters({ ...js5Descriptor, adapter: 'unknown-adapter' }), /未知适配器冠军类型/);
  assert.throws(() => validateAIParameters({ id: 'x', adapter: 'champion-guided' }), /适配器冠军缺少 jointVersion/);
  assert.throws(() => validateAIParameters({ ...js5Descriptor, jointVersion: 'not-joint' }), /jointVersion 非法/);
  assert.throws(() => validateAIParameters({ ...js5Descriptor, budgetMs: 0 }), /budgetMs/);
  // 无 adapter 字段：历史校验行为不变（缺权重必须拒绝）。
  assert.throws(() => validateAIParameters({ id: 'x' }), /参数 engineWeight/);
});

test('chooseAIAction：adapter 参数分派到联合适配器（与 chooseJointAction 同源合法）', () => {
  const g = createGame(['我', '下家'], 9100, [1]);
  g.players[0].isAI = true;
  g.players[0].stock = [2, 2, 0, 0];
  g.golemMarket = ['G08', 'G05', 'G23'];
  const r = chooseAIAction(g, { parameters: js5Descriptor });
  assert.ok(r.action, '分派必须返回行动');
  assert.ok(r.reason.includes('js5'), `决策理由应来自联合适配器：${r.reason}`);
  assert.doesNotThrow(() => applyAction(g, r.action), '分派行动必须为正式引擎合法');
  // 同源对照：同一局面下 chooseJointAction 应给出相同决策。
  const g2 = createGame(['我', '下家'], 9100, [1]);
  g2.players[0].isAI = true;
  g2.players[0].stock = [2, 2, 0, 0];
  g2.golemMarket = ['G08', 'G05', 'G23'];
  const r2 = chooseJointAction(g2, { version: 'joint-js5', budgetMs: 100 });
  assert.deepEqual(r.action, r2.action, 'adapter 分派与联合适配器同源（固定工作量可复现口径）');
});

test('chooseAIAction：无 adapter 字段的冠军路径行为不变（分派零干扰）', () => {
  // 冠军路径（权重参数）必须不进入适配器分支：同局面决策理由应含 AI 4.0 冠军标识。
  const g = createGame(['我', '下家'], 9100, [1]);
  g.players[0].isAI = true;
  g.players[0].stock = [2, 2, 0, 0];
  g.golemMarket = ['G08', 'G05', 'G23'];
  const r = chooseAIAction(g, { parameters: LEGACY_CHAMPION }); // 显式权重冠军（无 adapter）
  assert.ok(!r.reason.includes('js5'), `冠军路径不得被适配器分派劫持：${r.reason}`);
  assert.doesNotThrow(() => applyAction(g, r.action));
});

test('apply-champion.mjs：适配器冠军生成区 --check 往返一致', () => {
  const tmp = resolve(repoRoot, 'web-v1/dist/adapter-champion-fixture.json');
  writeFileSync(tmp, JSON.stringify({ id: 'joint-js5', parameters: js5Descriptor }));
  try {
    // 对临时冠军文件做一次真实写入（生成区变为适配器冠军），
    // 随后 --check 必须通过（生成逻辑确定性）。
    execFileSync('node', ['training/scripts/apply-champion.mjs', '--champion', tmp], { cwd: repoRoot, stdio: 'pipe' });
    execFileSync('node', ['training/scripts/apply-champion.mjs', '--champion', tmp, '--check'], { cwd: repoRoot, stdio: 'pipe' });
  } finally {
    // 恢复官方冠军生成区（测试不得改变冠军状态；生成确定性保证逐字节还原）。
    execFileSync('node', ['training/scripts/apply-champion.mjs'], { cwd: repoRoot, stdio: 'pipe' });
    execFileSync('node', ['training/scripts/apply-champion.mjs', '--check'], { cwd: repoRoot, stdio: 'pipe' });
    unlinkSync(tmp);
  }
});
