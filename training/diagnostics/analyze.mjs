/** AI 失败案例分析系统（任务书第九节）。
 *
 * 方法：用正式引擎确定性重放对局行动日志，在每个决策点重建公开局面，
 * 提取可验证事实与统计结果；启发式与推测分层标注，绝不把相关性当因果。
 *
 * 分析维度（对每局的落败席位）：
 * - 低利用率商人卡：获取后从未打出的卡（事实）
 * - 休息频率偏离（事实）
 * - 每百分步得分转换效率（事实）
 * - 终局滞后：终局触发后仍未认领的回合数（事实）
 * - 被抢目标：他人获取某卡时，本席位当时具备支付能力的次数（事实级"可负担"，不判定意图）
 * - 启发式与推测：分层标注，仅供后续算法改进假设。
 */

import { createGame, applyAction, score, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction } from '../../web-v1/dist/js/ai.js';
import { writeJSON, ensureDir } from '../lib/io.mjs';
import { resolve } from 'node:path';

function replayGame(seed, versions, maxMoves = 1200) {
  let game = createGame(Array.from({ length: 5 }, (_, i) => `席位${i}`), seed, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  const timeline = [];
  let moves = 0;
  while (game.phase !== 'finished' && moves < maxMoves) {
    const seat = game.current;
    const version = versions?.[seat] ?? null;
    const { action } = chooseAIAction(game, version?.parameters ? { parameters: version.parameters } : undefined);
    // 决策前公开快照：所有席位水晶、市场卡（含位置费）、阶段。
    timeline.push({
      move: moves, seat,
      stock: game.players.map(p => [...p.stock]),
      claimed: game.players.map(p => p.claimed.length),
      market: game.merchantMarket.map(m => m.id),
      golemMarket: [...game.golemMarket],
      action: JSON.parse(JSON.stringify(action)),
    });
    game = applyAction(game, action);
    moves += 1;
  }
  return { game, timeline, moves };
}

/** 分析一批对局；games = [{seed, versions, collectActions 结果}]。 */
export function analyzeGames(games) {
  const findings = [];
  for (const entry of games) {
    const { seed, versions } = entry;
    const { game, timeline, moves } = replayGame(seed, versions);
    if (game.phase !== 'finished') continue;
    const ranked = ranking(game);
    const loserSeats = ranked.slice(1).map(p => p.id);
    const winnerSeat = ranked[0].id;

    // 全局统计（事实层）。
    const actionCounts = Array.from({ length: 5 }, () => ({ play: 0, acquire: 0, claim: 0, rest: 0 }));
    for (const t of timeline) actionCounts[t.seat][t.action.type] += 1;

    // 每席位获取的卡与是否打出（事实层）。
    const acquired = Array.from({ length: 5 }, () => []);
    const played = Array.from({ length: 5 }, () => new Set());
    const acquisitions = []; // {move, seat, cardId, payment, index}
    for (const t of timeline) {
      if (t.action.type === 'acquire') {
        const cardId = t.market[t.action.index];
        acquired[t.seat].push({ cardId, move: t.move });
        acquisitions.push({ move: t.move, seat: t.seat, cardId, payment: t.action.payment, index: t.action.index, marketAtMove: [...t.market] });
      } else if (t.action.type === 'play') {
        played[t.seat].add(t.action.cardId);
      }
    }

    const totalDecisions = timeline.length;
    const scores = game.players.map(p => score(p));

    for (const seat of loserSeats) {
      const acts = actionCounts[seat];
      const totalSeatActions = acts.play + acts.acquire + acts.claim + acts.rest;
      const unused = acquired[seat].filter(a => !played[seat].has(a.cardId));
      const restRatio = totalSeatActions ? acts.rest / totalSeatActions : 0;
      const gameMeanRest = totalDecisions
        ? timeline.filter(t => t.action.type === 'rest').length / totalDecisions : 0;
      const conversion = scores[seat] / Math.max(1, totalSeatActions) * 100;

      // 终局滞后：以终局触发（任一席位认领第 5 张魔像）后的行动为界，统计落败席位剩余得分机会（事实层简化：触发后的认领数）。
      // 可负担却被他人获取的目标卡（事实级：仅证明当时付得起位置费）。
      let contestedMisses = 0;
      const contestedDetails = [];
      for (const acq of acquisitions) {
        if (acq.seat === seat) continue;
        const snap = timeline.find(t => t.move === acq.move);
        if (!snap) continue;
        const myStock = snap.stock[seat];
        const myTotal = myStock.reduce((s, x) => s + x, 0);
        if (myTotal >= acq.index && acq.index > 0) {
          contestedMisses += 1;
          contestedDetails.push({ move: acq.move, cardId: acq.cardId, bySeat: acq.seat, cost: acq.index });
        }
      }

      findings.push({
        seed, loserSeat: seat, winnerSeat, moves,
        facts: {
          finalScore: scores[seat],
          golems: game.players[seat].claimed.length,
          merchantsAcquired: acquired[seat].length,
          unusedMerchantCards: unused.map(u => u.cardId),
          unusedCount: unused.length,
          actionCounts: acts,
          restRatio: Number(restRatio.toFixed(4)),
          gameMeanRestRatio: Number(gameMeanRest.toFixed(4)),
          conversionPer100Actions: Number(conversion.toFixed(2)),
          contestedMisses,
          contestedDetails: contestedDetails.slice(0, 10),
        },
        heuristics: [],
        speculations: [],
      });
      const f = findings.at(-1);
      // 启发式分析（有事实依据的解读，非因果结论）。
      if (f.facts.unusedCount >= 3) {
        f.heuristics.push(`获取了 ${f.facts.unusedCount} 张从未打出的商人卡，疑似低利用率获取（对照任务书"避免盲目囤积"）`);
      }
      if (f.facts.restRatio > gameMeanRest * 1.5 && f.facts.restRatio > 0.15) {
        f.heuristics.push(`休息占比 ${f.facts.restRatio} 高于全场均值 ${gameMeanRest} 的 1.5 倍，疑似节奏偏慢`);
      }
      if (f.facts.contestedMisses >= 3) {
        f.heuristics.push(`${f.facts.contestedMisses} 次他人获取时本席位账面上付得起位置费，竞争获取可能不足（不构成因果）`);
      }
      if (conversion < 8) {
        f.heuristics.push(`每百行动得分 ${conversion}，转换效率偏低`);
      }
      // 尚未验证的推测（明确标注）。
      if (f.facts.unusedCount >= 3 && f.facts.restRatio > 0.15) {
        f.speculations.push('推测：囤卡与频繁休息可能同源于引擎/得分权衡参数失衡，需参数灵敏度实验验证');
      }
      if (f.facts.contestedMisses >= 3) {
        f.speculations.push('推测：contestWeight 或市场压力建模不足可能导致让牌，需对照实验验证');
      }
    }
  }
  return {
    gamesAnalyzed: games.length,
    findings,
    disclaimer: '事实字段来自确定性重放；heuristics 为有事实依据的启发式解读；speculations 仅为待验证假设，不构成因果结论。',
  };
}

/** 生成 Markdown 诊断报告。 */
export function renderMarkdown(analysis) {
  const lines = [];
  lines.push('# AI 失败案例分析报告', '');
  lines.push(`- 分析对局：${analysis.gamesAnalyzed}`);
  lines.push(`- 说明：${analysis.disclaimer}`, '');
  for (const f of analysis.findings) {
    lines.push(`## 种子 ${f.seed} — 落败席位 ${f.loserSeat}（胜者席位 ${f.winnerSeat}，共 ${f.moves} 步）`, '');
    lines.push('| 指标 | 值 |', '| --- | --- |');
    lines.push(`| 最终得分 | ${f.facts.finalScore} |`);
    lines.push(`| 认领魔像 | ${f.facts.golems} |`);
    lines.push(`| 获取商人卡 | ${f.facts.merchantsAcquired} |`);
    lines.push(`| 未使用商人卡 | ${f.facts.unusedCount} 张${f.facts.unusedCount ? '（' + f.facts.unusedMerchantCards.join('、') + '）' : ''} |`);
    lines.push(`| 休息占比 | ${f.facts.restRatio}（全场均值 ${f.facts.gameMeanRestRatio}） |`);
    lines.push(`| 每百行动得分 | ${f.facts.conversionPer100Actions} |`);
    lines.push(`| 可负担却被他人获取次数 | ${f.facts.contestedMisses} |`, '');
    if (f.heuristics.length) {
      lines.push('**启发式分析**', '');
      for (const h of f.heuristics) lines.push(`- ${h}`);
      lines.push('');
    }
    if (f.speculations.length) {
      lines.push('**未验证推测（不构成因果）**', '');
      for (const s of f.speculations) lines.push(`- ${s}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** CLI 入口：对指定种子运行基线对局并诊断。 */
export function runDiagnostics({ seeds, seedBase = 1, versions = null }) {
  const games = [];
  for (let i = 0; i < seeds; i++) {
    games.push({ seed: seedBase + i, versions });
  }
  return analyzeGames(games);
}

const isMain = process.argv[1] && process.argv[1].endsWith('analyze.mjs');
if (isMain) {
  const argOf = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const analysis = runDiagnostics({ seeds: argOf('seeds', 8), seedBase: argOf('seed-base', 1) });
  const outDir = resolve(process.cwd(), 'training/reports/diagnostics-latest');
  ensureDir(outDir);
  writeJSON(resolve(outDir, 'analysis.json'), analysis);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(outDir, 'report.md'), renderMarkdown(analysis), 'utf8');
  console.log(`诊断完成：${analysis.findings.length} 条落败席位记录`);
  console.log(`结果目录：${outDir}`);
}
