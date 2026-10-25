/** 跨系统种子治理层（AI7 任务 A1：统一登记、冲突查询与 fail-closed 校验）。
 *
 * 背景（03 审计 P0-1）：
 * - AI4 evolve、OpenEvolve 正式挑战、OpenEvolve 深度验证、PPO arena、AI6 联赛 /
 *   基线各自维护不同格式的账本；正式挑战只合并部分 validation-ledger；
 * - PPO arena 消费的验证池 [900000000, 900000040) 不在正式挑战账本；
 * - long20 深验使用 [300001200, 300001300) 但未写入 deep-validation-ledger；
 * - 缺失账本时旧 helper（nextValidationBase(null)）会按运行身份/小时派生起点，
 *   fail-open 地复用验证种子。
 *
 * 本模块不是"又一本账"，而是治理层：
 * 1. 各系统保留自己的账本格式；本层通过显式 adapter 只读归一化；
 * 2. 统一按区间（不是 experimentId/目录名）做跨系统防重；
 * 3. 用途分类：training / screening / deep-validation / formal-challenge /
 *    arena / baseline / league / audit——重叠一律冲突，只有联赛显式同 crnGroup
 *    的有意 CRN 配对例外；
 * 4. 历史只读声明（training/governance/historical-seed-claims.json）保留原始
 *    证据与不确定状态，绝不伪造历史账本条目；
 * 5. 新消费经 training/governance/seed-consumption-registry.json 原子登记
 *    （O_EXCL 文件锁），变动种子前先登记；
 * 6. 任何缺失/冲突/未登记证据一律 fail-closed。
 */

import {
  existsSync, readFileSync, writeFileSync, copyFileSync,
  openSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import {
  VALIDATION_POOL_BASE, VALIDATION_STRIDE, VALIDATION_POOL_MAX, ENGINE_SEED_MAX,
} from './seeds.mjs';
import {
  OPENEVOLVE_DEEP_VALIDATION_BLOCK, AI6_BASELINE_BLOCK,
  AI6_ADVERSARIAL_LEAGUE_BLOCK, PPO_TRAINING_BLOCK,
  AI5_EVAL_TRAINING_BLOCK, AI4_EVO_BLOCK,
} from '../../ai5/lib/seed_policy.mjs';

export const SEED_GOVERNANCE_SCHEMA = 'century-seed-governance-v1';
export const CENTRAL_REGISTRY_SCHEMA = 'century-seed-consumption-registry-v1';
export const HISTORICAL_CLAIMS_SCHEMA = 'century-seed-historical-claims-v1';
export const GOVERNANCE_DIR = resolve(REPO_ROOT, 'training/governance');
export const CENTRAL_REGISTRY_PATH = resolve(GOVERNANCE_DIR, 'seed-consumption-registry.json');
export const HISTORICAL_CLAIMS_PATH = resolve(GOVERNANCE_DIR, 'historical-seed-claims.json');

/** 用途分类（训练/快筛/深验/正式挑战严格区分）。 */
export const SEED_PURPOSES = Object.freeze([
  'training', 'screening', 'deep-validation', 'formal-challenge',
  'arena', 'baseline', 'league', 'audit',
]);

/** 账本来源注册表（新增来源必须先在此登记；路径相对 repo root）。 */
export const LEDGER_SOURCES = Object.freeze([
  source('structure-challenge-rollout-confirm', 'training/reports/structure-challenge-rollout-confirm/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('openevolve-goal-remaining-60', 'ai5/openevolve/experiments/reports/challenge-ai5-goal-remaining/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('openevolve-goal-remaining-500', 'ai5/openevolve/experiments/reports/challenge-ai5-goal-remaining-500/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('openevolve-readiness-500', 'ai5/openevolve/experiments/reports/challenge-readiness-efficiency-500/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('openevolve-readiness-1000', 'ai5/openevolve/experiments/reports/challenge-readiness-efficiency-1000/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('js5-formal-challenge', 'training/reports/js5-formal-challenge/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('js5-promotion-challenge', 'training/reports/js5-promotion-challenge/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('js5-promotion-invalid-seedreuse', 'training/reports/js5-promotion-challenge-invalid-seedreuse/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: false, status: 'invalid-evidence' }),
  source('ai4-evolve-latest', 'training/reports/evolve-latest/validation-ledger.json', 'validation-ledger', 'formal-challenge', { countsTowardChallengeIndex: true }),
  source('openevolve-deep-validation', 'ai5/openevolve/results/deep-validation-ledger.json', 'validation-ledger', 'deep-validation', { countsTowardChallengeIndex: false }),
  source('ppo-ledger', 'ai5/ppo/reports/seed-ledger.json', 'ppo-ledger', null, { countsTowardChallengeIndex: false }),
  source('ai6-league', 'training/adversarial/seed-ledger.json', 'league-ledger', 'league', { countsTowardChallengeIndex: false }),
  source('ai6-baseline', 'training/baseline/seed-ledger.json', 'baseline-ledger', 'baseline', { countsTowardChallengeIndex: false }),
]);

function source(id, path, format, forcePurposeClass, extra = {}) {
  return Object.freeze({ id, path, format, forcePurposeClass, ...extra });
}

/** 仓库内建的正式挑战账本来历（历史只读导入）。
 * 只有这些来源的条目可以证明「AI7 之前的正式挑战」；新证据必须能在
 * 中央登记中找到已完成的正式挑战记录（防账本重建/改名绕过中央登记）。 */
const BUILTIN_FORMAL_SOURCE_IDS = Object.freeze(new Set(
  LEDGER_SOURCES.filter(item => item.format === 'validation-ledger').map(item => item.id),
));

/** AI7 基准时的历史正式挑战次数（challengeIndex=11 为最后一个已归档挑战）。
 * 这是治理常量，不从可修改的账本动态重算：
 * - 若内建账本少于该值 → 历史基线被删除/截断，晋级 fail-closed；
 * - 若内建账本被人为追加 → 只会让中央登记要求更严，不会放宽；
 * - 更新该常量必须经 PR 审核（等同于承认新的历史基线）。 */
export const HISTORICAL_FORMAL_CHALLENGE_COUNT = 11;

/** AI7 基准时验证池的高水位（challenge-11 之后的下一个合法正式挑战起点）。
 * 若账本被截断/重建导致 nextFormalValidationBase 回退到更低的块，说明
 * 已消费区间从治理视图中消失，可能静默复用历史验证种子——必须拒绝。
 * 新增正式挑战只会抬高该值；更新常量必须经 PR 审核。 */
export const HISTORICAL_NEXT_FORMAL_BASE = 941_514_652;

const LOCK_STALE_MS = 60_000;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isInt(value) {
  return Number.isSafeInteger(value);
}

function intervalOf(entry) {
  return [entry.base, entry.base + entry.size];
}

function overlaps(a, b) {
  return a.base < b.base + b.size && b.base < a.base + a.size;
}

/** 用途分类：先按来源强制类，其次按种子所在区块与 purpose 文本。 */
function classifyPurpose({ sourceId, forcePurposeClass, base, purposeText, format }) {
  if (forcePurposeClass) return forcePurposeClass;
  if (format === 'baseline-ledger') return 'baseline';
  if (format === 'league-ledger') return 'league';
  if (format === 'ppo-ledger') {
    if (base >= VALIDATION_POOL_BASE && base < VALIDATION_POOL_MAX) return 'arena';
    if (base >= PPO_TRAINING_BLOCK[0] && base < PPO_TRAINING_BLOCK[1]) return 'training';
    if (base >= AI5_EVAL_TRAINING_BLOCK[0] && base < AI5_EVAL_TRAINING_BLOCK[1]) return 'training';
    if (base >= AI4_EVO_BLOCK[0] && base < AI4_EVO_BLOCK[1]) return 'training';
    return 'training';
  }
  if (base >= OPENEVOLVE_DEEP_VALIDATION_BLOCK[0] && base < OPENEVOLVE_DEEP_VALIDATION_BLOCK[1]) return 'deep-validation';
  const text = String(purposeText ?? '').toLowerCase();
  if (text.includes('deep-validation')) return 'deep-validation';
  if (text.includes('arena')) return 'arena';
  if (text.startsWith('training:') || text.includes('training')) return 'training';
  if (text.includes('screen') || text.includes('smoke')) return 'screening';
  return 'formal-challenge';
}

function validateInterval(base, size) {
  if (!isInt(base) || !isInt(size) || base < 0 || size <= 0) {
    throw new Error(`非法种子区间：base=${base}, size=${size}`);
  }
  if (base > ENGINE_SEED_MAX || base + size - 1 > ENGINE_SEED_MAX) {
    throw new Error(`种子区间 [${base}, ${base + size}) 越过引擎安全上限 ${ENGINE_SEED_MAX}`);
  }
}

function normalizeValidationLedger({ sourceId, path, forcePurposeClass, countsTowardChallengeIndex, status, defaultSize = VALIDATION_STRIDE }, ledger) {
  const entries = [];
  const uncertainties = [];
  const history = Array.isArray(ledger.history) ? ledger.history : [];
  for (const raw of history) {
    const base = Number(raw?.base);
    const rawSize = Number(raw?.size);
    const size = isInt(rawSize) && rawSize > 0 ? rawSize : defaultSize;
    if (!isInt(base)) {
      uncertainties.push(`账本 ${sourceId} 存在非整数 base 条目（已忽略）：${JSON.stringify(raw)?.slice(0, 100)}`);
      continue;
    }
    if (!isInt(rawSize) || rawSize <= 0) {
      uncertainties.push(`账本 ${sourceId} base=${base} 缺少 size，按保守步长 ${size} 占用区间（历史不确定状态）`);
    }
    validateInterval(base, size);
    entries.push({
      sourceId,
      ledgerPath: path,
      base,
      size,
      purpose: String(raw?.purpose ?? ''),
      purposeClass: classifyPurpose({ sourceId, forcePurposeClass, base, purposeText: raw?.purpose, format: 'validation-ledger' }),
      status: status ?? 'consumed',
      countsTowardChallengeIndex: Boolean(countsTowardChallengeIndex),
      uncertain: !isInt(rawSize) || rawSize <= 0,
      rawAt: raw?.at ?? null,
      note: raw?.note ?? null,
      challengeIndex: isInt(raw?.challengeIndex) ? raw.challengeIndex : null,
    });
  }
  if (entries.length === 0 && isInt(Number(ledger.lastBase))) {
    const base = Number(ledger.lastBase);
    if (base >= VALIDATION_POOL_BASE) {
      const size = defaultSize;
      entries.push({
        sourceId, ledgerPath: path, base, size,
        purpose: 'lastBase-fallback',
        purposeClass: forcePurposeClass ?? 'formal-challenge',
        status: status ?? 'consumed',
        countsTowardChallengeIndex: Boolean(countsTowardChallengeIndex),
        uncertain: true,
        note: '旧账本只有 lastBase，无 history；按保守步长占用',
      });
      uncertainties.push(`账本 ${sourceId} 无 history，仅 lastBase=${base}，按步长 ${size} 保守占用`);
    }
  }
  return {
    source: {
      id: sourceId, path, format: 'validation-ledger', present: true,
      challengeCount: isInt(ledger.challengeCount) ? ledger.challengeCount : null,
      rawSha256: null,
    },
    entries,
    uncertainties,
  };
}

function normalizeLeagueLedger({ sourceId, path }, ledger) {
  if (ledger.schema !== 'century-adversarial-seed-ledger-v1') {
    throw new Error(`联赛账本 schema 不识别：${ledger.schema}（${path}）`);
  }
  const entries = [];
  const uncertainties = [];
  for (const raw of ledger.experiments ?? []) {
    const base = Number(raw?.seedStart);
    const end = Number(raw?.seedEnd);
    const size = end - base;
    validateInterval(base, size);
    entries.push({
      sourceId, ledgerPath: path, base, size,
      experimentId: raw?.experimentId ?? null,
      purpose: String(raw?.purpose ?? ''),
      purposeClass: 'league',
      status: raw?.status ?? 'registered',
      crnGroup: raw?.crnGroup ?? null,
      countsTowardChallengeIndex: false,
      uncertain: false,
      codeCommit: raw?.codeCommit ?? null,
    });
  }
  return { source: { id: sourceId, path, format: 'league-ledger', present: true, rawSha256: null }, entries, uncertainties };
}

function normalizePpoLedger({ sourceId, path }, ledger) {
  const entries = [];
  for (const raw of ledger.history ?? []) {
    const base = Number(raw?.base);
    const rawSize = Number(raw?.size);
    const size = isInt(rawSize) && rawSize > 0 ? rawSize : VALIDATION_STRIDE;
    validateInterval(base, size);
    const purpose = String(raw?.purpose ?? '');
    entries.push({
      sourceId, ledgerPath: path, base, size,
      purpose,
      purposeClass: classifyPurpose({ sourceId, base, purposeText: purpose, format: 'ppo-ledger' }),
      status: 'consumed',
      countsTowardChallengeIndex: false,
      uncertain: raw?.note ? true : false,
      note: raw?.note ?? null,
    });
  }
  return {
    source: {
      id: sourceId, path, format: 'ppo-ledger', present: true,
      challengeCount: isInt(ledger.challengeCount) ? ledger.challengeCount : null,
      challengeCountConsistent: false,
      rawSha256: null,
    },
    entries,
    uncertainties: [
      `PPO 账本 challengeCount=${ledger.challengeCount ?? '缺失'} 与验证池条目数不一致（历史账本自身缺陷）；统一治理层不据此推导正式 challengeIndex`,
    ],
  };
}

function normalizeBaselineLedger({ sourceId, path }, ledger) {
  if (ledger.schema !== 'century-baseline-seed-ledger-v1') {
    throw new Error(`基线账本 schema 不识别：${ledger.schema}（${path}）`);
  }
  const entries = [];
  for (const [configKey, config] of Object.entries(ledger.configs ?? {})) {
    for (const raw of config?.history ?? []) {
      const base = Number(raw?.from);
      const size = Number(raw?.count ?? (Number(raw?.to) - base + 1));
      validateInterval(base, size);
      entries.push({
        sourceId, ledgerPath: path, base, size,
        experimentId: `baseline:${configKey}`,
        purpose: `baseline:${configKey}`,
        purposeClass: 'baseline',
        status: 'consumed',
        countsTowardChallengeIndex: false,
        uncertain: false,
      });
    }
  }
  return { source: { id: sourceId, path, format: 'baseline-ledger', present: true, rawSha256: null }, entries, uncertainties: [] };
}

function normalizeCentralRegistry(path, ledger) {
  const entries = [];
  for (const raw of ledger.entries ?? []) {
    const base = Number(raw?.base);
    const size = Number(raw?.size);
    validateInterval(base, size);
    entries.push({
      sourceId: 'governance-central',
      ledgerPath: path,
      base,
      size,
      experimentId: raw?.experimentId ?? null,
      purpose: String(raw?.purpose ?? ''),
      purposeClass: raw?.purposeClass ?? 'formal-challenge',
      status: raw?.status ?? 'reserved',
      countsTowardChallengeIndex: raw?.countsTowardChallengeIndex === true,
      // challengeIndex 是中央登记的身份字段：晋级证据必须能在此匹配到
      // 「第 k 次挑战」的已完成记录（缺失/伪造一律拒绝）。
      challengeIndex: isInt(raw?.challengeIndex) ? raw.challengeIndex : null,
      uncertain: false,
      codeCommit: raw?.codeCommit ?? null,
      evidencePath: raw?.evidencePath ?? null,
      crnGroup: raw?.crnGroup ?? null,
    });
  }
  return { source: { id: 'governance-central', path, format: 'central-registry', present: true, rawSha256: null }, entries, uncertainties: [] };
}

/** 读取并归一化全部来源；strict=true 时缺失任一来源直接抛错（fail-closed）。 */
export function loadSeedGovernance({
  root = REPO_ROOT,
  strict = true,
  extraLedgers = [],
  includeCentral = true,
  includeHistorical = true,
  centralRegistryPath = null,
} = {}) {
  const centralPath = centralRegistryPath ?? resolve(root, 'training/governance/seed-consumption-registry.json');
  const sources = [];
  const entries = [];
  const uncertainties = [];
  const missing = [];

  const loadOne = (definition) => {
    const absolute = resolve(root, definition.path);
    if (!existsSync(absolute)) {
      missing.push(definition.id);
      sources.push({ ...definition, present: false, rawSha256: null });
      return;
    }
    const text = readFileSync(absolute, 'utf8');
    const ledger = JSON.parse(text);
    let normalized;
    const sourceDefinition = { ...definition, sourceId: definition.id };
    if (definition.format === 'validation-ledger') normalized = normalizeValidationLedger(sourceDefinition, ledger);
    else if (definition.format === 'league-ledger') normalized = normalizeLeagueLedger(sourceDefinition, ledger);
    else if (definition.format === 'ppo-ledger') normalized = normalizePpoLedger(sourceDefinition, ledger);
    else if (definition.format === 'baseline-ledger') normalized = normalizeBaselineLedger(sourceDefinition, ledger);
    else throw new Error(`未知账本格式：${definition.format}`);
    normalized.source.rawSha256 = sha256(text);
    sources.push(normalized.source);
    entries.push(...normalized.entries);
    uncertainties.push(...normalized.uncertainties);
  };

  for (const definition of LEDGER_SOURCES) loadOne(definition);

  if (includeCentral) {
    const absolute = resolve(centralPath);
    if (!existsSync(absolute)) {
      missing.push('governance-central');
    } else {
      const text = readFileSync(absolute, 'utf8');
      const ledger = JSON.parse(text);
      if (ledger.schema !== CENTRAL_REGISTRY_SCHEMA) {
        throw new Error(`统一种子登记 schema 不识别：${ledger.schema}`);
      }
      const normalized = normalizeCentralRegistry(absolute, ledger);
      normalized.source.rawSha256 = sha256(text);
      sources.push(normalized.source);
      entries.push(...normalized.entries);
    }
  }

  for (const extra of extraLedgers) {
    const absolute = resolve(root, extra.path);
    if (!existsSync(absolute)) {
      if (extra.required !== false) missing.push(extra.id ?? extra.path);
      continue;
    }
    const text = readFileSync(absolute, 'utf8');
    const definition = {
      id: extra.id ?? 'extra-ledger',
      sourceId: extra.id ?? 'extra-ledger',
      path: extra.path,
      format: extra.format ?? 'validation-ledger',
      forcePurposeClass: extra.purposeClass ?? 'formal-challenge',
      countsTowardChallengeIndex: extra.countsTowardChallengeIndex ?? true,
      status: extra.status,
    };
    const normalized = normalizeValidationLedger(definition, JSON.parse(text));
    normalized.source.rawSha256 = sha256(text);
    sources.push(normalized.source);
    entries.push(...normalized.entries);
    uncertainties.push(...normalized.uncertainties);
  }

  if (includeHistorical) {
    const absolute = resolve(root, 'training/governance/historical-seed-claims.json');
    if (!existsSync(absolute)) {
      missing.push('historical-claims');
    } else {
      const text = readFileSync(absolute, 'utf8');
      const doc = JSON.parse(text);
      if (doc.schema !== HISTORICAL_CLAIMS_SCHEMA) throw new Error(`历史种子声明 schema 不识别：${doc.schema}`);
      for (const claim of doc.claims ?? []) {
        if (claim.occupiesRange === false) continue;
        validateInterval(Number(claim.base), Number(claim.size));
        entries.push({
          sourceId: 'historical-claims',
          ledgerPath: 'training/governance/historical-seed-claims.json',
          base: Number(claim.base),
          size: Number(claim.size),
          experimentId: claim.claimId,
          purpose: String(claim.purpose ?? ''),
          purposeClass: claim.purposeClass ?? 'deep-validation',
          status: claim.status ?? 'historical-unverified',
          countsTowardChallengeIndex: claim.countsTowardChallengeIndex === true,
          uncertain: true,
          note: claim.uncertainty ?? null,
          rawAt: null,
        });
      }
      sources.push({ id: 'historical-claims', path: 'training/governance/historical-seed-claims.json', format: 'historical-claims', present: true, rawSha256: sha256(text) });
    }
  }

  if (strict && missing.length) {
    throw new Error(
      `种子账本缺失（fail-closed）：${missing.join(', ')}。` +
      '缺失任一来历会使 challengeIndex 低估或种子块重复消费；禁止跳过或按空账本处理。',
    );
  }

  const registry = {
    schema: SEED_GOVERNANCE_SCHEMA,
    root,
    scannedAt: new Date().toISOString(),
    complete: missing.length === 0,
    missingSources: [...new Set(missing)].sort(),
    sources,
    entries: dedupeEntries(entries),
    uncertainties: [...new Set(uncertainties)],
  };
  const conflicts = detectConflicts(registry);
  registry.conflicts = conflicts;
  registry.summary = summarize(registry);
  return registry;
}

/** 同一区间在多份累计账本中重复出现 → 合并；同 base 不同 size 保留并成为缺陷。 */
function dedupeEntries(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.base}:${entry.size}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...entry, seenIn: [entry.sourceId] });
      continue;
    }
    if (!existing.seenIn.includes(entry.sourceId)) existing.seenIn.push(entry.sourceId);
    existing.countsTowardChallengeIndex = existing.countsTowardChallengeIndex || entry.countsTowardChallengeIndex;
    existing.uncertain = existing.uncertain || entry.uncertain;
    if (existing.status === 'consumed' && entry.status !== 'consumed') existing.status = entry.status;
    if (!existing.experimentId && entry.experimentId) existing.experimentId = entry.experimentId;
    if (!existing.note && entry.note) existing.note = entry.note;
  }
  return [...byKey.values()].sort((a, b) => a.base - b.base || a.size - b.size);
}

function detectConflicts(registry) {
  const conflicts = [];
  const entries = registry.entries;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (!overlaps(a, b)) continue;
      const crnPair = a.purposeClass === 'league' && b.purposeClass === 'league'
        && a.crnGroup !== null && a.crnGroup !== undefined && a.crnGroup === b.crnGroup;
      if (crnPair) continue;
      conflicts.push({
        type: a.base === b.base && a.size !== b.size ? 'ledger-size-mismatch' : 'seed-overlap',
        a: describeEntry(a),
        b: describeEntry(b),
        range: [Math.min(a.base, b.base), Math.max(a.base + a.size, b.base + b.size)],
        message:
          `种子区间重叠：[${a.base}, ${a.base + a.size})（${a.sourceId}/${a.purposeClass}）与 ` +
          `[${b.base}, ${b.base + b.size})（${b.sourceId}/${b.purposeClass}）`,
      });
    }
  }
  return conflicts;
}

function describeEntry(entry) {
  return {
    sourceId: entry.sourceId,
    base: entry.base,
    size: entry.size,
    purposeClass: entry.purposeClass,
    purpose: entry.purpose,
    status: entry.status,
    experimentId: entry.experimentId ?? null,
    uncertain: entry.uncertain === true,
  };
}

function summarize(registry) {
  const byPurpose = {};
  for (const entry of registry.entries) {
    byPurpose[entry.purposeClass] = (byPurpose[entry.purposeClass] ?? 0) + 1;
  }
  const validationPool = registry.entries.filter(e =>
    e.base >= VALIDATION_POOL_BASE && e.base < VALIDATION_POOL_MAX);
  return {
    entries: registry.entries.length,
    byPurpose,
    formalChallenges: formalChallengeCount(registry),
    validationPoolIntervals: validationPool.length,
    validationPoolByPurpose: Object.fromEntries(SEED_PURPOSES.map(p => [p,
      validationPool.filter(e => e.purposeClass === p).length]).filter(([, n]) => n > 0)),
    conflicts: registry.conflicts?.length ?? 0,
    missingSources: registry.missingSources.length,
    uncertainEntries: registry.entries.filter(e => e.uncertain).length,
  };
}

/** 正式挑战累计次数：唯一区间数（不信任任一账本自报 challengeCount）。
 * 深度验证/arena/league/baseline 不计入（它们不消耗正式检验的 alpha 预算）。 */
export function formalChallengeCount(registry) {
  return registry.entries.filter(e => e.countsTowardChallengeIndex === true).length;
}

/** 正式挑战累计次数（兼容旧 helper 命名）。 */
export function validationChallengeCount(registry) {
  return formalChallengeCount(registry);
}

/** 验证池内下一个正式挑战起点：全部用途已消费区间的最高末端 + 步长。 */
export function nextFormalValidationBase(registry) {
  const inPool = registry.entries.filter(e => e.base >= VALIDATION_POOL_BASE && e.base < VALIDATION_POOL_MAX);
  if (!inPool.length) return VALIDATION_POOL_BASE;
  const highestEnd = Math.max(...inPool.map(e => e.base + e.size));
  const next = highestEnd + VALIDATION_STRIDE;
  if (next >= VALIDATION_POOL_MAX) {
    throw new Error(`验证种子池已耗尽（下一块起点 ${next} ≥ 上限 ${VALIDATION_POOL_MAX}）`);
  }
  return next;
}

/** 历史基线完整性（fail-closed）：正式挑战次数与验证池高水位都不得回退。
 * 账本文件存在但 history 被截断/重建时，strict 模式无法发现缺失条目；
 * 该检查确保「已消费区间从治理视图消失」不能换来更低的分配起点。 */
function assertHistoricalBaselineIntact(registry) {
  const builtinFormal = registry.entries
    .filter(e => e.countsTowardChallengeIndex === true && BUILTIN_FORMAL_SOURCE_IDS.has(e.sourceId))
    .length;
  if (builtinFormal < HISTORICAL_FORMAL_CHALLENGE_COUNT) {
    throw new Error(
      `历史正式挑战基线不完整（内建账本仅 ${builtinFormal} 次 < 治理基线 ${HISTORICAL_FORMAL_CHALLENGE_COUNT} 次）——` +
      '账本被删除/截断或被重建；禁止分配新正式挑战或晋级，先恢复历史账本原始证据',
    );
  }
  const nextBase = nextFormalValidationBase(registry);
  if (nextBase < HISTORICAL_NEXT_FORMAL_BASE) {
    throw new Error(
      `历史验证池高水位被回退（下一块 ${nextBase} < 治理基线 ${HISTORICAL_NEXT_FORMAL_BASE}）——` +
      '账本被截断/重建，已消费区间从治理视图消失；禁止分配新正式挑战或晋级，否则会静默复用验证种子',
    );
  }
}

/** 区间冲突查询：返回与 [base, base+size) 重叠的全部已登记区间。 */
export function queryInterval(registry, base, size) {
  validateInterval(base, size);
  return registry.entries.filter(e => overlaps({ base, size }, e));
}

/** 单种子冲突查询。 */
export function querySeed(registry, seed) {
  if (!isInt(seed) || seed < 0) throw new Error(`非法种子：${seed}`);
  return registry.entries.filter(e => seed >= e.base && seed < e.base + e.size);
}

/** 汇总可读报告（CLI/审计门禁/报告共用）。 */
export function governanceReport(registry) {
  return {
    schema: registry.schema,
    scannedAt: registry.scannedAt,
    complete: registry.complete,
    missingSources: registry.missingSources,
    summary: registry.summary,
    conflicts: registry.conflicts,
    uncertainties: registry.uncertainties,
    sources: registry.sources.map(s => ({
      id: s.id, path: s.path, format: s.format, present: s.present !== false,
      rawSha256: s.rawSha256, challengeCount: s.challengeCount ?? null,
    })),
  };
}

/** 正式挑战启动前校验（fail-closed）。
 * - 必须在验证池内；
 * - 必须等于治理层算出的下一块（不允许跳块、重建账本或改名重放）；
 * - 不得与任何来源的已消费区间重叠；
 * - challengeIndex 必须等于累计次数 + 1（不接受自报更小序号）。 */
export function assertFormalChallengeAllocation({ registry, base, size, challengeIndex }) {
  if (!registry.complete) {
    throw new Error(`种子治理层不完整（缺失来源：${registry.missingSources.join(', ')}）——禁止启动正式挑战`);
  }
  if ((registry.conflicts ?? []).length) {
    throw new Error(
      `种子治理层存在 ${registry.conflicts.length} 项跨系统冲突——禁止启动正式挑战：` +
      registry.conflicts.map(c => c.message).join('；'),
    );
  }
  if (!isInt(base) || !isInt(size) || size <= 0) throw new Error(`非法挑战区间：base=${base}, size=${size}`);
  if (base < VALIDATION_POOL_BASE || base + size > VALIDATION_POOL_MAX) {
    throw new Error(`正式挑战区间 [${base}, ${base + size}) 不在验证池 [${VALIDATION_POOL_BASE}, ${VALIDATION_POOL_MAX})`);
  }
  assertHistoricalBaselineIntact(registry);
  const expectedBase = nextFormalValidationBase(registry);
  if (base !== expectedBase) {
    throw new Error(
      `正式挑战种子起点 ${base} ≠ 治理层下一块 ${expectedBase}（跳过/重放历史区间均被拒绝）`,
    );
  }
  const overlapsFound = queryInterval(registry, base, size);
  if (overlapsFound.length) {
    throw new Error(
      `正式挑战区间 [${base}, ${base + size}) 与 ${overlapsFound.length} 条已登记区间重叠：` +
      overlapsFound.map(e => `${e.sourceId}[${e.base},${e.base + e.size})`).join('、'),
    );
  }
  const expectedIndex = formalChallengeCount(registry) + 1;
  if (!isInt(challengeIndex) || challengeIndex !== expectedIndex) {
    throw new Error(`challengeIndex ${challengeIndex} ≠ 治理层累计+1 ${expectedIndex}（禁止伪造小序号换取宽松阈值）`);
  }
  return { base, size, challengeIndex, expectedBase, expectedIndex };
}

/** 晋级证据校验（fail-closed）：
 * - 每条人数证据必须已在治理层登记（本地账本或统一登记），且区间在验证池；
 * - 证据区间不得与其它用途（training/arena/deep-validation/league/baseline）重叠；
 * - challengeIndex 唯一且覆盖最近 N 次累计挑战，最大序号 = 治理层累计次数；
 * - 人数覆盖必须完整披露（调用方另行校验 2–5）。
 */
export function assertPromotionEvidenceRegistered({ registry, seatEvidence }) {
  if (!registry.complete) {
    throw new Error(`种子治理层不完整（缺失来源：${registry.missingSources.join(', ')}）——禁止晋级`);
  }
  if ((registry.conflicts ?? []).length) {
    throw new Error(
      `种子治理层存在 ${registry.conflicts.length} 项跨系统冲突——禁止晋级：` +
      registry.conflicts.map(c => c.message).join('；'),
    );
  }
  const problems = [];
  const indexes = [];
  // AI7 之前的正式挑战由仓库内建账本证明；其后的新证据必须来自中央登记。
  // 同时要求「次数 + 验证池高水位」都不低于治理基线（防账本截断/重建）。
  assertHistoricalBaselineIntact(registry);
  const historicalFormalChallenges = HISTORICAL_FORMAL_CHALLENGE_COUNT;
  for (const evidence of seatEvidence) {
    const base = Number(evidence.seedBase);
    const size = Number(evidence.seeds);
    const challengeIndex = Number(evidence.challengeIndex);
    if (!isInt(base) || !isInt(size) || size <= 0) {
      problems.push(`人数 ${evidence.seatCount}：非法区间 base=${evidence.seedBase}, seeds=${evidence.seeds}`);
      continue;
    }
    if (base < VALIDATION_POOL_BASE || base + size > VALIDATION_POOL_MAX) {
      problems.push(`人数 ${evidence.seatCount}：区间 [${base}, ${base + size}) 不在验证池`);
      continue;
    }
    if (!isInt(challengeIndex) || challengeIndex < 1) {
      problems.push(`人数 ${evidence.seatCount}：challengeIndex 非法`);
      continue;
    }
    indexes.push(challengeIndex);
    const covering = registry.entries.filter(e =>
      e.base <= base && e.base + e.size >= base + size && e.purposeClass === 'formal-challenge');
    if (!covering.length) {
      problems.push(
        `人数 ${evidence.seatCount}：区间 [${base}, ${base + size}) 没有任何已登记的正式挑战账本条目` +
        '（未登记证据不得晋级，禁止利用账本重建/改名重放）',
      );
    } else if (!covering.some(e => e.challengeIndex === challengeIndex)) {
      problems.push(
        `人数 ${evidence.seatCount}：区间 [${base}, ${base + size}) 的账本条目未记录 challengeIndex=${challengeIndex}` +
        '（复用历史块或伪造序号均被拒绝）',
      );
    }
    if (challengeIndex > historicalFormalChallenges) {
      const centrallyRegistered = covering.some(e =>
        e.sourceId === 'governance-central'
        && e.challengeIndex === challengeIndex
        && e.status === 'completed');
      if (!centrallyRegistered) {
        problems.push(
          `人数 ${evidence.seatCount}：challengeIndex=${challengeIndex} 超过历史正式挑战 ${historicalFormalChallenges} 次，` +
          '但中央种子登记（governance-central）中没有该次挑战的已完成记录' +
          '（新证据必须由 run-formal-challenge/evolve 在动用种子前登记；禁止用重建/改名后的本地账本伪造）',
        );
      }
    }
    const foreign = registry.entries.filter(e =>
      e.purposeClass !== 'formal-challenge' && overlaps({ base, size }, e));
    if (foreign.length) {
      problems.push(
        `人数 ${evidence.seatCount}：区间与其它用途区间重叠：` +
        foreign.map(e => `${e.sourceId}/${e.purposeClass}`).join('、'),
      );
    }
  }
  const total = formalChallengeCount(registry);
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  if (unique.length !== indexes.length) problems.push('多条人数证据复用了同一 challengeIndex');
  if (unique.length) {
    if (Math.max(...unique) !== total) {
      problems.push(`最大 challengeIndex ${Math.max(...unique)} ≠ 治理层累计挑战次数 ${total}`);
    }
    if (Math.min(...unique) < total - unique.length + 1) {
      problems.push(
        `challengeIndex 集合 ${JSON.stringify(unique)} 未覆盖最近 ${unique.length} 次挑战（累计 ${total}）——疑似伪造历史序号`,
      );
    }
    for (let i = 1; i < unique.length; i++) {
      if (unique[i] !== unique[i - 1] + 1) {
        problems.push(`challengeIndex 不连续：${unique.join(',')}`);
        break;
      }
    }
  }
  if (problems.length) {
    throw new Error(`晋级种子治理校验失败（fail-closed）：\n- ${problems.join('\n- ')}`);
  }
  return { challengeIndexes: unique, totalChallenges: total };
}

/** 文件锁（与联赛账本同一纪律：O_EXCL + 陈旧锁接管）。 */
function withRegistryLock(fn, registryPath = CENTRAL_REGISTRY_PATH) {
  const lockPath = `${registryPath}.lock`;
  let fd = null;
  const start = Date.now();
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* 锁已释放 */ }
      if (Date.now() - start > 30_000) throw new Error(`种子登记锁获取超时：${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* 已关闭 */ }
    try { unlinkSync(lockPath); } catch { /* 已接管 */ }
  }
}

function writeCentralRegistry(registry, path = CENTRAL_REGISTRY_PATH) {
  registry.updatedAt = new Date().toISOString();
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
}

/** 新消费登记（动用种子之前）：跨系统冲突检查 + 原子追加。
 * 各训练系统保留自己的账本；中央登记只记录身份与区间，便于统一查询。 */
export function reserveConsumption({
  purposeClass,
  purpose,
  base,
  size,
  experimentId,
  challengeIndex = null,
  evidencePath = null,
  codeCommit = null,
  crnGroup = null,
  registryPath = CENTRAL_REGISTRY_PATH,
  root = REPO_ROOT,
}) {
  if (!SEED_PURPOSES.includes(purposeClass)) throw new Error(`未知用途分类：${purposeClass}`);
  validateInterval(base, size);
  if (!/^[a-z0-9][a-z0-9._-]{2,95}$/i.test(String(experimentId ?? ''))) {
    throw new Error(`experimentId 非法：${experimentId}`);
  }
  return withRegistryLock(() => {
    const current = existsSync(registryPath)
      ? readJson(registryPath)
      : { schema: CENTRAL_REGISTRY_SCHEMA, createdAt: new Date().toISOString(), updatedAt: null, entries: [] };
    if (current.schema !== CENTRAL_REGISTRY_SCHEMA) throw new Error(`统一种子登记 schema 不识别：${current.schema}`);
    if ((current.entries ?? []).some(e => e.experimentId === experimentId)) {
      throw new Error(`实验已登记：${experimentId}（续跑请用 complete/新 experimentId，禁止重复登记）`);
    }
    const allowedCrn = (e) => purposeClass === 'league' && crnGroup !== null
      && e.crnGroup === crnGroup && e.purposeClass === 'league';
    if (current.entries.some(e => overlaps({ base, size }, e) && !allowedCrn(e))) {
      throw new Error(`登记区间 [${base}, ${base + size}) 与统一登记中已有区间重叠（种子复用）`);
    }
    // 读取全部来源（含中央当前内容）做跨系统防重。
    const governance = loadSeedGovernance({
      root, strict: true, includeHistorical: true, centralRegistryPath: registryPath,
    });
    if (!governance.complete || governance.conflicts.length) {
      throw new Error(
        `种子治理层不完整或存在冲突（missing=${governance.missingSources.join(',') || '无'}，` +
        `conflicts=${governance.conflicts.length}）——禁止登记新消费`,
      );
    }
    const existing = governance.entries.filter(e => overlaps({ base, size }, e) && !allowedCrn(e));
    if (existing.length) {
      throw new Error(
        `登记区间 [${base}, ${base + size}) 与已消费区间重叠：` +
        existing.map(e => `${e.sourceId}/${e.purposeClass}[${e.base},${e.base + e.size})`).join('、'),
      );
    }
    if (purposeClass === 'formal-challenge') {
      assertHistoricalBaselineIntact(governance);
      const expectedIndex = formalChallengeCount(governance) + 1;
      if (!isInt(challengeIndex) || challengeIndex !== expectedIndex) {
        throw new Error(`正式挑战 challengeIndex ${challengeIndex} ≠ 治理层累计+1 ${expectedIndex}`);
      }
      const expectedBase = nextFormalValidationBase(governance);
      if (base !== expectedBase) {
        throw new Error(`正式挑战起点 ${base} ≠ 治理层下一块 ${expectedBase}`);
      }
    }
    const entry = {
      experimentId,
      base,
      size,
      purposeClass,
      purpose: String(purpose ?? ''),
      status: 'reserved',
      challengeIndex: isInt(challengeIndex) ? challengeIndex : null,
      countsTowardChallengeIndex: purposeClass === 'formal-challenge',
      evidencePath,
      codeCommit,
      crnGroup,
      reservedAt: new Date().toISOString(),
      completedAt: null,
      note: null,
    };
    current.entries = [...(current.entries ?? []), entry].sort((a, b) => a.base - b.base || a.size - b.size);
    writeCentralRegistry(current, registryPath);
    return { entry, registry: current };
  }, registryPath);
}

/** 消费收尾：completed / voided（作废继续占用区间，留痕 reason）。 */
export function completeConsumption(experimentId, {
  status = 'completed', note = null, evidencePath = null,
  registryPath = CENTRAL_REGISTRY_PATH,
} = {}) {
  if (!['completed', 'voided', 'in-progress'].includes(status)) {
    throw new Error(`非法收尾状态：${status}`);
  }
  return withRegistryLock(() => {
    const current = readJson(registryPath);
    const entry = (current.entries ?? []).find(e => e.experimentId === experimentId);
    if (!entry) throw new Error(`实验未登记：${experimentId}`);
    entry.status = status;
    entry.completedAt = new Date().toISOString();
    if (note) entry.note = String(note);
    if (evidencePath) entry.evidencePath = evidencePath;
    writeCentralRegistry(current, registryPath);
    return entry;
  }, registryPath);
}
