/** JS5 真人对局诊断记录器（AI6 第五阶段·任务 G）。
 *
 * 目标：为后续真人对局验证准备最小诊断机制——记录 JS5 的决策时间、
 * 冠军原始建议行动、JS5 实际行动、竞争门控原因、行动覆盖与信心信息、
 * 对局结果和局面阶段。**不记录任何个人信息**（无用户标识/设备指纹/
 * 位置等；对局层面只有席位序号与公开游戏状态）。
 *
 * 实现方式（任务 G 纪律：不改变游戏功能和默认 AI）：独立训练侧工具——
 * 用 duel 协议跑 js5 对局并落盘逐决策 JSONL；正式网页 AI 路径不 import
 * 任何诊断代码。网页端的接入设计（未来真人验证时按需启用，缺省关闭）：
 *  - adapter.chooseJointAction 的返回值已含 joint.championAction / gated /
 *    contestedGoals / reason / stats（决策时间、rollouts）——UI 层可选消费；
 *  - 诊断开关必须显式传入（如 debug 选项），缺省不记录、不上报；
 *  - 数据落点为本地（离线），无网络传输。
 *
 * 用法：node training/joint/diagnostics.mjs --players 3 --seeds 10 [--budget 100] [--opponents classic|diverse]
 * 输出：training/reports/js5-phase5/diagnostics-<N>p.jsonl（逐决策）
 *       training/reports/js5-phase5/diagnostics-<N>p-games.json（对局结果）
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAblationCell, confirmSeedBase } from './duel.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

function parseArgs() {
  const args = { players: [3], seeds: 10, budget: 100, pool: 'classic', candidate: 'js5', outDir: resolve(REPO_ROOT, 'training/reports/js5-phase5') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--budget') args.budget = Number(argv[++i]);
    else if (argv[i] === '--pool') args.pool = argv[++i];
    else if (argv[i] === '--candidate') args.candidate = argv[++i];
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

async function main() {
  const { players, seeds, budget, pool, candidate, outDir } = parseArgs();
  mkdirSync(outDir, { recursive: true });
  for (const seatCount of players) {
    const seedBase = confirmSeedBase(seatCount, pool);
    const decisions = [];
    const jointOptions = { budgetMs: budget };
    const cell = runAblationCell({ candidateId: candidate, seatCount, seeds, seedBase, jointOptions, pool, diagnostics: decisions });
    // 决策记录与对局结果联接（同一 seed+direction）。
    const gamesBySeed = new Map(cell.games.map(g => [`${g.seed}:${g.direction}`, g]));
    const enriched = decisions.map(d => {
      const g = gamesBySeed.get(`${d.seed}:${d.direction}`);
      return {
        ...d,
        // 对局结果与局面阶段（任务 G 字段清单）。
        candidateWon: g?.won ?? null,
        candidateMeanScore: g?.meanScore ?? null,
        scoreDiff: g?.scoreDiff ?? null,
        moves: g?.moves ?? null,
        // 门控原因已内嵌于 reason（js5 reason 含争议目标与仲裁/直通标签）。
        championSuggested: d.championAction,
        js5Actual: d.action,
        overridden: d.championAction != null && JSON.stringify(d.championAction) !== JSON.stringify(d.action),
      };
    });
    const jsonl = resolve(outDir, `diagnostics-${seatCount}p.jsonl`);
    const games = resolve(outDir, `diagnostics-${seatCount}p-games.json`);
    writeFileSync(jsonl, enriched.map(d => JSON.stringify(d)).join('\n') + '\n');
    writeFileSync(games, JSON.stringify({ schema: 'century-js5-diagnostics-games-v1', seatCount, seeds, seedBase, pool, budget, cell }, null, 2));
    const gated = enriched.filter(d => d.gated === true).length;
    const overridden = enriched.filter(d => d.overridden).length;
    process.stdout.write(`[${seatCount}p] 决策 ${enriched.length} 条（门控 ${gated}，覆盖 ${overridden}）→ ${jsonl}\n`);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
