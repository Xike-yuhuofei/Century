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
    'ci-summary', 'promotion-gate', 'promotion-machine-gate',
    'verify-deploy.mjs', 'rollback-on-deploy-failure',
    'web-v1-dist', 'governance-tests', 'rules-cards', 'run-audit-gate.mjs',
    'research-worker', 'research-e2e', 'worker-protocol.test.mjs',
    '--test-name-pattern', '全 node 席位完整对局并按种子复现', 'MLP 席位往返', '回传越界序号被如实记为异常对局',
    'ai5/openevolve/node/duel_runner.mjs', 'ai5.ppo.tests.python.test_seed_policy',
    'npm ci', 'actions/upload-artifact', 'actions/download-artifact',
    // AI9 协同进化能力必须由 CI 真实执行，不能只留在本地研发脚本里。
    'ai9-research', 'ai9-module-wiring-audit.mjs', 'ai9-module-execution-audit.mjs',
    // 分片计划是 PR 墙钟的关键；缺了它就退回单作业 20 分钟串行。
    'plan-test-shards.mjs',
    // web 长测试（4×16 局完整对局）必须由专用并行作业执行，否则单作业 12 分钟。
    'web-long-tests', 'CENTURY_AI_TEST_BOTS', '--exclude ai.test.mjs',
    // 回滚必须走独立门禁（证明被回滚的确实是一次晋级，且逐字节恢复）。
    'rollback-gate', 'verify-rollback.mjs',
    // 回滚门禁的隔离演练必须在 CI 中真实执行（放行/拒绝/循环三类分支）。
    'rollback-gate-drill.mjs',
  ]) {
    if (!ci.includes(needle)) issues.push(`ci.yml 缺少必需元素：${needle}`);
  }
  if (ci.includes('promotion-approved')) issues.push('ci.yml 不得再依赖 promotion-approved 人工标签（人工审批已被机器门禁取代）');
  if (ci.includes('name: promotion-approval')) issues.push('ci.yml 不得保留 promotion-approval 人工批准作业');
  if (/continue-on-error/.test(ci)) issues.push('ci.yml 不允许 continue-on-error（失败不得被伪装成成功）');
  if (!/permissions:\s*\n\s{2}contents:\s*read/.test(ci)) issues.push('ci.yml 顶层必须声明最小权限 contents: read');
  if (/^\s{2}paths:/m.test(ci)) issues.push('ci.yml 的 PR 触发不允许 paths 过滤（会导致必需检查缺失）；请用变更分类器');
  if (/persist-credentials:\s*true/.test(ci)) issues.push('ci.yml 不应持久化 checkout 凭据');
  if (!/include-hidden-files:\s*true/.test(ci)) {
    issues.push('web-v1-dist 上传必须包含隐藏文件（.nojekyll 在 AI7 dist 部署闭包内，缺失会导致 fail-closed）');
  }
  // 晋级机器门禁必须在 PR 与 dispatch 两种到达方式下都能真实运行：PR 由
  // GITHUB_TOKEN 创建时不会触发 pull_request，只能靠显式 dispatch。
  const machineGateBlock = ci.slice(ci.indexOf('  promotion-machine-gate:'), ci.indexOf('  pages-deploy:'));
  if (!/github\.event_name == 'workflow_dispatch'/.test(machineGateBlock)) {
    issues.push('promotion-machine-gate 必须支持 workflow_dispatch（GITHUB_TOKEN 创建的 PR 不会触发 pull_request，否则出现触发断层）');
  }
  if (!/--post-apply/.test(machineGateBlock)) {
    issues.push('promotion-machine-gate 必须使用 --post-apply（PR 内 champion.json 已是候选本身，否则门禁永远失败）');
  }
  if (!/--base-champion-ref origin\/main/.test(machineGateBlock)) {
    issues.push('promotion-machine-gate 必须传 --base-champion-ref origin/main（post-apply 需要可信基线）');
  }
  if (!/ai9-research/.test(machineGateBlock)) {
    issues.push('promotion-machine-gate 的前置机器检查必须包含 ai9-research（AI9 证据不得被跳过）');
  }

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
  const promotionPublisher = /publish-promotion-pr\.mjs/.test(training) && /CENTURY_PR_TRIGGER/.test(training);
  if (!promotionPublisher && !/gh workflow run ci\.yml/.test(training)) {
    issues.push('ai-training.yml 的 promote 作业必须在创建候选 PR 后 dispatch ci.yml（GITHUB_TOKEN 创建的 PR 不会自动触发工作流；可经 publish-promotion-pr.mjs + CENTURY_PR_TRIGGER）');
  }
  if (!/permissions:[\s\S]*?actions:\s*write/.test(training)) {
    issues.push('ai-training.yml promote 作业缺少 actions: write（无法 dispatch CI）');
  }
  // 训练有效性：工作流成功 ≠ 训练有产物。必须有独立校验步骤与显式无候选披露。
  if (!/automation-report\.mjs/.test(training)) {
    issues.push('ai-training.yml 必须用 automation-report.mjs 校验训练产物（防止“成功但没有产物/候选”的静默失败）');
  }
  if (!/automation-state\.mjs pull/.test(training) || !/automation-state\.mjs push/.test(training)) {
    issues.push('ai-training.yml 必须持久化自动化状态（automation-state pull/push，防止断点与种子账本随 artifact 过期丢失）');
  }
  if (/if-no-files-found:\s*ignore/.test(training.slice(training.indexOf('name: evolve-state-latest') - 200, training.indexOf('name: evolve-state-latest') + 300))) {
    issues.push('训练状态 artifact 不得使用 if-no-files-found: ignore（断点/账本静默丢失会让下一次运行重置种子游标）');
  }
  // MLP+PPO 训练入口必须由工作流真实执行并校验产物，不能只留在文档里。
  if (!/ai5\.ppo\.training\.train_cli/.test(training)) {
    issues.push('ai-training.yml 必须包含 MLP+PPO 真实训练入口（ai5.ppo.training.train_cli），而不是只保留单元测试');
  }
  if (!/ppo-smoke/.test(training)) {
    issues.push('ai-training.yml 必须包含 ppo-smoke 作业（训练成功但无 checkpoint/summary 即失败）');
  }
  // AI9 协同进化必须由工作流真实执行（真实 2–5 人对局）。
  if (!/autonomous-run\.mjs start[\s\S]*?--coevolve/.test(training)) {
    issues.push('ai-training.yml 必须包含 AI9 协同进化作业（autonomous-run.mjs start --coevolve）');
  }

  const continuation = text['champion-continuation.yml'] ?? '';
  if (!continuation) {
    issues.push('缺少 champion-continuation.yml（冠军晋级后必须自动触发下一代进化）');
  } else {
    if (!/champion\.json/.test(continuation)) issues.push('champion-continuation 必须由 champion.json 变更触发');
    if (!/gh workflow run ai-training\.yml/.test(continuation)) issues.push('champion-continuation 必须 dispatch ai-training.yml');
    // 回滚提交也会改动 champion.json：必须显式跳过，否则部署持续失败时会不断
    // 以旧冠军为基线重启训练（回滚循环）。
    if (!/自动回滚|revert/i.test(continuation)) {
      issues.push('champion-continuation 必须跳过自动回滚提交（防止回滚循环重启训练）');
    }
  }

  const writeContents = files.filter(f => /contents:\s*write/.test(stripComments(text[f])));
  const allowedWrite = new Set(['ai-training.yml', 'ci.yml']);
  if (writeContents.some(f => !allowedWrite.has(f))) {
    issues.push(`contents: write 只允许出现在 ai-training.yml 与 ci.yml 的受控作业，实际：${writeContents.join(', ')}`);
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
