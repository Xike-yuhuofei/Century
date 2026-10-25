/** D6：轻量闭环演示。
 *
 * 使用少量开发种子（AI7 screen/deep 块）与少量候选完成一次端到端演示：
 *   生成多个合法候选（含 1 个非法参数、1 个静态安全失败）
 *   → 安全检查/构建校验 → 开发池快筛 → 多维筛选 → 独立深验
 *   → 待人工批准挑战请求 → 失败诊断/研究提示
 *   → 中途安全停止 + 断点恢复 → 结果归档
 *
 * 证明点（summary.checks）：
 * - 产生多个合法候选与独立 artifact；
 * - 安全检查与评分正常，失败候选不污染其他候选；
 * - 可以停止、恢复并重新读取结果；
 * - 生成正式挑战的待审核请求，且绝不自动修改冠军/晋级；
 * - 不消费正式验证池（审计所有 seed window）。
 *
 * 运行：
 *   node training/evolution/demo.mjs            # 真实开发池小规模对局
 *   node training/evolution/demo.mjs --fake     # 假评估器（CI/单测，不跑对局）
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureDir, writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { CampaignController } from './campaign-controller.mjs';
import { createTestDoubleGovernance, createGovernanceAdapter } from './governance-adapter.mjs';
import { ArtifactStore } from './artifact-store.mjs';
import { generateCandidateBatch, scriptedCandidates } from './candidate-generator.mjs';
import { evaluateCandidate } from './dev-evaluator.mjs';
import { VALIDATION_POOL_BLOCK, assertCondition, sha256Canonical } from './core.mjs';

export const DEMO_ROOT = resolve(REPO_ROOT, 'training/reports/ai7-evolution-demo');

const GUARDRAIL_FILES = [
  'training/champions/champion.json',
  'training/champions/candidates/joint-js5.json',
  'training/champions/candidates/ai5-readiness-efficiency.json',
  'web-v1/src/ai/parameters.ts',
  'training/adversarial/seed-ledger.json',
];

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validationLedgerFiles() {
  const root = resolve(REPO_ROOT, 'training/reports');
  if (!existsSync(root)) return [];
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'validation-ledger.json') files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

function snapshotGuardrails() {
  const files = [...GUARDRAIL_FILES, ...validationLedgerFiles()];
  const hashes = {};
  for (const file of files) {
    const path = resolve(REPO_ROOT, file);
    if (existsSync(path)) hashes[file] = hashFile(path);
  }
  return { hashes, count: Object.keys(hashes).length };
}

function diffGuardrails(before, after) {
  const changes = [];
  for (const [file, hash] of Object.entries(before.hashes)) {
    if (after.hashes[file] !== hash) changes.push(file);
  }
  for (const [file, hash] of Object.entries(after.hashes)) {
    if (before.hashes[file] !== hash) changes.push(file);
  }
  return changes;
}

function fakeEvaluator({ artifact, seeds, purpose }) {
  const mode = artifact.algorithmStructure.evaluationMode;
  const n = artifact.candidateId.length % 4;
  const behaviorSignature = mode === 'game'
    ? {
        kind: 'game-behavior-v1',
        actions: { acquire: 0.15 + n * 0.03, claim: 0.15, rest: 0.2, play: 0.4, discard: 0.1 },
        meanRank: 2 + n * 0.2, meanScore: 50 + n * 2, meanMoves: 120, seatCounts: [2, 3],
      }
    : { kind: 'proxy-coefficients-v1', targetId: artifact.algorithmStructure.targetIds[0], coefficients: { goalFit: 0.4 + n * 0.1 }, bias: 0 };
  const metrics = mode === 'game'
    ? (() => {
        const games = seeds.length * 2;
        const wins = Math.min(games, 2 + n);
        return {
          evidenceType: 'dev-game', totalGames: games, finishedGames: games,
          anomalies: 0, anomalyRate: 0, wins,
          firstPlaceRate: wins / games, chanceAdjustedRate: 0.08 + n * 0.03,
          minWilsonLower: 0.08 + n * 0.02, p95WallMs: 900 + n * 50, meanWallMs: 800,
          byPlayerCount: {},
        };
      })()
    : { evidenceType: 'offline-proxy', totalGames: 0, fixtures: 2, fallbackCount: 0, fallbackRate: 0, proxyDelta: 0.03 + n * 0.02 };
  return {
    schema: 'demo-fake-evidence', candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest, evaluationMode: mode, purpose,
    metrics, behaviorSignature, behaviorHash: sha256Canonical(behaviorSignature),
  };
}

/** 演示生成器：确定性有界候选 + 脚本化非法/不安全候选。 */
function demoGenerator(options) {
  const generated = generateCandidateBatch({
    ...options,
    count: 2,
    targetIds: ['candidateCap', 'searchBudget'],
    hints: options.hints,
  });
  const scripted = scriptedCandidates({
    experiment: options.experiment, round: options.round, includeCompiled: true,
  });
  const seen = new Set();
  const candidates = [];
  for (const item of [...generated, ...scripted.candidates]) {
    if (seen.has(item.artifact.identityDigest)) continue;
    seen.add(item.artifact.identityDigest);
    candidates.push(item);
  }
  return { candidates, rejectedAtGeneration: scripted.rejectedAtGeneration };
}

function demoConfig() {
  // 配置来自仓库内可审计文件（artifact.experiment.configRef 指向同一路径）。
  const path = resolve(REPO_ROOT, 'training/evolution/configs/ai7-demo.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path) {
  return relative(REPO_ROOT, path);
}

function displayPath(path) {
  return isAbsolute(path) ? rel(path) : path;
}

function buildSummary({ results, firstRun, guardrailBefore, guardrailAfter, auditTrail, store, rootDir, useFakeEvaluator }) {
  const changes = diffGuardrails(guardrailBefore, guardrailAfter);
  const round = results.rounds[0];
  const candidates = round.candidates;
  const safetyFailed = candidates.filter(c => c.stage === 'safety-failed');
  const evaluated = candidates.filter(c => c.quick);
  const selected = candidates.filter(c => ['selected', 'deep-done', 'pending-approval'].includes(c.stage));
  const deepConfirmed = candidates.filter(c => c.deep?.status === 'done');
  const labels = round.diagnostics?.labels ?? [];
  const findings = labels.filter(l => l.status === 'finding');
  const hints = round.diagnostics?.researchHints;
  const windows = [round.seedWindows.screen, round.seedWindows.deep];
  const validationTouched = windows.some(w =>
    w.base < VALIDATION_POOL_BLOCK[1] && VALIDATION_POOL_BLOCK[0] < w.base + w.count);
  const artifacts = store.list();
  const checks = {
    multipleValidCandidates: candidates.length >= 4 && evaluated.length >= 3,
    independentArtifacts: artifacts.length >= 4 && artifacts.every(a => a.identityDigest && a.artifactHash),
    evidenceIndependence: selected.every(c => c.evidenceDir && existsSync(resolve(REPO_ROOT, c.evidenceDir))),
    safetyChecksRan: candidates.every(c => c.safetyStatus === 'passed' || c.safetyStatus === 'failed'),
    failureIsolation: safetyFailed.length >= 1 && evaluated.length >= 3
      && candidates.some(c => c.stage === 'safety-failed') && candidates.some(c => c.stage === 'pending-approval'),
    generationRejectedInvalid: round.rejectedAtGeneration.length >= 1,
    selectedMultiple: selected.length >= 2,
    deepConfirmed: deepConfirmed.length >= 1,
    pendingHumanApproval: results.pendingApprovals.length >= 1
      && results.pendingApprovals.every(p => p.status === 'pending-human-approval' && p.promotionTriggered === false),
    stopAndResume: firstRun.status === 'stopped' && results.status === 'completed',
    noValidationPoolConsumption: !validationTouched
      && auditTrail.windows.every(w => w.base < VALIDATION_POOL_BLOCK[0] || w.base >= VALIDATION_POOL_BLOCK[1]),
    noChampionMutation: changes.length === 0,
    diagnosticsFlowedBack: findings.length >= 1 && (hints?.suggestedTargets?.length ?? 0) >= 1,
    advisoryOnlyHints: hints?.discipline?.advisoryOnly === true && hints?.discipline?.notRewardTruth === true,
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    schema: 'century-ai7-evolution-demo-v1',
    ok,
    mode: useFakeEvaluator ? 'fake-evaluator (CI/demo logic)' : 'real-dev-games (lightweight)',
    campaignId: results.campaignId,
    status: results.status,
    firstRunStatus: firstRun.status,
    checkpointSeq: results.checkpointSeq,
    budgetUsed: results.budgetUsed,
    seeds: { screen: round.seeds.screen, deep: round.seeds.deep, windows: windows },
    candidateCount: candidates.length,
    safetyFailed: safetyFailed.map(c => ({ candidateId: c.candidateId, failure: c.failure })),
    rejectedAtGeneration: round.rejectedAtGeneration,
    evaluated: evaluated.map(c => ({
      candidateId: c.candidateId,
      mode: c.evaluationMode,
      stage: c.stage,
      quickScore: c.quick?.score?.composite ?? null,
      deepScore: c.deep?.score?.composite ?? null,
      firstPlaceRate: c.quick?.metrics?.firstPlaceRate ?? null,
      proxyDelta: c.quick?.metrics?.proxyDelta ?? null,
    })),
    selected: selected.map(c => ({ candidateId: c.candidateId, stage: c.stage, mode: c.evaluationMode })),
    selectionSummary: round.selection,
    deepConfirmed: deepConfirmed.map(c => ({ candidateId: c.candidateId, metrics: c.deep.metrics })),
    pendingApprovals: results.pendingApprovals.map(p => ({
      requestId: p.requestId, candidateId: p.candidateId, status: p.status,
      requestPath: displayPath(p.requestPath), promotionTriggered: p.promotionTriggered,
    })),
    diagnostics: {
      paths: round.diagnostics?.paths ?? [],
      findings: findings.map(l => ({ code: l.code, label: l.label, occurrences: l.occurrences })),
      suggestedTargets: hints?.suggestedTargets ?? [],
      advisoryOnly: hints?.discipline?.advisoryOnly ?? null,
      notRewardTruth: hints?.discipline?.notRewardTruth ?? null,
    },
    artifacts: artifacts.map(a => ({
      candidateId: a.candidateId, identityDigest: a.identityDigest,
      buildArtifactHash: a.buildArtifactHash, evaluationMode: a.evaluationMode, status: a.status,
    })),
    guardrails: {
      changedFiles: changes,
      championAndLedgerUnchanged: changes.length === 0,
      validationPoolConsumed: validationTouched,
      promotionTriggered: results.guardrails.promotionTriggered,
      formalChallengeApprovalRequired: results.guardrails.formalChallengeApprovalRequired,
    },
    auditTrail,
    checks,
    paths: {
      root: displayPath(rootDir),
      state: rel(resolve(rootDir, 'state.json')),
      results: rel(resolve(rootDir, 'results.json')),
      events: rel(resolve(rootDir, 'logs/events.jsonl')),
      checkpoints: rel(resolve(rootDir, 'checkpoints')),
      artifacts: rel(resolve(rootDir, 'artifacts')),
      evidence: rel(resolve(rootDir, 'evidence')),
      pendingApproval: rel(resolve(rootDir, 'pending-approval')),
      diagnostics: rel(resolve(rootDir, 'diagnostics')),
    },
  };
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push('# AI7 自主进化轻量闭环演示', '');
  lines.push(`- 模式：${summary.mode}`);
  lines.push(`- campaign：\`${summary.campaignId}\``);
  lines.push(`- 状态：${summary.status}（第一次运行安全停止：${summary.firstRunStatus} → 恢复完成）`);
  lines.push(`- 检查点序号：${summary.checkpointSeq}`);
  lines.push(`- 预算使用：候选 ${summary.budgetUsed.candidates}，对局 ${summary.budgetUsed.games}，深验 ${summary.budgetUsed.deepConfirmations}`);
  lines.push(`- 种子窗口：screen \`${summary.seeds.windows[0].windowId}\` [${summary.seeds.screen.join(', ')}]；deep \`${summary.seeds.windows[1].windowId}\` [${summary.seeds.deep.join(', ')}]`);
  lines.push('');
  lines.push('## 候选结果', '');
  lines.push('| 候选 | 模式 | 阶段 | 快筛分 | 深验分 | 第一名率 | proxy Δ |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const c of summary.evaluated) {
    lines.push(`| ${c.candidateId} | ${c.mode} | ${c.stage} | ${c.quickScore?.toFixed(4) ?? '—'} | ${c.deepScore?.toFixed(4) ?? '—'} | ${c.firstPlaceRate?.toFixed(3) ?? '—'} | ${c.proxyDelta?.toFixed(3) ?? '—'} |`);
  }
  lines.push('');
  lines.push(`安全失败候选（隔离，不污染其他候选）：${summary.safetyFailed.map(c => c.candidateId).join('、') || '无'}`);
  lines.push(`生成即拒绝候选：${summary.rejectedAtGeneration.map(r => `${r.targetId}（${r.error}）`).join('；') || '无'}`);
  lines.push(`保留候选：${summary.selected.map(c => `${c.candidateId}(${c.mode})`).join('、')}`);
  lines.push('');
  lines.push('## 待人工审批的正式挑战请求', '');
  for (const p of summary.pendingApprovals) {
    lines.push(`- \`${p.requestId}\` 候选 ${p.candidateId}，状态 ${p.status}，自动晋级=${p.promotionTriggered}；文件 ${p.requestPath}`);
  }
  lines.push('');
  lines.push('## 失败诊断回流', '');
  lines.push(`- 诊断来源：${summary.diagnostics.paths.map(displayPath).join('、')}`);
  lines.push(`- finding 标签：${summary.diagnostics.findings.map(l => `${l.label}(${l.occurrences})`).join('、')}`);
  lines.push(`- 研究提示目标：${summary.diagnostics.suggestedTargets.join('、')}`);
  lines.push(`- advisoryOnly=${summary.diagnostics.advisoryOnly}, notRewardTruth=${summary.diagnostics.notRewardTruth}`);
  lines.push('');
  lines.push('## 验收检查', '');
  for (const [key, value] of Object.entries(summary.checks)) lines.push(`- ${key}: ${value ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`总判定：**${summary.ok ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 运行演示。
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {boolean} [options.useFakeEvaluator]
 * @param {number|null} [options.firstRunMaxSteps]
 * @param {boolean} [options.clean]
 */
export async function runDemo({
  rootDir = DEMO_ROOT, useFakeEvaluator = false, firstRunMaxSteps = 8, clean = true,
} = {}) {
  const root = resolve(rootDir);
  assertCondition(root !== REPO_ROOT, '演示目录不能是仓库根目录');
  if (clean && existsSync(root)) rmSync(root, { recursive: true, force: true });
  ensureDir(root);

  const guardrailBefore = snapshotGuardrails();
  const provider = createTestDoubleGovernance();
  const governance = createGovernanceAdapter({ provider });
  const store = new ArtifactStore({ root: resolve(root, 'artifacts') });
  const controller = new CampaignController({
    campaignId: 'ai7-demo-20261025',
    rootDir: root,
    store,
    governance,
    config: demoConfig(),
    generator: demoGenerator,
    evaluator: useFakeEvaluator ? fakeEvaluator : evaluateCandidate,
  });

  writeJSON(resolve(root, 'governance-policy.json'), {
    adapter: {
      contractVersion: governance.contractVersion,
      mode: governance.mode,
      capabilities: governance.capabilities,
    },
    provider: provider.describePolicy(),
  });

  const firstRun = await controller.run({ maxSteps: firstRunMaxSteps });
  const firstRunStatus = firstRun.status;
  const resumed = await controller.run({ resume: true });
  const guardrailAfter = snapshotGuardrails();
  const auditTrail = governance.auditTrail();
  const summary = buildSummary({
    results: resumed,
    firstRun: { status: firstRunStatus },
    guardrailBefore,
    guardrailAfter,
    auditTrail,
    store,
    rootDir: root,
    useFakeEvaluator,
  });

  writeJSON(resolve(root, 'demo-summary.json'), summary);
  writeJSON(resolve(root, 'governance-audit.json'), auditTrail);
  const markdownPath = resolve(root, 'demo-summary.md');
  writeFileSyncSafe(markdownPath, renderMarkdown(summary));
  summary.markdownPath = rel(markdownPath);
  writeJSON(resolve(root, 'demo-summary.json'), summary);
  return summary;
}

function writeFileSyncSafe(path, content) {
  writeFileSync(path, content, 'utf8');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const useFakeEvaluator = process.argv.includes('--fake');
  const summary = await runDemo({ useFakeEvaluator });
  process.stdout.write(renderMarkdown(summary) + '\n');
  if (!summary.ok) process.exitCode = 1;
}
