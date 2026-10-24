import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// 契约（build.mjs 已改用 esbuild 打包，见 PR 修复说明）：
//  - standalone.html / mobile 离线页为 esbuild IIFE 自包含产物；
//  - 决策链 ai/decision → js/adapter → js/*、om/*、sim/*（JS5）必须完整进入内联包
//    （回归背景：旧手工清单漏加 js/* 模块 → AI 运行时 ReferenceError → 冒烟超时）；
//  - mobile 在线模式经 assets/<digest>/ 拷贝 dist/js 原始模块（与桌面完全同源）。

const desktop = readFileSync(new URL('../dist/standalone.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../dist/mobile/index.html', import.meta.url), 'utf8');

test('GitHub Pages 手机与电脑入口均自包含，视图和存档相互独立', () => {
  for (const html of [desktop, mobile]) {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /function choosePlan\(/);
    assert.doesNotMatch(html, /<script type="module" src=/);
    assert.doesNotMatch(html, /<link rel="stylesheet" href=/);
  }
  assert.match(desktop, /KEY = ['"]crystal-corridor-game-v2-canonical['"]/);
  assert.match(mobile, /MOBILE_KEY = ['"]century-mobile-game-v2['"]/);
  assert.match(mobile, /id="mobile-app"/);
  assert.match(mobile, /viewport-fit=cover/);
  assert.doesNotMatch(mobile, /function renderMobileBoard/);
  assert.match(mobile, /function mHand\(\)/);
  assert.match(mobile, /href="\.\.\/"/);
  assert.match(desktop, /href="\.\/mobile\/"/);
});

test('JS5 决策链（ai/decision → js/adapter → js/*、om/*、sim/*）完整进入内联包', () => {
  // 这些函数分别来自 ai/planner、js/adapter、sim/session、om/policy、js/champion-guided：
  // 任一缺失即意味着模块清单再次断链（AI 将在运行时 ReferenceError 并停摆）。
  const markers = [
    'function choosePlan(',
    'function chooseJointAction(',
    'function createSimulation(',
    'function scoreAction(',
  ];
  for (const html of [desktop, mobile]) {
    for (const marker of markers) {
      assert.ok(html.includes(marker), `内联包缺少 JS5 链路标记：${marker}`);
    }
    assert.match(html, /joint-js5/, '内联包应包含 JS5 冠军版本标识');
  }
});

test('手机在线模式与桌面共享同一份编译规则和 AI（assets 拷贝，非复制源码）', () => {
  const assetsRoot = new URL('../dist/mobile/assets/', import.meta.url);
  const digestDirs = readdirSync(assetsRoot).filter(d => /^[0-9a-f]{12}$/.test(d));
  assert.ok(digestDirs.length >= 1, '存在 assets/<digest> 资源目录');
  for (const dir of digestDirs) {
    for (const name of ['engine', 'data', 'ai/decision']) {
      const asset = readFileSync(new URL(`../dist/mobile/assets/${dir}/${name}.js`, import.meta.url), 'utf8');
      const origin = readFileSync(new URL(`../dist/js/${name}.js`, import.meta.url), 'utf8');
      assert.equal(
        createHash('sha256').update(asset).digest('hex'),
        createHash('sha256').update(origin).digest('hex'),
        `assets/${dir}/${name} 必须与 dist/js/${name} 逐字节同源`,
      );
    }
  }
});
