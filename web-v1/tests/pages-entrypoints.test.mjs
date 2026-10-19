import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const desktop = readFileSync(new URL('../dist/standalone.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../dist/mobile/index.html', import.meta.url), 'utf8');

test('GitHub Pages 电脑版与独立手机版均为自包含 HTML', () => {
  for (const html of [desktop, mobile]) {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /function choosePlan\(game\)/);
    assert.match(html, /const KEY = ['"]crystal-corridor-game-v2-canonical['"]/);
    assert.doesNotMatch(html, /<script type="module" src=/);
    assert.doesNotMatch(html, /<link rel="stylesheet" href=/);
  }
  assert.match(mobile, /<html lang="zh-CN" data-century-mode="mobile">/);
  assert.match(mobile, /<title>晶石回廊 · 手机版<\/title>/);
  assert.match(mobile, /viewport-fit=cover/);
  assert.match(mobile, /@media \(min-width:0px\)/);
  assert.match(desktop, /@media \(max-width:980px\)/);
});

test('独立手机版与电脑版共用同一份编译引擎', () => {
  const scripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts(mobile), scripts(desktop));
  assert.match(mobile, /document\.documentElement\.dataset\.centuryMode === 'mobile'/);
  assert.match(mobile, /href="\.\.\/"/);
  assert.match(desktop, /href="\.\/mobile\/"/);
});
