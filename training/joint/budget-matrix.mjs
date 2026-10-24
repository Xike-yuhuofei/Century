/** 搜索预算矩阵编排器（AI6 第六阶段·任务 B）。
 *
 * 两种比较严格分开（任务书 B2），全部共享同一套种子实现完全配对：
 * - 比较一（同算法预算阶梯）：JS5@50 vs JS5@100 vs JS5@200 vs JS5@500 vs JS5@1000
 *   ——同一 JS5 冻结算法，仅预算不同；
 * - 比较二（同预算算法对照）：JS6@X vs JS5@X（X ∈ {100, 500, 1000}）
 *   ——JS6 = joint-js6（racing + claimFocus），JS5 = joint-js5；
 * - 参考比较（对实战版本）：JS6@500 vs JS5@100 从上述格子直接读出。
 *
 * 种子纪律（AI6_PHASE6_BUDGET_SUBBLOCK [1.372e9,1.382e9)）：
 * seedBase = 1.372e9 + (人数−2)×2e6；每个 (候选, 预算, 人数) 格子用
 * [seedBase, seedBase+seeds) 同一段种子——同人数全部格子共享种子
 * （配对设计：预算/算法是同一随机牌局上的不同"处理"）；
 * 不同人数绝不共享种子。消费的唯一种子 = 4 人数 × seeds。
 *
 * 公平性（任务书 B3）：
 * - 每格子报告记录 codeCommit（进程启动时）、engineBundleSha256、延迟摘要、
 *   jointSearch 实际模拟统计（duel.mjs 内建）；
 * - 编排器记录机器信息与并发度；并发 worker 数默认 = 4（每人数一路），
 *   全程固定——负载剖面写入报告；
 * - 断言：同人数全部格子 seeds/座位协议一致（compare.mjs 校验兜底）。
 *
 * 用法：node training/joint/budget-matrix.mjs [--seeds 100] [--players 2,3,4,5]
 *        [--budgets 50,100,200,500,1000] [--js6-budgets 100,500,1000] [--workers 4]
 * 输出：training/reports/phase6-task-b/<players>p/<tag>.json（duel ablation 格式）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch, cpus, totalmem } from 'node:os';
import { REPO_ROOT } from '../lib/paths.mjs';
import { AI6_PHASE6_BUDGET_SUBBLOCK } from '../../ai5/lib/seed_policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = {
    seeds: 100, players: [2, 3, 4, 5],
    budgets: [50, 100, 200, 500, 1000],
    js6Budgets: [100, 500, 1000],
    workers: 4, outDir: resolve(REPO_ROOT, 'training/reports/phase6-task-b'),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--budgets') args.budgets = argv[++i].split(',').map(Number);
    else if (argv[i] === '--js6-budgets') args.js6Budgets = argv[++i].split(',').map(Number).filter(x => x > 0);
    else if (argv[i] === '--workers') args.workers = Number(argv[++i]);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

/** 构建 (budget × players × candidate) 格子队列：预算优先分组——并发 worker
 * 认领的不同格子尽量是不同人数（跨人数比较相互独立），同 (预算,人数) 的
 * js5/js6 对照对相邻但不并发（同预算算法对照的负载条件尽量接近）。 */
function buildCells(args) {
  const cells = [];
  for (const budget of args.budgets) {
    for (const players of args.players) {
      cells.push({ players, budget, candidate: 'js5', label: `js5-${budget}ms` });
      if (args.js6Budgets.includes(budget)) {
        cells.push({ players, budget, candidate: 'js6', label: `js6-${budget}ms` });
      }
    }
  }
  return cells;
}

function runCell(cell, args) {
  const [blockStart] = AI6_PHASE6_BUDGET_SUBBLOCK;
  const seedBase = blockStart + (cell.players - 2) * 2_000_000;
  // 每格独立子目录（duel --out 只接受目录、文件名固定为
  // ablation-<block>-<candidates>-<players>-<seeds>s.json——同 (人数,候选)
  // 不同预算的格子若共用目录会同名互相覆盖，第五阶段已有同款教训）。
  const outDir = resolve(args.outDir, `${cell.players}p`, `b${cell.budget}ms`);
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `ablation-phase6-budget-${cell.candidate}-${cell.players}-${args.seeds}s.json`);
  const cmdArgs = [
    'training/joint/duel.mjs',
    '--candidates', cell.candidate,
    '--players', String(cell.players),
    '--seeds', String(args.seeds),
    '--block', 'phase6-budget',
    '--seed-base', String(seedBase),
    '--budget', String(cell.budget),
    '--pool', 'classic',
    '--out', outDir,
  ];
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const p = spawn('node', cmdArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', code => {
      if (code !== 0) rej(new Error(`cell ${cell.label} ${cell.players}p 失败（exit ${code}）：${stderr.slice(-400)}`));
      else res({ cell, out, wallMs: Date.now() - t0, stdout: stdout.trim().split('\n').slice(-2).join(' | ') });
    });
  });
}

async function main() {
  const args = parseArgs();
  const [blockStart, blockEnd] = AI6_PHASE6_BUDGET_SUBBLOCK;
  const maxSeed = blockStart + 2_000_000 + args.seeds; // 5p 分区顶
  if (maxSeed > blockEnd) throw new Error(`种子越界：${maxSeed} ≥ ${blockEnd}`);
  const cells = buildCells(args);
  const machine = {
    platform: platform(), arch: arch(), cpus: cpus().length, cpuModel: cpus()[0]?.model,
    totalMemGB: Number((totalmem() / 2 ** 30).toFixed(1)), nodeVersion: process.version,
    concurrency: args.workers, note: '每人数一路 worker（并发度 = workers）；墙钟预算结果的负载剖面依赖本并发度',
  };
  console.log(`预算矩阵：${cells.length} 格子｜seeds=${args.seeds}｜并发=${args.workers}`);
  console.log(`机器：${machine.cpuModel} × ${machine.cpus}｜${machine.totalMemGB}GB｜node ${machine.nodeVersion}`);
  const results = [];
  // 共享队列：N 个 worker 按序认领格子（同人数格子的墙钟负载由并发度决定，
  // 记录于 machine.concurrency；跨人数不共享 CPU 时段时负载剖面仍可披露）。
  let next = 0;
  const worker = async () => {
    while (next < cells.length) {
      const cell = cells[next++];
      process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] 开始 ${cell.label} ${cell.players}p\n`);
      try {
        const r = await runCell(cell, args);
        results.push(r);
        console.log(`[${new Date().toISOString().slice(11, 19)}] 完成 ${cell.label} ${cell.players}p（${Math.round(r.wallMs / 1000)}s）${r.stdout}`);
      } catch (e) {
        console.error(String(e));
        results.push({ cell, error: String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(args.workers, cells.length)) }, worker));
  const manifest = {
    schema: 'century-budget-matrix-manifest-v1', date: new Date().toISOString(),
    machine, seeds: args.seeds, budgets: args.budgets, js6Budgets: args.js6Budgets,
    seedPartition: { block: AI6_PHASE6_BUDGET_SUBBLOCK, perPlayers: 'seedBase = 1.372e9 + (人数−2)×2e6；同人数全部预算/算法格子共享同段种子（完全配对）' },
    cells: results.map(r => ({ ...r.cell, out: r.out, wallMs: r.wallMs, summary: r.stdout, error: r.error })),
  };
  writeFileSync(resolve(args.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`清单已写入：${resolve(args.outDir, 'manifest.json')}`);
  if (results.some(r => r.error)) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
