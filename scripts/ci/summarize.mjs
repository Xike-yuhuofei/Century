#!/usr/bin/env node
/** 汇总所有 CI 作业并生成唯一必需检查（ci-summary）。
 *
 * 关键防静默跳过机制：本作业会独立复算一次变更分类，与 changes 作业输出逐字段对账；
 * 任何不一致、缺失 diff、必需作业 skipped/failure/cancelled 都会使汇总失败。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyChanges, compareScopes } from './lib/scope.mjs';
import { evaluateSummary, renderMarkdown, scopeFromEnv } from './lib/summary.mjs';
import { readChangedFiles } from './change-scope.mjs';

function parseLabels(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 回滚门禁判定（失败关闭）：以 verify-rollback 的产物为准（该产物由 git 事实
 * 独立复算），并交叉检查回滚计划字段；无法建立 revert 计划一律拒绝。 */
function rollbackGate(scope) {
  if (!scope.rollback) return { applied: false };
  const env = process.env;
  const planPath = env.ROLLBACK_PLAN_FILE;
  if (!planPath || !existsSync(planPath)) {
    return { applied: true, ok: false, reason: '回滚计划产物缺失（失败关闭）' };
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (error) {
    return { applied: true, ok: false, reason: `回滚计划产物损坏：${error.message}` };
  }
  if (plan.verdict !== 'ROLLBACK_PR_OPENED') {
    return { applied: true, ok: false, reason: `回滚计划 verdict=${String(plan.verdict)}` };
  }
  if (plan.isChampionPromotion !== true) {
    return {
      applied: true, ok: false,
      reason: `被回滚提交 ${String(plan.target).slice(0, 12)} 不是一次冠军晋级落地（缺少 promotionEvidence）——禁止以“回滚”名义绕过晋进门禁`,
    };
  }
  if (plan.restoresPreviousChampion !== true) {
    return {
      applied: true, ok: false,
      reason: '回滚未恢复到该提交之前的冠军内容——回滚可能被用于非法改写',
    };
  }
  const allowed = ['training/champions/champion.json', 'web-v1/src/ai/parameters.ts'];
  const unexpected = (plan.changedFiles ?? []).filter(path =>
    !path.startsWith('web-v1/dist/') && !allowed.includes(path));
  if (unexpected.length) {
    return {
      applied: true, ok: false,
      reason: `回滚 PR 改动超出冠军恢复范围：${unexpected.join(', ')}`,
    };
  }
  // 独立产物：回滚门禁作业从 git 事实复算同一提交，必须给出 PASS。
  const verificationFile = env.ROLLBACK_VERIFICATION_FILE;
  if (!verificationFile || !existsSync(verificationFile)) {
    return { applied: true, ok: false, reason: '回滚验证产物缺失（失败关闭，不得凭计划自报放行）' };
  }
  let verification;
  try {
    verification = JSON.parse(readFileSync(verificationFile, 'utf8'));
  } catch (error) {
    return { applied: true, ok: false, reason: `回滚验证产物损坏：${error.message}` };
  }
  if (verification.verdict !== 'PASS') {
    const failed = (verification.checks ?? []).filter(c => c.status === 'FAIL').map(c => c.id);
    return { applied: true, ok: false, reason: `回滚独立验证未通过：${failed.join(', ') || 'verdict=' + String(verification.verdict)}` };
  }
  if (verification.target !== plan.target) {
    return { applied: true, ok: false, reason: '回滚验证目标提交与回滚计划不一致' };
  }
  return {
    applied: true, ok: true,
    reason: `回滚验证通过：被回滚提交 ${String(plan.target).slice(0, 12)}，恢复 ${String(plan.previousChampionId ?? '?')}`,
  };
}

function main() {
  const env = process.env;
  const needs = JSON.parse(env.NEEDS_JSON ?? '{}');
  const scope = scopeFromEnv(env);
  const eventName = env.EVENT_NAME ?? '';
  const ref = env.REF ?? '';

  // 独立复算：与 changes 作业使用同一事件输入，但由本作业重新执行 diff 与分类。
  let scopeError = null;
  let promotionVerdict = env.PROMOTION_VERDICT ?? '';
  let promotionRequiresApproval = (env.PROMOTION_REQUIRES_APPROVAL ?? 'false') === 'true';
  if (scope.promotion) {
    const verdictFile = env.PROMOTION_VERDICT_FILE;
    if (!verdictFile || !existsSync(verdictFile)) {
      scopeError = '晋级门禁审计产物缺失（失败关闭，不得凭作业输出放行）';
    } else {
      try {
        const report = JSON.parse(readFileSync(verdictFile, 'utf8'));
        promotionVerdict = report.verdict ?? '';
        promotionRequiresApproval = promotionVerdict === 'REQUIRES_APPROVAL' ||
          Number(report.summary?.requiresApproval ?? 0) > 0;
      } catch (error) {
        scopeError = `晋级门禁审计产物损坏（失败关闭）：${error.message}`;
      }
    }
    if (!promotionVerdict) scopeError = scopeError ?? '晋级门禁 verdict 缺失（失败关闭）';
  }

  // 回滚 PR：必须证明“被回滚的确实是一次冠军晋级落地，且恢复内容等于该提交
  // 之前的冠军”，否则任何人都能以“回滚”名义把任意参数写进 main。
  const rollback = rollbackGate(scope);
  if (rollback.applied && !rollback.ok) {
    scopeError = scopeError ?? `回滚门禁拒绝：${rollback.reason}`;
  }

  try {
    const forceAll = (env.FORCE_SCOPE ?? 'auto') === 'full';
    const forceFull = forceAll || eventName === 'workflow_dispatch';
    const forcePromotion = (env.FORCE_PROMOTION ?? 'false') === 'true';
    const files = forceFull ? [] : readChangedFiles({
      eventName,
      baseSha: env.BASE_SHA ?? '',
      headSha: env.HEAD_SHA ?? '',
    });
    const recomputed = classifyChanges(files, {
      labels: parseLabels(env.PR_LABELS),
      headRef: env.HEAD_REF ?? '',
      forceFull,
      forceAll,
      forcePromotion,
    });
    const comparison = compareScopes(scope, recomputed);
    if (!comparison.ok) {
      scopeError = `变更范围复算不一致：${comparison.mismatches.join('；')}`;
    }
  } catch (error) {
    scopeError = `变更范围复算失败（失败关闭）：${error.message}`;
  }

  const result = evaluateSummary({
    needs,
    scope,
    eventName,
    ref,
    promotionVerdict,
    promotionRequiresApproval,
  });
  if (scopeError) {
    result.ok = false;
    result.failures.push(scopeError);
  }
  if (rollback.applied) {
    result.rollback = { ok: rollback.ok, reason: rollback.reason };
    result.rows.push({
      job: 'rollback-verification',
      result: rollback.ok ? 'success' : 'failure',
      required: true,
      note: rollback.reason,
      ok: rollback.ok,
    });
  }

  const markdown = renderMarkdown(result, scope);
  console.log(markdown);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

  const report = {
    schema: 'century-ci-summary-v1',
    generatedAt: new Date().toISOString(),
    eventName,
    ref,
    scope,
    result,
    scopeError,
  };
  const out = env.CI_SUMMARY_JSON ?? resolve(env.RUNNER_TEMP ?? '/tmp', 'ci-summary.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n汇总报告：${out}`);
  if (!result.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`CI 汇总失败：${error.stack ?? error.message}`);
  process.exit(1);
}
