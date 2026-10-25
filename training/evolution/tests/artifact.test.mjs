/** D1 Candidate Artifact v1：哈希、封印、打包、注册、加载、复现校验。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCandidateFromSpec } from '../candidate-generator.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { validateArtifact, updateArtifact, seatVersionFor, verifyArtifactReproducibility } from '../candidate-artifact.mjs';
import { runSafetyChecks } from '../safety-check.mjs';
import { sha256Canonical, SCHEMAS } from '../core.mjs';

function experiment() {
  return {
    configRef: 'test://artifact',
    configHash: sha256Canonical({ test: 1 }),
    seedRefs: [
      { purpose: 'screen', windowId: 'ai7-screen-w000', base: 1_610_000_000, count: 2 },
      { purpose: 'deep', windowId: 'ai7-deep-w000', base: 1_620_000_000, count: 2 },
    ],
  };
}

function gameCandidate(overrides = {}) {
  return createCandidateFromSpec({
    targetId: 'overrideMargin', values: { overrideMargin: 0.01 },
    round: 1, index: 0, experiment: experiment(), ...overrides,
  }).artifact;
}

function proxyCandidate(overrides = {}) {
  return createCandidateFromSpec({
    targetId: 'acquisitionValue',
    values: { template: 'linear-feature-v1', coefficients: { goalFit: 2.4 } },
    round: 1, index: 1, experiment: experiment(), ...overrides,
  }).artifact;
}

test('artifact v1 包含任务书要求的全部字段', () => {
  const artifact = gameCandidate();
  assert.equal(artifact.schema, SCHEMAS.candidateArtifact);
  for (const key of [
    'candidateId', 'parentId', 'sourceHash', 'algorithmStructure', 'parameters',
    'buildArtifact', 'gameRules', 'experiment', 'applicablePlayerCounts', 'evidenceDir', 'safety',
    'identityDigest', 'artifactHash',
  ]) {
    assert.ok(key in artifact, `缺少字段 ${key}`);
  }
  assert.match(artifact.sourceHash, /^[0-9a-f]{64}$/);
  assert.match(artifact.identityDigest, /^[0-9a-f]{64}$/);
  assert.match(artifact.artifactHash, /^[0-9a-f]{64}$/);
  assert.equal(artifact.buildArtifact.kind, 'descriptor-bundle-v1');
  assert.equal(artifact.buildArtifact.compiled, false);
  assert.ok(artifact.algorithmStructure.jointOptionsByPlayerCount['2']);
  assert.equal(artifact.algorithmStructure.decisionCore, 'champion-guided');
});

test('descriptor 与声明模块候选的身份/构建哈希可复现', () => {
  const game = gameCandidate();
  assert.equal(verifyArtifactReproducibility(game).ok, true);
  const proxy = proxyCandidate();
  assert.equal(proxy.source.kind, 'declarative-module');
  assert.equal(proxy.buildArtifact.kind, 'declarative-module-bundle-v1');
  assert.equal(verifyArtifactReproducibility(proxy).ok, true);
  // 同输入同输出（纯函数）
  const again = gameCandidate();
  assert.equal(again.identityDigest, game.identityDigest);
  assert.equal(again.artifactHash, game.artifactHash);
});

test('篡改源码/构建哈希立即被 validateArtifact 拒绝', () => {
  const artifact = proxyCandidate();
  const tamperedSource = {
    ...artifact,
    source: {
      ...artifact.source,
      files: artifact.source.files.map(f => ({ ...f, content: f.content + ' ' })),
    },
  };
  assert.throws(() => validateArtifact(tamperedSource), /哈希不符|sourceHash/);
  const tamperedBuild = { ...artifact, buildArtifact: { ...artifact.buildArtifact, sha256: '0'.repeat(64) } };
  assert.throws(() => validateArtifact(tamperedBuild), /buildArtifact/);
  const tamperedIdentity = { ...artifact, identityDigest: '0'.repeat(64) };
  assert.throws(() => validateArtifact(tamperedIdentity), /identityDigest/);
});

test('更新证据/安全状态不改变算法身份，但改变全文封印', () => {
  const artifact = gameCandidate();
  const safety = runSafetyChecks(artifact);
  const updated = updateArtifact(artifact, { safety, status: 'checked', evidenceDir: '/tmp/evidence/x' });
  assert.equal(updated.identityDigest, artifact.identityDigest);
  assert.notEqual(updated.artifactHash, artifact.artifactHash);
  assert.equal(validateArtifact(updated), true);
  assert.throws(() => updateArtifact(artifact, { candidateId: 'cand-hacked' }), /不允许/);
});

test('内容寻址仓库：put/get/list/verify 与重复身份保护', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai7-artifact-'));
  const store = new ArtifactStore({ root: join(dir, 'artifacts') });
  const artifact = proxyCandidate();
  const first = store.put(artifact);
  assert.equal(first.created, true);
  assert.deepEqual(store.list().map(x => x.candidateId), [artifact.candidateId]);
  assert.equal(store.get(artifact.candidateId).identityDigest, artifact.identityDigest);
  assert.equal(store.verify(artifact.candidateId).ok, true);

  // 同 id 不同身份：禁止覆盖历史候选
  const other = createCandidateFromSpec({
    targetId: 'acquisitionValue',
    values: { template: 'linear-feature-v1', coefficients: { goalFit: 1.1 } },
    round: 1, index: 1, candidateId: artifact.candidateId, experiment: experiment(),
  }).artifact;
  assert.notEqual(other.identityDigest, artifact.identityDigest);
  assert.throws(() => store.put(other), /身份不同|禁止覆盖/);
});

test('artifact 持久化文件可被独立加载并复现（模拟人工搬运替代）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai7-artifact-load-'));
  const store = new ArtifactStore({ root: join(dir, 'artifacts') });
  const artifact = gameCandidate();
  const { path } = store.put(artifact);
  const fromDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(validateArtifact(fromDisk), true);
  assert.equal(fromDisk.identityDigest, artifact.identityDigest);
  // 独立 seat 解析：按人数给出适配器选项，且不触碰冠军参数
  const seat2 = seatVersionFor(fromDisk, 2);
  assert.equal(seat2.jointOptions.overrideMargin, 0.01);
  assert.equal(seat2.jointOptions.workUnits, 32);
  assert.equal(seat2.parameters.id, artifact.candidateId);
});
