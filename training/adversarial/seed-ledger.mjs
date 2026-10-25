/** 对抗联赛·实验种子消费账本（AI6 合并后整改 P0-4）。
 *
 * 缺陷背景：run-league.mjs 每次以 block[0] 作为种子起点——预注册联赛已消费
 * prereg 块 [1403000000, 1403001620)；若再以默认起点执行 30-seed 方案，会
 * 无声重放同一段种子（统计独立性违规）。duel/挑战等其它管线各有账本
 * （training/baseline/seed-ledger.mjs、training/lib/seeds.mjs），联赛此前没有。
 *
 * 账本语义（fail-closed）：
 * - 每条记录 = 一次种子区间消费：experimentId（全局唯一）、block（seed_policy
 *   子块）、[seedStart, seedEnd)、seeds、runId、codeCommit（进程启动时捕获）、
 *   algorithmFingerprints、purpose、crnGroup（有意配对复用标识）、status。
 * - 有意 CRN 配对复用必须显式声明 crnGroup：仅当新请求与既有记录 crnGroup
 *   相同（且双方均非 null）时允许区间重叠，其余任何重叠一律抛错——
 *   改名 experimentId / 换输出目录不能规避（防重键 = 区间本身）。
 * - 缺失账本 → 分配/校验直接抛错（绝不静默新建后当作空白区）。
 * - 作废（voided）实验保留区间占用（保守：防"作废即复用"引入相关样本），
 *   必须留痕 reason。
 * - 断点续跑：resumeExperiment 返回该实验已注册区间的末端游标，续跑在其
 *   自己的 [seedStart, seedEnd) 内推进，不新增区间、不重复记账。
 * - 并发安全：多进程分配经文件锁（O_EXCL 原子创建 + 陈旧锁接管）串行化；
 *   校验+写入在临界区内一次完成。
 *
 * 历史只读事实（2026-10-25 导入，来源于已归档实验报告，不重写原始数据）：
 * - evaluate-smoke（dev 块）：3 候选共享 [1400000000,1400000020)（有意 CRN 配对）；
 * - smoke-2-5-4s（smoke 块）：[1401000000,1401000120) 框架冒烟；
 * - prereg-15s-official（prereg 块）：[1403000000,1403001620) 1620 局正式联赛
 *   （PR #40，用户批准执行）。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AI6_LEAGUE_DEV_SUBBLOCK, AI6_LEAGUE_SMOKE_SUBBLOCK,
  AI6_LEAGUE_MATRIX_DEV_SUBBLOCK, AI6_LEAGUE_PREREG_SUBBLOCK,
} from '../../ai5/lib/seed_policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const LEAGUE_LEDGER_PATH = resolve(here, 'seed-ledger.json');
export const LEAGUE_LEDGER_SCHEMA = 'century-adversarial-seed-ledger-v1';

/** 联赛种子块注册表（与 ai5/lib/seed_policy.mjs 一致；新增块必须先登记那里）。 */
export const LEAGUE_SEED_BLOCKS = Object.freeze({
  dev: AI6_LEAGUE_DEV_SUBBLOCK,
  smoke: AI6_LEAGUE_SMOKE_SUBBLOCK,
  'matrix-dev': AI6_LEAGUE_MATRIX_DEV_SUBBLOCK,
  prereg: AI6_LEAGUE_PREREG_SUBBLOCK,
});

const LOCK_PATH = `${LEAGUE_LEDGER_PATH}.lock`;
const LOCK_STALE_MS = 60_000;

function captureCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null; // 非仓库环境（测试）：commit 不可用不阻断，但记录 null
  }
}

/** 读取账本；缺失/坏 schema 一律抛错（fail-closed——绝不静默按空账本处理）。 */
export function loadLedger(ledgerPath = LEAGUE_LEDGER_PATH) {
  if (!existsSync(ledgerPath)) {
    throw new Error(
      `联赛种子账本不存在：${ledgerPath}——fail-closed（P0-4）。` +
      '禁止在无账本状态分配种子；从仓库恢复 seed-ledger.json 或显式初始化（仅限全新部署）。',
    );
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  if (ledger.schema !== LEAGUE_LEDGER_SCHEMA) {
    throw new Error(`联赛种子账本 schema 不识别：${ledger.schema}（期望 ${LEAGUE_LEDGER_SCHEMA}）`);
  }
  return ledger;
}

/** 账本结构校验：区间落块、非 CRN 重叠、作废留痕。返回缺陷列表（空=健康）。 */
export function verifyLedger(ledger) {
  const defects = [];
  const entries = ledger.experiments ?? [];
  for (const e of entries) {
    const block = LEAGUE_SEED_BLOCKS[e.blockName];
    if (!block) { defects.push(`experiment ${e.experimentId}: 未知块 ${e.blockName}`); continue; }
    if (!(e.seedStart >= block[0] && e.seedEnd <= block[1] && e.seedEnd > e.seedStart)) {
      defects.push(`experiment ${e.experimentId}: 区间 [${e.seedStart},${e.seedEnd}) 越出块 ${JSON.stringify(block)}`);
    }
    if (e.status === 'voided' && !e.voidReason) {
      defects.push(`experiment ${e.experimentId}: 作废实验缺少 voidReason`);
    }
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]; const b = entries[j];
      const overlaps = a.seedStart < b.seedEnd && b.seedStart < a.seedEnd;
      if (!overlaps) continue;
      const crnPair = a.crnGroup !== null && a.crnGroup !== undefined
        && a.crnGroup === b.crnGroup;
      if (!crnPair) defects.push(`experiment ${a.experimentId} 与 ${b.experimentId}: 区间重叠且未声明 CRN 配对`);
    }
  }
  return defects;
}

/** 文件锁（多进程并发分配安全）：O_EXCL 原子创建；陈旧锁（>60s）接管。 */
function withLock(fn, ledgerPath = LEAGUE_LEDGER_PATH) {
  const lockPath = `${ledgerPath}.lock`;
  const start = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath); // 陈旧锁接管（持有者崩溃）
          continue;
        }
      } catch { /* 锁恰好被释放，重试 */ }
      if (Date.now() - start > 30_000) throw new Error(`联赛种子账本锁获取超时：${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* 已关闭 */ }
    try { unlinkSync(lockPath); } catch { /* 已被接管者删除 */ }
  }
}

function saveLedger(ledger, ledgerPath = LEAGUE_LEDGER_PATH) {
  ledger.updatedAt = new Date().toISOString();
  if (existsSync(ledgerPath)) copyFileSync(ledgerPath, `${ledgerPath}.bak`);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
}

/** 区间重叠检查（核心防重键 = 区间本身，与 experimentId/输出目录无关）。 */
function assertIntervalFree(ledger, { blockName, seedStart, seedEnd, crnGroup, experimentId }) {
  for (const e of ledger.experiments ?? []) {
    if (e.experimentId === experimentId) continue; // 自身续跑由 resume 语义处理
    const overlaps = seedStart < e.seedEnd && e.seedStart < seedEnd;
    if (!overlaps) continue;
    const crnPair = crnGroup !== null && crnGroup !== undefined && crnGroup === e.crnGroup;
    if (crnPair) continue; // 有意 CRN 配对复用（双方显式声明同组）
    throw new Error(
      `种子区间重叠：[${seedStart}, ${seedEnd}) 与已记账实验 ${e.experimentId}` +
      `（${e.blockName} 块 [${e.seedStart}, ${e.seedEnd})，status=${e.status}）重叠。` +
      '统计独立性违规——新实验必须从未消费区间分配；有意 CRN 配对必须显式声明相同 crnGroup。',
    );
  }
}

/**
 * 注册并校验一次实验种子消费（校验 + 写入在文件锁临界区内一次完成）。
 *
 * @param {object} options
 * @param {string} options.experimentId 全局唯一实验 ID（重复 ID 抛错）
 * @param {string} options.blockName LEAGUE_SEED_BLOCKS 键
 * @param {number} options.seedBase 起始种子（必须落在块内且不与已消费区间重叠）
 * @param {number} options.seedCount 消费种子数
 * @param {string} options.purpose 用途（结论性/开发/冒烟……进入审计披露）
 * @param {string|null} [options.crnGroup] 有意 CRN 配对组（null=独立实验）
 * @param {string} [options.runId] 运行标识（缺省 = experimentId@时间戳）
 * @param {string[]} [options.algorithmFingerprints] 参与版本的决策身份指纹
 * @param {string} [options.ledgerPath] 账本路径（测试可注入临时目录）
 * @param {boolean} [options.persist] false 时不落盘（干跑校验）
 * @returns {{seeds: number[], seedStart: number, seedEnd: number, entry: object}}
 */
export function registerExperiment({
  experimentId, blockName, seedBase, seedCount, purpose,
  crnGroup = null, runId = null, algorithmFingerprints = [],
  ledgerPath = LEAGUE_LEDGER_PATH, persist = true,
}) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(experimentId)) {
    throw new Error(`experimentId 非法：${experimentId}`);
  }
  const block = LEAGUE_SEED_BLOCKS[blockName];
  if (!block) throw new Error(`未知联赛种子块：${blockName}（可用：${Object.keys(LEAGUE_SEED_BLOCKS).join(', ')}）`);
  if (!Number.isSafeInteger(seedCount) || seedCount <= 0) throw new Error(`seedCount 必须为正整数，实际：${seedCount}`);
  if (!Number.isSafeInteger(seedBase) || seedBase < block[0] || seedBase + seedCount > block[1]) {
    throw new Error(`种子区间 [${seedBase}, ${seedBase + seedCount}) 越出 ${blockName} 块 ${JSON.stringify(block)}`);
  }
  const apply = (ledger) => {
    if ((ledger.experiments ?? []).some(e => e.experimentId === experimentId)) {
      throw new Error(`experimentId 已存在：${experimentId}（续跑请用 resumeExperiment，不得重复注册）`);
    }
    assertIntervalFree(ledger, { blockName, seedStart: seedBase, seedEnd: seedBase + seedCount, crnGroup, experimentId });
    const entry = {
      experimentId,
      blockName,
      seedStart: seedBase,
      seedEnd: seedBase + seedCount,
      seeds: seedCount,
      runId: runId ?? `${experimentId}@${new Date().toISOString()}`,
      codeCommit: captureCommit(),
      algorithmFingerprints,
      purpose: String(purpose ?? ''),
      crnGroup,
      status: 'registered',
      registeredAt: new Date().toISOString(),
      voidReason: null,
    };
    ledger.experiments = [...(ledger.experiments ?? []), entry].sort((a, b) => a.seedStart - b.seedStart);
    if (persist) saveLedger(ledger, ledgerPath);
    const seeds = Array.from({ length: seedCount }, (_, i) => seedBase + i);
    if (new Set(seeds).size !== seedCount) throw new Error('种子分配出现重复（内部不变量违规）');
    return { seeds, seedStart: seedBase, seedEnd: seedBase + seedCount, entry };
  };
  if (!persist) return apply(loadLedger(ledgerPath));
  return withLock(() => apply(loadLedger(ledgerPath)), ledgerPath);
}

/** 断点续跑游标：实验已注册区间的末端（续跑推进不得新增区间）。 */
export function resumeExperiment(experimentId, { ledgerPath = LEAGUE_LEDGER_PATH } = {}) {
  const ledger = loadLedger(ledgerPath);
  const entry = (ledger.experiments ?? []).find(e => e.experimentId === experimentId);
  if (!entry) throw new Error(`实验未注册，无法续跑：${experimentId}`);
  if (entry.status === 'voided') throw new Error(`实验已作废，禁止续跑：${experimentId}（${entry.voidReason}）`);
  return { seedStart: entry.seedStart, seedEnd: entry.seedEnd, seeds: entry.seeds, entry };
}

/** 实验收尾状态机：completed / voided（作废必须留痕 reason）。 */
export function setExperimentStatus(experimentId, status, { reason = null, ledgerPath = LEAGUE_LEDGER_PATH } = {}) {
  if (!['completed', 'voided', 'registered', 'in-progress'].includes(status)) {
    throw new Error(`非法实验状态：${status}`);
  }
  return withLock(() => {
    const ledger = loadLedger(ledgerPath);
    const entry = (ledger.experiments ?? []).find(e => e.experimentId === experimentId);
    if (!entry) throw new Error(`实验未注册：${experimentId}`);
    entry.status = status;
    entry.voidReason = status === 'voided' ? String(reason ?? 'unspecified') : null;
    entry.updatedAt = new Date().toISOString();
    saveLedger(ledger, ledgerPath);
    return entry;
  }, ledgerPath);
}

/** 块内下一个未消费起点（从未消费区间的最高末端继续；块全新则 = block[0]）。 */
export function nextSeedBase(blockName, { ledgerPath = LEAGUE_LEDGER_PATH } = {}) {
  const block = LEAGUE_SEED_BLOCKS[blockName];
  if (!block) throw new Error(`未知联赛种子块：${blockName}`);
  const ledger = loadLedger(ledgerPath);
  const inBlock = (ledger.experiments ?? []).filter(e => e.blockName === blockName);
  if (!inBlock.length) return block[0];
  return Math.max(...inBlock.map(e => e.seedEnd));
}

/** 初始化全新账本（仅限显式调用：全新部署或测试夹具；已存在则拒绝）。 */
export function initializeLedger({ ledgerPath = LEAGUE_LEDGER_PATH, historical = [] } = {}) {
  if (existsSync(ledgerPath)) throw new Error(`账本已存在，拒绝初始化覆盖：${ledgerPath}`);
  const ledger = { schema: LEAGUE_LEDGER_SCHEMA, createdAt: new Date().toISOString(), updatedAt: null, experiments: historical };
  saveLedger(ledger, ledgerPath);
  return ledger;
}

/** 仓库随附账本（历史只读事实导入）。缺失时允许测试显式初始化。 */
export function loadOrCreateWithHistory({ ledgerPath = LEAGUE_LEDGER_PATH } = {}) {
  if (existsSync(ledgerPath)) return loadLedger(ledgerPath);
  throw new Error(`联赛种子账本缺失：${ledgerPath}（fail-closed；从仓库恢复或经 initializeLedger 初始化）`);
}
