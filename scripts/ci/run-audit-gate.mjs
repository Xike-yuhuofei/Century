#!/usr/bin/env node
/** 执行审计门禁并把结构化 verdict 暴露给后续作业。
 *
 * 用法：
 *   node scripts/ci/run-audit-gate.mjs --tier promotion \
 *     --json training/reports/audit-gate-promotion.json \
 *     --md training/reports/audit-gate-promotion.md
 *
 * 退出码：PASS=0；REQUIRES_APPROVAL/BLOCKED=2；契约/执行错误=1。
 * REQUIRES_APPROVAL 不转换为成功——作业保持红色；人工审批已移除，必须完成
 * 第一名率正式挑战后由 promotion-machine-gate 机器复核。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAuditReport, renderAuditSummary } from './lib/audit.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`无法识别的参数：${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function writeOutputs(outputs, path = process.env.GITHUB_OUTPUT) {
  const text = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n');
  if (path) appendFileSync(path, `${text}\n`);
  else console.log(text);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tier = args.tier ?? 'dev';
  if (!['dev', 'research', 'promotion'].includes(tier)) throw new Error(`--tier 非法：${tier}`);
  const jsonPath = resolve(process.cwd(), args.json ?? 'audit-gate.json');
  const mdPath = args.md ? resolve(process.cwd(), args.md) : null;
  const gateScript = resolve(REPO_ROOT, args['gate-script'] ?? 'training/redteam/audit-gate.mjs');

  const gateArgs = [gateScript, '--tier', tier, '--json', jsonPath];
  if (mdPath) gateArgs.push('--md', mdPath);
  let gateStatus = 0;
  try {
    execFileSync(process.execPath, gateArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch (error) {
    gateStatus = error.status ?? 1;
  }

  if (!existsSync(jsonPath)) {
    console.error(`审计门禁未产出 JSON（gate exit=${gateStatus}）：${jsonPath}`);
    process.exit(1);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    console.error(`审计 JSON 解析失败：${error.message}`);
    process.exit(1);
  }

  const classification = classifyAuditReport(report);
  if (classification.error) {
    console.error(classification.error);
    process.exit(1);
  }
  // 契约一致性：审计 CLI 的退出码与 JSON verdict 必须同向，否则失败关闭。
  const expectedExit = classification.exitCode;
  if ((gateStatus === 0) !== (expectedExit === 0)) {
    console.error(`审计契约不一致：gate exit=${gateStatus}, verdict=${classification.verdict}`);
    process.exit(1);
  }

  writeOutputs({
    verdict: classification.verdict,
    requires_approval: String(classification.requiresApproval),
    audit_exit_code: String(gateStatus),
  });

  const summary = renderAuditSummary(report, classification);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  const recordPath = process.env.CI_AUDIT_RECORD;
  if (recordPath) {
    writeFileSync(recordPath, JSON.stringify({ tier, gateStatus, classification, report }, null, 2));
  }

  process.exit(expectedExit);
}

try {
  main();
} catch (error) {
  console.error(`审计适配层失败：${error.stack ?? error.message}`);
  process.exit(1);
}
