import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// AI6 第六阶段：内联产物改为 esbuild IIFE 打包——旧的"剥 import 拼接"无法纳入
// AI6 联合搜索依赖（js/sim/om 与 engine/ai 存在大量顶层同名声明，拼接即冲突），
// JS5 晋级后手机 Worker 曾因此 chooseJointAction 未定义、AI 静默停摆。本测试校验
// 打包产物结构不变量：自包含、双入口隔离、冠军决策链完整、脚本可解析。
// 行为级验收由 scripts/smoke_mobile.py / smoke_replay.py（真实浏览器）承担。
const desktop = readFileSync(new URL('../dist/standalone.html', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('../dist/mobile/index.html', import.meta.url), 'utf8');

test('GitHub Pages 手机与电脑入口均自包含，视图和存档相互独立', () => {
  for (const html of [desktop, mobile]) {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /function choosePlan\(/);
    assert.doesNotMatch(html, /<script type="module" src=/);
    assert.doesNotMatch(html, /<link rel="stylesheet" href=/);
  }
  // 存档键。esbuild 可能降级 const → var 并重命名冲突标识符，字符串字面量不变。
  assert.match(desktop, /(?:const|var|let) KEY = ['"]crystal-corridor-game-v2-canonical['"]/);
  assert.match(mobile, /(?:const|var|let) MOBILE_KEY = ['"]century-mobile-game-v2['"]/);
  assert.match(mobile, /id="mobile-app"/);
  assert.match(mobile, /viewport-fit=cover/);
  assert.doesNotMatch(mobile, /function renderMobileBoard/);
  assert.match(mobile, /function mHand\(\)/);
  assert.match(mobile, /href="\.\.\/"/);
  assert.match(desktop, /href="\.\/mobile\/"/);
});

test('手机与电脑嵌入同一冠军决策链（JS5）与完整模拟/对手模型依赖，脚本可解析', () => {
  for (const [name, html] of [['desktop', desktop], ['mobile', mobile]]) {
    // 冠军链标记：adapter 字面量 + 冠军参数 id + 联合搜索/公开模拟/联合 rollout
    // 入口（js/sim/om 任一缺失即静态红——行为防线在浏览器冒烟）。
    for (const marker of ['champion-guided', 'joint-js5', 'function chooseJointAction(',
      'function createSimulation(', 'function runJointRollout(', 'function choosePlan(']) {
      assert.ok(html.includes(marker), `${name} 内联产物缺少冠军链标记 ${marker}`);
    }
    // 全部 <script>（含 text/plain 嵌入 Worker）必须语法有效。
    for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      const code = m[1].trim();
      if (!code) continue;
      assert.doesNotThrow(() => new Function(code), `${name} 内联脚本语法无效`);
    }
  }
});
