/** 桌面运行时（AI7 任务 E3/E4）：生产接入的身份、降级与行为一致性测试。
 *
 * 断言口径（任务书 E4）：
 * - 固定算法身份（joint-js5）、固定参数（冠军参数）、固定模拟随机流（simSeed）、
 *   固定工作量（workUnits）下，Worker 与主线程同步决策逐位一致；
 * - 2–5 人各构造真实合法局面；6 人非官方扩展（2 真人 + 4 AI）单独覆盖；
 * - 墙钟模式只做诊断记录，不做逐位断言——预算耗尽时机本身不是逻辑差异。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createGame, applyAction } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai/observation.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { decideFromObservation } from '../dist/js/ai-runtime/decision-core.js';
import { createAIDecisionClient } from '../dist/js/ai-runtime/client.js';
import {
  championDecisionConfig, createDesktopAIRuntime,
} from '../dist/js/ai-runtime/desktop-runtime.js';
import { validateObservationShape } from '../dist/js/ai-runtime/protocol.js';
import { spawnNodeAIWorker } from './ai-runtime-helpers.mjs';

const clone = value => JSON.parse(JSON.stringify(value));

/** 构造指定人数的真实合法局面：用 JS2 快速推进，直到 AI 席位行动。 */
function aiPosition(playerCount, seed) {
  // 6 人仅允许既有 2 真人 + 4 AI 扩展（后四席固定为 AI）。
  const names = playerCount === 6
    ? ['H1', 'H2', 'A1', 'A2', 'A3', 'A4']
    : ['H', ...Array.from({ length: playerCount - 1 }, (_, i) => `A${i + 1}`)];
  const aiSeats = playerCount === 6
    ? [2, 3, 4, 5]
    : Array.from({ length: playerCount - 1 }, (_, i) => i + 1);
  let game = createGame(names, seed, aiSeats);
  for (let moves = 0; moves < 400; moves++) {
    if (game.phase === 'finished') break;
    if (game.players[game.current].isAI && game.turnNumber >= 4) return game;
    const step = chooseJointAction(game, { version: 'joint-js2', workUnits: 2, horizon: 30 });
    game = applyAction(game, step.action);
  }
  throw new Error(`${playerCount} 人局种子 ${seed} 未找到 AI 合法局面`);
}

/** 可复现的固定工作量比较（主线程 = 适配器同一入口）。 */
function fixedWorkComparison(game, { workUnits = 8, simSeed = 20261025, horizon = 40 } = {}) {
  const observation = buildObservation(game, game.current);
  const direct = chooseJointAction(clone(game), {
    version: 'joint-js5', workUnits, horizon, simSeed,
    // AI6 第六阶段起正式入口透传冠军参数；Worker 决策核心固定注入同一对象。
    championParameters: CHAMPION_PARAMETERS,
  });
  const core = decideFromObservation({
    observation, ai: { jointVersion: 'joint-js5' },
    budget: { mode: 'fixed-work', workUnits }, simSeed, horizon,
  });
  return { observation, direct, core };
}

test('E3 运行时身份：Worker 与主线程降级共用同一冠军配置，随机流不来自游戏牌库', () => {
  const config = championDecisionConfig();
  assert.equal(config.adapter, 'champion-guided');
  assert.equal(config.jointVersion, 'joint-js5');
  assert.equal(config.budgetMs, 100);
  assert.equal(config.simSeed, 0, '必须使用常量公开随机流，不得读取正式牌库种子');
  const source = championDecisionConfig.toString();
  assert.equal(/game\.seed|merchantDeck|golemDeck/.test(source), false, '配置函数不得接触隐藏牌库/对局种子');
});

test('E4 2–5 人：Worker 与主线程固定工作量决策逐位一致', async () => {
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  try {
    await client.ready();
    for (const playerCount of [2, 3, 4, 5]) {
      for (let variant = 1; variant <= 2; variant++) {
        const game = aiPosition(playerCount, 8100 + playerCount * 10 + variant);
        const { observation, direct, core } = fixedWorkComparison(game);
        assert.deepEqual(core.action, direct.action, `${playerCount}p 决策核心与适配器不一致`);
        const outcome = await client.requestDecision({
          gameStateVersion: playerCount * 100 + variant,
          observation,
          ai: { jointVersion: 'joint-js5' },
          budget: { mode: 'fixed-work', workUnits: 8 },
          simSeed: 20261025,
          horizon: 40,
          expectedMs: 15000,
        });
        assert.equal(outcome.status, 'decision', `${playerCount}p 种子 ${variant}：${outcome.status}`);
        assert.deepEqual(outcome.action, direct.action, `${playerCount}p 种子 ${variant}：Worker 与主线程行动不一致`);
        if (direct.joint) {
          assert.equal(outcome.diagnostics.stats.rollouts, direct.joint.stats.rollouts,
            `${playerCount}p 种子 ${variant}：工作量不一致`);
          assert.equal(outcome.diagnostics.gated, direct.joint.gated === true,
            `${playerCount}p 种子 ${variant}：门控身份不一致`);
        }
        assert.doesNotThrow(() => applyAction(clone(game), outcome.action), 'Worker 行动必须被正式引擎接受');
      }
    }
    // 临近终局（更接近真实竞争门控）的 5 人冻结局面：固定工作量下仍须逐位一致。
    const nearTerminal = JSON.parse(readFileSync(
      new URL('./fixtures/js5-near-terminal-c10.json', import.meta.url), 'utf8')).game;
    const near = fixedWorkComparison(nearTerminal, { workUnits: 16, simSeed: 20261026 });
    assert.deepEqual(near.core.action, near.direct.action, '临近终局局面决策不一致');
    const nearOutcome = await client.requestDecision({
      gameStateVersion: 999, observation: near.observation, ai: { jointVersion: 'joint-js5' },
      budget: { mode: 'fixed-work', workUnits: 16 }, simSeed: 20261026, horizon: 40, expectedMs: 15000,
    });
    assert.equal(nearOutcome.status, 'decision');
    assert.deepEqual(nearOutcome.action, near.direct.action, '临近终局 Worker 决策不一致');
    if (near.direct.joint) {
      assert.equal(nearOutcome.diagnostics.stats.rollouts, near.direct.joint.stats.rollouts);
    }
  } finally {
    client.dispose();
  }
});

test('E4 6 人扩展（2 真人 + 4 AI）：协议与 Worker 路径仍可承载', async () => {
  const game = aiPosition(6, 8601);
  assert.equal(game.players.length, 6);
  const observation = buildObservation(game, game.current);
  assert.doesNotThrow(() => validateObservationShape(observation));
  const { direct, core } = fixedWorkComparison(game, { workUnits: 6, simSeed: 8602 });
  assert.deepEqual(core.action, direct.action);
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  try {
    await client.ready();
    const outcome = await client.requestDecision({
      gameStateVersion: 1, observation, ai: { jointVersion: 'joint-js5' },
      budget: { mode: 'fixed-work', workUnits: 6 }, simSeed: 8602, horizon: 40, expectedMs: 15000,
    });
    assert.equal(outcome.status, 'decision');
    assert.deepEqual(outcome.action, direct.action);
  } finally {
    client.dispose();
  }
});

test('E4 墙钟模式：只记录分布，不把计时噪声误判为逻辑差异', async () => {
  const game = aiPosition(4, 8701);
  const observation = buildObservation(game, game.current);
  const samples = [];
  const client = createAIDecisionClient({ spawn: spawnNodeAIWorker });
  try {
    await client.ready();
    for (let i = 0; i < 3; i++) {
      const direct = chooseJointAction(clone(game), {
        version: 'joint-js5', budgetMs: 120, simSeed: 0,
      });
      const outcome = await client.requestDecision({
        gameStateVersion: i + 1, observation, ai: { jointVersion: 'joint-js5' },
        budget: { mode: 'wall-clock', budgetMs: 120 }, simSeed: 0, expectedMs: 3000,
      });
      assert.equal(outcome.status, 'decision');
      assert.doesNotThrow(() => applyAction(clone(game), outcome.action));
      samples.push({
        sameAction: JSON.stringify(outcome.action) === JSON.stringify(direct.action),
        workerRollouts: outcome.diagnostics.stats.rollouts,
        mainRollouts: direct.joint?.stats.rollouts ?? 0,
        workerElapsed: Math.round(outcome.diagnostics.elapsedMs),
        mainElapsed: Math.round(direct.joint?.stats.elapsedMs ?? 0),
      });
    }
  } finally {
    client.dispose();
  }
  // 差异必须由工作量（计时）解释，而不是另一套算法/参数。
  for (const sample of samples) {
    if (!sample.sameAction) {
      assert.notEqual(sample.workerRollouts, sample.mainRollouts,
        `行动不同但工作量相同：疑似逻辑不一致 ${JSON.stringify(sample)}`);
    }
  }
  console.log('  [墙钟诊断]', JSON.stringify(samples));
});

test('E3 Worker 无法启动：显式切换主线程冠军，不静默执行不明版本', async () => {
  const game = aiPosition(5, 8801);
  const runtime = createDesktopAIRuntime({
    spawn: () => { throw new Error('模拟 Worker 被部署环境阻断'); },
  });
  try {
    assert.equal(runtime.mode(), 'uninitialized');
    const decision = await runtime.decide(game, 1);
    assert.equal(decision.source, 'main-thread');
    assert.match(decision.reason, /主线程冠军降级/);
    assert.equal(runtime.mode(), 'main-thread-degraded');
    assert.equal(runtime.stats().mainThreadFallbacks, 1);
    assert.doesNotThrow(() => applyAction(clone(game), decision.action), '降级行动必须合法');
  } finally {
    runtime.dispose();
  }
});
