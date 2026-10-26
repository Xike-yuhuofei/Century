import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChanges, auditTier, scopeToOutputs } from '../lib/scope.mjs';

const scope = (files, options) => classifyChanges(files, options);

test('B5 文档变更：只跑规则与 CI 元测试，不触发高成本检查', () => {
  const s = scope(['README.md', 'docs/ci/BRANCH-PROTECTION.md', 'training/reports/note.md']);
  assert.equal(s.docsOnly, true);
  assert.deepEqual(
    [s.build, s.web, s.training, s.ai5, s.ui, s.simulation, s.audit, s.research, s.promotion, s.pages],
    [false, false, false, false, false, false, false, false, false, false],
  );
  assert.equal(s.rules, true);
  assert.equal(s.governance, true);
});

test('B5 AI 核心变更：web/training/模拟/审计/UI 全触发', () => {
  const s = scope(['web-v1/src/ai/decision.ts']);
  for (const key of ['build', 'web', 'training', 'ui', 'simulation', 'audit']) {
    assert.equal(s[key], true, `${key} 必须触发`);
  }
  assert.equal(s.research, false);
  assert.equal(s.promotion, false);
});

test('B5 UI 变更：跑 web 单测与浏览器冒烟，不跑训练/模拟/审计', () => {
  const s = scope(['web-v1/src/styles.css']);
  assert.equal(s.web, true);
  assert.equal(s.ui, true);
  assert.equal(s.pages, true);
  assert.equal(s.training, false);
  assert.equal(s.simulation, false);
  assert.equal(s.audit, false);
});

test('B5 训练脚本变更：跑训练单测与审计，不跑 web/模拟', () => {
  const s = scope(['training/optimizer/evolve.mjs']);
  assert.equal(s.training, true);
  assert.equal(s.audit, true);
  assert.equal(s.web, false);
  assert.equal(s.simulation, false);
  assert.equal(s.research, false);
  assert.equal(s.ai9, false);
});

test('AI9 协同进化控制面变更：触发真实 AI9 证据作业', () => {
  for (const file of [
    'training/evolution/multi-module-generator.mjs',
    'training/evolution/promotion-handler.mjs',
    'training/scripts/ai9-module-wiring-audit.mjs',
    'training/scripts/ai9-structural-search.mjs',
    'training/evolution/module-registry.json',
  ]) {
    const s = scope([file]);
    assert.equal(s.ai9, true, `${file} 必须触发 AI9 证据作业`);
    assert.equal(s.training, true, `${file} 必须触发训练单测`);
    assert.equal(s.build, true, `${file} 必须构建共享产物`);
  }
});

test('AI9 文档/报告变更不触发高成本证据作业', () => {
  const s = scope(['training/reports/ai9/module-wiring-audit.json', 'docs/ai9/notes.md']);
  assert.equal(s.ai9, false);
  assert.equal(s.training, false);
});

test('B5 冠军参数变更：强制晋级门禁与全代码检查', () => {
  const s = scope(['web-v1/src/ai/parameters.ts']);
  assert.equal(s.promotion, true);
  for (const key of ['build', 'web', 'training', 'ui', 'simulation', 'audit']) {
    assert.equal(s[key], true, `${key} 必须触发`);
  }
});

test('回滚分支改冠军：不得被当作 promotion，但必须触发全代码检查与回滚门禁', () => {
  const s = scope(['training/champions/champion.json', 'web-v1/src/ai/parameters.ts'], { headRef: 'rollback/champion-abc123' });
  assert.equal(s.rollback, true);
  assert.equal(s.promotion, false, '回滚不是晋级，不能要求第一名率预注册证据');
  for (const key of ['build', 'web', 'training', 'ui', 'simulation', 'audit']) {
    assert.equal(s[key], true, `${key} 必须触发`);
  }
  assert.equal(scopeToOutputs(s).rollback, 'true');
});

test('rollback 标签同样触发回滚门禁而不是晋进门禁', () => {
  const s = scope(['training/champions/champion.json'], { labels: ['rollback'] });
  assert.equal(s.rollback, true);
  assert.equal(s.promotion, false);
});

test('冠军归档变更同样触发晋级门禁', () => {
  const s = scope(['training/champions/champion.json']);
  assert.equal(s.promotion, true);
  assert.equal(s.training, true);
  assert.equal(s.simulation, true);
});

test('冠军治理元数据与候选资料不触发晋级门禁（避免信任类变更阻断普通 PR）', () => {
  for (const file of ['training/champions/version-lock.json', 'training/champions/revalidation-required.json', 'training/champions/candidates/joint-js5.json']) {
    const s = scope([file]);
    assert.equal(s.promotion, false, `${file} 不应触发 promotion`);
    assert.equal(s.training, true, `${file} 应触发 training`);
    assert.equal(s.audit, true, `${file} 应触发审计`);
    assert.equal(auditTier(s), 'research');
  }
});

test('研究 pilot 证据不触发晋级门禁，但 latest 晋级证据触发', () => {
  const pilot = scope(['training/reports/first-place-promotion/pilot-candidatecap-r1c7.json']);
  assert.equal(pilot.promotion, false, '研究 pilot 只是证据，不是一次冠军晋级');
  const latest = scope(['training/reports/first-place-promotion/latest/challenge-evidence.json']);
  assert.equal(latest.promotion, true, 'CI 实际消费的 latest 证据必须触发晋级门禁');
});

test('B5 AI5 研究变更：跑研究检查，不误触发 web/training 单测', () => {
  const s = scope(['ai5/ppo/trainer.py']);
  assert.equal(s.ai5, true);
  assert.equal(s.research, true);
  assert.equal(s.audit, true);
  assert.equal(s.build, true);
  assert.equal(s.web, false);
  assert.equal(s.training, false);
  assert.equal(s.ui, false);
  assert.equal(auditTier(s), 'research');
});

test('AI5 共享种子库变更同时触发训练与审计', () => {
  const s = scope(['ai5/lib/seed_policy.mjs']);
  assert.equal(s.training, true);
  assert.equal(s.research, true);
  assert.equal(s.audit, true);
  assert.equal(auditTier(s), 'research');
});

test('共享卡牌数据变更触发全代码检查', () => {
  const s = scope(['data/cards.json']);
  for (const key of ['build', 'web', 'training', 'ui', 'simulation', 'audit', 'pages']) {
    assert.equal(s[key], true, `${key} 必须触发`);
  }
});

test('CI 自身变更触发全代码检查（防门禁自我弱化）', () => {
  const s = scope(['.github/workflows/ci.yml', 'scripts/ci/lib/scope.mjs']);
  for (const key of ['build', 'web', 'training', 'ui', 'simulation', 'audit', 'pages']) {
    assert.equal(s[key], true, `${key} 必须触发`);
  }
});

test('AI10 LLM 玩家变更覆盖共享构建/训练/UI/审计', () => {
  const core = scope(['web-v1/src/ai/llm/player.ts']);
  for (const key of ['build', 'web', 'training', 'ui', 'simulation', 'audit']) {
    assert.equal(core[key], true, `LLM 共享核心必须触发 ${key}`);
  }
  const runner = scope(['training/llm/game-runner.mjs']);
  assert.equal(runner.training, true);
  assert.equal(runner.audit, true);
  assert.equal(runner.web, false);
  assert.equal(runner.simulation, false);
  const uiSmoke = scope(['web-v1/scripts/smoke_llm_ui.py']);
  assert.equal(uiSmoke.web, true);
  assert.equal(uiSmoke.ui, true);
  assert.equal(uiSmoke.training, false);
  const trainingTest = scope(['training/tests/llm-player.test.mjs']);
  assert.equal(trainingTest.training, true);
  assert.equal(trainingTest.audit, true);
  assert.equal(trainingTest.web, false);
  const webTest = scope(['web-v1/tests/llm-player.test.mjs']);
  assert.equal(webTest.web, true);
  assert.equal(webTest.ui, false);
  assert.equal(webTest.training, false);
});

test('测试文件变更只触发对应测试组', () => {
  const webTest = scope(['web-v1/tests/ai.test.mjs']);
  assert.equal(webTest.web, true);
  assert.equal(webTest.ui, false);
  assert.equal(webTest.training, false);
  assert.equal(webTest.simulation, false);

  const trainingTest = scope(['training/tests/evolve.test.mjs']);
  assert.equal(trainingTest.training, true);
  assert.equal(trainingTest.audit, true);
  assert.equal(trainingTest.web, false);
});

test('训练证据/报告变更只触发审计门禁', () => {
  const s = scope(['training/reports/audit-gate.json']);
  assert.equal(s.audit, true);
  assert.equal(s.build, true);
  assert.equal(s.training, false);
  assert.equal(s.simulation, false);
  assert.equal(s.web, false);
});

test('未知文件不会触发高成本测试', () => {
  const s = scope(['assets/unknown.bin']);
  assert.equal(s.rules, true);
  assert.equal(s.governance, true);
  assert.equal(s.build, false);
  assert.equal(s.web, false);
  assert.equal(s.training, false);
});

test('promotion 标签在文档变更上也会强制晋级门禁', () => {
  const s = scope(['README.md'], { labels: ['promotion'] });
  assert.equal(s.promotion, true);
  assert.equal(s.web, true);
  assert.equal(s.training, true);
  assert.equal(s.simulation, true);
  assert.equal(s.audit, true);
});

test('forceFull 强制全代码检查（含模拟），但不额外触发 macOS 研究验收', () => {
  const s = scope([], { forceFull: true });
  for (const key of ['build', 'web', 'training', 'ui', 'simulation', 'audit', 'pages']) {
    assert.equal(s[key], true, `${key} 必须触发`);
  }
  assert.equal(s.research, false);
});

test('forceAll 覆盖所有检查，包括 macOS 研究验收', () => {
  const s = scope([], { forceFull: true, forceAll: true });
  for (const key of ['build', 'web', 'training', 'ai5', 'ui', 'simulation', 'audit', 'research', 'pages']) {
    assert.equal(s[key], true, `${key} 必须触发`);
  }
});

test('scopeToOutputs 输出 GitHub Actions 可消费的字符串布尔值', () => {
  const outputs = scopeToOutputs(scope(['web-v1/src/ai/decision.ts']));
  assert.equal(outputs.web, 'true');
  assert.equal(outputs.research, 'false');
  assert.equal(outputs.audit_tier, 'research');
  assert.equal(outputs.changed_count, '1');
});
