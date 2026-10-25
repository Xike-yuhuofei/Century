#!/usr/bin/env node
/** AI7 竞技决策候选实验运行器（研究侧；不触碰正式验证种子）。
 *
 * 三个子命令：
 * - --scenarios：固定局面诊断（全部 50 个战术局面 × 5 个版本，workUnits=128
 *   固定工作量，逐位可复现）；输出行动变化、合法性、耗时、终局精确求解遥测。
 * - --latency：100ms 生产预算延迟/行为探针（同一批中局局面 × 多重复）。
 * - --screen：AI7 开发种子快筛（[1.41e9,1.42e9) 研究块，方向 A，按人数分层）。
 * - --ablate：候选内部消融（C1 弃置、C3 保护/配对、C4 人数条件），
 *   只在 2 人与 5 人两个极端人数上跑小样本。
 *
 * 纪律：
 * - 不读取、不消费正式验证池（[900M,1.06e9)）；
 * - 固定工作量模式保证可复现；墙钟模式只用于延迟与生产行为探针；
 * - 结论只作开发方向读数，不构成晋级证据。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyAction } from '../../web-v1/dist/js/engine.js';
import { PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { describeVersionRegistry } from '../lib/version-registry.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { runAblationCell } from './duel.mjs';
import { AI7_CANDIDATE_DEV_SUBBLOCK } from '../../ai5/lib/seed_policy.mjs';

const SCENARIO_PATH = resolve(REPO_ROOT, 'training/scenarios/data/scenarios.jsonl');
const OUT_DIR = resolve(REPO_ROOT, 'training/reports/ai7-candidates-dev');
const seatProfile = seat => seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];

function loadScenarios() {
  return readFileSync(SCENARIO_PATH, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function revive(scenario) {
  const game = structuredClone(scenario.engineState.position);
  for (const p of game.players) p.isAI = true;
  return game;
}

function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2));
}

function latencySummary(samples) {
  if (!samples.length) return null;
  return {
    n: samples.length,
    p50: percentile(samples, 0.50),
    p95: percentile(samples, 0.95),
    max: Number(Math.max(...samples).toFixed(2)),
    mean: Number((samples.reduce((s, x) => s + x, 0) / samples.length).toFixed(2)),
  };
}

const VERSIONS = [
  'joint-js5',
  'joint-js6-endgame',
  'joint-js7-arb',
  'joint-js8-engine',
  'joint-js8-engine-seat',
];

const key = a => JSON.stringify(a);

function configOf(result) {
  const c = result.config;
  return {
    hash: c.hash,
    endgameSolver: c.endgameSolver,
    endgameDiscard: c.endgameDiscard,
    arbitration: c.arbitration,
    minPairedTrials: c.minPairedTrials,
    pairedZ: c.pairedZ,
    claimProtection: c.claimProtection,
    claimProtectDelta: c.claimProtectDelta,
    claimProtectMargin: c.claimProtectMargin,
    ensureBestClaimCandidate: c.ensureBestClaimCandidate,
    engineModel: c.engineModel,
    seatPolicy: c.seatPolicy,
    championParametersId: c.championParametersId,
  };
}

// === 1. 固定局面诊断 ===
function runScenarios() {
  const scenarios = loadScenarios();
  const rows = [];
  for (const scenario of scenarios) {
    const game = revive(scenario);
    const profile = seatProfile(game.current);
    const results = [];
    for (const version of VERSIONS) {
      const g = revive(scenario);
      const t0 = performance.now();
      const r = chooseJointAction(g, {
        version, workUnits: 128, worlds: 4, simSeed: 0, profile,
      });
      const elapsedMs = performance.now() - t0;
      let legal = true;
      try { applyAction(structuredClone(g), r.action); } catch { legal = false; }
      results.push({
        version,
        action: r.action,
        actionKey: key(r.action),
        championAction: r.joint?.championAction ?? null,
        gated: r.joint?.gated ?? null,
        rollouts: r.joint?.stats.rollouts ?? 0,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        legal,
        endgame: r.joint?.stats.endgame ?? null,
        arbitration: r.joint?.stats.arbitration ?? null,
        claimGuard: r.joint?.stats.claimGuard ?? null,
        config: configOf(r),
      });
    }
    rows.push({
      id: scenario.id,
      playerCount: scenario.classification.playerCount,
      category: scenario.classification.category,
      phase: scenario.phase,
      triggerPlayer: game.triggerPlayer,
      currentSeat: game.current,
      legalActionCount: scenario.legalActionCount,
      results,
    });
  }

  const summary = {};
  for (const version of VERSIONS) {
    const results = rows.map(r => r.results.find(x => x.version === version));
    const js5 = rows.map(r => r.results.find(x => x.version === 'joint-js5'));
    const changed = results.filter((x, i) => x.actionKey !== js5[i].actionKey).length;
    const latencies = results.map(x => x.elapsedMs);
    summary[version] = {
      actionChangesVsJs5: changed,
      actionChangeRate: Number((changed / rows.length).toFixed(4)),
      legality: results.every(x => x.legal),
      latency: latencySummary(latencies),
      gatedRate: Number((results.filter(x => x.gated === true).length / rows.length).toFixed(4)),
      endgameSolved: results.filter(x => x.endgame).length,
    };
  }

  const anchors = {};
  for (const id of ['TS-3P-FIN-003', 'TS-2P-MCL-001', 'TS-4P-MCL-001', 'TS-4P-AVS-001', 'TS-3P-AVS-001']) {
    const row = rows.find(r => r.id === id);
    if (!row) continue;
    anchors[id] = Object.fromEntries(row.results.map(r => [r.version, {
      action: r.action,
      championAction: r.championAction,
      endgame: r.endgame ? {
        ownFinalScore: r.endgame.ownFinalScore,
        guaranteedRank: r.endgame.guaranteedRank,
        optimisticRank: r.endgame.optimisticRank,
        evaluatedActions: r.endgame.evaluatedActions,
      } : null,
      arbitration: r.arbitration ? {
        championProtected: r.arbitration.championProtected,
        protectedClaims: r.arbitration.protectedClaims,
        minTrials: r.arbitration.minTrials,
        candidates: r.arbitration.candidates.map(c => ({
          action: c.action, trials: c.trials, pairedTrials: c.pairedTrials,
          meanDiff: c.meanDiff, lowerConfidenceBound: c.lowerConfidenceBound, requiredMargin: c.requiredMargin,
        })),
      } : null,
      claimGuard: r.claimGuard,
    }]));
  }

  const report = {
    schema: 'century-ai7-scenario-diagnostics-v1',
    generatedAt: new Date().toISOString(),
    options: { workUnits: 128, worlds: 4, simSeed: 0, horizon: null },
    versionRegistry: describeVersionRegistry(),
    versions: VERSIONS,
    summary,
    anchors,
    scenarios: rows,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'scenarios.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(`固定局面诊断 → ${out}\n`);
  printVersionTable(summary);
  return report;
}

// === 2. 100ms 生产预算探针 ===
function runLatency() {
  const scenarios = loadScenarios()
    .filter(s => s.phase === 'turn' && s.legalActionCount >= 40)
    .slice(0, 12);
  const reps = 5;
  const rows = [];
  for (const scenario of scenarios) {
    const profile = seatProfile(scenario.currentSeat);
    const perVersion = {};
    for (const version of VERSIONS) {
      const samples = [];
      const actions = [];
      for (let i = 0; i < reps; i++) {
        const g = revive(scenario);
        const t0 = performance.now();
        const r = chooseJointAction(g, { version, budgetMs: 100, profile });
        samples.push(performance.now() - t0);
        actions.push(r.action);
        try { applyAction(structuredClone(g), r.action); } catch { actions[i] = { legal: false }; }
      }
      perVersion[version] = {
        actionStable: actions.every(a => key(a) === key(actions[0])),
        action: actions[0],
        latency: latencySummary(samples),
      };
    }
    rows.push({ id: scenario.id, playerCount: scenario.classification.playerCount, perVersion });
  }
  const summary = {};
  for (const version of VERSIONS) {
    const all = rows.flatMap(r => [r.perVersion[version].latency.p50, r.perVersion[version].latency.p95]);
    summary[version] = {
      p50OfP50: percentile(all.filter((_, i) => i % 2 === 0), 0.5),
      p50OfP95: percentile(all.filter((_, i) => i % 2 === 1), 0.5),
      maxObserved: Math.max(...rows.map(r => r.perVersion[version].latency.max)),
      stableActionRate: Number((rows.filter(r => r.perVersion[version].actionStable).length / rows.length).toFixed(4)),
      overBudgetRate: Number((rows.filter(r => r.perVersion[version].latency.p95 > 100).length / rows.length).toFixed(4)),
    };
  }
  const report = {
    schema: 'century-ai7-latency-probe-v1',
    generatedAt: new Date().toISOString(),
    budgetMs: 100,
    reps,
    versionRegistry: describeVersionRegistry(),
    summary,
    rows,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'latency.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(`100ms 延迟探针 → ${out}\n`);
  for (const [version, s] of Object.entries(summary)) {
    process.stdout.write(`${version}: p50(median of p50)=${s.p50OfP50}ms p95(median of p95)=${s.p50OfP95}ms max=${s.maxObserved}ms 稳定决策率=${s.stableActionRate} 超预算率=${s.overBudgetRate}\n`);
  }
  return report;
}

// === 3. 开发种子快筛 ===
const MAIN_CELLS = [
  { label: 'js5', version: 'joint-js5', options: {} },
  { label: 'js6-endgame', version: 'joint-js6-endgame', options: {} },
  { label: 'js7-arb', version: 'joint-js7-arb', options: {} },
  { label: 'js8-engine', version: 'joint-js8-engine', options: {} },
  { label: 'js8-engine-seat', version: 'joint-js8-engine-seat', options: {} },
];

const ABLATION_CELLS = [
  { label: 'js6-full', version: 'joint-js6-endgame', options: {} },
  { label: 'js6-no-discard', version: 'joint-js6-endgame', options: { endgameDiscard: false } },
  { label: 'js7-full', version: 'joint-js7-arb', options: {} },
  { label: 'js7-paired-only', version: 'joint-js7-arb', options: { claimProtection: false, ensureBestClaimCandidate: false } },
  { label: 'js7-guard-only', version: 'joint-js7-arb', options: { arbitration: 'legacy' } },
  { label: 'js8-flat', version: 'joint-js8-engine', options: {} },
  { label: 'js8-seat', version: 'joint-js8-engine-seat', options: {} },
];

function seedBaseFor(seatCount) {
  // 每个 (人数) 独占 1 万种子的子区间；同人数的不同版本/变体共享同一批
  // 种子（配对设计，跨版本差异不混入种子噪声）；不同人数绝不共享。
  const base = AI7_CANDIDATE_DEV_SUBBLOCK[0] + seatCount * 100_000;
  if (base + 10_000 > AI7_CANDIDATE_DEV_SUBBLOCK[1]) throw new Error(`AI7 开发种子越界：${base}`);
  return base;
}

function runCells(cells, seatCounts, seeds, label) {
  const cellsOut = [];
  for (const cell of cells) {
    for (const seatCount of seatCounts) {
      const seedBase = seedBaseFor(seatCount);
      const t0 = performance.now();
      const summary = runAblationCell({
        candidateId: cell.version,
        seatCount,
        seeds,
        seedBase,
        jointOptions: { workUnits: 16, worlds: 2, horizon: 32, ...cell.options },
        pool: 'classic',
        directions: ['A'],
      });
      cellsOut.push({
        label: cell.label,
        version: cell.version,
        jointOptions: { workUnits: 16, worlds: 2, horizon: 32, ...cell.options },
        seatCount,
        seedBase,
        seeds,
        elapsedMs: Number((performance.now() - t0).toFixed(0)),
        summary,
      });
      const a = summary.directionA ?? {};
      process.stdout.write(`[${label}] ${cell.label} ${seatCount}p seeds=${seeds} 第一名率=${a.firstPlace?.point ?? 'n/a'} CI=[${a.firstPlace?.lower ?? 'n/a'},${a.firstPlace?.upper ?? 'n/a'}] 均分差=${summary.meanScoreDiff?.mean ?? 'n/a'} 门控=${summary.jointSearch?.gateTriggerRate ?? 'n/a'} 覆盖=${summary.jointSearch?.overrideRate ?? 'n/a'}\n`);
    }
  }
  const report = {
    schema: 'century-ai7-dev-screen-v1',
    generatedAt: new Date().toISOString(),
    seedBlock: AI7_CANDIDATE_DEV_SUBBLOCK,
    note: 'AI7 开发种子快筛（研究块，非正式验证池；只作方向性读数，不得用于晋级）',
    workUnits: 16,
    worlds: 2,
    horizon: 32,
    directions: ['A'],
    cells: cellsOut,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, `${label}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(`开发快筛 → ${out}\n`);
  return report;
}

function printVersionTable(summary) {
  process.stdout.write('版本 | 行动变化/50 | 变化率 | 合法 | p50 | p95 | 门控率 | 终局求解\n');
  for (const [version, s] of Object.entries(summary)) {
    process.stdout.write(`${version} | ${s.actionChangesVsJs5} | ${s.actionChangeRate} | ${s.legality} | ${s.latency.p50} | ${s.latency.p95} | ${s.gatedRate} | ${s.endgameSolved}\n`);
  }
}

function runFocused() {
  // 针对性加大样本：只验证开发快筛中最值得复核的三条方向性读数。
  // 同一 (人数) 内所有版本共享种子（配对），不同人数不共享。
  const cells = MAIN_CELLS;
  const plans = [
    { label: '2p-engine', seatCount: 2, seeds: 24, versions: ['joint-js5', 'joint-js8-engine-seat', 'joint-js7-arb'] },
    { label: '4p-endgame', seatCount: 4, seeds: 16, versions: ['joint-js5', 'joint-js6-endgame'] },
    { label: '5p-arb', seatCount: 5, seeds: 16, versions: ['joint-js5', 'joint-js7-arb', 'joint-js8-engine-seat'] },
  ];
  const out = [];
  for (const plan of plans) {
    const seedBase = seedBaseFor(plan.seatCount);
    for (const version of plan.versions) {
      const cell = cells.find(c => c.version === version);
      const t0 = performance.now();
      const summary = runAblationCell({
        candidateId: version,
        seatCount: plan.seatCount,
        seeds: plan.seeds,
        seedBase,
        jointOptions: { workUnits: 16, worlds: 2, horizon: 32, ...cell.options },
        pool: 'classic',
        directions: ['A'],
      });
      out.push({
        label: plan.label, version, seatCount: plan.seatCount, seeds: plan.seeds,
        seedBase, jointOptions: { workUnits: 16, worlds: 2, horizon: 32, ...cell.options },
        elapsedMs: Number((performance.now() - t0).toFixed(0)),
        summary,
      });
      const a = summary.directionA ?? {};
      process.stdout.write(`[focused] ${plan.label} ${version} ${plan.seatCount}p seeds=${plan.seeds} 第一名率=${a.firstPlace?.point ?? 'n/a'} CI=[${a.firstPlace?.lower ?? 'n/a'},${a.firstPlace?.upper ?? 'n/a'}] 覆盖=${summary.jointSearch?.overrideRate ?? 'n/a'}\n`);
    }
  }
  const report = {
    schema: 'century-ai7-focused-dev-v1',
    generatedAt: new Date().toISOString(),
    seedBlock: AI7_CANDIDATE_DEV_SUBBLOCK,
    note: 'AI7 定向开发快筛（研究块，非正式验证池；不是晋级证据）',
    workUnits: 16, worlds: 2, horizon: 32, directions: ['A'],
    cells: out,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, 'focused.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  process.stdout.write(`定向快筛 → ${file}\n`);
  return report;
}

function runC4() {
  // C4 直接消融：5 人局 flat vs stratified 引擎模型（同种子配对）。
  // 2 人局两者在数学上相同（竞争因子 = 1），不需要重复跑。
  const seatCount = 5;
  const seeds = 16;
  const seedBase = seedBaseFor(seatCount);
  const out = [];
  for (const version of ['joint-js8-engine', 'joint-js8-engine-seat']) {
    const t0 = performance.now();
    const summary = runAblationCell({
      candidateId: version,
      seatCount,
      seeds,
      seedBase,
      jointOptions: { workUnits: 16, worlds: 2, horizon: 32 },
      pool: 'classic',
      directions: ['A'],
    });
    out.push({
      version, seatCount, seeds, seedBase,
      jointOptions: { workUnits: 16, worlds: 2, horizon: 32 },
      elapsedMs: Number((performance.now() - t0).toFixed(0)), summary,
    });
    const f = summary.directionA.firstPlace;
    process.stdout.write(`[c4] ${version} 5p seeds=${seeds} 第一名率=${f.point} CI=[${f.lower},${f.upper}] 覆盖=${summary.jointSearch.overrideRate}\n`);
  }
  const report = {
    schema: 'century-ai7-c4-ablation-v1',
    generatedAt: new Date().toISOString(),
    seedBlock: AI7_CANDIDATE_DEV_SUBBLOCK,
    note: 'C4 人数条件直接消融（5 人局 flat vs stratified；研究块，非正式验证）',
    cells: out,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, 'c4.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  process.stdout.write(`C4 消融 → ${file}\n`);
  return report;
}

function runReplicate() {
  // 固定工作量（workUnits=16）下同一 cell 连续跑两次，检验整局快筛的可重复性。
  // 发现（2026-10-25）：整局轨迹**不是**固定工作量可复现的——对手池含当前冠军
  // （生产 100ms 墙钟预算），对手决策随机器时序变化；因此胜率快筛只能作方向性
  // 读数，候选优劣必须靠固定局面/确定性行为证据或更大样本的独立确认。
  const seatCount = 5;
  const seeds = 4;
  const seedBase = seedBaseFor(seatCount);
  const out = [];
  for (const version of ['joint-js5', 'joint-js8-engine']) {
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const summary = runAblationCell({
        candidateId: version,
        seatCount,
        seeds,
        seedBase,
        jointOptions: { workUnits: 16, worlds: 2, horizon: 32 },
        pool: 'classic',
        directions: ['A'],
      });
      runs.push({
        firstPlace: summary.directionA.firstPlace,
        overrideRate: summary.jointSearch.overrideRate,
        seedResults: summary.games.filter(g => g.direction === 'A').map(g => ({ seed: g.seed, won: g.won })),
      });
    }
    out.push({ version, seatCount, seeds, seedBase, jointOptions: { workUnits: 16, worlds: 2, horizon: 32 }, runs });
    process.stdout.write(`[replicate] ${version} 5p run1=${runs[0].firstPlace.point} run2=${runs[1].firstPlace.point}\n`);
  }
  const stable = out.every(c => JSON.stringify(c.runs[0].seedResults) === JSON.stringify(c.runs[1].seedResults));
  const report = {
    schema: 'century-ai7-replication-v1',
    generatedAt: new Date().toISOString(),
    seedBlock: AI7_CANDIDATE_DEV_SUBBLOCK,
    note: '固定工作量整局快筛重复性检验；对手含当前冠军（100ms 墙钟），用于披露快筛噪声',
    sameSeedResultsAcrossRuns: stable,
    cells: out,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, 'replicate.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  process.stdout.write(`重复性检验 → ${file}（逐种子结果一致=${stable}）\n`);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  if (flags.has('--scenarios')) { runScenarios(); return; }
  if (flags.has('--latency')) { runLatency(); return; }
  if (flags.has('--focused')) { runFocused(); return; }
  if (flags.has('--c4')) { runC4(); return; }
  if (flags.has('--replicate')) { runReplicate(); return; }
  if (flags.has('--screen')) {
    const seedIdx = args.indexOf('--seeds');
    const seeds = seedIdx >= 0 ? Number(args[seedIdx + 1]) : 6;
    runCells(MAIN_CELLS, [2, 3, 4, 5], seeds, 'screen');
    return;
  }
  if (flags.has('--ablate')) {
    const seedIdx = args.indexOf('--seeds');
    const seeds = seedIdx >= 0 ? Number(args[seedIdx + 1]) : 4;
    runCells(ABLATION_CELLS, [2, 5], seeds, 'ablation');
    return;
  }
  process.stdout.write('用法：node training/joint/ai7-candidates.mjs --scenarios | --latency | --screen [--seeds N] | --ablate [--seeds N] | --focused | --c4 | --replicate\n');
}

main().catch(error => { console.error(error); process.exit(1); });
