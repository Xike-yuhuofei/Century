#!/usr/bin/env node
/** 统一自动化运行报告 + 训练有效性校验（失败关闭）。
 *
 * 目的：把「工作流成功」与「训练确实产生了可审计产物」分开判定。
 * - 读取 campaign state / run-summary / events / 候选证据 / 晋级结果；
 * - 生成统一 run-report.json + run-report.md（训练时长、候选与淘汰原因、
 *   算法轨道、第一名率、冠军/部署身份、失败与恢复、下一轮状态）；
 * - --validate 时对缺失产物、状态矛盾、静默丢失晋级请求等 fail-closed。
 *
 * 用法：
 *   node training/scripts/automation-report.mjs \
 *     --run-dir training/reports/coevolution/ai9-daily-20261026 \
 *     --mode ai9-coevolve --out training/reports/automation/ai9-daily-20261026 \
 *     --validate --min-candidates 1 --min-games 1
 *
 * 退出码：0=有效运行（可含 NO_CANDIDATE）；1=产物/状态无效；2=参数错误。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { ensureDir, writeJSON } from '../lib/io.mjs';

const ALLOWED_TERMINAL = new Set(['completed', 'budget-exhausted']);
const ALLOWED_STOPPED = new Set(['stopped']);
const FAILURE_VERDICTS = new Set(['ERROR', 'CHALLENGE_ERROR', 'PUBLISH_FAILED', 'FAILED']);

function parseArgs(argv) {
  const values = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { values._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (!args['run-dir']) {
  console.error('必须提供 --run-dir <训练运行目录>');
  process.exit(2);
}
const runDir = resolve(process.cwd(), String(args['run-dir']));
const outDir = resolve(process.cwd(), String(args.out ?? join('training/reports/automation', basename(runDir))));
const validate = args.validate === true;
const allowStopped = args['allow-stopped'] === true;
const minCandidates = Number(args['min-candidates'] ?? 0);
const minGames = Number(args['min-games'] ?? 0);
const mode = String(args.mode ?? 'unknown');

function readJSON(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function readEvents(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map(line => JSON.parse(line));
}

function histogram(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function fileList(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? fileList(path) : [path];
  });
}

function loadChampion() {
  const champion = readJSON(resolve(REPO_ROOT, 'training/champions/champion.json'));
  if (!champion) return null;
  return {
    id: champion.parameters?.id ?? champion.id ?? null,
    promotedAt: champion.provenance?.promotedAt ?? null,
    basedOn: champion.provenance?.basedOn ?? null,
    planId: champion.provenance?.promotionEvidence?.planId ?? null,
    evidenceHash: champion.provenance?.promotionEvidence?.evidenceHash ?? null,
  };
}

function loadDeploymentIdentity() {
  const candidates = [
    process.env.CENTURY_DEPLOYMENT_IDENTITY,
    'training/reports/deploy-verification.json',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const doc = readJSON(resolve(REPO_ROOT, candidate));
    if (doc) {
      return {
        source: candidate,
        verifiedAt: doc.verifiedAt ?? null,
        url: doc.url ?? null,
        artifact: doc.expectedArtifact ?? null,
        champion: doc.expectedChampion ?? null,
        verdict: doc.verdict ?? (doc.failed ? 'FAIL' : 'PASS'),
      };
    }
  }
  return null;
}

function summarizeCampaign(state, runSummary, events) {
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  const candidates = rounds.flatMap(round => (round.candidates ?? []).map(c => ({ ...c, round: round.round })));
  const outcomes = Array.isArray(state.promotionOutcomes) ? state.promotionOutcomes : [];
  const failures = candidates.filter(c => c.failure).map(c => ({
    candidateId: c.candidateId,
    stage: c.failure.stage ?? 'unknown',
    reason: String(c.failure.reason ?? c.failure.checks?.map(x => x.id).join(',') ?? 'unknown').slice(0, 300),
  }));
  const quick = candidates.filter(c => c.quick?.metrics);
  const deep = candidates.filter(c => c.deep?.metrics);
  const mean = values => (values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4))
    : null);
  const startedAt = state.createdAt ?? runSummary?.startedAt ?? null;
  const lastEvent = events.at(-1);
  const elapsedMs = runSummary?.elapsedMs
    ?? (startedAt && lastEvent?.at ? Date.parse(lastEvent.at) - Date.parse(startedAt) : null);
  const stopped = events.filter(e => e.type === 'campaign-stopped');
  const resumed = events.filter(e => e.type === 'campaign-resumed');
  const promotionOutcomeVerdicts = outcomes.map(o => o.outcome?.verdict ?? 'UNKNOWN');
  return {
    kind: 'campaign',
    schema: state.schema,
    status: state.status,
    phase: state.phase,
    createdAt: startedAt,
    updatedAt: state.updatedAt ?? null,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    effectiveTrainingMs: state.budgetUsed?.wallMs ?? null,
    budget: state.config?.budget ?? null,
    budgetUsed: state.budgetUsed ?? null,
    rounds: rounds.length,
    candidates: {
      total: candidates.length,
      quickEvaluated: quick.length,
      deepConfirmed: deep.length,
      selected: candidates.filter(c => String(c.stage).startsWith('selected')).length,
      promotionQueued: candidates.filter(c => String(c.stage).startsWith('promotion')).length,
      rejectionReasons: histogram(failures, f => `${f.stage}:${f.reason.split(/[（(]/)[0].slice(0, 80)}`),
      failures,
    },
    algorithmTracks: {
      generationMode: state.config?.generation?.mode ?? null,
      generator: state.config?.generation?.generator ?? null,
      strategies: state.config?.generation?.strategies ?? null,
      targetIds: state.config?.generation?.targetIds ?? null,
      generatorsUsed: histogram(candidates.filter(c => c.generator), c => c.generator),
      strategiesUsed: histogram(candidates.filter(c => c.strategy), c => c.strategy),
    },
    firstPlace: {
      quickMeanRate: mean(quick.map(c => Number(c.quick.metrics.firstPlaceRate)).filter(Number.isFinite)),
      deepMeanRate: mean(deep.map(c => Number(c.deep.metrics.firstPlaceRate)).filter(Number.isFinite)),
      deepMeanChanceAdjusted: mean(deep.map(c => Number(c.deep.metrics.chanceAdjustedRate)).filter(Number.isFinite)),
      note: '开发池小样本仅用于候选排序；正式晋级只认预注册 2–5 人第一名率挑战证据',
    },
    promotion: {
      queue: Array.isArray(state.promotionQueue) ? state.promotionQueue.length : 0,
      outcomes: outcomes.map(o => ({
        requestId: o.requestId,
        verdict: o.outcome?.verdict ?? 'UNKNOWN',
        reason: o.outcome?.reason ?? null,
        evidenceHash: o.outcome?.evidenceHash ?? null,
        publication: o.outcome?.publication?.verdict ?? null,
      })),
      verdicts: promotionOutcomeVerdicts,
      candidateReady: promotionOutcomeVerdicts.includes('PROMOTE_EVIDENCE_READY'),
      blocked: promotionOutcomeVerdicts.filter(v => v === 'BLOCKED').length,
    },
    guardrails: state.guardrails ?? null,
    recovery: {
      stopEvents: stopped.length,
      resumeEvents: resumed.length,
      lastStopReason: stopped.at(-1)?.payload?.reason ?? null,
      lastResumeSeq: resumed.at(-1)?.seq ?? null,
      lastError: state.lastError ?? null,
    },
  };
}

function summarizeEvolve(state, report, ledger) {
  const history = Array.isArray(report?.history) ? report.history : [];
  const generations = Number(report?.generations ?? state?.generation ?? 0);
  const candidateFile = readJSON(join(runDir, 'candidate.json'));
  const confirmation = report?.confirmation ?? null;
  return {
    kind: 'evolve',
    status: state?.interrupted ? 'stopped' : (state?.generation >= generations ? 'completed' : 'failed'),
    phase: state?.interrupted ? 'interrupted' : 'completed',
    createdAt: report?.startedAt ?? null,
    updatedAt: null,
    elapsedMs: Number(report?.wallMs ?? confirmation?.wallMs ?? null),
    effectiveTrainingMs: Number(report?.wallMs ?? null),
    budget: null,
    budgetUsed: {
      candidates: history.length ? Number(report?.population ?? 0) * generations : null,
      games: null,
    },
    rounds: generations,
    candidates: {
      total: history.length ? Number(report?.population ?? 0) * generations : null,
      quickEvaluated: null,
      deepConfirmed: confirmation ? 1 : 0,
      selected: report?.bestCandidateId ? 1 : 0,
      promotionQueued: candidateFile ? 1 : 0,
      rejectionReasons: {},
      failures: [],
    },
    algorithmTracks: {
      generationMode: 'descriptor',
      generator: 'bounded',
      strategies: null,
      targetIds: null,
      generatorsUsed: { bounded: history.length ? 1 : 0 },
      strategiesUsed: {},
    },
    firstPlace: {
      quickMeanRate: null,
      deepMeanRate: confirmation?.firstPlace?.candidateRate ?? null,
      deepMeanChanceAdjusted: confirmation?.firstPlace?.chanceAdjustedRate ?? null,
      note: 'AI4 参数进化只覆盖 5 人确认挑战，不构成本轮 AI9 晋级证据',
    },
    promotion: {
      queue: candidateFile ? 1 : 0,
      outcomes: candidateFile ? [{ verdict: 'CANDIDATE_READY', reason: null, evidenceHash: null, publication: null }] : [],
      verdicts: candidateFile ? ['CANDIDATE_READY'] : [],
      candidateReady: Boolean(candidateFile),
      blocked: 0,
    },
    guardrails: {
      validationPoolConsumed: Boolean(ledger?.history?.length),
      promotionTriggered: false,
      championMutation: 'none',
    },
    recovery: {
      stopEvents: state?.interrupted ? 1 : 0,
      resumeEvents: Number(state?.resumeCount ?? 0),
      lastStopReason: state?.interrupted ? 'time-budget-or-interrupt' : null,
      lastResumeSeq: null,
      lastError: null,
    },
    extra: {
      seedCursorAfter: report?.seedAllocation?.seedCursorAfter ?? state?.seedCursor ?? null,
      bestCandidateId: report?.bestCandidateId ?? null,
      improved: report?.improved ?? null,
      challengeIndex: report?.challengeIndex ?? null,
      confirmationSkipped: report?.confirmationSkipped ?? null,
    },
  };
}

function validateRun(summary, state, report) {
  const problems = [];
  if (!state && !report) problems.push('缺少 state.json / report.json：训练没有可审计产物');
  if (state && !ALLOWED_TERMINAL.has(state.status ?? summary.status) && !(allowStopped && ALLOWED_STOPPED.has(state.status))) {
    problems.push(`训练未正常收尾：status=${String(state.status ?? summary.status)}（允许 completed/budget-exhausted${allowStopped ? '/stopped' : ''}）`);
  }
  if (state && Number(summary.candidates.total ?? 0) < minCandidates) {
    problems.push(`候选数不足：${summary.candidates.total ?? 0} < ${minCandidates}`);
  }
  if (state && Number(summary.budgetUsed?.games ?? 0) < minGames) {
    problems.push(`对局数不足：${summary.budgetUsed?.games ?? 0} < ${minGames}`);
  }
  if (state?.promotionQueue?.length > 0 && (state.promotionOutcomes ?? []).length === 0) {
    problems.push(`晋级请求 ${state.promotionQueue.length} 条但没有任何 promotionOutcome：晋级处理器被静默跳过`);
  }
  const failedOutcomes = summary.promotion.outcomes.filter(o => FAILURE_VERDICTS.has(o.verdict));
  if (failedOutcomes.length) {
    problems.push(`晋级处理器失败：${failedOutcomes.map(o => `${o.requestId ?? '?'}=${o.verdict}`).join(', ')}`);
  }
  if (state && state.guardrails) {
    const g = state.guardrails;
    if (g.validationPoolConsumed !== false) problems.push('开发训练意外消费了正式验证池');
    if (g.championMutation && g.championMutation !== 'none') problems.push(`训练过程改动了冠军：${g.championMutation}`);
    if (g.promotionTriggered !== false) problems.push('训练过程直接触发冠军晋级（必须交给 CI 机器门禁）');
  }
  if (state?.codeVersion) {
    const cv = state.codeVersion;
    if (cv.headDirty !== false) problems.push('训练启动时工作区不干净（headDirty≠false）：不可复现');
    if (!cv.codeDigest) problems.push('训练缺少 codeDigest：无法绑定代码版本');
  }
  if (summary.promotion.queue > 0 && summary.promotion.outcomes.length === 0 && !state) {
    problems.push('晋级队列非空但无结果');
  }
  return problems;
}

const state = readJSON(join(runDir, 'state.json'));
const runSummary = readJSON(join(runDir, 'run-summary.json'));
const report = readJSON(join(runDir, 'report.json'));
const ledger = readJSON(join(runDir, 'validation-ledger.json'));
const events = readEvents(join(runDir, 'logs', 'events.jsonl'));
const summary = state?.schema === 'century-evolution-campaign-v1'
  ? summarizeCampaign(state, runSummary, events)
  : summarizeEvolve(state, report, ledger);
const problems = validateRun(summary, state, report);
const evidenceFiles = fileList(runDir);
const noCandidate = !summary.promotion.candidateReady;
const document = {
  ...summary,
  schema: 'century-automation-run-report-v1',
  generatedAt: new Date().toISOString(),
  runDir,
  mode,
  campaignId: state?.campaignId ?? report?.champion ?? basename(runDir),
  workflow: {
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    ref: process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  },
  verdict: problems.length ? 'FAIL' : 'PASS',
  problems,
  promotionCandidate: summary.promotion.candidateReady,
  noCandidateReason: summary.promotion.candidateReady
    ? null
    : (summary.promotion.outcomes.length
      ? `晋级处理器返回 ${summary.promotion.verdicts.join(', ')}；保留现冠军`
      : '本轮没有候选到达机器门禁（候选被淘汰或预算内未完成深验）；保留现冠军'),
  champion: loadChampion(),
  deployment: loadDeploymentIdentity(),
  nextRun: {
    state: problems.length ? 'requires-attention' : (noCandidate ? 'normal-training-continues' : 'promotion-pipeline'),
    note: problems.length
      ? '运行报告判定 FAIL：下一次定时训练仍会执行，但必须先修复报告中的问题'
      : (noCandidate ? '未发现有效候选：保留现任冠军，下一轮定时训练照常进行' : '候选证据已就绪：等待 CI 机器门禁/部署核验'),
  },
  evidence: {
    files: evidenceFiles.length,
    totalBytes: evidenceFiles.reduce((sum, path) => sum + Number(fileSize(path)), 0),
    note: '原始逐局证据保留在本次 artifact；报告只汇总可审计字段',
  },
};

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function renderMarkdown(doc) {
  const lines = [
    `# 自动化运行报告 · ${doc.campaignId}`,
    '',
    `- 模式：${doc.mode}`,
    `- 判定：**${doc.verdict}**${doc.problems.length ? `（${doc.problems.length} 项问题）` : ''}`,
    `- 训练状态：${doc.status} / ${doc.phase}`,
    `- 运行时长：${doc.elapsedMs == null ? '-' : `${(doc.elapsedMs / 60000).toFixed(1)} 分钟`}（有效训练 ${doc.effectiveTrainingMs == null ? '-' : `${(doc.effectiveTrainingMs / 60000).toFixed(1)} 分钟`}）`,
    `- 轮次：${doc.rounds}；候选：${doc.candidates.total}；对局：${doc.budgetUsed?.games ?? '-'}`,
    `- 算法轨道：${doc.algorithmTracks.generationMode}/${doc.algorithmTracks.generator ?? '-'}`,
    `- 候选晋级：${doc.promotionCandidate ? 'YES' : 'NO'}；${doc.noCandidateReason ?? ''}`,
    `- 冠军：${doc.champion?.id ?? '-'}；部署核验：${doc.deployment?.verdict ?? 'NOT_RUN'}`,
    '',
    '## 淘汰与失败原因',
    '',
    ...(Object.keys(doc.candidates.rejectionReasons).length
      ? Object.entries(doc.candidates.rejectionReasons).map(([reason, count]) => `- ${reason}: ${count}`)
      : ['- 无淘汰记录']),
    '',
    '## 晋级结果',
    '',
    ...(doc.promotion.outcomes.length
      ? doc.promotion.outcomes.map(o => `- ${o.requestId ?? 'request'}: ${o.verdict}${o.reason ? `（${o.reason}）` : ''}`)
      : ['- 没有候选进入正式挑战/晋级处理器']),
    '',
    '## 恢复与下一轮',
    '',
    `- 停止事件：${doc.recovery.stopEvents}；恢复事件：${doc.recovery.resumeEvents}`,
    `- 最后错误：${doc.recovery.lastError ? JSON.stringify(doc.recovery.lastError) : '无'}`,
    `- 下一轮：${doc.nextRun.note}`,
    '',
  ];
  if (doc.problems.length) {
    lines.push('## 失败原因', '', ...doc.problems.map(p => `- ${p}`), '');
  }
  return lines.join('\n');
}

ensureDir(outDir);
const jsonPath = join(outDir, 'run-report.json');
writeJSON(jsonPath, document);
const md = renderMarkdown(document);
const mdPath = join(outDir, 'run-report.md');
writeFileSync(mdPath, `${md}\n`);
console.log(JSON.stringify({
  verdict: document.verdict,
  problems,
  promotionCandidate: document.promotionCandidate,
  candidates: document.candidates.total,
  games: document.budgetUsed?.games ?? null,
  jsonPath,
  mdPath,
}, null, 2));
if (document.verdict !== 'PASS') {
  // 同时写 stderr，Actions 日志与测试断言都能定位；stdout 保留结构化 JSON。
  console.error(`运行报告失败关闭：\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
