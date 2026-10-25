/** 预算矩阵分析（AI6 第六阶段·任务 B 输出）。
 *
 * 输入：budget-matrix.mjs 产物目录（training/reports/phase6-task-b）。
 * 输出（任务书 B4）：
 * - 预算—第一名率曲线（方向 A/B 分列 + 合并，按人数）；
 * - 预算—平均名次曲线；
 * - 预算—有效模拟次数曲线（门控率 / 每决策试验数 / 饥饿回退率）；
 * - 边际收益（相邻预算配对差，种子级配对 bootstrap，复用 compare.mjs）；
 * - 三问分答（B2）：同算法预算阶梯 / 同预算算法对照 / 对实战版本参考。
 *
 * 用法：node training/joint/budget-curve.mjs [--dir training/reports/phase6-task-b]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pairedComparison, pairedComparisonDirectional } from './compare.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

function parseArgs() {
  const dir = resolve(REPO_ROOT, process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : 'training/reports/phase6-task-b');
  return { dir };
}

function loadCells(dir) {
  const cells = [];
  // 递归遍历（格子位于 <players>p/b<budget>ms/<file> 两层结构）。
  const walk = (rel) => {
    const abs = resolve(dir, rel);
    let entries;
    try { entries = readdirSync(abs); } catch { return; }
    for (const f of entries) {
      const relPath = rel ? `${rel}/${f}` : f;
      let doc;
      try { doc = JSON.parse(readFileSync(resolve(dir, relPath), 'utf8')); }
      catch { walk(relPath); continue; } // 目录 → 递归；JSON → 解析
      if (doc.schema !== 'century-joint-search-ablation-v1') continue;
      for (const cell of doc.cells) cells.push({ doc, cell, file: relPath });
    }
  };
  walk('');
  return cells;
}

const fmtCI = ci => `[${(ci[0] * 100).toFixed(1)},${(ci[1] * 100).toFixed(1)}]`;

async function main() {
  const { dir } = parseArgs();
  const manifestPath = resolve(dir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const cells = loadCells(dir);
  if (!cells.length) throw new Error(`${dir} 无 ablation 产物`);

  // 文件组织：<players>p/b<budget>ms/ablation-phase6-budget-<candidate>-<players>-<seeds>s.json
  //（每格独立子目录——duel 文件名固定，共用目录会同名覆盖，第五阶段教训）。
  const byKey = new Map();
  for (const { doc, cell, file } of cells) {
    const m = file.match(/^(\d)p\/b(\d+)ms\/ablation-phase6-budget-([a-z0-9-]+)-\1-(\d+)s\.json$/);
    if (!m) continue;
    byKey.set(`${m[1]}p:${m[3]}:b${m[2]}`, { doc, cell, players: Number(m[1]), candidate: m[3], budget: Number(m[2]) });
  }

  const lines = [];
  const playersList = [...new Set([...byKey.values()].map(v => v.players))].sort();
  const budgets = [...new Set([...byKey.values()].map(v => v.budget))].sort((a, b) => a - b);

  lines.push('# 预算—胜率曲线（同算法 JS5 阶梯）\n');
  for (const players of playersList) {
    lines.push(`## ${players} 人\n`);
    lines.push('| 预算 | 方向A 第一名率 | 方向B 阵营率 | 平均名次 | 门控率 | 每决策试验 | 饥饿回退率 | p95 延迟 ms |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const budget of budgets) {
      const v = byKey.get(`${players}p:js5:b${budget}`);
      if (!v) continue;
      const { cell } = v;
      const a = cell.directionA?.firstPlace, b = cell.directionB?.firstPlace;
      const joint = cell.jointSearch ?? {};
      const p95 = cell.latency?.p95 ?? cell.latency?.p95Ms ?? null;
      lines.push(`| ${budget}ms | ${a ? (a.point * 100).toFixed(1) + '% ' + fmtCI([a.lower, a.upper]) : '-'} | ${b ? (b.point * 100).toFixed(1) + '%' : '-'} | ${cell.meanRank ? cell.meanRank.mean.toFixed(2) : '-'} | ${joint.gateTriggerRate ?? '-'} | ${joint.meanRolloutsPerDecision ?? '-'} | ${joint.gatedStarvedFallbackRate ?? '-'} | ${p95 ?? '-'} |`);
    }
    lines.push('');
    // 相邻预算配对边际收益（同人数相邻预算：共享种子配对）。
    // 主判定 = 方向 A（单席位，pairedComparisonDirectional）；合并口径仅参考。
    for (let i = 1; i < budgets.length; i++) {
      const lo = byKey.get(`${players}p:js5:b${budgets[i - 1]}`);
      const hi = byKey.get(`${players}p:js5:b${budgets[i]}`);
      if (!lo || !hi) continue;
      try {
        const cmp = pairedComparisonDirectional(pathOf(dir, players, 'js5', budgets[i]), pathOf(dir, players, 'js5', budgets[i - 1]), { seatCount: players, directionFilter: 'A', iterations: 2000 });
        lines.push(`- 边际 ${budgets[i - 1]}→${budgets[i]}ms：方向A差 ${(cmp.firstPlaceDiff * 100).toFixed(1)}pp ${fmtCI(cmp.firstPlaceDiffCI)}｜${cmp.significance}`);
      } catch (e) {
        lines.push(`- 边际 ${budgets[i - 1]}→${budgets[i]}ms：配对失败（${String(e.message).slice(0, 80)}）`);
      }
    }
    lines.push('');
  }

  lines.push('# 同预算算法对照（JS6 vs JS5，任务 B2 比较二；方向A 主判定）\n');
  for (const players of playersList) {
    for (const budget of budgets) {
      const js6 = byKey.get(`${players}p:js6:b${budget}`);
      const js5 = byKey.get(`${players}p:js5:b${budget}`);
      if (!js6 || !js5) continue;
      try {
        const cmp = pairedComparisonDirectional(pathOf(dir, players, 'js6', budget), pathOf(dir, players, 'js5', budget), { seatCount: players, directionFilter: 'A', iterations: 2000 });
        lines.push(`- ${players}p @${budget}ms：JS6−JS5 方向A差 ${(cmp.firstPlaceDiff * 100).toFixed(1)}pp ${fmtCI(cmp.firstPlaceDiffCI)}｜${cmp.significance}｜分差 ${cmp.meanScoreDiff.toFixed(2)} ${fmtCI(cmp.meanScoreDiffCI)}`);
      } catch (e) {
        lines.push(`- ${players}p @${budget}ms：配对失败（${String(e.message).slice(0, 80)}）`);
      }
    }
  }

  const text = lines.join('\n');
  console.log(text);
  writeFileSync(resolve(dir, 'budget-curve.md'), text);
  const report = {
    schema: 'century-budget-curve-v1', date: new Date().toISOString(),
    machine: manifest?.machine ?? null, seeds: manifest?.seeds ?? null,
    budgetMatrix: manifest?.seedPartition ?? null, analysis: text,
  };
  writeFileSync(resolve(dir, 'budget-curve.json'), JSON.stringify(report, null, 2));
  console.log(`\n已写入：${resolve(dir, 'budget-curve.md')} 与 budget-curve.json`);
}

function pathOf(dir, players, candidate, budget) {
  const p = resolve(dir, `${players}p`, `b${budget}ms`, `ablation-phase6-budget-${candidate}-${players}-${seedTag(dir, players, candidate, budget)}s.json`);
  if (!existsSync(p)) throw new Error(`缺产物 ${p}`);
  return p;
}
function seedTag(dir, players, candidate, budget) {
  const f = readdirSync(resolve(dir, `${players}p`, `b${budget}ms`)).find(x => x.startsWith(`ablation-phase6-budget-${candidate}-`) && x.endsWith('.json'));
  if (!f) throw new Error(`缺产物 ${candidate}-b${budget}`);
  return f.match(/-(\d+)s\.json$/)[1];
}

main().catch(e => { console.error(e); process.exit(1); });
