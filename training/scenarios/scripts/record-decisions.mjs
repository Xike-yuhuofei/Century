#!/usr/bin/env node
/** 冻结版本建议行动重录 CLI（战术基准专用）。
 *
 * 当冻结版本口径变更（例如 JS5 固定工作量参数调整）时，用本脚本对既有语料
 * 重录 decisions/disagreement/客观约束，其余字段（分类、oracle、provenance）
 * 原样保留；引擎版本演进导致的重录差异属于基准漂移信号，应随 PR 显式评审。
 *
 * 用法：node scripts/record-decisions.mjs [--id TS-5P-CON-001] [--in data/scenarios.jsonl]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { frozenVersions, decideWithVersion, seatProfile } from '../lib/versions.mjs';
import { actionKey, targetClaims } from '../lib/classify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_IN = join(HERE, '..', 'data', 'scenarios.jsonl');

function parseArgs(argv) {
  const args = { id: null, in: DEFAULT_IN, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--id=')) args.id = a.slice(5);
    else if (a === '--id') { /* 下一个参数 */ }
    else if (args.id === null && !a.startsWith('--')) args.id = a;
    else if (a.startsWith('--in=')) args.in = resolve(process.cwd(), a.slice(5));
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

const args = parseArgs(process.argv);
const versions = frozenVersions();
const lines = readFileSync(args.in, 'utf8').split('\n').filter(Boolean);
const out = [];
let updated = 0;

for (const line of lines) {
  const scenario = JSON.parse(line);
  if (args.id && scenario.id !== args.id) { out.push(line); continue; }
  const position = scenario.engineState.position;
  const profile = seatProfile(scenario.currentSeat);
  const decisions = {};
  for (const v of versions) {
    const t0 = performance.now();
    const d = decideWithVersion(position, v, profile);
    decisions[v.key] = {
      label: v.label, options: v.recordedOptions,
      action: d.action, actionKey: actionKey(d.action), reason: d.reason,
      profile: profile.name, ms: Number((performance.now() - t0).toFixed(1)),
    };
  }
  const keys = Object.values(decisions).map(d => d.actionKey);
  const unique = [...new Set(keys)];
  const tally = {};
  for (const k of keys) tally[k] = (tally[k] ?? 0) + 1;
  scenario.decisions = decisions;
  scenario.disagreement = {
    versions: Object.keys(decisions), actionKeys: keys, uniqueActions: unique,
    uniqueCount: unique.length, allAgree: unique.length === 1,
    majorityActionKey: unique.reduce((a, b) => (tally[b] > tally[a] ? b : a)), tally,
  };
  scenario.endgame.targetClaims = targetClaims(scenario.classification.playerCount);
  updated++;
  out.push(JSON.stringify(scenario));
  console.log(`[record] ${scenario.id}: ${scenario.disagreement.allAgree ? '全一致' : `分歧 ${scenario.disagreement.uniqueCount}`}`);
}

if (!args.dryRun) writeFileSync(args.in, out.join('\n') + '\n');
console.log(`[record] ${updated}/${lines.length} 条已${args.dryRun ? '试算（未写盘）' : '重录'} → ${args.in}`);
