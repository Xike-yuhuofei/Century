/** 公共模拟器 differential 测试装置（AI6 第二阶段·任务 E）。
 *
 * 职责：
 * - 构造"同一个合法完整世界"：真实游戏（engine）+ 公共模拟会话；
 * - 将真实剩余牌序仅作为测试预设条件注入模拟器（preset sampler）；
 * - 提供公开状态投影（有规则意义的全部公开字段的规范形）；
 * - 提供牌库多重集 oracle：真实剩余牌库 ≡ 模拟器未知卡集合（每步强制）；
 * - 以正式引擎为规则权威做双向对照（合法集一致 + 后继状态逐字段一致）；
 * - 差异时自动保存最小可复现局面（行动、种子、预设翻牌、差异字段）。
 *
 * 本文件仅服务于 tests/；生产 AI 代码的导入链不含本装置。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyAction, createGame, score as engineScore, ranking as engineRanking } from '../dist/js/engine.js';
import { MERCHANT_BY_ID } from '../dist/js/data.js';
import { buildObservation, chooseAIAction } from '../dist/js/ai.js';
import {
  createSimulation, enumerateLegalActions, mulberry32,
} from '../dist/js/sim/index.js';

export { mulberry32 };

/** 断言两个多重集一致（用于未知卡推导 vs 真实剩余牌库的独立 oracle）。 */
export function assertSameMultiset(actualUnseen, realDeck, label) {
  const a = [...actualUnseen].sort();
  const b = [...realDeck].sort();
  assert.deepEqual(a, b, `${label} 多重集不一致：公开推导 ${a.length} 张 vs 真实剩余 ${b.length} 张`);
}

/** 预设翻牌采样器：把真实剩余牌序注入模拟器（仅测试路径）。
 * 多重集校验使"公开信息推导遗漏卡牌"类缺陷在创建时即刻暴露。 */
export function presetSamplerFor(game) {
  const merchant = [...game.merchantDeck];
  const golem = [...game.golemDeck];
  return {
    sampleMerchantDeck(unseen) {
      assertSameMultiset(unseen, merchant, '预设商人牌序 vs 模拟器未知商人集合');
      return [...merchant];
    },
    sampleGolemDeck(unseen) {
      assertSameMultiset(unseen, golem, '预设魔像牌序 vs 模拟器未知魔像集合');
      return [...golem];
    },
  };
}

/** 公开状态投影：有规则意义的全部公开字段的规范形（固定键序，可直接 JSON 比对）。 */
export function publicProjection(source) {
  return {
    current: source.current,
    phase: source.phase,
    triggerPlayer: source.triggerPlayer,
    turnNumber: source.turnNumber,
    copper: source.copper,
    silver: source.silver,
    players: source.players.map(p => ({
      id: p.id,
      stock: [...p.stock],
      hand: [...p.hand],
      played: [...p.played],
      claimed: [...p.claimed],
      copper: p.copper,
      silver: p.silver,
      turns: p.turns,
    })),
    merchantMarket: source.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] })),
    golemMarket: [...source.golemMarket],
  };
}

export function gameProjection(game) {
  return publicProjection(buildObservation(game, game.current));
}

export function simProjection(sim) {
  return publicProjection(sim.view);
}

/** 独立 oracle：真实剩余牌库多重集必须等于模拟器未知卡集合。 */
export function assertDeckOracle(game, sim, label) {
  assertSameMultiset(sim.view.unseenMerchants, game.merchantDeck, `${label}·未知商人`);
  assertSameMultiset(sim.view.unseenGolems, game.golemDeck, `${label}·未知魔像`);
}

/** 从完整真实世界构造模拟会话（预设 = 真实剩余牌序）。 */
export function simulationFor(game) {
  return createSimulation(buildObservation(game, game.current), { sampler: presetSamplerFor(game) });
}

/** 差异转储：最小可复现局面（行动、种子、预设翻牌、双方状态与差异字段）。 */
export function dumpRepro(context) {
  try {
    mkdirSync(new URL('./test-outputs/', import.meta.url), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = new URL(`./test-outputs/public-sim-repro-${stamp}.json`, import.meta.url);
    writeFileSync(path, JSON.stringify(context, null, 2));
    console.error(`[public-sim] 差异转储已保存：${path.pathname}`);
  } catch (dumpError) {
    console.error('[public-sim] 差异转储保存失败：', dumpError);
  }
}

/** 逐字段比较投影，返回差异字段路径列表（用于报告与最小复现）。 */
export function diffProjection(engineProjection, simProjection) {
  const diffs = [];
  const walk = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}.${key}`);
      return;
    }
    diffs.push({ field: path, engine: a, sim: b });
  };
  walk(engineProjection, simProjection, '$');
  return diffs;
}

export function assertProjectionEqual(engineProj, simProj, context) {
  const diffs = diffProjection(engineProj, simProj);
  if (diffs.length) {
    dumpRepro({ ...context, diffs, engineAfter: engineProj, simAfter: simProj });
  }
  assert.equal(diffs.length, 0, `公共状态出现差异（${diffs.length} 处）：${JSON.stringify(diffs.slice(0, 5))}`);
}

/** 行动规范化：引擎接受若干"参数缺省形式"（升级卡 steps 缺省 = 空序列、
 * 交易卡 repeats 缺省 = 1），与显式形式后继逐位相同。合法集合比较按
 * 规范形进行（后继等价类口径）。 */
export function canonicalAction(action) {
  if (action.type === 'play') {
    const card = MERCHANT_BY_ID[action.cardId];
    if (card && card.kind === 'upgrade') {
      return { type: 'play', cardId: action.cardId, steps: [...(action.steps ?? [])] };
    }
    if (card && card.kind === 'trade') {
      return { type: 'play', cardId: action.cardId, repeats: action.repeats ?? 1 };
    }
    return { type: 'play', cardId: action.cardId };
  }
  return JSON.parse(JSON.stringify(action));
}

/** 行动规范化键（用于合法集合的双向比较；数组顺序保留语义）。 */
export function actionKey(action) {
  return JSON.stringify(canonicalAction(action));
}

/** 引擎侧全量合法行动集合（以正式引擎为 oracle 的独立枚举）：
 * 不复用模拟器枚举器的剪枝逻辑——按"候选宇宙 × 引擎接受"构造，
 * 与 src/sim/legal.ts 相互独立，可检测枚举器过严/过宽两个方向。 */
export function engineAcceptedActions(game) {
  const accepted = [];
  const tryAccept = (action) => {
    try {
      applyAction(game, action);
      accepted.push(action);
    } catch { /* 引擎拒绝 = 非法 */ }
  };
  const p = game.players[game.current];
  if (game.phase === 'overflow') {
    const excess = p.stock.reduce((s, v) => s + v, 0) - 10;
    // 弃置后继与顺序可证明无关（逐色扣减交换律）；超额颗数在真实合法局面中
    // 无上界（市场卡上奖励累积），有序宇宙是指数级的。因此 oracle 侧同样
    // 采用规范排序组合宇宙（多项式级），与模拟器枚举口径一致。
    const combos = [];
    const walk = (available, remaining, prefix, firstColor) => {
      if (remaining === 0) { combos.push([...prefix]); return; }
      for (let color = firstColor; color < 4; color++) {
        if (available[color] <= 0) continue;
        available[color]--;
        prefix.push(color);
        walk(available, remaining - 1, prefix, color);
        prefix.pop();
        available[color]++;
      }
    };
    walk([...p.stock], excess, [], 0);
    for (const colors of combos) tryAccept({ type: 'discard', colors });
    return accepted;
  }
  // 认领：全部位置。
  for (let index = 0; index < game.golemMarket.length; index++) tryAccept({ type: 'claim', index });
  // 打出：手牌唯一 id；升级全序列（0..steps 长度、每步 0–2）；交易 repeats 1..10。
  const seen = new Set();
  for (const cardId of p.hand) {
    if (seen.has(cardId)) continue;
    seen.add(cardId);
    tryAccept({ type: 'play', cardId });
    const card = MERCHANT_BY_ID[cardId];
    if (!card) continue;
    if (card.kind === 'upgrade') {
      const sequences = [];
      const walk = (prefix) => {
        sequences.push([...prefix]);
        if (prefix.length >= card.steps) return;
        for (let c = 0; c < 3; c++) { prefix.push(c); walk(prefix); prefix.pop(); }
      };
      walk([]);
      for (const steps of sequences) tryAccept({ type: 'play', cardId, steps });
    } else if (card.kind === 'trade') {
      for (let repeats = 1; repeats <= 10; repeats++) tryAccept({ type: 'play', cardId, repeats });
    }
  }
  // 休息：引擎无条件允许。
  tryAccept({ type: 'rest' });
  // 获取：每个位置 × 全部长度为 index 的颜色序列（4^index，无库存剪枝）。
  for (let index = 0; index < game.merchantMarket.length; index++) {
    const total = 4 ** index;
    for (let code = 0; code < total; code++) {
      const payment = [];
      let value = code;
      for (let i = 0; i < index; i++) { payment.push(value % 4); value = Math.floor(value / 4); }
      tryAccept({ type: 'acquire', index, payment });
    }
  }
  return accepted;
}

/** 引擎侧得分/名次（规则权威）。 */
export function engineScoreOf(game, playerId) {
  return engineScore(game.players[playerId]);
}

export function engineRankingOf(game) {
  return engineRanking(game).map(p => p.id);
}

/** 行动驱动器：driver(ctx) → Action；ctx = { game, sim, rng }。 */
export const drivers = {
  /** 全量合法集中均匀随机。 */
  random: (rng) => ({ sim }) => {
    const actions = enumerateLegalActions(sim.view);
    return actions[Math.floor(rng() * actions.length)];
  },
  /** 有魔像可认领就认领（快速到达终局/触发/结算路径），否则随机。 */
  greedyClaim: (rng) => ({ sim }) => {
    const actions = enumerateLegalActions(sim.view);
    const claims = actions.filter(a => a.type === 'claim');
    const pool = claims.length ? claims : actions;
    return pool[Math.floor(rng() * pool.length)];
  },
  /** 冻结冠军 AI 驱动（保证到达真实终局与结算；仅作测试驱动器使用）。 */
  ai: () => ({ game }) => chooseAIAction(game).action,
};

/** 单步对照：模式 B（持续会话）与模式 A（重建校验）均与引擎结果比对。
 * 返回 { comparisons, game }（game 为引擎下一状态，避免重复转移）。 */
export function compareSingleStep(game, simPersistent, action, context) {
  let comparisons = 0;
  const engineAfter = applyAction(game, action);
  const engineProj = gameProjection(engineAfter);

  // 模式 B：持续会话（队列连续性 + 未知集合随翻牌收缩）。
  simPersistent.step(action);
  assertProjectionEqual(engineProj, simProjection(simPersistent), { ...context, mode: 'B-persistent', action });
  assertDeckOracle(engineAfter, simPersistent, `${context.label}·模式B`);
  comparisons += 1;

  // 模式 A：从引擎下一状态重建会话，校验 builder 逐字段保真与预设注入。
  const simRebuilt = simulationFor(engineAfter);
  assertProjectionEqual(engineProj, simProjection(simRebuilt), { ...context, mode: 'A-rebuild', action, stage: 'build' });
  comparisons += 1;

  // 得分权威一致性（全席位，复用 engine.score）。
  for (const p of engineAfter.players) {
    assert.equal(simRebuilt.score(p.id), engineScoreOf(engineAfter, p.id), `${context.label} 得分不一致：玩家 ${p.id}`);
  }
  return { comparisons, game: engineAfter };
}

/** 一整局 differential playout（模式 B 持续 + 每步模式 A 重建校验 + 终局结算对照）。 */
export function runDifferentialPlayout({ playerCount, seed, driverName, maxSteps = 400 }) {
  const names = Array.from({ length: playerCount }, (_, i) => `玩家${i + 1}`);
  let game = createGame(names, seed);
  for (const p of game.players) p.isAI = true;
  const rng = mulberry32(seed * 7919 + playerCount * 104729 + 17);
  const driver = drivers[driverName](rng);
  const sim = simulationFor(game);
  const context = { label: `playout n=${playerCount} seed=${seed} driver=${driverName}`, playerCount, seed, driverName };
  let stepIndex = 0;
  let comparisons = 0;
  const actions = [];
  while (game.phase !== 'finished' && stepIndex < maxSteps) {
    const action = driver({ game, sim, rng });
    actions.push(JSON.parse(JSON.stringify(action)));
    const result = compareSingleStep(game, sim, action, { ...context, stepIndex });
    comparisons += result.comparisons;
    game = result.game;
    stepIndex += 1;
  }
  // 终局结算对照：得分与名次（含平分决胜语义）。
  assertProjectionEqual(gameProjection(game), simProjection(sim), { ...context, stepIndex, stage: 'final' });
  if (game.phase === 'finished') {
    assert.deepEqual(sim.ranking(), engineRankingOf(game), `${context.label} 最终名次不一致`);
  }
  return { comparisons, finished: game.phase === 'finished', steps: stepIndex, actions, game, sim, context };
}
