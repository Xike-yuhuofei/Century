#!/usr/bin/env node
/** P4：线上部署身份核验（发布后自动门禁）。
 *
 * 校验项：
 * - 站点可访问（HTTP 200）；
 * - 部署的 build-manifest.json artifact.sha256 与本次构建产物一致；
 * - index.html 包含当前冠军参数 id（证明浏览器实际加载的冠军身份）；
 * - index.html 包含冠军适配器标记（champion-guided），防止"部署旧包"。
 *
 * 用法：
 *   node scripts/ci/verify-deploy.mjs \
 *     --url https://xike-yuhuofei.github.io/Century/ \
 *     --expected-artifact <sha256> --expected-champion joint-js5 \
 *     [--json output.json]
 *
 * 退出码：0=PASS；1=失败（触发回滚）。
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`无法识别的参数：${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.url ?? 'https://xike-yuhuofei.github.io/Century/').replace(/\/?$/, '/');
const expectedArtifact = args['expected-artifact'] ? String(args['expected-artifact']) : null;
const expectedChampion = args['expected-champion'] ? String(args['expected-champion']) : null;

const checks = [];
function check(id, pass, evidence) {
  checks.push({ id, status: pass ? 'PASS' : 'FAIL', evidence });
  return pass;
}

async function fetchText(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const site = await fetchText(baseUrl).catch(error => ({ error }));
  check('site-reachable', !site.error && site.status === 200,
    site.error ? `页面获取失败：${site.error.message}` : `status=${site.status}`);
  const index = site.text ?? '';
  check('index-non-empty', index.length > 10_000, `index.html 长度=${index.length}`);

  if (expectedChampion) {
    // standalone.html 内联了冠军参数块；字符串必须出现。
    check('champion-id-present', index.includes(expectedChampion),
      `index.html ${index.includes(expectedChampion) ? '包含' : '缺少'} 冠军 id ${expectedChampion}`);
    check('champion-adapter-present', index.includes('champion-guided'),
      `index.html ${index.includes('champion-guided') ? '包含' : '缺少'} 适配器标记 champion-guided`);
  }

  let manifest = null;
  const manifestResponse = await fetchText(`${baseUrl}build-manifest.json`).catch(error => ({ error }));
  if (!manifestResponse.error && manifestResponse.status === 200) {
    try { manifest = JSON.parse(manifestResponse.text); } catch { manifest = null; }
  }
  check('build-manifest-available', Boolean(manifest),
    manifest ? 'build-manifest.json 可解析' : `build-manifest.json 不可用（${manifestResponse.error?.message ?? manifestResponse.status}）`);
  if (manifest) {
    check('artifact-identity', !expectedArtifact || manifest.artifact?.sha256 === expectedArtifact,
      `部署 artifact=${String(manifest.artifact?.sha256).slice(0, 16)} 期望=${String(expectedArtifact).slice(0, 16)}`);
    check('manifest-schema', typeof manifest.schema === 'string' && manifest.schema.length > 0,
      `schema=${manifest.schema}`);
  }

  const failed = checks.filter(c => c.status === 'FAIL');
  const report = {
    schema: 'century-deploy-verification-v1',
    verifiedAt: new Date().toISOString(),
    url: baseUrl,
    expectedArtifact,
    expectedChampion,
    verdict: failed.length ? 'FAIL' : 'PASS',
    checks,
  };
  if (args.json) writeFileSync(resolve(process.cwd(), args.json), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => {
  console.error(`部署核验执行失败：${error.stack ?? error.message}`);
  process.exit(1);
});
