/** 代码版本身份：R09 长时运行必须绑定可复算的决策代码摘要。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_VERSION_SCHEMA, computeCodeVersion, sameCodeDigest, CODE_VERSION_EVOLUTION_FILES,
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
