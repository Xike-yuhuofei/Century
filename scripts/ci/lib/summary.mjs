/** CI 汇总门禁判定（纯函数，可单元测试）。
 *
 * 规则：
 * - changes / governance-tests / rules-cards 永远必须成功；
 * - 变更范围声明为 true 的分组，其对应作业必须真实成功（skipped 视为静默跳过 → 失败）；
 * - 任何作业 failure/cancelled 都会失败（避免红色作业被汇总掩盖），唯一例外是
 *   promotion-gate 在 verdict=REQUIRES_APPROVAL 时——它必须由独立的人工批准作业放行；
 * - promotion-gate 的 REQUIRES_APPROVAL 绝不被改写成 PASS：汇总会显式保留该状态，
 *   并要求 promotion-approval 作业成功才允许整体通过。
 */

const ALWAYS_REQUIRED = ['changes', 'governance-tests', 'rules-cards'];

/** @param {Record<string, any>} scope 变更范围（布尔字段） */
export function requiredJobs(scope, { eventName = '', ref = '', promotionVerdict = '', promotionRequiresApproval = false } = {}) {
  const required = new Set(ALWAYS_REQUIRED);
  if (scope.build) required.add('build');
  if (scope.web) required.add('web-unit');
  if (scope.training) required.add('training-unit');
  if (scope.simulation) required.add('simulation');
  if (scope.ui) required.add('ui-smoke');
  if (scope.research) {
    required.add('research-node');
    required.add('research-worker');
    required.add('research-e2e');
    required.add('research-python');
    required.add('research-seatbelt');
  }
  if (scope.audit && !scope.promotion) required.add('audit-gate');
  if (scope.promotion) {
    required.add('promotion-gate');
    if (promotionVerdict === 'REQUIRES_APPROVAL' || promotionRequiresApproval) {
      required.add('promotion-approval');
    }
  }
  const isMainPush = eventName === 'push' && ref === 'refs/heads/main';
  const isMainDispatch = eventName === 'workflow_dispatch' && ref === 'refs/heads/main';
  if (scope.pages && (isMainPush || isMainDispatch)) required.add('pages-deploy');
  return required;
}

export function evaluateSummary({ needs = {}, scope = {}, eventName = '', ref = '', promotionVerdict = '', promotionRequiresApproval = false }) {
  const verdict = promotionVerdict || needs['promotion-gate']?.outputs?.verdict || '';
  const requiresApproval = String(promotionRequiresApproval || needs['promotion-gate']?.outputs?.requires_approval || 'false') === 'true';
  const required = requiredJobs(scope, { eventName, ref, promotionVerdict: verdict, promotionRequiresApproval: requiresApproval });
  const failures = [];
  const notes = [];
  const rows = [];

  const pendingPromotion = scope.promotion && verdict === 'REQUIRES_APPROVAL';
  const approvalResult = needs['promotion-approval']?.result ?? 'skipped';

  for (const [job, data] of Object.entries(needs)) {
    const result = data?.result ?? 'missing';
    const isRequired = required.has(job);
    let note = '';
    let effectiveFailure = false;

    if (result === 'failure' || result === 'cancelled' || result === 'missing') {
      if (job === 'promotion-gate' && pendingPromotion) {
        note = '⏳ REQUIRES_APPROVAL（治理阻断，等待人工批准；不是代码失败）';
        notes.push(note);
      } else {
        effectiveFailure = true;
        failures.push(`${job}: ${result}`);
        note = result === 'cancelled' ? '任务超时或被取消（不得视为通过）' : '作业失败';
      }
    } else if (result === 'skipped') {
      if (isRequired) {
        effectiveFailure = true;
        failures.push(`${job}: skipped（关键检查被静默跳过）`);
        note = '关键检查被静默跳过';
      } else {
        note = '未触发（变更范围不适用）';
      }
    } else if (isRequired && result !== 'success') {
      effectiveFailure = true;
      failures.push(`${job}: ${result}`);
      note = '关键检查未成功';
    }

    if (job === 'promotion-gate' && scope.promotion) {
      if (verdict === 'PASS' && result !== 'success') {
        effectiveFailure = true;
        failures.push(`promotion-gate: verdict=PASS 但作业结果=${result}`);
        note = '晋级证据判定与作业状态不一致（失败关闭）';
      } else if (verdict === 'REQUIRES_APPROVAL') {
        if (result === 'success') {
          effectiveFailure = true;
          failures.push('promotion-gate: REQUIRES_APPROVAL 不得被转换为成功');
          note = 'REQUIRES_APPROVAL 被错误转换为成功';
        } else if (approvalResult !== 'success') {
          effectiveFailure = true;
          failures.push(`promotion-approval: ${approvalResult}（人工批准未完成）`);
          note = '⏳ REQUIRES_APPROVAL：人工批准未完成';
        } else {
          note = '⏳ REQUIRES_APPROVAL 已由独立人工批准作业放行（审计证据未改写为 PASS）';
        }
      } else if (!verdict) {
        effectiveFailure = true;
        failures.push('promotion-gate: 缺少结构化 verdict');
        note = '晋级门禁未产出 verdict（失败关闭）';
      }
    }

    if (job === 'promotion-approval' && !required.has('promotion-approval') && result === 'success') {
      effectiveFailure = true;
      failures.push('promotion-approval: 在没有 REQUIRES_APPROVAL 的情况下执行成功');
      note = '异常批准路径（失败关闭）';
    }

    if (job === 'promotion-approval' && required.has('promotion-approval') && result !== 'success') {
      note = note || `人工批准未完成（${result}）`;
    }

    rows.push({ job, result, required: isRequired, note, ok: !effectiveFailure });
  }

  // 必需的作业如果根本不在 needs 中（工作流结构错误），同样失败。
  for (const job of required) {
    if (!(job in needs)) {
      failures.push(`${job}: 未出现在 needs 中`);
      rows.push({ job, result: 'missing', required: true, note: '工作流缺少该作业', ok: false });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    notes,
    rows,
    required: [...required],
    promotion: { verdict, requiresApproval, approvalResult },
  };
}

export function renderMarkdown(result, scope) {
  const enabled = ['build', 'web', 'training', 'research', 'ui', 'simulation', 'audit', 'promotion', 'pages']
    .filter(k => scope[k]);
  const lines = [
    '## CI 门禁汇总',
    '',
    `- 变更文件：${scope.changedCount ?? '?'} 个${scope.docsOnly ? '（纯文档）' : ''}`,
    `- 检查范围：${enabled.join(', ') || '仅规则与 CI 元测试'}`,
    ...(scope.reasons ? [`- 触发原因：${scope.reasons}`] : []),
    '',
    '| 作业 | 结果 | 必须通过 | 说明 |',
    '|---|---|---|---|',
    ...result.rows.map(r => `| ${r.job} | ${r.result} | ${r.required ? '是' : '否'} | ${r.note || ''} |`),
    '',
  ];
  if (result.failures.length) {
    lines.push('### 失败原因', '', ...result.failures.map(f => `- ${f}`), '');
  } else {
    lines.push('所有必需的检查均已真实执行并通过；未发生关键检查静默跳过。', '');
  }
  if (result.promotion.verdict) {
    lines.push(`> 晋级判定：**${result.promotion.verdict}**`
      + (result.promotion.requiresApproval ? '（REQUIRES_APPROVAL 保留原样，由 promotion-approval 人工批准作业独立放行）' : ''), '');
  }
  return lines.join('\n');
}

export function scopeFromEnv(env) {
  const b = key => String(env[key] ?? 'false') === 'true';
  return {
    build: b('SCOPE_BUILD'),
    web: b('SCOPE_WEB'),
    training: b('SCOPE_TRAINING'),
    ai5: b('SCOPE_AI5'),
    ui: b('SCOPE_UI'),
    simulation: b('SCOPE_SIMULATION'),
    audit: b('SCOPE_AUDIT'),
    research: b('SCOPE_RESEARCH'),
    promotion: b('SCOPE_PROMOTION'),
    pages: b('SCOPE_PAGES'),
    rules: b('SCOPE_RULES'),
    governance: b('SCOPE_GOVERNANCE'),
    docsOnly: b('SCOPE_DOCS_ONLY'),
    auditTier: env.SCOPE_AUDIT_TIER ?? 'dev',
    changedCount: Number(env.SCOPE_CHANGED_COUNT ?? 0),
    reasons: env.SCOPE_REASONS ?? '',
  };
}
