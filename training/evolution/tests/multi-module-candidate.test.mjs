/** AI9 多模块候选协议：静态拒绝、组装隔离、artifact 身份、部署/回滚。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createCompiledModuleCandidate, loadCompiledCandidateModules, MULTI_MODULE_INFO,
} from '../multi-module-candidate.mjs';
import { validateArtifact } from '../candidate-artifact.mjs';
import { runSafetyChecks } from '../safety-check.mjs';
import { mutateModules } from '../module-mutations.mjs';
import { applyArtifactModules, checkArtifactModules, revertActiveModules } from '../../scripts/apply-modules.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const STATIC_CHECK = resolve(REPO_ROOT, 'ai5/openevolve/node/static_check_modules.mjs');

const experiment = {
  configRef: 'ai9://test/multi-module',
  configHash: 'a'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: 'ai9-screen-w000', base: 1_660_000_000, count: 4 },
    { purpose: 'deep', windowId: 'ai9-deep-w000', base: 1_670_000_000, count: 6 },
  ],
};

function staticRun(text, { modules = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai9-static-'));
  try {
    const program = join(dir, 'program.ts');
    const out = join(dir, 'static.json');
    writeFileSync(program, text);
    const args = [STATIC_CHECK, '--program', program, '--out', out];
    if (modules) args.push('--modules', modules.join(','));
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
    return { result, out };
  } finally {
    // 结果只在调用方读取前保留；使用同步读取后由调用方清理。
  }
}

test('静态检查：签名改动/额外代码/禁止构造/未注册函数/重复模块全部拒绝', () => {
  const base = `/* EVOLVE-BLOCK-START */
export function goalPriority(view: AIObservation, goalId: string, params: AIParameters): number {
  return 1;
}
/* EVOLVE-BLOCK-END */
`;
  // 合法基线。
  let run = staticRun(base, { modules: ['M01'] });
  assert.equal(run.result.status, 0, run.result.stdout);
  rmSync(run.out.replace(/\.json$/, '.M01.fn.ts'), { force: true });
  rmSync(run.out, { force: true });

  // 签名改动。
  run = staticRun(base.replace('goalId: string', 'goalId: number'), { modules: ['M01'] });
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stdout, /签名不符|参数类型/);
  rmSync(run.out, { force: true });

  // 函数外可执行代码（同一个 EVOLVE-BLOCK 内真实的函数外语句）。
  const functionOnly = base
    .replace('/* EVOLVE-BLOCK-START */', '')
    .replace('/* EVOLVE-BLOCK-END */', '');
  run = staticRun(`/* EVOLVE-BLOCK-START */\nconst x = 1;\n${functionOnly}\n/* EVOLVE-BLOCK-END */`, { modules: ['M01'] });
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stdout, /函数外代码|恰好包含一个/);
  rmSync(run.out, { force: true });

  // 禁止构造。
  run = staticRun(base.replace('return 1;', 'return Math.random();'), { modules: ['M01'] });
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stdout, /禁止构造/);
  rmSync(run.out, { force: true });

  // 未注册函数。
  run = staticRun(`/* EVOLVE-BLOCK-START */\nexport function evil() { return 1; }\n/* EVOLVE-BLOCK-END */`, { modules: ['M01'] });
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stdout, /不在模块注册表/);
  rmSync(run.out, { force: true });

  // 模块集合不符（请求两个，实际一个）。
  run = staticRun(base, { modules: ['M01', 'M02'] });
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stdout, /模块集合不符/);
  rmSync(run.out, { force: true });
  rmSync(run.out.replace(/\.json$/, '.M01.fn.ts'), { force: true });
});

test('编译候选：12 模块联合编译、artifact 身份覆盖全部模块、安全门禁通过', { timeout: 180_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, async () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true, '本测试需要 macOS Seatbelt');
  const modules = mutateModules(['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12']);
  const created = createCompiledModuleCandidate({
    modules,
    moduleIds: modules.map(m => m.id),
    experiment,
    round: 1,
    index: 0,
    sourceOrigin: 'deterministic-template',
    mutationLabel: 'test-all-twelve',
  });
  assert.deepEqual(created.probe.changedModules.sort(), modules.map(m => m.id).sort());
  assert.equal(created.probe.probeErrors, 0);
  assert.equal(created.artifact.source.modules.length, 12);
  assert.deepEqual([...created.artifact.algorithmStructure.targetIds].sort(), modules.map(m => m.id).sort());
  validateArtifact(created.artifact);
  const safety = runSafetyChecks(created.artifact);
  assert.equal(safety.status, 'passed', JSON.stringify(safety.checks.filter(c => c.status !== 'pass')));
  assert.ok(created.artifact.buildArtifact.files.length >= 20);
  assert.ok(created.artifact.buildArtifact.sha256.length === 64);

  // 身份覆盖：任改一个模块源码 → sourceHash/artifactHash 全部失效。
  const tampered = JSON.parse(JSON.stringify(created.artifact));
  const file = tampered.source.files.find(f => f.path === tampered.source.modules[0].path);
  file.content += '/* tampered */';
  assert.throws(() => validateArtifact(tampered), /哈希不符|sourceHash 不符/);

  // 清理成员：加载完整 ESM 决策包。
  const loaded = await loadCompiledCandidateModules(created.artifact);
  try {
    assert.equal(typeof loaded.aiModule.chooseAIAction, 'function');
    assert.equal(typeof loaded.jointModule.chooseJointAction, 'function');
  } finally {
    loaded.cleanup();
  }
});

test('部署/回滚：临时源码树应用 12 模块函数后可复核并完整恢复', { timeout: 180_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, async () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true);
  const modules = mutateModules(['M01', 'M02', 'M10']);
  const created = createCompiledModuleCandidate({
    modules,
    moduleIds: modules.map(m => m.id),
    experiment,
    round: 1,
    index: 1,
  });
  const temp = mkdtempSync(join(tmpdir(), 'ai9-apply-'));
  try {
    const srcRoot = join(temp, 'src');
    cpSync(join(REPO_ROOT, 'web-v1/src'), srcRoot, { recursive: true });
    const backupRoot = join(temp, 'backups');
    const activePath = join(temp, 'active-modules.json');
    mkdirSync(backupRoot, { recursive: true });

    const before = {
      evaluator: readFileSync(join(srcRoot, 'ai/evaluator.ts'), 'utf8'),
      modules: readFileSync(join(srcRoot, 'ai/evolve/modules.ts'), 'utf8'),
    };
    const mismatchesBefore = checkArtifactModules(created.artifact, { srcRoot });
    assert.equal(mismatchesBefore.length, 3);

    const applied = applyArtifactModules(created.artifact, { srcRoot, backupRoot, activePath });
    assert.deepEqual(applied.applied.sort(), ['M01', 'M02', 'M10']);
    assert.equal(checkArtifactModules(created.artifact, { srcRoot }).length, 0);

    const reverted = revertActiveModules({ srcRoot, activePath });
    assert.equal(reverted.reverted.length, 3);
    assert.equal(readFileSync(join(srcRoot, 'ai/evaluator.ts'), 'utf8'), before.evaluator);
    assert.equal(readFileSync(join(srcRoot, 'ai/evolve/modules.ts'), 'utf8'), before.modules);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
