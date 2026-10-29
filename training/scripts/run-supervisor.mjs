#!/usr/bin/env node
/** P2.1：无人工值守监督器（与 CampaignController / OpenEvolve 协同）。
 *
 * 能力：
 * - 自动启动 / 自动恢复（start → resume）；
 * - 心跳（state.json / events.jsonl 推进）与卡死检测（默认 20 分钟无推进）；
 * - 进程树清理（SIGTERM → 30s → SIGKILL）；
 * - 有界重试 + 指数退避；连续失败熔断（不无限重试掩盖错误）；
 * - 模型故障转移：连续 LLM/OpenEvolve 失败后切换到保守配置（单模型 + 更长超时）；
 * - 资源监控（内存/磁盘/负载），不足时等待而不是硬跑；
 * - 安全停止（`.stop` 标记）与运行报告；
 * - 持久任务队列（PENDING→…→DONE）+ 幂等提交 + 种子预留审计。
 *
 * 用法：
 *   node training/scripts/run-supervisor.mjs \
 *     --campaign ai11-6h --hours 6 --candidates 7 --quick-seeds 3 --deep-seeds 4
 *
 * 说明：macOS LaunchAgent 无法访问外置卷（历史已证实 getcwd EPERM），因此以
 * Node 监督器 + caffeinate 常驻；launchd 安装脚本可选且默认不启用。
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { openTaskQueue } from '../evolution/task-queue.mjs';
import { evaluateCapacity, resourceSnapshot } from '../lib/resource-scheduler.mjs';
import { sha256Canonical } from '../evolution/core.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const campaign = String(arg('campaign', `ai11-${Date.now()}`));
const hours = Number(arg('hours', 6));
const stallMinutes = Number(arg('stall-minutes', 20));
const maxFailures = Number(arg('max-failures', 6));
const pollSeconds = Number(arg('poll-seconds', 15));
const stage2Seeds = arg('stage2-seeds', null);
const stage3Seeds = arg('stage3-seeds', null);
const campaignRoot = resolve(REPO_ROOT, 'training/reports/coevolution', campaign);
const queueRoot = join(campaignRoot, 'queue');
const reportPath = join(campaignRoot, 'supervisor-report.json');
const heartbeatPath = join(campaignRoot, 'supervisor-heartbeat.json');
const logPath = join(campaignRoot, 'supervisor.log');

mkdirSync(campaignRoot, { recursive: true });
mkdirSync(queueRoot, { recursive: true });
const queue = openTaskQueue({ rootDir: queueRoot });

const startedAt = Date.now();
const deadline = startedAt + hours * 3600_000;
const statePath = join(campaignRoot, 'state.json');
const eventsPath = join(campaignRoot, 'logs', 'events.jsonl');

const report = {
  schema: 'century-supervisor-report-v1',
  openEvolveStageSeeds: {
    stage2: stage2Seeds === null ? 16 : Number(stage2Seeds),
    stage3: stage3Seeds === null ? 48 : Number(stage3Seeds),
    note: '仅在无人值守运行中缩小研究评估规模；正式验证完全不使用这些数量',
  },
  campaign,
  startedAt: new Date(startedAt).toISOString(),
  plannedHours: hours,
  stallMinutes,
  maxFailures,
  pollSeconds,
  runs: [],
  failures: [],
  recoveries: [],
  resourceSamples: [],
  modelFailover: [],
  stopReason: null,
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  writeFileSync(logPath, line, { flag: 'a' });
  process.stdout.write(line);
}

function writeHeartbeat(extra = {}) {
  writeFileSync(heartbeatPath, JSON.stringify({
    pid: process.pid,
    campaign,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    ...extra,
  }, null, 2));
}

function progressMtime() {
  let latest = 0;
  for (const path of [statePath, eventsPath]) {
    if (existsSync(path)) latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
}

function campaignStatus() {
  if (!existsSync(statePath)) return 'missing';
  try { return JSON.parse(readFileSync(statePath, 'utf8')).status; } catch { return 'unreadable'; }
}

function killTree(pid, signal) {
  try {
    const children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n').map(Number).filter(Boolean);
    for (const child of children) killTree(child, signal);
  } catch { /* 没有子进程 */ }
  try { process.kill(pid, signal); } catch { /* 已退出 */ }
}

/** 后代进程累计 CPU 时间（秒）：长耗时评估期间用它判断"仍在工作"而非卡死。 */
function descendantCpuSeconds(rootPid) {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid,ppid,time'], { encoding: 'utf8' });
    const rows = out.trim().split('\n').slice(1).map((line) => {
      const cols = line.trim().split(/\s+/);
      return { pid: Number(cols[0]), ppid: Number(cols[1]), time: cols[2] };
    });
    const childrenOf = new Map();
    for (const row of rows) {
      if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
      childrenOf.get(row.ppid).push(row);
    }
    let total = 0;
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop();
      for (const child of childrenOf.get(pid) ?? []) {
        const [h, m, s] = String(child.time).split(':');
        const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s.split('.')[0]);
        if (Number.isFinite(seconds)) total += seconds;
        stack.push(child.pid);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function boundedBackoff(attempt) {
  return Math.min(240_000, 15_000 * 2 ** Math.max(0, attempt - 1));
}

function forwardArgs() {
  const forwarded = [];
  const keys = [
    'rounds', 'candidates', 'player-counts', 'quick-seeds', 'deep-seeds', 'deep-confirmations',
    'max-deep-confirmations', 'modules', 'strategies', 'openevolve-iterations', 'generation-seed',
    'max-candidates', 'max-games', 'max-wall-ms', 'max-concurrent', 'targets',
    'openevolve-config', 'on-llm-unavailable', 'no-control', 'no-auto-challenge',
  ];
  for (const key of keys) {
    const index = args.indexOf(`--${key}`);
    if (index < 0) continue;
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) forwarded.push(`--${key}`);
    else forwarded.push(`--${key}`, next);
  }
  return forwarded;
}

/** 生成保守故障转移配置（只换模型与超时，不改评估/安全纪律）。 */
function ensureFallbackConfig() {
  const fallbackPath = resolve(REPO_ROOT, 'ai5/openevolve/config-ai9-fallback.yaml');
  if (existsSync(fallbackPath)) return fallbackPath;
  const base = readFileSync(resolve(REPO_ROOT, 'ai5/openevolve/config-ai9.yaml'), 'utf8');
  const text = base
    .replace(/  models:\n(?:    - name:[\s\S]*?)(?=\n  temperature:)/,
      '  models:\n    - name: "gpt-5.6-terra"\n      weight: 1.0\n      timeout: 1200\n      reasoning_effort: "low"\n')
    .replace('max_iterations: 6', 'max_iterations: 4');
  writeFileSync(fallbackPath, text);
  return fallbackPath;
}

async function runOnce({ attempt, useFallback }) {
  const resume = existsSync(statePath);
  const command = resume ? 'resume' : 'start';
  const queueTask = queue.enqueue({
    kind: 'campaign-run',
    payload: { campaign, command, attempt, fallback: useFallback },
    dedupeKey: `${campaign}:run:${attempt}`,
    maxAttempts: maxFailures,
  }).task;
  queue.claim({ taskId: queueTask.taskId, pid: process.pid });
  queue.start({ taskId: queueTask.taskId, pid: process.pid });

  const forwarded = forwardArgs();
  if (useFallback) forwarded.push('--openevolve-config', 'ai5/openevolve/config-ai9-fallback.yaml');
  const childArgs = [
    resolve(REPO_ROOT, 'training/evolution/autonomous-run.mjs'),
    command, '--coevolve', '--campaign', campaign,
    ...forwarded,
  ];
  const child = spawn(process.execPath, childArgs, {
    cwd: resolve(REPO_ROOT, 'training'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CENTURY_SUPERVISOR: '1',
      ...(stage2Seeds !== null ? { CENTURY_OPENEVOLVE_STAGE2_SEEDS: String(stage2Seeds) } : {}),
      ...(stage3Seeds !== null ? { CENTURY_OPENEVOLVE_STAGE3_SEEDS: String(stage3Seeds) } : {}),
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-20000); });
  child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-20000); });

  const runRecord = {
    attempt, command, pid: child.pid, startedAt: new Date().toISOString(),
    fallback: useFallback, taskId: queueTask.taskId,
  };
  report.runs.push(runRecord);
  log(`run ${attempt} started pid=${child.pid} command=${command} fallback=${useFallback}`);

  const lastProgress = { value: progressMtime() };
  let lastChildCpu = descendantCpuSeconds(child.pid);
  let stalled = false;
  const exit = await new Promise(resolveExit => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (now >= deadline) {
        if (!report.stopReason) {
          report.stopReason = 'supervisor-deadline';
          log('deadline reached; requesting safe stop');
          writeFileSync(join(campaignRoot, '.stop'), JSON.stringify({ reason: 'supervisor-deadline', at: new Date(now).toISOString() }));
        }
        // 安全停止最多等 15 分钟；仍不退出则强制结束进程树，避免监督器被卡死任务拖住。
        if (now >= deadline + 15 * 60_000) {
          log('safe stop timeout; force killing process tree');
          killTree(child.pid, 'SIGTERM');
          setTimeout(() => killTree(child.pid, 'SIGKILL'), 30_000);
          clearInterval(timer);
          resolveExit({ code: null, signal: 'SIGKILL', stalled: true });
        }
      }
      if (existsSync(join(campaignRoot, '.stop')) && !report.stopReason) {
        report.stopReason = 'operator-or-deadline';
        log('stop marker observed; waiting for graceful exit');
      }
      const mtime = progressMtime();
      if (mtime > lastProgress.value) lastProgress.value = mtime;
      // 长耗时评估（OpenEvolve 级联真实对局）不会推进 state.json，
      // 但后代进程仍在消耗 CPU：视为有效工作，避免把正常长任务误杀。
      const childCpu = descendantCpuSeconds(child.pid);
      if (childCpu > lastChildCpu + 0.5) {
        lastChildCpu = childCpu;
        lastProgress.value = Date.now();
      }
      writeHeartbeat({
        childPid: child.pid,
        idleSeconds: Math.floor((Date.now() - lastProgress.value) / 1000),
        campaignStatus: campaignStatus(),
      });
      if (Date.now() - lastProgress.value > stallMinutes * 60_000) {
        stalled = true;
        log(`stall detected: no progress for ${stallMinutes} 分钟；kill process tree pid=${child.pid}`);
        killTree(child.pid, 'SIGTERM');
        setTimeout(() => killTree(child.pid, 'SIGKILL'), 30_000);
        clearInterval(timer);
        resolveExit({ code: null, signal: 'SIGTERM', stalled: true });
      }
    }, pollSeconds * 1000);
    child.on('exit', (code, signal) => {
      clearInterval(timer);
      resolveExit({ code, signal, stalled: false });
    });
  });

  runRecord.endedAt = new Date().toISOString();
  runRecord.code = exit.code;
  runRecord.signal = exit.signal;
  runRecord.stalled = exit.stalled;

  if (exit.stalled) {
    queue.fail({ taskId: queueTask.taskId, error: 'stalled', retry: true });
    report.recoveries.push({ at: new Date().toISOString(), attempt, action: 'kill-and-resume' });
    return { ok: false, stalled: true, output };
  }
  const status = campaignStatus();
  if (exit.code === 0 && ['completed', 'budget-exhausted', 'stopped', 'running'].includes(status)) {
    queue.commit({
      taskId: queueTask.taskId,
      commitKey: `campaign-run:${campaign}:${attempt}`,
      result: { status },
    });
    return { ok: true, terminal: ['completed', 'budget-exhausted'].includes(status), status, output };
  }
  queue.fail({ taskId: queueTask.taskId, error: `exit=${exit.code} signal=${exit.signal} status=${status}`, retry: true });
  return { ok: false, terminal: false, status, output };
}

log(`supervisor start campaign=${campaign} hours=${hours} stall=${stallMinutes}m maxFailures=${maxFailures}`);
let attempt = 0;
let consecutiveFailures = 0;
let terminal = false;

while (Date.now() < deadline && !terminal) {
  attempt += 1;
  // 资源检查：不足时等待，不硬跑（避免 OOM/磁盘写满导致状态损坏）。
  const capacity = evaluateCapacity({ requestedConcurrency: 1 });
  report.resourceSamples.push({ at: new Date().toISOString(), ok: capacity.ok, snapshot: resourceSnapshot() });
  if (!capacity.ok) {
    log(`resource blocked: ${capacity.reasons.join('; ')} — 等待 120s`);
    await new Promise(r => setTimeout(r, 120_000));
    continue;
  }
  const useFallback = consecutiveFailures >= 2;
  if (useFallback && !report.modelFailover.length) {
    const config = ensureFallbackConfig();
    report.modelFailover.push({ at: new Date().toISOString(), reason: 'consecutive LLM/run failures', config });
    log(`model failover engaged → ${config}`);
  }
  const result = await runOnce({ attempt, useFallback });
  if (result.ok) {
    consecutiveFailures = 0;
    if (result.terminal) { terminal = true; log(`terminal state=${result.status}`); break; }
    continue;
  }
  consecutiveFailures += 1;
  const llmHint = /OpenEvolve|LLM|codex|quota|429/i.test(result.output ?? '');
  report.failures.push({
    at: new Date().toISOString(), attempt, stalled: Boolean(result.stalled),
    code: result.status ?? null, llmHint,
  });
  if (consecutiveFailures >= maxFailures) {
    report.stopReason = 'circuit-breaker';
    log(`circuit breaker: ${consecutiveFailures} 连续失败，停止（不无限重试）`);
    break;
  }
  const delay = boundedBackoff(consecutiveFailures);
  log(`retry in ${delay / 1000}s (attempt ${attempt})`);
  await new Promise(r => setTimeout(r, delay));
}

// 结束：写最终报告（不清除控制器自己的停止标记语义）。
report.endedAt = new Date().toISOString();
report.actualHours = Number(((Date.parse(report.endedAt) - startedAt) / 3600_000).toFixed(3));
report.queue = queue.snapshot();
report.recoveredTasks = queue.recover();
report.campaignStatus = campaignStatus();
report.eventsBytes = existsSync(eventsPath) ? statSync(eventsPath).size : 0;
report.eventsSha256 = existsSync(eventsPath)
  ? sha256Canonical(readFileSync(eventsPath, 'utf8').slice(-10000)) : null;
report.finalState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).status ?? null : null;
writeFileSync(reportPath, JSON.stringify(report, null, 2));
log(`supervisor end status=${report.finalState} hours=${report.actualHours} failures=${report.failures.length}`);
process.exit(report.stopReason === 'circuit-breaker' ? 1 : 0);
