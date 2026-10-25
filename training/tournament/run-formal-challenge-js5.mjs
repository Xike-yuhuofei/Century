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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consumeLedger, VALIDATION_POOL_BASE } from '../lib/seeds.mjs';
import {
  loadSeedGovernance, nextFormalValidationBase, formalChallengeCount,
  assertFormalChallengeAllocation, reserveConsumption, completeConsumption,
  CENTRAL_REGISTRY_PATH,
} from '../lib/seed-governance.mjs';
import { challengeWithDecision } from './challenge.mjs';
import { requireBuiltEngine, engineBundleSha256, buildProvenance, REPO_ROOT } from '../lib/paths.mjs';
import { DEFAULT_SIM_SALT } from '../lib/sim-stream.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { championParametersSha256 } from '../../web-v1/scripts/build-hash.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const seatsArg = args.includes('--seats') ? Number(args[args.indexOf('--seats') + 1]) : 5;
if (!Number.isSafeInteger(seatsArg) || seatsArg < 2 || seatsArg > 5) {
  throw new Error(`--seats 必须为 2–5 的整数（按人数独立挑战），实际：${seatsArg}`);
}
const outDir = args.includes('--out')
  ? resolve(process.cwd(), args[args.indexOf('--out') + 1])
  : resolve(REPO_ROOT, seatsArg === 5 ? 'training/reports/js5-promotion-challenge' : `training/reports/js5-promotion-challenge-seat${seatsArg}`);
mkdirSync(outDir, { recursive: true });
requireBuiltEngine();

const seedsArg = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 250;
if (!Number.isSafeInteger(seedsArg) || seedsArg < 60 || seedsArg > 2000) {
  throw new Error(`--seeds 必须为 60–2000 的整数（决定性下限 60 + 余量），实际：${seedsArg}`);
}

// ---- 0. 运行指纹在进程启动时捕获（教训：结束时捕获不对应实际加载代码——
// challenge-11 事故：并行改动晚于模块加载，证据 codeCommit 失真已用 provenance 更正）。
const CODE_COMMIT_AT_START = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
requireBuiltEngine();
const ENGINE_BUNDLE_AT_START = engineBundleSha256();

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
// 候选参数规范化身份：与 apply-champion 落地后的 CHAMPION_PARAMETERS 同一 canonical 口径。
const candidateParametersForIdentity = validateAIParameters(candidateDescriptor);
const CANDIDATE_PARAMETERS_SHA256 = championParametersSha256(candidateParametersForIdentity);

const champion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const championParameters = champion.parameters;

// ---- 1. 统一跨系统种子治理（AI7-A1）：AI4 evolve + OpenEvolve 正式挑战 +
// 深度验证 + PPO arena + 联赛 + 基线账本全部只读纳入；缺失/冲突 fail-closed。
// challengeIndex = 唯一正式挑战区间数 + 1（不信任任一账本自报 challengeCount）。
const SEEDS = seedsArg;
const governance = loadSeedGovernance({ strict: true });
const seedBase = nextFormalValidationBase(governance);
const challengeIndex = formalChallengeCount(governance) + 1;
assertFormalChallengeAllocation({ registry: governance, base: seedBase, size: SEEDS, challengeIndex });
const experimentId = `js5-formal-seat${seatsArg}-${challengeIndex}`;
// 动用种子前原子登记（跨系统防重）；作废/中止也继续占用区间，绝不"作废即复用"。
reserveConsumption({
  purposeClass: 'formal-challenge',
  purpose: `js5-formal-challenge@${seatsArg}p`,
  base: seedBase,
  size: SEEDS,
  experimentId,
  challengeIndex,
  evidencePath: outDir,
  codeCommit: CODE_COMMIT_AT_START,
  registryPath: CENTRAL_REGISTRY_PATH,
});
console.log(`治理层来源 ${governance.sources.length} 个，累计正式挑战 ${formalChallengeCount(governance)} 次 → 本次 challengeIndex=${challengeIndex}`);
console.log(`本次验证种子块：[${seedBase}, ${seedBase + SEEDS})（验证池起点 ${VALIDATION_POOL_BASE}）`);
console.log(`运行指纹（进程启动时捕获）：codeCommit=${CODE_COMMIT_AT_START.slice(0, 12)} engineBundle=${ENGINE_BUNDLE_AT_START.slice(0, 12)}`);

// ---- 3. 正式挑战（默认 250 种子 × 2 局 = 500 局，双向配对 + 座位轮换 + 冠军独占对手） ----
// deadlineMs 300s：方向 B 含 4 个 JS5 席位（每决策 100ms 预算），单局墙钟可达 ~90s。
// P0-5：--seats 2..5 支持按人数执行独立挑战（每种人数单独成次、跨人数不合并判定）；
// 缺省 5 = 历史协议口径。本脚本绝不在整改中自动执行挑战（不消费验证池）。
console.log(`开始正式挑战：${SEEDS} 种子 × 2 方向 × ${seatsArg} 人（预计 40-90 分钟）...`);
const startedAt = Date.now();
const { summary, games } = challengeWithDecision({
  champion: championParameters,
  candidate: candidateDescriptor,
  seeds: SEEDS,
  seedBase,
  seatCount: seatsArg,
  minSeeds: 60,
  challengeIndex,
  deadlineMs: 300_000,
});
// ---- 3.5 代码冻结校验：挑战全程产物指纹不得漂移（实际执行产物 = 受试产物） ----
const ENGINE_BUNDLE_AT_END = engineBundleSha256();
const codeFrozen = ENGINE_BUNDLE_AT_END === ENGINE_BUNDLE_AT_START;
if (!codeFrozen) {
  throw new Error(
    `代码冻结校验失败：引擎产物指纹在挑战过程中漂移（start=${ENGINE_BUNDLE_AT_START.slice(0, 12)} end=${ENGINE_BUNDLE_AT_END.slice(0, 12)}）——` +
    '并行会话重建了 dist。本次运行证据按纪律作废（不计入晋级），先隔离运行环境。',
  );
}
console.log(`挑战完成（${Math.round((Date.now() - startedAt) / 60000)} 分钟）；代码冻结校验通过（bundle ${ENGINE_BUNDLE_AT_END.slice(0, 12)}）`);
console.log(JSON.stringify({
  verdict: summary.decision.verdict, reason: summary.decision.reason,
  paired: summary.paired, candidateWinRate: summary.candidateWinRate,
  firstPlace: summary.firstPlace?.rate ?? null,
  anomalyRate: summary.anomalyRate,
}, null, 2));

// ---- 4. 产出晋级脚本兼容的 candidate.json + 续接账本 ----
// 账本合并治理层已识别的全部正式挑战区间 → challengeCount = 全局累计（本次为最后一个）。
const formalHistory = governance.entries
  .filter(e => e.countsTowardChallengeIndex === true)
  .map(e => ({ base: e.base, size: e.size, at: e.rawAt ?? null }));
const ledger = consumeLedger(
  { history: formalHistory, challengeCount: formalChallengeCount(governance) },
  seedBase,
  SEEDS,
  { challengeIndex, purpose: `js5-formal-challenge@${seatsArg}p`, experimentId, source: 'run-formal-challenge-js5' },
);
completeConsumption(experimentId, {
  status: codeFrozen ? 'completed' : 'voided',
  evidencePath: outDir,
  note: `seatCount=${seatsArg} decision=${summary.decision.verdict} challengeIndex=${challengeIndex}`,
  registryPath: CENTRAL_REGISTRY_PATH,
});
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
    seatCount: seatsArg,
  },
  ...buildProvenance(),
  engineBundleSha256: ENGINE_BUNDLE_AT_START,
  championParametersSha256: CANDIDATE_PARAMETERS_SHA256,
  codeCommit: CODE_COMMIT_AT_START,
  seatCount: seatsArg,
  // AI7-A4：每次运行只覆盖一种人数；完整晋级由 promote-champion 汇总 2–5 人
  // 的独立证据文件（--seat-evidence），缺任一人数不得晋级。
  seatEvidence: [{
    seatCount: seatsArg,
    seeds: SEEDS,
    seedBase,
    challengeIndex,
    engineBundleSha256: ENGINE_BUNDLE_AT_START,
    sourceClosureSha256: buildProvenance().sourceClosureSha256,
    decisionSourceSha256: buildProvenance().decisionSourceSha256,
    decisionArtifactSha256: buildProvenance().decisionArtifactSha256,
    championParametersSha256: CANDIDATE_PARAMETERS_SHA256,
    codeCommit: CODE_COMMIT_AT_START,
    decision: summary.decision,
    seedPairs: summary.seedPairs,
    primaryMetric: summary.primaryMetric,
  }],
  seatCoverage: {
    required: [2, 3, 4, 5],
    covered: [seatsArg],
    complete: false,
    note: '单次挑战只覆盖一种人数；晋级必须汇总 2/3/4/5 各自独立成次的证据',
  },
  promotionEligible: false,
  governance: {
    schema: governance.schema,
    purposeClass: 'formal-challenge',
    challengeIndex,
    formalChallengeCount: formalChallengeCount(governance),
    registeredInCentral: true,
    experimentId,
    sourceCount: governance.sources.length,
    conflicts: governance.conflicts.length,
  },
  primaryMetric: summary.primaryMetric,
  // P0-5 随机流留痕：AI 信念采样流 = deriveSimStreamSeed(对局种子, salt)——
  // 独立域单向派生，不暴露真实洗牌种子；来源与盐值随证据落盘可审计。
  simStream: {
    domain: 'derived-v1',
    salt: DEFAULT_SIM_SALT,
    derivation: 'simSeed = sha256(salt:对局种子) 截断 31 位（training/lib/sim-stream.mjs）',
    note: '游戏真实牌库 RNG（引擎内部）与 AI 信念采样 RNG 逻辑隔离；同盐同种子 ⇒ 同流（配对 CRN 保持）',
  },
  runFingerprints: {
    engineBundleAtStart: ENGINE_BUNDLE_AT_START,
    engineBundleAtEnd: ENGINE_BUNDLE_AT_END,
    codeFrozen: true,
    capturedAt: 'process-start（受试代码 = 实际加载代码）',
  },
  generatedAt: new Date().toISOString(),
}, null, 2));
writeFileSync(resolve(outDir, 'validation-ledger.json'), JSON.stringify(ledger, null, 2));
writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(resolve(outDir, 'games.json'), JSON.stringify(games, null, 2));
console.log(`证据目录：${outDir}`);
