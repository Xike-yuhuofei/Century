#!/usr/bin/env node
/** 校验共享构建产物完整性。构建作业在生成 dist 后立即运行；损坏产物会让测试提前失败，
 * 而不是把"缺文件/空文件"伪装成测试通过或测试失败。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = [
  'js/engine.js',
  'js/ai.js',
  'js/data.js',
  'js/js/adapter.js',
  'js/sim/index.js',
  'ai-runtime/harness.html',
  'index.html',
  'standalone.html',
];
const STANDALONE_MIN_BYTES = 100_000;

export function verifyDist(distDir) {
  const issues = [];
  for (const rel of REQUIRED) {
    const file = resolve(distDir, rel);
    if (!existsSync(file)) {
      issues.push(`缺少产物：${rel}`);
      continue;
    }
    const size = statSync(file).size;
    if (size === 0) issues.push(`空产物：${rel}`);
  }
  const standalone = resolve(distDir, 'standalone.html');
  if (existsSync(standalone)) {
    const html = readFileSync(standalone, 'utf8');
    if (statSync(standalone).size < STANDALONE_MIN_BYTES) {
      issues.push(`standalone.html 体积异常（${statSync(standalone).size} < ${STANDALONE_MIN_BYTES}）`);
    }
    if (!html.includes('function choosePlan(')) {
      issues.push('standalone.html 缺少规划器入口（function choosePlan(）');
    }
  }
  return { ok: issues.length === 0, issues };
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') { values.dist = argv[i + 1]; i++; }
  }
  return values;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const distDir = resolve(process.cwd(), args.dist ?? 'web-v1/dist');
  const result = verifyDist(distDir);
  if (result.ok) {
    console.log(`构建产物完整：${distDir}`);
  } else {
    console.error(`构建产物校验失败：\n- ${result.issues.join('\n- ')}`);
    process.exit(1);
  }
}
