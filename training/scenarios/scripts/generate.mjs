#!/usr/bin/env node
/** 基准语料生成 CLI（战术基准专用）。
 *
 * 用正式引擎回放 AI6_SCENARIO_BLOCK 内固定种子的完整对局，在每个决策点按
 * 十类目标标签 + 人数查配额槽位，命中即采集完整基准局面并记录四个冻结版本
 * 的确定性建议行动；随后对符合条件（终局在即）的局面运行局部求解 oracle，
 * 最后产出机器可读 JSONL + 分类索引 + 人类可读 Markdown + 种子消耗清单。
 *
 * 用法：node scripts/generate.mjs [--games 2:60,3:50,4:50,5:60] [--per-slot 2]
 *      [--max-total 44] [--oracle-limit 15] [--out data/scenarios.jsonl]
 *      [--append] [--focus final-round]   追加模式（种子续接）与焦点标签定向补采
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { engineBundleSha256, REPO_ROOT } from '../../lib/paths.mjs';
import { AI6_SCENARIO_BLOCK } from '../../../ai5/lib/seed_policy.mjs';
import { scenarioSeed, frozenVersions } from '../lib/versions.mjs';
import { playGame, snapshotPosition } from '../lib/harvest.mjs';
import { buildScenario, fullLegalActions, positionPublicView } from '../lib/decisions.mjs';
import { analyzePosition } from '../lib/classify.mjs';
import { solveEndgame, oracleEligible } from '../lib/oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const args = { games: '2:60,3:50,4:50,5:60', perSlot: 2, maxTotal: 44, oracleLimit: 15, out: join(SCENARIOS_ROOT, 'data', 'scenarios.jsonl'), focus: null, append: false };
  const values = { '--games': 'games', '--per-slot': 'perSlot', '--max-total': 'maxTotal', '--oracle-limit': 'oracleLimit', '--out': 'out', '--focus': 'focus' };
  for (let i = 2; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    if (argv[i] === '--append') { args.append = true; continue; }
    if (argv[i].startsWith('--') && eq > 0) {
      const key = values[argv[i].slice(0, eq)];
      if (!key) throw new Error(`未知参数：${argv[i]}`);
      args[key] = key === 'perSlot' || key === 'maxTotal' || key === 'oracleLimit' ? Number(argv[i].slice(eq + 1)) : argv[i].slice(eq + 1);
    } else if (values[argv[i]]) {
      const key = values[argv[i]];
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${argv[i]} 缺值`);
      args[key] = key === 'perSlot' || key === 'maxTotal' || key === 'oracleLimit' ? Number(v) : v;
    } else throw new Error(`未知参数：${argv[i]}`);
  }
  if (typeof args.out === 'string') args.out = resolve(process.cwd(), args.out);
  return args;
}

const args = parseArgs(process.argv);
const gamesByCount = Object.fromEntries(args.games.split(',').map(s => {
  const [n, c] = s.split(':');
  return [Number(n), Number(c)];
}));

let engineCommit = null;
try { engineCommit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); } catch { engineCommit = null; }
const bundleSha = engineBundleSha256();
const generatedAt = new Date().toISOString();
const blockLabel = `[${AI6_SCENARIO_BLOCK[0]}, ${AI6_SCENARIO_BLOCK[1]})`;

const drivers = frozenVersions().filter(v => v.key !== 'js5-w128'); // 驱动用确定性束搜索版本（快），JS5 只做基准记录
const driverByKey = Object.fromEntries(drivers.map(d => [d.key, d]));
const driverCycle = ['classic-beam-rollout', 'js1-beam-contest', 'v4-baseline'];

// 配额：覆盖度按标签集合计；主分类 × 人数槽位（上限 per-slot）控制分布均衡；
// 每个人数独立配额（maxTotal/4 向上取整），保证 2–5 人数都被覆盖。
// 追加模式（--append）：保留既有语料与配额状态，种子从上次消耗处续接；
// 焦点模式（--focus <tag>）：只采集带该标签的局面（如终局类定向补采）。
const scenarios = [];
const slots = new Map();
const primaryCounts = new Map();
const coveredTags = new Set();
const countScenarios = { 2: 0, 3: 0, 4: 0, 5: 0 };
const seqByCategory = new Map();
let seedIndex = 0;
const summaryPath = join(dirname(args.out), 'generation-summary.json');

if (args.append) {
  const existing = readFileSync(args.out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const s of existing) {
    scenarios.push(s);
    countScenarios[s.classification.playerCount]++;
    primaryCounts.set(`${s.classification.category}|${s.classification.playerCount}`, (primaryCounts.get(`${s.classification.category}|${s.classification.playerCount}`) ?? 0) + 1);
    for (const t of s.classification.tags) coveredTags.add(t);
    const m = s.id.match(/-([A-Z]{3})-(\d+)$/);
    if (m) {
      const key = `${s.classification.category}|${s.classification.playerCount}`;
      seqByCategory.set(key, Math.max(seqByCategory.get(key) ?? 0, Number(m[2])));
    }
  }
  if (existsSync(summaryPath)) {
    const prev = JSON.parse(readFileSync(summaryPath, 'utf8'));
    seedIndex = prev.seedsConsumed?.count ?? 0;
  }
  for (const s of existing) {
    for (const t of s.classification.tags) slots.set(`${t}|${s.classification.playerCount}`, (slots.get(`${t}|${s.classification.playerCount}`) ?? 0) + 1);
  }
  console.log(`[generate] 追加模式：保留 ${existing.length} 条既有语料，种子续接 ${AI6_SCENARIO_BLOCK[0] + seedIndex}${args.focus ? `，焦点标签 ${args.focus}` : ''}`);
}

const perCountCap = Math.ceil(args.maxTotal / 4);
const slotOpen = (tag, n) => (slots.get(`${tag}|${n}`) ?? 0) < args.perSlot;
const primaryOpen = (primary, n) => (primaryCounts.get(`${primary}|${n}`) ?? 0) < args.perSlot;
const fillSlots = (tags, n) => { for (const t of tags) { slots.set(`${t}|${n}`, (slots.get(`${t}|${n}`) ?? 0) + 1); coveredTags.add(t); } };
const TARGET_TAGS = ['final-round', 'opponent-ending', 'contested-claim', 'multi-claim', 'seat-race', 'acquire-vs-score', 'caravan-pressure', 'trade-chain-rest', 'conversion-efficiency', 'engine-overinvest'];
const coverageDone = () => TARGET_TAGS.every(t => coveredTags.has(t));
const quotaDone = () => scenarios.length >= args.maxTotal;
const done = () => (args.focus ? quotaDone() : coverageDone() && quotaDone());

mkdirSync(dirname(args.out), { recursive: true });
const anomalies = [];
let gamesPlayed = 0;

console.log(`[generate] 引擎产物指纹 ${bundleSha.slice(0, 12)}… · commit ${engineCommit?.slice(0, 12) ?? 'unknown'} · 种子块 ${blockLabel}`);

outer:
for (const seatCount of [2, 3, 4, 5]) {
  const games = gamesByCount[seatCount] ?? 0;
  for (let g = 0; g < games; g++) {
    if (done()) break outer;
    if (!args.focus && countScenarios[seatCount] >= perCountCap && coverageDone()) break; // 配额满且覆盖完成才跳到下一人数
    const seed = scenarioSeed(seedIndex++);
    const driverKey = driverCycle[g % driverCycle.length];
    const driver = driverByKey[driverKey];
    gamesPlayed++;
    const result = playGame(seed, seatCount, driver, ({ game, decisionIndex }) => {
      const position = snapshotPosition(game);
      const legal = fullLegalActions(position);
      const analysis = analyzePosition(positionPublicView(position), legal);
      if (analysis.tags.length === 0) return false;
      // 焦点模式：只采集带焦点标签的局面（定向补采，如终局类）。
      if (args.focus) {
        if (!analysis.tags.includes(args.focus)) return false;
        if (!primaryOpen(analysis.primaryCategory, seatCount)) return false;
      } else {
        // 覆盖优先：携带未覆盖标签的局面可越过人数配额与标签槽位（总量仍受 maxTotal 约束）。
        const uncoveredTags = analysis.tags.filter(t => !coveredTags.has(t));
        const quotaOk = countScenarios[seatCount] < perCountCap;
        const harvestTags = analysis.tags.filter(t => slotOpen(t, seatCount));
        const regularOk = quotaOk && primaryOpen(analysis.primaryCategory, seatCount) && harvestTags.length > 0;
        const huntOk = uncoveredTags.length > 0 && primaryOpen(analysis.primaryCategory, seatCount);
        if (!regularOk && !huntOk) return false;
      }
      const scenario = buildScenario(position, {
        gameSeed: seed, seatCount, decisionIndex, driver: driverKey,
        engineCommit, engineBundleSha256: bundleSha, generatedAt, scenarioBlock: blockLabel,
      }, seqByCategory);
      scenarios.push(scenario);
      countScenarios[seatCount]++;
      primaryCounts.set(`${analysis.primaryCategory}|${seatCount}`, (primaryCounts.get(`${analysis.primaryCategory}|${seatCount}`) ?? 0) + 1);
      fillSlots(analysis.tags.filter(t => slotOpen(t, seatCount)), seatCount);
      console.log(`[generate] + ${scenario.id}（tags: ${analysis.tags.join(', ')}；legal ${legal.length}${args.focus ? '；焦点补采' : ''}）`);
      return done();
    });
    if (result.status === 'anomaly') anomalies.push({ seed, seatCount, driver: driverKey, reason: result.reason });
  }
}

// —— oracle：终局在即的局面（固定工作量上限）——
let oracleRuns = 0;
for (const scenario of scenarios) {
  if (oracleRuns >= args.oracleLimit) break;
  if (!scenario.oracle && oracleEligible(scenario.engineState.position)) {
    const t0 = performance.now();
    scenario.oracle = solveEndgame(scenario.engineState.position);
    oracleRuns++;
    console.log(`[generate] oracle ${scenario.id}: ${scenario.oracle.status}（${scenario.oracle.stats?.nodes ?? 0} 节点，${Math.round(performance.now() - t0)}ms）`);
  }
}

// 序列化在 oracle 之后：确保落盘内容包含 oracle 结论（历史教训：先序列化后补字段会丢 oracle）。
writeFileSync(args.out, scenarios.map(s => JSON.stringify(s)).join('\n') + (scenarios.length ? '\n' : ''));

// —— 汇总与索引 ——
const byCategory = {};
const byPlayerCount = {};
const byStage = {};
for (const s of scenarios) {
  byCategory[s.classification.category] = (byCategory[s.classification.category] ?? 0) + 1;
  byPlayerCount[s.classification.playerCount] = (byPlayerCount[s.classification.playerCount] ?? 0) + 1;
  byStage[s.classification.stage] = (byStage[s.classification.stage] ?? 0) + 1;
}
const summary = {
  generatedAt,
  engineCommit,
  engineBundleSha256: bundleSha,
  seedBlock: blockLabel,
  seedsConsumed: { start: AI6_SCENARIO_BLOCK[0], end: AI6_SCENARIO_BLOCK[0] + seedIndex, count: seedIndex },
  gamesPlayed,
  anomalies,
  scenariosCount: scenarios.length,
  byCategory, byPlayerCount, byStage,
  scenariosByPlayerCount: countScenarios,
  perCountCap,
  tagCoverage: Object.fromEntries(TARGET_TAGS.map(t => [t, coveredTags.has(t)])),
  coverageComplete: coverageDone(),
  settings: { gamesByCount, perSlot: args.perSlot, maxTotal: args.maxTotal, oracleLimit: args.oracleLimit, driverCycle, focus: args.focus, append: args.append },
  oracleRuns,
};
writeFileSync(join(dirname(args.out), 'generation-summary.json'), JSON.stringify(summary, null, 2) + '\n');

// index.json：机器可读分类索引
const index = {
  schema: 'century-tactical-benchmark-index-v1',
  generatedAt,
  count: scenarios.length,
  byCategory, byPlayerCount, byStage,
  scenarios: scenarios.map(s => ({
    id: s.id,
    category: s.classification.category,
    tags: s.classification.tags,
    playerCount: s.classification.playerCount,
    stage: s.classification.stage,
    competition: s.classification.competition,
    targetCount: s.classification.targetCount,
    difficulty: s.classification.difficulty,
    legalActionCount: s.legalActionCount,
    turnNumber: s.turnNumber,
    allAgree: s.disagreement.allAgree,
    uniqueActions: s.disagreement.uniqueCount,
    oracleStatus: s.oracle?.status ?? null,
    gameSeed: s.provenance.gameSeed,
  })),
};
writeFileSync(join(dirname(args.out), 'index.json'), JSON.stringify(index, null, 2) + '\n');

// INDEX.md：人类可读总览
const md = [];
md.push('# Century 战术基准局面库索引', '');
md.push(`生成时间：${generatedAt} · 引擎 commit：${engineCommit ?? 'unknown'} · 产物指纹：\`${bundleSha.slice(0, 16)}…\` · 种子块：${blockLabel}`, '');
md.push(`共 ${scenarios.length} 个局面，玩家数分布 ${JSON.stringify(byPlayerCount)}，阶段分布 ${JSON.stringify(byStage)}。`, '');
for (const cat of [...new Set(scenarios.map(s => s.classification.category))].sort()) {
  const list = scenarios.filter(s => s.classification.category === cat);
  md.push(`## ${cat}（${list.length}）`, '');
  md.push('| id | 人数 | 阶段 | 竞争 | 难度 | 回合 | 合法行动 | 版本全一致 | oracle |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of list) {
    md.push(`| ${s.id} | ${s.classification.playerCount} | ${s.classification.stage} | ${s.classification.competition} | ${s.classification.difficulty} | ${s.turnNumber} | ${s.legalActionCount} | ${s.disagreement.allAgree ? '是' : `否(${s.disagreement.uniqueCount})`} | ${s.oracle?.status ?? '—'} |`);
  }
  md.push('');
}
md.push('字段口径与分类启发式阈值见 [README.md](../README.md)。', '');
writeFileSync(join(dirname(args.out), 'INDEX.md'), md.join('\n'));

console.log(`[generate] 完成：${scenarios.length} 局面 / ${gamesPlayed} 局回放 / 异常 ${anomalies.length} / oracle ${oracleRuns} 次`);
console.log(`[generate] 分类分布 ${JSON.stringify(byCategory)}`);
const missing = TARGET_TAGS.filter(t => !coveredTags.has(t));
if (missing.length > 0) console.warn(`[generate] 警告：以下目标类别未覆盖（可在同种子块继续加局数或调整驱动）：${missing.join(', ')}`);
if (scenarios.length === 0) { console.error('[generate] 警告：未采集到任何局面，请检查配额/游戏数设置'); process.exitCode = 2; }
