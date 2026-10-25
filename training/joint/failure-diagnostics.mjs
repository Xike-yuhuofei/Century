/** 失败案例诊断库（AI6 第六阶段·任务 H）。
 *
 * 目标（任务书 §十一）：对失败对局区分「决策实际错误」与「结果不利」，
 * 建立可复现的局面数据集与失败分类，为 OpenEvolve 自动算法进化提供
 * 失败分类与可更换组件的消融入口。
 *
 * 分类体系（任务书 §11 十类）与可自动化判据（诊断流证据）：
 * - budget-starved（9 预算不足）：门控触发但 rollouts=0（饥饿回退）或
 *   chosenTrials ≤ 1 的决策——预算截断使联合仲裁形同虚设；
 * - override-loss（决策错误复核池）：覆盖发生的失败局——联合仲裁改变了
 *   冠军行动且该局最终落败（人工复核：覆盖是错误还是对手随机性）；
 * - conservative-keep（8 保守覆盖过度，代理判据）：门控触发、未覆盖、且
 *   挑战者存在（candidateCount>1）的失败局聚合——覆盖边际是否系统性
 *   过度保守须结合对照实验（overrideMargin 消融）判定，此处仅披露频率；
 * - outcome-only-loss（10 正确决策仍输）：全程零覆盖、零饥饿的失败局——
 *   没有任何联合仲裁介入，落败归因于隐藏信息/对手随机性/对手更强，
 *   不构成"决策实际错误"的证据（禁止倒推）；
 * - no-search-loss（候选生成/搜索缺口复核池）：失败局中门控率显著低于
 *   胜局的席位聚合——可能存在竞争未触发门控的盲区（7 竞争门控误判的
 *   代理证据，须局面级人工复核确认）。
 *
 * 其余类别（1/2/3/4/5/6）需要反事实搜索或对手模型反演，超出自动分类
 * 边界——本工具输出上述可证子集 + 复现数据集（种子/座位/预算完整），
 * 人工与后续自动进化流程在其上做反事实分析。
 *
 * 用法：
 *   node training/joint/failure-diagnostics.mjs --players 4 --seeds 40 \
 *     --budget 100 [--block tune] [--pool classic] [--out dir]
 * 流程：duel 采集候选席位逐决策诊断流 → 终局配对 → 失败局分类 → 报告。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAblationCell } from './duel.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

function parseArgs() {
  const args = { players: 4, seeds: 40, budget: 100, block: 'tune', pool: 'classic', candidate: 'js5', outDir: resolve(REPO_ROOT, 'training/reports/phase6-task-h') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--players') args.players = Number(argv[++i]);
    else if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--budget') args.budget = Number(argv[++i]);
    else if (argv[i] === '--block') args.block = argv[++i];
    else if (argv[i] === '--pool') args.pool = argv[++i];
    else if (argv[i] === '--candidate') args.candidate = argv[++i];
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

const BLOCK_BASE = { tune: 1_310_000_000, 'phase6-dev': 1_352_000_000, 'phase6-tune': 1_353_000_000 };

function classify(seedRows, gameOutcome) {
  const gatedRows = seedRows.filter(r => r.gated === true);
  const overrides = gatedRows.filter(r => r.action && r.championAction && JSON.stringify(r.action) !== JSON.stringify(r.championAction));
  const starved = gatedRows.filter(r => r.rollouts === 0);
  const lowTrials = gatedRows.filter(r => r.rollouts > 0 && (r.chosenTrials ?? 0) <= 1);
  const ungated = seedRows.filter(r => r.gated === false || r.gated === null);
  return {
    totalDecisions: seedRows.length,
    gatedDecisions: gatedRows.length,
    overrides: overrides.length,
    starved: starved.length,
    lowTrials: lowTrials.length,
    won: gameOutcome.won === true,
    // 主分类（优先级：预算不足 > 覆盖复核 > 无搜索盲区 > 纯结果性失败）。
    primaryClass: starved.length > 0 ? 'budget-starved'
      : overrides.length > 0 ? 'override-loss'
      : gatedRows.length === 0 ? 'no-search-loss'
      : 'outcome-only-loss',
    // 复现数据集：完整决策流（种子/座位/行动/分数）供反事实分析。
    decisionStream: seedRows.map(r => ({
      turn: r.turnNumber, seat: r.seat, gated: r.gated,
      action: r.action, championAction: r.championAction,
      chosenMean: r.chosenMean, chosenSe: r.chosenSe, chosenTrials: r.chosenTrials,
      rollouts: r.rollouts, elapsedMs: r.elapsedMs,
      candidateCount: r.candidateCount, racingEliminated: r.racingEliminated,
    })),
  };
}

async function main() {
  const args = parseArgs();
  const seedBase = BLOCK_BASE[args.block];
  if (!seedBase) throw new Error(`--block 必须是 ${Object.keys(BLOCK_BASE).join('|')}`);
  const diagnostics = [];
  process.stdout.write(`采集 ${args.candidate} ${args.players}人 ${args.seeds}种子诊断流（budget=${args.budget}ms）...\n`);
  const cell = runAblationCell({
    candidateId: args.candidate, seatCount: args.players, seeds: args.seeds, seedBase,
    jointOptions: { budgetMs: args.budget }, pool: args.pool, diagnostics,
  });
  // 失败局 = 候选席位未获第一名（方向 A：单席位；方向 B：阵营未夺冠也计入，
  // 单独披露）。
  const games = cell.games.filter(g => g.status === 'finished');
  const lostGames = games.filter(g => g.won === false);
  const rowsByGame = new Map();
  for (const d of diagnostics) {
    const key = `${d.seed}:${d.direction}`;
    (rowsByGame.get(key) ?? rowsByGame.set(key, []).get(key)).push(d);
  }
  const failures = lostGames.map(g => {
    const rows = rowsByGame.get(`${g.seed}:${g.direction}`) ?? [];
    const c = classify(rows, g);
    return { seed: g.seed, direction: g.direction, seatCount: g.seatCount, ...c };
  });
  const taxonomy = failures.reduce((acc, f) => { acc[f.primaryClass] = (acc[f.primaryClass] ?? 0) + 1; return acc; }, {});
  const wonGames = games.filter(g => g.won === true).length;
  const report = {
    schema: 'century-failure-diagnostics-v1',
    date: new Date().toISOString(),
    candidate: args.candidate, players: args.players, seeds: args.seeds, budgetMs: args.budget,
    pool: args.pool, block: args.block,
    games: games.length, won: wonGames, lost: lostGames.length,
    lossRate: games.length ? Number((lostGames.length / games.length).toFixed(4)) : null,
    taxonomy,
    // 诚实边界：分类基于决策流证据的自动代理判据，override-loss/no-search-loss
    // 是"人工复核池"而非自动判定错误；outcome-only-loss 不构成决策错误的证据。
    caveats: [
      'override-loss = 覆盖与落败共存，须反事实复核后才能归因决策错误',
      'no-search-loss = 门控零触发的失败，是竞争门控误判的代理证据',
      'outcome-only-loss = 决策流无任何仲裁介入，禁止倒推为决策错误',
    ],
    failures,
  };
  mkdirSync(args.outDir, { recursive: true });
  const out = resolve(args.outDir, `failure-diagnostics-${args.candidate}-${args.players}p-${args.seeds}s.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`完成：${games.length} 局，胜 ${wonGames}，负 ${lostGames.length}`);
  console.log(`失败分类：${JSON.stringify(taxonomy)}`);
  console.log(`结果已写入：${out}`);
}

main().catch(error => { console.error(error); process.exit(1); });
