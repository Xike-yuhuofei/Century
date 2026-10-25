/** 编译型候选探针：在同一沙箱内调用官方 evaluator 与候选 evaluator。
 *
 * 只读取公开 fixture 输入；不接触隐藏牌库/种子。输出逐 fixture 的
 * baseline/candidate 值与聚合差值，供离线代理评分使用（不冒充对局强度）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const candidatePath = arg('candidate');
const officialPath = arg('official', resolve(REPO_ROOT, 'web-v1/dist/js/ai/evaluator.js'));
const fixturesPath = arg('fixtures');
const outPath = arg('out');
if (!candidatePath || !fixturesPath || !outPath) {
  console.error('用法: node probe_compiled.mjs --candidate <evaluator.js> --fixtures <json> --out <json>');
  process.exit(2);
}

const official = await import(pathToFileURL(officialPath).href);
const candidate = await import(pathToFileURL(resolve(candidatePath)).href);
if (typeof official.acquisitionValue !== 'function' || typeof candidate.acquisitionValue !== 'function') {
  console.error('候选或官方模块缺少 acquisitionValue');
  process.exit(3);
}

const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
if (!Array.isArray(fixtures) || fixtures.length === 0) {
  console.error('fixtures 为空');
  process.exit(2);
}

function call(module, argsList) {
  try {
    const value = module.acquisitionValue(...argsList);
    return { value: Number.isFinite(value) ? value : null, error: Number.isFinite(value) ? null : 'non-finite output' };
  } catch (error) {
    return { value: null, error: String(error?.message ?? error).slice(0, 200) };
  }
}

const rows = [];
let probeErrors = 0;
let mismatchCount = 0;
let pairs = 0;
let sumSigned = 0;
let sumAbs = 0;
let maxAbs = 0;
for (const fixture of fixtures) {
  const baseline = call(official, fixture.args);
  const cand = call(candidate, fixture.args);
  if (baseline.error || cand.error) probeErrors += 1;
  const delta = baseline.value === null || cand.value === null ? null : cand.value - baseline.value;
  if (delta !== null) {
    pairs += 1;
    sumSigned += delta / (Math.abs(baseline.value) + 1);
    sumAbs += Math.abs(delta);
    maxAbs = Math.max(maxAbs, Math.abs(delta));
    if (Math.abs(delta) > 1e-9) mismatchCount += 1;
  }
  rows.push({
    id: fixture.id,
    baseline: baseline.value,
    candidate: cand.value,
    delta,
    baselineError: baseline.error,
    candidateError: cand.error,
  });
}

const result = {
  schema: 'century-ai7-compiled-probe-v1',
  cases: rows.length,
  pairs,
  probeErrors,
  mismatchCount,
  meanSignedDelta: pairs ? Number((sumSigned / pairs).toFixed(6)) : null,
  meanAbsDelta: pairs ? Number((sumAbs / pairs).toFixed(6)) : null,
  maxAbsDelta: Number(maxAbs.toFixed(6)),
  identicalToBaseline: mismatchCount === 0 && probeErrors === 0,
  rows,
};
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  ok: probeErrors === 0 && pairs > 0,
  cases: result.cases,
  mismatchCount,
  probeErrors,
  meanSignedDelta: result.meanSignedDelta,
}));
process.exit(probeErrors === 0 && pairs > 0 ? 0 : 1);
