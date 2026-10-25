/** AI5 静态安全检查：验证演化后的 acquisitionValue 程序文本。
 *
 * 检查项（任何一项失败即判非法，候选淘汰）：
 * 1. EVOLVE-BLOCK 标记存在且成对（OpenEvolve enforce_evolve_blocks 的独立复核）；
 * 2. 恰好导出一个 acquisitionValue 函数，签名与官方接口逐参一致；
 * 3. 函数体内无禁止构造：import/require/eval/Function/process/globalThis/fetch/
 *    动态导入/隐藏牌库字段（merchantDeck/golemDeck）/随机数/计时器/DOM；
 * 4. 括号配平（剥离字符串与注释后）；
 * 5. 输出函数文本 SHA256 供审计。
 *
 * 用法：node static_check.mjs --program <file> [--out <json>]
 * 退出码 0 = 通过；非 0 = 不通过（stdout 输出 JSON 判定详情）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const programPath = arg('program');
const outPath = arg('out');
if (!programPath) { console.error('缺少 --program'); process.exit(2); }

const FORBIDDEN_PATTERNS = [
  { re: /\bimport\b/, why: '禁止 import（只能使用所在文件已有依赖）' },
  { re: /\brequire\s*\(/, why: '禁止 require' },
  { re: /\beval\s*\(/, why: '禁止 eval' },
  { re: /\bnew\s+Function\b|\bFunction\s*\(|\bconstructor\b/, why: '禁止 Function 动态构造 / constructor 逃逸' },
  { re: /\bprocess\b/, why: '禁止访问 process' },
  { re: /\bglobalThis\b/, why: '禁止访问 globalThis' },
  { re: /\bwindow\b|\bdocument\b|\blocalStorage\b|\bsessionStorage\b/, why: '禁止 DOM/浏览器存储' },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, why: '禁止网络访问' },
  { re: /\bmerchantDeck\b|\bgolemDeck\b|\.deck\b/, why: '禁止访问隐藏牌库字段' },
  { re: /Math\.random/, why: '禁止随机数（决策必须确定性）' },
  { re: /\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b/, why: '禁止计时器/时钟（决策必须确定性且纯净）' },
  { re: /\bwriteFileSync\b|\breadFileSync\b|\bnode:fs\b|\bnode:net\b|\bnode:child_process\b|\bnode:os\b/, why: '禁止文件系统/网络/进程模块' },
  { re: /`/, why: '禁止模板字符串（防止拼接注入代码）' },
];

/** 剥离字符串/模板/正则与注释，避免误报与括号误配。 */
function stripLiterals(src) {
  let out = '', i = 0;
  const n = src.length;
  let mode = 'code'; // code | line | block | sq | dq | tpl
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

/** 从文本中提取配平的 export function acquisitionValue 函数全文。
 * 用三型括号栈扫描：签名参数里的内联类型注解（如 state: {...}）会自闭合，
 * 函数体是最后一个未闭合的 {...}，栈首次清空即函数结束。 */
function extractFunction(stripped, original) {
  const m = stripped.match(/export\s+function\s+acquisitionValue\s*\(/);
  if (!m) return { error: '未找到 export function acquisitionValue' };
  const start = m.index;
  if (stripped.length !== original.length) return { error: '内部错误：剥离文本长度不一致' };
  const stack = [];
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      const open = stack.pop();
      const expect = c === '}' ? '{' : c === ')' ? '(' : '[';
      if (open !== expect) return { error: `括号错配：期望 ${expect}，遇到 ${c}（偏移 ${i - start}）` };
      // 只有函数体的顶层 { 在 } 处闭合时才终止；参数表 ) 清空栈后继续
      // 扫描（后面还有返回类型与函数体）。
      if (stack.length === 0 && c === '}') { end = i + 1; break; }
    }
  }
  if (end < 0 || stack.length !== 0) return { error: '函数体括号不配平' };
  return { text: original.slice(start, end), start, end };
}

const EXPECTED_PARAMS = ['state', 'cardId', 'preferred', 'profile', 'pressure', 'params', 'model'];

function check() {
  const original = readFileSync(programPath, 'utf8');
  const stripped = stripLiterals(original);

  // 标记本身是注释，必须在原文中查找（剥离文本中注释会被清除）。
  const starts = [...original.matchAll(/\/\*\s*EVOLVE-BLOCK-START\s*\*\//g)].map(m => m.index);
  const ends = [...original.matchAll(/\/\*\s*EVOLVE-BLOCK-END\s*\*\//g)].map(m => m.index);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return { ok: false, stage: 'static', reason: `EVOLVE-BLOCK 标记异常（START×${starts.length}, END×${ends.length}）` };
  }

  const fn = extractFunction(stripped, original);
  if (fn.error) return { ok: false, stage: 'static', reason: fn.error };
  if (fn.start < starts[0] || fn.end > ends[0]) {
    return { ok: false, stage: 'static', reason: 'acquisitionValue 函数必须完整位于 EVOLVE-BLOCK 内' };
  }

  const sigMatch = stripped.slice(fn.start, fn.start + 400).match(
    /export\s+function\s+acquisitionValue\s*\(([^)]*)\)/,
  );
  if (!sigMatch) return { ok: false, stage: 'static', reason: '无法解析参数签名' };
  const params = sigMatch[1].split(',').map(s => s.trim().split(/[:\s]/)[0]).filter(Boolean);
  if (JSON.stringify(params) !== JSON.stringify(EXPECTED_PARAMS)) {
    return { ok: false, stage: 'static', reason: `签名不符：期望 (${EXPECTED_PARAMS.join(', ')})，实际 (${params.join(', ')})` };
  }

  const fnStripped = stripped.slice(fn.start, fn.end);
  const hits = [];
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    const m = fnStripped.match(re);
    if (m) hits.push({ why, token: m[0] });
  }
  if (hits.length) {
    return { ok: false, stage: 'static', reason: `包含禁止构造：${hits.map(h => `${h.why}（${h.token}）`).join('；')}` };
  }

  const fnText = original.slice(fn.start, fn.end);
  // 括号配平复核（剥离文本内已保证，这里做粗检防御）。
  const pairs = { '{': 0, '(': 0, '[': 0 };
  for (const c of fnStripped) {
    if (c === '{') pairs['{']++; if (c === '}') pairs['{']--;
    if (c === '(') pairs['(']++; if (c === ')') pairs['(']--;
    if (c === '[') pairs['[']++; if (c === ']') pairs['[']--;
  }
  if (Object.values(pairs).some(v => v !== 0)) {
    return { ok: false, stage: 'static', reason: '括号配平校验失败' };
  }

  return {
    ok: true, stage: 'static',
    functionText: fnText,
    functionSha256: createHash('sha256').update(fnText).digest('hex'),
    textLength: fnText.length,
  };
}

const result = check();
const output = { ...result, functionText: undefined, functionTextSaved: false };
if (outPath && result.ok) {
  writeFileSync(outPath, JSON.stringify({ ...output, functionTextSaved: true }, null, 2));
  // 函数文本单独落盘，供组装步骤使用（避免 JSON 转义损耗）。
  writeFileSync(outPath.replace(/\.json$/, '.fn.ts'), result.functionText);
} else if (outPath) {
  writeFileSync(outPath, JSON.stringify(output, null, 2));
}
console.log(JSON.stringify({ ...output, functionText: result.functionText ? `<${result.functionText.length} chars>` : null }));
process.exit(result.ok ? 0 : 1);
