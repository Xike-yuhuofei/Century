import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyWorkflows } from '../verify-workflows.mjs';
import { planSimShards } from '../lib/sim-shards.mjs';
import { buildRuleset, REQUIRED_CHECKS } from '../apply-main-protection.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');

test('CI 工作流结构不变量：单一 PR 入口、无重复工作流、无 npm install、必需门禁在场', () => {
  const result = verifyWorkflows(ROOT);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

test('ai-training 不再在 PR 上触发，且晋级后 dispatch CI', () => {
  const training = readFileSync(resolve(ROOT, '.github/workflows/ai-training.yml'), 'utf8');
  assert.doesNotMatch(training, /^\s{2}pull_request:/m);
  assert.match(training, /gh workflow run ci\.yml/);
});

test('ci.yml 门禁是唯一必需检查聚合并使用 always()', () => {
  const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /ci-summary:/);
  assert.match(ci.slice(ci.indexOf('  ci-summary:')), /if:\s*always\(\)/);
  assert.match(ci, /name: web-v1-dist/);
});

test('B5 错误构建产物/超时/审计失败矩阵由汇总逻辑单元测试覆盖（见 summary.test.mjs）', () => {
  // 结构占位断言：汇总作业必须消费所有作业的 needs JSON。
  const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /NEEDS_JSON:\s*\$\{\{\s*toJSON\(needs\)\s*\}\}/);
});

test('模拟分片：100 局切 4 片保持连续种子且不重叠', () => {
  const plan = planSimShards({ games: 100, shards: 4, seedBase: 1 });
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map(p => p.games), [25, 25, 25, 25]);
  assert.deepEqual(plan.map(p => p.seedBase), [1, 26, 51, 76]);
  assert.equal(plan.reduce((s, p) => s + p.games, 0), 100);
});

test('模拟分片：不能整除时余数分配且种子连续', () => {
  const plan = planSimShards({ games: 101, shards: 4, seedBase: 10 });
  assert.deepEqual(plan.map(p => p.games), [26, 25, 25, 25]);
  assert.deepEqual(plan.map(p => p.seedBase), [10, 36, 61, 86]);
});

test('模拟分片：参数校验失败关闭', () => {
  assert.throws(() => planSimShards({ games: 0, shards: 4, seedBase: 1 }));
  assert.throws(() => planSimShards({ games: 10, shards: 0, seedBase: 1 }));
});

test('分支保护方案：禁止强推/删除、必需检查与 strict 同步', () => {
  const ruleset = buildRuleset();
  assert.equal(ruleset.target, 'branch');
  assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main']);
  const types = ruleset.rules.map(r => r.type);
  assert.ok(types.includes('non_fast_forward'));
  assert.ok(types.includes('deletion'));
  assert.ok(types.includes('pull_request'));
  const status = ruleset.rules.find(r => r.type === 'required_status_checks');
  assert.equal(status.parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(status.parameters.required_status_checks.map(c => c.context), REQUIRED_CHECKS);
  const pr = ruleset.rules.find(r => r.type === 'pull_request');
  assert.equal(pr.parameters.required_approving_review_count, 0);
  assert.deepEqual(ruleset.bypass_actors, []);
});
