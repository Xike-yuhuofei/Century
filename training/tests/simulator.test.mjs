/** 训练系统测试：五人自动对战模拟器。运行前需先构建 web-v1（npm run build）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateGame, summarizeResults, deterministicKey } from '../simulator/simulate.mjs';

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

test('逐席位版本可注入（Phase 4 起参数生效，本阶段验证接口兼容）', () => {
  const versions = [null, { id: 'baseline' }, null, null, null];
  const r = simulateGame({ seed: 42, versions });
  assert.equal(r.status, 'finished');
  assert.deepEqual(r.versions, ['baseline', 'baseline', 'baseline', 'baseline', 'baseline']);
});
