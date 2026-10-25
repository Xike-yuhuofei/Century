/** 基线评测种子纪律（AI6 第一阶段任务 C：训练 / 调参 / 正式验证 / 基线评测严格隔离）。
 *
 * 种子来源：ai5/lib/seed_policy.mjs 的 AI6_BASELINE_BLOCK [1.1e9, 1.2e9)——
 * 与 AI4 进化区 [0,300M)、AI5 专用块 [300M,400M)、AI4 基准区 [400M,900M)、
 * 验证池 [900M,1.06e9) 物理不相交；本模块消费不得越界。
 *
 * 账本（training/baseline/seed-ledger.json，随仓库归档审计）：
 * - 每个评测配置（configKey）独占一个固定子块，消费只能从子块头部顺序推进；
 * - 顺序切片（sequentialSeeds）→ 天然唯一、可审计、确定性可复现；
 * - 记录唯一种子数（防"重复种子冒充独立样本"事故重演）；
 * - 拒绝回退：新请求的游标不得小于已消费游标（重跑旧区间 = 种子复用）。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI6_BASELINE_BLOCK, assertInBlock } from '../../ai5/lib/seed_policy.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { reserveConsumption } from '../lib/seed-governance.mjs';

export const BASELINE_LEDGER_PATH = resolve(REPO_ROOT, 'training/baseline/seed-ledger.json');

/** 每个配置的子块容量：10k 种子，单配置一次正式基准消耗 ≤ 数千，余量充足。 */
export const BASELINE_SUBBLOCK_CAPACITY = 10_000;

/** 配置 → 种子子块基址（互不重叠，全部落在 AI6_BASELINE_BLOCK 内）。
 * 布局：镜像基准 4 块（N=2..5）+ 对抗基准 4 块（N=2..5）+ 复现对照 1 块
 * + 性能基准 1 块（固定诊断种子，不参与账本消费与统计断言）。 */
export const BASELINE_SEED_LAYOUT = {
  'mirror-n2': 1_100_000_000,
  'mirror-n3': 1_101_000_000,
  'mirror-n4': 1_102_000_000,
  'mirror-n5': 1_103_000_000,
  'contest-n2': 1_104_000_000,
  'contest-n3': 1_105_000_000,
  'contest-n4': 1_106_000_000,
  'contest-n5': 1_107_000_000,
  'repro-n5': 1_108_000_000,
  'perf': 1_109_000_000,
};

/** 校验布局自身合法性：全部子块落在 AI6_BASELINE_BLOCK 内且互不重叠。 */
export function assertLayoutValid() {
  const entries = Object.entries(BASELINE_SEED_LAYOUT);
  for (const [key, base] of entries) {
    assertInBlock(base, AI6_BASELINE_BLOCK, `布局 ${key} 基址`);
    const end = base + BASELINE_SUBBLOCK_CAPACITY;
    assertInBlock(end - 1, AI6_BASELINE_BLOCK, `布局 ${key} 末种子`);
  }
  const sorted = entries.map(([, base]) => base).sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1] + BASELINE_SUBBLOCK_CAPACITY > sorted[i]) {
      throw new Error(`种子子块重叠：${sorted[i - 1]}..${sorted[i - 1] + BASELINE_SUBBLOCK_CAPACITY} 与 ${sorted[i]}`);
    }
  }
  return true;
}

export function loadLedger(ledgerPath = BASELINE_LEDGER_PATH) {
  assertLayoutValid();
  if (!existsSync(ledgerPath)) {
    // AI7-A1：正式账本缺失 fail-closed（不得按空账本从子块头部重新分配）；
    // 测试/隔离工作区显式注入临时路径时允许从空状态开始。
    if (ledgerPath === BASELINE_LEDGER_PATH) {
      throw new Error(`基线种子账本缺失（fail-closed）：${ledgerPath}——禁止按空账本重新分配已消费种子`);
    }
    return { schema: 'century-baseline-seed-ledger-v1', configs: {}, updatedAt: null };
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  if (ledger.schema !== 'century-baseline-seed-ledger-v1') {
    throw new Error(`基线种子账本 schema 不识别：${ledger.schema}`);
  }
  return ledger;
}

export function saveLedger(ledger, ledgerPath = BASELINE_LEDGER_PATH) {
  ledger.updatedAt = new Date().toISOString();
  // 写前备份：账本是审计凭据，覆盖前留一份上一版（保留最近一版即可）。
  if (existsSync(ledgerPath)) copyFileSync(ledgerPath, `${ledgerPath}.bak`);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  return ledgerPath;
}

/** 为配置分配 count 个唯一种子：子块头顺序消费，账本推进并落盘。
 * 重复调用（同配置追加）从上次消费末端继续，绝不回退、绝不复用。 */
export function allocateBaselineSeeds(configKey, count, { ledgerPath = BASELINE_LEDGER_PATH, persist = true } = {}) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`count 必须为正整数，实际：${count}`);
  const base = BASELINE_SEED_LAYOUT[configKey];
  if (base === undefined) {
    throw new Error(`未知基线配置：${configKey}（可用：${Object.keys(BASELINE_SEED_LAYOUT).join(', ')}）`);
  }
  const ledger = loadLedger(ledgerPath);
  const consumed = ledger.configs[configKey]?.consumed ?? 0;
  if (count > BASELINE_SUBBLOCK_CAPACITY - consumed) {
    throw new Error(
      `配置 ${configKey} 种子子块余量不足：已消费 ${consumed}/${BASELINE_SUBBLOCK_CAPACITY}，请求 ${count}。` +
      '子块耗尽必须换新块（防止复用已评测种子）。',
    );
  }
  const start = base + consumed;
  const seeds = Array.from({ length: count }, (_, i) => start + i);
  // 逐种子区间断言（含末端）——布局校验已保证整体落块，这里防未来布局被改坏。
  assertInBlock(seeds[seeds.length - 1], AI6_BASELINE_BLOCK, `配置 ${configKey} 末种子`);
  const uniqueCount = new Set(seeds).size;
  if (uniqueCount !== count) throw new Error(`基线种子分配出现重复（${count} 请求仅 ${uniqueCount} 唯一）——统计独立性违规`);
  if (persist) {
    // AI7-A1：新基线评测区间先经统一治理层登记（测试临时账本不写中央登记）。
    if (ledgerPath === BASELINE_LEDGER_PATH) {
      reserveConsumption({
        purposeClass: 'baseline',
        purpose: `baseline:${configKey}`,
        base: start,
        size: count,
        experimentId: `baseline-${configKey}-${start}`,
        evidencePath: ledgerPath,
      });
    }
    ledger.configs[configKey] = {
      blockBase: base,
      capacity: BASELINE_SUBBLOCK_CAPACITY,
      consumed: consumed + count,
      lastSeed: seeds[seeds.length - 1],
      uniqueSeedCount: (ledger.configs[configKey]?.uniqueSeedCount ?? 0) + uniqueCount,
      lastAllocatedAt: new Date().toISOString(),
      history: [
        ...(ledger.configs[configKey]?.history ?? []).slice(-49),
        { count, from: start, to: seeds[seeds.length - 1], at: new Date().toISOString() },
      ],
    };
    saveLedger(ledger, ledgerPath);
  }
  return { seeds, base: start, uniqueSeedCount: uniqueCount };
}
