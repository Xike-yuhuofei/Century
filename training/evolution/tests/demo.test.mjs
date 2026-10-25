/** D6 轻量闭环演示（假评估器版本）：验证演示逻辑与护栏，不跑真实对局。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDemo } from '../demo.mjs';
import { readJSON } from '../../lib/io.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';

test('演示闭环：多候选/安全检查/失败隔离/停止恢复/待审批/诊断回流/冠军不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai7-demo-test-'));
  const summary = await runDemo({
    rootDir: root,
    useFakeEvaluator: true,
    firstRunMaxSteps: 5,
    clean: true,
  });
  assert.equal(summary.ok, true, JSON.stringify(summary.checks));
  assert.equal(summary.status, 'completed');
  assert.equal(summary.firstRunStatus, 'stopped');
  assert.ok(summary.candidateCount >= 4);
  assert.ok(summary.safetyFailed.length >= 1);
  assert.ok(summary.rejectedAtGeneration.length >= 1);
  assert.ok(summary.selected.length >= 2);
  assert.ok(summary.deepConfirmed.length >= 1);
  assert.ok(summary.pendingApprovals.length >= 1);
  assert.equal(summary.pendingApprovals[0].status, 'pending-human-approval');
  assert.equal(summary.pendingApprovals[0].promotionTriggered, false);
  assert.equal(summary.guardrails.championAndLedgerUnchanged, true);
  assert.equal(summary.guardrails.validationPoolConsumed, false);
  assert.ok(summary.diagnostics.findings.length >= 1);
  assert.ok(summary.diagnostics.suggestedTargets.length >= 1);
  assert.equal(summary.diagnostics.advisoryOnly, true);
  assert.equal(summary.diagnostics.notRewardTruth, true);

  for (const path of Object.values(summary.paths)) {
    assert.ok(existsSync(typeof path === 'string' ? resolve(REPO_ROOT, path) : path), `缺少演示产物：${path}`);
  }
  const persisted = readJSON(join(root, 'demo-summary.json'));
  assert.equal(persisted.ok, true);
  assert.equal(persisted.pendingApprovals.length, summary.pendingApprovals.length);
  assert.ok(existsSync(join(root, 'logs', 'events.jsonl')));
  assert.ok(existsSync(join(root, 'checkpoints')));
});
