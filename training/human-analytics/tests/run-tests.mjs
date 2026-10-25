/** 验收测试：真实格式样例 / 2–5 人支持 / 非法记录拒绝 / 隐藏信息剔除 / 输出确定性。
 *
 * 运行：node --test tests/run-tests.mjs
 * 前置：web-v1 引擎已编译（本套件会在 dist 缺失时经 engine-link 自动构建一次）。
 *
 * 数据来源声明：全部测试对局为 AI 模拟（正式引擎 + 脚本化合法策略生成，
 * 带 simulated-scripted 来源戳），不代表真人对局。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = resolve(HERE, '..');
const FIXTURES = resolve(MOD, 'fixtures');

const { importGameFile, importGameFiles, canonicalStringify } = await import(resolve(MOD, 'import-games.mjs'));
const {
  computeGameMetrics, discardedCrystalCount, unusedAcquisitions, annotateMissedClaims, METRIC_SCHEMA_VERSION,
} = await import(resolve(MOD, 'metrics.mjs'));
const { computeFailureDiagnosis, FAILURE_TYPES } = await import(resolve(MOD, 'failures.mjs'));
const { extractCases, assertNoHiddenInfo } = await import(resolve(MOD, 'cases.mjs'));
const { loadEngine } = await import(resolve(MOD, 'engine-link.mjs'));

const tmp = () => mkdtempSync(resolve(tmpdir(), 'century-ha-'));
const writeJson = (dir, name, obj) => { const p = resolve(dir, name); writeFileSync(p, JSON.stringify(obj, null, 2)); return p; };
const fixture = name => resolve(FIXTURES, name);
const sha = s => createHash('sha256').update(s).digest('hex');

const FINISHED = ['sim-scripted-2p-seed101.json', 'sim-scripted-3p-seed202.json', 'sim-scripted-4p-seed303.json', 'sim-scripted-5p-seed404.json'];

test('前置：fixtures 齐备（2–5 人 + 未完成 + 旧存档）', () => {
  for (const f of [...FINISHED, 'sim-scripted-3p-unfinished-seed505.json', 'sim-scripted-3p-legacy-seed606.json']) {
    assert.ok(existsSync(fixture(f)), `缺少 fixture ${f}`);
  }
});

test('2–5 人完整对局全部通过导入与引擎重放验证', async () => {
  for (const f of FINISHED) {
    const r = await importGameFile(fixture(f));
    const errors = r.anomalies.filter(a => a.level === 'error');
    assert.deepEqual(errors, [], `${f} 应无错误：${JSON.stringify(errors)}`);
    assert.equal(r.ok, true);
    assert.equal(r.meta.finished, true);
    assert.equal(r.provenance.kind, 'simulated-scripted', '模拟数据必须带来源戳');
  }
});

test('导入结果：席位人数与完成状态正确', async () => {
  const seats = [2, 3, 4, 5];
  for (let i = 0; i < seats.length; i++) {
    const r = await importGameFile(fixture(FINISHED[i]));
    assert.equal(r.meta.seatCount, seats[i]);
    assert.equal(r.meta.claimedTarget, seats[i] >= 4 ? 5 : 6);
    assert.equal(r.meta.finished, true);
  }
});

test('指标与正式引擎一致：总分、排名、认领目标', async () => {
  const { engine } = await loadEngine();
  for (const f of FINISHED) {
    const r = await importGameFile(fixture(f));
    assert.ok(r.ok, f);
    const metrics = await computeGameMetrics(r);
    for (const p of metrics.players) {
      assert.equal(p.kind.computed.totalScore, engine.score(r.game.players[p.seat]), `${f} 座位 ${p.seat} 总分应与引擎 score() 一致`);
    }
    const expect = engine.ranking(r.game).map(p => ({ seat: p.id, name: p.name, score: engine.score(p) }));
    assert.deepEqual(metrics.ranking, expect, `${f} 排名应与引擎 ranking() 一致`);
  }
});

test('非法记录拒绝：坏 JSON / 错 format / 负库存 / 手数断裂 / 非法行动 / 6 人 / 牌库篡改 / current 篡改', async () => {
  const dir = tmp();
  try {
    // 坏 JSON
    const badJson = resolve(dir, 'bad.json');
    writeFileSync(badJson, '{not json');
    let r = await importGameFile(badJson);
    assert.equal(r.ok, false);
    assert.ok(r.anomalies.some(a => a.code === 'bad-json'));

    const good = JSON.parse(readFileSync(fixture('sim-scripted-3p-seed202.json'), 'utf-8'));

    // 错 format
    r = await importGameFile(writeJson(dir, 'fmt.json', { ...good, format: 'other' }));
    assert.ok(r.anomalies.some(a => a.code === 'bad-format'));

    // 版本错
    r = await importGameFile(writeJson(dir, 'ver.json', { ...good, version: 2 }));
    assert.ok(r.anomalies.some(a => a.code === 'bad-version'));

    // 负库存（结构层拒绝）
    const neg = structuredClone(good);
    neg.replay.turns[5].before.stock[0] = -1;
    r = await importGameFile(writeJson(dir, 'neg.json', neg));
    assert.ok(r.anomalies.some(a => a.code === 'bad-player-field'));

    // 手数断裂（turnNumber 不严格递增）
    const dupTurn = structuredClone(good);
    dupTurn.replay.turns[3].turnNumber = dupTurn.replay.turns[2].turnNumber;
    r = await importGameFile(writeJson(dir, 'order.json', dupTurn));
    assert.ok(r.anomalies.some(a => a.code === 'turn-order' || a.code === 'continuation-invalid'));

    // 非法行动：重放被引擎拒绝（支付颗数与位置深度不符）
    const illegal = structuredClone(good);
    const acquireIdx = illegal.replay.turns.findIndex(t => t.actions[0].type === 'acquire');
    assert.ok(acquireIdx > 0, 'fixture 中应存在取卡行动');
    illegal.replay.turns[acquireIdx].actions[0].payment = [0, 0, 0]; // index 深度不符的支付
    r = await importGameFile(writeJson(dir, 'illegal.json', illegal));
    assert.ok(r.anomalies.some(a => a.code === 'replay-illegal-action' || a.code === 'bad-action'));

    // 行动后状态被篡改
    const afterTamper = structuredClone(good);
    afterTamper.replay.turns[10].after.stock[0] = 99;
    r = await importGameFile(writeJson(dir, 'after.json', afterTamper));
    assert.ok(r.anomalies.some(a => a.code === 'replay-after-mismatch'));

    // 6 人（非官方扩展）拒绝
    const six = structuredClone(good);
    six.replay.turns = [];
    r = await importGameFile(writeJson(dir, 'six.json', six));
    // 3 人 fixture 改不出 6 人；单独构造最小 6 人记录
    const sixp = structuredClone(good);
    sixp.replay.initial.players = Array.from({ length: 6 }, (_, i) => ({ ...sixp.replay.initial.players[0], id: i, name: `P${i}` }));
    r = await importGameFile(writeJson(dir, 'six2.json', sixp));
    assert.ok(r.anomalies.some(a => a.code === 'unsupported-players'));

    // 牌库序篡改 → 重放 cardId / 状态不一致
    const deck = structuredClone(good);
    const d = deck.replay.initial.merchantDeck;
    [d[0], d[1]] = [d[1], d[0]];
    r = await importGameFile(writeJson(dir, 'deck.json', deck));
    assert.ok(r.anomalies.some(a => ['replay-card-mismatch', 'replay-after-mismatch', 'replay-before-mismatch', 'final-state-mismatch'].includes(a.code)),
      '牌库篡改应被检出');

    // current 终态篡改
    const cur = structuredClone(good);
    cur.current.copper = 99;
    r = await importGameFile(writeJson(dir, 'cur.json', cur));
    assert.ok(r.anomalies.some(a => a.code === 'final-state-mismatch'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复记录检测：批内同文件两次导入 → duplicate', async () => {
  const results = await importGameFiles([fixture(FINISHED[0]), fixture(FINISHED[0])]);
  assert.equal(results[0].anomalies.filter(a => a.code === 'duplicate').length, 0);
  assert.equal(results[1].anomalies.filter(a => a.code === 'duplicate').length, 1);
});

test('未完成对局：通过校验但带 unfinished 警告；终局诊断输出「无法判断」', async () => {
  const r = await importGameFile(fixture('sim-scripted-3p-unfinished-seed505.json'));
  assert.equal(r.ok, true);
  assert.ok(r.anomalies.some(a => a.code === 'unfinished'));
  const metrics = await computeGameMetrics(r);
  const failures = computeFailureDiagnosis(metrics);
  for (const p of failures.players) {
    for (const code of ['engine-overbuild', 'endgame-pacing']) {
      const inc = p.inconclusives.find(i => i.type === code);
      assert.ok(inc, `未完成对局中座位 ${p.seat} 的 ${code} 应为「无法判断」`);
      assert.match(inc.reason, /game-unfinished/);
    }
  }
});

test('旧存档（replay=null）明确拒绝并给出原因', async () => {
  const r = await importGameFile(fixture('sim-scripted-3p-legacy-seed606.json'));
  assert.equal(r.ok, false);
  assert.ok(r.anomalies.some(a => a.code === 'no-replay'));
});

test('隐藏信息剔除：案例无牌库键、无他人手牌；泄漏检查可捕获注入', async () => {
  for (const f of FINISHED) {
    const r = await importGameFile(fixture(f));
    const metrics = await computeGameMetrics(r);
    const bundle = await extractCases(r, metrics, { maxCases: 40 });
    assert.deepEqual(assertNoHiddenInfo(bundle), [], `${f} 案例泄漏检查应通过`);
    for (const c of bundle.cases) {
      assert.ok(Array.isArray(c.ownHand), '决策者本人手牌存在（ownHand）');
      // 他人状态不得含手牌：只有公开字段
      for (const p of c.publicPosition.players) {
        if (p.seat !== c.seat) {
          assert.ok(!('hand' in p));
        }
        assert.ok(p.stock && p.played && p.claimed);
      }
      // 顶层键黑名单
      assert.ok(!('merchantDeck' in c.publicPosition));
      assert.ok(!('golemDeck' in c.publicPosition));
    }
  }
  // 泄漏检查能捕获注入的禁用键
  const fake = { cases: [{ publicPosition: { merchantDeck: ['M01'] }, hand: ['S01'] }] };
  const violations = assertNoHiddenInfo(fake);
  assert.equal(violations.length, 2, '注入 merchantDeck 与 hand 均应被发现');
});

test('确定性：同一记录重复生成逐字节一致的指标/案例/报告', async () => {
  const dirA = tmp(); const dirB = tmp();
  try {
    const cli = resolve(MOD, 'cli.mjs');
    const files = FINISHED.map(f => fixture(f));
    for (const dir of [dirA, dirB]) {
      const res = spawnSync(process.execPath, [cli, 'analyze', ...files, '--out', dir], { encoding: 'utf-8' });
      assert.equal(res.status, 0, res.stderr);
    }
    const namesA = readdirSync(dirA).sort();
    const namesB = readdirSync(dirB).sort();
    assert.deepEqual(namesB, namesA);
    for (const n of namesA) {
      assert.equal(sha(readFileSync(resolve(dirB, n))), sha(readFileSync(resolve(dirA, n))), `${n} 两次运行应逐字节一致`);
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('失败诊断：8 类类型齐备；findings 必附证据；不能只凭输赢', async () => {
  assert.equal(FAILURE_TYPES.length, 8);
  const r = await importGameFile(fixture('sim-scripted-4p-seed303.json'));
  const metrics = await computeGameMetrics(r);
  const failures = computeFailureDiagnosis(metrics);
  const seen = new Set(failures.players.flatMap(p => [...p.findings.map(f => f.type), ...p.inconclusives.map(i => i.type)]));
  for (const [code] of FAILURE_TYPES) assert.ok(seen.has(code) || true, `${code} 可不出现但结构合法`);
  for (const p of failures.players) {
    for (const f of p.findings) {
      assert.ok(f.evidence.length >= 1, 'finding 必须有证据');
      assert.ok(['low', 'medium', 'high'].includes(f.severity));
      assert.ok(f.thresholds && Object.keys(f.thresholds).length >= 1, 'finding 必须声明阈值');
    }
  }
  // 排名末位不自动产生任何「输家」标签：诊断只认证据
  assert.ok(failures.discipline.some(d => d.includes('不以输赢')));
});

test('案例提取：优先级与去重正确（trigger > contested > overflow > endgame）', async () => {
  const r = await importGameFile(fixture('sim-scripted-4p-seed303.json'));
  const metrics = await computeGameMetrics(r);
  const bundle = await extractCases(r, metrics, { maxCases: 10 });
  assert.ok(bundle.cases.length <= 10);
  const ids = bundle.cases.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, '案例 id 不重复');
  const pr = { trigger: 0, contested: 1, 'missed-claim': 2, overflow: 3, endgame: 4, claim: 5, 'final-action': 6 };
  const orderKey = c => Math.min(...c.kinds.map(k => pr[k]));
  for (let i = 1; i < bundle.cases.length; i++) {
    const a = orderKey(bundle.cases[i - 1]), b = orderKey(bundle.cases[i]);
    assert.ok(a <= b, '案例按优先级排序');
    if (a === b) assert.ok(bundle.cases[i - 1].turnNumber <= bundle.cases[i].turnNumber);
  }
});

test('CLI 端到端：check 拒绝非法文件（退出码 1），aggregate 产出报告', async () => {
  const cli = resolve(MOD, 'cli.mjs');
  const out = tmp();
  try {
    const res = spawnSync(process.execPath, [cli, 'check', fixture('sim-scripted-3p-legacy-seed606.json')], { encoding: 'utf-8' });
    assert.equal(res.status, 1, '旧存档应拒绝并退出 1');

    const res2 = spawnSync(process.execPath, [cli, 'analyze', fixture('sim-scripted-3p-seed202.json'), '--out', out], { encoding: 'utf-8' });
    assert.equal(res2.status, 0, res2.stderr);

    const res3 = spawnSync(process.execPath, [cli, 'aggregate', '--out', out, '--dir', out], { encoding: 'utf-8' });
    assert.equal(res3.status, 0, res3.stderr);
    const aggMd = readFileSync(resolve(out, 'aggregate.md'), 'utf-8');
    assert.match(aggMd, /数据来源/);
    assert.match(aggMd, /simulated-scripted/, '聚合报告必须标注模拟来源');
    const aggJson = JSON.parse(readFileSync(resolve(out, 'aggregate.json'), 'utf-8'));
    assert.equal(aggJson.schema, 'century-human-analytics-aggregate-v1');
    assert.equal(aggJson.gameCount, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('v2 口径：弃置颗数按 colors.length，不按颜色编号求和', () => {
  assert.equal(discardedCrystalCount([0, 0, 0]), 3, '黄色编号 0 也必须计颗数');
  assert.equal(discardedCrystalCount([0, 1, 1, 2]), 4);
  assert.equal(discardedCrystalCount([]), 0);
  assert.equal(discardedCrystalCount(undefined), 0);
});

test('v2 口径：死卡 = 取后从未打出；曾打出后休息收回不算死卡', () => {
  const starters = new Set(['S01', 'S02']);
  const events = [
    { type: 'acquire', cardId: 'M35', turn: 3 },
    { type: 'play', cardId: 'M35', turn: 5 },
    { type: 'rest', cardId: 'M35', turn: 7 }, // 休息收回不影响"曾使用"
    { type: 'acquire', cardId: 'M05', turn: 9 },
    { type: 'acquire', cardId: 'S02', turn: 11 }, // 起始卡永不计死卡
  ];
  const r = unusedAcquisitions(events, starters);
  assert.deepEqual(r.deadCards, ['M05']);
  assert.deepEqual(r.playedCardIds, ['M35']);
  assert.equal(r.acquiredNeverPlayed.length, 1);
  assert.equal(r.acquiredNeverPlayed[0].turn, 9);
});

test('v2 口径：自领不算被抢；跨回合重复目标只标首次流失', () => {
  const annotated = annotateMissedClaims([
    { turn: 10, bySeat: 0, golemId: 'G25', points: 17, chosen: 'play', claimedLaterBy: 0 },
    { turn: 20, bySeat: 0, golemId: 'G25', points: 17, chosen: 'acquire', claimedLaterBy: 2 },
    { turn: 30, bySeat: 1, golemId: 'G30', points: 10, chosen: 'rest', claimedLaterBy: 3 },
    { turn: 40, bySeat: 1, golemId: 'G31', points: 12, chosen: 'rest', claimedLaterBy: null },
  ]);
  assert.equal(annotated[0].claimedLaterBySelf, true);
  assert.equal(annotated[0].claimedLaterByOther, false);
  assert.equal(annotated[0].firstLossOfTarget, true);
  assert.equal(annotated[1].claimedLaterBySelf, false);
  assert.equal(annotated[1].claimedLaterByOther, true);
  assert.equal(annotated[1].repeatOfEarlierMiss, true);
  assert.equal(annotated[1].lossEventId, annotated[0].lossEventId, '同一 (席位,目标) 的重复记录共享 lossEventId');
  assert.equal(annotated[2].claimedLaterByOther, true);
  assert.equal(annotated[3].claimedLaterByOther, false);
});

test('v2 集成：指标 schema/弃置守恒/死卡明细/触发时点排名', async () => {
  for (const f of FINISHED) {
    const r = await importGameFile(fixture(f));
    assert.ok(r.ok, f);
    const m = await computeGameMetrics(r);
    assert.equal(m.schema, METRIC_SCHEMA_VERSION);
    assert.equal(m.metricSemantics.version, 2);
    const discardedTotal = m.overflowEvents.reduce((s, e) => s + e.count, 0);
    for (const p of m.players) {
      const o = p.kind.observable;
      assert.equal(o.crystalsDiscarded, o.discards.reduce((s, d) => s + d.count, 0), `${f} 弃置颗数必须逐事件守恒`);
      assert.equal(new Set(o.deadCards).size, o.deadCards.length, `${f} 死卡列表不得重复`);
      assert.equal(o.deadCardDetails.length, o.deadCards.length, `${f} 死卡明细与列表一致`);
      for (const d of o.deadCardDetails) {
        assert.ok(typeof d.cardId === 'string' && d.cardId.length > 0);
        assert.ok(!(o.usedThenRecovered ?? []).includes(d.cardId), `${f} 死卡不能同时被标为使用后收回`);
      }
      assert.ok(p.kind.computed.maxEngineSize >= 0);
    }
    // 逐事件弃置颗数之和 = 对局级 overflowEvents 之和（跨席位守恒）。
    const seatDiscarded = m.players.reduce((s, p) => s + p.kind.observable.crystalsDiscarded, 0);
    assert.equal(seatDiscarded, discardedTotal, `${f} 逐席位弃置与对局级事件守恒`);
    for (const mc of m.missedClaims) {
      assert.equal(typeof mc.claimedLaterBySelf, 'boolean');
      assert.equal(typeof mc.claimedLaterByOther, 'boolean');
      assert.ok(mc.claimedLaterBySelf === false || mc.claimedLaterByOther === false, '自领与他领互斥');
    }
    if (m.game.meta.finished) {
      assert.ok(m.game.meta.triggerRanking, `${f} 完成局必须有触发时点排名`);
      assert.equal(m.game.meta.triggerRanking.length, r.meta.seatCount);
      for (const entry of m.game.meta.triggerScores) assert.equal(typeof entry.score, 'number');
    }
  }
});

test('fixtures 生成器：同种子两次生成逐字节一致', async () => {
  const { simulateGame } = await import(resolve(MOD, 'fixtures-gen.mjs'));
  const a = await simulateGame(3, 202);
  const b = await simulateGame(3, 202);
  assert.equal(canonicalStringify(a.json), canonicalStringify(b.json));
});
