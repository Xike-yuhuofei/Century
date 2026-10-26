/** AI 9.0 多模块候选源码树组装。
 *
 * 用法：
 *   node assemble_modules.mjs --manifest <modules.json> --out <workdir>
 *   node assemble_modules.mjs --program <fn.ts> --out <workdir>   # 单模块兼容
 *
 * 语义：
 * - 候选树 = 官方 web-v1/src 的 import 闭包副本（入口 data.ts/engine.ts/ai.ts）；
 * - 逐模块把注册表声明的函数替换为候选函数文本，其余字节完全一致；
 * - 多个模块可以落在同一文件（如 M02/M04 都在 ai/evaluator.ts），按顺序拼接；
 * - 不信任候选路径：函数文本直接来自静态检查落盘的模块文件；
 * - 输出 manifest 记录每个模块的函数哈希、目标文件与逐文件 SHA256；
 * - 校验：除目标文件外不得有任何差异；目标文件必须能由官方文本 + 模块函数文本
 *   精确重建（防止插入函数外代码）。
 */
import {
  readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import {
  REPO_ROOT, SRC_ROOT, moduleRegistry, getModule, stripLiterals, extractFunction, sha256,
} from './module_registry.mjs';

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const manifestPath = arg('manifest');
const singleProgram = arg('program');
const outDir = arg('out');
const registryPath = arg('registry', undefined);
if ((!manifestPath && !singleProgram) || !outDir) {
  console.error('用法: node assemble_modules.mjs --manifest <modules.json> --out <workdir>（或 --program <fn.ts>）');
  process.exit(2);
}

const registry = moduleRegistry(registryPath ? { path: registryPath } : {});
const ENTRY_PATHS = ['data.ts', 'engine.ts', 'ai.ts'];

function collectImportClosure() {
  const seen = new Set();
  const queue = [...ENTRY_PATHS];
  const importPattern = /(?:from\s+|import\s+|import\()\s*['"](\.[^'"]+)['"]/g;
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFileSync(join(SRC_ROOT, rel), 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const fromTs = join(SRC_ROOT, rel);
      const target = relative(SRC_ROOT, resolve(dirname(fromTs), match[1]));
      const candidates = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`];
      for (const candidate of candidates) {
        if (existsSync(join(SRC_ROOT, candidate))) { queue.push(candidate); break; }
      }
    }
  }
  return [...seen].sort();
}

/** 读取模块清单：manifest JSON 或旧单函数文本。 */
function loadModules() {
  if (singleProgram) {
    const text = readFileSync(singleProgram, 'utf8');
    const fnNameMatch = text.match(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (!fnNameMatch) throw new Error('单模块程序缺少 export function');
    const module = registry.modules.find(m => m.functionName === fnNameMatch[1]);
    if (!module) throw new Error(`单模块函数未注册：${fnNameMatch[1]}`);
    return [{ module, text }];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) throw new Error('manifest.modules 为空');
  return manifest.modules.map(entry => {
    const module = getModule(entry.id, registry);
    if (entry.functionName !== module.functionName) throw new Error(`${entry.id} 函数名与注册表不一致`);
    if (entry.file !== module.file) throw new Error(`${entry.id} 文件与注册表不一致`);
    const path = entry.functionPath ?? manifest.moduleFiles?.[entry.id];
    if (!path) throw new Error(`${entry.id} 缺少函数文本路径`);
    const text = readFileSync(path, 'utf8');
    if (sha256(text) !== entry.functionSha256) throw new Error(`${entry.id} 函数文本哈希与静态检查不一致`);
    return { module, text };
  });
}

function extractCurrent(text, functionName) {
  const stripped = stripLiterals(text);
  return extractFunction(stripped, text, functionName);
}

function replaceFunction(text, functionName, newText) {
  const fn = extractCurrent(text, functionName);
  if (fn.error) throw new Error(`目标文件缺少 ${functionName}：${fn.error}`);
  return text.slice(0, fn.start) + newText + text.slice(fn.end);
}

/** 只允许注释/空白在 block 内函数文本之外（组装层防御性复核）。 */
function assertPureFunctionText(text, functionName) {
  const stripped = stripLiterals(text);
  const m = stripped.match(new RegExp(`export\\s+function\\s+${functionName}\\s*\\(`));
  if (!m) throw new Error(`${functionName} 文本缺少 export function`);
  const before = stripLiterals(text.slice(0, m.index)).trim();
  // 允许函数前的注释（剥离后为空）。
  if (before) throw new Error(`${functionName} 文本含函数外代码：${before.slice(0, 100)}`);
  const fn = extractFunction(stripped, text, functionName);
  if (fn.error) throw new Error(`${functionName} 文本结构非法：${fn.error}`);
  const after = stripLiterals(text.slice(fn.end)).trim();
  if (after) throw new Error(`${functionName} 文本含函数外代码：${after.slice(0, 100)}`);
}

try {
  const modules = loadModules();
  const byFile = new Map();
  for (const { module, text } of modules) {
    assertPureFunctionText(text, module.functionName);
    if (!byFile.has(module.file)) byFile.set(module.file, []);
    byFile.get(module.file).push({ module, text });
  }
  if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  const closure = collectImportClosure();
  mkdirSync(join(outDir, 'src'), { recursive: true });
  for (const rel of closure) {
    mkdirSync(dirname(join(outDir, 'src', rel)), { recursive: true });
    cpSync(join(SRC_ROOT, rel), join(outDir, 'src', rel));
  }

  const modulesManifest = [];
  const touchedFiles = [];
  for (const [file, entries] of byFile) {
    const target = join(outDir, 'src', file);
    if (!existsSync(target)) throw new Error(`目标文件不在 import 闭包：${file}`);
    const official = readFileSync(join(SRC_ROOT, file), 'utf8');
    let candidate = official;
    for (const { module, text } of entries) {
      candidate = replaceFunction(candidate, module.functionName, text);
    }
    // 精确重建校验：官方文件逐个替换模块函数后必须与候选文件逐字节一致。
    let rebuilt = official;
    for (const { module, text } of entries) rebuilt = replaceFunction(rebuilt, module.functionName, text);
    if (rebuilt !== candidate) throw new Error(`${file} 重建校验失败（存在函数外改动）`);
    writeFileSync(target, candidate);
    touchedFiles.push(`src/${file}`);
    for (const { module, text } of entries) {
      modulesManifest.push({
        id: module.id,
        functionName: module.functionName,
        file: `src/${module.file}`,
        interfaceVersion: registry.interfaceVersion,
        functionSha256: sha256(text),
        textLength: stripLiterals(text).length,
      });
    }
  }

  // 逐文件哈希：候选树内除目标文件外必须与官方逐字节一致。
  const files = {};
  const srcDir = join(outDir, 'src');
  for (const f of listFiles(srcDir)) {
    const rel = `src/${relative(srcDir, f)}`;
    const same = readFileSync(f).equals(readFileSync(join(SRC_ROOT, relative(srcDir, f))));
    files[rel] = { sha256: sha256(readFileSync(f)), matchesOfficial: same };
  }
  const invalid = Object.entries(files)
    .filter(([k, v]) => !v.matchesOfficial && !touchedFiles.includes(k))
    .map(([k]) => k);
  if (invalid.length) throw new Error(`源码树完整性失败：除目标文件外存在差异：${invalid.join(', ')}`);

  writeFileSync(join(outDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      outDir: 'dist/js', rootDir: 'src', noEmitOnError: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2));

  const manifest = {
    ok: true,
    protocol: registry.artifactProtocol,
    interfaceVersion: registry.interfaceVersion,
    registryVersion: registry.version,
    modules: modulesManifest,
    touchedFiles: touchedFiles.map(f => `src/${f}`),
    files,
    combinedModuleHash: sha256(modulesManifest.map(m => `${m.id}:${m.functionSha256}`).join('\n')),
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, modules: modulesManifest.map(m => `${m.id}:${m.functionSha256.slice(0, 12)}`), files: Object.keys(files).length }));
} catch (error) {
  console.error(`多模块组装失败：${error.message}`);
  process.exit(1);
}

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}
