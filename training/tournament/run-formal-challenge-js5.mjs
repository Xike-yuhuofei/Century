#!/usr/bin/env node
/** JS5（冠军引导选择性联合搜索）正式冠军挑战编排。
 *
 * 严格复用 run-formal-challenge.mjs 的机制，不绕过任何防线：
 * 1. 合并全部已知验证账本历史 → 本次 challengeIndex = 累计次数 + 1，
 *    alpha 按几何消耗收紧（α_k = 5%/2^k）——宁可最严，不得伪造小序号；
 * 2. assertBlockFree 后消费下一个互不重叠的验证种子块（[900M, 1.06e9) 池内）；
 * 3. challengeWithDecision 双向配对挑战（方向 A 候选 1 席 / B 候选 4 席，
 *    座位轮换，冠军独占对手），挑战种子全部来自验证池；
 * 4. 产出 promote-champion 兼容的 candidate.json（confirmation 逐种子证据 +
 *    challengeIndex + alphaBudget + engineBundleSha256 + codeCommit）与续接账本。
 *
 * 候选说明：JS5 是结构候选（adapter='champion-guided'，非参数变体）——决策核心
 * 为 web-v1/src/js/champion-guided.ts（冠军束搜索始终在场 + 竞争门控 + 多世界
 * CRN 联合仲裁 + 保守覆盖），经 training/simulator 的显式适配器分派按席位注入；
 * 冠军席位永远运行官方 chooseAIAction（版本隔离与结构变体同一机制）。
 * 样本量论证：held-out 验证块实测 JS5−JS0 配对得分优势率 0.783（60 种子）；
 * α₁₀ ≈ 4.88e-5（z≈3.89）下 Wilson 下界 > 0.5 需要 n ≥ ~153（p̂=0.66 时），
 * 250 种子覆盖真实优势率 ≥ 0.62 的情形（预注册，一次性消费，不做多次窥视）。
 *
 * 用法：node training/tournament/run-formal-challenge-js5.mjs [--seeds 250]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextValidationBase, consumeLedger, assertBlockFree, validationChallengeCount, VALIDATION_POOL_BASE } from '../lib/seeds.mjs';
import { challengeWithDecision } from './challenge.mjs';
import { requireBuiltEngine, engineBundleSha256, REPO_ROOT } from '../lib/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(REPO_ROOT, 'training/reports/js5-promotion-challenge');
mkdirSync(outDir, { recursive: true });
requireBuiltEngine();

const args = process.argv.slice(2);
const seedsArg = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 250;
if (!Number.isSafeInteger(seedsArg) || seedsArg < 60 || seedsArg > 2000) {
  throw new Error(`--seeds 必须为 60–2000 的整数（决定性下限 60 + 余量），实际：${seedsArg}`);
}

// ---- 候选版本：JS5 冠军引导选择性联合搜索（结构候选；显式适配器注入） ----
const candidateDescriptor = {
  id: 'joint-js5',
  adapter: 'champion-guided',
  jointVersion: 'joint-js5',
  budgetMs: 100, // 标准实时决策预算（与全部消融/验证块同口径）
  // 血统保持：联合轨迹的贪心镜像消费 CHAMPION_PARAMETERS.acquisitionVariant——
  // 挑战验证时的轨迹策略即 readiness-efficiency 收集估值，描述符必须冻结该配置，
  // 否则晋级落地后轨迹策略漂移（S4 回归实测：丢失后 js3 认领被 0.001 均值差翻转）。
  acquisitionVariant: 'readiness-efficiency',
};
if (candidateDescriptor.id !== 'joint-js5' || candidateDescriptor.adapter !== 'champion-guided') {
  throw new Error('JS5 候选描述符校验失败');
}

const champion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const championParameters = champion.parameters;

// ---- 1. 合并全部已知验证账本（防伪造小序号：累计全部已记账挑战） ----
const ledgerSources = [
  'training/reports/structure-challenge-rollout-confirm/validation-ledger.json', // PR #11 晋级挑战
  'training/reports/evolve-latest/validation-ledger.json',                       // 本地进化确认挑战
  'ai5/openevolve/experiments/reports/challenge-ai5-goal-remaining/validation-ledger.json',
  'ai5/openevolve/experiments/reports/challenge-ai5-goal-remaining-500/validation-ledger.json',
  'ai5/openevolve/experiments/reports/challenge-readiness-efficiency-500/validation-ledger.json',
  'ai5/openevolve/experiments/reports/challenge-readiness-efficiency-1000/validation-ledger.json', // challengeIndex=9（前任冠军晋级）
  'training/reports/js5-formal-challenge/validation-ledger.json', // challengeIndex=10（JS5 首次正式挑战；bundle 含接线前代码）
];
const merged = { history: [] };
for (const rel of ledgerSources) {
  const p = resolve(REPO_ROOT, rel);
  if (!p.startsWith(REPO_ROOT)) throw new Error(`账本路径越界：${rel}`);
  if (!existsSync(p)) { console.error(`账本缺失（跳过）：${rel}`); continue; }
  const ledger = JSON.parse(readFileSync(p, 'utf8'));
  for (const entry of ledger.history ?? []) {
    if (!merged.history.some(e => e.base === entry.base)) merged.history.push(entry);
  }
}
merged.challengeCount = validationChallengeCount({ history: merged.history });
const challengeIndex = merged.challengeCount + 1;
console.log(`历史已消费块 ${merged.history.length} 个，累计确认挑战 ${merged.challengeCount} 次 → 本次 challengeIndex=${challengeIndex}`);

// ---- 2. 分配并防重校验验证种子块（一次性消费；无论判定如何都记账） ----
const SEEDS = seedsArg;
const seedBase = nextValidationBase(merged);
assertBlockFree(seedBase, SEEDS, merged);
console.log(`本次验证种子块：[${seedBase}, ${seedBase + SEEDS})（验证池起点 ${VALIDATION_POOL_BASE}）`);

// ---- 3. 正式挑战（250 种子 × 2 局 = 500 局，双向配对 + 座位轮换 + 冠军独占对手） ----
// deadlineMs 300s：方向 B 含 4 个 JS5 席位（每决策 100ms 预算），单局墙钟可达 ~90s。
console.log(`开始正式挑战：${SEEDS} 种子 × 2 方向（预计 40-90 分钟）...`);
const startedAt = Date.now();
const { summary, games } = challengeWithDecision({
  champion: championParameters,
  candidate: candidateDescriptor,
  seeds: SEEDS,
  seedBase,
  minSeeds: 60,
  challengeIndex,
  deadlineMs: 300_000,
});
console.log(`挑战完成（${Math.round((Date.now() - startedAt) / 60000)} 分钟）`);
console.log(JSON.stringify({
  verdict: summary.decision.verdict, reason: summary.decision.reason,
  paired: summary.paired, candidateWinRate: summary.candidateWinRate,
  firstPlace: summary.firstPlace?.rate ?? null,
  anomalyRate: summary.anomalyRate,
}, null, 2));

// ---- 4. 产出晋级脚本兼容的 candidate.json + 续接账本 ----
const ledger = consumeLedger(merged, seedBase, SEEDS);
writeFileSync(resolve(outDir, 'candidate.json'), JSON.stringify({
  id: candidateDescriptor.id,
  name: 'AI6 JS5 冠军引导选择性联合搜索（PR #27）',
  description: '结构候选：冠军束搜索（冻结参数）生成默认行动，竞争门控（座位感知目标存活+终局触发）开启选择性多世界 CRN 联合仲裁，保守覆盖（挑战者稳健分须超冠军 0.02）。' +
    '决策核心 web-v1/src/js/champion-guided.ts（PR #27 合并 c2053a8）；模拟器经 version.adapter=\'champion-guided\' 显式按席位注入，冠军席位永远运行官方 chooseAIAction。',
  basedOn: champion.id,
  parameters: candidateDescriptor,
  confirmation: {
    seeds: SEEDS, games: summary.finishedGames,
    seedBase,
    challengeIndex,
    alphaBudget: summary.decision.alphaBudget,
    paired: summary.paired,
    seedPairs: summary.seedPairs,
    firstPlace: summary.firstPlace,
    winRate: summary.candidateWinRate, pairedDiff: summary.pairedDiffCI,
    ci: summary.decision.ci, decision: summary.decision,
  },
  engineBundleSha256: engineBundleSha256(),
  codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  generatedAt: new Date().toISOString(),
}, null, 2));
writeFileSync(resolve(outDir, 'validation-ledger.json'), JSON.stringify(ledger, null, 2));
writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(resolve(outDir, 'games.json'), JSON.stringify(games, null, 2));
console.log(`证据目录：${outDir}`);
