import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// AI6 第六阶段：桌面内联产物改为 esbuild IIFE 打包——旧的"剥 import 拼接"无法纳入
// AI6 联合搜索依赖（js/sim/om 与 engine/ai 存在大量顶层同名声明，拼接即冲突）。
// 本测试校验打包产物结构不变量：自包含、冠军决策链完整、脚本可解析。
// 行为级验收由 scripts/smoke_replay.py（真实浏览器）承担。
const desktop = readFileSync(new URL('../dist/standalone.html', import.meta.url), 'utf8');

test('GitHub Pages 桌面入口自包含，存档键与视图独立', () => {
  assert.match(desktop, /<meta name="viewport"/);
  assert.match(desktop, /function choosePlan\(/);
  assert.doesNotMatch(desktop, /<script type="module" src=/);
  assert.doesNotMatch(desktop, /<link rel="stylesheet" href=/);
  // esbuild 可能降级 const → var 并重命名冲突标识符，字符串字面量不变。
  assert.match(desktop, /(?:const|var|let) KEY = ['"]crystal-corridor-game-v2-canonical['"]/);
});

test('桌面入口嵌入冠军决策链（JS5）与完整模拟/对手模型依赖，脚本可解析', () => {
  // 冠军链标记：adapter 字面量 + 冠军参数 id + 联合搜索/公开模拟/联合 rollout
  // 入口（js/sim/om 任一缺失即静态红——行为防线在浏览器冒烟）。
  for (const marker of ['champion-guided', 'joint-js5', 'function chooseJointAction(',
    'function createSimulation(', 'function runJointRollout(', 'function choosePlan(']) {
    assert.ok(desktop.includes(marker), `桌面内联产物缺少冠军链标记 ${marker}`);
  }
  // 全部 <script> 必须语法有效。
  for (const m of desktop.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const code = m[1].trim();
    if (!code) continue;
    assert.doesNotThrow(() => new Function(code), '桌面内联脚本语法无效');
  }
});
