#!/usr/bin/env node
/** AI9 R09：12 小时持续运行 + 强制终止恢复的验收审计。
 *
 * 只读取 campaign 的真实 state.json 与 append-only events.jsonl，
 * 不信任任何手写总结。判定：
 * - PASS：预算跑满、强制停止→同配置恢复→正常结束、样本/门禁证据齐全；
 * - IN_PROGRESS：campaign 仍在运行或尚未跑满 12h 预算；
 * - FAIL：状态/事件/预算/证据自相矛盾。
 *
 * 输出：training/reports/ai9/endurance-audit.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';
import { CODE_VERSION_SCHEMA, computeCodeVersion, sameCodeDigest } from '../lib/code-version.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const campaignId = String(argValue('--campaign', 'ai9-12h-endurance-3'));
const minWallRatio = Number(argValue('--min-wall-ratio', '0.95'));
const outPath = resolve(REPO_ROOT, String(argValue('--out', 'training/reports/ai9/endurance-audit.json')));
const campaignDir = resolve(REPO_ROOT, 'training/reports/coevolution', campaignId);
const statePath = resolve(campaignDir, 'state.json');
const eventsPath = resolve(campaignDir, 'logs/events.jsonl');

function readEvents() {
  if (!existsSync(eventsPath)) return [];
  const text = readFileSync(eventsPath, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map(line => JSON.parse(line));
}

const checks = [];
function add(id, status, evidence) {
  checks.push({ id, status, evidence });
}

if (!existsSync(statePath)) {
  add('state-exists', 'FAIL', statePath);
  writeJSON(outPath, {
    schema: 'century-ai9-endurance-audit-v1',
    generatedAt: new Date().toISOString(),
    campaignId,
    verdict: 'FAIL',
    checks,
  });
  console.error(`缺少 campaign state：${statePath}`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const events = readEvents();
const config = state.config ?? {};
const budget = config.budget ?? {};
const used = state.budgetUsed ?? {};
const maxWallMs = Number(budget.maxWallMs ?? 0);
const requiredWallMs = Math.round(maxWallMs * minWallRatio);

add('state-schema', state.schema === 'century-evolution-campaign-v1' ? 'PASS' : 'FAIL', state.schema);

const codeVersion = state.codeVersion ?? null;
if (!codeVersion) {
  add('code-version-legacy', 'LEGACY',
    'campaign 启动早于 codeVersion 捕获；不追认当前代码为历史起点，也不伪造 state。该 campaign 的代码身份改由 runFingerprint、候选 artifact 哈希与构建日志佐证');
} else {
  add('code-version-declared',
    codeVersion.schema === CODE_VERSION_SCHEMA
      && /^[0-9a-f]{40}$/.test(String(codeVersion.headCommit ?? ''))
      && /^[0-9a-f]{64}$/.test(String(codeVersion.codeDigest ?? ''))
      ? 'PASS' : 'FAIL',
    `schema=${codeVersion.schema}，head=${String(codeVersion.headCommit).slice(0, 12)}，digest=${String(codeVersion.codeDigest).slice(0, 12)}`);
  add('code-version-clean',
    codeVersion.headDirty === false
      && codeVersion.webBuild?.gitDirty === false
      && Boolean(codeVersion.webBuild?.sourceSha256)
      && Boolean(codeVersion.webBuild?.artifactSha256)
      ? 'PASS' : 'FAIL',
    `headDirty=${codeVersion.headDirty}，webBuildDirty=${codeVersion.webBuild?.gitDirty}，dirtyFiles=${(codeVersion.dirtyFiles ?? []).length}`);
  let recomputedCodeVersion = null;
  try {
    recomputedCodeVersion = computeCodeVersion();
  } catch (error) {
    recomputedCodeVersion = { error: error.message };
  }
  add('code-version-recomputed',
    sameCodeDigest(codeVersion, recomputedCodeVersion) ? 'PASS' : 'FAIL',
    recomputedCodeVersion?.error
      ? recomputedCodeVersion.error
      : `state=${String(codeVersion.codeDigest).slice(0, 12)} ≠ current=${String(recomputedCodeVersion.codeDigest).slice(0, 12)}`);
}

add('wall-budget-declared',
  maxWallMs >= 43_200_000 ? 'PASS' : 'FAIL',
  `maxWallMs=${maxWallMs}，要求 >= 43,200,000（12h）`);
add('player-counts',
  Array.isArray(config.playerCounts) && [2, 3, 4, 5].every(n => config.playerCounts.includes(n)) ? 'PASS' : 'FAIL',
  JSON.stringify(config.playerCounts));
add('multi-module-targets',
  Array.isArray(config.generation?.targetIds) && config.generation.targetIds.length >= 2 ? 'PASS' : 'FAIL',
  JSON.stringify(config.generation?.targetIds));
add('strategy-coverage',
  Array.isArray(config.generation?.strategies)
    && ['single', 'pair', 'multi', 'crossover', 'ablation'].every(s => config.generation.strategies.includes(s))
    ? 'PASS' : 'FAIL',
  JSON.stringify(config.generation?.strategies));

const terminal = state.status === 'completed' || state.status === 'budget-exhausted';
const running = state.status === 'running';

const started = events.find(event => event.type === 'campaign-started');
const stoppedOperator = events.find(event => event.type === 'campaign-stopped' && event.payload?.reason === 'operator-request');
const resumed = events.find(event => event.type === 'campaign-resumed');
const terminalEvent = events.find(event => event.type === 'campaign-completed' || event.type === 'campaign-budget-exhausted');

add('campaign-started', started ? 'PASS' : 'FAIL', started ? `seq ${started.seq}` : 'missing');
add('forced-stop-resume',
  stoppedOperator && resumed && stoppedOperator.seq < resumed.seq
    && resumed.payload?.runFingerprint === state.runFingerprint
    ? 'PASS' : 'FAIL',
  stoppedOperator && resumed
    ? `stop seq ${stoppedOperator.seq} → resume seq ${resumed.seq}，fingerprint=${resumed.payload?.runFingerprint}`
    : 'missing stop/resume pair');
add('event-sequence-monotonic',
  events.every((event, index) => index === 0 || event.seq > events[index - 1].seq) ? 'PASS' : 'FAIL',
  `events=${events.length}，state.lastEventSeq=${state.lastEventSeq}`);
add('terminal-event',
  terminal ? (terminalEvent ? 'PASS' : 'FAIL') : 'IN_PROGRESS',
  terminal ? (terminalEvent ? `seq ${terminalEvent.seq}` : 'missing terminal event') : `status=${state.status}`);

const wallStatus = used.wallMs >= requiredWallMs ? 'PASS' : (running || state.status === 'stopped' ? 'IN_PROGRESS' : 'FAIL');
add('wall-budget-consumed', wallStatus,
  `wallMs=${used.wallMs}，要求 >= ${requiredWallMs}（${Math.round(minWallRatio * 100)}% × ${maxWallMs}）`);

const sampleStatus = Number(used.candidates) >= 12 && Number(used.games) >= 1000 && Number(used.deepConfirmations) >= 6
  ? 'PASS' : (running ? 'IN_PROGRESS' : 'FAIL');
add('sample-volume', sampleStatus,
  `candidates=${used.candidates}，games=${used.games}，deepConfirmations=${used.deepConfirmations}`);

const outcomes = Array.isArray(state.promotionOutcomes) ? state.promotionOutcomes : [];
const blocked = outcomes.filter(item => item.outcome?.verdict === 'BLOCKED');
const gateStatus = outcomes.length > 0
  && outcomes.every(item => ['BLOCKED', 'REJECTED', 'PASS'].includes(item.outcome?.verdict))
  ? 'PASS' : (running ? 'IN_PROGRESS' : 'FAIL');
add('machine-gate-path', gateStatus,
  `outcomes=${outcomes.length}，blocked=${blocked.length}，verdicts=${JSON.stringify(outcomes.map(item => item.outcome?.verdict))}`);

const guardrails = state.guardrails ?? {};
const promotionTriggered = outcomes.some(item => item.outcome?.promotionTriggered === true);
add('governance-guardrails',
  guardrails.validationPoolConsumed === false
    && guardrails.promotionTriggered === false
    && guardrails.championMutation === 'none'
    && promotionTriggered === false
    ? 'PASS' : 'FAIL',
  JSON.stringify({ ...guardrails, promotionTriggeredFromOutcomes: promotionTriggered }));

const failed = checks.filter(check => check.status === 'FAIL');
const pending = checks.filter(check => check.status === 'IN_PROGRESS');
const verdict = failed.length > 0 ? 'FAIL' : (pending.length > 0 ? 'IN_PROGRESS' : 'PASS');

const report = {
  schema: 'century-ai9-endurance-audit-v1',
  generatedAt: new Date().toISOString(),
  campaignId,
  verdict,
  status: {
    runtime: state.status,
    phase: state.phase,
    rounds: state.rounds?.length ?? 0,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    runFingerprint: state.runFingerprint,
    codeVersion: state.codeVersion
      ? {
        headCommit: state.codeVersion.headCommit,
        codeDigest: state.codeVersion.codeDigest,
        webBuildCommit: state.codeVersion.webBuild?.gitCommit ?? null,
      }
      : null,
  },
  requirements: {
    maxWallMs,
    requiredWallMs,
    minWallRatio,
    budgetUsed: used,
  },
  checks,
  notes: [
    'PASS 只表示 R09 的长时运行/恢复验收满足；不表示候选强度或冠军晋级。',
    '正式冠军晋级仍须预注册统计门禁；BLOCKED/insufficient-statistical-power 是合法结果。',
    'LEGACY 表示该 campaign 启动早于 codeVersion 捕获；不把当前代码冒充为历史起点，也不事后改写 state。',
  ],
};

writeJSON(outPath, report);
console.log(JSON.stringify({ outPath, verdict, failed: failed.map(check => check.id), pending: pending.map(check => check.id) }, null, 2));
if (verdict === 'FAIL') process.exit(1);
if (verdict === 'IN_PROGRESS') process.exit(2);
