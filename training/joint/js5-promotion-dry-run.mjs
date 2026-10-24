/** JS5 冠军晋级 dry-run 审核工具（AI6 第五阶段·任务 F）。
 *
 * 定位（重要边界）：**这不是正式晋级流程**——正式晋级机制
 * （challengeWithDecision + promote-champion.mjs + 几何 alpha 消耗 + 验证池
 * 账本）保持原样，本阶段不改变任何正式门槛、不写 champion.json、不消费
 * 验证池种子。本工具做的事：
 *  1. 以晋级脚本同等的怀疑标准，对一份 JS5 独立确认证据文件做**独立重算**
 *     与完整性核验（不信任自报结论）；
 *  2. 按草案协议（AI6-JS5-PROMOTION-PROTOCOL-DRAFT.md）的第一名率判定规则
 *     给出「若提交正式挑战，预期判定」的 dry-run 结论；
 *  3. 列出从证据到正式晋级还缺哪些工程步骤（正式管线扩展清单）。
 *
 * 核验项（镜像 promote-champion.mjs 的 P0/P1 纪律）：
 *  - 证据运行时产物指纹（engineBundleSha256）与当前编译产物一致；
 *  - 种子全部落在声明的独立确认块（AI6_JS5_CONFIRM_SUBBLOCK 分区）、
 *    逐种子唯一、无重复消费；
 *  - 逐局记录完整性：(seed, direction) 网格完整、座位分配协议一致、
 *    对手版本配置一致（compare.mjs 同源校验）；
 *  - 异常率 ≤ 2%；
 *  - 一级指标独立重算：方向 A（单席位）/ B（阵营）分开的种子级配对
 *    bootstrap，判定规则 = 草案协议 §4。
 *
 * 用法：node training/joint/js5-promotion-dry-run.mjs \
 *         --candidate <ablation-cand.json> --baseline <ablation-base.json> \
 *         [--candidate-id js5] [--baseline-id js0] [--family <多重检验族大小>]
 * 输出：training/reports/js5-phase5/promotion-dry-run.json（exit 0/2）
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { engineBundleSha256, REPO_ROOT } from '../lib/paths.mjs';
import { assertInBlock, AI6_JS5_CONFIRM_SUBBLOCK } from '../../ai5/lib/seed_policy.mjs';
import { pairedComparisonByDirection } from './compare.mjs';
import { clopperPearsonBound } from './exact-bounds.mjs';

function parseArgs() {
  const args = {
    candidate: null, baseline: null, candidateId: 'js5', baselineId: 'js0',
    family: null, anomalyCap: 0.02, outDir: resolve(REPO_ROOT, 'training/reports/js5-phase5'),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--candidate') args.candidate = resolve(argv[++i]);
    else if (argv[i] === '--baseline') args.baseline = resolve(argv[++i]);
    else if (argv[i] === '--candidate-id') args.candidateId = argv[++i];
    else if (argv[i] === '--baseline-id') args.baselineId = argv[++i];
    else if (argv[i] === '--family') args.family = Number(argv[++i]);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

function loadAblation(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.schema !== 'century-joint-search-ablation-v1') throw new Error(`${path} schema 异常：${doc.schema}`);
  return doc;
}

async function main() {
  const args = parseArgs();
  if (!args.candidate || !args.baseline) {
    console.error('用法：node training/joint/js5-promotion-dry-run.mjs --candidate <cand.json> --baseline <base.json> [--candidate-id js5] [--baseline-id js0]');
    process.exit(2);
  }
  const cand = loadAblation(args.candidate);
  const base = loadAblation(args.baseline);
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) console.error(`  ✗ ${name}：${detail}`); else console.log(`  ✓ ${name}`); };

  console.log('== JS5 晋级 dry-run（非正式流程；不写 champion.json、不消费验证池） ==\n');

  // 1. 产物指纹一致性（promote-champion P1 同款纪律）。
  const currentBundle = engineBundleSha256();
  const candBundle = cand.engineBundleSha256 ?? null;
  check('证据产物指纹存在', candBundle !== null, 'ablation 报告未记录 engineBundleSha256（需要 duel.mjs 补充记录）');
  check('证据产物指纹 = 当前编译产物', candBundle === null || candBundle === currentBundle,
    `证据 ${String(candBundle).slice(0, 8)}… vs 当前 ${currentBundle.slice(0, 8)}…（证据生成后引擎变更过则必须重新确认）`);

  // 2. 种子块归属与唯一性。
  const seedIssues = [];
  const seenSeeds = new Set();
  for (const cell of [...cand.cells, ...base.cells]) {
    for (const g of cell.games ?? []) {
      if (typeof g.seed !== 'number' || !Number.isSafeInteger(g.seed)) { seedIssues.push(`非法 seed：${g.seed}`); continue; }
      try { assertInBlock(g.seed, AI6_JS5_CONFIRM_SUBBLOCK, '确认块种子'); } catch (e) { seedIssues.push(e.message); }
      if (seenSeeds.has(`${g.seed}:${g.direction}:${cell.candidateId}`)) seedIssues.push(`重复：${g.seed}:${g.direction}:${cell.candidateId}`);
      seenSeeds.add(`${g.seed}:${g.direction}:${cell.candidateId}`);
    }
  }
  check('种子全部落在 AI6_JS5_CONFIRM_SUBBLOCK 且逐 (seed,direction,candidate) 唯一', seedIssues.length === 0,
    seedIssues.slice(0, 3).join('；') || `${seenSeeds.size} 条记录核验通过`);

  // 3. 异常率。
  const totalGames = cand.cells.reduce((s, c) => s + (c.totalGames ?? 0), 0);
  const anomalies = cand.cells.reduce((s, c) => s + (c.anomalies ?? 0), 0);
  const anomalyRate = totalGames ? anomalies / totalGames : 1;
  check(`异常率 ≤ ${(args.anomalyCap * 100).toFixed(0)}%`, anomalyRate <= args.anomalyCap,
    `异常 ${anomalies}/${totalGames} = ${(anomalyRate * 100).toFixed(2)}%`);

  // 4. 一级指标独立重算（方向分开；compare.mjs 同源校验在内部抛错）。
  const seatCounts = [...new Set(cand.cells.map(c => c.seatCount))].sort((a, b) => a - b);
  const family = args.family ?? Math.max(1, seatCounts.length);
  const verdicts = {};
  let allPass = true;
  const summary = {};
  for (const n of seatCounts) {
    try {
      const r = pairedComparisonByDirection(args.candidate, args.baseline, {
        seatCount: n, candidateId: args.candidateId, baselineId: args.baselineId, familySize: family,
      });
      verdicts[n] = r;
      // 草案协议 §4 判定：A 方向（单席位）CI 下界 > 0 = 显著优；
      // 上界 < 0 = 有证据退化；跨 0 = 证据不足（不得称"已证明无退化"）。
      const a = r.A;
      summary[n] = a ? {
        direction: 'A(单席位)',
        diff: Number((a.firstPlaceDiff * 100).toFixed(1)),
        ci: a.firstPlaceDiffCI.map(x => Number((x * 100).toFixed(1))),
        verdict: a.firstPlaceDiffCI[0] > 0 ? 'significantly-better'
          : a.firstPlaceDiffCI[1] < 0 ? 'significantly-worse' : 'inconclusive',
        zeroWinsNote: a.candidateZeroWinsExactUpper !== undefined
          ? `候选零胜（精确上界 ${(a.candidateZeroWinsExactUpper * 100).toFixed(1)}%）` : null,
      } : { direction: 'A(单席位)', verdict: 'no-data' };
      console.log(`  [${n}人] 方向A ${summary[n].diff ?? '-'}pp CI [${summary[n].ci?.join(',') ?? '-'}] → ${summary[n].verdict}`);
    } catch (error) {
      allPass = false;
      check(`[${n}人] 配对重算`, false, error.message);
    }
  }
  if (Object.keys(verdicts).length) check('配对重算（全部人数）', true, `${Object.keys(verdicts).join(',')} 人；family=${family}（Bonferroni）`);

  // 5. dry-run 结论（草案协议口径；非正式判定）。
  const better = seatCounts.filter(n => summary[n]?.verdict === 'significantly-better');
  const worse = seatCounts.filter(n => summary[n]?.verdict === 'significantly-worse');
  const inconclusive = seatCounts.filter(n => summary[n]?.verdict === 'inconclusive' || summary[n]?.verdict === 'no-data');
  let recommendation;
  if (worse.length) recommendation = 'C：暂不晋级——存在有证据退化的人数（先修复再议）';
  else if (better.length && inconclusive.length) recommendation = `B：仅按人数部署候选（${better.join('/')} 人显著；${inconclusive.join('/')} 人证据不足）——分人数路由需独立验证`;
  else if (better.length) recommendation = 'A：建议进入正式冠军挑战（走正式管线：挑战种子块 + 几何 alpha + promote-champion 独立重算）';
  else recommendation = 'C：暂不晋级——无任何人数达到显著优于冠军';
  console.log(`\n== dry-run 结论（草案协议）：${recommendation}`);
  const missingSteps = [
    '正式管线扩展：challengeWithDecision/promote-champion 支持联合版本注入与第一名率主判定（独立 PR + 人工审核）',
    '验证池种子：正式晋级必须消费验证池账本块（[900M,1.06e9)），本 confirm 块证据只作预筛',
    '几何 alpha 消耗：challengeIndex 来自验证账本 challengeCount，判定阈值按 α_k 收紧',
    '对手池口径：正式挑战对手池缺省 = 仅冠军（胜过当前冠军的语义），与确认实验的双池设计不同',
  ];
  const report = {
    schema: 'century-js5-promotion-dry-run-v1',
    date: new Date().toISOString(),
    disclaimer: 'dry-run 审核工具——不修改正式晋级门槛、不写 champion.json、不消费验证池种子；结论为草案协议口径的预期判定，非正式判定',
    inputs: { candidate: args.candidate, baseline: args.baseline, candidateId: args.candidateId, baselineId: args.baselineId, family },
    checks,
    perPlayerCount: summary,
    recommendation,
    missingStepsForFormalPromotion: missingSteps,
    engineBundleSha256: currentBundle,
  };
  mkdirSync(args.outDir, { recursive: true });
  const out = resolve(args.outDir, 'promotion-dry-run.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`报告已写入：${out}`);
  const failed = checks.filter(c => !c.ok);
  if (failed.length) { console.error(`\n${failed.length} 项核验未通过——按晋级纪律不得进入正式流程`); process.exitCode = 2; }
}

main().catch(error => { console.error(error); process.exit(1); });
