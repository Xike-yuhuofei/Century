/** 冻结代码版本身份（R09/长时运行的可复现性证据）。
 *
 * 记录两类信息：
 * - provenance：HEAD commit、工作区是否 dirty、构建清单的 gitCommit/来源哈希；
 * - codeDigest：只覆盖决策相关源码、构建产物与进化器源码的稳定摘要。
 *
 * 恢复时只要求 codeDigest 一致（文档/报告提交可推进 HEAD，但不得改变决策代码）；
 * R09 审计要求 codeDigest 存在、可重算一致，且运行起点为干净工作区。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { computeVersionLock } from './version-lock.mjs';

export const CODE_VERSION_SCHEMA = 'century-code-version-v1';

/** 进化器/候选编译链源码：改变它们会改变候选生成或评估语义。 */
export const CODE_VERSION_EVOLUTION_FILES = Object.freeze([
  'training/evolution/autonomous-run.mjs',
  'training/evolution/campaign-controller.mjs',
  'training/evolution/candidate-artifact.mjs',
  'training/evolution/candidate-generator.mjs',
  'training/evolution/compiled-game-evaluator.mjs',
  'training/evolution/dev-evaluator.mjs',
  'training/evolution/governance-provider-v2.mjs',
  'training/evolution/module-mutations.mjs',
  'training/evolution/multi-module-candidate.mjs',
  'training/evolution/multi-module-generator.mjs',
  'training/evolution/openevolve-campaign.mjs',
  'training/evolution/promotion-handler.mjs',
  'training/evolution/safety-check.mjs',
  'training/evolution/selection.mjs',
  'training/lib/code-version.mjs',
  'training/lib/seed-governance.mjs',
  'training/lib/seeds.mjs',
  'training/lib/version-lock.mjs',
]);

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 运行时状态/证据路径：它们会在训练中合法变化（种子登记、检查点、报告），
 * 但不改变代码语义。代码身份必须排除它们，否则云端训练在恢复治理账本后
 * 永远 headDirty=true，导致 resume/R09 被误判为代码不干净。 */
export const RUNTIME_STATE_PREFIXES = Object.freeze([
  'training/governance/',
  'training/state/',
  'training/state-prev/',
  'training/reports/',
  'web-v1/test-results/',
]);

export function isRuntimeStatePath(path) {
  return RUNTIME_STATE_PREFIXES.some(prefix => path.startsWith(prefix));
}

/** 解析 `git status --porcelain` 行，返回仓库相对路径（处理重命名）。 */
export function statusPath(line) {
  const text = String(line ?? '');
  if (!text.trim()) return '';
  const arrow = text.indexOf(' -> ');
  const raw = arrow >= 0 ? text.slice(arrow + 4) : text.slice(3);
  return raw.trim().replace(/^"|"$/g, '');
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function sha256Canonical(value) {
  return sha256Buffer(Buffer.from(JSON.stringify(value)));
}

function git(args, root) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/** 计算当前代码身份；不修改任何文件。 */
export function computeCodeVersion({ root = REPO_ROOT } = {}) {
  const headCommit = git(['rev-parse', 'HEAD'], root);
  const status = git(['status', '--porcelain', '--untracked-files=no'], root) ?? '';
  const allDirtyFiles = status ? status.split('\n').filter(Boolean) : [];
  const dirtyFiles = allDirtyFiles.filter(line => !isRuntimeStatePath(statusPath(line)));

  const manifestPath = resolve(root, 'web-v1/dist/build-manifest.json');
  let webBuild = null;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    webBuild = {
      gitCommit: manifest.gitCommit ?? null,
      gitDirty: manifest.gitDirty === true,
      sourceSha256: manifest.source?.sha256 ?? null,
      artifactSha256: manifest.artifact?.sha256 ?? null,
      fileCounts: {
        source: manifest.source?.fileCount ?? null,
        artifact: manifest.artifact?.fileCount ?? null,
      },
    };
  }

  const versionLock = computeVersionLock({ root });
  const evolutionSources = Object.fromEntries(CODE_VERSION_EVOLUTION_FILES.map(rel => {
    const path = resolve(root, rel);
    if (!existsSync(path)) throw new Error(`代码身份覆盖文件缺失：${rel}`);
    return [rel, sha256File(path)];
  }));
  const versionLockSha256 = sha256File(resolve(root, 'training/champions/version-lock.json'));

  const codeDigest = sha256Canonical({
    webSourceSha256: webBuild?.sourceSha256 ?? null,
    webArtifactSha256: webBuild?.artifactSha256 ?? null,
    decisionSources: versionLock.decisionSources,
    archives: versionLock.archives,
    evolutionSources,
    versionLockSha256,
  });

  return {
    schema: CODE_VERSION_SCHEMA,
    generatedAt: new Date().toISOString(),
    headCommit,
    headDirty: dirtyFiles.length > 0,
    dirtyFiles,
    webBuild,
    versionLockSha256,
    evolutionSources,
    codeDigest,
  };
}

/** 恢复/审计比较：只比较决策相关摘要。 */
export function sameCodeDigest(a, b) {
  return Boolean(a?.codeDigest) && a.codeDigest === b?.codeDigest;
}
