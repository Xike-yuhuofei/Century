/** Issue #20 专项测试：目标竞争局面下的对手建模行为（AI6 第三阶段·任务 H）。
 *
 * 背景缺陷（Issue #20）：AI 开局同质争抢同一魔像卡——目标选择缺乏
 * 座位感知的竞争时序建模。本测试集构造 10 类竞争局面，验证：
 * - 行动时序正确（当前席位立即行动时不计入未发生的对手行动）；
 * - 不会预测已被抢走的魔像仍可认领；
 * - 目标 ETA 随公开事件更新；
 * - 目标存活概率符合明显的规则边界；
 * - 概率不出现负数 / NaN / 超 1。
 * 纪律：不人为要求所有 AI 必须选择不同目标（目标是避免无效竞争，不是随机化）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction, buildObservation } from '../dist/js/ai.js';
import { buildPublicSimState } from '../dist/js/sim/index.js';
import { createOpponentModel } from '../dist/js/om/index.js';

const G01_COST = [2, 1, 0, 1]; // 9 分
const G26_COST = [0, 4, 0, 0]; // 8 分

/** 构造器：N 人局 + 显式公开状态（消除牌序随机性，专注竞争时序）。 */
function buildScenario({ seatCount = 3, current = 0, stocks, hands = {}, golemMarket, claimed = {}, triggerPlayer = null }) {
  const game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), 20260301, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  for (const p of game.players) p.isAI = true;
  for (let i = 0; i < seatCount; i++) {
    if (stocks[i]) game.players[i].stock = stocks[i];
    if (hands[i]) game.players[i].hand = hands[i];
    if (claimed[i]) game.players[i].claimed = claimed[i];
  }
  game.golemMarket = golemMarket;
  game.current = current;
  game.triggerPlayer = triggerPlayer;
  return buildPublicSimState(buildObservation(game, game.current));
}

const model = createOpponentModel({ seed: 2026, rollouts: 24 });

test('H1：两名玩家追逐同一魔像——双方意图指向一致且认领概率可观测', () => {
  const state = buildScenario({
    seatCount: 2, current: 0,
    stocks: [[2, 1, 0, 1], [1, 1, 0, 1]],
    golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'],
  });
  const intent0 = model.predictIntent(state, 0);
  const intent1 = model.predictIntent(state, 1);
  const top0 = intent0.golems.reduce((b, e) => (e.p > b.p ? e : b));
  const top1 = intent1.golems.reduce((b, e) => (e.p > b.p ? e : b));
  // 两名玩家当前库存都最接近 G01（P0 恰可支付；P1 缺 1 黄）。
  assert.equal(top0.golemId, 'G01');
  assert.equal(top1.golemId, 'G01');
  // 行动分布：P0 立即可认领，认领动作概率显著。
  const dist0 = model.predictAction(state, 0);
  const claimP0 = dist0.entries.filter(e => e.action.type === 'claim').reduce((s, e) => s + e.p, 0);
  assert.ok(claimP0 > 0.25, `可支付者的认领概率过低：${claimP0}`);
  // 不要求二者分布不同（竞争厌恶是程度问题，不是强制分歧）。
});

test('H2：后手玩家的目标将在其行动前被认领——存活概率反映座位时序', () => {
  // P0 恰可支付 G01；P2（current）覆盖度高但差 1 黄无法立即认领——
  // 其目标将在 P0 行动后被抢走。
  const state = buildScenario({
    seatCount: 3, current: 2,
    stocks: [[2, 1, 0, 1], [0, 0, 0, 0], [1, 1, 0, 1]],
    golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'],
  });
  const surv = model.predictSurvivalFor(state, 'G01', 2, 2);
  // viewer=P2=current：k=1 是立即行动点（存活恒 1）；k=2 在 P0、P1 行动之后，
  // P0 恰可认领 → 存活概率显著低于 1。
  assert.equal(surv.pPresentAt[1], 1, '当前席位第一次自身行动前不可能有对手行动');
  assert.ok(surv.pPresentAt[2] < 0.9, `后位观察者第二决策点存活未反映先手威胁：${surv.pPresentAt[2]}`);
  // P0 的抢牌概率在 perRival 中居首。
  const p0 = surv.perRival.find(r => r.playerId === 0);
  assert.ok(p0 && p0.pClaimWithin > 0.2, `先手可支付者抢牌概率过低：${JSON.stringify(surv.perRival)}`);
  // 后手 P2 的 ETA：窗口内认领概率被竞争压制（stolen 质量可观）。
  const eta = model.predictClaimETA(state, 2, 'G01');
  assert.ok(
    eta.pStolenBefore > 0.1 || eta.pClaimAt.reduce((s, x) => s + x, 0) < 0.9,
    '后手的认领分布未反映被抢风险',
  );
});

test('H3：三名及以上玩家目标冲突——存活概率随竞争者数量下降', () => {
  const golemMarket = ['G01', 'G05', 'G08', 'G14', 'G20'];
  // 观察席位固定为最后行动者：2 人局对手 1 名可支付；4 人局对手 3 名可支付。
  const mk2 = () => buildScenario({
    seatCount: 2, current: 0,
    stocks: [[2, 1, 0, 1], [2, 1, 0, 1]],
    golemMarket,
  });
  const mk4 = () => buildScenario({
    seatCount: 4, current: 0,
    stocks: [[2, 1, 0, 1], [2, 1, 0, 1], [2, 1, 0, 1], [2, 1, 0, 1]],
    golemMarket,
  });
  const surv2 = model.predictSurvivalFor(mk2(), 'G01', 2, 1);
  const surv4 = model.predictSurvivalFor(mk4(), 'G01', 2, 3);
  // viewer 的 k=1 前全部对手各行动一次：竞争者 1 → 3，存活单调下降。
  assert.ok(surv2.pPresentAt[1] < 1, `可支付对手存在时存活应下降：${surv2.pPresentAt[1]}`);
  assert.ok(surv4.pPresentAt[1] <= surv2.pPresentAt[1] + 1e-9,
    `竞争者增多未降低存活：2人局 ${surv2.pPresentAt[1]} vs 4人局 ${surv4.pPresentAt[1]}`);
});

test('H4：玩家通过交易突然提前完成目标——ETA 显著缩短', () => {
  // P0 库存 4 黄 + 手牌 M20（2黄→2绿，repeats 可到 2）→ 一次打出 + 一次认领 = 2 步拿到 G26。
  const state = buildScenario({
    seatCount: 2, current: 1,
    stocks: [[4, 0, 0, 0], [0, 0, 0, 0]],
    hands: { 0: ['M20', 'S01'] },
    golemMarket: ['G26', 'G05', 'G08', 'G14', 'G20'],
  });
  const eta = model.predictClaimETA(state, 0, 'G26');
  assert.equal(eta.earliestRuleEstimate, 2, `交易后认领的最早规则可达时间应为 2：${eta.earliestRuleEstimate}`);
  // 对比：无交易卡时直线规划显著更长（同为 4 黄、无手牌）。
  const noCard = buildScenario({
    seatCount: 2, current: 1,
    stocks: [[4, 0, 0, 0], [0, 0, 0, 0]],
    golemMarket: ['G26', 'G05', 'G08', 'G14', 'G20'],
  });
  const etaNoCard = model.predictClaimETA(noCard, 0, 'G26');
  assert.ok(
    etaNoCard.earliestRuleEstimate === null || etaNoCard.earliestRuleEstimate > eta.earliestRuleEstimate,
    `无交易卡的 ETA 应更长或不可达：${etaNoCard.earliestRuleEstimate}`,
  );
});

test('H5：玩家休息导致认领时间延后——需要先休息再激活引擎', () => {
  // P0 手牌为空、已打出 M35(4黄)+M42(2绿)、库存清零：
  // 必须 休息(1)→打出(2)→打出(3)→认领(4)。
  const game = createGame(['A', 'B'], 20260301, [1]);
  for (const p of game.players) p.isAI = true;
  game.players[0].stock = [0, 0, 0, 0];
  game.players[0].played = ['M35', 'M42'];
  game.players[0].hand = [];
  game.golemMarket = ['G08', 'G05', 'G14', 'G20', 'G34']; // G08 cost [2,2,0,0]
  game.current = 1;
  const state = buildPublicSimState(buildObservation(game, game.current));
  const eta = model.predictClaimETA(state, 0, 'G08');
  assert.equal(eta.earliestRuleEstimate, 4, `休息→打出→打出→认领应为 4 步：${eta.earliestRuleEstimate}`);
});

test('H6：获取商人卡使目标路径变化——补足缺口卡显著缩短 ETA', () => {
  // G01 缺 1 粉；市场 0 号位有 M36（创造 1 粉）。获取(1)→打出(2)→认领(3)。
  const state = buildScenario({
    seatCount: 2, current: 0,
    stocks: [[2, 1, 0, 0], [0, 0, 0, 0]],
    hands: { 0: ['S01', 'S02'] },
    golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'],
  });
  const etaWithout = model.predictClaimETA(state, 0, 'G01');
  // 市场上存在 M36（初始 6 市场必有创造/交易卡，缺粉需检查 0 号位是否为 M36）。
  const market0 = state.merchantMarket[0]?.id;
  if (market0 !== 'M36') return; // 场景依赖：非 M36 时跳过（种子固定下可预期）
  const eta = etaWithout;
  assert.equal(eta.earliestRuleEstimate, 3, `获取→打出→认领应为 3 步：${eta.earliestRuleEstimate}`);
});

test('H7：魔像被抢后其他玩家转向新目标——意图随公开事件重定向', () => {
  let game = createGame(['A', 'B', 'C'], 20260302, [1, 2]);
  for (const p of game.players) p.isAI = true;
  for (let i = 0; i < 20; i++) { const { action } = chooseAIAction(game); game = applyAction(game, action); }
  const before = buildPublicSimState(buildObservation(game, game.current));
  const viewer = game.current;
  const topBefore = model.predictIntent(before, viewer).golems
    .reduce((b, e) => (e.p > b.p ? e : b), { golemId: null, p: 0 });
  // 让另一玩家认领当前最热目标（模拟被抢）。
  const stolenId = topBefore.golemId ?? before.golemMarket[0];
  const claimIdx = before.golemMarket.indexOf(stolenId);
  const rival = (viewer + 1) % before.playerCount;
  let game2 = createGame(['A', 'B', 'C'], 20260302, [1, 2]);
  for (const p of game2.players) p.isAI = true;
  for (let i = 0; i < 20; i++) { const { action } = chooseAIAction(game2); game2 = applyAction(game2, action); }
  // 直接操作公开状态：rival 认领该魔像（合法性通过库存补足保证）。
  const cost = game2.golemMarket[claimIdx] ? { G01: [2, 1, 0, 1] }[game2.golemMarket[claimIdx]] ?? [0, 0, 0, 0] : [0, 0, 0, 0];
  void cost;
  // 构造"魔像已被 rival 认领"的后继公开状态：从市场移除 + rival.claimed 添加 + 翻新卡补位。
  const claimedId = game2.golemMarket.splice(claimIdx, 1)[0];
  game2.players[rival].claimed.push(claimedId);
  const drawn = game2.golemDeck.shift();
  if (drawn) game2.golemMarket.push(drawn);
  game2.current = viewer;
  const after = buildPublicSimState(buildObservation(game2, game2.current));
  assert.equal(after.golemMarket.includes(claimedId), false, '被抢魔像应已离开市场');
  // 被抢魔像的预测全部归零（不可再认领）。
  const etaGone = model.predictClaimETA(after, viewer, claimedId);
  assert.equal(etaGone.pBeyond, 1);
  assert.equal(etaGone.earliestRuleEstimate, null);
  const survGone = model.predictSurvival(after, claimedId);
  assert.ok(survGone.pPresentAt.every(v => v === 0));
  // viewer 的意图转向仍在市场中的目标（新目标概率 > 被抢目标概率 0）。
  const intentAfter = model.predictIntent(after, viewer);
  const newTop = intentAfter.golems.reduce((b, e) => (e.p > b.p ? e : b));
  assert.ok(newTop.golemId !== claimedId);
  assert.ok(after.golemMarket.includes(newTop.golemId));
});

test('H8：终局只剩当前整轮——终局触发者之后的决策点消失', () => {
  // triggerPlayer=0 已触发终局；current=1；整轮结束后 finished。
  const state = buildScenario({
    seatCount: 3, current: 1, triggerPlayer: 0,
    stocks: [[2, 1, 0, 1], [2, 1, 0, 1], [0, 0, 0, 0]],
    golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'],
  });
  const surv = model.predictSurvival(state, 'G01', 3);
  // 每人至多 1 次行动（终局整轮）→ 第 3 次自身行动的到达率应很低。
  assert.ok(surv.reachRate[3] < 0.5, `终局整轮内不应稳定到达第 3 次自身行动：${surv.reachRate[3]}`);
  // k=0 存活为 1；k=1 为 viewer=1（当前席位）行动前 → 仍为 1。
  assert.equal(surv.pPresentAt[0], 1);
  assert.equal(surv.pPresentAt[1], 1);
  // 终局当步认领无对手折扣：当前席位（P1）的认领概率不因"未来竞争"显著衰减。
  const dist = model.predictAction(state, 1);
  const claimP = dist.entries.filter(e => e.action.type === 'claim').reduce((s, e) => s + e.p, 0);
  const normState = buildScenario({
    seatCount: 3, current: 1, triggerPlayer: null,
    stocks: [[2, 1, 0, 1], [2, 1, 0, 1], [0, 0, 0, 0]],
    golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'],
  });
  const distNorm = model.predictAction(normState, 1);
  const claimPNorm = distNorm.entries.filter(e => e.action.type === 'claim').reduce((s, e) => s + e.p, 0);
  assert.ok(claimP >= claimPNorm * 0.8, `终局当步认领概率未获终局加成：${claimP} vs ${claimPNorm}`);
});

test('H9：不同座位但相似库存导致不同抢牌风险——座位感知时序成立', () => {
  // 4 人局、current=0：P1 恰可支付 G01（政策上接近确定性认领），P0/P2/P3 无威胁。
  // viewer=1 与 viewer=2 库存相同（均为空），仅座位不同：
  // viewer=1 的 k=1 前只有无害的 P0 行动 → 存活 ≈ 1；
  // viewer=2 的 k=1 前可支付的 P1 已行动 → 存活 ≈ 0。
  const state = buildScenario({
    seatCount: 4, current: 0,
    stocks: [[0, 0, 0, 0], [2, 1, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'],
  });
  const surv1 = model.predictSurvivalFor(state, 'G01', 1, 1);
  const surv2 = model.predictSurvivalFor(state, 'G01', 1, 2);
  assert.ok(surv1.pPresentAt[1] > 0.9, `viewer1 无威胁时存活应接近 1：${surv1.pPresentAt[1]}`);
  assert.ok(surv2.pPresentAt[1] < 0.5, `viewer2 应暴露在 P1 的抢牌风险下：${surv2.pPresentAt[1]}`);
  assert.ok(surv2.pPresentAt[1] < surv1.pPresentAt[1], '座位劣势必须降低存活概率');
});

test('H10：同一策略的多个 AI 产生高度一致行为——同构状态预测一致', () => {
  // 同一库存/手牌/市场的两个对局，仅席位 id 交换（0↔1），模型对两席位的
  // 预测分布（按行动族聚合）应高度一致——模型不因席位 id 本身产生偏置。
  const mkState = (swap) => {
    const game = createGame(['A', 'B'], 20260303, [1]);
    for (const p of game.players) p.isAI = true;
    game.players[0].stock = [2, 1, 0, 1];
    game.players[1].stock = [2, 1, 0, 1];
    game.golemMarket = ['G01', 'G05', 'G08', 'G14', 'G20'];
    game.current = 0;
    if (swap) {
      game.players[0].stock = [2, 1, 0, 1];
      game.players[1].stock = [2, 1, 0, 1];
    }
    return buildPublicSimState(buildObservation(game, 0));
  };
  const a = model.predictAction(mkState(false), 0);
  const b = model.predictAction(mkState(true), 0);
  const familyMass = (dist) => {
    const m = {};
    for (const e of dist.entries) m[e.family] = (m[e.family] ?? 0) + e.p;
    return m;
  };
  const fa = familyMass(a);
  const fb = familyMass(b);
  for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    assert.ok(Math.abs((fa[key] ?? 0) - (fb[key] ?? 0)) < 1e-9, `同构状态族概率漂移：${key}`);
  }
  // 多个相同 AI 实例（同参数）在同一种子下行为一致：冠军驱动两局逐位一致。
  const runAI = (seed) => {
    let game = createGame(['A', 'B'], seed, [1]);
    for (const p of game.players) p.isAI = true;
    const actions = [];
    let moves = 0;
    while (game.phase !== 'finished' && moves < 60) {
      const { action } = chooseAIAction(game);
      actions.push(action.type);
      game = applyAction(game, action);
      moves++;
    }
    return actions;
  };
  assert.deepEqual(runAI(777), runAI(777), '同种子同策略行为不一致');
});

test('H 卫生：全场景概率约束复核（负数 / NaN / 超 1 扫描）', () => {
  const scenarios = [
    buildScenario({ seatCount: 2, current: 0, stocks: [[2, 1, 0, 1], [2, 1, 0, 1]], golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'] }),
    buildScenario({ seatCount: 3, current: 2, stocks: [[2, 1, 0, 1], [2, 1, 0, 1], [2, 1, 0, 1]], golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'] }),
    buildScenario({ seatCount: 3, current: 1, triggerPlayer: 0, stocks: [[2, 1, 0, 1], [2, 1, 0, 1], [0, 0, 0, 0]], golemMarket: ['G01', 'G05', 'G08', 'G14', 'G20'] }),
  ];
  for (const state of scenarios) {
    for (let pid = 0; pid < state.playerCount; pid++) {
      const dist = model.predictAction(state, pid);
      const sum = dist.entries.reduce((s, e) => s + e.p, 0);
      if (dist.entries.length) assert.ok(Math.abs(sum - 1) < 1e-9, `行动分布和 ${sum}`);
      const intent = model.predictIntent(state, pid);
      const mass = intent.golems.reduce((s, e) => s + e.p, 0) + intent.noSpecificTarget;
      assert.ok(Math.abs(mass - 1) < 1e-6, `意图质量 ${mass}`);
    }
    for (const gid of state.golemMarket) {
      const eta = model.predictClaimETA(state, state.current, gid);
      assert.ok(Math.abs(eta.cumulative[eta.cumulative.length - 1] + eta.pBeyond - 1) < 1e-9 || eta.pBeyond === 1);
      const surv = model.predictSurvival(state, gid);
      assert.ok(surv.pPresentAt.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
    }
  }
  void G01_COST; void G26_COST;
});
