import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 与 scripts/build.mjs 的 AI_MODULES 保持同步：AI 4.0 决策核心模块清单。
const AI_MODULES = ['ai/parameters','ai/profiles','ai/observation','ai/knowledge','ai/opponent-model','ai/evaluator','ai/planner','ai/decision'];

const desktop = readFileSync(new URL('../dist/standalone.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../dist/mobile/index.html', import.meta.url), 'utf8');

test('GitHub Pages 手机与电脑入口均自包含，视图和存档相互独立', () => {
  for (const html of [desktop, mobile]) {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /function choosePlan\(/);
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
  for (const name of ['data','engine',...AI_MODULES]) {
    const code=compiled(name);
    assert.ok(desktop.includes(code), `电脑缺少同源 ${name}`);
    assert.ok(mobile.includes(code), `手机缺少同源 ${name}`);
  }
});

test('内联产物顶层标识符无冲突（standalone 为共享作用域）', () => {
  const strip = name => readFileSync(new URL(`../dist/js/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import\s.*?from\s+['"].*?['"];?\s*$/gm, '')
    .replace(/^export\s+(?=(const|function|class)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  const decls = new Map();
  for (const name of ['data','engine',...AI_MODULES,'organize','replay','archive','auto-export','app','mobile/storage','mobile/app','mobile/worker']) {
    const src = strip(name);
    const re = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(src))) {
      const id = m[1];
      assert.ok(!decls.has(id), `顶层标识符 '${id}' 在 ${name}.js 与 ${decls.get(id)}.js 重复声明，内联包会 SyntaxError`);
      decls.set(id, name);
    }
  }
});
