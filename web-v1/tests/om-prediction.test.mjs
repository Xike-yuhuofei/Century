/** 对手意图 / 认领 ETA / 目标存活预测测试（AI6 第三阶段·任务 C/D/E）。
 *
 * 验收口径：
 * - 意图为软概率 + 不确定性（禁止"库存接近 ⇒ 确定追逐"硬判定）；
 * - 风格混合：先验归一；历史证据可更新（rush 证据 → rush 权重上升）；
 * - ETA：最早规则可达时间与概率分布严格分离；删失与竞争事件显式处理；
 * - Survival：k=0 决定性；条件存活非增；竞争相依（唯一认领者语义）；
 * - 目标 ETA 随公开事件更新；
 * - 全接口概率无负数 / NaN / 超 1。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction, buildObservation } from '../dist/js/ai.js';
import { GOLEM_BY_ID } from '../dist/js/data.js';
import {
  buildPublicSimState, createEmptyHistory, appendEvent, derivePublicEvent,
  snapshotFromObservation, enumerateLegalActions,
} from '../dist/js/sim/index.js';
import { createOpponentModel, STYLE_KEYS } from '../dist/js/om/index.js';

function midgameState(seatCount, seed, steps = 24) {
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  for (let i = 0; i < steps && game.phase !== 'finished'; i++) {
    const { action } = chooseAIAction(game);
    game = applyAction(game, action);
  }
  return buildPublicSimState(buildObservation(game, game.current));
}

function assertProbabilityVector(values, label) {
  for (const v of values) {
    assert.ok(Number.isFinite(v), `${label} 出现非有限值`);
    assert.ok(v >= 0 && v <= 1, `${label} 越界：${v}`);
  }
}

test('任务C：意图为软概率——高覆盖度不产生确定性追逐判定', () => {
  const game = createGame(['A', 'B', 'C'], 111, [1, 2]);
  game.players[0].isAI = true;
  // 席位 1 库存恰好覆盖 G01 费用 [2,1,0,1]（高覆盖 ≠ 确定意图）。
  game.players[1].stock = [2, 1, 0, 1];
  game.golemMarket = ['G01', 'G02', 'G03', 'G04', 'G05'];
  game.current = 2;
  const state = buildPublicSimState(buildObservation(game, game.current));
  const model = createOpponentModel({ seed: 1, rollouts: 6 });
  const intent = model.predictIntent(state, 1);
  assertProbabilityVector(intent.golems.map(e => e.p), 'intent.p');
  assert.ok(intent.noSpecificTarget >= 0 && intent.noSpecificTarget <= 1);
  const mass = intent.golems.reduce((s, e) => s + e.p, 0) + intent.noSpecificTarget;
  assert.ok(Math.abs(mass - 1) < 1e-6, `意图总质量偏离 1：${mass}`);
  // 纪律约束：即便库存完全匹配，单一目标概率不得宣称确定（软概率上限）。
  const top = intent.golems.reduce((b, e) => (e.p > b.p ? e : b), intent.golems[0]);
  assert.ok(top.p < 0.95, `意图出现硬判定：p=${top.p}`);
  assert.ok(intent.uncertainty >= 0 && intent.uncertainty <= 1);
  // 高覆盖目标应是概率最高的候选之一（方向正确但保持软性）。
  assert.equal(top.golemId, 'G01');
});

test('任务C：风格先验归一；rush 证据经公开历史提升 rush 权重', () => {
  const state = midgameState(3, 222);
  const model = createOpponentModel({ seed: 1, rollouts: 4 });
  const prior = model.predictIntent(state, 0);
  const priorSum = STYLE_KEYS.reduce((s, k) => s + prior.style[k], 0);
  assert.ok(Math.abs(priorSum - 1) < 1e-9, `风格先验未归一：${priorSum}`);

  // 构造 rush 风格历史：席位 1 连续早期认领两枚魔像。
  const history = createEmptyHistory(3, { origin: 'recorded' });
  const fakeEvents = [
    { kind: 'claim', actor: 1, turn: 3, round: 1, phase: 'turn', endgame: false, index: 0, golemId: 'G08', points: 6, cost: [2, 2, 0, 0], coin: null, stock: { before: [2, 2, 0, 0], after: [0, 0, 0, 0] }, hand: { removed: [], added: [] }, played: { removed: [], added: [] }, golemRemoved: 'G08', golemAdded: null, triggersEnd: false, copperBefore: 6, copperAfter: 5, silverBefore: 6, silverAfter: 6 },
    { kind: 'claim', actor: 1, turn: 9, round: 3, phase: 'turn', endgame: false, index: 0, golemId: 'G34', points: 7, cost: [3, 2, 0, 0], coin: null, stock: { before: [3, 2, 0, 0], after: [0, 0, 0, 0] }, hand: { removed: [], added: [] }, played: { removed: [], added: [] }, golemRemoved: 'G34', golemAdded: null, triggersEnd: false, copperBefore: 5, copperAfter: 4, silverBefore: 6, silverAfter: 6 },
  ];
  for (const e of fakeEvents) appendEvent(history, e);
  const rushed = model.predictIntent(state, 1, history);
  assert.ok(rushed.style.rush > prior.style.rush + 0.05, `rush 证据未提升 rush 权重：${prior.style.rush} → ${rushed.style.rush}`);
  const rushedSum = STYLE_KEYS.reduce((s, k) => s + rushed.style[k], 0);
  assert.ok(Math.abs(rushedSum - 1) < 1e-9);
  assert.ok(rushed.styleEvidence.rush > 0, 'rush 证据应为正');
});

test('任务C：目标 ETA/意图随公开事件更新（历史特征产生可验证差异）', () => {
  let game = createGame(['A', 'B', 'C'], 333, [1, 2]);
  game.players[0].isAI = true;
  for (let i = 0; i < 16; i++) { const { action } = chooseAIAction(game); game = applyAction(game, action); }
  const state = buildPublicSimState(buildObservation(game, game.current));
  const opponent = (state.current + 1) % state.playerCount;
  // 目标 = 该对手当前最可能追逐的魔像（argmax p；保证其覆盖度非零、意图未被钳在下限）。
  const model0 = createOpponentModel({ seed: 2, rollouts: 8, useHistoryStyle: false });
  const neutral0 = createEmptyHistory(state.playerCount, { origin: 'recorded' });
  appendEvent(neutral0, {
    kind: 'rest', actor: (opponent + 1) % state.playerCount, turn: 2, round: 1, phase: 'turn', endgame: false,
    hand: { removed: [], added: [] }, played: { removed: [], added: [] },
  });
  const probe = model0.predictIntent(state, opponent, neutral0);
  const target = probe.golems.reduce((b, e) => (e.p > b.p ? e : b), probe.golems[0]).golemId;
  assert.ok(target, '市场应有魔像');
  // 隔离口径：关闭风格更新（useHistoryStyle=false），使"历史匹配事件"成为唯一差异。
  const model = createOpponentModel({ seed: 2, rollouts: 8, useHistoryStyle: false });
  const pOf = (intent, gid) => intent.golems.find(e => e.golemId === gid)?.p ?? 0;

  // 中性基线历史：仅含与目标无关的他人休息事件（origin=recorded，非空但无匹配证据）。
  const neutral = createEmptyHistory(state.playerCount, { origin: 'recorded' });
  appendEvent(neutral, {
    kind: 'rest', actor: (opponent + 1) % state.playerCount, turn: 2, round: 1, phase: 'turn', endgame: false,
    hand: { removed: [], added: [] }, played: { removed: [], added: [] },
  });
  const before = model.predictIntent(state, opponent, neutral);

  // 变体：同基线 + 该对手一次朝目标费用方向的产出事件（公开事件口径）。
  const withMatch = createEmptyHistory(state.playerCount, { origin: 'recorded' });
  appendEvent(withMatch, neutral.window[0]);
  const golemCost = GOLEM_BY_ID[target].cost;
  const gain = golemCost.map(n => Math.min(n, 2));
  appendEvent(withMatch, {
    kind: 'play', actor: opponent, turn: 3, round: 1, phase: 'turn', endgame: false,
    cardId: 'M38', steps: [], repeats: null,
    stock: { before: [1, 1, 1, 1], after: [1 + gain[0], 1 + gain[1], 1 + gain[2], 1 + gain[3]] },
    hand: { removed: ['M38'], added: [] }, played: { removed: [], added: ['M38'] },
  });
  const after = model.predictIntent(state, opponent, withMatch);
  assert.ok(
    pOf(after, target) > pOf(before, target),
    `公开事件未提升目标意图：${pOf(before, target).toFixed(4)} → ${pOf(after, target).toFixed(4)}`,
  );
});

test('任务D：ETA 分布与最早规则可达时间分离；概率约束与删失处理正确', () => {
  const model = createOpponentModel({ seed: 3, rollouts: 16 });
  // 情形 1：对手 P1 可立即认领（P0 无法支付、不会先抢）→ earliest = 1，主质量在 k=1。
  const game1 = createGame(['A', 'B'], 444, [1]);
  game1.players[0].isAI = true;
  game1.players[1].isAI = true;
  game1.players[0].stock = [0, 0, 0, 0];
  game1.players[1].stock = [2, 1, 0, 1];
  game1.golemMarket = ['G01', 'G02', 'G03', 'G04', 'G05'];
  game1.current = 0; // P0 先行动但无法认领；P1 的下一次自身行动即可认领
  const s1 = buildPublicSimState(buildObservation(game1, game1.current));
  const eta1 = model.predictClaimETA(s1, 1, 'G01');
  assert.equal(eta1.earliestRuleEstimate, 1, '可立即认领时最早规则可达时间应为 1');
  assertProbabilityVector(eta1.pClaimAt, 'eta1.pClaimAt');
  let cdf = 0;
  for (const c of eta1.cumulative) { assert.ok(c >= cdf - 1e-9, 'CDF 必须单调非减'); cdf = c; }
  assert.ok(eta1.pClaimAt[0] > 0.3, `可立即认领的对手在第 1 次自身行动认领概率过低：${eta1.pClaimAt[0]}`);
  assert.ok(Math.abs(eta1.cumulative[eta1.cumulative.length - 1] + eta1.pBeyond - 1) < 1e-9, 'CDF + pBeyond 必须为 1');
  assert.ok(eta1.samples > 0, 'samples 必须披露');

  // 情形 2：目标不在市场 → 全部质量归窗口外。
  const eta2 = model.predictClaimETA(s1, 1, 'G36');
  assert.equal(eta2.earliestRuleEstimate, null);
  assert.equal(eta2.pBeyond, 1);
  assert.equal(eta2.earliestRuleBlockedBy, 'stolen');

  // 情形 3：当前席位自己可立即认领——k=1 即行动时点。
  const game3 = createGame(['A', 'B'], 445, [1]);
  game3.players[0].isAI = true;
  game3.players[1].isAI = true;
  game3.players[0].stock = [2, 1, 0, 1];
  game3.players[1].stock = [0, 0, 0, 0];
  game3.golemMarket = ['G01', 'G02', 'G03', 'G04', 'G05'];
  game3.current = 0;
  const sNow = buildPublicSimState(buildObservation(game3, 0));
  const etaNow = model.predictClaimETA(sNow, 0, 'G01');
  assert.equal(etaNow.earliestRuleEstimate, 1);
  assert.ok(etaNow.pClaimAt[0] > 0.4, `当前席位立即认领概率过低：${etaNow.pClaimAt[0]}`);
  // 当前席位立即行动且可认领：第一时点存活恒为 1（尚未发生的对手行动不得计入）。
  const surv = model.predictSurvival(sNow, 'G01');
  assert.equal(surv.pPresentAt[0], 1);
  assert.equal(surv.pPresentAt[1], 1, '观察席位=当前席位：第一次自身行动前不可能有对手行动');
});

test('任务E：目标存活——按座位顺序竞争（座位劣势降低存活）', () => {
  // 3 人局：P0/P1 都恰好可支付 G01；观察席位不同 ⇒ 抢牌风险不同。
  const makeGame = () => {
    const game = createGame(['A', 'B', 'C'], 555, [1, 2]);
    game.players[0].isAI = true;
    game.players[1].isAI = true;
    game.players[2].isAI = true;
    game.players[0].stock = [2, 1, 0, 1];
    game.players[1].stock = [2, 1, 0, 1];
    game.players[2].stock = [0, 0, 0, 0];
    game.golemMarket = ['G01', 'G02', 'G03', 'G04', 'G05'];
    game.current = 0;
    return game;
  };
  const model = createOpponentModel({ seed: 6, rollouts: 24 });
  const sV0 = buildPublicSimState(buildObservation(makeGame(), 0));
  const sV2 = buildPublicSimState(buildObservation(makeGame(), 2));
  // viewer=0：当前行动者，k=1 前无对手行动。
  const surv0 = model.predictSurvival(sV0, 'G01', 2);
  assert.equal(surv0.pPresentAt[1], 1);
  // viewer=2：P0、P1 都先行动且都能认领 → k=1 时目标大概率已易主。
  const surv2 = model.predictSurvivalFor(sV2, 'G01', 2, 2);
  assert.ok(surv2.pPresentAt[1] < 0.8, `后位观察者存活概率未反映抢牌风险：${surv2.pPresentAt[1]}`);
  assert.ok(surv2.pPresentAt[1] < surv0.pPresentAt[1]);
  // 竞争相依：两个可认领对手的抢牌概率语义 = 唯一认领者（各自 pClaimWithin 之和 ≤ 1）。
  const sumRival = surv2.perRival.reduce((s, r) => s + r.pClaimWithin, 0);
  assert.ok(sumRival <= 1 + 1e-9, `对手抢牌概率之和超过唯一认领者语义：${sumRival}`);
  assertProbabilityVector(surv2.pPresentAt, 'surv2.pPresentAt');
  // 联合量（事件嵌套）必须非增；条件量允许队列选择效应的小幅容差。
  for (let k = 1; k < surv2.jointReachPresent.length; k++) {
    assert.ok(surv2.jointReachPresent[k] <= surv2.jointReachPresent[k - 1] + 1e-9, `联合存活应在 k=${k} 非增`);
  }
  for (let k = 1; k < surv2.pPresentAt.length; k++) {
    assert.ok(surv2.pPresentAt[k] <= surv2.pPresentAt[k - 1] + 0.2, `条件存活异常上升：k=${k}`);
  }
});

test('任务E：终局只剩当前整轮时未来决策点消失（reachRate 如实披露）', () => {
  const game = createGame(['A', 'B'], 666, [1]);
  game.players[0].isAI = true;
  game.players[1].isAI = true;
  game.triggerPlayer = 1;
  game.current = 1;
  game.golemMarket = ['G01', 'G02', 'G03', 'G04', 'G05'];
  const state = buildPublicSimState(buildObservation(game, game.current));
  const model = createOpponentModel({ seed: 7, rollouts: 12 });
  const surv = model.predictSurvival(state, 'G01', 3);
  // 终局整轮最多每人 1 次行动（加弃置），k=3 的决策点大概率不存在。
  assert.ok(surv.reachRate[3] < 1, `终局整轮内不应稳定到达第 3 次自身行动：${surv.reachRate[3]}`);
  assertProbabilityVector(surv.pPresentAt, 'surv.pPresentAt');
});

test('全接口概率卫生：无负数 / NaN / 超 1（多座位 × 多目标 × 多配置扫描）', () => {
  // 概率字段白名单（逐名核查，避免 explain 等非概率字段误报）。
  const PROB_KEYS = new Set(['p', 'noSpecificTarget', 'uncertainty', 'pBeyond', 'pStolenBefore', 'pGameEnded', 'pClaimWithin']);
  const PROB_ARRAY_KEYS = new Set(['pClaimAt', 'cumulative', 'pPresentAt', 'reachRate', 'jointReachPresent']);
  for (const seatCount of [2, 3, 4, 5]) {
    const state = midgameState(seatCount, 777 + seatCount, 30);
    const model = createOpponentModel({ seed: 8, rollouts: 8 });
    const payloads = [
      ['action', model.predictAction(state, state.current)],
      ['intent', model.predictIntent(state, (state.current + 1) % seatCount)],
      ...state.golemMarket.map(gid => ['eta', model.predictClaimETA(state, (state.current + 1) % seatCount, gid)]),
      ...state.golemMarket.map(gid => ['survival', model.predictSurvival(state, gid)]),
    ];
    for (const [name, payload] of payloads) {
      const scan = (obj, path) => {
        if (obj === null || obj === undefined) return;
        if (Array.isArray(obj)) {
          if (PROB_ARRAY_KEYS.has(path.split('.').pop())) {
            for (const v of obj) {
              assert.ok(Number.isFinite(v), `${name}${path} 非有限`);
              assert.ok(v >= -1e-12 && v <= 1 + 1e-12, `${name}${path} 越界：${v}`);
            }
          } else {
            obj.forEach((v, i) => scan(v, `${path}[${i}]`));
          }
          return;
        }
        if (typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if (k === 'style') {
              for (const sv of Object.values(v)) {
                assert.ok(Number.isFinite(sv) && sv >= 0 && sv <= 1, `${name}${path}.style 越界：${sv}`);
              }
              continue;
            }
            if (PROB_KEYS.has(k)) {
              assert.ok(Number.isFinite(v), `${name}${path}.${k} 非有限`);
              assert.ok(v >= -1e-12 && v <= 1 + 1e-12, `${name}${path}.${k} 越界：${v}`);
            } else {
              scan(v, `${path}.${k}`);
            }
          }
        }
      };
      scan(payload, '');
    }
  }
});
