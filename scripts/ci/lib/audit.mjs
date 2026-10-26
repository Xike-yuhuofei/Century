/** 审计门禁 CLI 的松耦合适配层（不导入审计实现，只依赖其文档化 CLI/JSON 契约）。
 *
 * 契约（training/redteam/audit-gate.mjs v2）：
 * - 参数：--tier dev|research|promotion --json <path> --md <path>
 * - 退出码：0=该层放行；2=阻断；1=参数/环境错误
 * - JSON: { verdict: 'PASS'|'REQUIRES_APPROVAL'|'BLOCKED', checks: [...] }
 *
 * 若 Agent A 后续升级审计接口，只需保持/适配该 CLI 契约；本适配层不复制审计逻辑。
 */

export function classifyAuditReport(report) {
  const verdict = report?.verdict;
  if (verdict === 'PASS') return { verdict, exitCode: 0, requiresApproval: false };
  if (verdict === 'REQUIRES_APPROVAL') return { verdict, exitCode: 2, requiresApproval: true };
  if (verdict === 'BLOCKED') return { verdict, exitCode: 2, requiresApproval: false };
  return { verdict: verdict ?? 'UNKNOWN', exitCode: 1, requiresApproval: false, error: '审计报告缺少 verdict' };
}

export function renderAuditSummary(report, classification) {
  const summary = report?.summary ?? {};
  const blocking = (report?.checks ?? []).filter(c => !['PASS', 'INFO'].includes(c.status));
  const lines = [
    '## 审计门禁结果',
    '',
    `- 层级：**${report?.tier ?? '?'}**`,
    `- 判定：**${classification.verdict}**`,
    `- 汇总：${summary.checks ?? '?'} 项（PASS ${summary.pass ?? '?'} / FAIL ${summary.fail ?? '?'} / BLOCKED ${summary.blocked ?? '?'} / REQUIRES_APPROVAL ${summary.requiresApproval ?? '?'}）`,
    '',
  ];
  if (blocking.length) {
    lines.push('| 层级 | 状态 | 检查 | 证据 |', '|---|---|---|---|');
    for (const c of blocking) {
      lines.push(`| ${c.tier} | ${c.status} | ${c.id} | ${String(c.evidence ?? '').replaceAll('|', '\\|').slice(0, 240)} |`);
    }
    lines.push('');
  }
  if (classification.verdict === 'REQUIRES_APPROVAL') {
    lines.push('> ⏳ **REQUIRES_APPROVAL 原样保留**：人工审批已移除，必须完成第一名率正式挑战并由'
      + 'promotion-machine-gate 机器复核；本检查不会被改写为 PASS。', '');
  }
  return lines.join('\n');
}
