/** Joint Search V1 信息公平性与预算纪律测试（AI6 第四阶段·交付 3）。
 *
 * 覆盖：
 * 1. 静态扫描：src/js/** 源码对隐藏牌库（merchantDeck/golemDeck 顺序）引用为零；
 * 2. 隐藏牌库随机化不变性：公开信息一致时联合决策一致（多位置 × 多种打乱）；
 * 3. 预算纪律：25/50/100/200ms 预算下 p95 不超过预算 + 5ms 容差；
 * 4. 预算耗尽回退：决策永远合法（含 0 轨迹完成的极端回退路径）；
 * 5. 版本隔离：未注册版本抛错；js1 委托冠军口径（beam-contest）行为存在。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';

const SRC_JS = resolve(import.meta.dirname, '../src/js');

const mulberry32 = seed => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffle = (array, random) => {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

/** 采集中局位置（champion 快速推进采样）。 */
function midgamePositions(count) {
  const positions = [];
  for (let seed = 5000; seed <= 5020 && positions.length < count; seed++) {
    let g = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 400 && positions.length < count) {
      if (g.phase === 'turn' && g.turnNumber % 9 === 4 && g.players[g.current].claimed.length === 0) {
        positions.push(JSON.parse(JSON.stringify(g)));
      }
      const r = chooseJointAction(g, { version: 'joint-js2', workUnits: 3, horizon: 30 });
      g = applyAction(g, r.action);
      moves++;
    }
  }
  return positions;
}

test('静态扫描：src/js 对隐藏牌库顺序的引用为零', () => {
  const files = readdirSync(SRC_JS).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 8, `src/js 模块数异常：${files.length}`);
  const pattern = /\.(merchantDeck|golemDeck)\b/;
  for (const file of files) {
    const text = readFileSync(join(SRC_JS, file), 'utf8');
    assert.equal(pattern.test(text), false, `${file} 引用了隐藏牌库字段`);
  }
});

test('随机化隐藏牌库顺序不改变联合规划决策（多位置 × 多种打乱）', () => {
  const positions = midgamePositions(10);
  assert.ok(positions.length >= 8, `采集中局位置不足：${positions.length}`);
  for (let pi = 0; pi < positions.length; pi++) {
    const base = positions[pi];
    const baseDecision = chooseJointAction(base, { version: 'joint-js3', workUnits: 6, horizon: 40, simSeed: 42 });
    for (let variant = 1; variant <= 3; variant++) {
      const shuffledGame = JSON.parse(JSON.stringify(base));
      const random = mulberry32(pi * 100 + variant);
      shuffledGame.merchantDeck = shuffle(shuffledGame.merchantDeck, random);
      shuffledGame.golemDeck = shuffle(shuffledGame.golemDeck, random);
      const shuffledDecision = chooseJointAction(shuffledGame, { version: 'joint-js3', workUnits: 6, horizon: 40, simSeed: 42 });
      assert.deepEqual(shuffledDecision.action, baseDecision.action, `位置 ${pi} 变体 ${variant}：决策随隐藏牌序改变`);
    }
  }
});

test('预算纪律：25/50/100/200ms 预算下决策延迟 p95 ≤ 预算 + 5ms', () => {
  const positions = midgamePositions(6);
  for (const budget of [25, 50, 100, 200]) {
    const samples = [];
    for (const g0 of positions) {
      const g = JSON.parse(JSON.stringify(g0));
      const t0 = performance.now();
      chooseJointAction(g, { version: 'joint-js2', budgetMs: budget });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
    assert.ok(p95 <= budget + 5, `预算 ${budget}ms：p95=${p95.toFixed(1)}ms 超限`);
  }
});

test('预算耗尽回退：极端预算下决策仍合法', () => {
  const positions = midgamePositions(4);
  for (const g0 of positions) {
    const g = JSON.parse(JSON.stringify(g0));
    // 1ms 极端预算：0-1 条轨迹完成也应返回合法行动。
    const r = chooseJointAction(g, { version: 'joint-js4', budgetMs: 1 });
    assert.doesNotThrow(() => applyAction(g, r.action), '极端预算下决策非法');
    // 0 预算：筛选即耗尽预算（慢机上必然发生）→ 必须回退先验最优而非抛错。
    const g2 = JSON.parse(JSON.stringify(g0));
    const r0 = chooseJointAction(g2, { version: 'joint-js2', budgetMs: 0 });
    assert.equal(r0.joint.stats.rollouts, 0, '0 预算应零轨迹完成（回退路径前提）');
    assert.doesNotThrow(() => applyAction(g2, r0.action), '0 预算回退决策非法');
  }
});

test('版本隔离：未注册版本抛错；注册版本可完整决策', () => {
  const positions = midgamePositions(2);
  const g = JSON.parse(JSON.stringify(positions[0]));
  assert.throws(() => chooseJointAction(g, { version: 'joint-js9' }), /未知联合规划版本/);
  assert.throws(() => chooseJointAction(g, { version: 'beam-rollout' }), /未知联合规划版本/);
  for (const version of ['joint-js1', 'joint-js2', 'joint-js3', 'joint-js4']) {
    const clone = JSON.parse(JSON.stringify(g));
    const r = chooseJointAction(clone, { version, workUnits: 4, horizon: 40 });
    assert.ok(r.action, `${version} 无决策`);
  }
});
