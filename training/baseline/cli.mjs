/** 基线评测 CLI（AI6 第一阶段：冠军基线冻结 + 多人第一名率基准）。
 *
 * 可重复执行入口（冻结清单 reproduce.command 引用本文件）：
 *   npm run baseline -- --players 2,3,4,5 --mirror-seeds 400 --contest-seeds 300
 *
 * 纪律：
 * - 启动即校验冠军冻结（引擎指纹 + 参数指纹与 champion.json 一致，不一致即终止）；
 * - 每个配置从 AI6_BASELINE_BLOCK 专用子块顺序消费唯一种子（账本持久化，绝不复用）；
 * - 复放校验（--replay <report.json>）：从既有报告读取种子区间重跑，
 *   逐局 outcomeKey 必须一致（确定性验收），不消耗新种子；
 * - 本 CLI 不改变晋级门槛、不写冠军记录、不触碰规则与裁判逻辑。
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadChampion, writeChampionFreeze, verifyChampionFreeze,
} from './freeze.mjs';
import { allocateBaselineSeeds, BASELINE_LEDGER_PATH } from './seed-ledger.mjs';
import { runMirrorBaseline, runContestBaseline, outcomeKey, MAX_SEAT_COUNT } from './runner.mjs';
import { environmentInfo } from './perf.mjs';
import { writeJSON, ensureDir } from '../lib/io.mjs';

const BASELINE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const FREEZE_PATH = resolve(BASELINE_DIR, 'champion-freeze.json');
const REPORTS_DIR = resolve(BASELINE_DIR, 'reports');

function parseArgs(argv) {
  const args = { players: '2,3,4,5', mirrorSeeds: 400, contestSeeds: 300, out: null, freezeCheck: false, replay: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--players') args.players = argv[++i];
    else if (arg === '--mirror-seeds') args.mirrorSeeds = Number(argv[++i]);
    else if (arg === '--contest-seeds') args.contestSeeds = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--freeze-check') args.freezeCheck = true;
    else if (arg === '--replay') args.replay = argv[++i];
    else if (arg === '--only') args.only = argv[++i];
    else throw new Error(`未知参数：${arg}`);
  }
  args.playerCounts = args.players.split(',').map(Number);
  if (args.playerCounts.some(n => !Number.isInteger(n) || n < 2 || n > MAX_SEAT_COUNT)) {
    throw new Error(`--players 必须是 2..${MAX_SEAT_COUNT} 的组合，实际：${args.players}`);
  }
  return args;
}

/** 冻结校验（manifest 缺失时按需现场生成；存在时逐项核对）。 */
export function ensureFreeze({ path = FREEZE_PATH, write = false } = {}) {
  if (!existsSync(path)) {
    if (!write) throw new Error(`冻结清单不存在（${path}）。首次使用请执行：node training/baseline/freeze.mjs`);
    return writeChampionFreeze(path);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const { ok, problems } = verifyChampionFreeze(manifest);
  if (!ok) throw new Error(`冠军冻结校验失败：\n- ${problems.join('\n- ')}`);
  return manifest;
}

/** 执行一轮完整基线（镜像 + 对抗 × 每个玩家数），返回报告对象。
 * ledgerPath / freezePath 可注入（测试用临时路径，避免消费正式种子账本）。 */
export function runBaseline({ playerCounts = [2, 3, 4, 5], mirrorSeeds = 400, contestSeeds = 300, label = 'baseline', ledgerPath = BASELINE_LEDGER_PATH, freezePath = FREEZE_PATH } = {}) {
  const freeze = ensureFreeze({ path: freezePath });
  const champion = loadChampion();
  const environment = environmentInfo();
  const configs = [];

  for (const seatCount of playerCounts) {
    if (mirrorSeeds > 0) {
      const mirrorAlloc = allocateBaselineSeeds(`mirror-n${seatCount}`, mirrorSeeds, { ledgerPath });
      const started = Date.now();
      const mirror = runMirrorBaseline({
        champion, seatCount, seeds: mirrorSeeds, seedBase: mirrorAlloc.base,
      });
      mirror.seedAllocation = { base: mirrorAlloc.base, count: mirrorSeeds, uniqueSeedCount: mirrorAlloc.uniqueSeedCount };
      mirror.elapsedMs = Date.now() - started;
      configs.push(mirror);
      console.log(`[mirror N=${seatCount}] 完成 ${mirror.finishedGames}/${mirror.totalGames} 局，异常 ${mirror.anomalies}，座位最大偏差 ${(mirror.maxSeatDeviation * 100).toFixed(1)}pp，耗时 ${(mirror.elapsedMs / 1000).toFixed(1)}s`);
    }
    if (contestSeeds > 0) {
      const contestAlloc = allocateBaselineSeeds(`contest-n${seatCount}`, contestSeeds, { ledgerPath });
      const started = Date.now();
      const contest = runContestBaseline({
        champion, seatCount, seeds: contestSeeds, seedBase: contestAlloc.base,
      });
      contest.seedAllocation = { base: contestAlloc.base, count: contestSeeds, uniqueSeedCount: contestAlloc.uniqueSeedCount };
      contest.elapsedMs = Date.now() - started;
      configs.push(contest);
      const fp = contest.firstPlace;
      console.log(`[contest N=${seatCount}] 完成 ${contest.finishedGames}/${contest.totalGames} 局，异常 ${contest.anomalies}，` +
        `第一名率 ${fp ? (fp.point * 100).toFixed(1) + '%' : 'N/A'}（bootstrap CI ${fp ? `[${(fp.lower * 100).toFixed(1)}, ${(fp.upper * 100).toFixed(1)}]` : ''}），耗时 ${(contest.elapsedMs / 1000).toFixed(1)}s`);
    }
  }

  return {
    schema: 'century-baseline-report-v1',
    label,
    startedAt: environment.measuredAt,
    finishedAt: new Date().toISOString(),
    environment,
    freeze: {
      championId: freeze.champion.id,
      fingerprint: freeze.champion.fingerprint,
      engineBundleSha256: freeze.version.engineBundleSha256,
      frozenAtRepoCommit: freeze.version.frozenAtRepoCommit,
    },
    seedLedgerPath: BASELINE_LEDGER_PATH,
    configs,
  };
}

/** 复放校验：重跑报告中的每个配置（同种子区间），逐局 outcomeKey 必须一致。
 * onlyFilter（可选）：只复放匹配的配置（config 名或 `config-nN` 键），控制复放成本。 */
export function verifyReplay(reportPath, { only = null } = {}) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.schema !== 'century-baseline-report-v1') {
    throw new Error(`报告 schema 不识别：${report.schema}`);
  }
  const champion = loadChampion();
  ensureFreeze();
  const problems = [];
  const configs = report.configs.filter(c =>
    !only || c.config === only || `${c.config}-n${c.seatCount}` === only);
  if (configs.length === 0) throw new Error(`--only 过滤器未匹配任何配置：${only}`);
  for (const config of configs) {
    const alloc = config.seedAllocation;
    if (!alloc) throw new Error(`报告配置 ${config.config} N=${config.seatCount} 缺少 seedAllocation，无法复放`);
    const run = config.config === 'mirror'
      ? runMirrorBaseline({ champion, seatCount: config.seatCount, seeds: alloc.count, seedBase: alloc.base, collectDecisions: false })
      : runContestBaseline({ champion, seatCount: config.seatCount, seeds: alloc.count, seedBase: alloc.base, collectDecisions: false });
    if (run.games.length !== config.games.length) {
      problems.push(`${config.config} N=${config.seatCount}：局数不一致（${run.games.length} vs ${config.games.length}）`);
      continue;
    }
    for (let i = 0; i < run.games.length; i++) {
      if (outcomeKey(run.games[i]) !== outcomeKey(config.games[i])) {
        problems.push(`${config.config} N=${config.seatCount} 第 ${i} 局结果不一致：\n  复放=${outcomeKey(run.games[i])}\n  原始=${outcomeKey(config.games[i])}`);
        break;
      }
    }
    console.log(`[replay] ${config.config} N=${config.seatCount}：${problems.length ? '不一致' : '逐局一致'}（${run.games.length} 局）`);
  }
  return { ok: problems.length === 0, problems };
}

/** 汇总 markdown 摘要（人类可读速览；完整数据在 report.json）。 */
export function summarizeMarkdown(report) {
  const lines = [];
  lines.push(`# Century AI 冠军基线评测（${report.finishedAt.slice(0, 10)}）`);
  lines.push('');
  lines.push(`- 冠军：\`${report.freeze.championId}\`（fingerprint \`${report.freeze.fingerprint.slice(0, 24)}…\`）`);
  lines.push(`- 引擎产物：\`${report.freeze.engineBundleSha256.slice(0, 16)}…\`｜commit：\`${report.environment.repoCommit?.slice(0, 9)}\`｜Node ${report.environment.nodeVersion}`);
  lines.push(`- 环境：${report.environment.cpuModel} ×${report.environment.cpuCores}｜${report.environment.memoryTotalGB}GB｜workers=${report.environment.workers}`);
  lines.push('');
  lines.push('| 配置 | N | 局数 | 异常 | 第一名率（bootstrap 95% CI） | 平均名次 | 平均分差 | 吞吐(局/h) | 决策 p50/p95/p99 (ms) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of report.configs) {
    const fp = c.firstPlace;
    const lat = c.latency ?? {};
    lines.push(`| ${c.config} | ${c.seatCount} | ${c.finishedGames} | ${c.anomalies} | ${fp ? `${(fp.point * 100).toFixed(1)}% [${(fp.lower * 100).toFixed(1)}, ${(fp.upper * 100).toFixed(1)}]` : '—'} | ${c.meanRank ?? '—'} | ${c.meanScoreDiff ?? '—'} | ${c.throughput?.gamesPerHourSingleCore ?? '—'} | ${lat.p50Ms ?? '—'}/${lat.p95Ms ?? '—'}/${lat.p99Ms ?? '—'} |`);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('cli.mjs');
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.freezeCheck) {
    ensureFreeze();
    console.log('冻结校验通过：冠军配置、参数指纹与引擎产物指纹全部一致');
    process.exitCode = 0;
  } else if (args.replay) {
    const { ok, problems } = verifyReplay(resolve(process.cwd(), args.replay), { only: args.only ?? null });
    console.log(ok ? '复放校验通过：全部配置逐局一致（确定性成立）' : `复放校验失败：\n${problems.join('\n')}`);
    process.exitCode = ok ? 0 : 1;
  } else {
    const report = runBaseline(args);
    const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = args.out ? resolve(process.cwd(), args.out) : resolve(REPORTS_DIR, runId);
    ensureDir(outDir);
    writeJSON(resolve(outDir, 'report.json'), report);
    const md = summarizeMarkdown(report);
    writeJSON(resolve(outDir, 'summary.json'), { markdown: md });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(outDir, 'summary.md'), md + '\n');
    console.log(`\n报告目录：${outDir}`);
    console.log('\n' + md);
  }
}
