#!/usr/bin/env node
/** 联赛报告·按人数分层重算工具（P0-3 配套证据更正）。
 *
 * 从已归档 league-report.json 的**逐局原始数据**（games 数组）重新生成分层统计，
 * 不重跑对局、不覆盖原始文件、不补造数据。产出：
 * - 逐 (seatCount, protocol, focus, opponent) 的 局数/第一名次数/第一名率/
 *   Wilson 95% CI/座位分解/异常局/焦点版本指纹；
 * - 与原 v1 合并单元格的对照（原合并数 = 各层之和，可审计对账）；
 * - 每个对手在每个人数下相对 50%（2p）或 1/N（≥3p 方向 A）机会基准的判定。
 *
 * 用法：node training/adversarial/stratify-league-report.mjs --in <league-report.json> [--out <corrections.json>]
 * 退出码：0=成功（无论统计结论如何——工具不裁决科学结论，只产出诚实分层）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { wilsonCI } = await import(`file://${resolve(here, '..', 'evaluator', 'stats.mjs')}`);

function parseArgs() {
  const args = { in: null, out: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') args.in = resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = resolve(argv[++i]);
  }
  if (!args.in) throw new Error('用法：--in <league-report.json> [--out <corrections.json>]');
  return args;
}

/** 单元格分层聚合（与 league.mjs v2 buildWinRateMatrix 同口径，输入为归档 games）。 */
function stratify(games) {
  const cells = new Map();
  for (const g of games) {
    const key = `${g.focusId}\u0000${g.opponentId}\u0000${g.direction}@${g.seatCount}`;
    if (!cells.has(key)) {
      cells.set(key, {
        focusId: g.focusId, opponentId: g.opponentId, direction: g.direction,
        seatCount: g.seatCount, protocol: `${g.direction}@${g.seatCount}`,
        games: 0, wins: 0, anomalies: 0, bySeat: {}, focusFingerprints: new Set(),
      });
    }
    const cell = cells.get(key);
    if (g.status !== 'finished') { cell.anomalies += 1; continue; }
    cell.games += 1;
    const won = g.winnerSeat === g.focusSeat;
    if (won) cell.wins += 1;
    if (Array.isArray(g.fingerprints) && g.fingerprints[0]) cell.focusFingerprints.add(g.fingerprints[0]);
    const seatKey = String(g.focusSeat);
    (cell.bySeat[seatKey] ??= { games: 0, wins: 0 });
    cell.bySeat[seatKey].games += 1;
    if (won) cell.bySeat[seatKey].wins += 1;
  }
  for (const cell of cells.values()) {
    cell.firstPlaceRate = cell.games ? Number((cell.wins / cell.games).toFixed(4)) : null;
    cell.wilson = cell.games ? wilsonCI(cell.wins, cell.games) : null;
    cell.chanceBaseline = cell.direction === 'h2h' ? 0.5 : 1 / cell.seatCount;
    cell.vsChance = cell.firstPlaceRate === null ? null
      : cell.wilson.lower > cell.chanceBaseline ? 'above'
      : cell.wilson.upper < cell.chanceBaseline ? 'below' : 'inconclusive';
    cell.focusFingerprints = [...cell.focusFingerprints].sort();
    cell.bySeat = Object.fromEntries(Object.entries(cell.bySeat).map(([seat, s]) => [
      seat, { ...s, firstPlaceRate: Number((s.wins / s.games).toFixed(4)) },
    ]));
  }
  return [...cells.values()].sort((a, b) =>
    a.seatCount - b.seatCount || a.focusId.localeCompare(b.focusId) || a.opponentId.localeCompare(b.opponentId));
}

/** 原报告 v1 矩阵（合并单元格）对账。
 * v1 规则：(A,B) 合并数 = 自己为焦点的全部层 finished + h2h 互补计数
 *（B 为焦点的 h2h 层同时填充 (A,B)）。对账按此口径逐局守恒。 */
function reconcileWithV1(report, cells) {
  const v1 = report.matrix ?? {};
  const mismatches = [];
  const pairs = new Set(cells.map(c => `${c.focusId}\u0000${c.opponentId}`));
  for (const key of pairs) {
    const [focusId, opponentId] = key.split('\u0000');
    const legacy = v1[focusId]?.[opponentId];
    if (!legacy) { mismatches.push(`${key}: v1 无此单元格`); continue; }
    const own = cells.filter(c => c.focusId === focusId && c.opponentId === opponentId).reduce((s, c) => s + c.games, 0);
    const complementary = cells.filter(c => c.focusId === opponentId && c.opponentId === focusId && c.direction === 'h2h').reduce((s, c) => s + c.games, 0);
    if (legacy.games !== own + complementary) {
      mismatches.push(`${key}: v1 合并 games=${legacy.games} ≠ 分层合计 own=${own} + h2h互补=${complementary}`);
    }
  }
  return mismatches;
}

const args = parseArgs();
const report = JSON.parse(readFileSync(args.in, 'utf8'));
if (!Array.isArray(report.games)) throw new Error('归档报告缺少逐局 games 数组（无法从原始数据重算）');
const cells = stratify(report.games);
const mismatches = reconcileWithV1(report, cells);

const byOpponent = {};
for (const cell of cells) {
  (byOpponent[cell.focusId] ??= {})[`${cell.opponentId}@${cell.protocol}`] = {
    games: cell.games, wins: cell.wins, firstPlaceRate: cell.firstPlaceRate,
    wilson: cell.wilson, chanceBaseline: cell.chanceBaseline, vsChance: cell.vsChance,
    anomalies: cell.anomalies,
  };
}

const corrections = {
  schema: 'century-adversarial-league-stratified-corrections-v1',
  date: new Date().toISOString(),
  source: {
    file: args.in,
    schema: report.schema,
    engineBundleSha256: report.engineBundleSha256,
    registryFingerprint: report.registrySnapshot?.registryFingerprint ?? null,
    jointOverrides: report.jointOverrides ?? null,
    totals: report.totals,
  },
  method: '从逐局原始 games 数组重算；(seatCount, protocol, focus, opponent) 分层统计；Wilson 95% CI 按层独立计算，绝不跨人数/协议合并。异常局不计入胜率、按层披露。',
  v1Reconciliation: {
    note: '原 v1 报告以 (focus, opponent) 合并各人数/协议——分层合计与原合并单元格对账（逐局数守恒）。',
    mismatches,
  },
  stratifiedCells: cells,
  byOpponent,
  interpretation: {
    note: 'vsChance 仅描述该层样本下 Wilson 95% CI 相对机会基准的位置；2p 基准 0.5、≥3p 方向 A 基准 1/N。跨层不得合并判定；结论外推需独立验证。',
  },
};

const outPath = args.out ?? resolve(dirname(args.in), 'stratified-corrections.json');
writeFileSync(outPath, JSON.stringify(corrections, null, 2) + '\n');
console.log(`分层重算完成：${cells.length} 个分层单元 → ${outPath}`);
console.log(`v1 对账：${mismatches.length ? `发现 ${mismatches.length} 项不一致` : '逐局数守恒（各层合计 = 原合并数）'}`);
for (const cell of cells) {
  if (cell.games === 0) continue;
  console.log(`  ${cell.protocol} ${cell.focusId} vs ${cell.opponentId}: ${(cell.firstPlaceRate * 100).toFixed(1)}% (${cell.wins}/${cell.games}) CI[${(cell.wilson.lower * 100).toFixed(1)},${(cell.wilson.upper * 100).toFixed(1)}] 基准 ${(cell.chanceBaseline * 100).toFixed(0)}% → ${cell.vsChance}`);
}
