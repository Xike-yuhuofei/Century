/** 公共模拟器信息公平性测试（AI6 第二阶段·任务 B/E）。
 *
 * 1. 隐藏牌序扰动不变性：保持公开状态不变、任意置换正式游戏隐藏牌序，
 *    公共状态、候选动作与信念采样分布不得发生系统性变化。
 * 2. 模拟随机流隔离：信念采样与正式游戏牌库随机数（engine LCG）零共享。
 * 3. 结构性封装：已采样未翻开的模拟牌序对 AI 决策函数物理不可见。
 * 4. 模块隔离静态扫描：src/sim 不引用隐藏字段、不运行时依赖 src/ai；
 *    src/ai 与正式入口不导入 src/sim（正式 AI 行为保持逐位不变）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createGame, applyAction } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai.js';
import {
  createSimulation, enumerateLegalActions, randomBeliefSampler,
  hashPublicState, mulberry32,
} from '../dist/js/sim/index.js';
import { chooseAIAction as chooseAIActionDist } from '../dist/js/ai.js';
import { publicProjection, simulationFor } from './public-sim-harness.mjs';

/** 中局位置采集（与 ai-fairness.test.mjs 相同的采集方式）。 */
function midgamePositions(count) {
  const positions = [];
  for (let seed = 1; seed <= 6 && positions.length < count; seed++) {
    let g = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 400 && positions.length < count) {
      if (g.phase === 'turn' && g.turnNumber % 7 === 3 && g.players[g.current].claimed.length === 0) {
        positions.push(structuredClone(g));
      }
      const { action } = chooseAIActionDist(g);
      g = applyAction(g, action);
      moves++;
    }
  }
  return positions;
}

const shuffleWith = (array, random) => {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

test('隐藏牌序扰动不变性：公开状态、候选动作与信念采样分布不变', () => {
  const positions = midgamePositions(8);
  assert.ok(positions.length >= 6, `采集中局位置不足：${positions.length}`);
  for (let pi = 0; pi < positions.length; pi++) {
    const base = positions[pi];
    const baseObs = buildObservation(base, base.current);
    const baseSim = createSimulation(baseObs, { simSeed: 7 });
    const baseProjection = publicProjection(baseSim.view);
    const baseActions = enumerateLegalActions(baseSim.view).map(a => JSON.stringify(a));
    const baseHash = hashPublicState(baseSim.view);
    // 信念采样分布：同一 simSeed 流下采样的未来牌序（只依赖公开未知集合）。
    const baseSamples = [];
    for (let s = 1; s <= 6; s++) {
      const sampler = randomBeliefSampler(s);
      baseSamples.push([
        sampler.sampleMerchantDeck(baseSim.view.unseenMerchants).join(','),
        sampler.sampleGolemDeck(baseSim.view.unseenGolems).join(','),
      ]);
    }
    for (let variant = 1; variant <= 4; variant++) {
      const shuffledGame = structuredClone(base);
      const random = mulberry32(pi * 100 + variant);
      shuffledGame.merchantDeck = shuffleWith(shuffledGame.merchantDeck, random);
      shuffledGame.golemDeck = shuffleWith(shuffledGame.golemDeck, random);
      const perturbed = simulationFor(shuffledGame);
      // 公共状态逐字段不变（含未知卡集合的集合语义）。
      assert.deepEqual(publicProjection(perturbed.view), baseProjection, `位置 ${pi} 变体 ${variant}：公共状态因隐藏牌序扰动而改变`);
      assert.equal(hashPublicState(perturbed.view), baseHash, `位置 ${pi} 变体 ${variant}：状态哈希漂移`);
      // 候选动作不变。
      assert.deepEqual(
        enumerateLegalActions(perturbed.view).map(a => JSON.stringify(a)),
        baseActions,
        `位置 ${pi} 变体 ${variant}：候选动作因隐藏牌序扰动而改变`,
      );
      // 信念采样分布不变（相同 simSeed ⇒ 相同采样输出）。
      for (let s = 1; s <= 6; s++) {
        const sampler = randomBeliefSampler(s);
        const merchantSample = sampler.sampleMerchantDeck(perturbed.view.unseenMerchants).join(',');
        const golemSample = sampler.sampleGolemDeck(perturbed.view.unseenGolems).join(',');
        assert.deepEqual([merchantSample, golemSample], baseSamples[s - 1], `位置 ${pi} 变体 ${variant} seed ${s}：信念采样分布漂移`);
      }
    }
  }
});

test('模拟随机流与真实牌库随机数隔离：相同种子流下模拟轨迹与真实牌序无关', () => {
  // 同一公开局面 + 相同模拟种子，无论真实隐藏牌序如何排列，
  // 模拟轨迹（含翻牌序列与最终哈希）逐位一致。
  const base = createGame(['A', 'B', 'C'], 314);
  base.players.forEach(p => { p.isAI = true; });
  // 推进 9 步形成中局。
  let g = base;
  for (let i = 0; i < 9; i++) {
    const { action } = chooseAIActionDist(g);
    g = applyAction(g, action);
  }
  const shuffled = structuredClone(g);
  const random = mulberry32(777);
  shuffled.merchantDeck = shuffleWith(shuffled.merchantDeck, random);
  shuffled.golemDeck = shuffleWith(shuffled.golemDeck, random);

  const runTrajectory = (game, seed) => {
    // 使用默认信念采样器（不注入真实牌序）：模拟随机世界只由 simSeed 决定，
    // 与真实隐藏牌序彻底无关。
    const sim = createSimulation(buildObservation(game, game.current), { simSeed: seed });
    const hashes = [hashPublicState(sim.view)];
    const rng = mulberry32(seed);
    let guard = 0;
    while (!sim.finished && guard < 40) {
      const actions = enumerateLegalActions(sim.view);
      const action = actions[Math.floor(rng() * actions.length)];
      sim.step(action);
      hashes.push(hashPublicState(sim.view));
      guard += 1;
    }
    return { hashes, reveals: sim.view.unseenMerchants.length + sim.view.unseenGolems.length };
  };
  const a = runTrajectory(g, 2026);
  const b = runTrajectory(shuffled, 2026);
  assert.deepEqual(b.hashes, a.hashes, '模拟轨迹随隐藏牌序扰动漂移（违反隔离约束）');
});

test('信念采样可重复性与多样性：相同输入+种子可复现，不同种子产生不同未来牌序', () => {
  const game = createGame(['A', 'B', 'C'], 55);
  const sim = simulationFor(game);
  const unseenM = sim.view.unseenMerchants;
  const unseenG = sim.view.unseenGolems;
  // 可重复：相同 seed ⇒ 相同输出。
  const a = randomBeliefSampler(42);
  const b = randomBeliefSampler(42);
  assert.equal(a.sampleMerchantDeck(unseenM).join(','), b.sampleMerchantDeck(unseenM).join(','));
  assert.equal(a.sampleGolemDeck(unseenG).join(','), b.sampleGolemDeck(unseenG).join(','));
  // 多样性：不同 seed ⇒ 至少一个不同排列。
  const outputs = new Set();
  for (let seed = 0; seed < 10; seed++) {
    outputs.add(randomBeliefSampler(seed).sampleMerchantDeck(unseenM).join(','));
  }
  assert.ok(outputs.size >= 9, `不同种子未产生多样化采样：${outputs.size}/10`);
  // 无放回：采样输出与未知集合多重集一致。
  for (let seed = 0; seed < 5; seed++) {
    const sample = randomBeliefSampler(seed).sampleMerchantDeck(unseenM);
    assert.deepEqual([...sample].sort(), [...unseenM].sort());
  }
});

test('Common Random Numbers：同一 root 的 fork 分支共享同一随机世界', () => {
  const game = createGame(['A', 'B'], 66);
  const sim = simulationFor(game);
  const view = sim.view;
  // 找一个可支付的位置 index（支付序列长度 = index > 0）。
  const acquireActions = enumerateLegalActions(view).filter(a => a.type === 'acquire' && a.payment.length > 0);
  const target = acquireActions.find(a => a.index >= 2) ?? acquireActions[0];
  assert.ok(target, '找不到可支付的获取动作');
  const branchA = sim.fork();
  const branchB = sim.fork();
  branchA.step(target);
  branchB.step(target);
  // 同一动作在两个分支翻开同一张模拟卡（CRN）。
  assert.deepEqual(
    branchA.view.merchantMarket.map(m => m.id),
    branchB.view.merchantMarket.map(m => m.id),
    'fork 分支未共享同一随机世界（CRN 失效）',
  );
  // 与 root 相比：翻开的是预设队列的同一张卡（市场其余槽位不变，仅被获取槽位被补）。
  assert.equal(branchA.view.merchantMarket.length, view.merchantMarket.length, '补牌后市场规模应不变');
});

test('已采样未翻开的牌序物理不可见（决策函数无法触达）', () => {
  const game = createGame(['A', 'B', 'C'], 77);
  const sim = simulationFor(game);
  // ES #private 字段不可枚举、不出现在序列化中。
  const ownKeys = Object.getOwnPropertyNames(sim);
  assert.equal(ownKeys.some(k => /queue/i.test(k)), false, `会话对象暴露了模拟队列字段：${ownKeys.join(',')}`);
  const serialized = JSON.stringify(sim);
  assert.equal(serialized.includes('queue'), false, 'JSON 序列化泄漏模拟队列');
  assert.equal(serialized.includes('unseenMerchants'), false, '会话对象不应直接序列化出状态内部字段');
  // 公共视图不含队列；未来翻牌只经 step 进入公开状态。
  const viewJson = JSON.stringify(sim.view);
  assert.equal(viewJson.includes('queue'), false);
  // 采样器接口只暴露采样函数，不暴露队列状态。
  const sampler = randomBeliefSampler(1);
  assert.deepEqual(Object.keys(sampler).sort(), ['sampleGolemDeck', 'sampleMerchantDeck']);
});

test('静态扫描：src/sim 不引用隐藏字段、不依赖正式引擎随机数、不运行时依赖 src/ai', () => {
  const simDir = new URL('../src/sim/', import.meta.url);
  const files = readdirSync(simDir).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 5, `sim 模块文件异常：${files.join(',')}`);
  const forbiddenDeckRefs = /\.merchantDeck|\.golemDeck/;
  const engineLcgConstants = /1664525|1013904223/;
  const runtimeAiImports = /^import\s+(?!type\b)[^;]*from\s+['"]\.\.\/ai\//m;
  for (const file of files) {
    const source = readFileSync(new URL(`../src/sim/${file}`, import.meta.url), 'utf8');
    assert.equal(forbiddenDeckRefs.test(source), false, `${file} 引用隐藏牌库字段，违反信息公平性约束`);
    assert.equal(engineLcgConstants.test(source), false, `${file} 出现正式引擎 LCG 常量，模拟随机流必须与真实牌库随机数隔离`);
    if (file !== 'index.ts') {
      assert.equal(runtimeAiImports.test(source), false, `${file} 存在对 src/ai 的运行时依赖（仅允许 import type）`);
    }
  }
  // 唯一允许的 ai 依赖：state.ts 的 import type AIObservation（类型层，零运行时）。
  const stateSource = readFileSync(new URL('../src/sim/state.ts', import.meta.url), 'utf8');
  assert.match(stateSource, /import type \{ AIObservation \} from '\.\.\/ai\/observation\.js';/);
});

test('静态扫描：src/ai 与正式入口不导入 sim 模块（正式 AI 行为保持不变）', () => {
  const aiDir = new URL('../src/ai/', import.meta.url);
  for (const file of readdirSync(aiDir).filter(f => f.endsWith('.ts'))) {
    const source = readFileSync(new URL(`../src/ai/${file}`, import.meta.url), 'utf8');
    assert.equal(/from\s+['"][^'"]*sim\//.test(source), false, `src/ai/${file} 导入了 sim 模块`);
  }
  const entry = readFileSync(new URL('../src/ai.ts', import.meta.url), 'utf8');
  assert.equal(/sim\//.test(entry), false, 'ai.ts 公共出口导入了 sim 模块');
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.equal(/sim\//.test(app), false, 'app.ts 导入了 sim 模块');
});
