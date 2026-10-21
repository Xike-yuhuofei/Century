/** 训练系统测试：五人自动对战模拟器。运行前需先构建 web-v1（npm run build）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateGame, summarizeResults, deterministicKey, seatProfile } from '../simulator/simulate.mjs';

test('相同种子与配置的对局完全可复现（剔除计时字段后逐位一致）', () => {
  const a = simulateGame({ seed: 2026, collectActions: true });
  const b = simulateGame({ seed: 2026, collectActions: true });
  assert.equal(deterministicKey(a), deterministicKey(b));
  assert.deepEqual(a.actions, b.actions);
  assert.equal(a.winnerSeat, b.winnerSeat);
  assert.equal(a.moves, b.moves);
});

test('不同种子产生不同对局', () => {
  const a = simulateGame({ seed: 1 });
  const b = simulateGame({ seed: 2 });
  assert.notEqual(deterministicKey(a), deterministicKey(b));
});

test('5 席全 AI 多种子连续完成且满足终局不变量', () => {
  for (const seed of [1, 7, 42, 2026, 99991]) {
    const r = simulateGame({ seed });
    assert.equal(r.status, 'finished', `seed=${seed} reason=${r.reason}`);
    assert.ok(r.moves > 50 && r.moves < 1200, `seed=${seed} moves=${r.moves}`);
    assert.equal(new Set(r.ranking.map(x => x.turns)).size, 1, '终局各席位回合数必须一致');
    // 认领魔像总数不超过 36 张，各席位分数非负。
    const totalGolems = r.ranking.reduce((s, x) => s + x.golems, 0);
    assert.ok(totalGolems > 0 && totalGolems <= 36);
    assert.ok(r.ranking.every(x => x.score >= 0));
    // 每席位至少有一次决策，且决策耗时被记录。
    assert.ok(r.metrics.seats.every(s => s.decisionCount > 0));
  }
});

test('版本配置长度不匹配时立即报错', () => {
  assert.throws(() => simulateGame({ seed: 1, versions: [null] }), /versions/);
});

test('种子超出引擎安全范围（≥ 2^31）必须拒绝（mod 2^32 回绕破坏复现与池隔离）', () => {
  // 恰好 2^31：引擎 generator 的 seed >>> 0 会把它回绕成镜像值，名义与实际序列脱钩。
  assert.throws(() => simulateGame({ seed: 2 ** 31, maxMoves: 0 }), /安全种子上限/);
  assert.throws(() => simulateGame({ seed: 20_262_022_000, maxMoves: 0 }), /安全种子上限/, '旧缺陷的真实越界值必须被拦截');
  // 边界内（2^31-1，即验证池上限以下）不因种子校验被拒。
  const r = simulateGame({ seed: 2 ** 31 - 1, maxMoves: 0 });
  assert.equal(r.status, 'anomaly'); // maxMoves=0 立即中止，仅验证种子校验通过
});

test('步数上限触发 anomaly 且不伪装成正常完成', () => {
  const r = simulateGame({ seed: 1, maxMoves: 3, deadlineMs: 60_000 });
  assert.equal(r.status, 'anomaly');
  assert.match(r.reason, /步数上限/);
  assert.equal(r.winnerSeat, null);
});

test('时间预算触发 anomaly 且不伪装成正常完成', () => {
  const r = simulateGame({ seed: 1, maxMoves: 1200, deadlineMs: 1 });
  assert.equal(r.status, 'anomaly');
  assert.match(r.reason, /时间预算/);
});

test('聚合统计将异常局与正常局严格分离', () => {
  const finished = simulateGame({ seed: 11 });
  const limited = simulateGame({ seed: 12, maxMoves: 5 });
  const summary = summarizeResults([finished, limited]);
  assert.equal(summary.totalGames, 2);
  assert.equal(summary.finishedGames, 1);
  assert.equal(summary.anomalyGames, 1);
  assert.equal(summary.anomalyRate, 0.5);
  // 胜率只统计正常完成的局。
  assert.ok(summary.winRates.reduce((s, x) => s + x, 0) <= 1.0001);
  const sum = summary.winRates.reduce((s, x) => s + x, 0);
  assert.equal(sum, 1, '正常局中恰有一名赢家');
});

test('席位人格与正式游戏逐席一致（审计整改：代理席不再挤占人格序号）', () => {
  // 正式游戏：席位 0 为人类，席位 1-4 依次获得 4 种人格；
  // 训练模拟把席位 0 替换为中立代理，席位 1-4 的映射必须与正式游戏完全一致。
  assert.equal(seatProfile(0).name, '中立代理');
  assert.equal(seatProfile(1).name, '引擎大师');
  assert.equal(seatProfile(2).name, '速攻专家');
  assert.equal(seatProfile(3).name, '精算大师');
  assert.equal(seatProfile(4).name, '战术大师');
  // 中立代理的全部乘子必须为 1.0（不得给人类代理席叠加人格偏好）。
  assert.deepEqual(seatProfile(0), { name: '中立代理', engine: 1, tempo: 1, contest: 1 });
});

test('对局中实际人格经决策理由可验证（端到端对齐）', () => {
  const r = simulateGame({ seed: 42, collectActions: true });
  assert.equal(r.status, 'finished');
  const expected = ['中立代理', '引擎大师', '速攻专家', '精算大师', '战术大师'];
  expected.forEach((profile, seat) => {
    const matched = r.actions.some(a => a.seat === seat && a.reason.includes(profile));
    assert.ok(matched, `席位 ${seat} 的决策中未出现人格 ${profile}`);
  });
  // 决策理由中不得再出现旧实现"席位 0 = 引擎大师 / 席位 4 = 引擎大师"的重复人格。
  assert.ok(!r.actions.some(a => a.seat === 0 && a.reason.includes('引擎大师')));
  assert.ok(!r.actions.some(a => a.seat === 4 && a.reason.includes('中立代理')));
});

test('逐席位版本可注入（Phase 4 起参数生效，本阶段验证接口兼容）', () => {
  const versions = [null, { id: 'baseline' }, null, null, null];
  const r = simulateGame({ seed: 42, versions });
  assert.equal(r.status, 'finished');
  assert.deepEqual(r.versions, ['baseline', 'baseline', 'baseline', 'baseline', 'baseline']);
});
