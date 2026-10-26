#!/usr/bin/env node
/** AI9 模块源码部署/回滚：把晋级候选的多模块函数写入正式源码。
 *
 * 纪律：
 * - 只接受通过 `validateArtifact` 全哈希复核的编译型多模块 artifact；
 * - 只替换注册表声明的 (file, function)，文件其余字节不动；
 * - 多模块同文件（M02/M04）按顺序拼接，逐函数哈希复核；
 * - apply 前自动备份目标文件；active-modules.json 记录当前部署身份；
 * - check 可在 CI/网页构建前独立核验"线上源码 = 冠军声明的模块身份"；
 * - revert 只恢复 active-modules.json 记录的备份，不猜测历史。
 *
 * 用法：
 *   node training/scripts/apply-modules.mjs --artifact <candidate.json> --apply
 *   node training/scripts/apply-modules.mjs --artifact <candidate.json> --check
 *   node training/scripts/apply-modules.mjs --revert
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../lib/paths.mjs';
import { validateArtifact } from '../evolution/candidate-artifact.mjs';
import {
  moduleRegistry, getModule, stripLiterals, extractFunction, sha256,
} from '../../ai5/openevolve/node/module_registry.mjs';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const invokedAsScript = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const args = invokedAsScript ? parseArgs(process.argv.slice(2)) : {};
const SRC = resolve(REPO_ROOT, 'web-v1/src');
const BACKUP_ROOT = resolve(REPO_ROOT, 'training/champions/module-backups');
const ACTIVE = resolve(REPO_ROOT, 'training/champions/active-modules.json');

function readArtifact(path) {
  const artifact = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
  validateArtifact(artifact);
  if (artifact.buildArtifact?.compiled !== true || artifact.source?.modules?.length === 0) {
    throw new Error('apply-modules 只接受编译型多模块 artifact');
  }
  return artifact;
}

function moduleSources(artifact, srcRoot) {
  const registry = moduleRegistry();
  return artifact.source.modules.map(meta => {
    const definition = getModule(meta.id, registry);
    if (meta.functionName !== definition.functionName) throw new Error(`${meta.id} 函数名不符`);
    if (meta.file !== `src/${definition.file}`) throw new Error(`${meta.id} 目标文件不符`);
    const file = artifact.source.files.find(f => f.path === meta.path);
    if (!file) throw new Error(`${meta.id} 缺少源码文件`);
    if (sha256(file.content) !== meta.functionSha256) throw new Error(`${meta.id} 源码哈希不符`);
    return { ...meta, text: file.content, target: join(srcRoot, definition.file) };
  });
}

export function checkArtifactModules(artifact, { srcRoot = SRC } = {}) {
  validateArtifact(artifact);
  const mismatches = [];
  for (const source of moduleSources(artifact, srcRoot)) {
    const original = readFileSync(source.target, 'utf8');
    const stripped = stripLiterals(original);
    const fn = extractFunction(stripped, original, source.functionName);
    if (fn.error) { mismatches.push({ id: source.id, reason: fn.error }); continue; }
    if (sha256(fn.text) !== source.functionSha256) {
      mismatches.push({ id: source.id, reason: 'official source module hash ≠ artifact' });
    }
  }
  return mismatches;
}

export function applyArtifactModules(
  artifact,
  { srcRoot = SRC, backupRoot = BACKUP_ROOT, activePath = ACTIVE } = {},
) {
  validateArtifact(artifact);
  const sources = moduleSources(artifact, srcRoot);
  const backupDir = join(backupRoot, artifact.artifactHash);
  if (existsSync(backupDir)) throw new Error(`备份目录已存在：${backupDir}（拒绝重复应用同一 artifact）`);
  mkdirSync(backupDir, { recursive: true });
  const touched = [...new Set(sources.map(s => s.target))];
  for (const target of touched) {
    const relative = target.slice(srcRoot.length + 1);
    copyFileSync(target, join(backupDir, relative.replace(/\//g, '__')));
  }

  const byTarget = new Map();
  for (const source of sources) {
    if (!byTarget.has(source.target)) byTarget.set(source.target, []);
    byTarget.get(source.target).push(source);
  }
  for (const [target, entries] of byTarget) {
    let text = readFileSync(target, 'utf8');
    for (const entry of entries) {
      const stripped = stripLiterals(text);
      const fn = extractFunction(stripped, text, entry.functionName);
      if (fn.error) throw new Error(`${entry.id} 官方函数定位失败：${fn.error}`);
      text = text.slice(0, fn.start) + entry.text + text.slice(fn.end);
    }
    writeFileSync(target, text);
  }
  const mismatches = checkArtifactModules(artifact, { srcRoot });
  if (mismatches.length) throw new Error(`应用后复核失败：${JSON.stringify(mismatches)}`);
  writeFileSync(activePath, JSON.stringify({
    schema: 'century-active-modules-v1',
    artifactHash: artifact.artifactHash,
    sourceHash: artifact.sourceHash,
    candidateId: artifact.candidateId,
    moduleIds: sources.map(s => s.id).sort(),
    modules: sources.map(s => ({ id: s.id, functionName: s.functionName, file: s.file, functionSha256: s.functionSha256 })),
    backupDir: backupDir.replace(REPO_ROOT + '/', ''),
    appliedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  return { applied: sources.map(s => s.id), backupDir };
}

export function revertActiveModules({ srcRoot = SRC, activePath = ACTIVE } = {}) {
  if (!existsSync(activePath)) throw new Error('没有 active-modules.json——没有可回滚的模块部署');
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  const backupDir = resolve(REPO_ROOT, active.backupDir);
  if (!existsSync(backupDir)) throw new Error(`备份目录缺失：${backupDir}`);
  for (const file of readdirRecursive(backupDir)) {
    const relative = file.replace(backupDir + '/', '').replace(/__/g, '/');
    const target = join(srcRoot, relative);
    writeFileSync(target, readFileSync(file));
  }
  rmSync(activePath);
  return { reverted: active.moduleIds, backupDir };
}

function readdirRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirRecursive(path));
    else out.push(path);
  }
  return out;
}

if (invokedAsScript) {
  try {
    if (args.revert === true) {
      console.log(JSON.stringify({ ok: true, ...revertActiveModules() }, null, 2));
      process.exit(0);
    }
    if (!args.artifact) throw new Error('必须提供 --artifact <candidate.json>');
    const artifact = readArtifact(args.artifact);
    if (args.check === true) {
      const mismatches = checkArtifactModules(artifact);
      if (mismatches.length) {
        console.log(JSON.stringify({ ok: false, applied: false, mismatches }, null, 2));
        process.exit(3);
      }
      console.log(JSON.stringify({ ok: true, applied: true, modules: artifact.source.modules.map(m => m.id) }, null, 2));
      process.exit(0);
    }
    if (args.apply === true) {
      console.log(JSON.stringify({ ok: true, ...applyArtifactModules(artifact) }, null, 2));
      process.exit(0);
    }
    throw new Error('必须指定 --apply / --check / --revert 之一');
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 800) }, null, 2));
    process.exit(1);
  }
}
