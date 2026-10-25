/** 对手强度分层披露（AI6 第六阶段·任务 F3）。
 *
 * 任务书 §九 F3 要求「至少建立弱/中/强/多结构混编池」并完整披露对手池分层。
 * 本工具不新建对局——直接从既有确认实验（任务 F confirm 与任务 A2）的
 * 逐局 versionsIds（席位→版本 id）提取候选对每类对手的胜负，形成
 * 「对手身份 × 候选胜率」分层披露。分层维度（按对手身份的先验强度）：
 * - 强：joint-js5-frozen（当前正式冠军）、joint-js5（池内冠军席）
 * - 中：风格变体（style-*、@tempo/@contest/@engine，冠军族权重扰动）
 * - 弱：neutral-baseline（v4.0 基线）、random-legal（随机合法）
 * - 独立结构：ai4-struct-beam-rollout（历史 AI4 冠军）
 *
 * 诚实边界：分层是「对手身份」的事后披露，不是预注册的多重检验终点；
 * 逐层样本量较小（约 40-120 局/格），CI 宽，仅供校验「不能仅靠击败弱对手
 * 证明棋力」与「是否存在被特定风格克制的迹象」。
 *
 * 用法：node training/joint/opponent-stratification.mjs
 * 输入：training/reports/phase6-task-f/{classic,diverse}/<p>/ablation-*.json
 * 输出：training/reports/phase6-task-f/opponent-stratification.json + 控制台表
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { wilsonCI } from '../evaluator/stats.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const TIER_OF = {
  'joint-js5-frozen': '强（当前冠军）',
  'joint-js5': '强（当前冠军）',
  'ai4-struct-beam-rollout': '独立结构（AI4 历史冠军）',
  'neutral-baseline': '弱（基线）',
  'random-legal': '弱（随机合法）',
};
const tierOf = id => TIER_OF[id] ?? (id.startsWith('style-') || id.includes('@') ? '中（风格变体）' : `其他（${id}）`);

function collect(dirRel) {
  const dir = resolve(REPO_ROOT, dirRel);
  const rows = [];
  const walk = rel => {
    let entries;
    try { entries = readdirSync(resolve(dir, rel)); } catch { return; }
    for (const f of entries) {
      const relPath = rel ? `${rel}/${f}` : f;
      if (f.endsWith('.json')) {
        const doc = JSON.parse(readFileSync(resolve(dir, relPath), 'utf8'));
        if (doc.schema !== 'century-joint-search-ablation-v1') continue;
        for (const cell of doc.cells) {
          for (const g of cell.games ?? []) {
            if (g.status !== 'finished' || g.won === null || g.won === undefined) continue;
            const seats = new Set(g.candidateSeats ?? []);
            const opponents = (g.versionsIds ?? []).filter((_, i) => !seats.has(i));
            for (const opp of opponents) rows.push({ file: relPath, players: cell.seatCount, candidate: cell.candidateId, opponent: opp, won: g.won === true });
          }
        }
      } else walk(relPath);
    }
  };
  walk('');
  return rows;
}

function main() {
  const fRows = collect('training/reports/phase6-task-f');
  const a2Rows = collect('training/reports/phase6-task-a');
  const report = { schema: 'century-opponent-stratification-v1', date: new Date().toISOString(), sources: ['任务 F confirm（js6 与 js5-frozen 候选，phase6-confirm 块）', '任务 A2（js5 与 legacy-js0 候选，phase6-2p 块）'], tiers: {}, caveat: '分层为对手身份的事后披露（非预注册终点）；逐层样本量小、CI 宽，仅供强度谱系校验' };

  const aggregate = (rows, label) => {
    const byOpp = new Map();
    for (const r of rows) {
      const key = `${r.candidate} vs ${r.opponent}`;
      const e = byOpp.get(key) ?? { candidate: r.candidate, opponent: r.opponent, tier: tierOf(r.opponent), games: 0, wins: 0, players: new Set() };
      e.games += 1; e.wins += r.won ? 1 : 0; e.players.add(r.players);
      byOpp.set(key, e);
    }
    return [...byOpp.values()].map(e => ({ ...e, players: [...e.players].sort().join(','), firstPlaceRate: Number((e.wins / e.games).toFixed(4)), wilson: wilsonCI(e.wins, e.games), source: label }))
      .sort((a, b) => a.tier.localeCompare(b.tier) || b.games - a.games);
  };

  report.tiers['F 确认（js6 与 js5-frozen 候选）'] = aggregate(fRows, 'phase6-task-f');
  report.tiers['任务 A2（js5 vs legacy-js0）'] = aggregate(a2Rows, 'phase6-task-a');

  const lines = ['# 对手强度分层披露（任务 F3，来自既有确认对局）', ''];
  for (const [label, rows] of Object.entries(report.tiers)) {
    lines.push(`## ${label}`, '', '| 候选 | 对手 | 层级 | 人数 | 局数 | 候选第一名率 | Wilson 95% CI |', '|---|---|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.candidate} | ${r.opponent} | ${r.tier} | ${r.players} | ${r.games} | ${(r.firstPlaceRate * 100).toFixed(1)}% | [${(r.wilson.lower * 100).toFixed(1)}, ${(r.wilson.upper * 100).toFixed(1)}] |`);
    }
    lines.push('');
  }
  const text = lines.join('\n');
  console.log(text);
  writeFileSync(resolve(REPO_ROOT, 'training/reports/phase6-task-f/opponent-stratification.json'), JSON.stringify(report, null, 2));
  writeFileSync(resolve(REPO_ROOT, 'training/reports/phase6-task-f/opponent-stratification.md'), text);
  console.log(`已写入 opponent-stratification.{json,md}`);
}

main();
