import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const desktop = readFileSync(new URL('../dist/standalone.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../dist/mobile/index.html', import.meta.url), 'utf8');

test('GitHub Pages 手机与电脑入口均自包含，视图和存档相互独立', () => {
  for (const html of [desktop, mobile]) {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /function choosePlan\(game\)/);
    assert.doesNotMatch(html, /<script type="module" src=/);
    assert.doesNotMatch(html, /<link rel="stylesheet" href=/);
  }
  assert.match(desktop, /const KEY = ['"]crystal-corridor-game-v2-canonical['"]/);
  assert.match(mobile, /const MOBILE_KEY = ['"]century-mobile-game-v2['"]/);
  assert.match(mobile, /id="mobile-app"/);
  assert.match(mobile, /viewport-fit=cover/);
  assert.doesNotMatch(mobile, /function renderMobileBoard/);
  assert.match(mobile, /function mHand\(\)/);
  assert.match(mobile, /href="\.\.\/"/);
  assert.match(desktop, /href="\.\/mobile\/"/);
});

test('手机与电脑嵌入同一份编译规则和 AI，不复制规则源码', () => {
  const compiled = name => readFileSync(new URL(`../dist/js/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import\s.*?from\s+['"].*?['"];?\s*$/gm, '')
    .replace(/^export\s+(?=(const|function|class)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '').trim();
  for (const name of ['data','engine','ai']) {
    const code=compiled(name);
    assert.ok(desktop.includes(code), `电脑缺少同源 ${name}`);
    assert.ok(mobile.includes(code), `手机缺少同源 ${name}`);
  }
});
