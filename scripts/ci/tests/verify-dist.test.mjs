import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDist } from '../verify-dist.mjs';

function makeDist({ standaloneSize = 200_000, planner = true, emptyEngine = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-dist-'));
  const files = [
    'js/engine.js', 'js/ai.js', 'js/data.js', 'js/js/adapter.js',
    'js/sim/index.js', 'ai-runtime/harness.html', 'index.html',
  ];
  for (const rel of files) {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, rel === 'js/engine.js' && emptyEngine ? '' : `// ${rel}`);
  }
  writeFileSync(join(dir, 'standalone.html'), `${planner ? 'function choosePlan(' : '// no planner'}${'x'.repeat(Math.max(0, standaloneSize - 20))}`);
  return dir;
}

test('B5 构建产物完整：全部必需文件 + 规划器入口 + 合理体积', () => {
  const result = verifyDist(makeDist());
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

test('B5 错误构建产物：缺少文件 → 失败', () => {
  const dir = makeDist();
  const result = verifyDist(join(dir, 'missing-dist'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(i => i.includes('缺少产物')));
});

test('B5 错误构建产物：空文件 → 失败', () => {
  const result = verifyDist(makeDist({ emptyEngine: true }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(i => i.includes('空产物：js/engine.js')));
});

test('B5 错误构建产物：standalone 缺少规划器 → 失败', () => {
  const result = verifyDist(makeDist({ planner: false }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(i => i.includes('缺少规划器入口')));
});

test('B5 错误构建产物：standalone 体积异常 → 失败', () => {
  const result = verifyDist(makeDist({ standaloneSize: 1000 }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(i => i.includes('体积异常')));
});
