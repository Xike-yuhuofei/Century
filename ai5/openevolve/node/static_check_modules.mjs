/** AI 9.0 多模块静态安全检查（不可信候选代码的第一道闸门）。
 *
 * 用法：
 *   node static_check_modules.mjs --program <file> --out <json> [--modules M01,M02] [--registry <json>]
 *
 * 检查项（任一失败 = 候选淘汰）：
 * 1. EVOLVE-BLOCK 数量与 --modules 精确一致；每个 block 只含一个注册函数；
 * 2. 函数名/导出名/参数签名与模块注册表逐参一致；
 * 3. block 内不得有函数外的可执行代码或额外导出（防跨模块逃逸）；
 * 4. 禁止 import/require/eval/Function/process/globalThis/DOM/网络/文件系统/
 *    随机数/时钟/隐藏牌库字段/模板字符串/明显死循环；
 * 5. 单模块源码长度不超过注册表上限；
 * 6. 输出每模块函数文本（供组装）与 SHA256（供 artifact 身份）。
 *
 * 退出码 0 = 通过；非 0 = 淘汰。stdout 输出结构化判定。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  moduleRegistry, getModule, moduleByFunctionName, extractEvolveBlocks,
  stripLiterals, extractFunction, functionParams, sha256, officialFunctionText,
} from './module_registry.mjs';

/** 参数声明文本（含类型/默认值），用于拒绝"只改类型/默认值"的接口漂移。 */
function signatureDeclaration(strippedFunction) {
  const m = strippedFunction.match(/export\s+function\s+\w+\s*\(([\s\S]*?)\)\s*(?::|{)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const programPath = arg('program');
const outPath = arg('out');
const registryPath = arg('registry', undefined);
const requestedIds = arg('modules') ? String(arg('modules')).split(',').map(s => s.trim()).filter(Boolean) : null;
if (!programPath) { console.error('缺少 --program'); process.exit(2); }

const FORBIDDEN_PATTERNS = [
  { re: /\bimport\b/, why: '禁止 import（只能使用所在文件已有依赖）' },
  { re: /\brequire\s*\(/, why: '禁止 require' },
  { re: /\beval\s*\(/, why: '禁止 eval' },
  { re: /\bnew\s+Function\b|\bFunction\s*\(|\bconstructor\b/, why: '禁止 Function 动态构造 / constructor 逃逸' },
  { re: /\bprocess\b/, why: '禁止访问 process' },
  { re: /\bglobalThis\b/, why: '禁止访问 globalThis' },
  { re: /\bwindow\b|\bdocument\b|\blocalStorage\b|\bsessionStorage\b/, why: '禁止 DOM/浏览器存储' },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bimport\s*\(/, why: '禁止网络/动态导入' },
  { re: /\bmerchantDeck\b|\bgolemDeck\b|\.deck\b/, why: '禁止访问隐藏牌库字段' },
  { re: /Math\.random/, why: '禁止随机数（决策必须确定性）' },
  { re: /\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/, why: '禁止计时器/时钟' },
  { re: /\bwriteFileSync\b|\breadFileSync\b|\bnode:fs\b|\bnode:net\b|\bnode:child_process\b|\bnode:os\b/, why: '禁止文件系统/网络/进程模块' },
  { re: /`/, why: '禁止模板字符串（防拼接注入）' },
  { re: /\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/, why: '禁止明显死循环' },
  { re: /\bexport\s+(?!function\b)/, why: 'block 内只允许一个 export function' },
];

function fail(reason, extra = {}) {
  const output = { ok: false, stage: 'static-modules', reason: String(reason).slice(0, 600), ...extra };
  if (outPath) writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
  process.exit(1);
}

function check() {
  const registry = moduleRegistry(registryPath ? { path: registryPath } : {});
  const original = readFileSync(programPath, 'utf8');
  const parsed = extractEvolveBlocks(original);
  if (parsed.error) return { ok: false, reason: parsed.error };
  const blocks = parsed.blocks;
  if (!blocks.length) return { ok: false, reason: '程序缺少 EVOLVE-BLOCK' };
  if (blocks.length > 12) return { ok: false, reason: `EVOLVE-BLOCK 过多：${blocks.length}` };

  const modules = [];
  const seenFunctions = new Set();
  const seenIds = new Set();
  for (const [index, block] of blocks.entries()) {
    const strippedBlock = stripLiterals(block.text);
    // block 内除空白/注释外，去掉唯一的函数文本后必须为空。
    const exportMatches = [...strippedBlock.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
    if (exportMatches.length !== 1) {
      return { ok: false, reason: `block#${index + 1} 必须恰好包含一个 export function，实际 ${exportMatches.length} 个` };
    }
    const functionName = exportMatches[0][1];
    const module = moduleByFunctionName(functionName, registry);
    if (!module) return { ok: false, reason: `block#${index + 1} 函数 ${functionName} 不在模块注册表` };
    if (seenFunctions.has(functionName)) return { ok: false, reason: `重复模块函数：${functionName}` };
    if (seenIds.has(module.id)) return { ok: false, reason: `重复模块：${module.id}` };
    seenFunctions.add(functionName);
    seenIds.add(module.id);

    const fn = extractFunction(strippedBlock, block.text, functionName);
    if (fn.error) return { ok: false, reason: `block#${index + 1}（${module.id}）：${fn.error}` };
    const before = stripLiterals(block.text.slice(0, fn.start)).trim();
    const after = stripLiterals(block.text.slice(fn.end)).trim();
    if (before || after) {
      return { ok: false, reason: `block#${index + 1}（${module.id}）含函数外代码：${(before || after).slice(0, 120)}` };
    }
    if (fn.strippedText.length > module.maxSourceBytes) {
      return { ok: false, reason: `${module.id} 源码 ${fn.strippedText.length}B 超过上限 ${module.maxSourceBytes}B` };
    }
    const params = functionParams(fn.strippedText);
    if (!params || JSON.stringify(params) !== JSON.stringify(module.signature)) {
      return {
        ok: false,
        reason: `${module.id} 签名不符：期望 (${module.signature.join(', ')})，实际 (${(params ?? []).join(', ')})`,
      };
    }
    const officialStripped = stripLiterals(officialFunctionText(module));
    const expectedSignature = signatureDeclaration(officialStripped);
    const actualSignature = signatureDeclaration(fn.strippedText);
    if (expectedSignature === null || actualSignature === null || expectedSignature !== actualSignature) {
      return { ok: false, reason: `${module.id} 参数类型/默认值漂移：官方 (${expectedSignature})，候选 (${actualSignature})` };
    }
    const hits = [];
    for (const { re, why } of FORBIDDEN_PATTERNS) {
      const m = fn.strippedText.match(re);
      if (m) hits.push({ why, token: m[0] });
    }
    if (hits.length) {
      return { ok: false, reason: `${module.id} 包含禁止构造：${hits.map(h => `${h.why}（${h.token}）`).join('；')}` };
    }
    const pairs = { '{': 0, '(': 0, '[': 0 };
    for (const c of fn.strippedText) {
      if (c === '{') pairs['{']++; if (c === '}') pairs['{']--;
      if (c === '(') pairs['(']++; if (c === ')') pairs['(']--;
      if (c === '[') pairs['[']++; if (c === ']') pairs['[']--;
    }
    if (Object.values(pairs).some(v => v !== 0)) return { ok: false, reason: `${module.id} 括号配平失败` };

    modules.push({
      id: module.id,
      functionName,
      file: module.file,
      interfaceVersion: registry.interfaceVersion,
      functionText: fn.text,
      functionSha256: sha256(fn.text),
      textLength: fn.strippedText.length,
    });
  }

  if (requestedIds) {
    const actual = modules.map(m => m.id).sort();
    const expected = [...requestedIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return { ok: false, reason: `模块集合不符：期望 ${expected.join(',')}，实际 ${actual.join(',')}` };
    }
  }
  // 依赖必须存在（若候选显式声明依赖，依赖模块可不在本候选内——按官方实现补齐）；
  // 这里只检查注册表引用完整性，避免未知依赖 id。
  const known = new Set(registry.modules.map(m => m.id));
  for (const module of modules) {
    const def = getModule(module.id, registry);
    for (const dep of def.dependsOn ?? []) {
      if (!known.has(dep)) return { ok: false, reason: `${module.id} 依赖未注册模块：${dep}` };
    }
  }
  return { ok: true, modules };
}

const result = check();
if (!result.ok) fail(result.reason, { stage: 'static-modules' });

const output = {
  ok: true,
  stage: 'static-modules',
  registryPath,
  modules: result.modules.map(({ functionText: _text, ...rest }) => rest),
  combinedSha256: sha256(result.modules.map(m => `${m.id}:${m.functionSha256}`).join('\n')),
};
const moduleFiles = {};
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ ...output, moduleFiles: Object.fromEntries(result.modules.map(m => [m.id, outPath.replace(/\.json$/, `.${m.id}.fn.ts`)])) }, null, 2));
  for (const module of result.modules) {
    const path = outPath.replace(/\.json$/, `.${module.id}.fn.ts`);
    writeFileSync(path, module.functionText);
    moduleFiles[module.id] = path;
  }
  // 兼容旧单模块调用方（AI5）：额外写 legacy .fn.ts 与 functionSha256。
  if (result.modules.length === 1) {
    const legacy = outPath.replace(/\.json$/, '.fn.ts');
    writeFileSync(legacy, result.modules[0].functionText);
    output.functionTextSaved = true;
    output.functionSha256 = result.modules[0].functionSha256;
  }
}
output.moduleFiles = moduleFiles;
console.log(JSON.stringify({ ...output, modules: output.modules.map(m => `${m.id}:${m.functionSha256.slice(0, 12)}`) }));
process.exit(0);
