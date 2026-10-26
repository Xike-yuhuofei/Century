/** 测试分片与长测试拆分：覆盖不变 + 计划确定性 + CI 与测试默认范围一致。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planTestShards, loadWeights, parseExcludes } from '../plan-test-shards.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const ROOT_WEIGHTS = resolve(ROOT, 'scripts/ci/test-runtime-weights.json');

function files(paths, bytes = 1000) {
  return paths.map(path => ({ path, bytes }));
}

test('分片计划：恰好覆盖一次、权重均衡、确定性', () => {
  const list = files(['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs', 'e.test.mjs']);
  const plan = planTestShards({ files: list, shards: 3 });
  const covered = plan.flatMap(p => p.files);
  assert.equal(covered.length, list.length);
  assert.equal(new Set(covered).size, list.length);
  const weights = plan.map(p => p.weight);
  assert.ok(Math.max(...weights) - Math.min(...weights) <= 1000, `权重不均衡：${weights.join(',')}`);
  assert.deepEqual(plan.map(p => p.index), [0, 1, 2]);
  assert.deepEqual(planTestShards({ files: list, shards: 3 }), plan, '同一输入必须得到同一计划');
});

test('分片计划：实测权重优先于字节数', () => {
  const list = [
    { path: 'heavy.test.mjs', bytes: 10 },
    { path: 'light.test.mjs', bytes: 999_999 },
  ];
  const plan = planTestShards({
    files: list, shards: 2,
    weights: { 'heavy.test.mjs': 600, 'light.test.mjs': 1 },
  });
  assert.equal(plan[0].files[0], 'heavy.test.mjs');
  assert.equal(plan[0].weight, 600);
  assert.equal(plan[1].weight, 1);
});

test('分片计划：空输入/非法分片失败关闭', () => {
  assert.throws(() => planTestShards({ files: [], shards: 2 }), /为空/);
  assert.throws(() => planTestShards({ files: files(['a.test.mjs']), shards: 0 }), /分片数非法/);
});

test('--exclude：拼写错误立即失败，正确名称被排除', () => {
  assert.throws(() => parseExcludes('no-such.test.mjs', 'web-v1/tests'), /不存在的测试文件/);
  assert.deepEqual(parseExcludes('ai.test.mjs', 'web-v1/tests'), ['ai.test.mjs']);
});

test('实测权重文件：格式合法且指向真实测试文件', () => {
  const weights = loadWeights(ROOT_WEIGHTS);
  assert.ok(Object.keys(weights).length > 0, '权重文件缺失或为空');
  for (const [path, value] of Object.entries(weights)) {
    assert.match(path, /^(training|web-v1)\/tests\/.*\.test\.mjs$/, `权重键不是测试文件：${path}`);
    assert.ok(value > 0, `权重必须为正：${path}=${value}`);
  }
});

test('CI 长测试拆分与测试默认范围一致（不得漏跑人数/种子）', () => {
  const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const testSource = readFileSync(resolve(ROOT, 'web-v1/tests/ai.test.mjs'), 'utf8');

  const botsBlock = /CENTURY_AI_TEST_BOTS: \$\{\{ matrix\.bots \}\}/.test(ci);
  assert.ok(botsBlock, 'CI 必须把 CENTURY_AI_TEST_BOTS 绑定到 matrix.bots');
  const matrix = /matrix:\s*\n\s*bots: \[([0-9, ]+)\]/.exec(ci);
  assert.ok(matrix, 'CI 缺少 bots 矩阵');
  const ciBots = matrix[1].split(',').map(s => Number(s.trim()));
  const defaultBots = /: \[1, 2, 3, 4\]/.test(testSource);
  assert.ok(defaultBots, 'ai.test.mjs 的默认人数集合应为 [1,2,3,4]');
  assert.deepEqual(ciBots, [1, 2, 3, 4], `CI 人数矩阵必须覆盖默认集合，实际 ${JSON.stringify(ciBots)}`);

  const start = /CENTURY_AI_TEST_SEED_START: '(\d+)'/.exec(ci)?.[1];
  const end = /CENTURY_AI_TEST_SEED_END: '(\d+)'/.exec(ci)?.[1];
  assert.equal(start, '1', 'CI 种子起点必须与测试默认一致');
  assert.equal(end, '16', 'CI 种子终点必须与测试默认一致');

  // 被排除的必须是同一个文件，且确实由专用作业执行。
  assert.match(ci, /--exclude ai\.test\.mjs/);
  assert.match(ci, /tests\/ai\.test\.mjs/, '专用作业必须运行被排除的测试文件');
});
