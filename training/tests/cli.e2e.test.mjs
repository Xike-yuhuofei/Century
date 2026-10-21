/** 训练系统测试：evolve-cli 端到端（审计整改：CI 必须覆盖晋级自动化全链路）。
 * 以子进程真实执行 CLI：进化 → 状态落盘 → 报告产出 →（达标时）验证种子记账。
 * 运行前需先构建 web-v1（npm run build）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAINING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(TRAINING_ROOT, '..');

test('evolve-cli 端到端：进化 → 状态/账本/报告完整落盘', { timeout: 300_000 }, () => {
  const outDir = mkdtempSync(join(tmpdir(), 'evolve-e2e-'));
  execFileSync(process.execPath, [
    join(TRAINING_ROOT, 'optimizer', 'evolve-cli.mjs'),
    '--generations', '1',
    '--population', '1',
    '--games-per-candidate', '1',
    '--confirm-seeds', '2',
    '--min-seeds', '2',
    '--time-budget-min', '10',
    '--seed-base', '777000',
    '--pool-size', '1',
    '--out', outDir,
  ], { cwd: REPO_ROOT, stdio: 'pipe' });

  // 进化状态与实验日志必须落盘（次日 --resume 与审计依赖它们）。
  assert.ok(existsSync(join(outDir, 'state.json')), 'state.json 必须落盘');
  assert.ok(existsSync(join(outDir, 'experiments.jsonl')), 'experiments.jsonl 必须落盘');
  const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
  assert.equal(report.generations, 1);
  // 冠军基准动态读取：晋级后 evolve 以新冠军为基准，测试不得硬编码冠军 id。
  const championRecord = JSON.parse(readFileSync(join(TRAINING_ROOT, 'champions', 'champion.json'), 'utf8'));
  assert.equal(report.champion, championRecord.parameters?.id ?? championRecord.id);
  assert.equal(report.opponents.length, 1, 'pool-size 1 时对手池退化为仅冠军');
  assert.ok(Array.isArray(report.history) && report.history.length === 1);
  // 断点续训状态完整性：恢复所需字段齐全。
  const state = JSON.parse(readFileSync(join(outDir, 'state.json'), 'utf8'));
  assert.equal(state.generation, 1);
  // P0 回归：--seed-base 必须真正驱动训练种子游标
  // （population 1 × 1 代：rng 消费 +1、候选种子块 +1 → 777000 + 2）。
  assert.equal(state.seedCursor, 777002, `CLI 的 --seed-base 未透传到进化器：游标 ${state.seedCursor}`);
  assert.ok(Number.isFinite(state.seedCursor));
  assert.ok('interrupted' in state, '状态必须记录中断标记');
  assert.equal(state.championId, report.champion, '状态必须记录冠军身份（切换检测依赖）');
  assert.ok(typeof state.championFingerprint === 'string', '状态必须记录冠军指纹');

  // P1 回归：账本必须无条件落盘（即使本次未触发确认挑战也续接旧账本），
  // 否则工作流归集不到账本，下次运行会重复消费验证种子块。
  assert.ok(existsSync(join(outDir, 'validation-ledger.json')), 'validation-ledger.json 必须无条件落盘');
  const ledger = JSON.parse(readFileSync(join(outDir, 'validation-ledger.json'), 'utf8'));
  assert.ok(Array.isArray(ledger.history), '账本必须含 history 字段');

  // 若候选通过快速筛选并完成确认挑战，验证种子账本必须落盘且不与默认池重叠。
  if (existsSync(join(outDir, 'candidate.json'))) {
    const candidate = JSON.parse(readFileSync(join(outDir, 'candidate.json'), 'utf8'));
    assert.ok(candidate.confirmation.decision.promote === true);
    assert.ok(candidate.confirmation.seedBase >= 900_000_000, '验证种子必须来自验证种子池');
    const ledger = JSON.parse(readFileSync(join(outDir, 'validation-ledger.json'), 'utf8'));
    assert.equal(ledger.lastBase, candidate.confirmation.seedBase);
  }
});

test('evolve-cli 断点续训：--resume 从上次状态继续且种子游标单调前进', { timeout: 300_000 }, () => {
  const outDir = mkdtempSync(join(tmpdir(), 'evolve-resume-'));
  const common = [
    join(TRAINING_ROOT, 'optimizer', 'evolve-cli.mjs'),
    '--population', '1',
    '--games-per-candidate', '1',
    '--confirm-seeds', '2',
    '--min-seeds', '2',
    '--time-budget-min', '10',
    '--seed-base', '888000',
    '--pool-size', '1',
    '--out', outDir,
  ];
  execFileSync(process.execPath, [...common, '--generations', '1'], { cwd: REPO_ROOT, stdio: 'pipe' });
  const first = JSON.parse(readFileSync(join(outDir, 'state.json'), 'utf8'));
  execFileSync(process.execPath, [...common, '--generations', '1', '--resume', join(outDir, 'state.json')], { cwd: REPO_ROOT, stdio: 'pipe' });
  const second = JSON.parse(readFileSync(join(outDir, 'state.json'), 'utf8'));
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2, '恢复后必须从上次代数继续');
  assert.ok(second.seedCursor > first.seedCursor, '种子游标必须跨会话单调前进');
  assert.equal(second.history.length, 2, '历史必须累积');
});
