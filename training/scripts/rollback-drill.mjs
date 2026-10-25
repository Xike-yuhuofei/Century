#!/usr/bin/env node
/** P4：自动回滚演练（损坏部署检测 + 回滚计划生成）。
 *
 * 本演练真实执行：
 * 1. 仅提供正确产物/冠军身份 → verify-deploy PASS；
 * 2. 提供错误产物指纹 → verify-deploy FAIL；
 * 3. 产物正确但冠军 id 缺失 → verify-deploy FAIL；
 * 4. rollback-champion.mjs --dry-run → 生成可审计的 revert 计划。
 *
 * 注意：演练不创建真实 revert PR、不合并、不改变正式冠军；它证明检测与计划
 * 链路有效。真实回滚（revert PR + auto-merge + Pages 恢复）仍需在冠军晋级后
 * 由同一脚本执行。
 */

import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const here = REPO_ROOT;
const VERIFY = resolve(here, 'scripts/ci/verify-deploy.mjs');
const ROLLBACK = resolve(here, 'scripts/ci/rollback-champion.mjs');
const artifact = 'a'.repeat(64);
const wrongArtifact = 'b'.repeat(64);
const champion = 'joint-js5';

function startServer({ manifestArtifact, includeChampion, includeAdapter }) {
  const dir = mkdtempSync(join(tmpdir(), 'century-drill-'));
  const index = [
    '<!doctype html><html><body>',
    includeChampion ? `<script>const CHAMPION={id:"${champion}"};</script>` : '<script>const CHAMPION={id:"unknown"};</script>',
    includeAdapter ? '<script>const ADAPTER="champion-guided";</script>' : '',
    `<script>/* ${'x'.repeat(12_000)} */</script>`,
    '<div id="app">Century</div>',
    '</body></html>',
  ].join('\n');
  writeFileSync(join(dir, 'index.html'), index);
  writeFileSync(join(dir, 'build-manifest.json'), JSON.stringify({
    schema: 'century-build-manifest-v1',
    artifact: { sha256: manifestArtifact },
  }));
  const server = createServer((req, res) => {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const body = readFileSync(join(dir, path.replace(/^\//, '')), 'utf8');
      res.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise(resolveServer => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, dir, port: server.address().port });
    });
  });
}

function runVerify(url, expectedArtifact) {
  // 必须异步执行：同步 exec 会阻塞当前事件循环，本地 HTTP 服务器无法响应。
  return new Promise(resolveVerify => {
    execFile(process.execPath, [
      VERIFY, '--url', url, '--expected-artifact', expectedArtifact, '--expected-champion', champion,
    ], { encoding: 'utf8', cwd: here }, (error, stdout, stderr) => {
      resolveVerify(error
        ? { ok: false, stdout: stdout ?? '', stderr: stderr ?? error.message }
        : { ok: true, stdout });
    });
  });
}

const checks = [];
async function withServer(options, fn) {
  const { server, dir, port } = await startServer(options);
  try {
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const good = await withServer({ manifestArtifact: artifact, includeChampion: true, includeAdapter: true },
    url => runVerify(url, artifact));
  checks.push({ id: 'valid-deploy-passes', status: good.ok ? 'PASS' : 'FAIL', evidence: good.ok ? 'verify-deploy 放行' : good.stdout.slice(-300) });

  const badArtifact = await withServer({ manifestArtifact: wrongArtifact, includeChampion: true, includeAdapter: true },
    url => runVerify(url, artifact));
  checks.push({
    id: 'corrupt-artifact-detected', status: badArtifact.ok ? 'FAIL' : 'PASS',
    evidence: badArtifact.ok ? 'verify-deploy 未检测到错误产物' : '错误产物指纹被拒绝',
  });

  const missingChampion = await withServer({ manifestArtifact: artifact, includeChampion: false, includeAdapter: true },
    url => runVerify(url, artifact));
  checks.push({
    id: 'missing-champion-detected', status: missingChampion.ok ? 'FAIL' : 'PASS',
    evidence: missingChampion.ok ? 'verify-deploy 未检测到冠军 id 缺失' : '冠军 id 缺失被拒绝',
  });

  let rollbackPlan = null;
  try {
    const stdout = execFileSync(process.execPath, [ROLLBACK, '--dry-run'], { encoding: 'utf8', cwd: here });
    rollbackPlan = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch (error) {
    rollbackPlan = { error: String(error.stderr ?? error.message).slice(0, 300) };
  }
  const planValid = Boolean(rollbackPlan && /^[0-9a-f]{40}$/.test(rollbackPlan.target) && rollbackPlan.branch);
  checks.push({
    id: 'rollback-plan-valid', status: planValid ? 'PASS' : 'FAIL',
    evidence: planValid ? `target=${rollbackPlan.target.slice(0, 12)} branch=${rollbackPlan.branch}` : JSON.stringify(rollbackPlan).slice(0, 300),
  });

  const failed = checks.filter(c => c.status === 'FAIL');
  const report = {
    schema: 'century-rollback-drill-v1',
    generatedAt: new Date().toISOString(),
    verdict: failed.length ? 'FAIL' : 'PASS',
    checks,
    note: '演练只验证损坏部署检测与 revert 计划；未创建真实 revert PR、未改变正式冠军',
  };
  writeJSON(resolve(REPO_ROOT, 'training/reports/rollback-drill.json'), report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => {
  console.error(`回滚演练失败：${error.stack ?? error.message}`);
  process.exit(1);
});
