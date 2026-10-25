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
