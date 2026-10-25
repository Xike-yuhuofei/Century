#!/usr/bin/env node
/** 冠军晋级脚本（AI7 任务 A4：晋级治理 fail-closed）。
 *
 * 与 AI6 版本的差异（全部为收紧，不放宽任何既有条件）：
 * 1. 验证账本强制：候选同目录必须存在 validation-ledger.json，且账本合并了
 *    全局正式挑战历史（challengeCount 必须等于本次最大 challengeIndex）；
 * 2. 统一跨系统种子治理：AI4 evolve / OpenEvolve / 深度验证 / PPO arena /
 *    联赛 / 基线账本全部纳入冲突查询；证据区间必须已登记，不得与其它用途重叠；
 * 3. 人数覆盖：必须提供 2/3/4/5 人各自独立成次的证据（seatEvidence），缺任一
 *    人数、任一 seatCount 判定非 promote、或证据未登记 → 拒绝晋级；
 * 4. 双指纹：证据的 engineBundleSha256 必须等于当前运行产物闭包，
 *    sourceClosureSha256 必须等于当前源码闭包（源码改动但未重建 → 拒绝）；
 * 5. 历史归档不可变：同名归档已存在且内容不同 → 拒绝；已在该 id 的冠军记录
 *    不得被重新晋级覆盖（不通过改写 provenance 消除指纹漂移）；
 * 6. 人工批准机制保留：脚本只产出待审记录，apply-champion 与 PR 审核仍由人执行。
 *
 * 用法：
 *   node training/scripts/promote-champion.mjs --candidate <候选文件> \
 *     [--seat-evidence <另一人数的证据文件> ...] \
 *     [--champion training/champions/champion.json] [--min-seeds 60] \
 *     [--governance-central training/governance/seed-consumption-registry.json]
 *
 * 候选文件可以是：
 * - run-formal-challenge-js5.mjs 产出的单人数证据（seatEvidence 数组 1 条）；
 * - 汇总文件（seatEvidence 数组覆盖 2–5 人）；
 * - --seat-evidence 传入的多个单人数证据文件（按 seatCount 去重合并）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { ensureDir, readJSON } from '../lib/io.mjs';
import { requireBuiltEngine, REPO_ROOT, buildProvenance } from '../lib/paths.mjs';
import { pairedPromotionDecision, alphaSpendingThreshold, PROMOTION_ALPHA_BUDGET } from '../evaluator/stats.mjs';
import { VALIDATION_POOL_BASE, VALIDATION_POOL_MAX, validationChallengeCount } from '../lib/seeds.mjs';
import { loadSeedGovernance, assertPromotionEvidenceRegistered, formalChallengeCount } from '../lib/seed-governance.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { championParametersSha256 } from '../../web-v1/scripts/build-hash.mjs';

const REQUIRED_SEAT_COUNTS = Object.freeze([2, 3, 4, 5]);

function parseArgs(argv) {
  const values = {};
  const repeated = { '--seat-evidence': [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else {
      if (arg === '--seat-evidence') repeated[arg].push(next);
      else values[key] = next;
      i++;
    }
  }
  return { values, seatEvidenceArgs: repeated['--seat-evidence'] };
}

const { values: args, seatEvidenceArgs } = parseArgs(process.argv.slice(2));
if (!args.candidate) {
  console.error('必须提供 --candidate <候选文件>');
  process.exit(2);
}
// P0 迁移守卫：本脚本的判据是「配对得分优势率」，不再是冠军晋级的有效依据。
// 仅允许作为历史复现工具运行，且复现产物写入 reports 目录，绝不改写正式冠军。
const legacyReproduction = args['legacy-reproduction'] === true;
if (!legacyReproduction) {
  console.error(
    '拒绝执行：旧晋级判据（配对得分优势率）已不是冠军晋级的有效依据。\n' +
    '请使用第一名率正式挑战与机器门禁：\n' +
    '  node training/tournament/run-first-place-challenge.mjs --candidate <file>\n' +
    '  node training/scripts/promote-first-place-champion.mjs --evidence ... --plan ... --candidate ...\n' +
    '如仅需历史复现，请显式传 --legacy-reproduction（输出到 training/reports/legacy-reproduction/，不改正式冠军）。',
  );
  process.exit(4);
}
const minSeedsFloor = args['min-seeds'] !== undefined ? Number(args['min-seeds']) : 60;
if (!Number.isSafeInteger(minSeedsFloor) || minSeedsFloor < 1) {
  throw new Error('--min-seeds 必须为正整数');
}
const championPath = legacyReproduction
  ? (args.champion !== undefined
      ? resolve(process.cwd(), args.champion)
      : resolve(REPO_ROOT, 'training/reports/legacy-reproduction/champion-reproduced.json'))
  : resolve(args.champion !== undefined ? process.cwd() : REPO_ROOT, args.champion ?? 'training/champions/champion.json');
const candidatePath = resolve(process.cwd(), args.candidate);
// 中央种子登记路径（隔离工作区/回归测试可注入；缺省为仓库正式登记）。
const centralRegistryPath = args['governance-central'] !== undefined
  ? resolve(process.cwd(), String(args['governance-central']))
  : undefined;

const built = requireBuiltEngine();
const currentProvenance = buildProvenance();
const candidate = readJSONSafe(candidatePath);
const parameters = candidate.parameters ?? candidate;
if (!parameters?.id) throw new Error('候选文件缺少 parameters.id');
const validatedParameters = validateAIParameters(parameters);
// 待发布冠军参数块身份（apply-champion 落地后应与 CHAMPION_PARAMETERS canonical 哈希一致）。
const expectedCandidateParameters = championParametersSha256(validatedParameters);

// ---- 证据文件集合：主候选 + --seat-evidence ----
const evidenceDocs = [candidate];
for (const rel of seatEvidenceArgs) {
  const p = resolve(process.cwd(), rel);
  evidenceDocs.push(readJSONSafe(p));
}
// AI7-A2/A4：证据文件必须描述同一候选参数身份（禁止混合不同候选的 seatCount 证据）。
for (const [index, doc] of evidenceDocs.entries()) {
  const docParams = doc.parameters ?? null;
  const docId = docParams?.id ?? doc.id ?? null;
  if (docId && docId !== parameters.id) {
    throw new Error(
      `证据文件 ${index === 0 ? candidatePath : seatEvidenceArgs[index - 1]} 的候选 id=${docId} ≠ 主候选 ${parameters.id}；` +
      '禁止混合不同候选的人数证据',
    );
  }
  if (docParams && canonicalJSON(docParams) !== canonicalJSON(parameters)) {
    throw new Error(
      `证据文件 ${index === 0 ? candidatePath : seatEvidenceArgs[index - 1]} 的候选参数与主候选不一致；` +
      '运行时实际消费的参数必须可核验且逐字段一致',
    );
  }
}

// ---- 账本强制：每个证据文件同目录必须有 validation-ledger.json ----
const ledgerPaths = [];
for (const [index, doc] of evidenceDocs.entries()) {
  const effectivePath = index === 0 ? candidatePath : resolve(process.cwd(), seatEvidenceArgs[index - 1]);
  const ledgerPath = join(dirname(effectivePath), 'validation-ledger.json');
  if (!existsSync(ledgerPath)) {
    throw new Error(
      `验证账本缺失（fail-closed）：${ledgerPath}\n` +
      'AI7-A4：晋级证据包必须随附验证账本（合并全局正式挑战历史）。缺失账本时 challengeIndex 可被伪造成更小序号，禁止晋级。',
    );
  }
  ledgerPaths.push(ledgerPath);
}

// ---- 汇总 seatEvidence ----
const seatMap = new Map();
for (const [index, doc] of evidenceDocs.entries()) {
  const sourcePath = index === 0 ? candidatePath : resolve(process.cwd(), seatEvidenceArgs[index - 1]);
  let entries = Array.isArray(doc.seatEvidence) ? doc.seatEvidence : [];
  // 兼容旧单人数布局：confirmation 内携带 seatCount。
  if (!entries.length && doc.confirmation && Number.isInteger(doc.confirmation.seatCount)) {
    entries = [{
      ...doc.confirmation,
      seatCount: doc.confirmation.seatCount,
      engineBundleSha256: doc.confirmation.engineBundleSha256 ?? doc.engineBundleSha256,
      codeCommit: doc.confirmation.codeCommit ?? doc.codeCommit,
      sourceClosureSha256: doc.confirmation.sourceClosureSha256 ?? doc.sourceClosureSha256,
    }];
  }
  if (!entries.length) {
    throw new Error(`证据文件 ${sourcePath} 缺少 seatEvidence（必须显式披露人数与逐人数证据）`);
  }
  for (const entry of entries) {
    const seatCount = Number(entry.seatCount);
    if (!Number.isInteger(seatCount) || seatCount < 2 || seatCount > 5) {
      throw new Error(`seatEvidence.seatCount 非法：${entry.seatCount}（必须 2–5）`);
    }
    if (seatMap.has(seatCount)) {
      throw new Error(`人数 ${seatCount} 的证据重复（每个 seatCount 只能有一份独立成次证据）`);
    }
    seatMap.set(seatCount, { entry, sourcePath });
  }
}

const missingSeats = REQUIRED_SEAT_COUNTS.filter(n => !seatMap.has(n));
if (missingSeats.length) {
  throw new Error(
    `晋级证据人数覆盖缺失：未提供 ${missingSeats.join('/')} 人局的正式挑战证据（已有 ${[...seatMap.keys()].sort().join('/')}）。` +
    'AI7-A4：缺失证据不得被标记 PASS；必须按人数独立成次挑战后重新晋级。',
  );
}

// ---- 逐人数独立核验（不信任自报结论） ----
const verifiedSeats = [];
for (const seatCount of REQUIRED_SEAT_COUNTS) {
  const { entry, sourcePath } = seatMap.get(seatCount);
  verifiedSeats.push(verifySeatEvidence({
    entry, seatCount, sourcePath, candidateId: parameters.id, currentProvenance,
  }));
}

// ---- 统一种子治理：证据必须已登记、不得跨用途重叠、challengeIndex 不得伪造 ----
const extraLedgers = [...new Set(ledgerPaths)].map((ledgerPath, i) => ({
  id: `promotion-ledger-${i}`,
  path: ledgerPath,
  required: true,
}));
const governance = loadSeedGovernance({
  strict: true,
  extraLedgers,
  ...(centralRegistryPath ? { centralRegistryPath } : {}),
});
const seatEvidence = verifiedSeats.map(v => ({
  seatCount: v.seatCount,
  seeds: v.seeds,
  seedBase: v.seedBase,
  challengeIndex: v.challengeIndex,
}));
const governanceCheck = assertPromotionEvidenceRegistered({ registry: governance, seatEvidence });
const expectedMaxIndex = Math.max(...seatEvidence.map(s => s.challengeIndex));
if (governanceCheck.totalChallenges !== expectedMaxIndex) {
  throw new Error(
    `治理层累计正式挑战 ${governanceCheck.totalChallenges} ≠ 证据最大 challengeIndex ${expectedMaxIndex}；证据账本不完整，禁止晋级`,
  );
}
// 至少一份随附账本必须是完整累计账本：history 覆盖全部正式挑战区间，
// 且 challengeCount 等于证据最大序号。早先人数的单次账本可以只到自己的
// challengeIndex（它们仍参与逐区间登记校验），但最终挑战的账本必须合并全局历史。
const formalEntries = governance.entries.filter(e => e.countsTowardChallengeIndex === true);
const ledgerReports = [...new Set(ledgerPaths)].map(path => {
  const ledger = readJSON(path);
  const seen = new Set((ledger.history ?? [])
    .filter(e => Number.isSafeInteger(Number(e?.base)) && Number.isSafeInteger(Number(e?.size)))
    .map(e => `${Number(e.base)}:${Number(e.size)}`));
  const covered = formalEntries.filter(e => seen.has(`${e.base}:${e.size}`)).length;
  return {
    path,
    count: validationChallengeCount(ledger),
    covered,
    required: formalEntries.length,
    complete: covered === formalEntries.length && validationChallengeCount(ledger) === expectedMaxIndex,
  };
});
if (!ledgerReports.some(entry => entry.complete)) {
  throw new Error(
    `随附账本没有任何一份是完整累计账本（必须覆盖全部 ${formalEntries.length} 个正式挑战区间，` +
    `且 challengeCount=${expectedMaxIndex}）：` +
    `${ledgerReports.map(e => `${e.path}（覆盖 ${e.covered}/${e.required}，challengeCount=${e.count}）`).join('，')}；` +
    '禁止用局部/重建的小账本伪造低序号',
  );
}

// ---- 历史不可变：归档同 id 内容不同 → 拒绝；已有冠军同 id → 拒绝重晋级 ----
const archiveDir = join(dirname(championPath), 'candidates');
ensureDir(archiveDir);
const archiveFile = join(archiveDir, `${parameters.id}.json`);
if (existsSync(archiveFile)) {
  const existing = readJSON(archiveFile);
  if (canonicalJSON(existing) !== canonicalJSON(candidate)) {
    throw new Error(
      `同名晋级归档已存在且内容不同：${archiveFile}\n` +
      'AI7-A4：历史算法版本不可变。不得覆盖归档以改写历史身份；新候选必须使用新 id。',
    );
  }
}
if (existsSync(championPath)) {
  const existingChampion = readJSON(championPath);
  if (existingChampion?.parameters?.id === parameters.id || existingChampion?.id === parameters.id) {
    throw new Error(
      `冠军 ${parameters.id} 已是当前活动冠军：禁止重新晋级覆盖其 provenance（不得以改写历史消除指纹漂移）；` +
      '如确需重新验证，请用新的候选 id 与新的正式挑战证据。',
    );
  }
}

// ---- 归档 + 写入冠军记录（不修改既有 provenance） ----
if (!existsSync(archiveFile)) {
  writeFileSync(archiveFile, JSON.stringify(candidate, null, 2) + '\n');
}
const primary = verifiedSeats.find(v => v.seatCount === 5) ?? verifiedSeats[0];
const record = {
  id: parameters.id,
  name: `AI 4.0 冠军 ${parameters.id}`,
  description: `由正式挑战证据晋级（基于 ${candidate.basedOn ?? '上一冠军'}）；2–5 人独立证据见 provenance.promotionEvidence。`,
  parameters: validatedParameters,
  provenance: {
    basedOn: candidate.basedOn ?? null,
    promotedAt: new Date().toISOString().slice(0, 10),
    engineBundleSha256: currentProvenance.engineBundleSha256,
    sourceClosureSha256: currentProvenance.sourceClosureSha256,
    // 规范化身份：决策核心（参数块占位）+ 待发布候选参数块。
    // apply-champion 落地并重建后，audit-gate 用这两项核验"部署 = 受试"，
    // 不再因预期中的参数块变化误报指纹漂移。
    decisionSourceSha256: currentProvenance.decisionSourceSha256,
    decisionArtifactSha256: currentProvenance.decisionArtifactSha256,
    championParametersSha256: expectedCandidateParameters,
    codeCommit: candidate.codeCommit ?? primary.codeCommit ?? null,
    build: {
      schema: currentProvenance.buildManifestSchema,
      generatedAt: currentProvenance.buildGeneratedAt,
      gitCommit: currentProvenance.buildGitCommit,
      gitDirty: currentProvenance.buildGitDirty,
      artifact: currentProvenance.engineBundleSha256,
      decisionArtifact: currentProvenance.decisionArtifactSha256,
      source: currentProvenance.sourceClosureSha256,
      decisionSource: currentProvenance.decisionSourceSha256,
      championParameters: expectedCandidateParameters,
    },
    promotionEvidence: {
      // 保留主证据（5p）字段，兼容既有审计读取；完整 2–5 人证据在 seats。
      ...primary.evidence,
      recalculated: primary.recalculated,
      verified: {
        challengeIndex: expectedMaxIndex,
        challengeIndexes: governanceCheck.challengeIndexes,
        alpha: primary.threshold.alpha,
        z: primary.threshold.z,
        ledgerCrossChecked: true,
        governance: {
          schema: governance.schema,
          sourceCount: governance.sources.length,
          formalChallengeCount: formalChallengeCount(governance),
          conflicts: governance.conflicts.length,
        },
      },
      seatCounts: REQUIRED_SEAT_COUNTS,
      seats: verifiedSeats.map(v => ({
        seatCount: v.seatCount,
        seeds: v.seeds,
        seedBase: v.seedBase,
        challengeIndex: v.challengeIndex,
        alpha: v.threshold.alpha,
        z: v.threshold.z,
        decision: v.decision,
        recalculated: v.recalculated,
        engineBundleSha256: v.engineBundleSha256,
        sourceClosureSha256: v.sourceClosureSha256,
        decisionSourceSha256: v.decisionSourceSha256,
        decisionArtifactSha256: v.decisionArtifactSha256,
        championParametersSha256: v.championParametersSha256,
        codeCommit: v.codeCommit,
        sourcePath: v.sourcePath,
      })),
      recalculatedAt: new Date().toISOString(),
    },
    candidateArchive: `candidates/${parameters.id}.json`,
  },
};
writeFileSync(championPath, JSON.stringify(record, null, 2) + '\n');

console.log(`冠军已晋级（待人工批准落地）：${parameters.id}`);
for (const seat of verifiedSeats) {
  console.log(`  ${seat.seatCount}p：${seat.recalculated.reason}`);
}
console.log(`  统一治理：累计正式挑战=${governanceCheck.totalChallenges}，challengeIndexes=${governanceCheck.challengeIndexes.join(',')}`);
console.log(`  产物指纹：${currentProvenance.engineBundleSha256.slice(0, 16)}；源码闭包：${currentProvenance.sourceClosureSha256.slice(0, 16)}`);
console.log(`  冠军记录：${championPath}`);
console.log(`  候选归档：${archiveFile}`);
console.log('后续步骤（人工）：PR 审核通过后执行 node training/scripts/apply-champion.mjs --champion ' + championPath);

// ---- 内部函数 ----
function verifySeatEvidence({ entry, seatCount, sourcePath, candidateId, currentProvenance }) {
  const seedPairs = entry.seedPairs;
  if (!Array.isArray(seedPairs) || seedPairs.length === 0) {
    throw new Error(`${seatCount}p 证据缺少逐种子配对证据（seedPairs），无法独立核验，禁止晋级`);
  }
  for (const pair of seedPairs) {
    if (!Number.isSafeInteger(pair?.seed) || (pair.status !== 'finished' && pair.status !== 'anomaly')) {
      throw new Error(`${seatCount}p 证据含非法 seedPairs 条目：${JSON.stringify(pair)?.slice(0, 120)}`);
    }
    if (pair.status === 'finished' && typeof pair.diff !== 'number') {
      throw new Error(`${seatCount}p 证据种子 ${pair.seed} 缺少分差字段 diff`);
    }
  }
  const seedBase = Number(entry.seedBase);
  if (!Number.isSafeInteger(seedBase) || seedBase < VALIDATION_POOL_BASE || seedBase >= VALIDATION_POOL_MAX) {
    throw new Error(`${seatCount}p 证据种子基数 ${entry.seedBase} 不在验证种子池内，证据无效`);
  }
  const challengeIndex = Number(entry.challengeIndex);
  if (!Number.isSafeInteger(challengeIndex) || challengeIndex < 1) {
    throw new Error(`${seatCount}p 证据缺少合法 challengeIndex（多重检验防线）`);
  }
  if (entry.alphaBudget !== PROMOTION_ALPHA_BUDGET) {
    throw new Error(`${seatCount}p 证据 alphaBudget ${entry.alphaBudget} 与系统预算 ${PROMOTION_ALPHA_BUDGET} 不一致`);
  }
  const decision = entry.decision;
  if (!decision?.promote) {
    throw new Error(`${seatCount}p 证据缺少 promote=true 判定；任一 seatCount 未通过 → 禁止晋级`);
  }
  // 双指纹（AI7-A4 规范化身份）：
  // - 决策核心源码/产物闭包：不含 CHAMPION-PARAMETERS 生成区，晋级/落地前后必须一致；
  // - 候选参数哈希：必须等于 apply-champion 落地后的 CHAMPION_PARAMETERS canonical 哈希。
  // 新证据必须同时携带三者；旧证据缺规范化字段时退化为全量产物/源码严格比对。
  const evidenceArtifact = entry.engineBundleSha256;
  const evidenceSource = entry.sourceClosureSha256;
  const evidenceDecisionSource = entry.decisionSourceSha256;
  const evidenceDecisionArtifact = entry.decisionArtifactSha256;
  const evidenceChampionParameters = entry.championParametersSha256;
  const normalized = /^[0-9a-f]{64}$/.test(String(evidenceDecisionSource ?? ''))
    && /^[0-9a-f]{64}$/.test(String(evidenceDecisionArtifact ?? ''))
    && /^[0-9a-f]{64}$/.test(String(evidenceChampionParameters ?? ''));
  if (normalized) {
    if (evidenceDecisionSource !== currentProvenance.decisionSourceSha256) {
      throw new Error(
        `${seatCount}p 证据决策核心源码与当前不一致（证据 ${evidenceDecisionSource.slice(0, 12)} ≠ 当前 ${currentProvenance.decisionSourceSha256.slice(0, 12)}）；` +
        '决策核心已变更，须重新挑战',
      );
    }
    if (evidenceDecisionArtifact !== currentProvenance.decisionArtifactSha256) {
      throw new Error(
        `${seatCount}p 证据决策核心产物闭包与当前不一致（证据 ${evidenceDecisionArtifact.slice(0, 12)} ≠ 当前 ${currentProvenance.decisionArtifactSha256.slice(0, 12)}）`,
      );
    }
    if (evidenceChampionParameters !== expectedCandidateParameters) {
      throw new Error(
        `${seatCount}p 证据候选参数哈希与待发布参数不一致（证据 ${evidenceChampionParameters.slice(0, 12)} ≠ 候选 ${expectedCandidateParameters.slice(0, 12)}）`,
      );
    }
  } else {
    if (evidenceArtifact !== currentProvenance.engineBundleSha256) {
      throw new Error(
        `${seatCount}p 证据产物指纹与当前编译产物不一致（证据 ${evidenceArtifact ?? '缺失'} ≠ 当前 ${currentProvenance.engineBundleSha256}）；` +
        '引擎在证据生成后变更，旧证据不适用',
      );
    }
    if (!/^[0-9a-f]{64}$/.test(String(evidenceSource ?? ''))) {
      throw new Error(`${seatCount}p 证据缺少源码闭包指纹（sourceClosureSha256）——无法证明构建输入一致，禁止晋级`);
    }
    if (evidenceSource !== currentProvenance.sourceClosureSha256) {
      throw new Error(
        `${seatCount}p 证据源码闭包与当前源码不一致（证据 ${evidenceSource.slice(0, 12)} ≠ 当前 ${currentProvenance.sourceClosureSha256.slice(0, 12)}）；` +
        '源码已变更，须重新构建并重新挑战',
      );
    }
  }
  const finishedPairs = seedPairs.filter(p => p.status === 'finished');
  if (!Number.isSafeInteger(entry.seeds) || entry.seeds !== seedPairs.length) {
    throw new Error(`${seatCount}p 自报种子数 ${entry.seeds} 与配对证据 ${seedPairs.length} 不一致`);
  }
  // AI7-A4：逐种子证据必须落在声明的验证块内（挑战协议使用连续种子
  // seedBase..seedBase+seeds-1）。否则可用训练/历史种子伪造一份"新块"证据。
  for (const pair of seedPairs) {
    if (pair.seed < seedBase || pair.seed >= seedBase + entry.seeds) {
      throw new Error(
        `${seatCount}p 证据种子 ${pair.seed} 不在声明区间 [${seedBase}, ${seedBase + entry.seeds})；` +
        '逐种子证据与账本登记区间不一致，禁止晋级',
      );
    }
  }
  // 唯一性由 pairedPromotionDecision 强制；长度相等 + 区间内 + 唯一 ⇒ 恰好覆盖整块。
  if (entry.games !== finishedPairs.length * 2) {
    throw new Error(`${seatCount}p 自报完成局数 ${entry.games} 与配对证据不一致`);
  }
  const threshold = alphaSpendingThreshold(challengeIndex, { alphaBudget: entry.alphaBudget });
  const recalculated = pairedPromotionDecision({ seedPairs, minSeeds: minSeedsFloor, z: threshold.z });
  if (!recalculated.promote) {
    throw new Error(`${seatCount}p 独立重算未通过（${recalculated.verdict}）：${recalculated.reason}`);
  }
  if (decision.ci && recalculated.ci && Math.abs(decision.ci.point - recalculated.ci.point) > 1e-9) {
    throw new Error(`${seatCount}p 自报优势率 ${decision.ci.point} 与重算 ${recalculated.ci.point} 不一致`);
  }
  if (decision.verdict !== recalculated.verdict) {
    throw new Error(`${seatCount}p 自报判定 ${decision.verdict} 与重算 ${recalculated.verdict} 不一致`);
  }
  if (Number.isFinite(decision.z) && Math.abs(decision.z - threshold.z) > 1e-6) {
    throw new Error(`${seatCount}p 自报检验阈值 z=${decision.z} 与按 challengeIndex 重算 z=${threshold.z.toFixed(6)} 不一致`);
  }
  return {
    seatCount,
    seeds: entry.seeds,
    seedBase,
    challengeIndex,
    threshold,
    decision,
    recalculated,
    evidence: entry,
    engineBundleSha256: evidenceArtifact,
    sourceClosureSha256: evidenceSource,
    decisionSourceSha256: evidenceDecisionSource,
    decisionArtifactSha256: evidenceDecisionArtifact,
    championParametersSha256: evidenceChampionParameters,
    codeCommit: entry.codeCommit ?? null,
    sourcePath,
  };
}

function readJSONSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`文件不可读或非法 JSON：${path}（${error.message}）`);
  }
}

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}
