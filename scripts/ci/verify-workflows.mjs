#!/usr/bin/env node
/** CI 结构不变量校验（无第三方 YAML 依赖，按行做保守检查）。
 * 这些断言是 CI 元测试的一部分：结构被改坏时在 PR 阶段直接失败，而不是等运行期才发现。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPORTED_CHECKS = [
  'ci.yml',
];

function stripComments(text) {
  return text.split('\n').map(line => {
    const idx = line.indexOf('#');
    return (idx >= 0 ? line.slice(0, idx) : line).trimEnd();
  }).join('\n');
}

export function verifyWorkflows(repoRoot) {
  const dir = resolve(repoRoot, '.github/workflows');
  const issues = [];
  const files = readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  const text = Object.fromEntries(files.map(f => [f, readFileSync(resolve(dir, f), 'utf8')]));

  for (const legacy of ['web-v1-ai.yml', 'ai-v2.yml', 'pages.yml', 'card-data-validation.yml', 'ai5.yml']) {
    if (existsSync(resolve(dir, legacy))) issues.push(`重复/废弃工作流仍存在：${legacy}`);
  }

  const prWorkflows = files.filter(f => /^on:\s*$/m.test(text[f]) && /^\s{2}pull_request:/m.test(stripComments(text[f])));
  if (prWorkflows.length !== 1 || prWorkflows[0] !== 'ci.yml') {
    issues.push(`PR 触发工作流必须且只能是 ci.yml，实际：${prWorkflows.join(', ') || '无'}`);
  }
  for (const f of files) {
    if (/pull_request_target/.test(stripComments(text[f]))) issues.push(`${f}: 禁止使用 pull_request_target`);
    if (/npm install\b/.test(stripComments(text[f]))) issues.push(`${f}: 必须使用可复现的 npm ci，而不是 npm install`);
    if (/permissions:\s*write-all/.test(stripComments(text[f]))) issues.push(`${f}: 禁止 write-all 权限`);
  }

  const ci = text['ci.yml'] ?? '';
  if (!ci) issues.push('缺少 ci.yml');
  for (const needle of [
    'ci-summary', 'promotion-gate', 'promotion-approval', 'promotion-approved',
    'web-v1-dist', 'governance-tests', 'rules-cards', 'run-audit-gate.mjs',
    'ai5/openevolve/node/duel_runner.mjs', 'ai5.ppo.tests.python.test_seed_policy',
    'npm ci', 'actions/upload-artifact', 'actions/download-artifact',
  ]) {
    if (!ci.includes(needle)) issues.push(`ci.yml 缺少必需元素：${needle}`);
  }
  if (/continue-on-error/.test(ci)) issues.push('ci.yml 不允许 continue-on-error（失败不得被伪装成成功）');
  if (!/permissions:\s*\n\s{2}contents:\s*read/.test(ci)) issues.push('ci.yml 顶层必须声明最小权限 contents: read');
  if (/^\s{2}paths:/m.test(ci)) issues.push('ci.yml 的 PR 触发不允许 paths 过滤（会导致必需检查缺失）；请用变更分类器');
  if (/persist-credentials:\s*true/.test(ci)) issues.push('ci.yml 不应持久化 checkout 凭据');

  const runsOn = (ci.match(/^\s{4}runs-on:/gm) ?? []).length;
  const timeouts = (ci.match(/^\s{4}timeout-minutes:/gm) ?? []).length;
  if (runsOn === 0) issues.push('ci.yml 未发现任何作业');
  if (timeouts < runsOn) issues.push(`ci.yml 有 ${runsOn} 个作业但仅 ${timeouts} 个 timeout-minutes 声明`);

  const summaryBlock = ci.slice(ci.indexOf('  ci-summary:'));
  if (!/if:\s*always\(\)/.test(summaryBlock)) issues.push('ci-summary 必须使用 if: always()');
  if ((ci.match(/actions\/download-artifact@v4/g) ?? []).length < 5) {
    issues.push('共享构建产物下载次数不足：高成本作业必须复用 web-v1-dist');
  }

  const training = text['ai-training.yml'] ?? '';
  if (!training) issues.push('缺少 ai-training.yml');
  if (/^\s{2}pull_request:/m.test(stripComments(training))) {
    issues.push('ai-training.yml 不得在 PR 上触发（CI 已由 ci.yml 统一编排）');
  }
  if (!/gh workflow run ci\.yml/.test(training)) {
    issues.push('ai-training.yml 的 promote 作业必须在创建候选 PR 后 dispatch ci.yml（GITHUB_TOKEN 创建的 PR 不会自动触发工作流）');
  }
  if (!/permissions:[\s\S]*?actions:\s*write/.test(training)) {
    issues.push('ai-training.yml promote 作业缺少 actions: write（无法 dispatch CI）');
  }

  const writeContents = files.filter(f => /contents:\s*write/.test(stripComments(text[f])));
  if (writeContents.length && !(writeContents.length === 1 && writeContents[0] === 'ai-training.yml')) {
    issues.push(`contents: write 只允许出现在 ai-training.yml promote 作业，实际：${writeContents.join(', ')}`);
  }

  return { ok: issues.length === 0, issues, workflows: files };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const result = verifyWorkflows(root);
  if (result.ok) {
    console.log(`工作流结构校验通过：${result.workflows.join(', ')}`);
  } else {
    console.error(`工作流结构校验失败：\n- ${result.issues.join('\n- ')}`);
    process.exit(1);
  }
}
