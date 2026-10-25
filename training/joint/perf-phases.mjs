/** JS5 分阶段性能画像与预算扫描（AI6 第五阶段·任务 B1/B3）。
 *
 * B1：按游戏阶段 × 人数分别计量 js0（冻结冠军）与 js5 的整次决策延迟，
 * 并对 js5 分相披露（plan/rootSim/gate/screen/rollout/aggregate——
 * champion-guided stats 分相字段）。阶段定义（全部公开信息可判定）：
 * - opening        开局（turnNumber ≤ 2）
 * - engine-forming 引擎初步形成（有人已认领 ≥1 且处于前 1/3 回程）
 * - bighand-mid    大手牌中局（中 1/3 回程且有人手牌 ≥5）
 * - multi-claim    多张魔像可认领（当前行动者可支付 ≥2 个市场目标）
 * - multi-rival    多玩家目标竞争（≥2 个对手已各认领 ≥1）
 * - endgame        临近终局（triggerPlayer ≠ null）
 * - overflow       超容量弃置（phase='overflow'）
 * 一个决策可命中多个阶段（分别计入，披露 counts）。
 *
 * B3：预算 25/50/100/200ms 下披露 js0 延迟、js5 总延迟、增量、
 * 饥饿回退率（gated && rollouts=0 → 回退冠军）、有效试验数/决策、
 * p50/p95/p99/max、超预算比例——整次决策口径（含冠军规划），
 * 不是"联合部分遵守预算"。
 *
 * 同步执行模型限制（任务 B3 要求的显式披露）：单决策内部无抢占点，
 * 冠军 choosePlan 在重态可超预算（继承成本，js0 同样承担）——本工具
 * 逐阶段量化该成本；Worker 隔离/可中断执行的工程评估见报告。
 *
 * 种子：AI6_JOINT_PERF_SUBBLOCK [1.35e9,1.351e9) 内未消费段（+50 起；
 * 性能遥测基础设施，不用于任何强度结论）。
 *
 * 用法：node training/joint/perf-phases.mjs [--players 2,3,4,5] [--games 8] [--budget 100] [--budgets 25,50,100,200]
 * 输出：training/reports/js5-phase5/perf-phases.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { GOLEM_BY_ID } from '../../web-v1/dist/js/data.js';
import { assertInBlock } from '../../ai5/lib/seed_policy.mjs';
import { latencySummary } from '../baseline/stats.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { resolveAlgorithmVersion } from '../lib/version-registry.mjs';

const seatProfile = seat => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);
// P0-1 整改：js0 计时与状态驱动 = 冻结 legacy-js0（晋级前 CHAMPION_PARAMETERS 即
// 该参数；晋级后 CHAMPION_PARAMETERS 变为 JS5 适配器，直接透传会把 timeJs0 变成
// JS5-auto 计时、状态驱动变成 JS5 驱动——身份与历史口径漂移）。
const JS0 = resolveAlgorithmVersion('legacy-js0');

function parseArgs() {
  const args = { players: [2, 3, 4, 5], games: 8, budget: 100, budgets: [25, 50, 100, 200], outDir: resolve(REPO_ROOT, 'training/reports/js5-phase5') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--games') args.games = Number(argv[++i]);
    else if (argv[i] === '--budget') args.budget = Number(argv[++i]);
    else if (argv[i] === '--budgets') args.budgets = argv[++i].split(',').map(Number);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

/** 当前决策命中的阶段集合（公开信息判定；一个决策可命中多个）。 */
function stagesOf(game) {
  const stages = [];
  const n = game.players.length;
  if (game.turnNumber <= 2) stages.push('opening');
  const maxClaimed = Math.max(...game.players.map(p => p.claimed.length));
  if (maxClaimed >= 1 && game.turnNumber <= 6) stages.push('engine-forming');
  if (game.turnNumber > 6 && game.turnNumber <= 12 && game.players.some(p => p.hand.length >= 5)) stages.push('bighand-mid');
  // multi-claim：行动者可支付的市场目标数（观察口径：stock 可覆盖任一已入场目标费用）。
  const me = game.players[game.current];
  const affordable = game.golemMarket.filter(id => {
    const goal = GOLEM_BY_ID[id];
    return goal && goal.cost.every((c, i) => me.stock[i] >= c);
  }).length;
  if (affordable >= 2) stages.push('multi-claim');
  if (game.players.filter(p => p.id !== game.current && p.claimed.length >= 1).length >= 2) stages.push('multi-rival');
  if (game.triggerPlayer !== null) stages.push('endgame');
  if (game.phase === 'overflow') stages.push('overflow');
  return stages;
}

// GOLEM_BY_ID 已在顶部从 dist data 导入。

/** 用冠军快速推进采集各阶段决策状态（每阶段 cap 个样本）。 */
function collectStates({ seatCount, seed, stageCaps }) {
  let g = createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  g.players[0].isAI = true;
  const captured = [];
  let moves = 0;
  while (g.phase !== 'finished' && moves < 1200) {
    for (const stage of stagesOf(g)) {
      const cap = stageCaps[stage];
      if (cap !== undefined && (captured.filter(x => x.stage === stage).length) < cap) {
        captured.push({ stage, game: JSON.parse(JSON.stringify(g)) });
      }
    }
    const r = chooseAIAction(g, { parameters: JS0.parameters, structure: JS0.structure, profile: seatProfile(g.current) });
    g = applyAction(g, r.action);
    moves += 1;
  }
  return captured;
}

/** 逐决策计时（深拷贝防 applyAction 原地改写；候选席人格按席位映射）。 */
function timeJs0(game) {
  const g = JSON.parse(JSON.stringify(game));
  const t0 = performance.now();
  const r = chooseAIAction(g, { parameters: JS0.parameters, structure: JS0.structure, profile: seatProfile(g.current) });
  return { ms: performance.now() - t0, action: r.action };
}

function timeJs5(game, budgetMs, seed) {
  const g = JSON.parse(JSON.stringify(game));
  const t0 = performance.now();
  const r = chooseJointAction(g, { version: 'joint-js5', budgetMs, simSeed: seed, profile: seatProfile(g.current) });
  const ms = performance.now() - t0;
  return {
    ms, action: r.action,
    gated: r.joint?.gated ?? null,
    rollouts: r.joint?.stats?.rollouts ?? 0,
    phases: r.joint?.stats ?? {},
    starved: (r.joint?.gated === true && (r.joint?.stats?.rollouts ?? 0) === 0),
  };
}

async function main() {
  const { players, games, budget, budgets, outDir } = parseArgs();
  // 逐 (人数, 阶段) 采样目标：每阶段 ≤12 个决策样本。
  const stageCaps = Object.fromEntries(['opening', 'engine-forming', 'bighand-mid', 'multi-claim', 'multi-rival', 'endgame', 'overflow'].map(s => [s, 12]));
  const phaseData = {};
  const budgetData = {};
  for (const seatCount of players) {
    const capturedAll = [];
    for (let i = 0; i < games; i++) {
      const seed = 1_350_000_050 + i + games * players.indexOf(seatCount);
      assertInBlock(seed, [1_350_000_000, 1_351_000_000], 'perf 种子');
      capturedAll.push(...collectStates({ seatCount, seed, stageCaps }));
    }
    // B1：标准 100ms 预算分阶段画像。
    for (const stage of Object.keys(stageCaps)) {
      const states = capturedAll.filter(x => x.stage === stage).slice(0, stageCaps[stage]);
      if (!states.length) continue;
      const js0 = states.map(s => timeJs0(s.game));
      const js5 = states.map((s, i) => timeJs5(s.game, budget, 1_350_000_050 + i));
      phaseData[`${seatCount}p/${stage}`] = {
        samples: states.length,
        js0: latencySummary(js0.map(x => x.ms)),
        js5: latencySummary(js5.map(x => x.ms)),
        js5DeltaP50: Number((latencySummary(js5.map(x => x.ms)).p50Ms - latencySummary(js0.map(x => x.ms)).p50Ms).toFixed(3)),
        js5PhasesMean: ['planMs', 'rootSimMs', 'gateMs', 'screenMs', 'rolloutMs', 'aggregateMs'].reduce((acc, k) => {
          const vals = js5.map(x => x.phases[k]).filter(v => typeof v === 'number');
          acc[k] = vals.length ? Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)) : null;
          return acc;
        }, {}),
        gateRate: Number((js5.filter(x => x.gated === true).length / js5.length).toFixed(4)),
        starvedRate: Number((js5.filter(x => x.starved).length / js5.length).toFixed(4)),
        meanRollouts: Number((js5.reduce((s, x) => s + x.rollouts, 0) / js5.length).toFixed(2)),
      };
    }
    // B3：预算扫描（整次决策口径）。
    for (const b of budgets) {
      const states = capturedAll.slice(0, 40);
      const js0 = states.map(s => timeJs0(s.game));
      const js5 = states.map((s, i) => timeJs5(s.game, b, 1_350_000_050 + i));
      budgetData[`${seatCount}p@${b}ms`] = {
        samples: states.length,
        budgetMs: b,
        js0: latencySummary(js0.map(x => x.ms)),
        js5: latencySummary(js5.map(x => x.ms)),
        js5DeltaP50: Number((latencySummary(js5.map(x => x.ms)).p50Ms - latencySummary(js0.map(x => x.ms)).p50Ms).toFixed(3)),
        overBudgetRatio: Number((js5.filter(x => x.ms > b).length / js5.length).toFixed(4)),
        starvedFallbackRate: Number((js5.filter(x => x.starved).length / js5.length).toFixed(4)),
        gatedRate: Number((js5.filter(x => x.gated === true).length / js5.length).toFixed(4)),
        meanEffectiveTrials: Number((js5.reduce((s, x) => s + x.rollouts, 0) / js5.length).toFixed(2)),
        legalityNote: '全部决策经 applyAction 试探校验（duel 纪律）——本工具只计时不落对局，合法性由回归测试与 duel 保证',
      };
    }
    process.stdout.write(`[done] ${seatCount}p：阶段样本 ${capturedAll.length}，预算扫描 ${budgets.length} 档\n`);
  }
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, 'perf-phases.json');
  writeFileSync(out, JSON.stringify({
    schema: 'century-js5-perf-phases-v1',
    date: new Date().toISOString(),
    note: '开发机实测（Apple Silicon 10 核）；M4 绝对值以目标机复测为准。阶段可重叠命中（分别计入）。预算口径 = 整次决策（含冠军规划）。',
    stageDefs: {
      opening: 'turnNumber ≤ 2', 'engine-forming': '有人认领≥1 且 turnNumber ≤ 6',
      'bighand-mid': '6 < turnNumber ≤ 12 且有人手牌 ≥5', 'multi-claim': '行动者可支付 ≥2 个市场目标',
      'multi-rival': '≥2 个对手各认领 ≥1', endgame: 'triggerPlayer ≠ null', overflow: 'phase=overflow',
    },
    standardBudgetMs: budget, phases: phaseData, budgets: budgetData,
  }, null, 2));
  console.log(`已写入：${out}`);
}

main().catch(error => { console.error(error); process.exit(1); });
