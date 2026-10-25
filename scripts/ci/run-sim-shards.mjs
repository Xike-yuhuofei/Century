#!/usr/bin/env node
/** 分片并行执行 PR 模拟评估，合并为一份完整统计。
 *
 * 背景：原 CI 串行执行 100 局（每局约 18s）需约 30 分钟，是 PR 超时的直接原因之一。
 * 本脚本按连续种子区间切成 N 片并行执行，保持"100 局 + 同一批种子"覆盖不变；
 * 任何一片失败/少局都使整体失败，不做近似或缩减。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSimShards } from './lib/sim-shards.mjs';
import { summarizeResults } from '../../training/simulator/simulate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SIM_CLI = resolve(REPO_ROOT, 'training/simulator/cli.mjs');

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`无法识别的参数：${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

function runShard(shard, outDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      SIM_CLI,
      '--games', String(shard.games),
      '--seed-base', String(shard.seedBase),
      '--out', resolve(outDir, `shard-${shard.index}`),
    ], { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('error', rejectPromise);
    child.on('exit', code => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`分片 ${shard.index} 失败（exit=${code}）`));
    });
  });
}

function readResults(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const games = Number(args.games ?? 100);
  const seedBase = Number(args['seed-base'] ?? 1);
  const shards = Number(args.shards ?? 4);
  const maxAnomalyRate = Number(args['max-anomaly-rate'] ?? 0.02);
  const outArg = args.out ?? 'training/reports/pr-eval';
  const outDir = resolve(process.cwd(), outArg);

  const plan = planSimShards({ games, shards, seedBase });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  console.log(`并行模拟：${games} 局 / ${plan.length} 片，种子 [${seedBase}, ${seedBase + games})`);

  const started = performance.now();
  try {
    await Promise.all(plan.map(shard => runShard(shard, outDir)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const combined = [];
  for (const shard of plan) {
    const rows = readResults(resolve(outDir, `shard-${shard.index}/results.jsonl`));
    if (rows.length !== shard.games) {
      console.error(`分片 ${shard.index} 局数不符：期望 ${shard.games}，实际 ${rows.length}`);
      process.exit(1);
    }
    combined.push(...rows);
  }
  const seeds = new Set(combined.map(r => r.seed));
  if (seeds.size !== games) {
    console.error(`种子不唯一：期望 ${games}，实际 ${seeds.size}`);
    process.exit(1);
  }

  writeFileSync(resolve(outDir, 'results.jsonl'), combined.map(r => JSON.stringify(r)).join('\n') + '\n');
  const summary = summarizeResults(combined);
  summary.wallMs = Number((performance.now() - started).toFixed(1));
  summary.config = {
    games,
    seedBase,
    shards: plan.map(s => ({ index: s.index, games: s.games, seedBase: s.seedBase })),
    uniqueSeedCount: seeds.size,
  };
  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const lines = [
    '## PR 模拟评估（分片并行，覆盖不变）',
    '',
    `- 总局数：${summary.totalGames}（完成 ${summary.finishedGames} / 异常 ${summary.anomalyGames}）`,
    `- 唯一种子：${seeds.size}`,
    `- 异常率：${(summary.anomalyRate * 100).toFixed(2)}%（上限 ${(maxAnomalyRate * 100).toFixed(2)}%）`,
    `- 平均步数：${summary.meanMoves}`,
    `- 分片：${plan.map(s => `${s.games}局@${s.seedBase}`).join(' / ')}`,
    '',
  ];
  const markdown = lines.join('\n');
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

  if (summary.anomalyRate > maxAnomalyRate) {
    console.error(`异常率超限：${summary.anomalyRate} > ${maxAnomalyRate}`);
    process.exit(1);
  }
  console.log(`结果目录：${outDir}`);
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
