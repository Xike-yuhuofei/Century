/** 训练系统测试：冠军晋级脚本（审计整改 P0：候选归档目录 + champion.json 同步）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAINING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeCandidate(id, promote) {
  return {
    id,
    basedOn: 'v4.0-baseline',
    parameters: {
      id, engineWeight: 1.05, tempoWeight: 0.98, contestWeight: 1.1, synergyWeight: 1,
      goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
    },
    confirmation: {
      seeds: 60, games: 120, winRate: 0.62,
      decision: { promote, verdict: promote ? 'promote' : 'inconclusive', reason: '测试证据' },
    },
    generatedAt: new Date().toISOString(),
  };
}

function runPromote(sandbox, candidate) {
  const candidateFile = join(sandbox, 'candidate.json');
  writeFileSync(candidateFile, JSON.stringify(candidate, null, 2));
  execFileSync(process.execPath, [
    join(TRAINING_ROOT, 'scripts', 'promote-champion.mjs'),
    '--candidate', candidateFile,
    '--champion', join(sandbox, 'champion.json'),
  ], { stdio: 'pipe' });
}

test('晋级脚本：归档候选（自动创建目录）并同步 champion.json', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-ok-'));
  runPromote(sandbox, makeCandidate('evo-g9-test', true));
  // 归档文件存在（目录此前不存在，脚本必须自建）。
  const archiveFile = join(sandbox, 'candidates', 'evo-g9-test.json');
  assert.ok(existsSync(archiveFile), '候选必须归档到 candidates/ 目录');
  // champion.json 已同步为候选参数。
  const champion = JSON.parse(readFileSync(join(sandbox, 'champion.json'), 'utf8'));
  assert.equal(champion.id, 'evo-g9-test');
  assert.equal(champion.parameters.engineWeight, 1.05);
  assert.equal(champion.provenance.basedOn, 'v4.0-baseline');
  assert.ok(champion.provenance.promotionEvidence?.decision?.promote === true, '晋级证据必须写入冠军记录');
});

test('晋级脚本：无 promote 证据的候选必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-no-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-bad', false)),
    /promote/,
    '未通过确认挑战的候选不得晋级',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')), '拒绝时不得改写冠军记录');
});
