/** 合法行动枚举正确性测试（任务书 6 / 14.P1）：
 * 1) 随机对局中每个决策点枚举出的每个候选，正式引擎必须全部接受；
 * 2) 枚举对同一公开观察完全确定（逐位相同）；
 * 3) 枚举是 AI 4.0 planner 候选集的超集（支付全排列 ⊇ 其 Top-3 近似）；
 * 4) 支付顺序差异被保留（同组合不同顺序 → 不同候选），且各自被引擎接受。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../../../../web-v1/dist/js/engine.js';
import { buildObservation, chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { actions as plannerActions, initialState as plannerState } from '../../../../web-v1/dist/js/ai/planner.js';
import { CHAMPION_PARAMETERS } from '../../../../web-v1/dist/js/ai.js';
import { enumerateCandidates, descriptorToEngineAction, paymentSequences, publicStateKey } from '../../bridge/action_enum.mjs';

const seatProfile = (seat) => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

/** 用冠军策略推进 n 步，返回（每步快照：当时局面 + 候选）。 */
function rollout(seed, steps, policy) {
  let game = createGame(Array.from({ length: 5 }, (_, i) => `席位${i}`), seed, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  const snapshots = [];
  for (let i = 0; i < steps && game.phase !== 'finished'; i++) {
    const view = buildObservation(game);
    const { candidates, stats } = enumerateCandidates(view, { maxCandidates: 512 });
    // applyAction 对输入局面是纯函数（克隆后修改），快照可安全留存原局面引用。
    snapshots.push({ game, view, candidates, stats });
    let action;
    if (policy === 'champion' || view.players[view.current].id !== 0) {
      action = chooseAIAction(game, { profile: seatProfile(game.current) }).action;
    } else {
      action = descriptorToEngineAction(candidates[(i * 7 + 3) % candidates.length]);
    }
    game = applyAction(game, action);
  }
  return { game, snapshots };
}

test('枚举的每个候选都被正式引擎接受（多种子 × 混合策略全程）', () => {
  for (const seed of [1, 42, 777, 20260321, 543210]) {
    const { game, snapshots } = rollout(seed, 400, 'mixed');
    for (const { game: at, candidates } of snapshots) {
      for (const d of candidates) {
        const action = descriptorToEngineAction(d);
        assert.doesNotThrow(() => applyAction(at, action),
          `seed=${seed} 候选 ${JSON.stringify(d)} 被引擎拒绝`);
      }
    }
    assert.ok(game.phase === 'finished' || snapshots.length >= 400 * 0.8, '对局应正常推进');
  }
});

test('枚举确定性：同一公开观察必得同一候选序列', () => {
  const { snapshots } = rollout(20260321, 120, 'champion');
  for (const { view, candidates } of snapshots) {
    const again = enumerateCandidates(view, { maxCandidates: 512 });
    assert.equal(JSON.stringify(again.candidates), JSON.stringify(candidates));
    assert.equal(publicStateKey(view), publicStateKey(view));
  }
});

test('枚举 ⊇ AI 4.0 planner 候选集（含支付全排列 ⊇ Top-3 近似）', () => {
  const { snapshots } = rollout(424242, 200, 'champion');
  const params = CHAMPION_PARAMETERS;
  for (const { view, candidates } of snapshots) {
    if (view.phase !== 'turn') continue;
    const state = plannerState(view);
    const theirs = plannerActions(state, null, false, params);
    const mine = new Set(candidates.map(JSON.stringify));
    for (const a of theirs) {
      if (a.type === 'rest' && view.players[view.current].played.length === 0) continue; // planner 的空 rest 兜底
      const desc = a.type === 'play'
        ? (a.steps ? ['U', a.cardId, a.steps] : a.repeats !== undefined ? ['T', a.cardId, a.repeats] : ['P', a.cardId])
        : a.type === 'acquire' ? ['A', a.index, a.payment]
        : a.type === 'claim' ? ['C', a.index]
        : ['R'];
      assert.ok(mine.has(JSON.stringify(desc)), `planner 候选 ${JSON.stringify(a)} 不在 AI5 枚举中`);
    }
  }
});

test('支付顺序保留：同组合不同顺序是不同候选且全部合法', () => {
  // 直接构造富库存局面（不依赖开局序列）：黄 3 绿 3，取位置 3（支付 3 颗）。
  let game = createGame(['a', 'b'], 7, [1]);
  game.players[0].isAI = true;
  game.players[0].stock = [3, 3, 0, 0];
  const view = buildObservation(game);
  assert.ok(view.merchantMarket.length > 3, '市场应有 ≥4 张商人卡');
  const seqs = paymentSequences(view.players[0].stock, 3);
  // 3 颗支付、库存含黄绿各 ≥2：不同顺序（如 [0,0,1] vs [0,1,0]）必须同时存在。
  assert.ok(seqs.some(s => JSON.stringify(s) === '[0,0,1]'));
  assert.ok(seqs.some(s => JSON.stringify(s) === '[0,1,0]'));
  assert.ok(new Set(seqs.map(s => s.join(''))).size > 1, '不应折叠为单一顺序');
  // 每个顺序都被引擎接受，且留下不同的市场奖励分布（顺序真实影响后继状态）。
  const seenBonuses = new Set();
  for (const payment of seqs) {
    const after = applyAction(game, { type: 'acquire', index: 3, payment });
    seenBonuses.add(JSON.stringify(after.merchantMarket.map(m => m.bonus.join(','))));
    assert.equal(after.players[0].hand.length, 3, '获取后手牌应增加');
  }
  assert.ok(seenBonuses.size > 1, '不同支付顺序必须产生不同后继市场奖励分布');
});

test('候选上限剪枝：fullCount/keptCount 如实上报且保留候选全部合法', () => {
  const { snapshots } = rollout(99, 150, 'champion');
  for (const { game: at, view, candidates, stats } of snapshots) {
    const { candidates: kept, stats: s2 } = enumerateCandidates(view, { maxCandidates: 8 });
    assert.equal(s2.fullCount, stats.fullCount);
    assert.equal(kept.length, s2.keptCount);
    if (s2.pruned) {
      const nonAcquire = candidates.filter(c => c[0] !== 'A').length;
      assert.ok(s2.keptCount <= Math.max(8, nonAcquire), '剪枝后应 ≤ 上限与不可剪部分之和');
      // 剪枝只允许裁掉 acquire 支付排列。
      assert.ok(kept.filter(c => c[0] !== 'A').length >= Math.min(nonAcquire, 8));
    }
    // 保留候选（含升序规范支付）仍然全部合法。
    for (const d of kept) {
      assert.doesNotThrow(() => applyAction(at, descriptorToEngineAction(d)),
        `剪枝保留候选 ${JSON.stringify(d)} 被引擎拒绝`);
    }
  }
});
