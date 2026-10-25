import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyAuditReport } from '../lib/audit.mjs';

const WRAPPER = resolve(import.meta.dirname, '../run-audit-gate.mjs');

test('审计 verdict 分类：PASS / REQUIRES_APPROVAL / BLOCKED / 未知', () => {
  assert.deepEqual(classifyAuditReport({ verdict: 'PASS' }), { verdict: 'PASS', exitCode: 0, requiresApproval: false });
  assert.deepEqual(classifyAuditReport({ verdict: 'REQUIRES_APPROVAL' }), { verdict: 'REQUIRES_APPROVAL', exitCode: 2, requiresApproval: true });
  assert.deepEqual(classifyAuditReport({ verdict: 'BLOCKED' }), { verdict: 'BLOCKED', exitCode: 2, requiresApproval: false });
  assert.equal(classifyAuditReport({}).exitCode, 1);
  assert.equal(classifyAuditReport({ verdict: 'WHATEVER' }).exitCode, 1);
});

function fakeGate(dir, { verdict, exitCode, write = true }) {
  const path = join(dir, `fake-gate-${verdict}-${exitCode}.mjs`);
  writeFileSync(path, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const i = args.indexOf('--json');
const out = args[i + 1];
${write ? `writeFileSync(out, JSON.stringify({
  tier: 'promotion',
  verdict: ${JSON.stringify(verdict)},
  summary: { checks: 2, pass: 1, fail: 0, blocked: 0, requiresApproval: 1 },
  checks: [{ tier: 'promotion', status: 'REQUIRES_APPROVAL', id: 'promotion-governance', evidence: 'evidence' }]
}));` : ''}
process.exit(${exitCode});
`);
  return path;
}

function runWrapper(dir, gateScript, { withOutput = true } = {}) {
  const json = join(dir, 'audit.json');
  const md = join(dir, 'audit.md');
  const output = join(dir, 'github-output.txt');
  const summary = join(dir, 'step-summary.md');
  const env = { ...process.env, GITHUB_OUTPUT: withOutput ? output : '', GITHUB_STEP_SUMMARY: summary };
  const result = spawnSync(process.execPath, [WRAPPER, '--tier', 'promotion', '--json', json, '--md', md, '--gate-script', gateScript], {
    cwd: dir, env, encoding: 'utf8',
  });
  return { result, json, output, summary };
}

test('适配层：PASS 放行，输出 verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-audit-pass-'));
  const { result, output } = runWrapper(dir, fakeGate(dir, { verdict: 'PASS', exitCode: 0 }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /verdict=PASS/);
});

test('适配层：REQUIRES_APPROVAL 保持阻断（exit=2）并显式输出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-audit-approval-'));
  const { result, output, summary } = runWrapper(dir, fakeGate(dir, { verdict: 'REQUIRES_APPROVAL', exitCode: 2 }));
  assert.equal(result.status, 2, result.stderr);
  const outputText = readFileSync(output, 'utf8');
  assert.match(outputText, /verdict=REQUIRES_APPROVAL/);
  assert.match(outputText, /requires_approval=true/);
  assert.match(readFileSync(summary, 'utf8'), /REQUIRES_APPROVAL 原样保留/);
});

test('适配层：BLOCKED 必须失败且不产生批准信号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-audit-blocked-'));
  const { result, output } = runWrapper(dir, fakeGate(dir, { verdict: 'BLOCKED', exitCode: 2 }));
  assert.equal(result.status, 2);
  assert.match(readFileSync(output, 'utf8'), /requires_approval=false/);
});

test('适配层：审计未产出 JSON 时失败关闭', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-audit-missing-'));
  const { result } = runWrapper(dir, fakeGate(dir, { verdict: 'PASS', exitCode: 0, write: false }));
  assert.equal(result.status, 1);
});

test('适配层：退出码与 verdict 不一致时失败关闭', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-audit-contract-'));
  const { result } = runWrapper(dir, fakeGate(dir, { verdict: 'PASS', exitCode: 2 }));
  assert.equal(result.status, 1);
});
