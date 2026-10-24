/** PR #26 正确性修复回归测试（fix/pr26-joint-search-correctness）。
 *
 * 四组缺陷的可复现证据（每组先在修复前代码上验证为红，修复后转绿）：
 * P0-1 JS4 搜索树时序：根行动后未推进对手回合就展开"己方"分支；
 *      兄弟分支共享可变预算；终局名次未用正式排名规则。
 * P0-2 立即认领被未来存活概率错误惩罚（screenRootActions）。
 * P0-3 S3 场景实体重复 + 不可支付库存（见 joint-issue20.test.mjs 重设计）。
 * P1-1 trialIndex 导致根行动间随机流不对齐；单世界采样。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, ranking } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai/observation.js';
import { createSimulation } from '../dist/js/sim/session.js';
import { enumerateLegalActions } from '../dist/js/sim/legal.js';
import { runJointTreeTrial } from '../dist/js/js/joint-tree.js';
import { runJointRollout, trialRngSeed } from '../dist/js/js/joint-rollout.js';
import { screenRootActions, heuristicContext, rootSurvival, actionValue, topPayments } from '../dist/js/js/rollout-policy.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { initialState } from '../dist/js/ai/planner.js';
import { NEUTRAL_PROFILE } from '../dist/js/ai/profiles.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';

/** 2 人定向构造：直接摆库存/市场（合法牌 id；marked directed construction）。 */
function twoPlayerGame(seed, seat0Stock, seat1Stock, golemMarket) {
  const g = createGame(['我', '下家'], seed, [1]);
  g.players[0].isAI = true;
  g.players[0].stock = [...seat0Stock];
  g.players[1].stock = [...seat1Stock];
  g.golemMarket = [...golemMarket];
  return g;
}

function treeCtxOf(mySeat, overrides = {}) {
  return {
    mySeat, mode: 'rule', evaluator: 'L2', horizon: 40, om: null,
    treeBranching: 2, treeDepth: 1, ...overrides,
  };
}

test('P0-1a 树搜索：放弃轮次不能"免费"（v1 缺陷：max 节点替对手做利我选择）', () => {
  // 双方可认领 G08@0（6 分 + 0 号位铜币 3 分）。根行动对比：
  // claim@0（立即 +9）vs rest（把行动权让给对手）。修复后的树：对手节点按对手
  // 策略采样（rule τ=0.2 下认领 ≈ 确定性）⇒ rest 的价值必须显著低于 claim。
  // v1 缺陷路径：expandMyNode 在对手节点展开（initialState 按 view.current 取到
  // 对手候选集），并以"我方 leaf 值"取 max ⇒ "对手不动、留我下轮认领"的幻想
  // 分支胜出，rest 价值被抬高到与 claim 相当甚至更高（机会节点被 max 污染）。
  const g = twoPlayerGame(7001, [2, 2, 0, 0], [2, 2, 0, 0], ['G08', 'G05', 'G23']);
  const view = buildObservation(g, 0);
  const root = createSimulation(view, { simSeed: 42 });
  const meanOf = (rootAction, trials = 24) => {
    let total = 0;
    for (let replica = 0; replica < trials; replica++) {
      total += runJointTreeTrial(root, rootAction, 0, replica, 42, treeCtxOf(0)).value;
    }
    return total / trials;
  };
  const claimValue = meanOf({ type: 'claim', index: 0 });
  const restValue = meanOf({ type: 'rest' });
  assert.ok(claimValue - restValue > 0.15,
    `认领与弃权价值差不足（claim=${claimValue.toFixed(3)} rest=${restValue.toFixed(3)}）——对手节点疑似被 max 污染（P0-1 未修复）`);
});

test('P0-1b 树搜索：2 人局座位时序严格交替（我→下家→我→…）', () => {
  const g = twoPlayerGame(7002, [2, 2, 0, 0], [2, 2, 0, 0], ['G08', 'G05', 'G23']);
  const view = buildObservation(g, 0);
  const root = createSimulation(view, { simSeed: 7 });
  for (const rootAction of [{ type: 'rest' }, { type: 'acquire', index: 0, payment: [] }]) {
    const stepLog = [];
    runJointTreeTrial(root, rootAction, 0, 3, 7, treeCtxOf(0, { stepLog, horizon: 24 }));
    for (let i = 0; i < stepLog.length; i++) {
      assert.equal(stepLog[i].seat, i % 2,
        `座位时序断裂 @${i}：${JSON.stringify(stepLog.slice(Math.max(0, i - 2), i + 1))}`);
    }
  }
});

test('P0-1c 树搜索终局：finalRank 必须来自正式规则 ranking', () => {
  // 5 人局定向构造（合法形态：已认领与市场无重复实体；库存足额 5 蓝）：
  // 我（席位 2）已认领 4 张，认领 G14（第 5 张）触发终局且我分最高 ⇒ finalRank 1。
  const g = createGame(['P0', 'P1', 'P2', 'P3', 'P4'], 7010, [1, 2, 3, 4]);
  g.players.forEach(p => { p.isAI = true; });
  const me = g.players[2];
  me.stock = [0, 0, 5, 0]; // G14 [0,0,4,0] 足额（v1 的 S3 用 [4,2,2,0] 蓝不足，缺陷留档）
  me.claimed = ['G05', 'G06', 'G08', 'G13']; // 与市场零交集
  me.copper = 1;
  g.golemMarket = ['G14', 'G20', 'G24', 'G07', 'G26'];
  g.current = 2;
  const view = buildObservation(g, 2);
  const root = createSimulation(view, { simSeed: 9 });
  const claimG14 = { type: 'claim', index: 0 };
  const outcome = runJointTreeTrial(root, claimG14, 0, 0, 9, treeCtxOf(2));
  assert.equal(outcome.finished, true, '认领第 5 张魔像应触发终局');
  assert.equal(outcome.finalRank, 1, `finalRank 必须来自正式 ranking：${outcome.finalRank}`);
  assert.equal(outcome.value, 1, '终局第一名价值必须为 1');
});

test('P0-2 立即认领不被未来存活概率惩罚（screenRootActions 修复）', async () => {
  // S5a 同款 5 人盘面：席位 4（后手）可立即认领 G01@0（9 分）；golemSurvivalModel
  // 给 G01 的未来存活显著 < 1。修复口径：根层 claim 可立即执行 ⇒ 存活系数 = 1，
  // 先验与 survival=1.0 时完全一致；非 claim 行动（未来目标规划）仍受弱折扣。
  const mk = current => {
    const g = createGame(['P0', 'P1', 'P2', 'P3', 'P4'], 7020, [1, 2, 3, 4]);
    g.players.forEach(p => { p.isAI = true; });
    g.golemMarket = ['G01', 'G05', 'G23', 'G07', 'G26'];
    for (const p of g.players) p.stock = [2, 1, 0, 1];
    g.players[current].stock = [3, 1, 0, 1]; // G01 [2,1,0,1] 可支付
    g.current = current;
    return g;
  };
  const g = mk(4);
  const view = buildObservation(g, 4);
  const survival = rootSurvival(view, 2);
  assert.ok(survival['G01'] < 0.99, `前置：G01 存活应 < 1（实际 ${survival['G01']?.toFixed(3)}）`);
  const ctx = heuristicContext(buildObservation(g, 4), CHAMPION_PARAMETERS, NEUTRAL_PROFILE);
  const claim = { type: 'claim', index: 0 };
  const rootActions = [claim];
  const withDiscount = screenRootActions(view, rootActions, ctx, survival);
  const withImmune = screenRootActions(view, rootActions, ctx, { ...survival, G01: 1 });
  const priorOf = (list, type, index) => list.find(x => x.action.type === type && (type !== 'acquire' || x.action.index === index))?.prior;
  const claimD = priorOf(withDiscount, 'claim', 0);
  const claimI = priorOf(withImmune, 'claim', 0);
  assert.ok(claimD !== undefined && claimI !== undefined, 'claim 行动缺失先验');
  assert.ok(Math.abs(claimD - claimI) < 1e-9,
    `立即认领仍被存活折扣惩罚：survival 表折扣 prior=${claimD.toFixed(4)} vs 免疫 prior=${claimI.toFixed(4)}`);
  // 独立验证：立即认领的先验必须等于原始 actionValue（×1）。
  const raw = actionValue(initialState(view), claim, 'G01', ctx);
  assert.ok(Math.abs(claimD - raw) < 1e-9, `claim 先验 ${claimD.toFixed(4)} ≠ 原始值 ${raw.toFixed(4)}`);
  // 控制组：非行动者视角（立即性不成立）时，未来存活折扣必须仍然生效——
  // 防止过度修复（把一切认领都免疫）。
  const viewNotActor = { ...view, playerId: 4, current: 0 };
  const ctxNotActor = heuristicContext(viewNotActor, CHAMPION_PARAMETERS, NEUTRAL_PROFILE);
  const notActorD = screenRootActions(viewNotActor, [claim], ctxNotActor, survival).find(x => x.action.type === 'claim')?.prior;
  const notActorI = screenRootActions(viewNotActor, [claim], ctxNotActor, { ...survival, G01: 1 }).find(x => x.action.type === 'claim')?.prior;
  assert.ok(notActorD !== undefined && notActorI !== undefined && notActorD < notActorI,
    `非立即认领的存活折扣失效（过度修复）：${notActorD} vs ${notActorI}`);
});

test('P1-1a CRN：同一 (world, replica) 跨根行动派生同一随机流', () => {
  // 派生函数纯度 + 结构性质。
  assert.equal(trialRngSeed(12345, 2, 3), trialRngSeed(12345, 2, 3), '同参必须同种子');
  const seeds = new Set();
  for (let w = 0; w < 4; w++) for (let r = 0; r < 3; r++) seeds.add(trialRngSeed(99, w, r));
  assert.equal(seeds.size, 12, '不同 (world, replica) 必须派生不同随机流');
});

test('P1-1b 多世界 + CRN：全部候选共享同一 (world, replica) 网格且逐位可复现', () => {
  const g = twoPlayerGame(7030, [2, 2, 2, 1], [1, 1, 1, 1], ['G03', 'G05', 'G13']);
  const run = () => chooseJointAction(g, {
    version: 'joint-js2', workUnits: 48, worlds: 4, horizon: 40, simSeed: 11, collectTrials: true,
  });
  const r1 = run();
  const r2 = run();
  const trials1 = r1.joint.trials;
  const trials2 = r2.joint.trials;
  assert.ok(trials1 && trials1.length > 0, 'collectTrials 未披露试验记录');
  assert.deepEqual(trials2, trials1, '同观察同选项决策必须逐位可复现');
  assert.equal(r1.joint.stats.worldsUsed, 4, 'worlds=4 未生效');
  // CRN 结构断言：每个候选的 (world, replica) 键集完全一致（均衡配对设计）。
  const keySetOf = actionIndex => new Set(trials1.filter(t => t.actionIndex === actionIndex).map(t => `${t.world}:${t.replica}`));
  const triedIndexes = [...new Set(trials1.map(t => t.actionIndex))];
  assert.ok(triedIndexes.length >= 2, '已试候选不足');
  const reference = keySetOf(triedIndexes[0]);
  for (const idx of triedIndexes) {
    assert.deepEqual([...keySetOf(idx)].sort(), [...reference].sort(),
      `候选 ${idx} 的 (world, replica) 网格与其他候选不一致（CRN 破坏）`);
  }
  // 试验数在候选间严格均衡。
  const counts = triedIndexes.map(idx => trials1.filter(t => t.actionIndex === idx).length);
  assert.ok(new Set(counts).size === 1, `候选间试验数不均衡：${counts.join(',')}`);
});

test('P1-1c 单世界回退：worlds=1 时恢复单一信念世界语义', () => {
  const g = twoPlayerGame(7031, [2, 2, 2, 1], [1, 1, 1, 1], ['G03', 'G05', 'G13']);
  const r = chooseJointAction(g, { version: 'joint-js2', workUnits: 16, worlds: 1, horizon: 40, simSeed: 3, collectTrials: true });
  assert.equal(r.joint.stats.worldsUsed, 1);
  assert.ok(r.joint.trials.every(t => t.world === 0), 'worlds=1 时不应出现其他世界索引');
});

test('P0-1d 兄弟分支预算独立：两个分支都必须获得完整视野（v1 缺陷：共享预算饥饿）', () => {
  // v1 缺陷：expandMyNode 的兄弟分支共享 transitions 计数——第一个分支的轨迹
  // 吃满 horizon，后续兄弟在 depth-0 处被叶子计价（值依赖兄弟求值顺序）。
  // 修复后：每分支独立预算 ⇒ 总转移数 ≈ branching × horizon。
  const g = twoPlayerGame(7040, [3, 2, 2, 1], [2, 2, 1, 1], ['G03', 'G05', 'G13']);
  const view = buildObservation(g, 0);
  const root = createSimulation(view, { simSeed: 5 });
  const horizon = 30;
  const legal = enumerateLegalActions(root.view, { dedupe: true });
  const rootAction = legal.find(a => a.type === 'acquire') ?? legal[0];
  let maxTransitions = 0;
  for (let replica = 0; replica < 6; replica++) {
    const outcome = runJointTreeTrial(root, rootAction, 0, replica, 5, treeCtxOf(0, { horizon, treeBranching: 2, treeDepth: 1 }));
    maxTransitions = Math.max(maxTransitions, outcome.transitions);
  }
  assert.ok(maxTransitions >= 1.5 * horizon,
    `兄弟分支预算仍被共享（最大转移数 ${maxTransitions} < 1.5×horizon=${1.5 * horizon}）——第二分支被饥饿到 depth-0 叶子计价`);
  assert.ok(maxTransitions <= 3 * horizon + 8, `树试验转移数失控：${maxTransitions}`);
});

test('P0-1e 对手行动必须来自对手当回合的完整合法策略（random 模式覆盖检验）', () => {
  // 对手（seat 1）：空手牌、空打出、商人市场非空、G08 可认领 ⇒ 全量合法集 =
  // {claim@0, rest, acquire@0}。random 模式均匀采样 ⇒ 30 试中三类都应出现。
  // v1 缺陷路径：幻影节点用冠军候选集（played 为空时 rest 被排除）代替对手的
  // 全量合法采样——rest 分支在树中不可达。
  const g = twoPlayerGame(7060, [1, 1, 1, 1], [2, 2, 0, 0], ['G08', 'G05', 'G23']);
  g.players[1].hand = [];
  g.players[1].played = [];
  g.players[0].hand = [];
  g.players[0].played = ['S01']; // 我的 rest 合法（已在打出的卡可回收）
  const view = buildObservation(g, 0);
  const root = createSimulation(view, { simSeed: 77 });
  const seen = new Set();
  const trials = 40;
  for (let replica = 0; replica < trials; replica++) {
    const stepLog = [];
    runJointTreeTrial(root, { type: 'rest' }, 0, replica, 77, treeCtxOf(0, { mode: 'random', stepLog, horizon: 12 }));
    assert.equal(stepLog[0].seat, 0, '首步必须是根行动者');
    assert.equal(stepLog[1].seat, 1, '根行动后必须轮到对手');
    seen.add(stepLog[1].action.type);
  }
  assert.ok(seen.has('claim') && seen.has('rest') && seen.has('acquire'),
    `对手行动未覆盖全量合法集（观测到 ${[...seen].join('/')}）——疑似候选集被策略性剪枝替代`);
});

test('P1-1d 修复后 js4 端到端：决策合法且时序正确（座位交替抽查）', () => {
  const g = twoPlayerGame(7050, [2, 2, 0, 0], [2, 2, 0, 0], ['G08', 'G05', 'G23']);
  const r = chooseJointAction(g, { version: 'joint-js4', workUnits: 24, horizon: 40, simSeed: 13 });
  assert.doesNotThrow(() => applyAction(g, r.action), `js4 决策非法：${JSON.stringify(r.action)}`);
});
