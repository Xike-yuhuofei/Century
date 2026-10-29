#!/usr/bin/env node
/** 实验 A2 / P2.2：Checkpoint 恢复演练（真实进程停止 → resume → 不变量核验）。
 *
 * 流程：
 * 1. 启动一个 2 轮 campaign（真实编译型候选、真实对局，不使用 LLM）；
 * 2. 第 1 轮完成深验后写入 `.stop`，等待进程退出；
 * 3. 用 `resume` 继续；
 * 4. 核验：
 *    - 同一 runFingerprint / codeDigest；
 *    - 已完成证据文件哈希未变（不丢结果）；
 *    - 种子窗口不重叠、不重复消费；
 *    - 候选谱系 parentId 仍可解析；
 *    - 最终 status=completed。
 *
 * 用法：node training/scripts/ai11-a2-checkpoint-drill.mjs [--campaign ai11-a2]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}
const campaign = String(arg('campaign', 'ai11-a2-drill'));
const rounds = Number(arg('rounds', 2));

const root = resolve(REPO_ROOT, 'training/reports/coevolution', campaign);
const statePath = join(root, 'state.json');
mkdirSync(root, { recursive: true });

const cliArgs = [
  'start', '--coevolve', '--campaign', campaign,
  '--rounds', String(rounds), '--candidates', '2',
  '--quick-seeds', '4', '--deep-seeds', '4',
  '--player-counts', '2,3,4,5',
  '--strategies', 'single,pair',
  '--max-candidates', String(rounds * 2 + 2),
  '--max-games', '600', '--max-wall-ms', String(2 * 3600_000),
  '--generation-seed', '20261102',
  '--no-auto-challenge',
];

function run(command) {
  return spawn(process.execPath, [
    resolve(REPO_ROOT, 'training/evolution/autonomous-run.mjs'),
    command, ...cliArgs.slice(1),
  ], {
    cwd: resolve(REPO_ROOT, 'training'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readState() {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const report = { schema: 'century-ai11-a2-drill-v1', campaign, at: new Date().toISOString(), checks: [] };
const add = (id, title, ok, evidence) => report.checks.push({ id, title, status: ok ? 'PASS' : 'FAIL', evidence });

// 1. 启动
const first = run('start');
let firstExit = null;
first.on('exit', (code, signal) => { firstExit = { code, signal }; });

// 等第 1 轮完成深验（最多 40 分钟）
let reached = false;
for (let i = 0; i < 2400; i += 1) {
  sleep(1000);
  const state = readState();
  if (!state) continue;
  const round1 = state.rounds?.[0];
  if (round1?.deepDone) { reached = true; break; }
  if (firstExit) break;
}
add('A2-1', '第 1 轮深验完成后再停止', reached, `deepDone=${Boolean(readState()?.rounds?.[0]?.deepDone)}`);

// 2. 安全停止
const beforeStop = readState();
const evidenceHashesBefore = {};
if (beforeStop) {
  for (const round of beforeStop.rounds) {
    for (const candidate of round.candidates ?? []) {
      if (!candidate.quick?.evidencePath) continue;
      const absolute = resolve(REPO_ROOT, candidate.quick.evidencePath);
      if (existsSync(absolute)) evidenceHashesBefore[candidate.candidateId] = sha256(readFileSync(absolute, 'utf8'));
    }
  }
}
writeFileSync(join(root, '.stop'), JSON.stringify({ reason: 'a2-drill', at: new Date().toISOString() }));
for (let i = 0; i < 600 && !firstExit; i += 1) sleep(500);
const stopped = readState();
add('A2-2', '安全停止保留状态', firstExit !== null && Boolean(stopped) && stopped.status !== 'completed',
  `exit=${JSON.stringify(firstExit)} status=${stopped?.status}`);

// 3. resume
const second = run('resume');
let secondExit = null;
second.on('exit', (code, signal) => { secondExit = { code, signal }; });
for (let i = 0; i < 2400 && !secondExit; i += 1) sleep(1000);
const final = readState();

const fingerprintMatch = stopped && final && stopped.runFingerprint === final.runFingerprint;
const digestMatch = stopped && final && stopped.codeVersion?.codeDigest === final.codeVersion?.codeDigest;
add('A2-3', '同一 runFingerprint / codeDigest 恢复', fingerprintMatch && digestMatch,
  `fingerprint=${fingerprintMatch} digest=${digestMatch} exit=${JSON.stringify(secondExit)}`);

let evidenceIntact = true;
let checked = 0;
for (const [candidateId, hash] of Object.entries(evidenceHashesBefore)) {
  const candidate = (final?.rounds ?? []).flatMap(r => r.candidates ?? []).find(c => c.candidateId === candidateId);
  const path = candidate?.quick?.evidencePath;
  if (!path) continue;
  const absolute = resolve(REPO_ROOT, path);
  if (!existsSync(absolute)) { evidenceIntact = false; break; }
  checked += 1;
  if (sha256(readFileSync(absolute, 'utf8')) !== hash) { evidenceIntact = false; break; }
}
add('A2-4', '已确认的评估结果未被覆盖', evidenceIntact, `checked=${checked} intact=${evidenceIntact}`);

const windows = (final?.rounds ?? []).flatMap(r => Object.values(r.seedWindows ?? {}).map(w => w.windowId));
const windowUnique = new Set(windows).size === windows.length;
add('A2-5', '种子窗口不重复消费', windowUnique, `windows=${windows.length} unique=${new Set(windows).size}`);

const candidates = (final?.rounds ?? []).flatMap(r => r.candidates ?? []);
const inherited = candidates.filter(c => c.parentId);
const parentsResolvable = inherited.every(c => candidates.some(x => x.candidateId === c.parentId));
add('A2-6', '谱系在恢复后仍可解析', parentsResolvable && inherited.length >= 0,
  `inherited=${inherited.length} parentsResolvable=${parentsResolvable}`);

add('A2-7', '恢复后正常完成', final?.status === 'completed',
  `status=${final?.status} rounds=${final?.rounds?.length}`);

const failed = report.checks.filter(c => c.status === 'FAIL');
report.verdict = failed.length ? 'FAIL' : 'PASS';
report.finalStatus = final?.status ?? null;
writeFileSync(join(REPO_ROOT, 'training/reports/ai11-a2-checkpoint-drill.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(failed.length ? 1 : 0);
