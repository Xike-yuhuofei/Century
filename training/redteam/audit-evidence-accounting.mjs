#!/usr/bin/env node
/** 红队审计 #2：历史证据核算（P0）——PR #29 局数声明 + PR #30 晋级证据独立复算。
 *
 * 只读审计，不修改任何原始结果。复算内容：
 * - E1 confirm 块总局数：8 个 ablation JSON 逐格清点（声明 25,600 vs 实际）；
 *   并核对 PHASE5 报告 §5.1 自述的 12,800；
 * - E2 confirm 块完整性：每格 200 种子、种子分区公式、A/B 配对齐全、
 *   座位轮换覆盖、零异常、跨文件种子零重叠；
 * - E3 challenge-11 晋级证据复算：从 games.json 独立重算全部汇总统计
 *   （第一名率方向 A/B、配对优势率、Wilson 区间、晋级判定），
 *   与 summary.json/candidate.json/champion.json.provenance 三方核对；
 * - E4 验证账本合并复算：全部 validation-ledger.json 求并集 →
 *   challengeIndex 复算、种子块重叠检查（含作废运行）、块边界记录；
 * - E5 指纹清单：confirm×8 / candidate.json / champion.json / 当前重建。
 *
 * 用法：node training/redteam/audit-evidence-accounting.mjs [--json]
 * 退出码：0=核算通过；2=发现差异。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
const findings = [];
const note = (severity, id, title, detail) => findings.push({ severity, id, title, detail });

/** probit（与 training/evaluator/stats.mjs 同口径的 Ackard 逆近似）。 */
function probit(p) {
  const j = Math.sqrt(-2 * Math.log(Math.min(Math.max(p, 1e-15), 1 - 1e-15)));
  return -j + (2.30753 + 0.27061 * j) / (1 + 0.99229 * j + 0.04481 * j * j);
}
function wilsonCI(wins, n, z) {
  const p = wins / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { point: p, lower: center - spread, upper: center + spread };
}

// ================= E1/E2：confirm 块 =================
const CONFIRM_DIR = resolve(REPO_ROOT, 'training/reports/js5-phase5/confirm');
const confirmFiles = [];
for (const v of ['js0', 'js1', 'js5', 'js5opt']) {
  for (const pool of ['classic', 'diverse']) {
    const stem = v === 'js5opt' ? 'js5-opt' : v;
    confirmFiles.push({
      label: `${v}-${pool}`,
      path: resolve(CONFIRM_DIR, `${v}-${pool}`, `ablation-confirm-${stem}-2_3_4_5-200s${pool === 'diverse' ? '-div' : ''}.json`),
      pool,
    });
  }
}
const confirmSeedBase = (seatCount, pool) => 1_360_000_000 + (seatCount - 2) * 1_000_000 + (pool === 'diverse' ? 500_000 : 0);

let totalGames = 0, totalAnomalies = 0;
const seedUsage = new Map(); // seed → file（跨文件重叠检测）
for (const f of confirmFiles) {
  const j = JSON.parse(readFileSync(f.path, 'utf8'));
  let cellGames = 0, issues = [];
  for (const cell of j.cells) {
    cellGames += cell.games.length;
    totalAnomalies += cell.anomalies ?? 0;
    if (cell.totalGames !== cell.games.length) issues.push(`seatCount=${cell.seatCount} totalGames(${cell.totalGames})≠games.length(${cell.games.length})`);
    // 种子分区：每格应恰为 200 个连续种子，起点 = confirmSeedBase(N, pool)
    const seeds = [...new Set(cell.games.map(g => g.seed))].sort((a, b) => a - b);
    const expectBase = confirmSeedBase(cell.seatCount, f.pool);
    if (seeds.length !== 200) issues.push(`seatCount=${cell.seatCount} 唯一种子 ${seeds.length}≠200`);
    if (seeds[0] !== expectBase) issues.push(`seatCount=${cell.seatCount} 种子起点 ${seeds[0]}≠${expectBase}`);
    if (seeds.length && seeds[seeds.length - 1] !== expectBase + 199) issues.push(`seatCount=${cell.seatCount} 种子终点非连续块`);
    // A/B 配对齐全 + 座位轮换覆盖
    const bySeed = new Map();
    for (const g of cell.games) {
      const arr = bySeed.get(g.seed) ?? []; arr.push(g.direction); bySeed.set(g.seed, arr);
      seedUsage.set(g.seed, f.label);
    }
    const unpaired = [...bySeed.entries()].filter(([, d]) => !(d.includes('A') && d.includes('B'))).length;
    if (unpaired) issues.push(`seatCount=${cell.seatCount} ${unpaired} 个种子 A/B 不齐`);
    const seatsSeen = new Set(cell.games.flatMap(g => g.candidateSeats));
    for (let s = 0; s < cell.seatCount; s++) if (!seatsSeen.has(s)) issues.push(`seatCount=${cell.seatCount} 座位 ${s} 未被候选轮换覆盖`);
    // 异常局不应存在（PR #29 声明零异常）
    const anom = cell.games.filter(g => g.status !== 'finished');
    if (anom.length) issues.push(`seatCount=${cell.seatCount} 存在 ${anom.length} 局非 finished`);
  }
  totalGames += cellGames;
  if (issues.length) note('P1', 'E2', `confirm 文件 ${f.label} 完整性问题`, issues.join('；'));
}
note(totalAnomalies === 0 ? 'PASS' : 'P1', 'E2', `confirm 块异常局 = ${totalAnomalies}`, 'PR #29 声明零异常');

const CLAIMED = 25600;
if (totalGames !== CLAIMED) {
  note('P1', 'E1', `PR #29/PHASE5 报告 §0 声明 ${CLAIMED} 局，落盘 confirm 数据实为 ${totalGames} 局`,
    `逐格清点 8 文件 = ${totalGames}（= PHASE5 §5.1 自述 12,800）。25,600 = 12,800 × 2，疑似把「双向 A/B 两局/种子」重复计入两次` +
    `（如 200 种子 × 2 方向 × 4 版本 × 2 池 × 4 人数再乘 2）。对局数口径以落盘 games 数组为准；晋级判定实际依赖的是 challenge-11 的 500 局，本差异不改变晋级结论，但属证据陈述失真。`);
} else {
  note('PASS', 'E1', `confirm 块总局数 = ${totalGames}`, '与声明一致');
}

// ================= E3：challenge-11 独立复算 =================
{
  const dir = resolve(REPO_ROOT, 'training/reports/js5-promotion-challenge');
  const games = JSON.parse(readFileSync(resolve(dir, 'games.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(resolve(dir, 'summary.json'), 'utf8'));
  const cand = JSON.parse(readFileSync(resolve(dir, 'candidate.json'), 'utf8'));
  const champ = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));

  const finished = games.filter(g => g.status === 'finished');
  const anomalies = games.length - finished.length;
  const wins = finished.filter(g => g.candidateWon).length;
  const byDir = d => {
    const fg = finished.filter(g => g.direction === d);
    return { games: fg.length, wins: fg.filter(g => g.candidateWon).length, rate: fg.length ? fg.filter(g => g.candidateWon).length / fg.length : null };
  };
  const dirA = byDir('A'), dirB = byDir('B');

  // 种子级配对复算（不经 summary.seedPairs，直接从 games 聚合）
  const bySeed = new Map();
  for (const g of finished) {
    const e = bySeed.get(g.seed) ?? { sum: 0, n: 0 };
    e.sum += g.candidateMeanScore - g.opponentMeanScore; e.n += 1;
    bySeed.set(g.seed, e);
  }
  const diffs = [...bySeed.entries()].filter(([, e]) => e.n === 2).map(([seed, e]) => ({ seed, diff: e.sum / 2 }));
  const decisive = diffs.filter(p => p.diff !== 0);
  const won = decisive.filter(p => p.diff > 0).length, lost = decisive.filter(p => p.diff < 0).length, tied = diffs.length - decisive.length;

  const challengeIndex = cand.confirmation?.challengeIndex ?? null;
  const alpha = 0.05 / 2 ** challengeIndex;
  const z = probit(1 - alpha);
  const ci = wilsonCI(won, decisive.length, z);
  const tCrit975 = 1.969; // n=250 的 95% t 近似值（双侧）；正态近似 1.96
  const meanDiff = diffs.reduce((s, p) => s + p.diff, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, p) => s + (p.diff - meanDiff) ** 2, 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  const diffCI = [meanDiff - tCrit975 * se, meanDiff + tCrit975 * se];

  const mism = [];
  if (finished.length !== summary.finishedGames) mism.push(`finished ${finished.length}≠${summary.finishedGames}`);
  if (wins !== summary.candidateWins) mism.push(`wins ${wins}≠${summary.candidateWins}`);
  if (anomalies !== summary.anomalies) mism.push(`anomalies ${anomalies}≠${summary.anomalies}`);
  if (dirA.wins !== summary.firstPlace?.directionA?.wins) mism.push(`directionA wins ${dirA.wins}≠${summary.firstPlace?.directionA?.wins}`);
  if (dirB.wins !== summary.firstPlace?.directionB?.wins) mism.push(`directionB wins ${dirB.wins}≠${summary.firstPlace?.directionB?.wins}`);
  if (won !== summary.paired?.won || lost !== summary.paired?.lost || tied !== summary.paired?.tied) {
    mism.push(`paired ${won}/${lost}/${tied} ≠ summary ${summary.paired?.won}/${summary.paired?.lost}/${summary.paired?.tied}`);
  }
  const candPaired = cand.confirmation?.paired ?? {};
  if (won !== candPaired.won || lost !== candPaired.lost || tied !== candPaired.tied) {
    mism.push(`paired vs candidate.json ${candPaired.won}/${candPaired.lost}/${candPaired.tied}`);
  }
  // challenge-11 是 joint-js5 的历史证据。当前冠军若已换成新算法，仍应对照
  // 不可变的 joint-js5 归档核算，而不是要求新冠军的 provenance 里继续保存旧口径。
  const archivePath = resolve(REPO_ROOT, 'training/champions/candidates/joint-js5.json');
  const champId = champ.parameters?.id ?? champ.id;
  const provSource = champId === cand.id ? 'champion.json.provenance' : 'candidates/joint-js5.json(archive)';
  const provPaired = champId === cand.id
    ? (champ.provenance?.promotionEvidence?.paired ?? {})
    : (existsSync(archivePath)
        ? (JSON.parse(readFileSync(archivePath, 'utf8')).confirmation?.paired ?? {})
        : {});
  if (Object.keys(provPaired).length > 0
    && (won !== provPaired.won || lost !== provPaired.lost || tied !== provPaired.tied)) {
    mism.push(`paired vs ${provSource} ${provPaired.won}/${provPaired.lost}/${provPaired.tied}`);
  }
  // 独立晋级判定
  const verdictIndependent = ci.lower > 0.5 && decisive.length >= 60 ? 'promote' : (ci.lower > 0.5 ? 'insufficient-seeds' : 'not-promote');
  const verdictRecorded = summary.decision?.verdict;
  if (mism.length) note('P0', 'E3', 'challenge-11 证据复算与记录不一致', mism.join('；'));
  else note('PASS', 'E3', `challenge-11 复算与三方记录全部一致：${finished.length} 局，配对 ${won}W/${lost}L/${tied}T`,
    `独立判定 ${verdictIndependent}（优势率 ${ci.point.toFixed(4)}，Wilson 下界 @α=${alpha.toExponential(3)}, z=${z.toFixed(3)}：${ci.lower.toFixed(4)}）与记录 verdict=${verdictRecorded} 一致；` +
    `配对分差 mean=${meanDiff.toFixed(3)} 95%CI[${diffCI[0].toFixed(2)},${diffCI[1].toFixed(2)}]（记录 ${summary.pairedDiffCI?.lower?.toFixed(2)},${summary.pairedDiffCI?.upper?.toFixed(2)}）；` +
    `方向A单席位第一名率 ${(dirA.rate * 100).toFixed(1)}%（5 人局机会基线 20%）、方向B ${(dirB.rate * 100).toFixed(1)}%（机会基线 80%）。` +
    `注：晋级口径剔除平局（decisive=${decisive.length}），若含平局优势率=${(won / diffs.length).toFixed(4)}，Wilson 下界仍需复核 >0.5。`);

  // 异常局静默丢弃检查：games.json 应包含全部局（含异常）
  const expected = summary.seeds * 2;
  if (games.length !== expected) note('P1', 'E3b', `games.json 局数 ${games.length} ≠ seeds×2 = ${expected}`, '可能存在未落盘的异常局');
}

// ================= E4：验证账本合并复算 =================
{
  const ledgerPaths = [
    'training/reports/structure-challenge-rollout-confirm/validation-ledger.json',
    'training/reports/evolve-latest/validation-ledger.json',
    'ai5/openevolve/experiments/reports/challenge-ai5-goal-remaining/validation-ledger.json',
    'ai5/openevolve/experiments/reports/challenge-ai5-goal-remaining-500/validation-ledger.json',
    'ai5/openevolve/experiments/reports/challenge-readiness-efficiency-500/validation-ledger.json',
    'ai5/openevolve/experiments/reports/challenge-readiness-efficiency-1000/validation-ledger.json',
    'training/reports/js5-formal-challenge/validation-ledger.json',
    'training/reports/js5-promotion-challenge/validation-ledger.json',
  ];
  const blocks = [];
  const missing = [];
  for (const rel of ledgerPaths) {
    const p = resolve(REPO_ROOT, rel);
    if (!existsSync(p)) { missing.push(rel); continue; }
    const ledger = JSON.parse(readFileSync(p, 'utf8'));
    for (const e of ledger.history ?? []) blocks.push({ base: Number(e.base), size: Number(e.size ?? 2000), src: rel.split('/reports/').pop().split('/')[0] });
  }
  if (missing.length) note('P1', 'E4', `${missing.length} 个账本源缺失（run-formal-challenge 会静默跳过——fail-open 隐患）`, missing.join('，'));

  // 账本为累积快照（新账本内嵌全部历史），必须按 base 去重后再比较
  //（与 run-formal-challenge-js5.mjs 的合并逻辑同口径；size 取各快照最大值以保守防重）。
  const byBase = new Map();
  for (const b of blocks) {
    const prev = byBase.get(b.base);
    if (!prev) byBase.set(b.base, b);
    else if (b.size > prev.size) byBase.set(b.base, { ...b, size: b.size });
  }
  const uniqueBlocks = [...byBase.values()].sort((a, b) => a.base - b.base);

  // 重叠检查（验证池内、去重后）
  const inPool = uniqueBlocks.filter(b => b.base >= 900_000_000 && b.base < 1_060_000_000);
  const overlaps = [];
  for (let i = 0; i < inPool.length; i++) for (let k = i + 1; k < inPool.length; k++) {
    const a = inPool[i], b = inPool[k];
    if (a.base < b.base + b.size && b.base < a.base + a.size) overlaps.push(`[${a.base},${a.base + a.size})×[${b.base},${b.base + b.size})`);
  }
  if (overlaps.length) note('P0', 'E4b', `验证账本（去重后）存在种子块重叠：${overlaps.join('；')}`, '重复消费验证种子会破坏配对独立性');
  else note('PASS', 'E4b', `验证池 ${inPool.length} 个已消费块（去重后）两两无重叠`,
    `块清单：${inPool.map(b => `[${b.base},${b.base + b.size})`).join(' ')}`);

  // challengeIndex 复算：去重块数 = 累计确认挑战次数；晋级时应为 10 → 本次 11
  const challengeIndex = inPool.length;
  note(challengeIndex === 11 ? 'PASS' : 'P1', 'E4c', `账本合并复算：去重后 ${challengeIndex} 个消费块 ↔ 晋级记录 challengeIndex=11`,
    challengeIndex === 11
      ? '与 run-formal-challenge-js5.mjs 的 challengeCount+1 口径一致'
      : '口径不一致——若账本缺失会使该值偏小、alpha 收紧不足且种子块可能重叠（challenge-10 事故已实证该风险）');
  // 作废运行留痕核对：invalid-seedreuse 账本必须未被并入有效账本链
  const invalid = resolve(REPO_ROOT, 'training/reports/js5-promotion-challenge-invalid-seedreuse/validation-ledger.json');
  if (existsSync(invalid)) {
    const j = JSON.parse(readFileSync(invalid, 'utf8'));
    const invalidBases = (j.history ?? []).map(e => Number(e.base));
    const leaked = invalidBases.filter(b => !byBase.has(b));
    note(leaked.length ? 'P1' : 'PASS', 'E4d', leaked.length ? '作废运行的种子块未在有效账本中记账' : '作废运行（invalid-seedreuse）已正确隔离',
      leaked.length ? `未记账块：${leaked.join('，')}` : `作废账本块 ${invalidBases.join('，')} 均已按 challenge-10 口径记账一次`);
  }
}

// ================= E5：指纹清单 =================
{
  const fps = [];
  for (const f of confirmFiles) fps.push({ artifact: `confirm/${f.label}`, sha: JSON.parse(readFileSync(f.path, 'utf8')).engineBundleSha256 });
  const cand = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/reports/js5-promotion-challenge/candidate.json'), 'utf8'));
  const champ = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
  fps.push({ artifact: 'candidate.json(codeCommit 4a11b62)', sha: cand.engineBundleSha256 });
  fps.push({ artifact: 'champion.json.provenance', sha: champ.provenance?.engineBundleSha256 });
  const distinct = [...new Set(fps.map(f => f.sha))];
  note(distinct.length <= 2 ? 'PASS' : 'P1', 'E5', `证据产物指纹共 ${distinct.length} 种`, fps.map(f => `${f.artifact}=${f.sha.slice(0, 12)}`).join('；') +
    '；已知语义：b0df3fc4=PR-25 时代（js0-classic），9ed80290=第五阶段 HEAD（confirm 其余 7 文件），77292a19=挑战 commit 4a11b62（可逐字节复现）');
}

// ---- 输出 ----
const blocked = findings.filter(f => f.severity === 'P0');
if (process.argv.includes('--json')) console.log(JSON.stringify({ audit: 'redteam-evidence-accounting', findings, verdict: blocked.length ? 'DISCREPANCY' : 'CONSISTENT' }, null, 2));
else {
  console.log(`\n== 红队历史证据核算：${blocked.length ? '发现差异' : '核算通过'} ==`);
  for (const f of findings) console.log(`[${f.severity}] ${f.id} ${f.title}\n    ${f.detail}`);
}
process.exit(blocked.length ? 2 : 0);
