import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSummary, requiredJobs, renderMarkdown } from '../lib/summary.mjs';

const fullScope = {
  build: true, web: true, training: true, ai5: false, ui: true,
  simulation: true, audit: true, research: false, promotion: false, pages: true,
  rules: true, governance: true, docsOnly: false, changedCount: 3, reasons: 'shared-core',
};

const docsScope = {
  build: false, web: false, training: false, ai5: false, ui: false,
  simulation: false, audit: false, research: false, promotion: false, pages: false,
  rules: true, governance: true, docsOnly: true, changedCount: 1, reasons: '',
};

const job = (result = 'success', outputs = {}) => ({ result, outputs });
const baseNeeds = (extra = {}) => ({
  changes: job(),
  'governance-tests': job(),
  'rules-cards': job(),
  ...extra,
});
const fullNeeds = (overrides = {}) => baseNeeds({
  build: job(),
  'web-unit': job(),
  'training-unit': job(),
  simulation: job(),
  'ui-smoke': job(),
  'audit-gate': job(),
  ...overrides,
});
const docsNeeds = () => baseNeeds({
  build: job('skipped'),
  'web-unit': job('skipped'),
  'training-unit': job('skipped'),
  simulation: job('skipped'),
  'ui-smoke': job('skipped'),
  'audit-gate': job('skipped'),
  'research-node': job('skipped'),
  'research-worker': job('skipped'),
  'research-e2e': job('skipped'),
  'research-python': job('skipped'),
  'research-seatbelt': job('skipped'),
  'promotion-gate': job('skipped'),
  'promotion-approval': job('skipped'),
  'pages-deploy': job('skipped'),
});

test('B5 文档变更：仅规则与元测试成功即可放行', () => {
  const result = evaluateSummary({ needs: docsNeeds(), scope: docsScope, eventName: 'pull_request' });
  assert.equal(result.ok, true, result.failures.join('; '));
});

test('B5 正常代码变更：全部分组真实执行成功才放行', () => {
  const result = evaluateSummary({ needs: fullNeeds(), scope: fullScope, eventName: 'pull_request' });
  assert.equal(result.ok, true, result.failures.join('; '));
});

test('B5 错误构建产物：build 失败 → 汇总失败', () => {
  const result = evaluateSummary({ needs: fullNeeds({ build: job('failure') }), scope: fullScope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /build: failure/);
});

test('B5 测试超时：web-unit cancelled 不得视为通过', () => {
  const result = evaluateSummary({ needs: fullNeeds({ 'web-unit': job('cancelled') }), scope: fullScope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /web-unit: cancelled/);
});

test('B5 审计失败：audit-gate 失败 → 汇总失败', () => {
  const result = evaluateSummary({ needs: fullNeeds({ 'audit-gate': job('failure') }), scope: fullScope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /audit-gate: failure/);
});

test('关键检查被静默跳过 → 汇总失败', () => {
  const result = evaluateSummary({ needs: fullNeeds({ 'web-unit': job('skipped') }), scope: fullScope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /web-unit: skipped/);
});

test('必需作业根本不存在于 needs → 汇总失败', () => {
  const needs = fullNeeds();
  delete needs['training-unit'];
  const result = evaluateSummary({ needs, scope: fullScope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /training-unit/);
});

test('changes 失败时不得继续放行', () => {
  const needs = docsNeeds();
  needs.changes = job('failure');
  const result = evaluateSummary({ needs, scope: docsScope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
});

test('B5 冠军晋级：REQUIRES_APPROVAL + 独立人工批准成功才放行', () => {
  const scope = { ...fullScope, promotion: true, pages: false };
  const needs = fullNeeds({
    'audit-gate': job('skipped'),
    'promotion-gate': job('failure', { verdict: 'REQUIRES_APPROVAL', requires_approval: 'true' }),
    'promotion-approval': job('success'),
  });
  const result = evaluateSummary({
    needs, scope, eventName: 'pull_request', promotionVerdict: 'REQUIRES_APPROVAL', promotionRequiresApproval: true,
  });
  assert.equal(result.ok, true, result.failures.join('; '));
  assert.equal(result.promotion.verdict, 'REQUIRES_APPROVAL');
  assert.match(renderMarkdown(result, scope), /REQUIRES_APPROVAL/);
});

test('REQUIRES_APPROVAL 未被人工批准 → 汇总失败', () => {
  const scope = { ...fullScope, promotion: true, pages: false };
  const needs = fullNeeds({
    'audit-gate': job('skipped'),
    'promotion-gate': job('failure', { verdict: 'REQUIRES_APPROVAL', requires_approval: 'true' }),
    'promotion-approval': job('skipped'),
  });
  const result = evaluateSummary({
    needs, scope, eventName: 'pull_request', promotionVerdict: 'REQUIRES_APPROVAL', promotionRequiresApproval: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /promotion-approval: skipped/);
});

test('REQUIRES_APPROVAL 被错误转换为成功 → 汇总失败（防止伪装）', () => {
  const scope = { ...fullScope, promotion: true, pages: false };
  const needs = fullNeeds({
    'audit-gate': job('skipped'),
    'promotion-gate': job('success', { verdict: 'REQUIRES_APPROVAL', requires_approval: 'true' }),
    'promotion-approval': job('success'),
  });
  const result = evaluateSummary({
    needs, scope, eventName: 'pull_request', promotionVerdict: 'REQUIRES_APPROVAL', promotionRequiresApproval: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /不得被转换为成功/);
});

test('晋级证据 PASS：不需要人工批准作业', () => {
  const scope = { ...fullScope, promotion: true, pages: false };
  const needs = fullNeeds({
    'audit-gate': job('skipped'),
    'promotion-gate': job('success', { verdict: 'PASS', requires_approval: 'false' }),
    'promotion-approval': job('skipped'),
  });
  const result = evaluateSummary({ needs, scope, eventName: 'pull_request', promotionVerdict: 'PASS' });
  assert.equal(result.ok, true, result.failures.join('; '));
});

test('晋级门禁缺少 verdict → 失败关闭', () => {
  const scope = { ...fullScope, promotion: true, pages: false };
  const needs = fullNeeds({
    'audit-gate': job('skipped'),
    'promotion-gate': job('failure', {}),
    'promotion-approval': job('skipped'),
  });
  const result = evaluateSummary({ needs, scope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /缺少结构化 verdict/);
});

test('非晋级 PR 不要求 promotion 作业，普通 PR 不会被历史晋级阻断', () => {
  const required = requiredJobs(fullScope, { eventName: 'pull_request' });
  assert.equal(required.has('promotion-gate'), false);
  assert.equal(required.has('promotion-approval'), false);
});

test('非必需作业意外失败也会失败（红色作业不得被汇总掩盖）', () => {
  const result = evaluateSummary({
    needs: fullNeeds({ 'research-node': job('failure') }),
    scope: fullScope,
    eventName: 'pull_request',
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /research-node: failure/);
});

test('main push 部署失败 → 汇总失败', () => {
  const needs = fullNeeds({ 'pages-deploy': job('failure') });
  const result = evaluateSummary({ needs, scope: fullScope, eventName: 'push', ref: 'refs/heads/main' });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(';'), /pages-deploy: failure/);
});

test('PR 上 pages-deploy skipped 是合法的不适用状态', () => {
  const needs = fullNeeds({ 'pages-deploy': job('skipped') });
  const result = evaluateSummary({ needs, scope: fullScope, eventName: 'pull_request', ref: 'refs/pull/1/merge' });
  assert.equal(result.ok, true, result.failures.join('; '));
});

test('研究 PR 必需研究检查', () => {
  const scope = { ...fullScope, web: false, training: false, ui: false, simulation: false, audit: true, research: true, pages: false };
  const needs = baseNeeds({
    build: job(), 'audit-gate': job(),
    'research-node': job('success'), 'research-worker': job('success'), 'research-e2e': job('success'),
    'research-python': job('success'), 'research-seatbelt': job('success'),
    'web-unit': job('skipped'), 'training-unit': job('skipped'), 'ui-smoke': job('skipped'), 'simulation': job('skipped'),
  });
  const result = evaluateSummary({ needs, scope, eventName: 'pull_request' });
  assert.equal(result.ok, true, result.failures.join('; '));
  for (const required of ['research-node', 'research-worker', 'research-e2e', 'research-python', 'research-seatbelt']) {
    assert.equal(requiredJobs(scope, { eventName: 'pull_request' }).has(required), true, required);
  }
});

test('研究 worker / 端到端门禁失败 → 汇总失败（不得静默跳过）', () => {
  const scope = { ...fullScope, web: false, training: false, ui: false, simulation: false, audit: true, research: true, pages: false };
  const needs = baseNeeds({
    build: job(), 'audit-gate': job(),
    'research-node': job('success'), 'research-worker': job('failure'), 'research-e2e': job('failure'),
    'research-python': job('success'), 'research-seatbelt': job('success'),
    'web-unit': job('skipped'), 'training-unit': job('skipped'), 'ui-smoke': job('skipped'), 'simulation': job('skipped'),
  });
  const result = evaluateSummary({ needs, scope, eventName: 'pull_request' });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.startsWith('research-worker: failure')));
  assert.ok(result.failures.some(f => f.startsWith('research-e2e: failure')));
});
