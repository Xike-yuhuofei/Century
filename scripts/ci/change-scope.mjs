#!/usr/bin/env node
/** 计算 CI 变更范围并写入 GITHUB_OUTPUT。
 *
 * 环境变量：
 *   EVENT_NAME        pull_request | push | workflow_dispatch
 *   BASE_SHA          比较基线（push 的 before / PR 的 base.sha）
 *   HEAD_SHA          目标提交（PR 的 head.sha / push 的 sha）
 *   PR_LABELS         JSON 数组（PR 标签名）
 *   FORCE_SCOPE       auto | full（workflow_dispatch）
 *   FORCE_PROMOTION   true | false（workflow_dispatch）
 *   CI_SCOPE_JSON     可选，完整范围 JSON 输出路径
 *
 * 失败关闭：无法取得可信 diff 时按全量代码检查处理。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChanges, scopeToOutputs } from './lib/scope.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHA_RE = /^[0-9a-f]{40}$/i;

function parseLabels(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function readChangedFiles({ eventName, baseSha, headSha, cwd = REPO_ROOT }) {
  if (!SHA_RE.test(baseSha ?? '') || !SHA_RE.test(headSha ?? '')) {
    throw new Error(`diff 提交不合法：base=${baseSha} head=${headSha}`);
  }
  if (/^0+$/.test(baseSha)) {
    throw new Error('base SHA 为全零（新分支/强推），无法可靠比较');
  }
  const range = eventName === 'pull_request' ? `${baseSha}...${headSha}` : `${baseSha}..${headSha}`;
  const raw = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRD', range], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

function writeOutputs(outputs, path = process.env.GITHUB_OUTPUT) {
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${String(v).replaceAll('\n', ' ')}`);
  if (path) appendFileSync(path, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}

function main() {
  const eventName = process.env.EVENT_NAME ?? 'workflow_dispatch';
  const forceAll = (process.env.FORCE_SCOPE ?? 'auto') === 'full';
  const forcePromotion = (process.env.FORCE_PROMOTION ?? 'false') === 'true';
  const labels = parseLabels(process.env.PR_LABELS);
  const baseSha = process.env.BASE_SHA ?? '';
  const headSha = process.env.HEAD_SHA ?? '';

  let files = [];
  let forceFull = forceAll || eventName === 'workflow_dispatch';
  let diffError = null;

  if (!forceFull) {
    try {
      files = readChangedFiles({ eventName, baseSha, headSha });
    } catch (error) {
      forceFull = true;
      diffError = error.message;
    }
  }

  const scope = classifyChanges(files, { labels, forceFull, forceAll, forcePromotion });
  if (diffError) scope.reasons.push(`diff-unavailable:${diffError.slice(0, 120)}`);

  const outputs = scopeToOutputs(scope);
  writeOutputs(outputs);

  const jsonPath = process.env.CI_SCOPE_JSON ?? resolve(process.env.RUNNER_TEMP ?? '/tmp', 'ci-scope.json');
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(scope, null, 2));

  const enabled = Object.entries(scope)
    .filter(([k, v]) => typeof v === 'boolean' && v && !['rules', 'governance', 'docsOnly'].includes(k))
    .map(([k]) => k);
  console.log(`变更文件 ${scope.changedCount} 个；检查范围：${enabled.join(', ') || '仅规则与元测试'}`);
  if (scope.reasons.length) console.log(`触发原因：${scope.reasons.join(', ')}`);
  if (scope.docsOnly) console.log('本次为纯文档变更：跳过 web/training 高成本测试，规则与 CI 元测试仍执行。');
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`变更范围计算失败：${error.message}`);
    process.exit(1);
  }
}
