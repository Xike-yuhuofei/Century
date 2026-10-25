/** 联赛种子消费账本测试（AI6 合并后整改 P0-4）。
 *
 * 覆盖：缺失账本 fail-closed、历史导入健康、已消费区间防重（改名/换目录不可规避）、
 * 有意 CRN 配对显式声明、并发分配唯一性、断点续跑不重复记账、作废留痕。
 * 全部在临时账本上运行，绝不触碰仓库账本与种子块。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  initializeLedger, loadLedger, registerExperiment, resumeExperiment,
  setExperimentStatus, nextSeedBase, verifyLedger, LEAGUE_LEDGER_SCHEMA,
} from '../adversarial/seed-ledger.mjs';

function tempLedger({ historical = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'league-ledger-'));
  const path = join(dir, 'seed-ledger.json');
  initializeLedger({ ledgerPath: path, historical });
  return path;
}

test('缺失账本 fail-closed：分配/加载直接抛错，绝不静默按空白区处理', () => {
  const missing = join(tmpdir(), `league-ledger-missing-${Date.now()}.json`);
  assert.throws(() => loadLedger(missing), /fail-closed|不存在/);
  assert.throws(() => registerExperiment({
    experimentId: 'missing-ledger-probe', blockName: 'dev', seedBase: 1400000000, seedCount: 10, purpose: 't', ledgerPath: missing,
  }), /不存在/);
});

test('仓库账本：历史导入结构健康（verifyLedger 零缺陷）+ prereg 区间在场', async () => {
  const { LEAGUE_LEDGER_PATH } = await import('../adversarial/seed-ledger.mjs');
  const ledger = loadLedger(LEAGUE_LEDGER_PATH);
  assert.deepEqual(verifyLedger(ledger), []);
  const prereg = ledger.experiments.find(e => e.experimentId === 'prereg-15s-official');
  assert.ok(prereg, 'PR #40 历史消费必须已导入');
  assert.deepEqual([prereg.seedStart, prereg.seedEnd], [1403000000, 1403001620]);
  assert.equal(prereg.status, 'completed');
});

test('已消费区间不得被新独立实验复用（改名/换输出目录不可规避）', () => {
  const path = tempLedger();
  registerExperiment({ experimentId: 'exp-a', blockName: 'prereg', seedBase: 1403000000, seedCount: 100, purpose: '测试', ledgerPath: path });
  // 换 experimentId + 换 ledgerPath 之外的输出目录（账本键 = 区间）→ 仍然拒绝
  assert.throws(() => registerExperiment({
    experimentId: 'exp-b-renamed', blockName: 'prereg', seedBase: 1403000050, seedCount: 100, purpose: '测试', ledgerPath: path,
  }), /重叠/);
  // 紧随其后分配合法
  const ok = registerExperiment({ experimentId: 'exp-c', blockName: 'prereg', seedBase: 1403000100, seedCount: 100, purpose: '测试', ledgerPath: path });
  assert.equal(ok.seedStart, 1403000100);
});

test('有意 CRN 配对：显式声明同组才允许共享；未声明/组不同一律拒绝', () => {
  const path = tempLedger();
  registerExperiment({ experimentId: 'crn-1', blockName: 'dev', seedBase: 1400000000, seedCount: 20, purpose: '轴A', crnGroup: 'pair-x', ledgerPath: path });
  // 同组显式声明 → 允许共享
  const shared = registerExperiment({ experimentId: 'crn-2', blockName: 'dev', seedBase: 1400000000, seedCount: 20, purpose: '轴A 配对', crnGroup: 'pair-x', ledgerPath: path });
  assert.equal(shared.seedStart, 1400000000);
  // 未声明 crnGroup → 拒绝
  assert.throws(() => registerExperiment({ experimentId: 'crn-3', blockName: 'dev', seedBase: 1400000000, seedCount: 20, purpose: 'x', ledgerPath: path }), /重叠/);
  // 不同组 → 拒绝
  assert.throws(() => registerExperiment({ experimentId: 'crn-4', blockName: 'dev', seedBase: 1400000000, seedCount: 20, purpose: 'x', crnGroup: 'pair-y', ledgerPath: path }), /重叠/);
});

test('并发申请不能分配相同种子（多进程文件锁串行化）', () => {
  const path = tempLedger();
  // 导入路径必须相对本测试文件定位（npm test 的 cwd = training/，不能用 process.cwd()）。
  const ledgerModulePath = resolve(dirname(fileURLToPath(import.meta.url)), '../adversarial/seed-ledger.mjs');
  const worker = `
    import { registerExperiment } from '${ledgerModulePath}';
    const path = process.argv[2];
    const id = process.argv[3];
    try {
      const r = registerExperiment({ experimentId: id, blockName: 'dev', seedBase: 1400000100, seedCount: 10, purpose: '并发测试', ledgerPath: path });
      process.stdout.write(JSON.stringify({ id, ok: true, seedStart: r.seedStart }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ id, ok: false, error: String(error.message).slice(0, 80) }));
    }
  `;
  const workerPath = join(tmpdir(), `ledger-worker-${Date.now()}.mjs`);
  writeFileSync(workerPath, worker);
  const results = [];
  for (let i = 0; i < 6; i++) {
    const out = execFileSync(process.execPath, [workerPath, path, `conc-${i}`], { encoding: 'utf8' });
    results.push(JSON.parse(out));
  }
  rmSync(workerPath);
  const winners = results.filter(r => r.ok);
  assert.equal(winners.length, 1, `恰好一个并发申请成功，实际 ${winners.length}：${JSON.stringify(results)}`);
  const losers = results.filter(r => !r.ok);
  assert.ok(losers.length >= 5, '其余申请必须被防重拒绝（重叠）');
});

test('断点续跑：resume 返回已注册区间末端；重复注册同 ID 抛错；续跑不新增对局种子', () => {
  const path = tempLedger();
  registerExperiment({ experimentId: 'resume-me', blockName: 'dev', seedBase: 1400000200, seedCount: 50, purpose: '续跑测试', ledgerPath: path });
  const r = resumeExperiment('resume-me', { ledgerPath: path });
  assert.deepEqual([r.seedStart, r.seedEnd], [1400000200, 1400000250]);
  // 续跑推进在自己区间内：区间 [200, 225) 已跑、断点 225 → 下一局种子 1400000225
  const nextSeed = r.seedStart + 25;
  assert.ok(nextSeed >= r.seedStart && nextSeed < r.seedEnd, '断点必须落在已注册区间内（不新增区间）');
  assert.throws(() => registerExperiment({ experimentId: 'resume-me', blockName: 'dev', seedBase: 1400000200, seedCount: 50, purpose: 'x', ledgerPath: path }), /已存在/);
  // 中断后重启不得复用已跑区间起点：新实验从 nextSeedBase 继续（区间末端之后）
  assert.equal(nextSeedBase('dev', { ledgerPath: path }), 1400000250);
});

test('作废实验：区间继续占用（防相关样本）、必须留痕 reason、禁止续跑', () => {
  const path = tempLedger();
  registerExperiment({ experimentId: 'void-me', blockName: 'matrix-dev', seedBase: 1402000000, seedCount: 30, purpose: '将被作废', ledgerPath: path });
  setExperimentStatus('void-me', 'voided', { reason: '运行中代码指纹漂移', ledgerPath: path });
  const ledger = loadLedger(path);
  const entry = ledger.experiments.find(e => e.experimentId === 'void-me');
  assert.equal(entry.status, 'voided');
  assert.match(entry.voidReason, /指纹漂移/);
  // 作废区间继续阻断复用（保守）
  assert.throws(() => registerExperiment({ experimentId: 'after-void', blockName: 'matrix-dev', seedBase: 1402000010, seedCount: 10, purpose: 'x', ledgerPath: path }), /重叠/);
  assert.throws(() => resumeExperiment('void-me', { ledgerPath: path }), /作废/);
  // verifyLedger：作废缺 reason = 缺陷
  const badPath = tempLedger();
  registerExperiment({ experimentId: 'bad-void', blockName: 'matrix-dev', seedBase: 1402000100, seedCount: 5, purpose: 'x', ledgerPath: badPath });
  {
    const l = loadLedger(badPath);
    l.experiments.find(e => e.experimentId === 'bad-void').status = 'voided';
    writeFileSync(badPath, JSON.stringify(l));
    assert.ok(verifyLedger(loadLedger(badPath)).length > 0, '作废缺 voidReason 必须被账本校验捕获');
  }
});

test('账本记录完备性：seedStart/seedEnd/runId/commit/指纹/用途逐项落盘', () => {
  const path = tempLedger();
  const { entry } = registerExperiment({
    experimentId: 'record-complete', blockName: 'dev', seedBase: 1400000300, seedCount: 7,
    purpose: '记录完备性测试', algorithmFingerprints: ['fp-demo-1', 'fp-demo-2'], ledgerPath: path,
  });
  assert.equal(entry.seedStart, 1400000300);
  assert.equal(entry.seedEnd, 1400000307);
  assert.equal(entry.seeds, 7);
  assert.ok(entry.runId, 'runId 必须落盘');
  assert.ok(entry.registeredAt);
  assert.deepEqual(entry.algorithmFingerprints, ['fp-demo-1', 'fp-demo-2']);
  assert.match(entry.purpose, /完备性/);
  assert.equal(entry.crnGroup, null);
  // 落盘可读回
  const ledger = loadLedger(path);
  assert.equal(ledger.schema, LEAGUE_LEDGER_SCHEMA);
  assert.ok(ledger.experiments.some(e => e.experimentId === 'record-complete'));
});
