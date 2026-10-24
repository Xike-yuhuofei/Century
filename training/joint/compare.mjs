/** JS0–JS5 配对比较工具（PR #26 第三阶段；AI6 第五阶段 A2 审计加固）。
 *
 * 输入：多个 ablation JSON（duel.mjs 产物，同 block/同 seeds/同 players）。
 * 输出：候选 vs 基准的按种子聚类配对第一名率差 + bootstrap CI + 逐座位分解。
 *
 * 统计口径（任务书 §三.7；第五阶段任务 A2 加固）：
 * - 一级指标 = 候选席位第一名率，方向 A/B 严格分开披露（A=单席位口径，
 *   B=候选阵营口径，二者不得混为一谈；A+B 合并值标注为"阵营混合参考"）；
 * - 配对单位 = 种子（同一 seed 的 A/B 双局共享洗牌序列，是相关样本）；
 * - 区间 = 种子级 cluster bootstrap（重抽样单位 = 种子）；
 * - 胜率差 CI：对每个 bootstrap 重抽样，同时抽同一批种子索引，计算
 *   候选与基准的第一名率差（配对差分，方差随相关而降）。
 *
 * 第五阶段 A2 数据完整性纪律（全部强制，任何一条不满足即抛错——
 * 绝不静默取交集/丢弃/覆盖）：
 * 1. 重复 (seed, direction, candidate) 记录 → 拒绝；
 * 2. 非 finished 局（异常局）→ 拒绝（异常局绝不计入胜率）；
 * 3. 配对缺失（一侧有一侧无的 (seed, direction)）→ 拒绝并列出缺失清单；
 * 4. 座位分配协议不一致（同 (seed, direction) 的 candidateSeats 不同）→ 拒绝；
 * 5. 对手版本配置不一致（同 (seed, direction) 的 versionsIds 不同）→ 拒绝；
 * 6. 零胜/全胜场附 Clopper–Pearson 精确界；
 * 7. familySize > 1 时按 Bonferroni 调整 CI 水平（多重检验显式化；
 *    正式晋级以几何 alpha 消耗协议为准，本参数用于探索性报告的透明披露）。
 */

import { readFileSync } from 'node:fs';
import { mulberry32 } from '../lib/rng.mjs';
import { clopperPearsonBound } from './exact-bounds.mjs';

function loadGames(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (report.schema !== 'century-joint-search-ablation-v1') {
    throw new Error(`${path} 不是 duel.mjs ablation 产物（schema=${report.schema}）`);
  }
  const games = [];
  for (const cell of report.cells) {
    for (const g of cell.games ?? []) games.push({ ...g, seatCount: cell.seatCount, candidateId: cell.candidateId });
  }
  return { report, games };
}

/** 从 ablation JSON 提取按 (seed, direction) 的胜局表。
 * A2 纪律：重复记录抛错；非 finished 局抛错（列出清单）；candidateId 过滤
 * 只用于"同文件多候选 cell"的显式指定，过滤后必须仍有数据。 */
function winMap(path, seatCount, candidateId) {
  const { report, games } = loadGames(path);
  const map = new Map();
  const anomalies = [];
  for (const g of games) {
    if (g.seatCount !== seatCount || (candidateId && g.candidateId !== candidateId)) continue;
    if (g.status !== 'finished') { anomalies.push(`${g.seed}:${g.direction}（${g.status}${g.reason ? '：' + g.reason : ''}）`); continue; }
    const key = `${g.seed}:${g.direction}`;
    if (map.has(key)) throw new Error(`${path} 存在重复 (seed, direction, candidate) 记录：${key}（candidate=${g.candidateId}）——配对数据完整性违规`);
    map.set(key, { won: g.won === true, scoreDiff: g.scoreDiff, candidateSeats: g.candidateSeats, versionsIds: g.versionsIds });
  }
  if (anomalies.length) {
    throw new Error(`${path} 混入 ${anomalies.length} 局非 finished 记录（异常局绝不计入配对统计，请先排查异常原因）：${anomalies.slice(0, 5).join('；')}${anomalies.length > 5 ? ' …' : ''}`);
  }
  if (!map.size) throw new Error(`${path} 在 seatCount=${seatCount}${candidateId ? ` candidate=${candidateId}` : ''} 下无 finished 数据`);
  return map;
}

/** 配对完整性核验（A2）：键集相等、座位分配协议一致、对手版本配置一致。
 * 返回排序后的配对种子列表；任何不一致抛错并列出具体差异。 */
function validatePairing(cand, base, labelCand, labelBase) {
  const candKeys = [...cand.keys()].sort();
  const baseKeys = [...base.keys()].sort();
  const missingInBase = candKeys.filter(k => !base.has(k));
  const missingInCand = baseKeys.filter(k => !cand.has(k));
  if (missingInBase.length || missingInCand.length) {
    throw new Error(`配对缺失（禁止静默取交集）：${labelCand} 独有 ${missingInBase.length} 个、${labelBase} 独有 ${missingInCand.length} 个` +
      `（示例：${[...missingInBase, ...missingInCand].slice(0, 5).join('，')}）——两侧 ablation 必须来自完全相同的 (seed, direction) 网格`);
  }
  for (const k of candKeys) {
    const c = cand.get(k), b = base.get(k);
    if (JSON.stringify(c.candidateSeats) !== JSON.stringify(b.candidateSeats)) {
      throw new Error(`座位分配协议不一致 @${k}：${labelCand}=${JSON.stringify(c.candidateSeats)} vs ${labelBase}=${JSON.stringify(b.candidateSeats)}`);
    }
    if (JSON.stringify(c.versionsIds) !== JSON.stringify(b.versionsIds)) {
      throw new Error(`对手版本配置不一致 @${k}：${labelCand}=${JSON.stringify(c.versionsIds)} vs ${labelBase}=${JSON.stringify(b.versionsIds)}——两侧必须使用同一对手池与轮换协议`);
    }
  }
  return [...new Set(candKeys.map(k => k.split(':')[0]))].map(Number).sort((a, b) => a - b);
}

/** 配对比较：candidatePath 与 baselinePath 必须通过全部配对完整性核验。 */
export function pairedComparison(candidatePath, baselinePath, { seatCount = 2, candidateId, baselineId, iterations = 2000, rngSeed = 0x6a11e5, familySize = 1 } = {}) {
  const cand = winMap(candidatePath, seatCount, candidateId);
  const base = winMap(baselinePath, seatCount, baselineId);
  const seeds = validatePairing(cand, base, candidatePath, baselinePath);
  // 聚类：seed → [{direction, candWon, baseWon, candDiff, baseDiff}]（A/B 各一条）。
  const clusters = seeds.map(seed => (['A', 'B'].map(direction => {
    const c = cand.get(`${seed}:${direction}`);
    const b = base.get(`${seed}:${direction}`);
    return c && b ? { direction, c: c.won ? 1 : 0, b: b.won ? 1 : 0, cd: c.scoreDiff, bd: b.scoreDiff } : null;
  })).filter(Boolean));
  const games = clusters.flat();
  const rate = (pick) => games.reduce((s, g) => s + (pick(g) ? 1 : 0), 0) / games.length;
  const point = {
    candidateFirstPlace: rate(g => g.c === 1),
    baselineFirstPlace: rate(g => g.b === 1),
    firstPlaceDiff: rate(g => g.c === 1) - rate(g => g.b === 1),
    meanScoreDiff: games.reduce((s, g) => s + (g.cd - g.bd), 0) / games.length,
    games: games.length,
    seeds: clusters.length,
  };
  // 种子级配对 bootstrap（Bonferroni：familySize>1 时按 1−0.05/N 分位）。
  const family = Math.max(1, Math.floor(familySize));
  const alphaTail = 0.05 / (2 * family);
  const rng = mulberry32(rngSeed);
  const diffs = [];
  const scoreDiffs = [];
  for (let i = 0; i < iterations; i++) {
    let cWins = 0, bWins = 0, n = 0, sd = 0;
    for (let k = 0; k < clusters.length; k++) {
      const cluster = clusters[Math.floor(rng() * clusters.length)];
      for (const g of cluster) {
        cWins += g.c; bWins += g.b; n += 1; sd += g.cd - g.bd;
      }
    }
    diffs.push((cWins - bWins) / n);
    scoreDiffs.push(sd / n);
  }
  diffs.sort((a, b) => a - b);
  scoreDiffs.sort((a, b) => a - b);
  const percentile = (sorted, p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const candWins = games.filter(g => g.c === 1).length;
  const baseWins = games.filter(g => g.b === 1).length;
  const result = {
    ...point,
    firstPlaceDiffCI: [Number(percentile(diffs, alphaTail).toFixed(4)), Number(percentile(diffs, 1 - alphaTail).toFixed(4))],
    meanScoreDiffCI: [Number(percentile(scoreDiffs, alphaTail).toFixed(4)), Number(percentile(scoreDiffs, 1 - alphaTail).toFixed(4))],
    method: 'seed-cluster-paired-bootstrap',
    ciLevel: Number((1 - 0.05 / family).toFixed(4)),
    familySize: family,
    // A2：极端样本（零胜/全胜）精确界披露（Clopper–Pearson 单侧 97.5%）。
    candidateWins: candWins, baselineWins: baseWins,
    ...(candWins === 0 ? { candidateZeroWinsExactUpper: clopperPearsonBound(games.length, 'upper') } : {}),
    ...(candWins === games.length ? { candidateAllWinsExactLower: clopperPearsonBound(games.length, 'lower') } : {}),
    ...(baseWins === 0 ? { baselineZeroWinsExactUpper: clopperPearsonBound(games.length, 'upper') } : {}),
    ...(baseWins === games.length ? { baselineAllWinsExactLower: clopperPearsonBound(games.length, 'lower') } : {}),
  };
  result.significance = result.firstPlaceDiffCI[0] > 0 ? 'candidate>baseline'
    : result.firstPlaceDiffCI[1] < 0 ? 'candidate<baseline' : 'inconclusive';
  return result;
}

/** 按方向分解的完整比较（A2：方向 A=单席位、B=阵营、合并=阵营混合参考）。
 * 返回 {A, B, combined} 三个口径的结果（方向数据不足时对应项为 null）。 */
export function pairedComparisonByDirection(candidatePath, baselinePath, options = {}) {
  const out = { A: null, B: null, combined: null };
  for (const direction of ['A', 'B']) {
    try {
      out[direction] = pairedComparisonDirectional(candidatePath, baselinePath, { ...options, directionFilter: direction });
    } catch (error) {
      if (!/无 finished 数据|配对缺失/.test(String(error.message))) throw error;
    }
  }
  try {
    out.combined = pairedComparison(candidatePath, baselinePath, options);
    out.combined.caveat = 'A+B 合并为阵营混合口径（单席位方向 A 与候选阵营方向 B 的等权混合），仅供与历史数字对照，不得作为单候选获胜概率解释';
  } catch { /* 方向数据由上面单项承载 */ }
  return out;
}

/** 单方向配对比较（directionFilter='A'|'B'）。 */
export function pairedComparisonDirectional(candidatePath, baselinePath, { seatCount = 2, candidateId, baselineId, directionFilter, iterations = 2000, rngSeed = 0x6a11e5, familySize = 1 } = {}) {
  const cand = winMap(candidatePath, seatCount, candidateId);
  const base = winMap(baselinePath, seatCount, baselineId);
  const seeds = validatePairing(cand, base, candidatePath, baselinePath);
  const pairs = seeds.map(seed => {
    const c = cand.get(`${seed}:${directionFilter}`);
    const b = base.get(`${seed}:${directionFilter}`);
    return c && b ? { seed, c: c.won ? 1 : 0, b: b.won ? 1 : 0, cd: c.scoreDiff, bd: b.scoreDiff } : null;
  }).filter(Boolean);
  if (!pairs.length) throw new Error(`方向 ${directionFilter} 无配对数据`);
  const n = pairs.length;
  const rate = (pick) => pairs.reduce((s, p) => s + (pick(p) ? 1 : 0), 0) / n;
  const family = Math.max(1, Math.floor(familySize));
  const alphaTail = 0.05 / (2 * family);
  const rng = mulberry32(rngSeed);
  const diffs = [];
  const scoreDiffs = [];
  for (let i = 0; i < iterations; i++) {
    let cWins = 0, bWins = 0, sd = 0;
    for (let k = 0; k < n; k++) {
      const p = pairs[Math.floor(rng() * n)];
      cWins += p.c; bWins += p.b; sd += p.cd - p.bd;
    }
    diffs.push((cWins - bWins) / n);
    scoreDiffs.push(sd / n);
  }
  diffs.sort((a, b) => a - b);
  scoreDiffs.sort((a, b) => a - b);
  const percentile = (sorted, p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const candWins = pairs.filter(p => p.c === 1).length;
  const baseWins = pairs.filter(p => p.b === 1).length;
  const result = {
    direction: directionFilter,
    candidateFirstPlace: rate(p => p.c === 1),
    baselineFirstPlace: rate(p => p.b === 1),
    firstPlaceDiff: rate(p => p.c === 1) - rate(p => p.b === 1),
    meanScoreDiff: pairs.reduce((s, p) => s + (p.cd - p.bd), 0) / n,
    games: n, seeds: n,
    firstPlaceDiffCI: [Number(percentile(diffs, alphaTail).toFixed(4)), Number(percentile(diffs, 1 - alphaTail).toFixed(4))],
    meanScoreDiffCI: [Number(percentile(scoreDiffs, alphaTail).toFixed(4)), Number(percentile(scoreDiffs, 1 - alphaTail).toFixed(4))],
    method: 'seed-cluster-paired-bootstrap',
    ciLevel: Number((1 - 0.05 / family).toFixed(4)),
    familySize: family,
    candidateWins: candWins, baselineWins: baseWins,
    ...(candWins === 0 ? { candidateZeroWinsExactUpper: clopperPearsonBound(n, 'upper') } : {}),
    ...(candWins === n ? { candidateAllWinsExactLower: clopperPearsonBound(n, 'lower') } : {}),
    ...(baseWins === 0 ? { baselineZeroWinsExactUpper: clopperPearsonBound(n, 'upper') } : {}),
    ...(baseWins === n ? { baselineAllWinsExactLower: clopperPearsonBound(n, 'lower') } : {}),
  };
  result.significance = result.firstPlaceDiffCI[0] > 0 ? 'candidate>baseline'
    : result.firstPlaceDiffCI[1] < 0 ? 'candidate<baseline' : 'inconclusive';
  return result;
}

// CLI：node training/joint/compare.mjs <candidate.json> <baseline.json> [--players=2] [--candidate=js5] [--baseline=js0] [--direction=A|B|both] [--family=N]
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('compare.mjs')) {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const optOf = (name, dflt) => {
    const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : dflt;
  };
  const seatCounts = (optOf('players', '2,3,4,5')).split(',').map(Number);
  const baselineId = optOf('baseline', 'js0');
  const candidateIds = optOf('candidate', null);
  const direction = optOf('direction', 'both');
  const familySize = Number(optOf('family', '1'));
  if (positional.length < 2) {
    console.error('用法：node training/joint/compare.mjs <candidate-ablation.json> <baseline-ablation.json> [--players=2,5] [--candidate=js5] [--baseline=js0] [--direction=A|B|both] [--family=N]');
    console.error('A2 口径：方向A=单席位第一名率｜方向B=候选阵营第一名率｜both=分别报告 + 阵营混合参考（标注 caveat）');
    process.exit(1);
  }
  const familyNote = familySize > 1 ? `（Bonferroni family=${familySize}，CI 水平 ${(100 - 5 / familySize).toFixed(2)}%）` : '';
  for (const n of seatCounts) {
    for (const cid of candidateIds ? candidateIds.split(',') : [null]) {
      try {
        if (direction === 'both') {
          const r = pairedComparisonByDirection(positional[0], positional[1], { seatCount: n, candidateId: cid, baselineId, familySize });
          const fmt = (x, tag) => x ? `[${tag}] ${(x.candidateFirstPlace * 100).toFixed(1)}% vs ${(x.baselineFirstPlace * 100).toFixed(1)}%｜差 ${(x.firstPlaceDiff * 100).toFixed(1)}pp CI [${(x.firstPlaceDiffCI[0] * 100).toFixed(1)},${(x.firstPlaceDiffCI[1] * 100).toFixed(1)}]｜分差 ${x.meanScoreDiff.toFixed(2)} CI [${x.meanScoreDiffCI[0].toFixed(2)},${x.meanScoreDiffCI[1].toFixed(2)}]｜${x.significance}${x.candidateZeroWinsExactUpper !== undefined ? `｜候选零胜精确上界 ${(x.candidateZeroWinsExactUpper * 100).toFixed(1)}%` : ''}` : `[${tag}] 无配对数据`;
          console.log(`[${n}人][${cid ?? '全部候选'} vs ${baselineId}] ${fmt(r.A, '方向A·单席位')}`);
          console.log(`[${n}人][${cid ?? '全部候选'} vs ${baselineId}] ${fmt(r.B, '方向B·阵营')}`);
          if (r.combined) console.log(`[${n}人][${cid ?? '全部候选'} vs ${baselineId}] [A+B合并·参考] ${(r.combined.candidateFirstPlace * 100).toFixed(1)}% vs ${(r.combined.baselineFirstPlace * 100).toFixed(1)}%｜${r.combined.caveat}${familyNote}`);
        } else {
          const r = pairedComparisonDirectional(positional[0], positional[1], { seatCount: n, candidateId: cid, baselineId, directionFilter: direction, familySize });
          console.log(`[${n}人][方向${direction}${direction === 'A' ? '·单席位' : '·阵营'}][${cid ?? '全部候选'} vs ${baselineId}] 配对 ${r.seeds} 种子：${(r.candidateFirstPlace * 100).toFixed(1)}% vs ${(r.baselineFirstPlace * 100).toFixed(1)}%｜差 ${(r.firstPlaceDiff * 100).toFixed(1)}pp CI [${(r.firstPlaceDiffCI[0] * 100).toFixed(1)},${(r.firstPlaceDiffCI[1] * 100).toFixed(1)}]｜分差 ${r.meanScoreDiff.toFixed(2)} CI [${r.meanScoreDiffCI[0].toFixed(2)},${r.meanScoreDiffCI[1].toFixed(2)}]｜${r.significance}${familyNote}`);
        }
      } catch (error) {
        console.error(`[${n}人][${cid ?? '全部候选'}] ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
}
