#!/usr/bin/env node
/** 红队审计 #4：第六阶段审计门禁（P0-2 整改：结构化、分层、可放行可阻断）。
 *
 * 缺陷背景（原 v1）：
 * - 「晋级治理」检查写死 verdict:'BLOCKED'——门禁永远红，放行能力为伪；
 * - 回归测试被重复执行两次（run() + node --test 各一次）；
 * - 无结构化结果、无分层（晋级治理阻断把全部开发单测一并锁死）；
 * - 子脚本执行失败未正确计入判定（exit code 被吞）。
 *
 * v2 设计：
 * - 每项检查返回结构化结果：{id, severity, status, evidence, remediation, checkVersion}；
 *   status ∈ PASS | FAIL | BLOCKED | NOT_RUN | REQUIRES_APPROVAL | INFO；
 * - 分层门禁（--tier）：
 *   · dev        开发门禁：代码合法性、版本身份、信息公平、回归测试——
 *                日常开发/单测的准入线（晋级治理问题不在此层阻断）；
 *   · research   研究门禁：dev + 统计证据核算 + 联赛种子账本完整性——
 *                消耗研究种子块/产生实验结论前必须通过；
 *   · promotion  正式晋级门禁：research + 晋级治理（冻结产物指纹、独立验证
 *                证据覆盖、人工授权）——REQUIRES_APPROVAL 在此层阻断；
 * - 命令失败/缺产物默认阻断（FAIL/BLOCKED），绝不静默放行；
 * - 不允许通过删除审计脚本使门禁变绿（本脚本检查审计工具自身在场）；
 * - 输出：人类可读文本（缺省）+ 机器可读 JSON（--json [path]）+ Markdown（--md path）；
 * - CI 入口：npm run gate（training/package.json）+ ai-training 工作流 audit job。
 *
 * 用法：node training/redteam/audit-gate.mjs [--tier dev|research|promotion] [--json [path]] [--md path]
 * 退出码：0=该层放行；1=参数/环境错误；2=该层阻断。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
const GATE_VERSION = 'v2';

// ---- 参数 ----
const argv = process.argv.slice(2);
const getArg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
};
const TIER = getArg('--tier') ?? 'dev';
if (!['dev', 'research', 'promotion'].includes(TIER)) {
  console.error(`--tier 必须为 dev|research|promotion，实际：${TIER}`);
  process.exit(1);
}
const JSON_OUT = getArg('--json'); // true（stdout）或路径
const MD_OUT = getArg('--md');

/** 结构化检查结果构造器。 */
const checks = [];
const add = ({ id, tier, status, severity, title, evidence, remediation = null, checkVersion = GATE_VERSION }) => {
  checks.push({ id, tier, status, severity, title, evidence, remediation, checkVersion });
};

/** 执行子审计脚本：返回 {code, json|null, raw}；执行失败不是异常而是检查证据。 */
function runAudit(script, args = []) {
  try {
    const raw = execFileSync('node', [resolve(REPO_ROOT, script), ...args], { encoding: 'utf8', timeout: 900_000 });
    return { code: 0, raw };
  } catch (error) {
    return { code: error.status ?? 1, raw: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}
const parseJSONLoose = (raw) => {
  try {
    const start = raw.indexOf('{');
    return JSON.parse(raw.slice(start));
  } catch { return null; }
};

// ---- 通用前置：dist 产物（缺失默认阻断——不评估无产物的代码） ----
const distReady = existsSync(resolve(REPO_ROOT, 'web-v1/dist/js/ai.js'));
if (!distReady) {
  add({
    id: 'build-artifacts', tier: 'dev', status: 'BLOCKED', severity: 'P0',
    title: 'web-v1/dist 未构建（缺少编译产物，门禁拒绝在无产物状态下评估）',
    evidence: 'web-v1/dist/js/ai.js 不存在',
    remediation: 'cd web-v1 && npm run build',
  });
}

// ---- 1. 版本身份（行为学；dev 层） ----
if (distReady) {
  const r = runAudit('training/redteam/audit-versions.mjs', ['--probes=16', '--json']);
  const j = parseJSONLoose(r.raw);
  if (r.code !== 0 || !j) {
    add({
      id: 'version-identity', tier: 'dev', status: 'FAIL', severity: 'P0',
      title: '版本身份审计执行失败（命令失败默认阻断）',
      evidence: `exit=${r.code}；输出末段：${r.raw.slice(-400)}`,
      remediation: '先修复 training/redteam/audit-versions.mjs 的执行错误',
    });
  } else {
    const p0 = j.findings.filter(f => f.severity === 'P0');
    const governance = j.findings.filter(f => f.severity === 'GOVERNANCE');
    add({
      id: 'version-identity', tier: 'dev',
      status: p0.length ? 'FAIL' : 'PASS',
      severity: p0.length ? 'P0' : 'PASS',
      title: p0.length ? `版本身份存在 ${p0.length} 项 P0 污染` : '版本身份干净（js0/js1/对手池 = 冻结归档身份）',
      evidence: p0.length
        ? p0.map(f => `${f.id} ${f.title}`).join('；')
        : `verdict=${j.verdict}；checks=${j.checks.map(c => `${c.id}:${c.status}`).join(' ')}`,
      remediation: p0.length ? '评测运行器必须经 training/lib/version-registry.mjs 冻结描述符分派（禁止内联 CHAMPION_PARAMETERS）' : null,
    });
    for (const g of governance) {
      add({
        id: `governance:${g.id}`, tier: 'promotion', status: 'REQUIRES_APPROVAL', severity: 'GOVERNANCE',
        title: g.title, evidence: g.detail, remediation: g.remediation ?? '等待人工授权（不得自动消费验证池）',
      });
    }
  }
}

// ---- 2. 历史证据核算（research 层） ----
if (distReady || true) { // 核算是纯数据复算，不依赖 dist
  const r = runAudit('training/redteam/audit-evidence-accounting.mjs', ['--json']);
  const j = parseJSONLoose(r.raw);
  if (r.code !== 0 || !j) {
    add({
      id: 'evidence-accounting', tier: 'research', status: 'FAIL', severity: 'P0',
      title: '历史证据核算执行失败（命令失败默认阻断）',
      evidence: `exit=${r.code}；输出末段：${r.raw.slice(-400)}`,
      remediation: '先修复 training/redteam/audit-evidence-accounting.mjs',
    });
  } else {
    const p0 = j.findings.filter(f => f.severity === 'P0');
    add({
      id: 'evidence-accounting', tier: 'research',
      status: p0.length ? 'FAIL' : 'PASS',
      severity: p0.length ? 'P0' : 'PASS',
      title: p0.length ? `证据核算存在 ${p0.length} 项差异` : '历史证据核算一致（confirm 12,800 局；challenge-11 可独立复现）',
      evidence: p0.length ? p0.map(f => `${f.id} ${f.title}`).join('；') : `verdict=${j.verdict}`,
    });
  }
}

// ---- 3. 双人 A/B 独立统计（信息性，不阻断） ----
{
  const r = runAudit('training/redteam/stats-two-player.mjs', ['--json']);
  const j = parseJSONLoose(r.raw);
  add({
    id: 'two-player-stats', tier: 'research', status: j?.crossCheck?.agreePoint ? 'INFO' : 'NOT_RUN',
    severity: 'INFO',
    title: '双人 A/B 独立统计（信息性，不阻断）',
    evidence: j ? `交叉核对一致=${j.crossCheck?.agreePoint}；CI 重叠=${j.crossCheck?.agreeCIOrder}` : `执行失败 exit=${r.code}（信息性检查不阻断，但建议修复）`,
  });
}

// ---- 4. 回归测试（P0-2：只执行一次；快照已迁移为正向不变量） ----
{
  const r = (() => {
    try {
      const raw = execFileSync('node', ['--test', '--test-concurrency=2', resolve(REPO_ROOT, 'training/redteam/tests/redteam.test.mjs')], { encoding: 'utf8', timeout: 900_000 });
      return { code: 0, raw };
    } catch (error) { return { code: error.status ?? 1, raw: (error.stdout ?? '') + (error.stderr ?? '') }; }
  })();
  const pass = Number(/# pass (\d+)/.exec(r.raw)?.[1] ?? 0);
  const fail = Number(/# fail (\d+)/.exec(r.raw)?.[1] ?? 0);
  add({
    id: 'redteam-regression', tier: 'dev',
    status: r.code !== 0 || fail > 0 ? 'FAIL' : 'PASS',
    severity: r.code !== 0 || fail > 0 ? 'P0' : 'PASS',
    title: r.code !== 0 ? '红队回归测试执行失败（命令失败默认阻断）' : fail > 0 ? `红队回归存在 ${fail} 项失败` : '红队正向不变量全部成立',
    evidence: `pass=${pass} fail=${fail} exit=${r.code}（单次执行，无重复调用）`,
    remediation: fail > 0 ? '正向不变量失败 = 行为回归；先修根因，不得删除检测条件' : null,
  });
}

// ---- 5. 联赛种子账本完整性（research 层；P0-4） ----
{
  const ledgerPath = resolve(REPO_ROOT, 'training/adversarial/seed-ledger.json');
  if (!existsSync(ledgerPath)) {
    add({
      id: 'seed-ledger', tier: 'research', status: 'BLOCKED', severity: 'P0',
      title: '联赛种子账本缺失（fail-closed）',
      evidence: `${ledgerPath} 不存在——缺失账本下任何联赛实验分配都必须拒绝`,
      remediation: '从仓库恢复 seed-ledger.json（含历史只读事实导入）',
    });
  } else {
    let verdict = 'PASS'; let evidence = ''; let defects = [];
    try {
      const { loadLedger, verifyLedger } = await import(`file://${resolve(REPO_ROOT, 'training/adversarial/seed-ledger.mjs')}`);
      const ledger = loadLedger(ledgerPath);
      defects = verifyLedger(ledger);
      evidence = `experiments=${ledger.experiments.length}；区间重叠（非 CRN）=${defects.length}；prereg 历史=[1403000000,1403001620)${ledger.experiments.some(e => e.experimentId === 'prereg-15s-official') ? ' 在账' : ' 缺失'}`;
      if (defects.length || !ledger.experiments.some(e => e.experimentId === 'prereg-15s-official')) verdict = 'FAIL';
    } catch (error) {
      verdict = 'FAIL';
      evidence = `账本加载/校验失败：${error.message}`;
    }
    add({
      id: 'seed-ledger', tier: 'research', status: verdict, severity: verdict === 'PASS' ? 'PASS' : 'P0',
      title: verdict === 'PASS' ? '联赛种子账本完整（历史导入在场、无未声明重叠）' : '联赛种子账本存在缺陷（fail-closed）',
      evidence,
      remediation: verdict === 'PASS' ? null : `修复账本结构缺陷：${defects.join('；') || '恢复历史导入'}`,
    });
  }
}

// ---- 6. 晋级治理（promotion 层；区分代码缺陷与治理决定） ----
{
  const champPath = resolve(REPO_ROOT, 'training/champions/champion.json');
  const champ = JSON.parse(readFileSync(champPath, 'utf8'));
  const evidence = champ.provenance?.promotionEvidence ?? {};
  const govNotes = [];
  // G1：证据人数覆盖——正式挑战证据覆盖的人数 vs 部署口径
  const seatCountsCovered = evidence.seatCounts ?? [5]; // challenge-11 按 5 人协议执行
  govNotes.push(`晋级证据覆盖人数=${JSON.stringify(seatCountsCovered)}（正式挑战协议 ${TIER === 'promotion' ? '现已支持 2–5 人独立成次' : ''}）；2p 未有正式证据即全人数部署属治理风险（需按人数补验或人工裁决）`);
  // G2：证据指纹 = 当前重建产物
  const recorded = champ.provenance?.engineBundleSha256;
  let current = null;
  try { current = (await import(`file://${resolve(REPO_ROOT, 'training/lib/paths.mjs')}`)).engineBundleSha256(); } catch { /* 无 dist */ }
  if (recorded && current && recorded !== current) {
    govNotes.push(`晋级证据指纹 ${recorded.slice(0, 12)} ≠ 当前产物 ${current.slice(0, 12)}（受试产物 ≠ 晋级产物——需人工授权的新独立挑战；已在 version-identity V7b 列为 REQUIRES_APPROVAL）`);
  }
  add({
    id: 'promotion-governance', tier: 'promotion', status: 'REQUIRES_APPROVAL', severity: 'GOVERNANCE',
    title: '正式晋级治理未决（阻断晋级层，不阻断开发/研究层）',
    evidence: `冠军=${champ.parameters?.id}；promotionEvidence.seeds=${evidence.seeds}；${govNotes.join('；')}`,
    remediation: '人工授权后执行新一轮正式独立挑战（当前冻结产物 × 需补人数口径）；不得自动消费验证池，不得伪造冠军证明',
  });
}

// ---- 7. 审计工具自身在场（防"删脚本变绿"） ----
for (const tool of ['training/redteam/audit-versions.mjs', 'training/redteam/audit-evidence-accounting.mjs', 'training/redteam/stats-two-player.mjs', 'training/redteam/tests/redteam.test.mjs']) {
  if (!existsSync(resolve(REPO_ROOT, tool))) {
    add({
      id: `tool-presence:${tool}`, tier: 'dev', status: 'BLOCKED', severity: 'P0',
      title: '审计工具缺失（禁止通过删除审计脚本使门禁变绿）',
      evidence: `${tool} 不存在`,
      remediation: '从仓库恢复审计工具',
    });
  }
}

// ---- 汇总与分层判定 ----
const tierRank = { dev: 0, research: 1, promotion: 2 };
const relevant = checks.filter(c => tierRank[c.tier] <= tierRank[TIER]);
const blocking = relevant.filter(c => ['FAIL', 'BLOCKED'].includes(c.status));
const approval = relevant.filter(c => c.status === 'REQUIRES_APPROVAL');
const pass = blocking.length === 0 && (TIER !== 'promotion' || approval.length === 0);

const verdictText = pass ? '放行' : '阻断';
const report = {
  schema: 'century-redteam-audit-gate-v2',
  checkVersion: GATE_VERSION,
  date: new Date().toISOString(),
  tier: TIER,
  verdict: pass ? 'PASS' : approval.length && !blocking.length ? 'REQUIRES_APPROVAL' : 'BLOCKED',
  summary: {
    checks: relevant.length,
    pass: relevant.filter(c => c.status === 'PASS' || c.status === 'INFO').length,
    fail: blocking.filter(c => c.status === 'FAIL').length,
    blocked: blocking.filter(c => c.status === 'BLOCKED').length,
    requiresApproval: approval.length,
  },
  checks,
};
const statusIcon = { PASS: '✓', INFO: 'ℹ', FAIL: '✗', BLOCKED: '⛔', NOT_RUN: '∅', REQUIRES_APPROVAL: '⏳' };

console.log(`\n== 第六阶段审计门禁（${GATE_VERSION}，层级 ${TIER}）==\n`);
for (const c of relevant) {
  console.log(`${statusIcon[c.status] ?? '?'} [${c.tier.padEnd(9)}] ${c.status.padEnd(19)} ${c.id} — ${c.title}`);
}
console.log('');
for (const c of relevant) {
  if (c.status !== 'PASS' && c.status !== 'INFO') {
    console.log(`-- ${c.id} --\n  证据：${c.evidence}${c.remediation ? `\n  处置：${c.remediation}` : ''}\n`);
  }
}
console.log(pass
  ? `门禁判定（${TIER} 层）：放行。${TIER !== 'promotion' && approval.length ? `（${approval.length} 项治理事项待人工授权，仅阻断晋级层）` : ''}`
  : `门禁判定（${TIER} 层）：阻断（FAIL=${report.summary.fail} BLOCKED=${report.summary.blocked}${approval.length ? ` REQUIRES_APPROVAL=${approval.length}（仅晋级层阻断）` : ''}）。`);

if (JSON_OUT) {
  const text = JSON.stringify(report, null, 2);
  if (typeof JSON_OUT === 'string') writeFileSync(resolve(JSON_OUT), text);
  else console.log(text);
}
if (MD_OUT) {
  const lines = [
    `# 第六阶段审计门禁报告（${GATE_VERSION}）`,
    '',
    `- 时间：${report.date}`,
    `- 层级：${TIER}`,
    `- 判定：**${report.verdict}**`,
    `- 汇总：${report.summary.checks} 项检查（PASS ${report.summary.pass} / FAIL ${report.summary.fail} / BLOCKED ${report.summary.blocked} / REQUIRES_APPROVAL ${report.summary.requiresApproval}）`,
    '',
    '| 层级 | 状态 | 检查 | 结论 | 证据 |',
    '|---|---|---|---|---|',
    ...relevant.map(c => `| ${c.tier} | ${c.status} | ${c.id} | ${c.title} | ${String(c.evidence).replace(/\|/g, '\\|').slice(0, 200)} |`),
    '',
  ];
  writeFileSync(resolve(typeof MD_OUT === 'string' ? MD_OUT : 'audit-gate-report.md'), lines.join('\n'));
}
process.exit(pass ? 0 : 2);
