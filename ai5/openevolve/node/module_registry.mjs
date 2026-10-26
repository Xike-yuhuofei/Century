/** AI 9.0 可进化模块注册表与源码工具（Node/Python 共用的单一权威）。
 *
 * 职责：
 * - 读取 training/evolution/module-registry.json（权威身份表）；
 * - 从官方源码提取模块函数、按模块生成 OpenEvolve 程序；
 * - EVOLVE-BLOCK 解析、函数括号配平、字符串/注释剥离；
 * - 静态检查与多模块组装共用，避免两份口径漂移。
 *
 * 安全边界：模块只允许替换注册表中声明的一个导出的纯函数；文件名、函数名、
 * 参数签名、依赖与最大源码长度全部由注册表预先冻结。任何未注册函数/文件、
 * 签名变化、额外导出或危险构造都判非法。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SRC_ROOT = join(REPO_ROOT, 'web-v1/src');
export const REGISTRY_PATH = join(REPO_ROOT, 'training/evolution/module-registry.json');

let cached = null;

export function moduleRegistry({ path = REGISTRY_PATH } = {}) {
  if (cached && cached.path === path) return cached.registry;
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  validateRegistry(registry);
  cached = { path, registry };
  return registry;
}

export function validateRegistry(registry) {
  const fail = why => { throw new Error(`模块注册表非法：${why}`); };
  if (registry?.schema !== 'century-evolvable-module-registry-v1') fail('schema');
  if (!Array.isArray(registry.modules) || registry.modules.length === 0) fail('modules 为空');
  const ids = new Set();
  const functions = new Set();
  for (const m of registry.modules) {
    for (const key of ['id', 'functionName', 'file', 'signature', 'kind', 'wiring']) {
      if (typeof m[key] !== (key === 'signature' ? 'object' : 'string')) fail(`${m.id ?? '?'}.${key}`);
    }
    if (!/^M[0-9]{2}$/.test(m.id)) fail(`id 非法：${m.id}`);
    if (ids.has(m.id)) fail(`重复模块 id：${m.id}`);
    if (functions.has(m.functionName)) fail(`重复函数名：${m.functionName}`);
    if (!Array.isArray(m.signature) || m.signature.length === 0) fail(`${m.id}.signature 为空`);
    if (m.file.startsWith('/') || m.file.includes('..')) fail(`${m.id}.file 路径非法`);
    if (!existsSync(join(SRC_ROOT, m.file))) fail(`${m.id}.file 不存在：${m.file}`);
    ids.add(m.id);
    functions.add(m.functionName);
  }
  return true;
}

export function listModules(registry = moduleRegistry()) {
  return registry.modules;
}

export function getModule(id, registry = moduleRegistry()) {
  const module = registry.modules.find(m => m.id === id);
  if (!module) throw new Error(`未注册模块：${String(id)}（可用：${registry.modules.map(m => m.id).join(',')}）`);
  return module;
}

export function moduleByFunctionName(functionName, registry = moduleRegistry()) {
  return registry.modules.find(m => m.functionName === functionName) ?? null;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 剥离字符串/模板字符串/注释，保留换行与代码位置（长度不变）。 */
export function stripLiterals(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += ' '; i++; continue; }
      if (c === '"') { mode = 'dq'; out += ' '; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } else out += ' '; i++; continue; }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; out += '  '; i += 2; } else { out += c === '\n' ? c : ' '; i++; }
      continue;
    }
    if (mode === 'sq') { if (c === '\\') { out += '  '; i += 2; } else if (c === "'") { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
    if (mode === 'dq') { if (c === '\\') { out += '  '; i += 2; } else if (c === '"') { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
    if (mode === 'tpl') { if (c === '\\') { out += '  '; i += 2; } else if (c === '`') { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
  }
  return out;
}

/** 从剥离文本中提取指定名称的 export function（三型括号栈配平）。 */
export function extractFunction(stripped, original, functionName) {
  const re = new RegExp(`export\\s+function\\s+${functionName}\\s*\\(`);
  const m = stripped.match(re);
  if (!m) return { error: `未找到 export function ${functionName}` };
  if (stripped.length !== original.length) return { error: '内部错误：剥离文本长度不一致' };
  const start = m.index;
  const stack = [];
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      const open = stack.pop();
      const expect = c === '}' ? '{' : c === ')' ? '(' : '[';
      if (open !== expect) return { error: `${functionName} 括号错配（偏移 ${i - start}）` };
      if (stack.length === 0 && c === '}') { end = i + 1; break; }
    }
  }
  if (end < 0 || stack.length !== 0) return { error: `${functionName} 函数体括号不配平` };
  return { text: original.slice(start, end), strippedText: stripped.slice(start, end), start, end };
}

/** 顶层逗号切分（跳过括号/方括号/花括号内部）。 */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(s => s.trim()).filter(Boolean);
}

/** 参数名列表（只取顶层参数，忽略类型注解与默认值）。 */
export function functionParams(strippedFunction) {
  const m = strippedFunction.match(/export\s+function\s+\w+\s*\(([\s\S]*?)\)\s*(?::|{)/);
  if (!m) return null;
  return splitTopLevel(m[1]).map(p => p.replace(/[:=][\s\S]*$/, '').trim()).filter(Boolean);
}

/** 解析程序文本中的全部 EVOLVE-BLOCK（支持 // 与块注释标记）。 */
export function extractEvolveBlocks(text) {
  const markerRe = /(?:\/\*\s*EVOLVE-BLOCK-(START|END)\s*\*\/|\/\/\s*EVOLVE-BLOCK-(START|END)\s*)/g;
  const markers = [];
  for (const match of text.matchAll(markerRe)) {
    const kind = match[1] ?? match[2];
    markers.push({ kind, start: match.index, end: match.index + match[0].length });
  }
  const blocks = [];
  let open = null;
  for (const marker of markers) {
    if (marker.kind === 'START') {
      if (open) return { error: 'EVOLVE-BLOCK 嵌套：START 未闭合又出现 START' };
      open = marker;
    } else {
      if (!open) return { error: 'EVOLVE-BLOCK 异常：END 无对应 START' };
      blocks.push({ contentStart: open.end, contentEnd: marker.start, text: text.slice(open.end, marker.start) });
      open = null;
    }
  }
  if (open) return { error: 'EVOLVE-BLOCK 异常：START 无对应 END' };
  return { blocks };
}

/** 官方源码中的模块函数文本（用于生成初始程序 / 校验）。 */
export function officialFunctionText(module) {
  const path = join(SRC_ROOT, module.file);
  const original = readFileSync(path, 'utf8');
  const stripped = stripLiterals(original);
  const fn = extractFunction(stripped, original, module.functionName);
  if (fn.error) throw new Error(`${module.id} 官方源码提取失败：${fn.error}`);
  const params = functionParams(fn.strippedText);
  if (!params || JSON.stringify(params) !== JSON.stringify(module.signature)) {
    throw new Error(`${module.id} 官方签名与注册表不一致：期望 (${module.signature.join(',')})，实际 (${(params ?? []).join(',')})`);
  }
  return fn.text;
}

/** 生成单模块 OpenEvolve 程序（EVOLVE-BLOCK 内为官方函数文本）。 */
export function renderModuleProgram(module, { header = true } = {}) {
  const text = officialFunctionText(module);
  const preamble = header ? `// AI9 模块 ${module.id} · ${module.label}
// 函数：${module.functionName}（${module.file}）
// 契约：签名不得改动；只能使用模块文档列出的作用域内依赖；禁止 import/eval/
// 网络/文件/进程/随机数/时钟/隐藏牌库字段；必须纯且确定性。
// 真实决策接线：${module.wiring}
` : '';
  return `${preamble}/* EVOLVE-BLOCK-START */
${text}
/* EVOLVE-BLOCK-END */
`;
}

/** 生成多模块联合程序（一个 EVOLVE-BLOCK = 一个模块函数）。 */
export function composeProgram(moduleIds, { registry = moduleRegistry(), header = true } = {}) {
  const modules = moduleIds.map(id => getModule(id, registry));
  const preamble = header ? `// AI9 多模块联合进化程序
// 模块：${modules.map(m => `${m.id}:${m.functionName}`).join(' / ')}
// 每个 EVOLVE-BLOCK 对应一个模块；不得增删 block、不得改签名。
// 只能使用各模块的 scope 列出的作用域内依赖；禁止 import/eval/网络/文件/进程/
// 随机数/时钟/隐藏牌库字段；函数必须纯且确定性。
` : '';
  const contracts = modules.map(m => `// ===== ${m.id} ${m.label} =====
// 函数：${m.functionName}（${m.file}）
// 签名：(${m.signature.join(', ')})
// 真实决策接线：${m.wiring}
// 依赖模块：${(m.dependsOn ?? []).join(', ') || '无'}
// 作用域内可用依赖：${(m.scope ?? []).join('、')}
`).join('');
  const blocks = modules.map(m => renderModuleProgram(m, { header: false })).join('\n');
  return `${preamble}${contracts}\n${blocks}`;
}

/** 数学上界裁剪（候选输出/策略边界统一使用）。 */
export function clampNumber(value, low, high, fallback = low) {
  return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

/** 写文件（自动建父目录）。 */
export function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
