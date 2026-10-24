/** JS6 机制单因子筛查编排器（AI6 第六阶段·任务 C1/C3/D1/D3）。
 *
 * 纪律（任务书 §八 研发方法）：单因子实验 → 确认决策影响 → 局面级正确性
 * → 小规模独立配对 → 真实第一名率验证 → 只合并可靠正向证据。
 * 本工具执行第一步（胜率筛查）：每个因子 = 一个 duel 消融 cell，与同种子
 * 基线（js5 缺省）配对比较；调参块种子，结论仅作筛选信号（不晋级）。
 *
 * 因子集（@500ms 高预算区，5 人局——第五阶段效应最强与门控率最高的人群）：
 * - worlds8 / worlds16（C1 信念世界扩展）；
 * - cap6 / cap8（C3 候选覆盖扩展）；
 * - racing / claimFocus（JS6 两组件单独）；
 * - evaluator L3（D3 叶子评价）；
 * - om-v1（D1 对手建模）；
 * - gate-always（C2 对照：全决策联合评估）。
 *
 * 用法：node training/joint/mechanism-screens.mjs [--seeds 30] [--players 5]
 *        [--budget 500] [--block phase6-tune] [--workers 3]
 * 输出：training/reports/phase6-screens/<tag>.json + 配对比较摘要。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedComparison } from './compare.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const FACTORS = [
  { tag: 'base', flags: [] },
  { tag: 'worlds8', flags: ['--worlds', '8'] },
  { tag: 'worlds16', flags: ['--worlds', '16'] },
  { tag: 'cap6', flags: ['--cap', '6'] },
  { tag: 'cap8', flags: ['--cap', '8'] },
  { tag: 'racing', flags: ['--allocation', 'racing'] },
  { tag: 'claimFocus', flags: ['--endgame', 'claimFocus'] },
  { tag: 'evaluatorL3', flags: ['--evaluator', 'L3'] },
  { tag: 'omV1', flags: ['--opponent-mode', 'om-v1'] },
  { tag: 'gateAlways', flags: ['--gate', 'always'] },
];

function parseArgs() {
  const args = { seeds: 30, players: 5, budget: 500, block: 'phase6-tune', workers: 3, outDir: resolve(REPO_ROOT, 'training/reports/phase6-screens') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--players') args.players = Number(argv[++i]);
    else if (argv[i] === '--budget') args.budget = Number(argv[++i]);
    else if (argv[i] === '--block') args.block = argv[++i];
    else if (argv[i] === '--workers') args.workers = Number(argv[++i]);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

const BLOCK_BASE = { 'phase6-tune': 1_353_000_000, 'phase6-dev': 1_352_000_000, tune: 1_310_000_000 };

function runCell(factor, args) {
  const seedBase = BLOCK_BASE[args.block];
  if (!seedBase) throw new Error(`--block 必须是 ${Object.keys(BLOCK_BASE).join('|')}`);
  // 每因子独立子目录（duel 文件名固定，共用目录会同名互相覆盖）。
  const outDir = resolve(args.outDir, `${args.players}p-b${args.budget}`, factor.tag);
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `ablation-${args.block}-js5-${args.players}-${args.seeds}s.json`);
  const cmdArgs = [
    'training/joint/duel.mjs',
    '--candidates', 'js5',
    '--players', String(args.players),
    '--seeds', String(args.seeds),
    '--block', args.block,
    '--seed-base', String(seedBase),
    '--budget', String(args.budget),
    '--pool', 'classic',
    '--out', outDir,
    ...factor.flags,
  ];
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const p = spawn('node', cmdArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', code => {
      if (code !== 0) rej(new Error(`${factor.tag} 失败（exit ${code}）：${stderr.slice(-300)}`));
      else res({ factor: factor.tag, out, wallMs: Date.now() - t0, stdout: stdout.trim().split('\n').slice(-2).join(' | ') });
    });
  });
}

async function main() {
  const args = parseArgs();
  const players = args.players;
  mkdirSync(args.outDir, { recursive: true });
  console.log(`单因子筛查：${FACTORS.length} 因子｜${players}p @${args.budget}ms｜${args.seeds} 种子｜并发 ${args.workers}`);
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < FACTORS.length) {
      const factor = FACTORS[next++];
      try {
        const r = await runCell(factor, args);
        results.push(r);
        console.log(`完成 ${factor.tag}（${Math.round(r.wallMs / 1000)}s）${r.stdout}`);
      } catch (e) {
        console.error(String(e));
        results.push({ factor: factor.tag, error: String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(args.workers, FACTORS.length)) }, worker));

  // 与 base 配对比较（同种子同池同预算——配对设计）。
  const baseFile = results.find(r => r.factor === 'base')?.out;
  const comparisons = [];
  for (const r of results) {
    if (r.error || r.factor === 'base' || !baseFile) continue;
    try {
      const cmp = pairedComparison(r.out, baseFile, { seatCount: players, iterations: 2000, familySize: FACTORS.length - 1 });
      comparisons.push({
        factor: r.factor,
        directionADiff: cmp.firstPlaceDiff, directionADiffCI: cmp.firstPlaceDiffCI,
        meanScoreDiff: cmp.meanScoreDiff, scoreDiffCI: cmp.meanScoreDiffCI,
        significance: cmp.significance,
        note: '筛查信号（调参块种子 + family=9 Bonferroni）——正向信号须按任务 E 流程在独立验证确认',
      });
    } catch (e) {
      comparisons.push({ factor: r.factor, error: String(e.message).slice(0, 120) });
    }
  }
  const report = {
    schema: 'century-mechanism-screens-v1', date: new Date().toISOString(),
    players, budgetMs: args.budget, seeds: args.seeds, block: args.block,
    comparisons,
    results: results.map(r => ({ factor: r.factor, out: r.out, wallMs: r.wallMs, error: r.error })),
  };
  writeFileSync(resolve(args.outDir, `screens-${players}p-b${args.budget}.json`), JSON.stringify(report, null, 2));
  console.log('\n=== 配对比较（因子 vs 缺省 js5，方向A）===');
  for (const c of comparisons) {
    if (c.error) { console.log(`${c.factor}: ${c.error}`); continue; }
    console.log(`${c.factor.padEnd(12)} ${(c.directionADiff * 100).toFixed(1)}pp [${c.directionADiffCI.map(v => (v * 100).toFixed(1)).join(',')}]｜${c.significance}`);
  }
  console.log(`报告已写入：${resolve(args.outDir, `screens-${players}p-b${args.budget}.json`)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
