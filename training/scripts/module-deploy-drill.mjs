#!/usr/bin/env node
/** AI9 模块部署/回滚隔离演练（不触碰正式源码与正式冠军）。
 *
 * 真实执行：
 * 1. 编译一个多模块候选（M01+M02 确定性变异）；
 * 2. 在临时源码副本中 apply → check 通过；
 * 3. 篡改 artifact → validateArtifact 失败（部署前拒绝）；
 * 4. 篡改临时源码 → check 失败（构建前拒绝）；
 * 5. revert → 临时源码逐字节恢复。
 *
 * 证据：training/reports/ai9/module-deploy-drill.json
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { createCompiledModuleCandidate, MULTI_MODULE_INFO } from '../evolution/multi-module-candidate.mjs';
import { validateArtifact } from '../evolution/candidate-artifact.mjs';
import { mutateModules } from '../evolution/module-mutations.mjs';
import { stripLiterals, extractFunction } from '../../ai5/openevolve/node/module_registry.mjs';
import {
  applyArtifactModules, checkArtifactModules, revertActiveModules,
} from './apply-modules.mjs';

const outPath = resolve(REPO_ROOT, 'training/reports/ai9/module-deploy-drill.json');
const checks = [];
function check(id, fn) {
  try {
    const detail = fn();
    checks.push({ id, status: 'PASS', detail: detail ?? 'ok' });
  } catch (error) {
    checks.push({ id, status: 'FAIL', detail: String(error.message).slice(0, 500) });
  }
}

if (!MULTI_MODULE_INFO.seatbeltAvailable) {
  writeJSON(outPath, {
    schema: 'century-ai9-module-deploy-drill-v1',
    status: 'BLOCKED',
    reason: 'macOS Seatbelt 不可用——拒绝无沙箱编译（fail closed）',
    checks,
  });
  console.log(JSON.stringify({ status: 'BLOCKED' }));
  process.exit(3);
}

const experiment = {
  configRef: 'ai9://drill/module-deploy',
  configHash: 'd'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: 'ai9-drill-screen', base: 1_660_003_000, count: 2 },
    { purpose: 'deep', windowId: 'ai9-drill-deep', base: 1_670_003_000, count: 2 },
  ],
};
const created = createCompiledModuleCandidate({
  modules: mutateModules(['M01', 'M02']),
  moduleIds: ['M01', 'M02'],
  experiment,
  round: 1,
  index: 0,
  sourceOrigin: 'drill',
  candidateId: 'cand-ai9-drill-module-deploy',
});
check('compile-and-probe', () => {
  if (created.probe?.probeErrors !== 0) throw new Error(`探针错误：${created.probe?.probeErrors}`);
  if (!created.probe?.changedModules?.includes('M01') || !created.probe?.changedModules?.includes('M02')) {
    throw new Error('两个模块都必须产生可观测行为差异');
  }
  return `modules=${created.artifact.source.modules.map(m => m.id).join(',')}`;
});

const temp = mkdtempSync(join(tmpdir(), 'ai9-deploy-drill-'));
const srcRoot = join(temp, 'src');
const backupRoot = join(temp, 'backups');
const activePath = join(temp, 'active-modules.json');
mkdirSync(backupRoot, { recursive: true });
cpSync(join(REPO_ROOT, 'web-v1/src'), srcRoot, { recursive: true });
const originals = {
  'ai/evaluator.ts': readFileSync(join(srcRoot, 'ai/evaluator.ts'), 'utf8'),
  'ai/evolve/modules.ts': readFileSync(join(srcRoot, 'ai/evolve/modules.ts'), 'utf8'),
};
try {
  check('apply', () => {
    const applied = applyArtifactModules(created.artifact, { srcRoot, backupRoot, activePath });
    if (applied.applied.length !== 2) throw new Error(`应用模块数 ${applied.applied.length} ≠ 2`);
    return applied.backupDir;
  });
  check('check-after-apply', () => {
    const mismatches = checkArtifactModules(created.artifact, { srcRoot });
    if (mismatches.length) throw new Error(JSON.stringify(mismatches));
    return 'official source matches artifact module hashes';
  });
  check('tampered-artifact-rejected', () => {
    const tampered = JSON.parse(JSON.stringify(created.artifact));
    tampered.source.modules[0].functionSha256 = '0'.repeat(64);
    try {
      validateArtifact(tampered);
    } catch {
      return 'artifact 哈希校验拒绝篡改';
    }
    throw new Error('篡改 artifact 未被拒绝');
  });
  check('tampered-source-detected', () => {
    const path = join(srcRoot, 'ai/evaluator.ts');
    const text = readFileSync(path, 'utf8');
    const fn = extractFunction(stripLiterals(text), text, 'acquisitionValue');
    if (fn.error) throw new Error(fn.error);
    const tamperedFn = fn.text.replace('goalFit * 2 * params.goalWeight', 'goalFit * 2.1 * params.goalWeight');
    if (tamperedFn === fn.text) throw new Error('演练篡改点不存在（官方函数结构变更）');
    writeFileSync(path, text.slice(0, fn.start) + tamperedFn + text.slice(fn.end));
    const mismatches = checkArtifactModules(created.artifact, { srcRoot });
    if (!mismatches.length) throw new Error('篡改源码未被 check 检出');
    writeFileSync(path, originals['ai/evaluator.ts']);
    return `mismatches=${mismatches.length}`;
  });
  check('revert-restores-bytes', () => {
    const reverted = revertActiveModules({ srcRoot, activePath });
    if (reverted.reverted.length !== 2) throw new Error('回滚模块数不符');
    for (const [rel, content] of Object.entries(originals)) {
      if (readFileSync(join(srcRoot, rel), 'utf8') !== content) throw new Error(`${rel} 未逐字节恢复`);
    }
    return 'two source files restored byte-identically';
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const failed = checks.filter(c => c.status !== 'PASS');
const report = {
  schema: 'century-ai9-module-deploy-drill-v1',
  generatedAt: new Date().toISOString(),
  artifact: {
    candidateId: created.artifact.candidateId,
    artifactHash: created.artifact.artifactHash,
    sourceHash: created.artifact.sourceHash,
    modules: created.artifact.source.modules.map(m => m.id),
  },
  sandbox: 'macos-seatbelt',
  status: failed.length ? 'FAIL' : 'PASS',
  checks,
};
writeJSON(outPath, report);
console.log(JSON.stringify({ status: report.status, checks: checks.map(c => `${c.id}:${c.status}`), outPath }, null, 2));
process.exit(failed.length ? 1 : 0);
