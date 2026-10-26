#!/usr/bin/env node
/** 自动化状态持久化（独立 automation/state 分支，不写入 main）。
 *
 * 解决三个 P0 可靠性问题：
 * 1. GitHub Actions artifact 只保留 30/90 天，训练断点与验证种子账本过期后
 *    会被静默重置；本脚本把治理账本与断点提交到独立分支，长期可恢复、可审计。
 * 2. 云端 campaign 的种子登记只存在于单次 job 的工作区，下一次运行看不到，
 *    会重复分配开发种子；pull 必须在训练前恢复中央登记。
 * 3. 失败/取消的运行同样需要保存状态；状态分支与运行结论无关，只要 push
 *    步骤执行（if: always()）就能留下可恢复检查点。
 *
 * 用法：
 *   node training/scripts/automation-state.mjs pull [--branch automation/state]
 *   node training/scripts/automation-state.mjs push [--branch automation/state]
 *     [--run-id <id>] [--commit <sha>] [--campaign <id>] [--message <text>]
 *
 * 退出码：0=成功（cold-start 也是成功但会明确标记）；1=状态损坏/校验失败；
 * 2=参数错误。任何校验失败一律 fail-closed，不静默重建账本。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../lib/paths.mjs';
import { ensureDir, readJSON, writeJSON } from '../lib/io.mjs';

const ROOT = process.env.CENTURY_REPO_ROOT ? resolve(process.env.CENTURY_REPO_ROOT) : REPO_ROOT;

const MANIFEST_SCHEMA = 'century-automation-state-manifest-v1';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const GOVERNANCE_FILES = [
  'training/governance/seed-consumption-registry.json',
  'training/governance/alpha-ledger.json',
  'training/governance/historical-seed-claims.json',
];
const AI4_FILES = [
  'training/state/state.json',
  'training/state/validation-ledger.json',
];
const LOCAL_MARKER = 'training/state/pull.json';
const AI9_POINTER = 'state/ai9-latest.json';

function parseArgs(argv) {
  const values = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { values._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd ?? ROOT,
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  }).trim();
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertRelativeSafePath(path) {
  if (typeof path !== 'string' || path.length === 0
    || path.startsWith('/') || path.includes('\\')
    || path.split('/').some(part => part === '..' || part === '')) {
    throw new Error(`状态清单路径不安全：${String(path)}`);
  }
  return true;
}

function fileEntry(root, relPath) {
  const absolute = resolve(root, relPath);
  const bytes = statSync(absolute).size;
  if (bytes > MAX_FILE_BYTES) throw new Error(`状态文件过大（${bytes} > ${MAX_FILE_BYTES}）：${relPath}`);
  return { path: relPath.split('\\').join('/'), bytes, sha256: sha256File(absolute) };
}

export function buildManifest({ branch, files, context = {}, root = ROOT }) {
  const entries = files.map(relPath => fileEntry(root, relPath));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`状态总量过大：${totalBytes} > ${MAX_TOTAL_BYTES}`);
  return {
    schema: MANIFEST_SCHEMA,
    branch,
    generatedAt: new Date().toISOString(),
    totalBytes,
    files: entries,
    context: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      runId: context.runId ?? process.env.GITHUB_RUN_ID ?? null,
      runAttempt: context.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? null,
      commit: context.commit ?? process.env.GITHUB_SHA ?? null,
      campaignId: context.campaignId ?? null,
      note: '自动化状态分支只保存治理账本、断点与小体积指针；不保存密钥或逐局大证据',
    },
  };
}

export function validateManifest(manifest) {
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA) throw new Error('状态清单 schema 非法');
  if (!Array.isArray(manifest.files)) throw new Error('状态清单 files 非法');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !entry.path || seen.has(entry.path)) {
      throw new Error(`状态清单包含重复/非法路径：${String(entry.path)}`);
    }
    assertRelativeSafePath(entry.path);
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256))) throw new Error(`状态文件缺少 sha256：${entry.path}`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`状态文件大小非法：${entry.path}`);
    seen.add(entry.path);
  }
  return true;
}

function assertGovernanceIntegrity() {
  const registryPath = resolve(ROOT, GOVERNANCE_FILES[0]);
  const alphaPath = resolve(ROOT, GOVERNANCE_FILES[1]);
  if (!existsSync(registryPath)) throw new Error('缺少中央种子登记，禁止 push 状态');
  if (!existsSync(alphaPath)) throw new Error('缺少 alpha 账本，禁止 push 状态');
  const registry = readJSON(registryPath);
  if (registry.schema !== 'century-seed-consumption-registry-v1') {
    throw new Error(`中央种子登记 schema 非法：${String(registry.schema)}`);
  }
  const alpha = readJSON(alphaPath);
  if (alpha.schema !== 'century-alpha-ledger-v1') throw new Error(`alpha 账本 schema 非法：${String(alpha.schema)}`);
  if (!Array.isArray(alpha.reservations) || !Array.isArray(alpha.outcomes)) {
    throw new Error('alpha 账本结构非法');
  }
  return { registry, alpha };
}

function branchExists(branch) {
  try {
    const result = sh('git', ['ls-remote', '--heads', 'origin', branch]);
    return Boolean(result);
  } catch {
    return false;
  }
}

function readBranchFile(tree, relPath) {
  const path = join(tree, relPath);
  if (!existsSync(path)) throw new Error(`状态分支缺少文件：${relPath}`);
  return path;
}

function copyToRepo(tree, relPath) {
  const source = readBranchFile(tree, relPath);
  const target = resolve(ROOT, relPath);
  ensureDir(dirname(target));
  copyFileSync(source, target);
}

function pull(branch) {
  ensureDir(resolve(ROOT, 'training/state'));
  const markerPath = resolve(ROOT, LOCAL_MARKER);
  if (!branchExists(branch)) {
    writeJSON(markerPath, {
      schema: 'century-automation-state-pull-v1',
      source: 'cold-start',
      branch,
      at: new Date().toISOString(),
      note: '状态分支尚不存在：本次使用仓库内治理账本；push 时会创建分支并冻结此后状态',
    });
    console.log(JSON.stringify({ source: 'cold-start', branch, markerPath }, null, 2));
    return;
  }
  const tree = mkdtempSync(join(tmpdir(), 'century-state-pull-'));
  try {
    sh('git', ['fetch', 'origin', branch]);
    sh('git', ['worktree', 'add', '--detach', tree, `origin/${branch}`]);
    const manifestPath = join(tree, 'state/manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`状态分支 ${branch} 缺少 state/manifest.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    validateManifest(manifest);
    for (const entry of manifest.files) {
      assertRelativeSafePath(entry.path);
      const absolute = join(tree, entry.path);
      if (!existsSync(absolute)) throw new Error(`状态分支文件缺失：${entry.path}`);
      if (sha256File(absolute) !== entry.sha256) throw new Error(`状态分支文件哈希不符：${entry.path}`);
    }
    for (const relPath of GOVERNANCE_FILES) {
      // 治理账本必须始终存在；状态分支若丢账本，宁可失败也不能静默重置种子。
      if (!manifest.files.some(entry => entry.path === relPath)) {
        throw new Error(`状态分支清单缺少治理文件：${relPath}`);
      }
      copyToRepo(tree, relPath);
    }
    let restored = [...GOVERNANCE_FILES];
    for (const relPath of AI4_FILES) {
      if (manifest.files.some(entry => entry.path === relPath)) {
        copyToRepo(tree, relPath);
        restored.push(relPath);
      }
    }
    const pointer = join(tree, AI9_POINTER);
    if (existsSync(pointer)) {
      copyFileSync(pointer, resolve(ROOT, 'training/state/ai9-latest.json'));
      restored.push('training/state/ai9-latest.json');
    }
    // 恢复后立即做 schema 校验：损坏的账本不得进入训练。
    assertGovernanceIntegrity();
    writeJSON(markerPath, {
      schema: 'century-automation-state-pull-v1',
      source: 'state-branch',
      branch,
      manifestSha256: sha256File(manifestPath),
      restored,
      at: new Date().toISOString(),
    });
    console.log(JSON.stringify({ source: 'state-branch', branch, restored, markerPath }, null, 2));
  } finally {
    try { sh('git', ['worktree', 'remove', '--force', tree]); } catch { /* 临时 worktree 已清理 */ }
    rmSync(tree, { recursive: true, force: true });
  }
}

function prepareTree(branch) {
  const tree = mkdtempSync(join(tmpdir(), 'century-state-push-'));
  if (branchExists(branch)) {
    sh('git', ['fetch', 'origin', branch]);
    sh('git', ['worktree', 'add', '--detach', tree, `origin/${branch}`]);
    sh('git', ['checkout', '-B', branch, `origin/${branch}`], { cwd: tree });
  } else {
    sh('git', ['worktree', 'add', '--detach', tree, 'HEAD']);
    sh('git', ['checkout', '--orphan', branch], { cwd: tree });
    sh('git', ['rm', '-rf', '.'], { cwd: tree });
  }
  return tree;
}

function push(branch, args) {
  const { registry, alpha } = assertGovernanceIntegrity();
  const files = [...GOVERNANCE_FILES, ...AI4_FILES].filter(rel => existsSync(resolve(ROOT, rel)));
  const pointer = {
    schema: 'century-ai9-latest-pointer-v1',
    campaignId: args.campaign ? String(args.campaign) : null,
    runId: args['run-id'] ? String(args['run-id']) : (process.env.GITHUB_RUN_ID ?? null),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    commit: args.commit ? String(args.commit) : (process.env.GITHUB_SHA ?? null),
    updatedAt: new Date().toISOString(),
    note: '指向最近的 AI9 campaign 目录；完整逐局证据在 Actions artifact，本分支只保存指针',
  };
  const tree = prepareTree(branch);
  try {
    for (const relPath of files) {
      const target = join(tree, relPath);
      ensureDir(dirname(target));
      copyFileSync(resolve(ROOT, relPath), target);
    }
    ensureDir(join(tree, 'state'));
    writeJSON(join(tree, AI9_POINTER), pointer);
    // 先写 pointer 再生成清单，保证 manifest 覆盖分支上全部受管文件。
    const manifest = buildManifest({
      branch,
      files: [...files, AI9_POINTER],
      root: tree,
      context: {
        runId: args['run-id'],
        commit: args.commit,
        campaignId: args.campaign,
      },
    });
    writeJSON(join(tree, 'state/manifest.json'), manifest);
    sh('git', ['add', '--', ...files, AI9_POINTER, 'state/manifest.json'], { cwd: tree });
    const message = String(args.message ?? `chore(automation): 保存训练状态 run=${manifest.context.runId ?? 'local'} campaign=${manifest.context.campaignId ?? '-'}`);
    sh('git', ['-c', 'user.name=century-ai-bot', '-c', 'user.email=actions@users.noreply.github.com',
      'commit', '-m', message], { cwd: tree });
    try {
      sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: tree, timeout: 300_000 });
    } catch (error) {
      // 并发运行（本地/云端）可能同时 push：重新拉取并重放一次，仍冲突则失败关闭。
      sh('git', ['fetch', 'origin', branch], { cwd: tree });
      sh('git', ['rebase', `origin/${branch}`], { cwd: tree });
      sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: tree, timeout: 300_000 });
    }
    console.log(JSON.stringify({
      verdict: 'PUSHED',
      branch,
      commit: sh('git', ['rev-parse', 'HEAD'], { cwd: tree }),
      files: manifest.files.length,
      totalBytes: manifest.totalBytes,
      registryEntries: registry.entries?.length ?? 0,
      alphaChallenges: alpha.reservations?.length ?? 0,
      pointer,
    }, null, 2));
  } finally {
    try { sh('git', ['worktree', 'remove', '--force', tree]); } catch { /* 临时 worktree 已清理 */ }
    rmSync(tree, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const branch = String(args.branch ?? 'automation/state');
  if (!['pull', 'push'].includes(command)) {
    console.error('用法：automation-state.mjs pull|push [--branch automation/state] [--run-id id] [--campaign id]');
    process.exit(2);
  }
  if (args['dry-run'] === true) {
    console.log(JSON.stringify({
      command, branch, dryRun: true,
      files: [...GOVERNANCE_FILES, ...AI4_FILES].filter(rel => existsSync(resolve(ROOT, rel))),
    }, null, 2));
    process.exit(0);
  }
  try {
    if (command === 'pull') pull(branch);
    else push(branch, args);
  } catch (error) {
    console.error(`自动化状态${command === 'pull' ? '恢复' : '保存'}失败（fail-closed）：${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
