/** AI5 候选源码树组装：把演化后的 acquisitionValue 函数注入隔离的源码副本。
 *
 * 设计要点（同局双版本隔离的基础）：
 * - 候选树 = 官方源码的字节级副本（import 闭包：从 src/data.ts、src/engine.ts、
 *   src/ai.ts 出发沿相对 import 递归收集——自动覆盖 ai/**、js/**、sim/**、om/**
 *   等官方源码目录，杜绝"决策入口接线新增模块后快照失配"（2026-10-24 事故：
 *   PR #26/#30 把 '../js/adapter.js' 接线进 decision.ts 后 COPIED_PATHS 白名单
 *   未更新，候选编译 TS2307，ai5.yml Seatbelt/e2e 双 job 失败）），
 *   唯一差异是 ai/evaluator.ts 中的 acquisitionValue 函数被替换为演化版本；
 * - 官方 web-v1/src 与 web-v1/dist 全程只读，冠军代码零污染；
 * - 除演化函数外逐文件 SHA256 校验与官方一致（manifest 固证，审计可查）；
 * - 候选树独立 tsc 编译为独立 ESM 模块，与官方 dist/js/ai.js 在同一 Node
 *   进程内是两个互不共享状态的模块实例 —— 同局对战时按席位分别引用。
 *
 * 用法：node assemble_candidate.mjs --program <静态检查通过的函数文本文件> --out <workdir>
 * 退出码 0 = 组装成功（workdir/src 可编译）；非 0 = 失败。
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sha256 = p => createHash('sha256').update(p).digest('hex');

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'); // ai5/openevolve/node → repo
const srcRoot = join(repoRoot, 'web-v1/src');
const programPath = arg('program');
const outDir = arg('out');
if (!programPath || !outDir) { console.error('用法: node assemble_candidate.mjs --program <fn.ts> --out <workdir>'); process.exit(2); }

const functionText = readFileSync(programPath, 'utf8');
const ENTRY_PATHS = ['data.ts', 'engine.ts', 'ai.ts'];

/** import 闭包收集：从入口出发沿相对 import 递归收集全部 TS 源文件。
 * NodeNext 风格的 '.js' 后缀映射回 '.ts'；非相对导入（裸包名）与不存在的
 * 目标静默跳过（web-v1/src 无裸包依赖）。 */
function collectImportClosure() {
  const seen = new Set();
  const queue = [...ENTRY_PATHS];
  const importPattern = /(?:from\s+|import\s+|import\()\s*['"](\.[^'"]+)['"]/g;
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFileSync(join(srcRoot, rel), 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const fromTs = join(srcRoot, rel);
      let target = relative(srcRoot, resolve(dirname(fromTs), match[1]));
      const candidates = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`];
      for (const candidate of candidates) {
        if (existsSync(join(srcRoot, candidate))) { queue.push(candidate); break; }
      }
    }
  }
  return [...seen].sort();
}

/** 与 static_check.mjs 相同的剥离逻辑（用于在官方 evaluator.ts 中定位原函数）。 */
function stripLiterals(src) { /* 简版：定位只依赖注释/字符串安全的最小实现 */
  let out = '', i = 0; const n = src.length; let mode = 'code';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += ' '; i++; continue; }
      if (c === '"') { mode = 'dq'; out += ' '; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } else out += ' '; i++; continue; }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; out += '  '; i += 2; } else { out += c === '\n' ? c : ' '; i++; } continue; }
    if (mode === 'sq') { if (c === '\\') { out += '  '; i += 2; } else if (c === "'") { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
    if (mode === 'dq') { if (c === '\\') { out += '  '; i += 2; } else if (c === '"') { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
    if (mode === 'tpl') { if (c === '\\') { out += '  '; i += 2; } else if (c === '`') { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
  }
  return out;
}

function extractFunction(stripped, original) {
  const m = stripped.match(/export\s+function\s+acquisitionValue\s*\(/);
  if (!m) return { error: '官方 evaluator.ts 中未找到 acquisitionValue（源码结构变更？）' };
  const stack = [];
  let end = -1;
  for (let i = m.index; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      const open = stack.pop();
      const expect = c === '}' ? '{' : c === ')' ? '(' : '[';
      if (open !== expect) return { error: `官方函数括号错配（偏移 ${i - m.index}）` };
      if (stack.length === 0 && c === '}') { end = i + 1; break; }
    }
  }
  if (end < 0 || stack.length !== 0) return { error: '官方函数括号配平失败' };
  return { text: original.slice(m.index, end), start: m.index, end };
}

try {
  const officialEvaluator = readFileSync(join(srcRoot, 'ai/evaluator.ts'), 'utf8');
  const strippedOfficial = stripLiterals(officialEvaluator);
  const orig = extractFunction(strippedOfficial, officialEvaluator);
  if (orig.error) { console.error(orig.error); process.exit(1); }

  // 演化函数合法性快速复核（签名与导出名）——静态检查已在上一级执行，这里防御性重复。
  if (!/^export\s+function\s+acquisitionValue\s*\(/.test(functionText)) {
    console.error('演化函数文本必须以 export function acquisitionValue( 开头'); process.exit(1);
  }

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  const closure = collectImportClosure();
  mkdirSync(join(outDir, 'src'), { recursive: true });
  for (const rel of closure) {
    mkdirSync(dirname(join(outDir, 'src', rel)), { recursive: true });
    cpSync(join(srcRoot, rel), join(outDir, 'src', rel));
  }

  // 替换演化函数（保持函数前后内容逐字节不动）。
  const evalPath = join(outDir, 'src/ai/evaluator.ts');
  const spliced = officialEvaluator.slice(0, orig.start) + functionText + officialEvaluator.slice(orig.end);
  if (spliced === officialEvaluator) {
    console.error('替换未生效：演化函数与原函数完全一致（将作为基线一致性候选处理）');
  }
  writeFileSync(evalPath, spliced);

  // 逐文件哈希固证：候选树内全部文件（除 evaluator.ts 外）必须与官方逐字节一致。
  const manifest = { splicedFile: 'src/ai/evaluator.ts', evolvedFunctionSha256: sha256(functionText), files: {} };
  const files = {};
  const srcDir = join(outDir, 'src');
  for (const f of listFiles(srcDir)) {
    const rel = `src/${relative(srcDir, f)}`;
    files[rel] = { sha256: sha256(readFileSync(f)), matchesOfficial: readFileSync(f).equals(readFileSync(join(srcRoot, relative(srcDir, f)))) };
  }
  const mismatches = Object.entries(files).filter(([k, v]) => !v.matchesOfficial).map(([k]) => k);
  // 允许两种形态：仅 evaluator.ts 有差异（演化候选）；或与官方完全一致
  // （基线候选/无行为变化的演化，交由探针与对战判定）。
  const invalid = mismatches.filter(k => k !== 'src/ai/evaluator.ts');
  if (invalid.length > 0) {
    console.error(`源码树完整性校验失败：与官方不一致的文件应仅 evaluator.ts，实际：${invalid.join(', ')}`);
    process.exit(1);
  }
  files['src/ai/evaluator.ts'].diff = 'acquisitionValue 函数替换为演化版本（函数外内容逐字节一致）';

  // 作用域 tsconfig：只编译候选树（import 闭包内的文件），严格选项与 web-v1 完全一致。
  writeFileSync(join(outDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      outDir: 'dist/js', rootDir: 'src', noEmitOnError: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2));

  manifest.files = files;
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, files: Object.keys(files).length, evolvedFunctionSha256: manifest.evolvedFunctionSha256 }));
} catch (error) {
  console.error(`组装失败：${error.message}`);
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
