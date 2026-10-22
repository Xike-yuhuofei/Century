/** P0 可靠性整改回归测试：种子解析严格性与唯一性（OpenEvolve 深度验证事故防御）。
 *
 * 事故：work/deep-seeds.txt 101 行全部为 "3.00001e+08"（科学计数法的
 * 300001000），旧实现 Number() 静默接受且无重复检测——101 个"独立"配对
 * 样本实为 1 个种子，独立验证结论失真。
 *
 * 运行：node --test ai5/openevolve/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSeedList, sequentialSeeds, assertInBlock,
  AI5_BLOCK, PPO_TRAINING_BLOCK, VALIDATION_POOL_BLOCK,
  OPENEVOLVE_STAGE2_BLOCK, OPENEVOLVE_STAGE3_BLOCK, OPENEVOLVE_DEEP_VALIDATION_BLOCK,
  AI4_EVO_BLOCK, AI4_BENCHMARK_BLOCK, AI5_EVAL_TRAINING_BLOCK,
} from '../../lib/seed_policy.mjs';

test('parseSeedList：科学计数法文本必须被拒绝（事故根因回归）', () => {
  const incident = Array.from({ length: 101 }, () => '3.00001e+08').join('\n');
  assert.throws(() => parseSeedList(incident, { block: AI5_BLOCK }),
    /格式非法/, '101 行科学计数法种子不得被静默接受');
});

test('parseSeedList：浮点/正负号/垃圾行拒绝', () => {
  for (const bad of ['300001000.0', '-300001000', '+300001000', '0x11d90be8', 'abc', '3 00001000']) {
    assert.throws(() => parseSeedList(bad, { block: AI5_BLOCK }), /格式非法/, `应拒绝："${bad}"`);
  }
});

test('parseSeedList：合法十进制列表通过并保留顺序', () => {
  const seeds = parseSeedList('300001000\n300001001\n300001002\n', { block: AI5_BLOCK });
  assert.deepEqual(seeds, [300001000, 300001001, 300001002]);
});

test('parseSeedList：重复种子必须抛错（不同配对样本禁止共享种子）', () => {
  assert.throws(() => parseSeedList('300001000\n300001000', { block: AI5_BLOCK }),
    /重复/, '重复种子破坏统计独立性');
  // 同一种子双向配对允许共享——由 duel_runner 结构保证（每 seed 一对），本函数语义即"每种子一个配对样本"。
});

test('parseSeedList：越界种子拒绝（区间纪律）', () => {
  assert.throws(() => parseSeedList('900000000', { block: AI5_BLOCK }), /越界/, '验证池种子不得进入 AI5 训练块');
  assert.throws(() => parseSeedList('299999999', { block: AI5_BLOCK }), /越界/);
});

test('parseSeedList：空列表拒绝', () => {
  assert.throws(() => parseSeedList('\n \n', { block: AI5_BLOCK }), /为空/);
});

test('sequentialSeeds：顺序切片唯一且不越界', () => {
  const seeds = sequentialSeeds(OPENEVOLVE_DEEP_VALIDATION_BLOCK, 300001100, 100);
  assert.equal(seeds.length, 100);
  assert.equal(new Set(seeds).size, 100);
  assert.equal(seeds[0], 300001100);
  assert.equal(seeds[99], 300001199);
  assert.throws(() => sequentialSeeds(OPENEVOLVE_DEEP_VALIDATION_BLOCK, 300001901, 100), /越界/);
});

test('assertInBlock：边界语义为含头不含尾', () => {
  assert.equal(assertInBlock(300000000, AI5_BLOCK), 300000000);
  assert.throws(() => assertInBlock(400000000, AI5_BLOCK), /越界/);
});

test('种子全局布局：各系统区间互不重叠（P0 整改验收）', () => {
  const blocks = {
    AI4_EVO: AI4_EVO_BLOCK,
    OPENEVOLVE_STAGE2: OPENEVOLVE_STAGE2_BLOCK,
    OPENEVOLVE_STAGE3: OPENEVOLVE_STAGE3_BLOCK,
    OPENEVOLVE_DEEP: OPENEVOLVE_DEEP_VALIDATION_BLOCK,
    PPO_TRAINING: PPO_TRAINING_BLOCK,
    AI5_EVAL_TRAINING: AI5_EVAL_TRAINING_BLOCK,
    AI4_BENCHMARK: AI4_BENCHMARK_BLOCK,
    VALIDATION_POOL: VALIDATION_POOL_BLOCK,
  };
  const names = Object.keys(blocks);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a0, a1] = blocks[names[i]];
      const [b0, b1] = blocks[names[j]];
      assert.ok(a1 <= b0 || b1 <= a0,
        `区间 ${names[i]} [${a0},${a1}) 与 ${names[j]} [${b0},${b1}) 重叠——布局违规`);
    }
  }
  // AI5 子块必须全部落在 AI5 大块内。
  for (const name of ['OPENEVOLVE_STAGE2', 'OPENEVOLVE_STAGE3', 'OPENEVOLVE_DEEP', 'PPO_TRAINING', 'AI5_EVAL_TRAINING']) {
    const [s, e] = blocks[name];
    assert.ok(s >= AI5_BLOCK[0] && e <= AI5_BLOCK[1], `${name} 必须在 AI5 块内`);
  }
  // 全部种子 < 2^31（引擎回绕安全上限）。
  for (const [name, [s, e]] of Object.entries(blocks)) {
    assert.ok(e - 1 <= 2 ** 31 - 1, `${name} 越过引擎种子安全上限`);
  }
});
