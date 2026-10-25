/** P0：研究 fitness 主指标迁移——焦点席位配对第一名率模式。
 *
 * 候选=官方代码时，A/B 两局完全一致，delta 必须为 0；用于验证：
 * - `--primary first-place` 生成 firstPlacePairs / firstPlaceDelta；
 * - 焦点席位随 seedIndex 轮换；
 * - 输出 schema 与训练侧 first-place 证据一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const runner = join(repoRoot, 'ai5/openevolve/node/duel_runner.mjs');

test('研究 fitness：焦点席位第一名率模式（固定 workUnits，候选=官方 → delta 0）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duel-firstplace-'));
  const out = join(dir, 'result.json');
  try {
    // 固定 workUnits：官方冠军缺省走 100ms 墙钟，同一 seed 的 A/B 决策可能不同；
    // 研究配对必须固定工作量才能得到逐位可复现的配对样本（P3）。
    execFileSync(process.execPath, [
      runner, '--candidate-official', '--primary', 'first-place', '--work-units', '8',
      '--seeds', '2', '--seed-base', '300000000', '--out', out,
    ], { encoding: 'utf8', cwd: repoRoot, timeout: 600_000 });
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.config.primary, 'first-place');
    assert.equal(result.config.workUnits, 8);
    assert.equal(result.stats.primaryMetric, 'pairedFirstPlaceRateDelta');
    assert.equal(result.stats.firstPlacePairs.length, 2);
    assert.equal(result.stats.firstPlacePairs[0].focusSeat, 0);
    assert.equal(result.stats.firstPlacePairs[1].focusSeat, 1);
    assert.equal(result.stats.totalGames, 4);
    for (const pair of result.stats.firstPlacePairs) {
      assert.equal(pair.candidateFirst, pair.championFirst, '候选=官方时必须同结果');
    }
    assert.equal(result.stats.firstPlaceDelta.ci.mean, 0);
    assert.equal(result.stats.firstPlaceDelta.status, 'analyzed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
