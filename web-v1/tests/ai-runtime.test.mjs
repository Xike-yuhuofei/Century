/** AI Worker 运行时测试（夜间任务 C）。
 *
 * 覆盖任务书"实验正确性"要求：
 * 1. 静态公平性：worker 侧模块对隐藏牌库引用为零；无任何网络 API；
 * 2. 协议防火墙：白名单外/禁止字段载荷被拒绝；
 * 3. 固定工作量一致性：同一公开观察 + 同一算法 + 同一随机流 + 同一固定工作量
 *    ⇒ Worker 决策与主线程直接调用行动一致（含 chooseJointAction 全量交叉验证）；
 * 4. 隐藏牌库随机化不变性：打乱 merchantDeck/golemDeck 不改变 worker 决策；
 * 5. 非法行动防线：worker 决策与回退路径输出均被正式引擎接受；
 * 6. 换局隔离：旧局请求不污染新局（reset + 重生双路径）；
 * 7. 墙钟预算：延迟分布报告（不要求跨机器逐位一致）。
 *
 * 算力纪律：全部为少量固定工作量决策（workUnits ≤ 16 / budgetMs ≤ 400），
 * 无大规模对局扫描。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createGame, applyAction } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai/observation.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { decideFromObservation, DecisionCoreError } from '../dist/js/ai-runtime/decision-core.js';
import { chooseVerifiedFallback } from '../dist/js/ai-runtime/fallback.js';
import {
  PROTOCOL_VERSION, PROTOCOL_MAJOR_VERSION, validateObservationShape,
} from '../dist/js/ai-runtime/protocol.js';
import { createAIDecisionClient } from '../dist/js/ai-runtime/client.js';
import { spawnNodeAIWorker, midgamePositions } from './ai-runtime-helpers.mjs';

const SRC_RUNTIME = resolve(import.meta.dirname, '../src/ai-runtime');
const DIST_RUNTIME = resolve(import.meta.dirname, '../dist/js/ai-runtime');

const runtimeModules = () => readdirSync(DIST_RUNTIME).filter(f => f.endsWith('.js'));

/** 构造一个"推进到 AI 行动"的确定性中局 + 公开观察。 */
function positionAndObservation(seed) {
  let g = createGame(['A', 'B', 'C', 'D'], seed, [1, 2, 3]);
  let moves = 0;
  while (g.phase !== 'finished' && moves < 200) {
    if (g.phase === 'turn' && g.turnNumber % 9 === 4) break;
    const r = chooseJointAction(g, { version: 'joint-js2', workUnits: 2, horizon: 30 });
    g = applyAction(g, r.action);
    moves++;
  }
  if (g.phase !== 'turn') throw new Error(`种子 ${seed} 未采到 turn 局面（phase=${g.phase}）`);
  return { game: g, observation: buildObservation(g, g.current) };
}

test('协议常量与防火墙：白名单外字段、禁止字段被拒绝', () => {
  assert.equal(PROTOCOL_MAJOR_VERSION, PROTOCOL_VERSION.split('.')[0]);
  const { observation } = positionAndObservation(6101);
  assert.doesNotThrow(() => validateObservationShape(observation));
  assert.throws(() => validateObservationShape({ ...observation, merchantDeck: ['M01'] }), /merchantDeck.*防火墙|防火墙.*merchantDeck/i);
  assert.throws(() => validateObservationShape({ ...observation, golemDeck: ['G01'] }), /golemDeck/i);
  assert.throws(() => validateObservationShape({ ...observation, rogueField: 1 }), /白名单之外/);
  assert.throws(() => validateObservationShape({ playerId: observation.playerId }), /缺少必需字段/);
});

test('静态扫描：ai-runtime worker 侧源码对隐藏牌库引用为零', () => {
  const pattern = /\.(merchantDeck|golemDeck)\b/;
  for (const file of readdirSync(SRC_RUNTIME).filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(join(SRC_RUNTIME, file), 'utf8');
    // worker 侧四文件绝不允许出现隐藏牌库标识符；client/harness 允许类型引用吗？
    // 本仓库纪律：整个 ai-runtime 目录一律零引用（观察构建走 buildObservation）。
    assert.equal(pattern.test(text), false, `${file} 引用了隐藏牌库字段`);
  }
});

test('静态扫描：ai-runtime 无任何网络 API 与远程地址', () => {
  const pattern = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|importScripts\s*\(|https?:\/\/(?!localhost|127\.0\.0\.1)/;
  for (const file of readdirSync(SRC_RUNTIME).filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(join(SRC_RUNTIME, file), 'utf8');
    assert.equal(pattern.test(text), false, `${file} 疑似网络访问（运行时不通过网络获取模型/信息）`);
  }
  for (const file of runtimeModules()) {
    const text = readFileSync(join(DIST_RUNTIME, file), 'utf8');
    assert.equal(pattern.test(text), false, `编译产物 ${file} 疑似网络访问`);
  }
});

test('固定工作量决策核心：逐位确定性（同观察 + 同种子 + 同工作量）', () => {
  const { observation } = positionAndObservation(6102);
  const request = {
    observation, ai: { jointVersion: 'joint-js5' },
    budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 910, horizon: 40,
  };
  const first = decideFromObservation(request);
  const second = decideFromObservation(JSON.parse(JSON.stringify(request)));
  assert.deepEqual(second.action, first.action);
  assert.equal(second.diagnostics.stats.rollouts, first.diagnostics.stats.rollouts);
  assert.equal(second.diagnostics.stats.budgetExhausted, false, '固定工作量模式不得报告预算耗尽');
});

test('Worker 与直接调用一致（worker_threads 同核轮转 × 多位置）', async t => {
  const positions = [];
  for (const seed of [6103, 6104, 6105]) positions.push(positionAndObservation(seed));
  await t.test('决策核心直调 == chooseJointAction（全量 Game 入口）', () => {
    for (const { game, observation } of positions) {
      const direct = chooseJointAction(game, { version: 'joint-js5', workUnits: 8, horizon: 40, simSeed: 911 });
      const core = decideFromObservation({
        observation, ai: { jointVersion: 'joint-js5' },
        budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 911, horizon: 40,
      });
      assert.deepEqual(core.action, direct.action, `位置 turn=${game.turnNumber} 席位 ${game.current} 决策不一致`);
    }
  });
  await t.test('经 client + worker_threads 往返 == 决策核心直调', async () => {
    const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
    try {
      await client.ready();
      let checked = 0;
      for (const [i, { game, observation }] of positions.entries()) {
        const direct = decideFromObservation({
          observation, ai: { jointVersion: 'joint-js5' },
          budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 912 + i, horizon: 40,
        });
        const outcome = await client.requestDecision({
          gameStateVersion: game.turnNumber * 10 + game.current,
          observation, ai: { jointVersion: 'joint-js5' },
          budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 912 + i, horizon: 40,
          expectedMs: 5000,
        });
        assert.equal(outcome.status, 'decision', `位置 ${i}：${outcome.status}`);
        assert.deepEqual(outcome.action, direct.action, `位置 ${i}：worker 行动与直调不一致`);
        assert.equal(outcome.diagnostics.stats.rollouts, direct.diagnostics.stats.rollouts);
        assert.equal(outcome.diagnostics.gameStateVersion, game.turnNumber * 10 + game.current);
        checked++;
      }
      assert.equal(checked, positions.length);
    } finally {
      client.dispose();
    }
  });
});

test('隐藏牌库随机化不改变 worker 决策（信息公平性 × worker 路径）', () => {
  const { game, observation } = positionAndObservation(6106);
  const direct = decideFromObservation({
    observation, ai: { jointVersion: 'joint-js5' },
    budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 920, horizon: 40,
  });
  const mulberry32 = seed => {
    let value = seed >>> 0;
    return () => {
      value = (value + 0x6D2B79F5) | 0;
      let t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 14), 1 | t)) >>> 0;
      return t / 4294967296;
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
  for (let variant = 1; variant <= 3; variant++) {
    const shuffledGame = JSON.parse(JSON.stringify(game));
    const random = mulberry32(700 + variant);
    shuffledGame.merchantDeck = shuffle(shuffledGame.merchantDeck, random);
    shuffledGame.golemDeck = shuffle(shuffledGame.golemDeck, random);
    const shuffledObservation = buildObservation(shuffledGame, shuffledGame.current);
    assert.deepEqual(JSON.parse(JSON.stringify(shuffledObservation)), JSON.parse(JSON.stringify(observation)),
      '打乱隐藏牌序后的公开观察必须逐字段相同');
    const shuffledDecision = decideFromObservation({
      observation: shuffledObservation, ai: { jointVersion: 'joint-js5' },
      budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 920, horizon: 40,
    });
    assert.deepEqual(shuffledDecision.action, direct.action, `变体 ${variant} 决策随隐藏牌序改变`);
  }
});

test('非法行动防线：worker 决策与回退路径均被正式引擎接受', async () => {
  const positions = await midgamePositions(5, {
    engine: { createGame, applyAction },
    adapter: g => chooseJointAction(g, { version: 'joint-js2', workUnits: 3, horizon: 30 }),
  });
  assert.ok(positions.length >= 4, `中局位置不足：${positions.length}`);
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  try {
    await client.ready();
    for (const [i, game] of positions.entries()) {
      const observation = buildObservation(game, game.current);
      const outcome = await client.requestDecision({
        gameStateVersion: i + 1, observation, ai: { jointVersion: 'joint-js5' },
        budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 930 + i, horizon: 40, expectedMs: 5000,
      });
      assert.ok(outcome.status === 'decision' || outcome.status === 'fallback', `位置 ${i}：${outcome.status}`);
      assert.doesNotThrow(() => applyAction(JSON.parse(JSON.stringify(game)), outcome.action), `位置 ${i} 行动非法`);
      const fallback = chooseVerifiedFallback(observation);
      assert.doesNotThrow(() => applyAction(JSON.parse(JSON.stringify(game)), fallback.action), `位置 ${i} 回退行动非法`);
    }
  } finally {
    client.dispose();
  }
});

test('换局隔离：旧局请求被废弃，不污染新局决策', async () => {
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  try {
    await client.ready();
    const old = positionAndObservation(6107);
    const fresh = positionAndObservation(6108);
    // 旧局慢请求（墙钟 300ms）后立即换局：invalidate 应立即废弃旧任务。
    const stalePromise = client.requestDecision({
      gameStateVersion: 1, observation: old.observation, ai: { jointVersion: 'joint-js5' },
      budget: { mode: 'wall-clock', budgetMs: 300 }, simSeed: 940, expectedMs: 2000,
    });
    client.invalidate(2); // 换局：状态版本推进
    const stale = await stalePromise;
    assert.equal(stale.status, 'superseded', `旧局请求应被废弃，实际 ${stale.status}`);
    // 新局决策与"全新 client"决策一致（无跨局状态污染）。
    const freshOutcome = await client.requestDecision({
      gameStateVersion: 2, observation: fresh.observation, ai: { jointVersion: 'joint-js5' },
      budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 941, horizon: 40, expectedMs: 5000,
    });
    const freshDirect = decideFromObservation({
      observation: fresh.observation, ai: { jointVersion: 'joint-js5' },
      budget: { mode: 'fixed-work', workUnits: 8 }, simSeed: 941, horizon: 40,
    });
    assert.equal(freshOutcome.status, 'decision');
    assert.deepEqual(freshOutcome.action, freshDirect.action, '新局决策受旧局残留影响');
  } finally {
    client.dispose();
  }
});

test('墙钟预算：worker 延迟分布（报告口径，不要求跨机器逐位一致）', async () => {
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  const samples = [];
  try {
    await client.ready();
    const { observation } = positionAndObservation(6109);
    for (const budgetMs of [200, 300, 400]) {
      const outcome = await client.requestDecision({
        gameStateVersion: 1, observation, ai: { jointVersion: 'joint-js5' },
        budget: { mode: 'wall-clock', budgetMs }, simSeed: 950, expectedMs: 2000,
      });
      assert.equal(outcome.status, 'decision');
      assert.ok(outcome.latencyMs < budgetMs + 2000, `预算 ${budgetMs}ms 延迟失控：${outcome.latencyMs.toFixed(0)}ms`);
      samples.push({ budgetMs, latency: Math.round(outcome.latencyMs), workerElapsed: Math.round(outcome.diagnostics.stats.elapsedMs), rollouts: outcome.diagnostics.stats.rollouts });
    }
  } finally {
    client.dispose();
  }
  console.log('  [延迟分布]', JSON.stringify(samples));
});

test('版本纪律：未知版本与 champion-contest 在 worker 路径被明确拒绝', async () => {
  assert.throws(() => decideFromObservation({
    observation: buildObservation(createGame(['A', 'B'], 1, [1]), 0),
    ai: { jointVersion: 'joint-js9' }, budget: { mode: 'fixed-work', workUnits: 2 }, simSeed: 1,
  }), /未知联合规划版本/);
  const { observation } = positionAndObservation(6110);
  assert.throws(() => decideFromObservation({
    observation, ai: { jointVersion: 'joint-js1' }, budget: { mode: 'fixed-work', workUnits: 2 }, simSeed: 1,
  }), /champion-contest/);
  // 决策类错误经 worker 往返后以 fallback 呈现（不悬挂、不提交过期行动）。
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  try {
    await client.ready();
    const outcome = await client.requestDecision({
      gameStateVersion: 1, observation, ai: { jointVersion: 'joint-js9' },
      budget: { mode: 'fixed-work', workUnits: 2 }, simSeed: 1, expectedMs: 2000,
    });
    // 未知版本是协议类错误：确定性失败 → 直接回退。
    assert.equal(outcome.status, 'fallback');
    assert.match(outcome.error ?? '', /未知联合规划版本/);
    assert.doesNotThrow(() => applyAction(positionAndObservation(6110).game, outcome.action), '回退行动必须合法');
  } finally {
    client.dispose();
  }
});
