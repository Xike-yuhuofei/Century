/** AI7 C2/C4 引擎价值 V2 单元回归（独立测试）。
 *
 * 关键纪律（任务书 C2）：新评价函数不得"简单偏向所有创造卡"——
 * 重复收益必须同时受剩余回合、真实可用性与商队容量约束；容量已满或
 * 需要两次以上产出才能回本时不得加成。缺省参数（v1）逐位不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MERCHANT_BY_ID } from '../dist/js/data.js';
import { cardEngineValue, engineValue } from '../dist/js/ai/knowledge.js';
import {
  engineModelContext, cardEngineValueV2, engineValueV2, engineValueFor,
  acquisitionPaymentOpportunityCost, acquisitionRepeatDelta,
} from '../dist/js/ai/engine-model.js';
import { BASELINE_PARAMETERS, CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai.js';

const ENGINE_V2 = {
  ...CHAMPION_PARAMETERS,
  id: 'test-engine-v2',
  engineModel: 'v2',
  seatPolicy: 'flat',
};

/** 最小公开观察（只含 engineModelContext 消费的字段）。 */
function viewOf({ playerCount = 2, myClaims = 1, otherClaims = 1, turnsEach = 10 } = {}) {
  const players = Array.from({ length: playerCount }, (_, id) => ({
    id,
    claimed: Array(id === 0 ? myClaims : otherClaims).fill('G01'),
    turns: turnsEach,
  }));
  return {
    playerId: 0, current: 0, players, triggerPlayer: null,
    merchantMarket: [], golemMarket: [], copper: 0, silver: 0,
    phase: 'turn', turnNumber: turnsEach,
  };
}

const highTurns = () => engineModelContext(viewOf({ myClaims: 1, otherClaims: 1, turnsEach: 10 }), ENGINE_V2);
const lowTurns = () => engineModelContext(viewOf({ myClaims: 5, otherClaims: 4, turnsEach: 4 }), ENGINE_V2);

test('剩余回合估计：早期高、临终局低；只使用公开回合/认领数', () => {
  const high = highTurns();
  const low = lowTurns();
  assert.ok(high.remainingTurns >= 10, `早期剩余回合应充足，实际 ${high.remainingTurns}`);
  assert.ok(low.remainingTurns <= 3, `临终局剩余回合应收敛，实际 ${low.remainingTurns}`);
  assert.equal(high.seatPolicy, 'flat');
});

test('创造卡重复产出：受剩余回合约束，不是无条件加成', () => {
  const card = MERCHANT_BY_ID.M36; // 创造粉×1
  const stock = [0, 0, 0, 5];
  const high = cardEngineValueV2(card, stock, null, highTurns(), 2);
  const low = cardEngineValueV2(card, stock, null, lowTurns(), 2);
  const base = cardEngineValue(card, stock, null);
  assert.ok(high > base, `高剩余回合应体现重复产出：${high} vs ${base}`);
  assert.ok(low > base, '仍有 2 次可用产出时应保留部分价值');
  assert.ok(high > low, '剩余回合更少时重复价值应更低');
});

test('容量约束：商队已满或只能产出一次时不得加成（反"所有创造卡"偏向）', () => {
  const card = MERCHANT_BY_ID.M36;
  const full = [3, 3, 2, 2]; // 10 颗，无空间
  assert.equal(cardEngineValueV2(card, full, null, highTurns(), 2), cardEngineValue(card, full, null),
    '容量已满的创造卡不得获得重复加成');

  const yellow = MERCHANT_BY_ID.M39; // 创造黄×3（成长 3）
  const roomFive = [0, 0, 0, 5]; // 只剩 5 格：只能打 1 次
  assert.equal(cardEngineValueV2(yellow, roomFive, null, highTurns(), 2), cardEngineValue(yellow, roomFive, null),
    '只能产出一次的创造卡不得获得重复加成');

  const roomTen = [0, 0, 0, 0];
  assert.ok(cardEngineValueV2(yellow, roomTen, null, highTurns(), 2) > cardEngineValue(yellow, roomTen, null),
    '容量充足且多回合可用时应体现重复产出');
});

test('升级卡长期作用：有黄水晶且剩余回合充足才加成', () => {
  const upgrade = MERCHANT_BY_ID.M43;
  const withYellow = [2, 0, 0, 0];
  const withoutYellow = [0, 2, 0, 0];
  assert.ok(cardEngineValueV2(upgrade, withYellow, null, highTurns(), 2) > cardEngineValue(upgrade, withYellow, null));
  assert.equal(cardEngineValueV2(upgrade, withoutYellow, null, highTurns(), 2), cardEngineValue(upgrade, withoutYellow, null),
    '无黄水晶时升级卡的长期加成应为 0');
});

test('交易卡重复使用：可支付时高于不可支付（真实可用性）', () => {
  const trade = MERCHANT_BY_ID.M22; // 黄×3 → 绿×3
  const payable = [3, 0, 0, 0];
  const notPayable = [0, 3, 0, 0];
  const basePayable = cardEngineValue(trade, payable, null);
  const baseNot = cardEngineValue(trade, notPayable, null);
  const bonusPayable = cardEngineValueV2(trade, payable, null, highTurns(), 2) - basePayable;
  const bonusNot = cardEngineValueV2(trade, notPayable, null, highTurns(), 2) - baseNot;
  assert.ok(bonusPayable > 0);
  assert.ok(bonusPayable > bonusNot, `可支付时重复收益应更高：${bonusPayable} vs ${bonusNot}`);
});

test('获取支付机会成本：非黄支付计 1 分、黄支付计 0.5 分', () => {
  assert.equal(acquisitionPaymentOpportunityCost([3, 0, 0, 0], 3), 1.5);
  assert.equal(acquisitionPaymentOpportunityCost([0, 3, 0, 0], 3), 3);
  assert.equal(acquisitionPaymentOpportunityCost([2, 1, 0, 0], 0), 0);
});

test('获取重复增量：容量已满时为 0；缺省 v1 下不产生任何增量', () => {
  const state = { stock: [0, 0, 0, 5], hand: [], played: [] };
  const fullState = { stock: [3, 3, 2, 2], hand: [], played: [] };
  assert.ok(acquisitionRepeatDelta('M36', state, null, highTurns()) > 0);
  assert.equal(acquisitionRepeatDelta('M36', fullState, null, highTurns()), 0);
});

test('缺省 v1 与冻结 knowledge.engineValue 逐位一致', () => {
  const state = { stock: [1, 2, 1, 0], hand: ['M36', 'M43'], played: ['S01'] };
  const v1 = engineValue(state, null);
  assert.equal(engineValueFor(state, null, BASELINE_PARAMETERS, null), v1);
  assert.equal(engineValueFor(state, null, CHAMPION_PARAMETERS, null), v1);
  // 即使参数声明 v2，没有模型上下文也必须回退 v1（缺省零成本）。
  assert.equal(engineValueFor(state, null, ENGINE_V2, null), v1);
});

test('人数条件策略：stratified 只在 5 人局提高竞争折扣，且与 flat 可独立消融', () => {
  const paramsSeat = { ...ENGINE_V2, seatPolicy: 'stratified' };
  const ctx2 = engineModelContext(viewOf({ playerCount: 2 }), paramsSeat);
  const ctx5 = engineModelContext(viewOf({ playerCount: 5 }), paramsSeat);
  assert.equal(ctx2.competition, 1);
  assert.ok(ctx5.competition > 1.2, `5 人局竞争折扣应 >1.2，实际 ${ctx5.competition}`);
  const card = MERCHANT_BY_ID.M36;
  const stock = [0, 0, 0, 3];
  assert.ok(cardEngineValueV2(card, stock, null, ctx5, 2) < cardEngineValueV2(card, stock, null, ctx2, 2));
});

test('候选版本注册：js8/js8-seat 的配置身份显式区分，js5 保持 v1/flat', () => {
  const scenario = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../training/scenarios/data/scenarios.jsonl'), 'utf8')
    .split('\n').find(line => line.includes('"TS-2P-CON-001"')));
  const clone = () => {
    const g = structuredClone(scenario.engineState.position);
    for (const p of g.players) p.isAI = true;
    return g;
  };
  const opts = { workUnits: 32, worlds: 4, simSeed: 0, profile: NEUTRAL_PROFILE };
  const js5 = chooseJointAction(clone(), { ...opts, version: 'joint-js5' });
  const flat = chooseJointAction(clone(), { ...opts, version: 'joint-js8-engine' });
  const seat = chooseJointAction(clone(), { ...opts, version: 'joint-js8-engine-seat' });
  assert.equal(js5.config.engineModel, 'v1');
  assert.equal(js5.config.seatPolicy, 'flat');
  assert.equal(js5.config.championParametersId, 'joint-js5');
  assert.equal(flat.config.engineModel, 'v2');
  assert.equal(flat.config.seatPolicy, 'flat');
  assert.equal(flat.config.championParametersId, 'ai7-engine-v2');
  assert.equal(seat.config.engineModel, 'v2');
  assert.equal(seat.config.seatPolicy, 'stratified');
  assert.equal(seat.config.championParametersId, 'ai7-engine-v2-seat');
  assert.notEqual(flat.config.hash, seat.config.hash, '两个候选必须有不同的配置哈希');
  assert.notEqual(flat.config.hash, js5.config.hash);
});

test('引擎 V2 是同值域增强：整套引擎价值不低于 V1（只加显式重复项）', () => {
  const state = { stock: [1, 1, 1, 1], hand: ['M36', 'M43', 'M22'], played: ['S01', 'M35'] };
  const v1 = engineValue(state, null);
  const v2 = engineValueV2(state, null, highTurns());
  assert.ok(v2 >= v1, `v2 不应低于 v1：${v2} vs ${v1}`);
});
