/** 冠军晋级脚本回归（AI7-A4：账本强制 / 统一治理 / 2–5 人覆盖 / 双指纹 / 历史不可变）。
 *
 * 所有正向夹具都使用「当前构建 + 当前源码闭包」的真实指纹，并在临时目录写一份
 * 合并全局正式挑战历史的账本；测试不写 training/governance 中央登记，也不消费
 * 任何真实验证种子。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedPromotionDecision, alphaSpendingThreshold, PROMOTION_ALPHA_BUDGET } from '../evaluator/stats.mjs';
import { VALIDATION_POOL_BASE, VALIDATION_STRIDE } from '../lib/seeds.mjs';
import { buildProvenance } from '../lib/paths.mjs';
import { championParametersSha256 } from '../../web-v1/scripts/build-hash.mjs';
import {
  loadSeedGovernance, nextFormalValidationBase, formalChallengeCount,
} from '../lib/seed-governance.mjs';

const TRAINING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = buildProvenance();
const GOVERNANCE = loadSeedGovernance({ strict: true });
const FIRST_INDEX = formalChallengeCount(GOVERNANCE) + 1;
const SEEDS_PER_SEAT = 100;

/** 2/3/4/5 人各自独立成次的种子块（严格接在治理层下一块之后）。 */
const SEAT_BLOCKS = (() => {
  let base = nextFormalValidationBase(GOVERNANCE);
  return [2, 3, 4, 5].map((seatCount, i) => {
    const block = { seatCount, base, size: SEEDS_PER_SEAT, challengeIndex: FIRST_INDEX + i };
    base = base + SEEDS_PER_SEAT + VALIDATION_STRIDE;
    return block;
  });
})();

function makeSeedPairs(total, winRate, base) {
  const wins = Math.round(total * winRate);
  return Array.from({ length: total }, (_, i) => ({
    seed: base + i,
    status: 'finished',
    diff: i < wins ? 2.5 : -1.5,
    anomalies: 0,
  }));
}

function makeSeatEvidence(block, overrides = {}) {
  const seeds = overrides.seeds ?? block.size;
  const seedPairs = overrides.seedPairs ?? makeSeedPairs(seeds, overrides.winRate ?? 1, overrides.base ?? block.base);
  const challengeIndex = overrides.challengeIndex ?? block.challengeIndex;
  const threshold = alphaSpendingThreshold(challengeIndex);
  const recalculated = pairedPromotionDecision({ seedPairs, minSeeds: 60, z: threshold.z });
  const decision = overrides.decision ?? {
    ...recalculated,
    promote: overrides.promote ?? true,
    verdict: (overrides.promote ?? true) ? 'promote' : 'inconclusive',
  };
  return {
    seatCount: overrides.seatCount ?? block.seatCount,
    seeds,
    games: overrides.games ?? seedPairs.filter(p => p.status === 'finished').length * 2,
    seedBase: overrides.base ?? block.base,
    challengeIndex,
    alphaBudget: overrides.alphaBudget ?? PROMOTION_ALPHA_BUDGET,
    engineBundleSha256: overrides.engineBundleSha256 ?? CURRENT.engineBundleSha256,
    sourceClosureSha256: 'sourceClosureSha256' in overrides ? overrides.sourceClosureSha256 : CURRENT.sourceClosureSha256,
    decisionSourceSha256: overrides.decisionSourceSha256 ?? CURRENT.decisionSourceSha256,
    decisionArtifactSha256: overrides.decisionArtifactSha256 ?? CURRENT.decisionArtifactSha256,
    ...('championParametersSha256' in overrides
      ? { championParametersSha256: overrides.championParametersSha256 }
      : {}),
    codeCommit: CURRENT.buildGitCommit ?? 'test-commit',
    seedPairs,
    paired: {
      seeds: seedPairs.length,
      finished: seedPairs.length,
      won: seedPairs.filter(p => p.diff > 0).length,
      lost: seedPairs.filter(p => p.diff < 0).length,
      tied: seedPairs.filter(p => p.diff === 0).length,
    },
    firstPlace: { rate: 0.9 },
    winRate: 0.9,
    pairedDiff: recalculated.ci,
    ci: recalculated.ci,
    decision,
  };
}

function makeCandidate(id, overrides = {}) {
  const seatEvidence = overrides.seatEvidence ?? SEAT_BLOCKS.map(block => makeSeatEvidence(block));
  return {
    id,
    basedOn: 'v4.0-baseline',
    parameters: {
      id, engineWeight: 1.05, tempoWeight: 0.98, contestWeight: 1.1, synergyWeight: 1,
      goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
      ...overrides.parameters,
    },
    confirmation: seatEvidence.find(e => e.seatCount === 5) ?? seatEvidence[0],
    seatEvidence,
    seatCoverage: {
      required: [2, 3, 4, 5],
      covered: seatEvidence.map(e => e.seatCount).sort((a, b) => a - b),
      complete: true,
      note: 'test fixture：四个独立成次挑战',
    },
    promotionEligible: true,
    engineBundleSha256: CURRENT.engineBundleSha256,
    sourceClosureSha256: CURRENT.sourceClosureSha256,
    codeCommit: CURRENT.buildGitCommit ?? 'test-commit',
    generatedAt: new Date().toISOString(),
  };
}

/** 合并全局正式挑战历史 + 4 个新人数的账本（每个新条目记录 challengeIndex）。 */
function writeLedger(sandbox, seatEvidence = SEAT_BLOCKS.map(b => makeSeatEvidence(b)), {
  includeHistory = true, extraEntries = [],
} = {}) {
  const formal = includeHistory ? GOVERNANCE.entries
    .filter(e => e.countsTowardChallengeIndex === true)
    .map(e => ({ base: e.base, size: e.size, at: e.rawAt ?? null, challengeIndex: e.challengeIndex ?? undefined })) : [];
  const additions = seatEvidence.map(e => ({
    base: e.seedBase,
    size: e.seeds,
    at: new Date().toISOString(),
    challengeIndex: e.challengeIndex,
    purpose: `test@${e.seatCount}p`,
  }));
  const byBase = new Map();
  for (const entry of [...formal, ...additions, ...extraEntries]) {
    if (!byBase.has(entry.base)) byBase.set(entry.base, entry);
  }
  const history = [...byBase.values()].sort((a, b) => a.base - b.base);
  writeFileSync(join(sandbox, 'validation-ledger.json'), JSON.stringify({
    lastBase: Math.max(...history.map(e => e.base)),
    challengeCount: FIRST_INDEX + 3,
    history,
  }, null, 2));
}

/** 中央种子登记夹具：新证据（challengeIndex > 历史累计）必须在此有已完成记录。 */
function writeCentralRegistry(sandbox, seatEvidence, { status = 'completed', omitSeatCounts = [] } = {}) {
  const entries = seatEvidence
    .filter(e => !omitSeatCounts.includes(e.seatCount))
    .map(e => ({
      experimentId: `test-central-${e.seatCount}p-${e.challengeIndex}`,
      base: e.seedBase,
      size: e.seeds,
      purposeClass: 'formal-challenge',
      purpose: `test@${e.seatCount}p`,
      status,
      countsTowardChallengeIndex: true,
      challengeIndex: e.challengeIndex,
    }));
  const path = join(sandbox, 'central-registry.json');
  writeFileSync(path, JSON.stringify({
    schema: 'century-seed-consumption-registry-v1',
    createdAt: new Date().toISOString(),
    entries,
  }, null, 2));
  return path;
}

function runPromote(sandbox, candidate, {
  writeLedgerFile = true, writeCentralFile = true, extraArgs = [],
  ledgerOptions = {}, centralOptions = {},
} = {}) {
  const candidateFile = join(sandbox, 'candidate.json');
  // 测试夹具：为未显式覆盖参数哈希的 seatEvidence 绑定主候选参数哈希；
  // 针对参数哈希的负向用例会显式提供错误值，不会被覆盖。
  const expectedParametersHash = championParametersSha256(candidate.parameters);
  const bound = {
    ...candidate,
    seatEvidence: (candidate.seatEvidence ?? []).map(entry => ({
      ...entry,
      ...(entry.championParametersSha256 ? {} : { championParametersSha256: expectedParametersHash }),
    })),
  };
  bound.confirmation = bound.seatEvidence.find(e => e.seatCount === 5) ?? bound.seatEvidence[0] ?? bound.confirmation;
  writeFileSync(candidateFile, JSON.stringify(bound, null, 2));
  let evidence = candidate.seatEvidence ?? [];
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] !== '--seat-evidence') continue;
    const doc = JSON.parse(readFileSync(extraArgs[i + 1], 'utf8'));
    evidence = [...evidence, ...(doc.seatEvidence ?? [])];
  }
  if (writeLedgerFile) writeLedger(sandbox, evidence, ledgerOptions);
  const centralArgs = writeCentralFile
    ? ['--governance-central', writeCentralRegistry(sandbox, evidence, centralOptions)]
    : [];
  return execFileSync(process.execPath, [
    join(TRAINING_ROOT, 'scripts', 'promote-champion.mjs'),
    '--candidate', candidateFile,
    '--champion', join(sandbox, 'champion.json'),
    // P0 迁移：旧判据只允许作为历史复现工具运行；测试固定沙箱 champion 路径，
    // 不触碰正式冠军。正式晋级见 promote-first-place-champion.mjs。
    '--legacy-reproduction',
    ...extraArgs,
    ...centralArgs,
  ], { stdio: 'pipe' });
}

test('晋级：四人数完整证据 + 账本 + 双指纹 → 归档并写入待人工批准记录', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-ok-'));
  const candidate = makeCandidate('evo-g9-test');
  runPromote(sandbox, candidate);
  const archiveFile = join(sandbox, 'candidates', 'evo-g9-test.json');
  assert.ok(existsSync(archiveFile), '候选必须归档到 candidates/ 目录');
  const champion = JSON.parse(readFileSync(join(sandbox, 'champion.json'), 'utf8'));
  assert.equal(champion.id, 'evo-g9-test');
  assert.equal(champion.parameters.engineWeight, 1.05);
  assert.equal(champion.provenance.basedOn, 'v4.0-baseline');
  assert.equal(champion.provenance.engineBundleSha256, CURRENT.engineBundleSha256);
  assert.equal(champion.provenance.sourceClosureSha256, CURRENT.sourceClosureSha256);
  assert.equal(champion.provenance.decisionSourceSha256, CURRENT.decisionSourceSha256);
  assert.equal(champion.provenance.decisionArtifactSha256, CURRENT.decisionArtifactSha256);
  assert.equal(
    champion.provenance.championParametersSha256,
    championParametersSha256(candidate.parameters),
    '冠军记录必须携带待发布候选参数哈希',
  );
  assert.deepEqual(champion.provenance.promotionEvidence.seatCounts, [2, 3, 4, 5]);
  assert.equal(champion.provenance.promotionEvidence.seats.length, 4);
  assert.equal(champion.provenance.promotionEvidence.verified.ledgerCrossChecked, true);
  assert.equal(champion.provenance.promotionEvidence.verified.challengeIndex, FIRST_INDEX + 3);
  assert.ok(champion.provenance.promotionEvidence.recalculated.promote, '必须记录独立重算判定');
});

test('晋级：缺少验证账本必须被拒绝（账本强制，不再条件性核对）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-noledger-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-noledger'), { writeLedgerFile: false }),
    /账本缺失|fail-closed/,
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级：缺少 2/3/4/5 任一人口证据必须被拒绝（缺失证据不得 PASS）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-noseat-'));
  const full = makeCandidate('evo-g9-noseat');
  const partial = { ...full, seatEvidence: full.seatEvidence.filter(e => e.seatCount !== 3) };
  assert.throws(() => runPromote(sandbox, partial), /人数覆盖缺失|未提供 3/, '3p 缺失必须拒绝');
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级：任一 seatCount 判定非 promote 必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-oneseatlose-'));
  const candidate = makeCandidate('evo-g9-oneseatlose');
  candidate.seatEvidence[1] = makeSeatEvidence(SEAT_BLOCKS[1], { promote: false });
  candidate.confirmation = candidate.seatEvidence.find(e => e.seatCount === 5);
  assert.throws(
    () => runPromote(sandbox, candidate),
    /promote=true|独立重算|未通过/,
    '任一人数未通过都不得晋级',
  );
});

test('晋级：伪造 promote 但配对证据不支持必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-forge-'));
  const candidate = makeCandidate('evo-g9-forge');
  candidate.seatEvidence = SEAT_BLOCKS.map(block => makeSeatEvidence(block, { winRate: 0.3 }));
  candidate.confirmation = candidate.seatEvidence.find(e => e.seatCount === 5);
  assert.throws(() => runPromote(sandbox, candidate), /独立重算|重算/, '必须用逐种子证据重算识破伪造结论');
});

test('晋级：自报种子数/局数与证据不一致必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-tamper-'));
  const candidate = makeCandidate('evo-g9-tamper');
  candidate.seatEvidence[0] = { ...candidate.seatEvidence[0], seeds: 300 };
  assert.throws(() => runPromote(sandbox, candidate), /种子数/, '自报种子数必须与逐种子证据一致');
});

test('晋级：逐种子证据替换为声明区间之外的种子必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-seed-substitute-'));
  const candidate = makeCandidate('evo-g9-seed-substitute');
  const seat = candidate.seatEvidence[0];
  candidate.seatEvidence[0] = {
    ...seat,
    seedPairs: seat.seedPairs.map((pair, i) => ({ ...pair, seed: seat.seedBase + 10_000 + i })),
  };
  candidate.confirmation = candidate.seatEvidence.find(e => e.seatCount === 5);
  assert.throws(
    () => runPromote(sandbox, candidate),
    /不在声明区间|账本登记区间不一致/,
    '声明的验证块与逐种子证据必须一致，禁止用其它种子冒充新块',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级：训练种子上的证据无效（必须来自验证池）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-pool-'));
  const candidate = makeCandidate('evo-g9-train');
  candidate.seatEvidence[0] = makeSeatEvidence(SEAT_BLOCKS[0], { base: 20261021 });
  assert.throws(() => runPromote(sandbox, candidate), /验证种子池/, '训练种子的确认挑战不构成晋级证据');
});

test('晋级：决定性种子不足门槛必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-small-'));
  const candidate = makeCandidate('evo-g9-small');
  candidate.seatEvidence[0] = makeSeatEvidence(SEAT_BLOCKS[0], { seeds: 30 });
  assert.throws(() => runPromote(sandbox, candidate), /不足/, '小样本证据不得混过晋级门槛');
});

test('晋级：参数越界必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-bound-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-bound', { parameters: { engineWeight: 99 } })),
    /参数|bounds|engineWeight/i,
  );
});

test('晋级：伪造 challengeIndex（小于全局累计）必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-idx-'));
  const candidate = makeCandidate('evo-g9-idx');
  candidate.seatEvidence = SEAT_BLOCKS.map((block, i) => makeSeatEvidence(block, { challengeIndex: i + 1 }));
  candidate.confirmation = candidate.seatEvidence.find(e => e.seatCount === 5);
  assert.throws(() => runPromote(sandbox, candidate), /challengeIndex|治理层/, '禁止伪造小序号换宽松阈值');
});

test('晋级：随附账本只有局部新条目（未合并全局正式挑战历史）必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-ledger-partial-'));
  const candidate = makeCandidate('evo-g9-ledger-partial');
  assert.throws(
    () => runPromote(sandbox, candidate, { ledgerOptions: { includeHistory: false } }),
    /累计|治理层|challengeIndex/,
    '局部小账本不得把全局累计挑战次数伪装成本次证据',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级：随附账本累计到比证据更大的 challengeIndex 必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-ledger-ahead-'));
  const candidate = makeCandidate('evo-g9-ledger-ahead');
  const extraBase = SEAT_BLOCKS[3].base + SEAT_BLOCKS[3].size + VALIDATION_STRIDE;
  assert.throws(
    () => runPromote(sandbox, candidate, {
      ledgerOptions: {
        extraEntries: [{
          base: extraBase, size: 100, at: new Date().toISOString(), challengeIndex: FIRST_INDEX + 4,
        }],
      },
    }),
    /累计|challengeIndex|治理层/,
    '账本领先于证据 = 证据不完整，必须拒绝',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级：新证据未在中央种子登记（重建/改名本地账本）必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-no-central-'));
  const candidate = makeCandidate('evo-g9-no-central');
  assert.throws(
    () => runPromote(sandbox, candidate, { writeCentralFile: false }),
    /中央|governance-central|没有该次挑战/,
    '仅靠本地账本（可重建/改名）不得登记新正式挑战',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级：中央登记状态为 voided 的挑战证据必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-voided-'));
  const candidate = makeCandidate('evo-g9-voided');
  assert.throws(
    () => runPromote(sandbox, candidate, { centralOptions: { status: 'voided' } }),
    /中央|已完成|governance-central/,
    '作废挑战继续占用种子，但不得作为晋级证据',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级：alphaBudget 被篡改必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-alpha-'));
  const candidate = makeCandidate('evo-g9-alpha');
  candidate.seatEvidence[0] = makeSeatEvidence(SEAT_BLOCKS[0], { alphaBudget: 0.2 });
  assert.throws(() => runPromote(sandbox, candidate), /alphaBudget/);
});

test('晋级：自报检验阈值 z 被篡改必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-z-'));
  const candidate = makeCandidate('evo-g9-z');
  const seat = candidate.seatEvidence[0];
  candidate.seatEvidence[0] = { ...seat, decision: { ...seat.decision, z: 1.0 } };
  assert.throws(() => runPromote(sandbox, candidate), /检验阈值|z=/);
});

test('晋级：决策核心产物指纹不一致必须被拒绝（证据失效）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-artifact-'));
  const candidate = makeCandidate('evo-g9-artifact');
  candidate.seatEvidence[0] = makeSeatEvidence(SEAT_BLOCKS[0], { decisionArtifactSha256: 'deadbeef'.repeat(8) });
  assert.throws(() => runPromote(sandbox, candidate), /决策核心产物|产物/);
});

test('晋级：旧布局（无规范化身份）缺失源码闭包必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-source-missing-'));
  const candidate = makeCandidate('evo-g9-source-missing');
  candidate.seatEvidence = candidate.seatEvidence.map(e => {
    const { decisionSourceSha256, decisionArtifactSha256, championParametersSha256, ...rest } = e;
    return { ...rest, sourceClosureSha256: undefined };
  });
  assert.throws(() => runPromote(sandbox, candidate), /源码闭包/);
});

test('晋级：决策核心源码不一致必须被拒绝（源码变更后未重新挑战）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-source-'));
  const candidate = makeCandidate('evo-g9-source');
  candidate.seatEvidence[0] = makeSeatEvidence(SEAT_BLOCKS[0], { decisionSourceSha256: 'ab'.repeat(32) });
  assert.throws(() => runPromote(sandbox, candidate), /决策核心源码/);
});

test('晋级：候选参数哈希与待发布参数不一致必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-params-'));
  const candidate = makeCandidate('evo-g9-params');
  // 显式错误值不会被 runPromote 夹具覆盖。
  candidate.seatEvidence[0] = makeSeatEvidence(SEAT_BLOCKS[0], { championParametersSha256: 'cd'.repeat(32) });
  assert.throws(() => runPromote(sandbox, candidate), /候选参数哈希/);
});

test('晋级：复用历史验证种子块必须被拒绝（区间已消费且序号不匹配）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-reuse-'));
  const candidate = makeCandidate('evo-g9-reuse');
  const historical = 941512402; // 当前冠军 challenge-11 的已消费块
  candidate.seatEvidence[0] = makeSeatEvidence(SEAT_BLOCKS[0], { base: historical });
  assert.throws(() => runPromote(sandbox, candidate), /challengeIndex|重叠|未登记|治理层/);
});

test('晋级：同名归档已存在且内容不同必须被拒绝（历史不可变）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-archive-'));
  const candidate = makeCandidate('evo-g9-archive');
  mkdirSync(join(sandbox, 'candidates'), { recursive: true });
  writeFileSync(join(sandbox, 'candidates', 'evo-g9-archive.json'), JSON.stringify({ id: 'old-content', parameters: { id: 'evo-g9-archive' } }));
  assert.throws(() => runPromote(sandbox, candidate), /归档已存在|历史算法版本不可变/);
});

test('晋级：已在该 id 的冠军不得被重新晋级覆盖 provenance', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-sameid-'));
  const candidate = makeCandidate('evo-g9-sameid');
  writeFileSync(join(sandbox, 'champion.json'), JSON.stringify({ id: 'evo-g9-sameid', parameters: { id: 'evo-g9-sameid' }, provenance: { engineBundleSha256: 'legacy' } }));
  assert.throws(() => runPromote(sandbox, candidate), /已是当前活动冠军|禁止重新晋级/);
});

test('晋级：--seat-evidence 可汇总单人数证据文件', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-separate-'));
  const five = SEAT_BLOCKS[3];
  const primary = makeCandidate('evo-g9-separate', {
    seatEvidence: [makeSeatEvidence(five)],
  });
  const extraFiles = SEAT_BLOCKS.slice(0, 3).map(block => {
    const file = join(sandbox, `seat-${block.seatCount}.json`);
    writeFileSync(file, JSON.stringify({
      id: 'evo-g9-separate',
      parameters: primary.parameters,
      seatEvidence: [{
        ...makeSeatEvidence(block),
        championParametersSha256: championParametersSha256(primary.parameters),
      }],
    }, null, 2));
    return file;
  });
  runPromote(sandbox, primary, {
    extraArgs: extraFiles.flatMap(file => ['--seat-evidence', file]),
  });
  const champion = JSON.parse(readFileSync(join(sandbox, 'champion.json'), 'utf8'));
  assert.equal(champion.provenance.promotionEvidence.seats.length, 4);
});
