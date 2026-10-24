import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// AI6 第六阶段：standalone/离线改用 esbuild IIFE 打包（模块作用域根治跨模块
// 顶层标识符冲突；构建清单自动跟随 import 闭包）。本文件断言同步更新——
// 意图不变：双入口自包含、同源编译产物、视图与存档相互独立。

const desktop = readFileSync(new URL('../dist/standalone.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../dist/mobile/index.html', import.meta.url), 'utf8');

test('GitHub Pages 手机与电脑入口均自包含，视图和存档相互独立', () => {
  for (const html of [desktop, mobile]) {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /function choosePlan\(/);
    assert.doesNotMatch(html, /<script type="module" src=/);
    assert.doesNotMatch(html, /<link rel="stylesheet" href=/);
  }
  // esbuild IIFE 将顶层 const 提升为 var（模块作用域内），字符串内容不变。
  assert.match(desktop, /(const|var|let)\s+KEY\s*=\s*['"]crystal-corridor-game-v2-canonical['"]/);
  assert.match(mobile, /(const|var|let)\s+MOBILE_KEY\s*=\s*['"]century-mobile-game-v2['"]/);
  assert.match(mobile, /id="mobile-app"/);
  assert.match(mobile, /viewport-fit=cover/);
  assert.doesNotMatch(mobile, /function renderMobileBoard/);
  assert.match(mobile, /function mHand\(\)/);
  assert.match(mobile, /href="\.\.\/"/);
  assert.match(desktop, /href="\.\/mobile\/"/);
});

/** 从编译产物提取有区分度的字符串字面量（同源嵌入检查用）。
 * 先剥离注释（esbuild 产物不含注释，注释内文本不构成同源证据）；
 * 匹配单/双引号（tsc 保留源码引号风格）。 */
function distinctiveLiteral(name) {
  const raw = readFileSync(new URL(`../dist/js/${name}.js`, import.meta.url), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals = [
    ...src.matchAll(/"([^"\\\n]{8,})"/g), ...src.matchAll(/'([^'\\\n]{8,})'/g),
  ].map(m => m[1]);
  literals.sort((a, b) => b.length - a.length);
  return literals[0] ?? null;
}

test('手机与电脑嵌入同一份编译规则和 AI（esbuild IIFE 同源），不复制规则源码', () => {
  // 引擎/AI/冠军适配器路径的关键模块：以运行时必达的语义锚点断言同源嵌入
  // （esbuild 作用域包装 + 模板字符串切分后，字节级子串/自动提取均不可靠；
  // 锚点取自各模块的实际输出字符串与标识符，与 dist/js 编译产物同源）。
  const anchors = {
    'data': '"G01"',
    'engine': '游戏结束，AI 无法行动',
    'ai/decision': 'AI 4.0',
    'js/adapter': '联合规划决策非法',
    'js/champion-guided': '未校准胜率近似',
    'sim/session': 'historySummary',
    'om/index': 'predictAction',
  };
  for (const [name, anchor] of Object.entries(anchors)) {
    assert.ok(desktop.includes(anchor), `电脑缺少同源 ${name}（锚点缺失：${anchor}）`);
    assert.ok(mobile.includes(anchor), `手机缺少同源 ${name}（锚点缺失：${anchor}）`);
  }
  // 源码文本不得成段出现（esbuild 的 `// src/x.ts` 模块路径注释除外——
  // 那是打包器标记，不是源码复制）。
  assert.ok(!desktop.includes('import { choosePlan }'), '桌面 HTML 不应包含源码 import 语句');
});

test('内联产物顶层标识符无冲突（esbuild 模块作用域后为历史回归锚）', () => {
  // esbuild IIFE 将每个模块包进作用域，跨模块重名已不可达；本测试保留为
  // 手工 strip 时代的历史锚（若回退 strip 内联，这里会先红）。
  const AI_MODULES = ['ai/parameters','ai/profiles','ai/observation','ai/knowledge','ai/opponent-model','ai/evaluator','ai/planner','ai/decision'];
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
