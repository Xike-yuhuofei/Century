#!/usr/bin/env node
/** 搜索预算比较接口（战术基准专用）。
 *
 * 对同一基准局面以多档 JS5 搜索预算（workUnits 固定工作量口径，逐位可复现；
 * 也可选 budgetMs 墙钟口径做参照）重放决策，披露：各档建议行动、行动是否随
 * 预算收敛、耗时剖面。这是"不同搜索预算的比较接口"，不判定对错。
 *
 * 用法：node scripts/compare-budgets.mjs --id TS-5P-CON-001 [--budgets 16,64,128,256]
 *      [--budget-ms 100] [--first 5] [--in data/scenarios.jsonl] [--out result.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chooseJointAction } from '../../../web-v1/dist/js/js/adapter.js';
import { seatProfile } from '../lib/versions.mjs';
import { actionKey } from '../lib/classify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_IN = join(HERE, '..', 'data', 'scenarios.jsonl');

function parseArgs(argv) {
  const args = { id: null, first: null, budgets: '16,64,128,256', budgetMs: null, in: DEFAULT_IN, out: null };
  const numbers = new Set(['first', 'budgetMs']);
  const values = { '--id': 'id', '--first': 'first', '--budgets': 'budgets', '--budget-ms': 'budgetMs', '--in': 'in', '--out': 'out' };
  for (let i = 2; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    if (argv[i].startsWith('--') && eq > 0) {
      const key = values[argv[i].slice(0, eq)];
      if (!key) throw new Error(`未知参数：${argv[i]}`);
      args[key] = numbers.has(key) ? Number(argv[i].slice(eq + 1)) : argv[i].slice(eq + 1);
    } else if (values[argv[i]]) {
      const key = values[argv[i]];
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${argv[i]} 缺值`);
      args[key] = numbers.has(key) ? Number(v) : v;
    } else throw new Error(`未知参数：${argv[i]}`);
  }
  if (typeof args.in === 'string') args.in = resolve(process.cwd(), args.in);
  if (typeof args.out === 'string') args.out = resolve(process.cwd(), args.out);
  return args;
}

const args = parseArgs(process.argv);
const budgets = args.budgets.split(',').map(Number).filter(Number.isSafeInteger);
if (budgets.length === 0) throw new Error('--budgets 至少一档');

const lines = readFileSync(args.in, 'utf8').split('\n').filter(Boolean);
const scenarios = lines.map(l => JSON.parse(l))
  .filter(s => (args.id ? s.id === args.id : true))
  .slice(0, args.first ?? Infinity);
if (scenarios.length === 0) throw new Error(`未找到局面（id=${args.id ?? '全部'}）`);

const report = {
  generatedAt: new Date().toISOString(),
  budgets,
  budgetMsReference: args.budgetMs,
  scenarios: [],
};

for (const scenario of scenarios) {
  const position = scenario.engineState.position;
  const game = structuredClone(position);
  for (const p of game.players) p.isAI = true;
  if (game.phase !== 'turn') throw new Error(`${scenario.id} 阶段 ${game.phase} 不支持决策`);
  const profile = seatProfile(game.current);

  const runs = [];
  for (const wu of budgets) {
    const t0 = performance.now();
    const d = chooseJointAction(game, { version: 'joint-js5', workUnits: wu, worlds: 4, simSeed: 0, profile });
    runs.push({ workUnits: wu, action: d.action, actionKey: actionKey(d.action), reason: d.reason, ms: Number((performance.now() - t0).toFixed(1)) });
  }
  if (args.budgetMs) {
    const t0 = performance.now();
    const d = chooseJointAction(game, { version: 'joint-js5', budgetMs: args.budgetMs, profile });
    runs.push({ budgetMs: args.budgetMs, action: d.action, actionKey: actionKey(d.action), reason: d.reason, ms: Number((performance.now() - t0).toFixed(1)), note: '墙钟口径：结果受机器负载影响，不保证逐位复现' });
  }
  const uniqueKeys = [...new Set(runs.map(r => r.actionKey))];
  report.scenarios.push({
    id: scenario.id,
    recordedBaseline: scenario.decisions['js5-w128']?.actionKey ?? null,
    runs,
    converged: uniqueKeys.length === 1,
    uniqueActionKeys: uniqueKeys,
  });
  const line = report.scenarios.at(-1);
  console.error(`[compare] ${scenario.id}: ${line.converged ? `全预算一致（${line.uniqueActionKeys[0]}）` : `随预算变动：${line.uniqueActionKeys.join(' | ')}`}（基线 ${line.recordedBaseline ?? '—'}）`);
}

if (args.out) {
  writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
  console.error(`[compare] 已写出 ${args.out}`);
} else {
  console.log(JSON.stringify(report, null, 2)); // stdout 只含 JSON（机器可读；日志走 stderr）
}
