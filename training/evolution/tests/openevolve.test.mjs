/** D2 OpenEvolve 边界：LLM 只产出有界 spec，不产出代码；非法提案隔离。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENEVOLVE_OUTPUT_CONTRACT, parseOpenEvolveProposals, createProposalGenerator, openEvolvePromptContract,
} from '../openevolve-adapter.mjs';
import { sha256Canonical } from '../core.mjs';

function experiment() {
  return {
    configRef: 'test://openevolve',
    configHash: sha256Canonical({ test: 1 }),
    seedRefs: [
      { purpose: 'screen', windowId: 'ai7-screen-w000', base: 1_610_000_000, count: 2 },
      { purpose: 'deep', windowId: 'ai7-deep-w000', base: 1_620_000_000, count: 2 },
    ],
  };
}

test('解析合法 JSON 提案数组 + 非法提案隔离', () => {
  const text = JSON.stringify([
    {
      schema: 'century-ai7-openevolve-proposal-v1',
      targetId: 'acquisitionValue',
      values: { coefficients: { goalFit: 2.4, readiness: 0.2 }, bias: 0.1 },
      rationale: '目标契合度与可负担度联合提升',
    },
    {
      schema: 'century-ai7-openevolve-proposal-v1',
      targetId: 'candidateCap',
      values: { candidateCap: 3 },
      rationale: '减少联合评估候选数，降低延迟',
    },
    {
      schema: 'century-ai7-openevolve-proposal-v1',
      targetId: 'candidateCap',
      values: { candidateCap: 99 },
      rationale: '越界提案必须被拒绝',
    },
    {
      schema: 'century-ai7-openevolve-proposal-v1',
      targetId: 'overrideMargin',
      values: { overrideMargin: 0.05 },
      source: 'import fs from "node:fs"',
      rationale: '夹带源码必须被拒绝',
    },
  ]);
  const parsed = parseOpenEvolveProposals(text, { maxCandidates: 8 });
  assert.equal(parsed.proposals.length, 2);
  assert.equal(parsed.rejected.length, 2);
  assert.equal(parsed.proposals[0].values.coefficients.goalFit, 2.4);
  assert.equal(parsed.proposals[1].values.candidateCap, 3);
  assert.equal(parsed.rejected.every(r => typeof r.error === 'string'), true);
});

test('解析 JSONL 提案 + 上限保护', () => {
  const lines = [
    { schema: 'century-ai7-openevolve-proposal-v1', targetId: 'gateThreshold', values: { contestThreshold: 0.88 }, rationale: 'r1' },
    { schema: 'century-ai7-openevolve-proposal-v1', targetId: 'searchBudget', values: { workUnits: 64 }, rationale: 'r2' },
  ].map(x => JSON.stringify(x)).join('\n');
  const parsed = parseOpenEvolveProposals(lines);
  assert.equal(parsed.proposals.length, 2);
  assert.throws(() => parseOpenEvolveProposals(lines, { maxCandidates: 1 }), /超过上限/);
});

test('非法 schema/未知 target/未知 fields 被拒绝', () => {
  const bad = [
    JSON.stringify([{ schema: 'wrong', targetId: 'candidateCap', values: { candidateCap: 3 } }]),
    JSON.stringify([{ schema: 'century-ai7-openevolve-proposal-v1', targetId: 'unknown', values: {} }]),
    JSON.stringify([{ schema: 'century-ai7-openevolve-proposal-v1', targetId: 'candidateCap', values: { candidateCap: 3 }, code: 'x' }]),
  ];
  assert.equal(parseOpenEvolveProposals(bad[0]).rejected.length, 1);
  assert.equal(parseOpenEvolveProposals(bad[1]).rejected.length, 1);
  assert.equal(parseOpenEvolveProposals(bad[2]).rejected.length, 1);
});

test('提案生成器物化为 Candidate Artifact，且不执行任何 LLM 代码', () => {
  const parsed = parseOpenEvolveProposals(JSON.stringify([
    { schema: 'century-ai7-openevolve-proposal-v1', targetId: 'keepValue', values: { coefficients: { coverage: 2.5 } }, rationale: '容量保留' },
    { schema: 'century-ai7-openevolve-proposal-v1', targetId: 'searchBudgetAllocation', values: { 2: 32, 3: 64, 4: 96, 5: 128 }, rationale: '分人数预算' },
  ]));
  const generator = createProposalGenerator({ proposals: parsed.proposals, round: 3 });
  const batch = generator({ experiment: experiment(), round: 3 });
  assert.equal(batch.candidates.length, 2);
  assert.equal(batch.rejectedAtGeneration.length, 0);
  assert.equal(batch.candidates[0].artifact.algorithmStructure.evaluationMode, 'proxy');
  assert.equal(batch.candidates[1].artifact.algorithmStructure.evaluationMode, 'game');
  assert.equal(batch.candidates[1].artifact.algorithmStructure.jointOptionsByPlayerCount['2'].workUnits, 32);
  assert.equal(batch.candidates[1].artifact.experiment.seedRefs[0].base, 1_610_000_000);
});

test('契约正文只包含有界目标描述，不含密钥/路径/代码模板', () => {
  const prompt = openEvolvePromptContract();
  assert.match(prompt, /century-ai7-openevolve-proposal-v1/);
  assert.match(prompt, /coefficients/);
  assert.doesNotMatch(prompt, /OPENAI|API_KEY|sk-/);
  assert.equal(OPENEVOLVE_OUTPUT_CONTRACT.forbiddenFields.includes('source'), true);
  assert.equal(OPENEVOLVE_OUTPUT_CONTRACT.forbiddenFields.includes('code'), true);
});
