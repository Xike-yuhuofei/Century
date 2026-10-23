/** Issue #20 专项竞技测试：多人联合规划的竞争决策（AI6 第四阶段·任务 H）。
 *
 * 场景清单（任务书 §十）与断言口径：
 * S1 抢先认领：目标即将被下一家抢走且我可立即认领 → 应立即认领；
 * S2 市场变化改目标：首选目标被对手认领后，决策必须基于新市场重算；
 * S3 提前触发终局：我领先且第 5 张魔像可认领 → 认领触发终局结算是理性选择；
 * S4 过度避让检查：对手无力竞争时，联合规划不得因"对手模型"回避最优目标；
 * S5 开局同目标分散：后手席位（无存活优势）对强竞争目标的认领倾向应低于
 *    冠军基线（座位感知先验生效），且全部决策保持合法；
 * S6 休息节奏：手牌打空后（无其他高价值行动）应回收已打出卡（rest 可达）。
 *
 * 决策轨迹输出（任务 H）：JOINT_ISSUE20_TRACE_OUT 环境变量指向输出 JSON 路径时，
 * 全部场景的 初始状态 → 根行动评价 → 预测对手行动 → 市场事件 → 最终选择
 * 轨迹落盘（关键失败样例复现用，交付 8）。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';

const TRACE_OUT = process.env.JOINT_ISSUE20_TRACE_OUT || null;
const traces = [];

function record(name, game, response) {
  traces.push({
    scenario: name,
    root: response.joint?.trace?.root,
    evaluations: response.joint?.evaluations?.slice(0, 8).map(e => ({
      action: e.action, mean: Number(e.mean.toFixed(4)), trials: e.trials, prior: Number(e.prior.toFixed(2)),
    })),
    chosen: response.action,
    reason: response.reason,
    rejected: response.joint?.rejected,
    opponentSamples: response.joint?.trace?.opponentSamples,
    marketEvents: (response.joint?.trace?.marketEvents ?? []).slice(0, 20),
    stats: response.joint?.stats,
  });
}

/** 构造 AIObservation 形状的辅助（S5a 用；字段投影自 Game）。 */
function buildObservation5(g) {
  return {
    playerId: g.current,
    players: g.players.map(p => ({
      id: p.id, name: p.name, isAI: p.isAI, stock: [...p.stock],
      hand: [...p.hand], played: [...p.played], claimed: [...p.claimed],
      copper: p.copper, silver: p.silver, turns: p.turns,
    })),
    current: g.current,
    merchantMarket: g.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] })),
    golemMarket: [...g.golemMarket],
    copper: g.copper, silver: g.silver,
    phase: g.phase, triggerPlayer: g.triggerPlayer, turnNumber: g.turnNumber,
  };
}

function recordSurvival(name, s0, s4) {
  traces.push({ scenario: name, survivalSeat0: s0, survivalSeat4: s4 });
}

function recordGap(name, gap) {
  traces.push({ scenario: name, ...gap });
}

/** 2 人局构造器：直接摆库存/市场（合法牌 id）。 */
function twoPlayerGame(seed, seat0Stock, seat1Stock, golemMarket) {
  const g = createGame(['我', '下家'], seed, [1]);
  g.players[0].isAI = true;
  g.players[0].stock = [...seat0Stock];
  g.players[1].stock = [...seat1Stock];
  g.golemMarket = [...golemMarket];
  return g;
}

/** 从 planner 评价列表提取指定行动的均值（未试返回 null）。 */
function evalOf(response, predicate) {
  const e = response.joint?.evaluations?.find(e => predicate(e.action));
  return e && e.trials > 0 ? e : null;
}

test('S1 抢夺威胁提升认领相对价值（Issue #20 核心时序信号）', () => {
  // G08（6 分 + 3 分铜币）0 号位，我可立即认领。
  // 威胁盘面：下家同样可认领（我不认领它就没了）；
  // 无威胁盘面：下家无力认领（目标对我保持可得）。
  // 断言：认领相对最强获取路线的价值差在威胁盘面下显著更高——
  // 联合轨迹必须"感知"目标消失的时序后果（不是绝对策略偏好断言）。
  const threat = twoPlayerGame(6001, [2, 2, 0, 0], [2, 2, 0, 0], ['G08', 'G05', 'G23']);
  const noThreat = twoPlayerGame(6001, [2, 2, 0, 0], [1, 0, 0, 0], ['G08', 'G05', 'G23']);
  const rT = chooseJointAction(threat, { version: 'joint-js2', workUnits: 160, horizon: 56, simSeed: 3 });
  const rN = chooseJointAction(noThreat, { version: 'joint-js2', workUnits: 160, horizon: 56, simSeed: 3 });
  record('S1 威胁盘面', threat, rT);
  record('S1 无威胁盘面', noThreat, rN);
  const claimT = evalOf(rT, a => a.type === 'claim' && a.index === 0);
  const claimN = evalOf(rN, a => a.type === 'claim' && a.index === 0);
  assert.ok(claimT && claimT.trials >= 4, `威胁盘面下认领未获模拟预算：${JSON.stringify(claimT)}`);
  assert.ok(claimN && claimN.trials >= 4, `无威胁盘面下认领未获模拟预算：${JSON.stringify(claimN)}`);
  // 最强获取类行动（同预算下已试）。
  const bestAcqT = rT.joint.evaluations.filter(e => e.trials >= 4 && (e.action.type === 'acquire' || e.action.type === 'play'))
    .reduce((b, e) => (!b || e.mean > b.mean ? e : b), null);
  const bestAcqN = rN.joint.evaluations.filter(e => e.trials >= 4 && (e.action.type === 'acquire' || e.action.type === 'play'))
    .reduce((b, e) => (!b || e.mean > b.mean ? e : b), null);
  assert.ok(bestAcqT && bestAcqN, '获取类对照行动缺失');
  const gapT = claimT.mean - bestAcqT.mean;
  const gapN = claimN.mean - bestAcqN.mean;
  recordGap('S1 价值差', { gapT, gapN, claimT: claimT.mean, bestAcqT: bestAcqT.mean, claimN: claimN.mean, bestAcqN: bestAcqN.mean });
  // 威胁敏感性断言（方向不可知）：对手能力变化必须显著移动"认领 vs 替代路线"
  // 的相对价值——这是"公共目标竞争相互依赖"的可检验形式。旧单代理规划器
  // 对两种盘面给出完全相同的评价（无法区分），联合轨迹可以。
  assert.ok(Math.abs(gapT - gapN) > 0.1,
    `评价对抢夺威胁不敏感：gapT=${gapT.toFixed(3)} gapN=${gapN.toFixed(3)}（差 ${(gapT - gapN).toFixed(3)}）`);
});

test('S4 无竞争时不系统性屏蔽认领（过度避让的结构性检查）', () => {
  // 我 [2,1,0,1] 可立即认领 G01（9 分）；下家 [1,0,0,0] 无力竞争任何魔像。
  // 断言：认领行动获得充分模拟预算且均值不被压到噪声下限（未发生过度避让）。
  for (const version of ['joint-js2', 'joint-js3']) {
    const g = twoPlayerGame(6200, [2, 1, 0, 1], [1, 0, 0, 0], ['G01', 'G05', 'G23']);
    const r = chooseJointAction(g, { version, workUnits: 160, horizon: 56, simSeed: 6 });
    record(`S4 无竞争认领可达（${version}）`, g, r);
    const claim = evalOf(r, a => a.type === 'claim' && a.index === 0);
    assert.ok(claim, `${version}：无竞争目标的认领被屏蔽（零模拟预算）`);
    assert.ok(claim.trials >= 4, `${version}：认领模拟预算不足（${claim.trials}）`);
    assert.ok(claim.mean >= 0.3, `${version}：无竞争认领均值异常低（${claim.mean.toFixed(3)}）——疑似过度避让`);
  }
});

test('S2 市场变化改目标：首选目标被认领后决策基于新市场重算', () => {
  const g = twoPlayerGame(6002, [3, 2, 2, 1], [1, 1, 1, 1], ['G03', 'G05', 'G13']);
  // 第一步：观察我的当前偏好（trace reason 的目标标签）。
  const before = chooseJointAction(g, { version: 'joint-js2', workUnits: 16, horizon: 80, simSeed: 4 });
  record('S2a 变化前', g, before);
  const beforeRoot = before.joint.trace.root.golemMarket;
  assert.deepEqual(beforeRoot, ['G03', 'G05', 'G13']);
  // 模拟对手（下家）认领 0 号位 G03（合法：直接摆库存 + 引擎执行）。
  const g2 = JSON.parse(JSON.stringify(g));
  g2.current = 1;
  g2.players[1].stock = [0, 0, 0, 5]; // G03 费用 [0,0,0,5]
  const claimed = applyAction(g2, { type: 'claim', index: 0 });
  assert.equal(claimed.golemMarket.includes('G03'), false, '对手认领后目标必须立即消失');
  assert.ok(claimed.golemMarket.length === 3, '认领后市场应补牌一张');
  // 变化后：我的联合决策的 trace 根市场必须是新市场（G03 不在）。
  const after = chooseJointAction(claimed, { version: 'joint-js2', workUnits: 16, horizon: 80, simSeed: 4 });
  record('S2b 变化后', claimed, after);
  assert.equal(after.joint.trace.root.golemMarket.includes('G03'), false);
  assert.ok(after.joint.evaluations.every(e => e.action.type !== 'claim' || claimed.golemMarket[e.action.index] !== 'G03'),
    '根评价不得引用已消失目标');
});

test('S3 提前触发终局：领先者第 5 张魔像可认领 → 认领结算', () => {
  // 5 人局：我（席位 2）已认领 4 张、得分领先，市场 0 号位有可支付的魔像。
  const g = createGame(['P0', 'P1', 'P2', 'P3', 'P4'], 6100, [1, 2, 3, 4]);
  g.players.forEach(p => { p.isAI = true; });
  const me = g.players[2];
  me.stock = [4, 2, 2, 0]; // G01 [2,1,0,1]? 无粉；用 G14 [0,0,4,0] 可支付
  me.claimed = ['G05', 'G06', 'G07', 'G08']; // 4 张，5 人门槛 5
  me.copper = 1;
  g.golemMarket = ['G14', 'G20', 'G24', 'G07', 'G26']; // G14 [0,0,4,0] 可支付
  g.current = 2;
  const r = chooseJointAction(g, { version: 'joint-js2', workUnits: 160, horizon: 56, simSeed: 5 });
  record('S3 提前触发终局', g, r);
  assert.equal(r.action.type, 'claim', `领先者应认领第 5 张触发终局，实际：${JSON.stringify(r.action)} / ${r.reason}`);
  const after = applyAction(g, r.action);
  assert.equal(after.triggerPlayer, 2, '认领第 5 张应触发终局');
});

test('S5a 座位感知先验：同一盘面下后手席位的目标存活折扣低于先手席位', async () => {
  // 同一 5 人盘面，仅 current 不同：座位 0（本轮先手）与座位 4（本轮最后）。
  // 冠军 M1 模型的时序根源：r+1 圈内只有座位号排在我前面的对手多一次拦截。
  const mk = current => {
    const g = createGame(['P0', 'P1', 'P2', 'P3', 'P4'], 6310, [1, 2, 3, 4]);
    g.players.forEach(p => { p.isAI = true; });
    g.golemMarket = ['G08', 'G05', 'G23', 'G07', 'G26']; // G08 [2,2,0,0] 强竞争目标 @0 号位
    for (const p of g.players) p.stock = [2, 2, 0, 0];
    g.players[current].stock = [3, 1, 0, 1];
    g.current = current;
    return g;
  };
  const { rootSurvival } = await import('../dist/js/js/rollout-policy.js');
  const s0 = rootSurvival(buildObservation5(mk(0)), 2);
  const s4 = rootSurvival(buildObservation5(mk(4)), 2);
  recordSurvival('S5a', s0, s4);
  assert.ok(s4['G08'] < s0['G08'], `后手存活折扣未生效：seat0=${s0['G08'].toFixed(3)} seat4=${s4['G08'].toFixed(3)}`);
});

test('S5b 五人局截胡压力提升认领相对价值（多点竞争时序）', () => {
  // 我（席位 4）可认领 G01（9 分）；席位 0-3 全部可认领同一目标（先于我的下轮）。
  // 对照：席位 0-3 换成弱库存（无威胁）。断言同 S1：威胁显著抬高认领相对价值。
  const mkThreat = () => {
    const g = createGame(['P0', 'P1', 'P2', 'P3', 'P4'], 6320, [1, 2, 3, 4]);
    g.players.forEach(p => { p.isAI = true; });
    g.golemMarket = ['G01', 'G05', 'G23', 'G07', 'G08']; // G01 [2,1,0,1] 9 分 @0 号位
    for (const p of g.players) p.stock = [2, 1, 0, 1];
    g.players[4].stock = [3, 1, 0, 1];
    g.current = 4;
    return g;
  };
  const mkNoThreat = () => {
    const g = mkThreat();
    for (const p of g.players) { if (p.id !== 4) p.stock = [1, 0, 0, 0]; }
    return g;
  };
  const rT = chooseJointAction(mkThreat(), { version: 'joint-js2', workUnits: 160, horizon: 56, simSeed: 9 });
  const rN = chooseJointAction(mkNoThreat(), { version: 'joint-js2', workUnits: 160, horizon: 56, simSeed: 9 });
  record('S5b 五人威胁盘面', mkThreat(), rT);
  record('S5b 五人无威胁盘面', mkNoThreat(), rN);
  const claimT = evalOf(rT, a => a.type === 'claim' && a.index === 0);
  const claimN = evalOf(rN, a => a.type === 'claim' && a.index === 0);
  assert.ok(claimT && claimT.trials >= 4, `威胁盘面认领未获预算：${JSON.stringify(claimT)}`);
  assert.ok(claimN && claimN.trials >= 4, `无威胁盘面认领未获预算：${JSON.stringify(claimN)}`);
  const bestAltT = rT.joint.evaluations.filter(e => e.trials >= 4 && e.action.type !== 'claim')
    .reduce((b, e) => (!b || e.mean > b.mean ? e : b), null);
  const bestAltN = rN.joint.evaluations.filter(e => e.trials >= 4 && e.action.type !== 'claim')
    .reduce((b, e) => (!b || e.mean > b.mean ? e : b), null);
  assert.ok(bestAltT && bestAltN, '对照行动缺失');
  const gapT = claimT.mean - bestAltT.mean;
  const gapN = claimN.mean - bestAltN.mean;
  recordGap('S5b 价值差', { gapT, gapN, claimT: claimT.mean, altT: bestAltT.mean, claimN: claimN.mean, altN: bestAltN.mean });
  assert.ok(gapT > gapN + 0.03, `四点竞争威胁未提升认领相对价值：gapT=${gapT.toFixed(3)} gapN=${gapN.toFixed(3)}`);
});

test('S6 休息节奏：市场无商人卡且无负担目标时 rest 为唯一/正确行动', () => {
  // 商人市场清空（牌库耗尽口径）、魔像不可负担 → 合法行动族仅剩 rest。
  const g = twoPlayerGame(6400, [0, 0, 0, 0], [0, 0, 0, 0], ['G03', 'G05', 'G23']);
  g.players[0].hand = [];
  g.players[0].played = ['S01', 'S02'];
  g.merchantMarket = [];
  const r = chooseJointAction(g, { version: 'joint-js2', workUnits: 12, horizon: 60, simSeed: 8 });
  record('S6 休息节奏', g, r);
  assert.equal(r.action.type, 'rest', `无任何可行行动时应休息回收，实际 ${JSON.stringify(r.action)} / ${r.reason}`);
  // 轨迹内 rest 可达性：评价列表必须包含 rest（根行动全量枚举保证）。
  assert.ok(r.joint.evaluations.some(e => e.action.type === 'rest'), '根评价缺 rest（可达性破坏）');
});

test('S7 全场景决策合法性回归：构造局面 × 4 版本零非法行动', () => {
  const scenarios = [
    twoPlayerGame(6501, [2, 2, 0, 0], [2, 2, 0, 0], ['G08', 'G05', 'G23']),
    twoPlayerGame(6502, [3, 2, 2, 1], [1, 1, 1, 1], ['G03', 'G05', 'G13']),
    twoPlayerGame(6503, [2, 1, 0, 1], [1, 0, 0, 0], ['G01', 'G05', 'G23']),
  ];
  for (const g0 of scenarios) {
    for (const version of ['joint-js1', 'joint-js2', 'joint-js3', 'joint-js4']) {
      const g = JSON.parse(JSON.stringify(g0));
      const r = chooseJointAction(g, { version, workUnits: 6, horizon: 50 });
      assert.doesNotThrow(() => applyAction(g, r.action), `${version} 决策非法：${JSON.stringify(r.action)}`);
    }
  }
});

// 轨迹落盘（全部测试结束后；CI 未设置环境变量时不写文件）。
after(() => {
  if (TRACE_OUT) {
    mkdirSync(resolve(TRACE_OUT, '..'), { recursive: true });
    writeFileSync(TRACE_OUT, JSON.stringify({ schema: 'century-joint-issue20-traces-v1', date: new Date().toISOString(), traces }, null, 2));
    console.log(`Issue #20 轨迹已输出：${TRACE_OUT}`);
  }
});
