/** P0.2 验收：研究索引必须记录研究上下文哈希、生成配置与行为哈希。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchIndex } from '../research-index.mjs';

function tempIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'ai11-index-'));
  const path = join(dir, 'research-index.jsonl');
  return { path, index: createResearchIndex({ path, campaignId: 'ai11-test' }) };
}

function readRecords(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const artifact = {
  candidateId: 'cand-test-1',
  parentId: 'cand-parent',
  identityDigest: 'a'.repeat(64),
  artifactHash: 'b'.repeat(64),
  sourceHash: 'c'.repeat(64),
  buildArtifact: { sha256: 'd'.repeat(64) },
  source: { modules: [{ id: 'M01' }] },
  algorithmStructure: { evaluationMode: 'game' },
};

test('candidate 记录研究上下文哈希与 LLM 核算', () => {
  const { path, index } = tempIndex();
  const record = index.candidate({
    artifact,
    strategy: 'openevolve',
    generator: 'openevolve-llm',
    experiment: { configRef: 'ai9://campaign/coevolution', round: 3 },
    hypothesisId: 'H3A',
    researchContextHash: 'e'.repeat(64),
    llm: { calls: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120, billing: 'unknown' },
  });
  assert.equal(record.schema, 'century-research-candidate-v1');
  assert.equal(record.researchContextHash, 'e'.repeat(64));
  assert.equal(record.hypothesisId, 'H3A');
  assert.equal(record.llm.totalTokens, 120);
  assert.equal(record.llm.billing, 'unknown');
  assert.match(record.recordHash, /^[0-9a-f]{64}$/);
});

test('非法 researchContextHash 被拒绝（不能伪造上下文）', () => {
  const { index } = tempIndex();
  assert.throws(() => index.candidate({ artifact, researchContextHash: 'not-a-hash' }), /researchContextHash 非法/);
});

test('lineage 记录完整哈希链、生成配置与假设', () => {
  const { path, index } = tempIndex();
  index.lineage({
    candidateId: 'cand-test-1',
    lineage: {
      parentCandidateId: 'cand-parent',
      parentSourceHash: '1'.repeat(64),
      inputProgramHash: '2'.repeat(64),
      outputProgramHash: '3'.repeat(64),
      bestProgramHash: '4'.repeat(64),
      modulesChanged: ['M02'],
      operator: 'openevolve-llm',
      hypothesisId: 'H3A',
      configPath: 'training/reports/coevolution/x/openevolve-configs/r003.yaml',
      checkpointResumedFrom: '/tmp/ckpt',
    },
  });
  const [record] = readRecords(path);
  assert.equal(record.bestProgramHash, '4'.repeat(64));
  assert.equal(record.hypothesisId, 'H3A');
  assert.equal(record.configPath.endsWith('r003.yaml'), true);
  assert.equal(record.checkpointResumedFrom, '/tmp/ckpt');
});

test('experiment 记录假设结论、种子与模块范围', () => {
  const { path, index } = tempIndex();
  index.experiment({
    hypothesisId: 'H3A',
    candidateId: 'cand-test-1',
    stage: 'deep',
    metrics: { pairs: 8, firstPlaceDelta: 0.25 },
    verdict: 'supported',
    seeds: [1670500000, 1670500001],
    evidenceHash: 'a'.repeat(64),
    moduleScope: ['M02'],
  });
  const [record] = readRecords(path);
  assert.equal(record.schema, 'century-research-experiment-v1');
  assert.equal(record.verdict, 'supported');
  assert.equal(record.moduleScope[0], 'M02');
  assert.equal(record.seeds.length, 2);
});

test('evaluation 记录行为探针哈希与种子批次', () => {
  const { path, index } = tempIndex();
  index.evaluation({
    candidateId: 'cand-test-1',
    stage: 'deep',
    evidence: {
      metrics: { pairs: 4, firstPlaceDelta: 0.25, anomalyRate: 0 },
      seedWindow: { windowId: 'ai9-deep-w1', count: 4 },
      behaviorHash: 'f'.repeat(64),
    },
  });
  const [record] = readRecords(path);
  assert.equal(record.behaviorHash, 'f'.repeat(64));
  assert.equal(record.seedWindow.windowId, 'ai9-deep-w1');
  assert.equal(record.firstPlaceDelta, 0.25);
});
