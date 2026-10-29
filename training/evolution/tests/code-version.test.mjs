/** 代码版本身份：R09 长时运行必须绑定可复算的决策代码摘要。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_VERSION_SCHEMA, computeCodeVersion, sameCodeDigest, CODE_VERSION_EVOLUTION_FILES,
  isRuntimeStatePath, statusPath,
} from '../../lib/code-version.mjs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../lib/paths.mjs';

test('代码身份：HEAD、构建清单、决策源与进化器源码均可复算', () => {
  const version = computeCodeVersion();
  assert.equal(version.schema, CODE_VERSION_SCHEMA);
  assert.match(version.headCommit, /^[0-9a-f]{40}$/);
  assert.match(version.codeDigest, /^[0-9a-f]{64}$/);
  assert.equal(typeof version.headDirty, 'boolean');
  assert.ok(version.webBuild, '缺少 web 构建清单');
  assert.match(version.webBuild.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(version.webBuild.artifactSha256, /^[0-9a-f]{64}$/);
  for (const rel of CODE_VERSION_EVOLUTION_FILES) {
    assert.match(version.evolutionSources[rel], /^[0-9a-f]{64}$/, `${rel} 缺少源码哈希`);
    assert.equal(resolve(REPO_ROOT, rel).startsWith(REPO_ROOT), true);
  }
});

test('代码身份：同一代码重复计算完全相同，不含时间戳', () => {
  const a = computeCodeVersion();
  const b = computeCodeVersion();
  assert.equal(a.codeDigest, b.codeDigest);
  assert.equal(sameCodeDigest(a, b), true);
  assert.equal(sameCodeDigest(a, { codeDigest: 'f'.repeat(64) }), false);
  assert.equal(sameCodeDigest(null, b), false);
});

test('运行时状态（种子登记/检查点/报告）不计入代码 dirty', () => {
  assert.equal(isRuntimeStatePath('training/governance/seed-consumption-registry.json'), true);
  assert.equal(isRuntimeStatePath('training/reports/coevolution/x/state.json'), true);
  assert.equal(isRuntimeStatePath('training/state/validation-ledger.json'), true);
  assert.equal(isRuntimeStatePath('training/evolution/campaign-controller.mjs'), false);
  assert.equal(statusPath(' M training/governance/alpha-ledger.json'), 'training/governance/alpha-ledger.json');
  assert.equal(statusPath('R  old/path.mjs -> new/path.mjs'), 'new/path.mjs');
  assert.equal(statusPath('?? weird'), 'weird');
  const version = computeCodeVersion();
  assert.equal(version.dirtyFiles.some(isRuntimeStatePath), false,
    `代码身份仍包含运行时状态：${version.dirtyFiles.filter(isRuntimeStatePath).join(', ')}`);
});

test('statusPath 兼容 1–2 个状态字符：runtime 账本不得被误判为脏', async () => {
  const { statusPath, isRuntimeStatePath } = await import('../../lib/code-version.mjs');
  for (const line of [
    'M training/governance/seed-consumption-registry.json',
    ' M training/governance/seed-consumption-registry.json',
    'M  training/governance/seed-consumption-registry.json',
    '?? training/reports/coevolution/x.json',
    'R  old.json -> training/governance/seed-consumption-registry.json',
  ]) {
    const path = statusPath(line);
    assert.ok(path.endsWith('seed-consumption-registry.json') || path.endsWith('x.json'), `解析失败：${line} → ${path}`);
  }
  assert.equal(isRuntimeStatePath('training/governance/seed-consumption-registry.json'), true);
});
