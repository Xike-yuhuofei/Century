/** 训练系统测试：冠军晋级脚本（审计整改 P0：候选归档目录 + champion.json 同步；
 * P1 复审：晋级脚本必须独立核验配对证据，拒绝缺失/伪造/不一致的统计结论；
 * P0 可靠性整改：多重检验 challengeIndex 核验 + 引擎指纹核验 + 账本交叉核对）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedPromotionDecision, alphaSpendingThreshold, PROMOTION_ALPHA_BUDGET } from '../evaluator/stats.mjs';
import { VALIDATION_POOL_BASE, VALIDATION_POOL_MAX, consumeLedger } from '../lib/seeds.mjs';
import { engineBundleSha256 } from '../lib/paths.mjs';

const TRAINING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ENGINE_SHA = engineBundleSha256();

/** 构造一份真实可核验的配对证据：winRate 比例的种子分差 > 0，其余为负。 */
function makeSeedPairs(total, winRate) {
  const wins = Math.round(total * winRate);
  return Array.from({ length: total }, (_, i) => ({
    seed: VALIDATION_POOL_BASE + i,
    status: 'finished',
    diff: i < wins ? 2.5 : -1.5,
    anomalies: 0,
  }));
}

function makeCandidate(id, promote, overrides = {}) {
  const seedPairs = overrides.seedPairs ?? makeSeedPairs(60, 0.7);
  const challengeIndex = overrides.challengeIndex ?? 1;
  const threshold = alphaSpendingThreshold(challengeIndex);
  const recalculated = pairedPromotionDecision({ seedPairs, minSeeds: 60, z: threshold.z });
  const decision = overrides.decision ?? {
    ...recalculated,
    promote: promote ? true : false,
    verdict: promote ? 'promote' : 'inconclusive',
  };
  return {
    id,
    basedOn: 'v4.0-baseline',
    parameters: {
      id, engineWeight: 1.05, tempoWeight: 0.98, contestWeight: 1.1, synergyWeight: 1,
      goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
    },
    confirmation: {
      seeds: overrides.seeds ?? seedPairs.length,
      games: overrides.games ?? seedPairs.filter(p => p.status === 'finished').length * 2,
      seedBase: overrides.seedBase ?? VALIDATION_POOL_BASE + 1000,
      challengeIndex,
      alphaBudget: PROMOTION_ALPHA_BUDGET,
      engineBundleSha256: overrides.engineBundleSha256 ?? REAL_ENGINE_SHA,
      codeCommit: '0123456789abcdef0123456789abcdef01234567',
      winRate: 0.7,
      paired: { seeds: seedPairs.length, finished: seedPairs.length, won: 42, lost: 18, tied: 0 },
      seedPairs,
      decision,
      ...overrides.confirmationExtra,
    },
    generatedAt: new Date().toISOString(),
  };
}

function runPromote(sandbox, candidate) {
  const candidateFile = join(sandbox, 'candidate.json');
  writeFileSync(candidateFile, JSON.stringify(candidate, null, 2));
  return execFileSync(process.execPath, [
    join(TRAINING_ROOT, 'scripts', 'promote-champion.mjs'),
    '--candidate', candidateFile,
    '--champion', join(sandbox, 'champion.json'),
  ], { stdio: 'pipe' });
}

test('晋级脚本：归档候选（自动创建目录）并同步 champion.json', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-ok-'));
  runPromote(sandbox, makeCandidate('evo-g9-test', true));
  // 归档文件存在（目录此前不存在，脚本必须自建）。
  const archiveFile = join(sandbox, 'candidates', 'evo-g9-test.json');
  assert.ok(existsSync(archiveFile), '候选必须归档到 candidates/ 目录');
  // champion.json 已同步为候选参数。
  const champion = JSON.parse(readFileSync(join(sandbox, 'champion.json'), 'utf8'));
  assert.equal(champion.id, 'evo-g9-test');
  assert.equal(champion.parameters.engineWeight, 1.05);
  assert.equal(champion.provenance.basedOn, 'v4.0-baseline');
  assert.ok(champion.provenance.promotionEvidence?.decision?.promote === true, '晋级证据必须写入冠军记录');
  // P1 复审：独立重算结果必须随证据落盘，供后续审计。
  assert.ok(champion.provenance.promotionEvidence?.recalculated?.promote === true, '必须记录独立重算判定');
});

test('晋级脚本：无 promote 证据的候选必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-no-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-bad', false)),
    /promote/,
    '未通过确认挑战的候选不得晋级',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')), '拒绝时不得改写冠军记录');
});

test('晋级脚本：缺少逐种子配对证据必须被拒绝（无法独立核验）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-nopairs-'));
  const candidate = makeCandidate('evo-g9-nopairs', true);
  delete candidate.confirmation.seedPairs;
  assert.throws(
    () => runPromote(sandbox, candidate),
    /seedPairs/,
    '缺少配对证据时不得只信任自报 decision',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级脚本：伪造 promote 但证据不支持时必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-forge-'));
  // 证据实际是 70% 劣势，却自报 promote=true（伪造结论）。
  const candidate = makeCandidate('evo-g9-forge', true, {
    seedPairs: makeSeedPairs(60, 0.3),
  });
  assert.throws(
    () => runPromote(sandbox, candidate),
    /独立重算|重算/,
    '晋级脚本必须用配对证据重算判定，识破伪造结论',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级脚本：样本量与证据不一致（篡改）必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-tamper1-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-t1', true, { seeds: 300 })),
    /种子数/,
    '自报种子数必须与逐种子证据一致',
  );
  const sandbox2 = mkdtempSync(join(tmpdir(), 'promote-tamper2-'));
  assert.throws(
    () => runPromote(sandbox2, makeCandidate('evo-g9-t2', true, { games: 999 })),
    /局数/,
    '自报完成局数必须与逐种子证据一致',
  );
});

test('晋级脚本：训练种子上的证据无效（必须来自验证种子池）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-pool-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-train', true, { seedBase: 20261021 })),
    /验证种子池/,
    '训练种子的确认挑战不构成晋级证据',
  );
});

test('晋级脚本：决定性种子不足晋级门槛时必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-small-'));
  // 证据真实（全胜）但只有 30 个种子 < 默认门槛 60。
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-small', true, {
      seedPairs: makeSeedPairs(30, 1),
    })),
    /不足/,
    '小样本证据不得混过晋级门槛',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级脚本：参数越界的候选必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-bound-'));
  const candidate = makeCandidate('evo-g9-bound', true);
  candidate.parameters.engineWeight = 99; // 越出 PARAMETER_BOUNDS
  assert.throws(
    () => runPromote(sandbox, candidate),
    /参数|bounds|engineWeight/i,
    '非法参数不得晋级',
  );
});

// ---- P0 可靠性整改：多重检验核验 / 引擎指纹 / 账本交叉核对 ----

test('晋级脚本：缺少 challengeIndex（多重检验要素）必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-nochkidx-'));
  const candidate = makeCandidate('evo-g9-noidx', true);
  delete candidate.confirmation.challengeIndex;
  assert.throws(
    () => runPromote(sandbox, candidate),
    /challengeIndex/,
    '没有挑战序号就无法执行 alpha 消耗核验，禁止晋级',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级脚本：alphaBudget 与系统预算不一致必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-badalgo-'));
  const candidate = makeCandidate('evo-g9-badalgo', true, { confirmationExtra: { alphaBudget: 0.2 } });
  assert.throws(() => runPromote(sandbox, candidate), /alphaBudget/, '自报宽松预算不得混过核验');
});

test('晋级脚本：自报检验阈值与按挑战序号重算不一致必须被拒绝（伪造宽松 z）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-zforge-'));
  const candidate = makeCandidate('evo-g9-zforge', true);
  candidate.confirmation.decision.z = 1.0; // 伪造宽松阈值（真实 k=1 应为 ≈1.96）
  assert.throws(() => runPromote(sandbox, candidate), /检验阈值|z=/, '自报 z 必须与重算一致');
});

test('晋级脚本：challengeIndex 必须与随附验证账本的累计挑战次数一致（防伪造小序号）', () => {
  // 账本显示已挑战 2 次，候选却自报 challengeIndex=1（想拿最宽松阈值）→ 拒绝。
  const sandbox1 = mkdtempSync(join(tmpdir(), 'promote-ledger1-'));
  writeFileSync(join(sandbox1, 'validation-ledger.json'), JSON.stringify(
    consumeLedger(consumeLedger(null, VALIDATION_POOL_BASE, 80), VALIDATION_POOL_BASE + 2000, 80),
  ));
  assert.throws(
    () => runPromote(sandbox1, makeCandidate('evo-g9-led1', true, { challengeIndex: 1 })),
    /challengeIndex|账本/,
    '伪造挑战序号必须被随附账本识破',
  );
  // challengeIndex 与账本一致（=2）→ 正常晋级，且核验记录落盘。
  const sandbox2 = mkdtempSync(join(tmpdir(), 'promote-ledger2-'));
  writeFileSync(join(sandbox2, 'validation-ledger.json'), JSON.stringify(
    consumeLedger(consumeLedger(null, VALIDATION_POOL_BASE, 80), VALIDATION_POOL_BASE + 2000, 80),
  ));
  runPromote(sandbox2, makeCandidate('evo-g9-led2', true, { challengeIndex: 2 }));
  const champion = JSON.parse(readFileSync(join(sandbox2, 'champion.json'), 'utf8'));
  assert.equal(champion.provenance.promotionEvidence.verified.challengeIndex, 2);
  assert.equal(champion.provenance.promotionEvidence.verified.ledgerCrossChecked, true);
  assert.equal(champion.provenance.promotionEvidence.verified.z, alphaSpendingThreshold(2).z);
});

test('晋级脚本：确认挑战证据的引擎指纹与当前产物不一致必须被拒绝（证据失效）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-engsha-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-stale', true, { engineBundleSha256: 'deadbeef'.repeat(8) })),
    /运行时产物指纹|engine/,
    '引擎在证据生成后变更过，旧证据不得晋级',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级脚本：evolve-cli 顶层指纹布局的候选必须可正常晋级（回归：字段位置兼容）', () => {
  // evolve-cli（权威生产者）把 engineBundleSha256/codeCommit 写在 candidate.json
  // 顶层而非 confirmation 内；晋级脚本必须接受该布局，否则任何真实候选都会被
  // 指纹核验误拒（缺陷实证：AI5 readiness-efficiency 冲冠晋级被 "证据 缺失" 拒绝）。
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-topsha-'));
  const candidate = makeCandidate('evo-g9-topsha', true);
  candidate.engineBundleSha256 = candidate.confirmation.engineBundleSha256;
  candidate.codeCommit = candidate.confirmation.codeCommit;
  delete candidate.confirmation.engineBundleSha256;
  delete candidate.confirmation.codeCommit;
  runPromote(sandbox, candidate);
  const champion = JSON.parse(readFileSync(join(sandbox, 'champion.json'), 'utf8'));
  assert.equal(champion.provenance.engineBundleSha256, REAL_ENGINE_SHA, '顶层布局指纹必须通过核验并随冠军记录落盘');
  assert.equal(champion.provenance.codeCommit, candidate.codeCommit, '顶层布局 codeCommit 必须随冠军记录落盘');
});

test('晋级脚本：顶层布局指纹过期同样必须被拒绝（两处布局核验语义一致）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-topstale-'));
  const candidate = makeCandidate('evo-g9-topstale', true);
  candidate.engineBundleSha256 = 'deadbeef'.repeat(8);
  candidate.codeCommit = candidate.confirmation.codeCommit;
  delete candidate.confirmation.engineBundleSha256;
  assert.throws(
    () => runPromote(sandbox, candidate),
    /运行时产物指纹|engine/,
    '顶层布局的过期指纹不得绕过证据失效核验',
  );
  assert.ok(!existsSync(join(sandbox, 'champion.json')));
});

test('晋级脚本：验证种子基数越过验证池上限必须被拒绝', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-poolmax-'));
  assert.throws(
    () => runPromote(sandbox, makeCandidate('evo-g9-overpool', true, { seedBase: VALIDATION_POOL_MAX })),
    /验证种子池/,
    '验证池 [900M, 1.06e9) 之外的基数不是合法验证证据',
  );
});

test('晋级脚本：champion.json 必须携带引擎与代码版本溯源（P1 证据完整性）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-prov-'));
  runPromote(sandbox, makeCandidate('evo-g9-prov', true));
  const champion = JSON.parse(readFileSync(join(sandbox, 'champion.json'), 'utf8'));
  assert.equal(champion.provenance.engineBundleSha256, REAL_ENGINE_SHA, '引擎指纹必须随冠军记录落盘');
  assert.equal(champion.provenance.codeCommit, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(champion.provenance.promotionEvidence.verified.alpha, 0.025, 'k=1 的 alpha 与旧制一致');
});
