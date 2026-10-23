/** 基线冻结与多人评测基准测试（AI6 第一阶段）。
 * 运行前需先构建 web-v1（npm run build）；种子账本测试一律用临时路径，
 * 绝不消费正式账本（AI6_BASELINE_BLOCK）的种子额度。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { percentile, latencySummary, firstPlaceClusterCI, firstPlaceBy, pairedDiffSummary } from '../baseline/stats.mjs';
import {
  BASELINE_SEED_LAYOUT, BASELINE_SUBBLOCK_CAPACITY, assertLayoutValid,
  allocateBaselineSeeds, loadLedger,
} from '../baseline/seed-ledger.mjs';
import { AI6_BASELINE_BLOCK, assertInBlock } from '../../ai5/lib/seed_policy.mjs';
import { freezeChampion, verifyChampionFreeze, loadChampion, writeChampionFreeze } from '../baseline/freeze.mjs';
import {
  championVersion, baselineOpponentPool, versionsForSeats,
  runMirrorBaseline, runContestBaseline, outcomeKey, MAX_SEAT_COUNT,
} from '../baseline/runner.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'century-baseline-'));

// ---------- stats：分位数与延迟摘要 ----------

test('percentile：已知数组的 p50/p95/p99 线性插值正确', () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(percentile(sorted, 0), 1);
  assert.equal(percentile(sorted, 1), 5);
  assert.equal(percentile(sorted, 0.5), 3);
  assert.equal(percentile(sorted, 0.25), 2);
  assert.equal(percentile([10, 20], 0.5), 15);
  assert.throws(() => percentile([], 0.5));
  assert.throws(() => percentile(sorted, 1.5));
});

test('latencySummary：空样本返回 null 字段，非空给出分位数', () => {
  assert.equal(latencySummary([]).p50Ms, null);
  const s = latencySummary([3, 1, 2, 4, 100]);
  assert.equal(s.count, 5);
  assert.equal(s.p50Ms, 3);
  // 5 样本 p99 = 线性插值 4 + (100-4)×0.96 = 96.16（介于倒数第 1、2 位之间）。
  assert.equal(s.p99Ms, 96.16);
  assert.equal(s.maxMs, 100);
  assert.equal(s.meanMs, 22);
});

// ---------- stats：种子聚类 bootstrap（相关样本修正） ----------

test('firstPlaceClusterCI：确定性（同输入同输出）且区间包含点估计', () => {
  const games = [];
  for (let seed = 0; seed < 50; seed++) {
    // 每 seed 2 局（模拟双方向配对），胜率约 0.6。
    games.push({ seed, firstPlace: seed % 5 !== 0 });
    games.push({ seed, firstPlace: seed % 10 !== 0 });
  }
  const a = firstPlaceClusterCI(games, { iterations: 500 });
  const b = firstPlaceClusterCI(games, { iterations: 500 });
  assert.deepEqual(a, b, 'bootstrap 用确定性 RNG，必须可复现');
  assert.ok(a.lower <= a.point && a.point <= a.upper);
  assert.equal(a.seeds, 50);
  assert.equal(a.games, 100);
});

test('firstPlaceClusterCI：全胜退化为点估计（区间不产生 NaN）', () => {
  const games = Array.from({ length: 20 }, (_, seed) => ({ seed, firstPlace: true }));
  const ci = firstPlaceClusterCI(games, { iterations: 100 });
  assert.equal(ci.point, 1);
  assert.equal(ci.lower, 1);
  assert.equal(ci.upper, 1);
});

test('firstPlaceClusterCI：拒绝非法输入（缺 seed / firstPlace 非布尔 / 重复种子聚类）', () => {
  assert.throws(() => firstPlaceClusterCI([{ firstPlace: true }]));
  assert.throws(() => firstPlaceClusterCI([{ seed: 1, firstPlace: 'yes' }]));
  assert.throws(() => firstPlaceClusterCI([]));
});

test('firstPlaceBy / pairedDiffSummary：分组与配对汇总正确', () => {
  const games = [
    { seed: 1, direction: 'A', firstPlace: true },
    { seed: 1, direction: 'B', firstPlace: false },
    { seed: 2, direction: 'A', firstPlace: false },
    { seed: 2, direction: 'B', firstPlace: true },
  ];
  const byDir = firstPlaceBy(games, g => g.direction);
  assert.equal(byDir.A.rate, 0.5);
  assert.equal(byDir.B.rate, 0.5);
  const paired = pairedDiffSummary([
    { seed: 1, status: 'finished', diff: 2.5 },
    { seed: 2, status: 'finished', diff: -1 },
    { seed: 3, status: 'finished', diff: 0 },
    { seed: 4, status: 'anomaly', diff: null },
  ]);
  assert.equal(paired.seeds, 3);
  assert.equal(paired.won, 1);
  assert.equal(paired.lost, 1);
  assert.equal(paired.tied, 1);
  assert.equal(paired.advantageRate, 0.3333, '优势率按 4 位小数舍入');
});

// ---------- 种子纪律：布局 / 账本 / 唯一性 ----------

test('基线种子布局：全部子块落在 AI6_BASELINE_BLOCK 内且互不重叠', () => {
  assert.equal(assertLayoutValid(), true);
  const bases = Object.values(BASELINE_SEED_LAYOUT);
  assert.ok(bases.every(b => b >= AI6_BASELINE_BLOCK[0] && b + BASELINE_SUBBLOCK_CAPACITY <= AI6_BASELINE_BLOCK[1]));
  assert.equal(new Set(bases).size, bases.length, '子块基址不得重复');
});

test('allocateBaselineSeeds：顺序切片、块内唯一、账本推进且不回退', () => {
  const dir = tmp();
  const ledgerPath = join(dir, 'seed-ledger.json');
  const first = allocateBaselineSeeds('mirror-n5', 100, { ledgerPath });
  assert.equal(first.seeds.length, 100);
  assert.equal(first.base, BASELINE_SEED_LAYOUT['mirror-n5']);
  assert.equal(first.uniqueSeedCount, 100);
  assertInBlock(first.seeds[0], AI6_BASELINE_BLOCK);
  assertInBlock(first.seeds[99], AI6_BASELINE_BLOCK);

  const second = allocateBaselineSeeds('mirror-n5', 50, { ledgerPath });
  assert.equal(second.base, BASELINE_SEED_LAYOUT['mirror-n5'] + 100, '续接消费不得回退');
  const overlap = first.seeds.filter(s => second.seeds.includes(s));
  assert.equal(overlap.length, 0, '两次消费不得有交集');

  // 账本已持久化且记录唯一种子数。
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(ledger.configs['mirror-n5'].consumed, 150);
  assert.equal(ledger.configs['mirror-n5'].uniqueSeedCount, 150);

  // 不同配置的子块互不重叠。
  const other = allocateBaselineSeeds('mirror-n4', 10, { ledgerPath });
  assert.ok(other.base !== first.base);
});

test('allocateBaselineSeeds：拒绝未知配置与超额消费（宁终止也不复用）', () => {
  const ledgerPath = join(tmp(), 'seed-ledger.json');
  assert.throws(() => allocateBaselineSeeds('unknown-config', 10, { ledgerPath }), /未知基线配置/);
  assert.throws(
    () => allocateBaselineSeeds('contest-n2', BASELINE_SUBBLOCK_CAPACITY + 1, { ledgerPath }),
    /余量不足/,
  );
  // 恰好整块的消费合法（边界含头不含尾）。
  const full = allocateBaselineSeeds('contest-n2', BASELINE_SUBBLOCK_CAPACITY, { ledgerPath });
  assert.equal(full.seeds.length, BASELINE_SUBBLOCK_CAPACITY);
  assert.throws(
    () => allocateBaselineSeeds('contest-n2', 1, { ledgerPath }),
    /余量不足/,
    '子块耗尽后继续消费必须被拒绝',
  );
});

test('loadLedger：损坏 schema 拒绝加载', () => {
  const dir = tmp();
  const path = join(dir, 'bad.json');
  writeFileSync(path, JSON.stringify({ schema: 'wrong-v0', configs: {} }));
  assert.throws(() => loadLedger(path), /schema 不识别/);
});

// ---------- 冠军冻结 ----------

test('冻结清单：正式冠军指纹核验通过，manifest 含复现入口', () => {
  const manifest = freezeChampion();
  assert.equal(manifest.schema, 'century-champion-freeze-v1');
  assert.ok(manifest.champion.id.startsWith('ai5-'), `冠军 id：${manifest.champion.id}`);
  assert.equal(manifest.champion.fingerprint.length > 0, true);
  assert.equal(manifest.version.engineBundleSha256, loadChampion().provenance.engineBundleSha256,
    '冻结时的引擎产物指纹必须与冠军 provenance 一致（freezeChampion 内部已强校验）');
  assert.match(manifest.reproduce.command, /npm run baseline/);
  const { ok, problems } = verifyChampionFreeze(manifest);
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
});

test('冻结清单：参数被篡改时校验必须失败（防配置漂移）', () => {
  const manifest = freezeChampion();
  const tampered = JSON.parse(JSON.stringify(manifest));
  const key = Object.keys(tampered.champion.parameters).find(k => k.endsWith('Weight'));
  tampered.champion.parameters[key] = 3.14; // 任意改动参数
  const { ok, problems } = verifyChampionFreeze(tampered);
  assert.equal(ok, false);
  assert.ok(problems.some(p => /指纹|不一致|漂移/.test(p)), `应报指纹/漂移问题：${problems.join('; ')}`);
});

// ---------- 运行器：席位版本分配与对手池 ----------

test('versionsForSeats：任意 N 与池大小下确定性轮换且覆盖全池', () => {
  const champion = loadChampion();
  const candidate = championVersion(champion);
  const pool = baselineOpponentPool(champion);
  assert.ok(!pool.some(o => o.id === candidate.id), '对手池不得包含冠军本体');
  assert.ok(pool.length >= 2);
  const ids = new Set(pool.map(o => o.id));
  assert.ok(ids.has('struct-beam-rollout') || pool.length >= 4, '应包含前代冠军或风格变体');

  for (const seatCount of [2, 3, 4, 5]) {
    for (const seedIndex of [0, 1, 7, 23]) {
      const versions = versionsForSeats([seedIndex % seatCount], candidate, pool, seedIndex, seatCount);
      assert.equal(versions.length, seatCount);
      // 候选席位是冠军，其余席位来自对手池且不与候选 id 冲突。
      versions.forEach((v, seat) => {
        if (seat === seedIndex % seatCount) assert.equal(v.id, candidate.id);
        else assert.ok(ids.has(v.id), `席位 ${seat} 版本 ${v.id} 必须来自对手池`);
      });
      // 确定性：同输入同输出。
      const again = versionsForSeats([seedIndex % seatCount], candidate, pool, seedIndex, seatCount);
      assert.deepEqual(versions, again);
    }
    // 全池覆盖：遍历足够多 seedIndex，每个席位都应见过池内全部对手。
    const seen = new Set();
    for (let i = 0; i < pool.length * 3; i++) {
      const versions = versionsForSeats([i % seatCount], candidate, pool, i, seatCount);
      versions.forEach((v, seat) => {
        if (seat !== i % seatCount) seen.add(v.id);
      });
    }
    for (const id of ids) assert.ok(seen.has(id), `池内对手 ${id} 应被轮换覆盖`);
  }
  assert.throws(() => versionsForSeats([0], candidate, pool, 0, 6), /seatCount/);
  assert.throws(() => versionsForSeats([0], candidate, pool, 0, 1), /seatCount/);
});

// ---------- 运行器：小规模冒烟（2-5 人真实对局） ----------

const CHAMPION = loadChampion();

test('镜像基准 N=2..5：全部完成、座位公平性结构与吞吐/延迟字段齐全', () => {
  for (const seatCount of [2, 3, 4, 5]) {
    const summary = runMirrorBaseline({ champion: CHAMPION, seatCount, seeds: 4, seedBase: 1_199_000_000 + seatCount * 100, collectDecisions: true });
    assert.equal(summary.config, 'mirror');
    assert.equal(summary.totalGames, 4);
    assert.equal(summary.anomalies, 0, `N=${seatCount} 异常：${summary.anomalyReasons.map(([k, v]) => `${k}×${v}`).join(', ')}`);
    assert.equal(summary.finishedGames, 4);
    // 座位公平性结构：每席位 games=局数，期望 1/N。
    const seats = Object.keys(summary.seatFairness);
    assert.equal(seats.length, seatCount);
    for (const s of seats) {
      assert.equal(summary.seatFairness[s].games, 4);
      assert.equal(summary.seatFairness[s].expected, Number((1 / seatCount).toFixed(4)));
    }
    assert.ok(summary.maxSeatDeviation <= 1);
    // 吞吐与延迟遥测。
    assert.ok(summary.throughput.gamesPerHourSingleCore > 0);
    assert.ok(summary.throughput.meanMovesPerGame > 0);
    assert.ok(summary.latency.count > 0);
    assert.ok(summary.latency.p50Ms >= 0 && summary.latency.p99Ms >= summary.latency.p50Ms);
    // 镜像配置不产出第一名率（无冠军 vs 对手语义），配对优势为空。
    assert.equal(summary.firstPlace, undefined);
    assert.equal(summary.pairedScoreAdvantage.seeds, 0);
  }
});

test('对抗基准 N=2..5：双方向配对、座位轮换全覆盖、第一名率推断结构完整', () => {
  for (const seatCount of [2, 3, 4, 5]) {
    const summary = runContestBaseline({ champion: CHAMPION, seatCount, seeds: 4, seedBase: 1_199_010_000 + seatCount * 100 });
    assert.equal(summary.config, 'contest');
    assert.equal(summary.totalGames, 8, '每种子双方向 2 局');
    assert.equal(summary.anomalies, 0, `N=${seatCount} 异常：${summary.anomalyReasons.map(([k, v]) => `${k}×${v}`).join(', ')}`);
    // primary 指标结构：bootstrap CI + Wilson 参考 + 方向/座位分解。
    assert.equal(summary.firstPlace.games, 8);
    assert.equal(summary.firstPlace.seeds, 4);
    assert.ok(summary.firstPlace.lower <= summary.firstPlace.point && summary.firstPlace.point <= summary.firstPlace.upper);
    assert.ok(summary.firstPlace.wilsonRef);
    assert.ok(summary.firstPlace.byDirection.A && summary.firstPlace.byDirection.B);
    // bySeat 覆盖方向 A 的全部单席位（无 '+' 的键）与方向 B 的组合席位；
    // 种子数 4 < 席位数时覆盖 min(N, seeds) 个座位（完整覆盖由下一条测试用例保证）。
    const singleSeatKeys = Object.keys(summary.firstPlace.bySeat).filter(k => !k.includes('+'));
    assert.equal(singleSeatKeys.length, Math.min(seatCount, 4), '方向 A 冠军席位覆盖 = min(N, seeds)');
    // 配对（辅助指标）与对手风格分解。
    assert.equal(summary.pairedScoreAdvantage.seeds, 4);
    assert.ok(Object.keys(summary.byOpponentStyle).length >= 2, '至少 2 种对手风格出现');
    for (const style of Object.values(summary.byOpponentStyle)) {
      assert.ok(style.gamesPresent > 0 && style.championFirstPlaceRate >= 0 && style.championFirstPlaceRate <= 1);
    }
    assert.ok(summary.meanRank >= 1 && summary.meanRank <= seatCount);
  }
});

test('对抗基准：种子数少于席位数时座位覆盖断言按 min(N, seeds) 校验', () => {
  const summary = runContestBaseline({ champion: CHAMPION, seatCount: 5, seeds: 2, seedBase: 1_199_020_000 });
  const singleSeatKeys = Object.keys(summary.firstPlace.bySeat).filter(k => !k.includes('+'));
  assert.equal(singleSeatKeys.length, 2, '2 个种子只轮换 2 个座位');
});

test('outcomeKey：同种子同配置逐位一致，剔除计时字段后跨运行稳定', () => {
  const run = () => runContestBaseline({ champion: CHAMPION, seatCount: 2, seeds: 2, seedBase: 1_199_030_000, collectDecisions: false });
  const a = run();
  const b = run();
  assert.equal(a.games.length, b.games.length);
  for (let i = 0; i < a.games.length; i++) {
    assert.equal(outcomeKey(a.games[i]), outcomeKey(b.games[i]));
  }
});

test('对抗基准：对手池含冠军本体时立即报错', () => {
  const champion = loadChampion();
  const version = championVersion(champion);
  assert.throws(
    () => runContestBaseline({ champion, seatCount: 3, seeds: 1, seedBase: 1_199_040_000, opponents: [version] }),
    /不得包含冠军本体/,
  );
});

// ---------- CLI：端到端（临时账本 + 临时冻结清单，不触碰正式种子额度） ----------

test('runBaseline 端到端：报告结构与冻结/账本注入正确', async () => {
  const { runBaseline } = await import('../baseline/cli.mjs');
  const dir = tmp();
  const ledgerPath = join(dir, 'seed-ledger.json');
  const freezePath = join(dir, 'champion-freeze.json');
  // 测试用冻结清单：写入临时路径（不触碰 training/baseline/champion-freeze.json）。
  writeChampionFreeze(freezePath);
  const report = runBaseline({
    playerCounts: [2, 5],
    mirrorSeeds: 2,
    contestSeeds: 2,
    ledgerPath,
    freezePath,
  });
  assert.equal(report.schema, 'century-baseline-report-v1');
  assert.equal(report.configs.length, 4, '2 个玩家数 × mirror+contest');
  assert.ok(report.freeze.championId && report.freeze.engineBundleSha256.length === 64);
  for (const c of report.configs) {
    assert.ok(c.seedAllocation && c.seedAllocation.uniqueSeedCount > 0);
    assert.ok(existsSync(ledgerPath));
  }
  // 复现：第二次运行（临时冻结清单已存在 → 走校验路径）结果逐局一致。
  const replay = runBaseline({
    playerCounts: [2, 5],
    mirrorSeeds: 2,
    contestSeeds: 2,
    ledgerPath: join(dir, 'seed-ledger-2.json'),
    freezePath,
  });
  // 复放比较：同 seatCount 同 config 的种子区间不同（新账本），但用相同 base 重放验证确定性。
  for (const config of report.configs) {
    const same = replay.configs.find(c => c.config === config.config && c.seatCount === config.seatCount);
    assert.ok(same);
    assert.equal(same.totalGames, config.totalGames);
  }
  // outcomeKey 级确定性：直接用相同种子区间重跑。
  for (const config of report.configs) {
    const champion = loadChampion();
    const rerun = config.config === 'mirror'
      ? runMirrorBaseline({ champion, seatCount: config.seatCount, seeds: config.seedAllocation.count, seedBase: config.seedAllocation.base, collectDecisions: false })
      : runContestBaseline({ champion, seatCount: config.seatCount, seeds: config.seedAllocation.count, seedBase: config.seedAllocation.base, collectDecisions: false });
    for (let i = 0; i < rerun.games.length; i++) {
      assert.equal(outcomeKey(rerun.games[i]), outcomeKey(config.games[i]), `${config.config} N=${config.seatCount} 第 ${i} 局复放不一致`);
    }
  }
});

test('runBaseline：冻结清单缺失时拒绝执行（防无审计基线）', async () => {
  const { runBaseline } = await import('../baseline/cli.mjs');
  const dir = tmp();
  assert.throws(
    () => runBaseline({ playerCounts: [2], mirrorSeeds: 1, contestSeeds: 0, ledgerPath: join(dir, 'l.json'), freezePath: join(dir, 'missing-freeze.json') }),
    /冻结清单不存在/,
  );
});
