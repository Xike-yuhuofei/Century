/** D1/D4 编译型候选：独立 tsc、编译产物哈希、Seatbelt 探针与安全拒绝。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCompiledAcquisitionCandidate, evaluateCompiledProxy, COMPILED_CANDIDATE_INFO,
} from '../compiled-candidate.mjs';
import { createCandidateArtifact, validateArtifact } from '../candidate-artifact.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { runSafetyChecks } from '../safety-check.mjs';
import { evaluateCandidate } from '../dev-evaluator.mjs';
import { scriptedCandidates } from '../candidate-generator.mjs';
import { sha256Canonical, gameRulesDescriptor } from '../core.mjs';

const AVAILABLE = COMPILED_CANDIDATE_INFO.seatbeltAvailable;
const skip = AVAILABLE ? false : 'macOS Seatbelt 不可用（编译型候选 fail closed）';

function experiment() {
  return {
    configRef: 'test://compiled',
    configHash: sha256Canonical({ test: 'compiled' }),
    seedRefs: [
      { purpose: 'screen', windowId: 'ai7-screen-w000', base: 1_610_000_000, count: 2 },
      { purpose: 'deep', windowId: 'ai7-deep-w000', base: 1_620_000_000, count: 2 },
    ],
  };
}

test('真实编译候选：静态检查→tsc→编译产物哈希→artifact 注册/加载/复现', { skip }, () => {
  const built = createCompiledAcquisitionCandidate({ experiment: experiment(), round: 1, index: 4 });
  const artifact = built.artifact;
  assert.equal(artifact.source.kind, 'esm-module-bundle');
  assert.equal(artifact.buildArtifact.compiled, true);
  assert.equal(artifact.buildArtifact.kind, 'esm-module-bundle-v1');
  assert.match(artifact.buildArtifact.compiler, /^tsc \d+\./);
  assert.ok(artifact.buildArtifact.files.length >= 1);
  assert.equal(artifact.buildArtifact.files[0].path, 'dist/js/ai/evaluator.js');
  assert.equal(validateArtifact(artifact), true);

  const dir = mkdtempSync(join(tmpdir(), 'ai7-compiled-store-'));
  const store = new ArtifactStore({ root: join(dir, 'artifacts') });
  assert.equal(store.put(artifact).created, true);
  assert.equal(store.get(artifact.candidateId).identityDigest, artifact.identityDigest);
  assert.equal(store.verify(artifact.candidateId).ok, true);
});

test('编译产物内容被篡改立即被哈希校验拒绝', { skip }, () => {
  const built = createCompiledAcquisitionCandidate({ experiment: experiment(), round: 1, index: 4 });
  const tampered = {
    ...built.artifact,
    buildArtifact: {
      ...built.artifact.buildArtifact,
      files: built.artifact.buildArtifact.files.map(f => ({
        ...f,
        content: `${f.content}\n// tampered`,
      })),
    },
  };
  assert.throws(() => validateArtifact(tampered), /buildArtifact|哈希/);
});

test('安全门禁：编译型候选通过；源码走私 process 被拒绝', { skip }, () => {
  const built = createCompiledAcquisitionCandidate({ experiment: experiment(), round: 1, index: 4 });
  const safety = runSafetyChecks(built.artifact);
  assert.equal(safety.status, 'passed', JSON.stringify(safety.checks.filter(c => c.status === 'fail')));
  assert.ok(safety.checks.some(c => c.id === 'compiled-module' && c.status === 'pass'));

  const maliciousSource = '/* EVOLVE-BLOCK-START */\nexport function acquisitionValue(): number {\n  return process.env.SECRET;\n}\n/* EVOLVE-BLOCK-END */\n';
  const malicious = createCandidateArtifact({
    candidateId: 'cand-ai7-compiled-bad',
    parentId: null,
    algorithmStructure: {
      targetIds: ['acquisitionValue'], decisionCore: 'plugin-only', adapter: null,
      structure: 'compiled-acquisition-bad', jointVersion: null, evaluationMode: 'proxy',
      jointOptionsByPlayerCount: null, integration: 'candidate-plugin-only',
    },
    parameters: { id: 'cand-ai7-compiled-bad', version: 1, values: { kind: 'compiled-acquisition-v1' } },
    source: {
      kind: 'esm-module-bundle',
      files: [{ path: 'src/ai/evaluator.acquisitionValue.fn.ts', content: maliciousSource }],
    },
    experiment: experiment(),
    applicablePlayerCounts: [2, 3, 4, 5],
    safety: { status: 'pending', checks: [] },
    buildInput: {
      kind: 'esm-module-bundle-v1', compiler: 'tsc test',
      files: [{ path: 'dist/js/ai/evaluator.js', content: 'export function acquisitionValue(){ return 1; }' }],
    },
    gameRules: gameRulesDescriptor(),
  });
  const badSafety = runSafetyChecks(malicious);
  assert.equal(badSafety.status, 'failed');
  assert.equal(badSafety.checks.find(c => c.id === 'forbidden-constructs').status, 'fail');
});

test('编译型候选经 Seatbelt 探针产生离线代理证据（不冒充对局强度）', { skip }, () => {
  const built = createCompiledAcquisitionCandidate({ experiment: experiment(), round: 1, index: 4 });
  const evidence = evaluateCandidate({ artifact: built.artifact, round: 1 });
  assert.equal(evidence.evaluationMode, 'proxy');
  assert.equal(evidence.metrics.evidenceType, 'offline-proxy');
  assert.equal(evidence.metrics.moduleForm, 'compiled-esm');
  assert.equal(evidence.metrics.sandbox, 'macos-seatbelt');
  assert.equal(evidence.metrics.probeErrors, 0);
  assert.ok(evidence.metrics.fixtures >= 2);
  assert.equal(Number.isFinite(evidence.metrics.proxyDelta), true);
  assert.match(evidence.behaviorHash, /^[0-9a-f]{64}$/);
  assert.equal(evidence.metrics.productionWiring, 'not-wired');

  const direct = evaluateCompiledProxy({ artifact: built.artifact, round: 1 });
  assert.equal(direct.metrics.proxyDelta, evidence.metrics.proxyDelta);
});

test('脚本化候选在 macOS 上包含一个真实编译候选', { skip }, () => {
  const batch = scriptedCandidates({ experiment: experiment(), round: 1, includeCompiled: true });
  const compiled = batch.candidates.filter(c => c.artifact.buildArtifact.compiled === true);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].artifact.algorithmStructure.targetIds[0], 'acquisitionValue');
});
