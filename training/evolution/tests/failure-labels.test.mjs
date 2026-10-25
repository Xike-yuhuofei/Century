/** D5 失败诊断标签：可复现、证据分层、研究提示 advisoryOnly、不奖励化。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FAILURE_LABELS, labelsFromDiagnosticsAnalysis, labelsFromHumanAnalytics,
  labelsFromGameFacts, mergeLabels, toResearchHints, RESEARCH_HINT_DISCIPLINE,
} from '../failure-labels.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { canonicalJSON } from '../core.mjs';

const ANALYSIS_PATH = resolve(REPO_ROOT, 'training/reports/diagnostics-latest/analysis.json');

test('六类标签齐全且顺序稳定', () => {
  assert.deepEqual(FAILURE_LABELS.map(x => x.code), [
    'engine-deficiency', 'claim-delay', 'rest-waste', 'capacity-waste', 'endgame-error', 'contest-loss',
  ]);
});

test('读取现有 diagnostics/analyze 输出：确定性、证据可追溯、不把推测当证据', () => {
  const analysis = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf8'));
  const first = labelsFromDiagnosticsAnalysis(analysis);
  const second = labelsFromDiagnosticsAnalysis(analysis);
  assert.equal(canonicalJSON(first), canonicalJSON(second));
  assert.equal(first.rows.length, analysis.findings.length);
  const row = first.rows[0];
  assert.equal(row.labels.length, FAILURE_LABELS.length);
  for (const label of row.labels) {
    assert.ok(['finding', 'inconclusive', 'absent'].includes(label.status));
    assert.equal(typeof label.rule, 'string');
    if (label.status !== 'absent') assert.ok(label.evidence.length > 0, `${label.code} 缺证据`);
  }
  // 推测字段只保留在行级，不进入 label evidence
  assert.equal(row.speculations.length >= 0, true);
  const labelEvidence = row.labels.flatMap(l => l.evidence).join(' ');
  assert.equal(labelEvidence.includes('推测：'), false);
});

test('human-analytics failures 类型映射正确（finding 优先于 inconclusive）', () => {
  const failures = {
    schema: 'test',
    game: { file: 'fixture', hash: 'abc' },
    players: [{
      seat: 1,
      findings: [
        { type: 'rest-cost-high', evidence: ['3 次低价值休息'] },
        { type: 'capacity-waste', evidence: ['丢弃 4 颗'] },
        { type: 'missed-claims', evidence: ['错过 14 分魔像'] },
      ],
      inconclusives: [
        { type: 'rest-cost-high', reason: '重复但 finding 优先' },
        { type: 'goal-competition', reason: '仅 1 次' },
      ],
    }],
  };
  const result = labelsFromHumanAnalytics(failures);
  const labels = Object.fromEntries(result.rows[0].labels.map(l => [l.code, l.status]));
  assert.equal(labels['rest-waste'], 'finding');
  assert.equal(labels['capacity-waste'], 'finding');
  assert.equal(labels['claim-delay'], 'finding');
  assert.equal(labels['endgame-error'], 'finding'); // missed-claims 同时映射终局
  assert.equal(labels['contest-loss'], 'inconclusive');
  assert.equal(labels['engine-deficiency'], 'absent');
});

test('单局事实阈值：引擎不足/竞争/休息/容量/终局', () => {
  const labels = Object.fromEntries(labelsFromGameFacts({
    golems: 1, merchantsAcquired: 2, conversionPer100Actions: 6,
    contestedMisses: 4,
    restRatio: 0.3, gameMeanRestRatio: 0.1,
    crystalsDiscarded: 5,
    triggerRank: 5, triggerCount: 5, postTriggerMissed: 3,
  }).map(l => [l.code, l.status]));
  for (const [code, status] of Object.entries(labels)) {
    if (code === 'capacity-waste') continue;
    assert.equal(status, 'finding', `${code} 应为 finding`);
  }
  assert.equal(labels['capacity-waste'], 'finding');
  const absent = Object.fromEntries(labelsFromGameFacts({
    golems: 4, merchantsAcquired: 5, conversionPer100Actions: 20,
    contestedMisses: 0, restRatio: 0.1, gameMeanRestRatio: 0.1,
    crystalsDiscarded: 0, triggerRank: 1, triggerCount: 5, postTriggerMissed: 0,
  }).map(l => [l.code, l.status]));
  assert.equal(Object.values(absent).every(s => s === 'absent'), true);
});

test('合并 + 研究提示：suggestedTargets 来自标签，advisoryOnly/notRewardTruth', () => {
  const analysis = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf8'));
  const merged = mergeLabels([labelsFromDiagnosticsAnalysis(analysis)]);
  assert.equal(merged.labels.length, FAILURE_LABELS.length);
  const hints = toResearchHints(merged);
  assert.equal(hints.discipline.advisoryOnly, true);
  assert.equal(hints.discipline.notRewardTruth, true);
  assert.equal(hints.discipline.rewardModified, false);
  assert.equal(hints.curriculum.advisoryOnly, true);
  assert.equal(hints.curriculum.rewardModified, false);
  assert.ok(Array.isArray(hints.suggestedTargets));
  assert.match(hints.hintDigest, /^[0-9a-f]{64}$/);
  assert.equal('reward' in hints.curriculum, false);
  assert.equal(RESEARCH_HINT_DISCIPLINE.canPromote, false);
  // 同输入同输出
  assert.equal(hints.hintDigest, toResearchHints(mergeLabels([labelsFromDiagnosticsAnalysis(analysis)])).hintDigest);
});
