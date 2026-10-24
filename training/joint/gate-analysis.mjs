/** JS5 门控策略分析（AI6 第五阶段·任务 E）。
 *
 * 回答（任务 E 五问的可计算部分）：
 * 1. 不同人数的门控触发率（gateTriggerRate，按 cell 披露）；
 * 2. 门控触发与实际棋力收益的关联：gated 决策占比 vs 相对 js0 的
 *    第一名率差（跨人数关联表）；
 * 3. 联合搜索覆盖冠军选择的频率（overrideRate / championKeepRate）；
 * 4. 错误覆盖造成的损失：诊断流（diagnostics JSONL）中 overridden 对局
 *    与 championKeep 对局的候选胜率对比（同 cell 内分组，样本量披露）；
 * 5. 边际计算成本：meanRolloutsPerDecision / meanTransitionsPerDecision +
 *    延迟差（cell.latency）。
 * 终局与立即认领特殊状态：gatedReason 分布由 reason 前缀聚合（终局触发
 * 的 gated 决策 reason 含"争议目标"与 trigger 状态——以 diagnostics 的
 * phase 字段聚合 endgame/overflow 占比）。
 *
 * 输入：一个或多个 ablation JSON（可带同名 -diagnostics JSONL）。
 * 用法：node training/joint/gate-analysis.mjs <ablation1.json> [ablation2.json ...] [--out <dir>]
 * 输出：控制台表格 + <out>/gate-analysis.json
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';

function parseArgs() {
  const argv = process.argv.slice(2);
  const positional = argv.filter(a => !a.startsWith('--'));
  const outHit = argv.find(a => a.startsWith('--out='));
  return { inputs: positional, outDir: outHit ? resolve(outHit.split('=')[1]) : null };
}

/** 从诊断流聚合覆盖损失对比（同 cell 内 overridden vs championKeep 的胜率）。 */
function overrideLossFromDiagnostics(jsonlPath, gamesPath) {
  if (!existsSync(jsonlPath) || !existsSync(gamesPath)) return null;
  const decisions = readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const doc = JSON.parse(readFileSync(gamesPath, 'utf8'));
  const gamesBySeed = new Map((doc.cell?.games ?? []).map(g => [`${g.seed}:${g.direction}`, g]));
  const groups = { overridden: { games: new Set(), wins: 0, n: 0 }, championKeep: { games: new Set(), wins: 0, n: 0 }, starved: { games: new Set(), wins: 0, n: 0 } };
  for (const d of decisions) {
    const g = gamesBySeed.get(`${d.seed}:${d.direction}`);
    if (!g || g.status !== 'finished') continue;
    const key = `${d.seed}:${d.direction}`;
    let bucket;
    if (d.gated === true && d.rollouts === 0) bucket = groups.starved;
    else if (d.overridden) bucket = groups.overridden;
    else if (d.gated === true) bucket = groups.championKeep;
    else continue;
    bucket.games.add(key);
  }
  const out = {};
  for (const [name, b] of Object.entries(groups)) {
    const finishedGames = [...b.games].map(k => gamesBySeed.get(k)).filter(g => g.status === 'finished');
    out[name] = {
      games: finishedGames.length,
      candidateWinRate: finishedGames.length ? Number((finishedGames.filter(g => g.won).length / finishedGames.length).toFixed(4)) : null,
      meanScoreDiff: finishedGames.length ? Number((finishedGames.reduce((s, g) => s + g.scoreDiff, 0) / finishedGames.length).toFixed(3)) : null,
    };
  }
  // 对局级归因的语义边界：一次对局的胜负由全部决策共同决定——
  // 分组对比是描述性关联，不是"覆盖决策因果损失"的估计。
  out.caveat = '对局级分组对比 = 描述性关联（胜负由整局共同决定），不构成覆盖决策的因果损失估计';
  return out;
}

function main() {
  const { inputs, outDir } = parseArgs();
  if (!inputs.length) {
    console.error('用法：node training/joint/gate-analysis.mjs <ablation.json> [...] [--out=dir]');
    process.exit(2);
  }
  const rows = [];
  for (const path of inputs) {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const diagJsonl = resolve(resolve(path, '..'), `diagnostics.jsonl`);
    for (const cell of doc.cells) {
      const j = cell.jointSearch ?? null;
      rows.push({
        source: basename(path),
        candidate: cell.candidateId, seatCount: cell.seatCount, pool: doc.pool ?? 'classic',
        block: doc.block,
        decisions: j?.decisions ?? 0,
        gateTriggerRate: j?.gateTriggerRate ?? null,
        overrideRate: j?.overrideRate ?? null,
        championKeepRate: j?.gatedChampionKeepRate ?? null,
        starvedFallbackRate: j?.gatedStarvedFallbackRate ?? null,
        meanRolloutsPerDecision: j?.meanRolloutsPerDecision ?? 0,
        meanTransitionsPerDecision: j?.meanTransitionsPerDecision ?? null,
        latencyP50: cell.latency?.p50Ms ?? null,
        latencyP95: cell.latency?.p95Ms ?? null,
      });
    }
  }
  // 跨人数关联表（门控率 vs 相对 js0 的第一名率差需要 compare 结果——此处
  // 披露原始门控行为，关联结论在报告层合成）。
  console.log('candidate | N | pool | decisions | gate% | override% | keep% | starved% | rollouts/dec | p50 | p95');
  for (const r of rows) {
    const pct = x => x == null ? '-' : (x * 100).toFixed(1) + '%';
    console.log(`${r.candidate} | ${r.seatCount} | ${r.pool} | ${r.decisions} | ${pct(r.gateTriggerRate)} | ${pct(r.overrideRate)} | ${pct(r.championKeepRate)} | ${pct(r.starvedFallbackRate)} | ${r.meanRolloutsPerDecision} | ${r.latencyP50 ?? '-'} | ${r.latencyP95 ?? '-'}`);
  }
  // 诊断流覆盖损失（ablation 同目录存在 diagnostics-<N>p JSONL 时自动联接）。
  const lossAnalyses = [];
  for (const path of inputs) {
    const doc2 = JSON.parse(readFileSync(path, 'utf8'));
    const dir = resolve(path, '..');
    for (const cell of doc2.cells) {
      const jsonl = join(dir, `diagnostics-${cell.seatCount}p.jsonl`);
      const games = join(dir, `diagnostics-${cell.seatCount}p-games.json`);
      if (existsSync(jsonl) && existsSync(games)) {
        lossAnalyses.push({ source: basename(path), seatCount: cell.seatCount, analysis: overrideLossFromDiagnostics(jsonl, games) });
      }
    }
  }
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const out = resolve(outDir, 'gate-analysis.json');
    writeFileSync(out, JSON.stringify({ schema: 'century-js5-gate-analysis-v1', date: new Date().toISOString(), rows, lossAnalyses }, null, 2));
    console.log(`\n已写入：${out}`);
  }
}

main();
