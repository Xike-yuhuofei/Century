/** OpenEvolve 静态安全层测试（无沙箱依赖，可在任意平台运行）：
 * 恶意样例必须全部被静态检查拒绝；合法候选必须通过。
 *
 * 注：Seatbelt 沙箱属性验收（读主目录/越界写/联网/超时）在 macOS 专用流程
 * （ai5/openevolve/tests/test_security_sandbox.py，macOS Runner）执行，
 * 本测试只覆盖与平台无关的静态判定层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const staticCheck = join(repoRoot, 'ai5', 'openevolve', 'node', 'static_check.mjs');
const maliciousDir = join(repoRoot, 'ai5', 'openevolve', 'experiments', 'malicious');
const benignFn = join(repoRoot, 'ai5', 'openevolve', 'results', 'evaluations', '66f6a296aa72', 'function.ts');

function staticCheckExit(src, tag) {
  const outDir = mkdtempSync(join(tmpdir(), `ai5-static-${tag}-`));
  const prog = join(outDir, 'prog.ts');
  const out = join(outDir, 'out.json');
  writeFileSync(prog, src);
  let rc = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [staticCheck, '--program', prog, '--out', out], { encoding: 'utf8' });
  } catch (e) {
    rc = e.status ?? 1;
    stdout = e.stdout ?? '';
  }
  return { rc, stdout, outDir };
}

test('全部恶意样例必须被静态检查拒绝（静态禁构造可达性回归）', () => {
  const names = readdirSync(maliciousDir).filter(n => n.startsWith('m') && n.endsWith('.ts'));
  assert.ok(names.length >= 5, `恶意样例缺失：${names}`);
  for (const name of names) {
    if (name === 'm05_infinite_loop.ts') continue; // 死循环无静态特征，属运行时层（Seatbelt 流程验收）
    const { rc, stdout, outDir } = staticCheckExit(readFileSync(join(maliciousDir, name), 'utf8'), name);
    rmSync(outDir, { recursive: true, force: true });
    assert.notEqual(rc, 0, `${name} 必须被静态检查拒绝（stdout=${stdout.slice(0, 200)}）`);
  }
});

test('合法演化候选（66f6a296aa72）必须通过静态检查', () => {
  const src = `/* EVOLVE-BLOCK-START */\n${readFileSync(benignFn, 'utf8').trim()}\n/* EVOLVE-BLOCK-END */\n`;
  const { rc, stdout, outDir } = staticCheckExit(src, 'benign');
  rmSync(outDir, { recursive: true, force: true });
  assert.equal(rc, 0, `合法候选不得被误杀：${stdout.slice(0, 200)}`);
});

test('EVOLVE-BLOCK 标记缺失/不成对必须被拒绝', () => {
  const body = readFileSync(benignFn, 'utf8').trim();
  for (const [src, tag] of [
    [body, 'no-marker'],
    [`/* EVOLVE-BLOCK-START */\n${body}\n`, 'unpaired'],
  ]) {
    const { rc, outDir } = staticCheckExit(src, tag);
    rmSync(outDir, { recursive: true, force: true });
    assert.notEqual(rc, 0, `${tag} 必须被拒绝`);
  }
});

test('隐藏牌库字段访问文本必须被拒绝（信息公平性）', () => {
  const body = readFileSync(benignFn, 'utf8').trim().replace(
    'return 0;',
    'const leak = state.merchantDeck !== undefined ? 1 : 0; return leak * 0 + 0;');
  const src = `/* EVOLVE-BLOCK-START */\n${body}\n/* EVOLVE-BLOCK-END */\n`;
  const { rc, outDir } = staticCheckExit(src, 'deck-access');
  rmSync(outDir, { recursive: true, force: true });
  // 注意：state 形参未声明 merchantDeck，但静态检查禁止任何 .deck 字段访问文本。
  assert.notEqual(rc, 0, '牌库字段访问文本必须被静态拒绝');
});
