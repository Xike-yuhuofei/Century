/** D4：轻量级自动进化控制器（Campaign Controller 原型）。
 *
 * 闭环：
 *   候选生成 → 静态安全检查 → 独立构建校验 → 开发池低成本评估
 *   → 多维候选筛选 → 深度确认 → 机器门禁挑战请求
 *   → （可选注入 promotionHandler：正式第一名率挑战 + 自动晋级）
 *   → 结果归档 → 失败诊断 → 新一轮候选生成
 *
 * 硬约束：
 * - 只使用 AI7 开发池窗口（真实种子治理 provider 原子分配），绝不消费正式验证池；
 * - 冠军晋级只认预注册第一名率证据；控制器只排队，晋级由 promotionHandler/CI 机器门禁执行；
 * - 检查点/断点恢复/安全停止/M4 预算/并发上限/失败隔离/完整日志/重复运行保护；
 * - 评估器与生成器可注入（测试用假评估器，不跑长对局；生产默认真实评估器）。
 */

import {
  existsSync, openSync, writeSync, closeSync, unlinkSync, readdirSync, readFileSync,
} from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ensureDir, writeJSON, appendJSONL, readJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import {
  SCHEMAS, assertCondition, assertDisjoint, deepFreeze, sha256Canonical,
} from './core.mjs';
import { createLiveGovernanceProvider, createAutonomousGovernanceAdapter } from './governance-provider-v2.mjs';
import { ArtifactStore } from './artifact-store.mjs';
import { generateCandidateBatch } from './candidate-generator.mjs';
import { generateMultiModuleBatch, recordCoEvolutionElite } from './multi-module-generator.mjs';
import { runSafetyChecks } from './safety-check.mjs';
import { evaluateCandidate, assertIndependentWindows } from './dev-evaluator.mjs';
import { AI9_DEV_BLOCKS } from './core.mjs';
import { scoreCandidate, selectCandidates } from './selection.mjs';
import {
  labelsFromDiagnosticsAnalysis, labelsFromHumanAnalytics, mergeLabels, toResearchHints,
} from './failure-labels.mjs';
import { computeCodeVersion, sameCodeDigest } from '../lib/code-version.mjs';
import { createResearchIndex } from './research-index.mjs';
import { openResearchMemory } from './research-memory.mjs';
import { diagnosePairedEvidence } from './failure-diagnosis.mjs';
import { buildResearchBrief, writeBriefConfig } from './research-context.mjs';
import { decideNextResearch, summarizeTrend, composeRoundPlan } from './research-orchestrator.mjs';
import { moduleRegistry } from '../../ai5/openevolve/node/module_registry.mjs';

const CAMPAIGN_CONFIG_VERSION = 1;
/** 深验异常率上限：超过则判"深验不稳定"，绝不进入正式挑战待审批请求。 */
const DEEP_MAX_ANOMALY_RATE = 0.2;
/** P0.3 正式挑战资格（读取任何正式结果之前固定，禁止看结果后放宽）：
 * - 最小有意义效应 10pp（与 statistical-plan 的 MDE 目标一致）；
 * - 至少 16 个配对单位（8 种子 × 2 人数起）；
 * - 单侧下界不得低于 −15pp（避免把完全不确定的候选送进正式验证）。 */
export const CHALLENGE_MIN_EFFECT = 0.10;
export const CHALLENGE_MIN_PAIRS = 16;
export const CHALLENGE_MIN_LOWER = -0.15;

/** 深验候选排序键：配对第一名率下界优先，其次点估计，最后诊断 composite。 */
function rankOfDeep(item) {
  const lower = item.deep?.metrics?.firstPlaceLower;
  const delta = item.deep?.metrics?.firstPlaceDelta;
  if (Number.isFinite(lower)) return lower;
  if (Number.isFinite(delta)) return delta;
  return (item.deep?.score?.composite ?? 0) - 1;
}

/**
 * 正式挑战资格判定（研究保留与正式挑战必须分开）。
 *
 * @param {object} options
 * @param {object} options.item 候选状态（含 strategy/deep.metrics）
 * @param {number} options.minPairs 最少配对单位
 * @param {number} options.minEffect 最小有意义效应
 * @param {number} options.minLower 允许的单侧下界下限
 */
export function challengeEligibility({ item, minPairs, minEffect, minLower }) {
  const metrics = item?.deep?.metrics ?? {};
  const delta = metrics.firstPlaceDelta;
  const lower = metrics.firstPlaceLower;
  const pairs = metrics.pairs ?? 0;
  const reasons = [];
  if (item?.strategy === 'control') reasons.push('对照基线候选（官方模块）不得进入正式挑战');
  if (!Number.isFinite(delta)) reasons.push('缺少配对第一名率增量（非配对设计）');
  else if (delta < minEffect) reasons.push(`配对增量 ${delta} < 最小有意义效应 ${minEffect}`);
  if (pairs < minPairs) reasons.push(`配对单位 ${pairs} < 下限 ${minPairs}`);
  if (Number.isFinite(lower) && lower < minLower) reasons.push(`单侧下界 ${lower} < ${minLower}`);
  return {
    eligible: reasons.length === 0,
    reason: reasons.length ? reasons.join('；') : null,
    delta: Number.isFinite(delta) ? delta : null,
    lower: Number.isFinite(lower) ? lower : null,
    pairs,
    minPairs, minEffect, minLower,
  };
}

/** 读取 append-only 事件日志中的最大 seq：崩溃窗口下 state 可能落后于日志尾部。 */
function lastLoggedEventSeq(logPath) {
  if (!existsSync(logPath)) return 0;
  const lines = readFileSync(logPath, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const seq = JSON.parse(line).seq;
      if (Number.isSafeInteger(seq) && seq > 0) return seq;
    } catch { /* 跳过截断/损坏行，继续向前找 */ }
  }
  return 0;
}

export const DEFAULT_CAMPAIGN_CONFIG = deepFreeze({
  version: CAMPAIGN_CONFIG_VERSION,
  configRef: 'ai7://campaign/default',
  rounds: 1,
  playerCounts: [2, 3],
  quickSeeds: 2,
  deepSeeds: 3,
  maxMoves: 400,
  deadlineMs: 20_000,
  retainTopK: 3,
  deepConfirmations: 1,
  generation: {
    count: 4,
    seed: 20_261_025,
    targetIds: null,
    /** 'descriptor'（AI7 默认）| 'multi-module'（AI9 协同进化）。 */
    mode: 'descriptor',
    strategies: null,
    openevolveIterations: 2,
    includeControl: true,
    allowDeterministicFallback: true,
  },
  budget: {
    maxCandidates: 8,
    maxGames: 24,
    maxWallMs: 300_000,
    maxConcurrent: 1,
    maxDeepConfirmations: 2,
  },
  diagnosticsPath: 'training/reports/diagnostics-latest/analysis.json',
  humanAnalyticsFailuresPath: null,
  /** 显式父候选（已批准/人工选定的 artifact id）；null = 官方冠军归档基线。 */
  parentCandidateId: null,
  /** 第二轮起自动从上一轮保留候选继续（未显式指定 parentCandidateId 时）。 */
  continueFromSelected: false,
});

function normalizeConfig(config) {
  const merged = {
    ...DEFAULT_CAMPAIGN_CONFIG,
    ...config,
    generation: { ...DEFAULT_CAMPAIGN_CONFIG.generation, ...(config?.generation ?? {}) },
    budget: { ...DEFAULT_CAMPAIGN_CONFIG.budget, ...(config?.budget ?? {}) },
  };
  assertCondition(Number.isSafeInteger(merged.rounds) && merged.rounds >= 1, 'rounds 必须为 ≥1 整数');
  assertCondition(Array.isArray(merged.playerCounts) && merged.playerCounts.length > 0, 'playerCounts 不能为空');
  for (const n of merged.playerCounts) assertCondition([2, 3, 4, 5].includes(n), `非法人数：${n}`);
  assertCondition(Number.isSafeInteger(merged.quickSeeds) && merged.quickSeeds > 0, 'quickSeeds 非法');
  assertCondition(Number.isSafeInteger(merged.deepSeeds) && merged.deepSeeds > 0, 'deepSeeds 非法');
  assertCondition(merged.quickSeeds <= 1000 && merged.deepSeeds <= 1000, '种子窗口最多 1000');
  // 编译型多模块评估要求每个种子独立分配到一个人数层：种子数必须 ≥ 人数层数。
  assertCondition(merged.quickSeeds >= merged.playerCounts.length,
    `quickSeeds=${merged.quickSeeds} 少于人数层数 ${merged.playerCounts.length}（无法分人数配对）`);
  assertCondition(merged.deepSeeds >= merged.playerCounts.length,
    `deepSeeds=${merged.deepSeeds} 少于人数层数 ${merged.playerCounts.length}（无法分人数配对）`);
  assertCondition(Number.isSafeInteger(merged.retainTopK) && merged.retainTopK > 0, 'retainTopK 非法');
  assertCondition(Number.isSafeInteger(merged.deepConfirmations) && merged.deepConfirmations >= 0, 'deepConfirmations 非法');
  assertCondition(['descriptor', 'multi-module'].includes(merged.generation.mode),
    `generation.mode 非法：${String(merged.generation.mode)}`);
  if (merged.generation.strategies !== null) {
    assertCondition(Array.isArray(merged.generation.strategies) && merged.generation.strategies.length > 0,
      'generation.strategies 必须为非空数组或 null');
    for (const strategy of merged.generation.strategies) {
      assertCondition(['single', 'pair', 'multi', 'crossover', 'ablation', 'openevolve'].includes(strategy),
        `未知生成策略：${String(strategy)}`);
    }
  }
  const b = merged.budget;
  for (const key of ['maxCandidates', 'maxGames', 'maxWallMs', 'maxConcurrent', 'maxDeepConfirmations']) {
    assertCondition(Number.isSafeInteger(b[key]) && b[key] >= 0, `budget.${key} 非法`);
  }
  assertCondition(b.maxConcurrent >= 1 && b.maxConcurrent <= 4, 'maxConcurrent 必须在 1..4');
  assertCondition(b.maxCandidates >= 1, 'maxCandidates 必须 ≥1');
  assertCondition(b.maxGames >= 1, 'maxGames 必须 ≥1');
  assertCondition(b.maxWallMs >= 1, 'maxWallMs 必须 ≥1');
  return deepFreeze(merged);
}

function nowIso() {
  return new Date().toISOString();
}

function pidAliveDefault(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function expectedGames({ evidenceMode, seeds, playerCounts, pairedArms = 1 }) {
  return evidenceMode === 'game' ? seeds.length * playerCounts.length * pairedArms : 0;
}

/** 仓库内路径存相对路径（产物可移植）；仓库外（测试临时目录）保留绝对路径。 */
function portablePath(path) {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith('..') ? path : rel;
}

function resolvePortable(path) {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export class CampaignController {
  constructor({
    campaignId, rootDir, store = null, governance = null, config = {},
    generator = null, evaluator = null, isPidAlive = pidAliveDefault, promotionHandler = null,
  }) {
    assertCondition(typeof campaignId === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(campaignId),
      `campaignId 非法：${String(campaignId)}`);
    this.campaignId = campaignId;
    this.rootDir = resolve(rootDir);
    this.config = normalizeConfig(config);
    this.store = store ?? new ArtifactStore({ root: resolve(this.rootDir, 'artifacts') });
    // 生产默认：真实种子治理 + 机器门禁队列（不再使用测试替身）。
    this.governance = governance ?? createAutonomousGovernanceAdapter({ provider: createLiveGovernanceProvider() });
    this.generator = generator ?? null;
    this.evaluator = evaluator ?? null;
    this.isPidAlive = isPidAlive;
    this.promotionHandler = promotionHandler;
    this.statePath = resolve(this.rootDir, 'state.json');
    this.lockPath = resolve(this.rootDir, '.campaign.lock');
    this.logPath = resolve(this.rootDir, 'logs', 'events.jsonl');
    this.researchPath = resolve(this.rootDir, 'research-index.jsonl');
    this.research = createResearchIndex({ path: this.researchPath, campaignId });
    this.memoryPath = resolve(this.rootDir, 'research-memory.jsonl');
    this.memory = openResearchMemory({ path: this.memoryPath });
    this.stopPath = resolve(this.rootDir, '.stop');
    this._stopRequested = false;
    this.runFingerprint = sha256Canonical({
      campaignId,
      config: this.config,
      governanceContract: this.governance.contractVersion,
    });
  }

  requestStop(reason = 'operator-request') {
    this._stopRequested = true;
    this._stopReason = reason;
    try { writeJSON(this.stopPath, { reason, at: nowIso() }); } catch { /* 停止标志写失败不阻断内存停止 */ }
  }

  _stopRequestedNow() {
    return this._stopRequested || existsSync(this.stopPath);
  }

  _acquireLock() {
    ensureDir(this.rootDir);
    if (existsSync(this.lockPath)) {
      let lock = null;
      try { lock = readJSON(this.lockPath); } catch { lock = null; }
      if (lock && Number.isSafeInteger(lock.pid) && this.isPidAlive(lock.pid)) {
        throw new Error(`campaign ${this.campaignId} 已有活动进程 pid=${lock.pid}（重复运行保护）`);
      }
      unlinkSync(this.lockPath);
    }
    const fd = openSync(this.lockPath, 'wx');
    writeSync(fd, JSON.stringify({ pid: process.pid, runFingerprint: this.runFingerprint, at: nowIso() }));
    closeSync(fd);
  }

  _releaseLock() {
    if (existsSync(this.lockPath)) {
      try { unlinkSync(this.lockPath); } catch { /* 锁已由其他进程清理 */ }
    }
  }

  _event(state, type, payload = {}, candidateId = null) {
    state.lastEventSeq = (state.lastEventSeq ?? 0) + 1;
    appendJSONL(this.logPath, {
      schema: SCHEMAS.campaignEvent,
      seq: state.lastEventSeq,
      at: nowIso(),
      type,
      campaignId: this.campaignId,
      round: state.rounds[state.currentRoundIndex]?.round ?? null,
      candidateId,
      payload,
    });
  }

  _save(state) {
    state.updatedAt = nowIso();
    state.checkpointSeq = (state.checkpointSeq ?? 0) + 1;
    writeJSON(this.statePath, state);
    const checkpointDir = ensureDir(resolve(this.rootDir, 'checkpoints'));
    writeJSON(resolve(checkpointDir, `state-${String(state.checkpointSeq).padStart(3, '0')}.json`), state);
    const files = readdirSync(checkpointDir).filter(f => f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 30))) {
      try { unlinkSync(resolve(checkpointDir, old)); } catch { /* 清理旧检查点失败不阻断 */ }
    }
  }

  _initState() {
    const state = {
      schema: SCHEMAS.campaign,
      campaignId: this.campaignId,
      runFingerprint: this.runFingerprint,
      codeVersion: computeCodeVersion(),
      config: this.config,
      status: 'initialized',
      phase: 'initialized',
      currentRoundIndex: 0,
      rounds: [],
      checkpointSeq: 0,
      lastEventSeq: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      budgetUsed: { candidates: 0, games: 0, wallMs: 0, deepConfirmations: 0 },
      pendingApprovals: [],
      guardrails: {
        validationPoolConsumed: false,
        promotionTriggered: false,
        championMutation: 'none',
        formalChallengeApprovalRequired: false,
        machineGateRequired: true,
      },
      promotionQueue: [],
      promotionOutcomes: [],
      moduleElites: [],
      mapElites: {},
      generationDiagnostics: [],
    };
    this._startRound(state);
    return state;
  }

  _usedWindowIds(state, purpose) {
    const ids = [];
    for (const round of state.rounds) {
      const w = round.seedWindows?.[purpose];
      if (w) ids.push(w.windowId);
    }
    return ids;
  }

  _startRound(state) {
    const round = state.rounds.length + 1;
    const screenWindow = this.governance.allocateDevSeedWindow({
      campaignId: this.campaignId,
      round,
      purpose: 'screen',
      count: this.config.quickSeeds,
      excludeWindowIds: this._usedWindowIds(state, 'screen'),
    });
    const deepWindow = this.governance.allocateDevSeedWindow({
      campaignId: this.campaignId,
      round,
      purpose: 'deep',
      count: this.config.deepSeeds,
      excludeWindowIds: this._usedWindowIds(state, 'deep'),
    });
    const screenSeeds = Array.from({ length: this.config.quickSeeds }, (_, i) => screenWindow.base + i);
    const deepSeeds = Array.from({ length: this.config.deepSeeds }, (_, i) => deepWindow.base + i);
    assertIndependentWindows({
      screenSeeds,
      deepSeeds,
      blocks: this.config.generation.mode === 'multi-module' ? AI9_DEV_BLOCKS : undefined,
    });
    assertDisjoint([screenWindow.base, screenWindow.base + screenWindow.count], [deepWindow.base, deepWindow.base + deepWindow.count],
      'screen/deep 窗口');
    const roundData = {
      round,
      seedWindows: { screen: screenWindow, deep: deepWindow },
      screenSeeds,
      deepSeeds,
      generated: false,
      selected: false,
      deepDone: false,
      approvalDone: false,
      diagnosticsDone: false,
      candidates: [],
      selectedIds: [],
      selectionSummary: null,
      diagnostics: null,
      rejectedAtGeneration: [],
      notes: [],
    };
    state.rounds.push(roundData);
    state.currentRoundIndex = state.rounds.length - 1;
    this._event(state, 'round-started', {
      round,
      screenWindow, deepWindow, screenSeeds, deepSeeds,
    });
    return roundData;
  }

  _currentRound(state) {
    return state.rounds[state.currentRoundIndex];
  }

  _experimentFor(state, roundData) {
    return {
      configRef: this.config.configRef,
      configHash: sha256Canonical(this.config),
      seedRefs: [
        {
          purpose: 'screen', windowId: roundData.seedWindows.screen.windowId,
          base: roundData.seedWindows.screen.base, count: roundData.screenSeeds.length,
        },
        {
          purpose: 'deep', windowId: roundData.seedWindows.deep.windowId,
          base: roundData.seedWindows.deep.base, count: roundData.deepSeeds.length,
        },
      ],
    };
  }

  _parentArtifact(state, roundData) {
    // 实验 A0：allowInheritance=false 精确复现旧路径（每代从官方源码开始，无父代）。
    if (this.config.generation.allowInheritance === false) {
      this._parentSource = 'disabled-for-experiment';
      return null;
    }
    // 显式父候选优先（可指向人工批准的 artifact；身份由 store 校验）。
    if (this.config.parentCandidateId) {
      try {
        const parent = this.store.get(this.config.parentCandidateId);
        this._assertParentIntegrity(parent, this.config.parentCandidateId);
        return parent;
      } catch (error) {
        throw new Error(`显式父候选不可用：${this.config.parentCandidateId}（${error.message}）`);
      }
    }
    if (roundData.round > 1 && this.config.continueFromSelected) {
      const previous = state.rounds[roundData.round - 2];
      const bestId = previous?.selectedIds?.[0];
      if (bestId) {
        try {
          const parent = this.store.get(bestId);
          if (this.config.generation.mode === 'multi-module') this._assertParentIntegrity(parent, bestId);
          return parent;
        } catch (error) {
          // P0.1：多模块模式下父代缺失/哈希错误必须拒绝继续，不得静默退回官方基线。
          if (this.config.generation.mode === 'multi-module') {
            throw new Error(`上一轮父候选不可用：${bestId}（${error.message}）——拒绝在无谱系的情况下继续进化`);
          }
          return null;
        }
      }
    }
    if (this.config.generation.mode === 'multi-module') {
      const elite = this._bestEliteParent(state);
      if (elite) return elite;
      // 精英池为空（首轮深验尚未发生或全部未通过）：用上一轮快筛最优继续，
      // 仍然必须是真实源码 artifact；再没有才允许引导代。
      const previous = state.rounds[roundData.round - 2];
      // 即使快筛失败，只要 artifact 真实存在且源码可校验，仍然可以作为父代继续进化
      // （否则一次评估异常会让整个 campaign 停摆）。
      const ranked = (previous?.candidates ?? [])
        .filter(c => c.strategy !== 'control' && c.stage !== 'safety-failed')
        .sort((a, b) => (b.quick?.score?.rankKey ?? -9) - (a.quick?.score?.rankKey ?? -9));
      for (const candidate of ranked) {
        try {
          const parent = this.store.get(candidate.candidateId);
          this._assertParentIntegrity(parent, candidate.candidateId);
          this._parentSource = 'previous-round';
          return parent;
        } catch { /* 继续寻找下一个可用父代 */ }
      }
      this._parentSource = 'bootstrap';
      return null;
    }
    return null;
  }

  /** 多模块模式的跨代继承父代：按配对第一名率增量从精英池取最优。 */
  _bestEliteParent(state) {
    const elites = [...(state.moduleElites ?? [])];
    const byCell = Object.values(state.mapElites ?? {});
    const entries = [...elites, ...byCell].filter(entry => entry?.candidateId);
    const candidates = entries.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    for (const entry of candidates) {
      try {
        const parent = this.store.get(entry.candidateId);
        this._assertParentIntegrity(parent, entry.candidateId);
        this._parentSource = 'elite';
        return parent;
      } catch (error) {
        this._lastParentFailure = { candidateId: entry.candidateId, reason: error.message };
      }
    }
    // 精英池全部不可用（文件缺失/哈希不符）→ 拒绝继续，绝不静默回落到官方基线。
    if (entries.length > 0) {
      throw new Error(
        `精英池中的父代全部不可用（${this._lastParentFailure?.candidateId ?? '?'}：${this._lastParentFailure?.reason ?? 'unknown'}）——拒绝无谱系继续`,
      );
    }
    this._parentSource = 'bootstrap';
    return null;
  }

  /** 父代完整性：artifact 可被 store 校验（内容寻址哈希）+ 源码非空。 */
  _assertParentIntegrity(artifact, candidateId) {
    assertCondition(artifact, `父候选 ${candidateId} 不存在`);
    assertCondition(artifact.candidateId === candidateId,
      `父候选身份不符：请求 ${candidateId}，实际 ${artifact.candidateId}`);
    assertCondition(typeof artifact.sourceHash === 'string' && /^[0-9a-f]{64}$/.test(artifact.sourceHash),
      `父候选 ${candidateId} 缺少合法源码哈希`);
    assertCondition(artifact.source?.modules?.length > 0,
      `父候选 ${candidateId} 不是多模块源码候选（无法继承代码）`);
    return true;
  }

  /**
   * P0.1：跨代谱系核验（生成即校验，绝不把"父代 ID 元数据"当成继承）。
   *
   * 拒绝条件：parentId/父源码哈希不符、父模块哈希不符、没有任何模块变化、
   * 依赖闭包缺失（候选模块集合不再包含父代被依赖模块时由编译期静态检查兜底）。
   */
  _verifyLineage({ artifact, parentArtifact, round }) {
    const lineage = artifact.lineage;
    assertCondition(lineage, `候选 ${artifact.candidateId} 缺少 lineage（拒绝未登记谱系的候选）`);
    if (parentArtifact) {
      assertCondition(artifact.parentId === parentArtifact.candidateId,
        `候选 parentId ${String(artifact.parentId)} ≠ 本轮父代 ${parentArtifact.candidateId}`);
      assertCondition(lineage.parentSourceHash === parentArtifact.sourceHash,
        `候选 lineage.parentSourceHash 与父代源码哈希不符（期望 ${parentArtifact.sourceHash}，实际 ${String(lineage.parentSourceHash)}）`);
      const parentHashes = Object.fromEntries(
        parentArtifact.source.modules.map(m => [m.id, m.functionSha256]),
      );
      for (const [id, hash] of Object.entries(lineage.parentModuleHashes ?? {})) {
        assertCondition(parentHashes[id] === hash,
          `候选记录的父代模块 ${id} 哈希 ${hash} 与实际父代 ${String(parentHashes[id])} 不符`);
      }
      assertCondition(lineage.modulesChanged.length > 0,
        `候选 ${artifact.candidateId} 与父代源码完全相同（modulesChanged 为空）——拒绝无变化的"伪代"`);
    } else {
      assertCondition(artifact.parentId === null,
        `第 ${round} 轮为引导代（无父代），候选却声明 parentId=${String(artifact.parentId)}`);
    }
    return true;
  }

  /**
   * P1.1：研究控制层决策（趋势 → 决策 → ResearchBrief → 每轮 OpenEvolve 配置）。
   * 仅多模块模式启用；descriptor 模式保持原有行为。
   */
  _researchPlan(state, roundData, parentArtifact, hints, { injectConfig = true } = {}) {
    const history = [];
    let lastEvidence = null;
    let lastEvidencePath = null;
    for (const round of state.rounds) {
      if (round.round >= roundData.round) break;
      const confirmed = (round.candidates ?? [])
        .filter(c => c.deep?.status === 'done' && Number.isFinite(c.deep?.metrics?.firstPlaceDelta))
        .sort((a, b) => (b.deep.metrics.firstPlaceLower ?? -9) - (a.deep.metrics.firstPlaceLower ?? -9));
      const best = confirmed[0];
      if (!best) continue;
      history.push({
        round: round.round,
        delta: best.deep.metrics.firstPlaceDelta,
        lower: best.deep.metrics.firstPlaceLower ?? null,
        pairs: best.deep.metrics.pairs ?? null,
      });
      lastEvidencePath = best.deep.evidencePath;
    }
    if (lastEvidencePath) {
      try { lastEvidence = readJSON(resolvePortable(lastEvidencePath)); } catch { lastEvidence = null; }
    }
    const trend = summarizeTrend(history);
    const diagnosis = state.rounds[roundData.round - 2]?.diagnostics?.diagnosis ?? null;
    const testedHypotheses = this.memory.testedHypotheses();
    const positiveModules = this.memory.positiveModules();
    const recentFailures = this.memory.readAll().filter(e => e.kind === 'failure').slice(-10);
    const memorySummary = { testedHypotheses, positiveModules, recentFailures };
    const modules = this.config.generation.targetIds?.length
      ? this.config.generation.targetIds
      : moduleRegistry().modules.map(m => m.id);
    const budget = {
      remainingCandidates: this.config.budget.maxCandidates - state.budgetUsed.candidates,
      remainingGames: this.config.budget.maxGames - state.budgetUsed.games,
    };
    const decision = decideNextResearch({
      trend, diagnosis, memory: memorySummary, modules, budget,
      hasElites: (state.moduleElites ?? []).length > 0,
    });
    const brief = buildResearchBrief({
      round: roundData.round,
      parentArtifact,
      evidence: lastEvidence,
      diagnosis,
      memory: memorySummary,
      moduleIds: decision.targetIds.length ? decision.targetIds : modules,
      experiment: {
        playerCounts: this.config.playerCounts,
        quickSeeds: this.config.quickSeeds,
        deepSeeds: this.config.deepSeeds,
      },
      previousBest: { stagnantRounds: trend.stagnantRounds },
    });
    // 研究假设写入跨进程研究记忆（LLM 解释只能是假设，等待实验验证）。
    for (const hypothesis of brief.hypotheses) {
      const existing = testedHypotheses.find(h => h.hypothesisId === hypothesis.id);
      if (existing) continue;
      this.memory.recordHypothesis({
        hypothesisId: hypothesis.id,
        statement: hypothesis.statement,
        mechanisms: hypothesis.mechanisms.map(m => m.claim),
        predictions: hypothesis.mechanisms.map(m => m.prediction),
        moduleScope: [...new Set(hypothesis.mechanisms.flatMap(m => m.modules))],
        status: 'untested',
        contextHash: brief.contextHash,
      });
    }
    const plan = composeRoundPlan({
      plan: decision,
      briefContext: { round: roundData.round, parentArtifact, memory: memorySummary },
      extra: { trend, contextHash: brief.contextHash },
    });
    let configPath = null;
    let briefPath = null;
    if (!injectConfig) {
      // 实验 B1：只走 artifacts 通道（不替换 system_message）。
      try {
        const outPath = resolve(this.rootDir, 'openevolve-briefs', `r${String(roundData.round).padStart(3, '0')}.brief.json`);
        briefPath = outPath;
        mkdirSync(resolve(this.rootDir, 'openevolve-briefs'), { recursive: true });
        writeFileSync(outPath, JSON.stringify(brief, null, 2));
      } catch { /* 简报落盘失败不阻断生成 */ }
    } else try {
      const outPath = resolve(this.rootDir, 'openevolve-configs', `r${String(roundData.round).padStart(3, '0')}.yaml`);
      const written = writeBriefConfig({
        baseConfigPath: this.config.generation.openevolveConfigPath
          ?? resolve(REPO_ROOT, 'ai5/openevolve/config-ai9.yaml'),
        brief,
        outPath,
      });
      configPath = written.path;
      briefPath = written.briefPath;
    } catch (error) {
      this._event(state, 'research-brief-config-failed', { reason: String(error.message).slice(0, 300) });
    }
    return {
      plan,
      brief,
      strategies: decision.strategies.length ? decision.strategies : this.config.generation.strategies,
      configPath,
      briefPath,
      hints,
    };
  }

  /** 精英候选 artifact：模块级精英池 + MAP-Elites 单元格（去重、坏引用跳过）。 */
  _eliteArtifacts(state) {
    const ids = new Set();
    for (const entry of state.moduleElites ?? []) ids.add(entry.candidateId);
    for (const entry of Object.values(state.mapElites ?? {})) ids.add(entry.candidateId);
    const artifacts = [];
    for (const id of ids) {
      try {
        const artifact = this.store.get(id);
        if (artifact?.source?.modules?.length > 0) artifacts.push(artifact);
      } catch { /* 精英候选已被清理：跳过，不阻断新一代生成 */ }
    }
    return artifacts;
  }

  _normalizeBatch(result) {
    if (Array.isArray(result)) return { candidates: result, rejectedAtGeneration: [] };
    return {
      candidates: result?.candidates ?? [],
      rejectedAtGeneration: result?.rejectedAtGeneration ?? [],
      generatorMeta: result?.generatorMeta ?? null,
    };
  }

  _generate(state, roundData) {
    const remaining = this.config.budget.maxCandidates - state.budgetUsed.candidates;
    if (remaining <= 0) {
      roundData.generated = true;
      state.status = 'budget-exhausted';
      this._event(state, 'budget-exhausted', { stage: 'generation', remaining });
      return;
    }
    const count = Math.min(this.config.generation.count, remaining);
    const multiModule = this.config.generation.mode === 'multi-module';
    const experiment = this._experimentFor(state, roundData);
    const parentArtifact = this._parentArtifact(state, roundData);
    const generationParentSource = this._parentSource ?? (parentArtifact ? 'explicit' : 'bootstrap');
    if (multiModule && this.config.generation.allowInheritance !== false) {
      assertCondition(roundData.round === 1 || parentArtifact !== null,
        `第 ${roundData.round} 轮没有可继承的父代——拒绝无谱系进化`);
      this._event(state, 'generation-parent-selected', {
        round: roundData.round,
        parentCandidateId: parentArtifact?.candidateId ?? null,
        parentSourceHash: parentArtifact?.sourceHash ?? null,
        parentSource: generationParentSource,
      });
    }
    const hints = state.rounds.length > 1
      ? state.rounds[state.rounds.length - 2]?.diagnostics?.researchHints ?? null
      : null;
    const researchContext = this.config.generation.researchContext ?? 'brief';
    const researchPlan = multiModule && researchContext !== 'off'
      ? this._researchPlan(state, roundData, parentArtifact, hints, { injectConfig: researchContext === 'brief' })
      : null;
    const generationConfig = researchPlan
      ? {
        ...this.config.generation,
        strategies: researchPlan.strategies,
        openevolveConfigPath: researchPlan.configPath,
        openevolveBriefPath: researchPlan.briefPath,
      }
      : this.config.generation;
    if (researchPlan) {
      roundData.researchPlan = researchPlan.plan;
      roundData.researchBrief = {
        contextHash: researchPlan.brief.contextHash,
        briefHash: researchPlan.brief.contentHash,
        hypotheses: researchPlan.brief.hypotheses.map(h => h.id),
        failures: researchPlan.brief.failures,
      };
      this._event(state, 'research-plan-decided', {
        round: roundData.round,
        decision: researchPlan.plan.decision,
        reason: researchPlan.plan.reason,
        targetIds: researchPlan.plan.targetIds,
        strategies: researchPlan.plan.strategies,
        contextHash: researchPlan.brief.contextHash,
        configPath: researchPlan.configPath ?? null,
      });
    }
    const targetIds = researchPlan?.plan?.targetIds?.length
      ? researchPlan.plan.targetIds
      : this.config.generation.targetIds;
    const generator = this.generator ?? (multiModule
      ? (options) => generateMultiModuleBatch({
          ...options,
          moduleConfig: generationConfig,
          eliteArtifacts: this._eliteArtifacts(state),
          mapElites: state.mapElites,
        })
      : (options) => generateCandidateBatch(options));
    const batch = this._normalizeBatch(generator({
      count, round: roundData.round, seed: this.config.generation.seed + roundData.round,
      experiment, parentArtifact, targetIds, hints,
    }));
    if (batch.generatorMeta) roundData.generatorMeta = batch.generatorMeta;
    if (batch.rejectedAtGeneration?.length) {
      state.generationDiagnostics.push({
        round: roundData.round,
        at: nowIso(),
        rejected: batch.rejectedAtGeneration,
      });
    }
    for (const rejected of batch.rejectedAtGeneration) {
      roundData.rejectedAtGeneration.push(rejected);
      this._event(state, 'candidate-rejected-at-generation', rejected);
    }
    for (const item of batch.candidates) {
      const artifact = item.artifact;
      assertCondition(artifact, '生成器返回的候选缺少 artifact');
      // 对照基线（官方模块）不是"进化代"，不要求谱系；其余候选必须可追溯父代源码。
      // 单个候选的谱系缺陷只拒绝该候选，不中断整个 campaign；
      // 父代 artifact 本身缺失/哈希不符仍由 _parentArtifact 抛错中止（那是全局完整性）。
      if (multiModule && !artifact.lineage) {
        assertCondition(item.strategy === 'control',
          `候选 ${artifact.candidateId} 缺少 lineage（拒绝未登记谱系的候选）`);
        assertCondition(artifact.parentId === null, '对照基线候选不得声明父代');
      } else if (multiModule) {
        // crossover/ablation 的真实父代是捐赠精英（可能不是本轮主父代），
        // 谱系必须按 artifact 自己声明的 parentId 去 store 取回并核验，
        // 不能拿"本轮父代"去否定合法的组合候选。
        let lineageParent = parentArtifact;
        if (artifact.parentId && artifact.parentId !== parentArtifact?.candidateId) {
          lineageParent = this.store.get(artifact.parentId);
          this._assertParentIntegrity(lineageParent, artifact.parentId);
        }
        try {
          this._verifyLineage({ artifact, parentArtifact: lineageParent, round: roundData.round });
        } catch (error) {
          const rejection = { candidateId: artifact.candidateId, strategy: item.strategy ?? null, stage: 'lineage-rejected', reason: error.message };
          roundData.candidates.push({ ...rejection, stage: 'lineage-rejected', failure: { stage: 'lineage', reason: error.message } });
          roundData.rejectedAtGeneration.push({ strategy: item.strategy ?? null, reason: error.message });
          this._event(state, 'candidate-lineage-rejected', rejection, artifact.candidateId);
          continue;
        }
      }
      const put = this.store.put(artifact);
      this.research.candidate({
        artifact,
        strategy: item.strategy ?? null,
        generator: item.generator ?? artifact.lineage?.operator ?? null,
        experiment: { configRef: this.config.configRef, round: roundData.round },
        hypothesisId: artifact.lineage?.hypothesisId ?? null,
        llm: artifact.lineage?.llm ?? null,
      });
      if (artifact.lineage) {
        this.research.lineage({ candidateId: artifact.candidateId, lineage: artifact.lineage });
      }
      state.budgetUsed.candidates += 1;
      roundData.candidates.push({
        candidateId: artifact.candidateId,
        parentId: artifact.parentId,
        identityDigest: artifact.identityDigest,
        strategy: item.strategy ?? null,
        modules: artifact.source?.modules?.map(m => m.id) ?? null,
        lineage: artifact.lineage ? {
          parentCandidateId: artifact.lineage.parentCandidateId,
          parentSourceHash: artifact.lineage.parentSourceHash,
          inputProgramHash: artifact.lineage.inputProgramHash,
          outputProgramHash: artifact.lineage.outputProgramHash,
          modulesChanged: artifact.lineage.modulesChanged,
          operator: artifact.lineage.operator,
          llm: artifact.lineage.llm,
        } : null,
        evaluationMode: artifact.algorithmStructure.evaluationMode,
        targetIds: [...artifact.algorithmStructure.targetIds],
        artifactPath: portablePath(put.path),
        stage: 'created',
        safetyStatus: artifact.safety.status,
        sourceHash: artifact.sourceHash,
        buildArtifactHash: artifact.buildArtifact.sha256,
        buildKind: artifact.buildArtifact.kind,
        generator: item.generator ?? null,
        generatorMeta: item.generatorMeta ?? null,
        evidenceDir: null,
        quick: null,
        deep: null,
        failure: null,
      });
      this._event(state, 'candidate-generated', {
        identityDigest: artifact.identityDigest,
        evaluationMode: artifact.algorithmStructure.evaluationMode,
        targetIds: artifact.algorithmStructure.targetIds,
        buildKind: artifact.buildArtifact.kind,
        generator: item.generator ?? null,
      }, artifact.candidateId);
    }
    roundData.generated = true;
    state.phase = 'generated';
    this._event(state, 'generation-completed', {
      round: roundData.round,
      count: batch.candidates.length,
      rejected: batch.rejectedAtGeneration.length,
    });
  }

  _candidateState(roundData, candidateId) {
    return roundData.candidates.find(c => c.candidateId === candidateId);
  }

  /** 竞技证据摘要：配对第一名率增量是唯一主指标，其余仅诊断。 */
  _competitiveMetrics(evidence) {
    const metrics = evidence?.metrics ?? {};
    const lower = metrics.firstPlaceDeltaCi?.oneSidedLower
      ?? metrics.firstPlaceDeltaPooledCi?.oneSidedLower
      ?? metrics.firstPlaceDeltaLower ?? null;
    return {
      firstPlaceDelta: Number.isFinite(metrics.firstPlaceDelta) ? Number(metrics.firstPlaceDelta) : null,
      firstPlaceLower: Number.isFinite(lower) ? Number(lower) : null,
      pairs: metrics.pairs ?? null,
      finishedPairs: metrics.finishedPairs ?? null,
      firstPlaceRate: metrics.firstPlaceRate ?? metrics.candidateFirstRate ?? null,
      chanceAdjustedRate: metrics.chanceAdjustedRate ?? null,
      minWilsonLower: metrics.minWilsonLower ?? null,
      anomalyRate: metrics.anomalyRate ?? null,
      finishedGames: metrics.finishedGames ?? null,
      proxyDelta: metrics.proxyDelta ?? null,
      p95WallMs: metrics.p95WallMs ?? null,
    };
  }

  _safetyNext(state, roundData) {
    const item = roundData.candidates.find(c => c.stage === 'created');
    if (!item) return false;
    try {
      const artifact = this.store.get(item.candidateId);
      const safety = runSafetyChecks(artifact);
      const updated = this.store.update(item.candidateId, {
        safety,
        status: safety.status === 'passed' ? 'checked' : 'rejected',
      });
      item.safetyStatus = safety.status;
      item.buildKind = updated.buildArtifact.kind;
      if (safety.status !== 'passed') {
        item.stage = 'safety-failed';
        item.failure = { stage: 'safety', checks: safety.checks.filter(c => c.status === 'fail') };
        this._event(state, 'candidate-safety-failed', item.failure, item.candidateId);
      } else {
        item.stage = 'checked';
        this._event(state, 'candidate-safety-passed', {
          checks: safety.checks.length,
          buildKind: updated.buildArtifact.kind,
          buildCompiled: updated.buildArtifact.compiled,
        }, item.candidateId);
        if (updated.buildArtifact.compiled === true) {
          // 独立编译产物已通过哈希复核；记录可审计的构建身份。
          this._event(state, 'candidate-build-verified', {
            buildKind: updated.buildArtifact.kind,
            compiler: updated.buildArtifact.compiler,
            buildArtifactHash: updated.buildArtifact.sha256,
          }, item.candidateId);
        }
      }
    } catch (error) {
      item.stage = 'safety-failed';
      item.failure = { stage: 'safety-check-error', reason: error.message };
      this._event(state, 'candidate-safety-error', item.failure, item.candidateId);
    }
    return true;
  }

  async _quickNext(state, roundData) {
    const item = roundData.candidates.find(c => c.stage === 'checked');
    if (!item) return false;
    const evidenceMode = item.evaluationMode;
    const pairedArms = this.config.generation.mode === 'multi-module' ? 2 : 1;
    const games = expectedGames({ evidenceMode, seeds: roundData.screenSeeds, playerCounts: this.config.playerCounts, pairedArms });
    if (state.budgetUsed.games + games > this.config.budget.maxGames) {
      item.stage = 'budget-skipped';
      item.failure = { stage: 'quick-eval', reason: `game budget exceeded (${state.budgetUsed.games}+${games}>${this.config.budget.maxGames})` };
      state.status = 'budget-exhausted';
      this._event(state, 'candidate-budget-skipped', item.failure, item.candidateId);
      return true;
    }
    try {
      const artifact = this.store.get(item.candidateId);
      const evaluator = this.evaluator ?? evaluateCandidate;
      const evidence = await evaluator({
        artifact,
        seeds: roundData.screenSeeds,
        purpose: 'screen',
        round: roundData.round,
        playerCounts: this.config.playerCounts,
        maxMoves: this.config.maxMoves,
        deadlineMs: this.config.deadlineMs,
      });
      const absoluteEvidenceDir = ensureDir(resolve(this.rootDir, 'evidence', item.candidateId));
      const evidenceDir = portablePath(absoluteEvidenceDir);
      const absoluteEvidencePath = resolve(absoluteEvidenceDir, `quick-r${String(roundData.round).padStart(3, '0')}.json`);
      const evidencePath = portablePath(absoluteEvidencePath);
      writeJSON(absoluteEvidencePath, evidence);
      const score = scoreCandidate({ artifact, evidence });
      const updated = this.store.update(item.candidateId, {
        evidenceDir,
        status: 'evaluated',
      });
      item.evidenceDir = evidenceDir;
      item.quick = {
        evidencePath, evidenceType: evidence.metrics.evidenceType,
        score, games: evidence.metrics.totalGames,
        metrics: this._competitiveMetrics(evidence),
        artifactHash: updated.artifactHash,
      };
      item.stage = 'quick-done';
      item.safetyStatus = updated.safety.status;
      state.budgetUsed.games += Number(evidence.metrics.totalGames ?? 0);
      this._event(state, 'candidate-quick-evaluated', {
        evidencePath, score: score.composite, metrics: item.quick.metrics,
      }, item.candidateId);
      this.research.evaluation({
        candidateId: item.candidateId, stage: 'quick', evidence,
        metrics: item.quick.metrics, seedWindow: evidence.seedWindow ?? null,
      });
    } catch (error) {
      item.stage = 'quick-failed';
      item.failure = { stage: 'quick-eval', reason: error.message.slice(0, 500) };
      this._event(state, 'candidate-quick-failed', item.failure, item.candidateId);
    }
    return true;
  }

  _select(state, roundData) {
    const finished = roundData.candidates.filter(c => c.stage === 'quick-done');
    if (finished.length === 0) {
      roundData.selected = true;
      roundData.selectionSummary = { evaluated: 0, selected: 0, note: 'no candidate passed quick evaluation' };
      this._event(state, 'selection-empty', roundData.selectionSummary);
      return;
    }
    const entries = finished.map(item => {
      const artifact = this.store.get(item.candidateId);
      const evidence = readJSON(resolvePortable(item.quick.evidencePath));
      return { artifact, evidence, candidateId: item.candidateId };
    });
    const selection = selectCandidates({
      entries, maxKeep: this.config.retainTopK, minBehaviorDistance: 0.12,
    });
    for (const selected of selection.selected) {
      const item = this._candidateState(roundData, selected.artifact.candidateId);
      item.stage = 'selected';
      item.quick.score = selected.score;
      roundData.selectedIds.push(item.candidateId);
      this.store.update(item.candidateId, { status: 'selected' });
    }
    const selectedSet = new Set(selection.selected.map(s => s.artifact.candidateId));
    const rejectionReasons = new Map([
      ...selection.rejected.map(r => [r.candidateId, r.reason]),
      ...selection.duplicates.map(r => [r.candidateId, r.reason]),
    ]);
    for (const item of roundData.candidates) {
      if (item.stage !== 'quick-done' || selectedSet.has(item.candidateId)) continue;
      item.stage = 'not-selected';
      item.failure = { stage: 'selection', reason: rejectionReasons.get(item.candidateId) ?? 'below-retention-cutoff' };
      this.store.update(item.candidateId, { status: 'archived' });
    }
    roundData.selected = true;
    roundData.selectionSummary = selection.summary;
    this._event(state, 'selection-completed', selection.summary);
  }

  async _deepNext(state, roundData) {
    const pending = roundData.selectedIds
      .map(id => this._candidateState(roundData, id))
      .filter(item => item && item.evaluationMode === 'game' && item.stage === 'selected');
    const confirmedSoFar = roundData.candidates.filter(c => c.deep && c.deep.status === 'done').length;
    if (confirmedSoFar >= Math.min(this.config.deepConfirmations, this.config.budget.maxDeepConfirmations)) {
      roundData.deepDone = true;
      this._event(state, 'deep-confirm-skipped', { reason: 'deep confirmation quota reached', confirmedSoFar });
      return true;
    }
    if (pending.length === 0) {
      roundData.deepDone = true;
      this._event(state, 'deep-confirm-completed', { confirmed: confirmedSoFar, note: 'no pending game candidate' });
      return true;
    }
    const item = pending.sort((a, b) => (b.quick?.score?.composite ?? 0) - (a.quick?.score?.composite ?? 0))[0];
    const pairedArms = this.config.generation.mode === 'multi-module' ? 2 : 1;
    const games = expectedGames({ evidenceMode: 'game', seeds: roundData.deepSeeds, playerCounts: this.config.playerCounts, pairedArms });
    if (state.budgetUsed.games + games > this.config.budget.maxGames) {
      item.stage = 'deep-skipped';
      item.failure = { stage: 'deep-confirm', reason: 'game budget exhausted' };
      state.status = 'budget-exhausted';
      this._event(state, 'candidate-deep-budget-skipped', item.failure, item.candidateId);
      return true;
    }
    if (state.budgetUsed.deepConfirmations >= this.config.budget.maxDeepConfirmations) {
      // 深验配额是「本 campaign 不再做深验」的资源上限，不是全局终止条件：
      // 继续下一轮生成/快筛/筛选，但不再消耗深验预算，避免长 campaign 在第 4 次
      // 深验后误判为 budget-exhausted（12h 压力测试首次运行即因此提前停止）。
      item.stage = 'deep-quota-skipped';
      item.failure = { stage: 'deep-confirm', reason: 'deep confirmation quota reached' };
      this._event(state, 'candidate-deep-quota-skipped', item.failure, item.candidateId);
      roundData.deepDone = true;
      return true;
    }
    try {
      const artifact = this.store.get(item.candidateId);
      const evaluator = this.evaluator ?? evaluateCandidate;
      const evidence = await evaluator({
        artifact,
        seeds: roundData.deepSeeds,
        purpose: 'deep',
        round: roundData.round,
        playerCounts: this.config.playerCounts,
        maxMoves: this.config.maxMoves,
        deadlineMs: this.config.deadlineMs,
      });
      const absoluteEvidenceDir = resolvePortable(item.evidenceDir);
      const absoluteEvidencePath = resolve(absoluteEvidenceDir, `deep-r${String(roundData.round).padStart(3, '0')}.json`);
      const evidencePath = portablePath(absoluteEvidencePath);
      writeJSON(absoluteEvidencePath, evidence);
      const score = scoreCandidate({ artifact, evidence });
      const anomalyRate = evidence.metrics.anomalyRate ?? 1;
      const finishedGames = evidence.metrics.finishedGames ?? 0;
      const deepMetrics = this._competitiveMetrics(evidence);
      state.budgetUsed.games += Number(evidence.metrics.totalGames ?? 0);
      state.budgetUsed.deepConfirmations += 1;
      if (anomalyRate > DEEP_MAX_ANOMALY_RATE || finishedGames === 0) {
        // 快筛优秀但深验不稳定：拒绝进入正式挑战待审批请求（不污染其他候选）。
        item.deep = {
          status: 'unstable', evidencePath,
          score, games: evidence.metrics.totalGames,
          metrics: deepMetrics,
          reason: `deep anomalyRate=${anomalyRate} > ${DEEP_MAX_ANOMALY_RATE} or no finished game`,
        };
        item.stage = 'deep-unstable';
        this.research.failureCase({
          candidateId: item.candidateId, stage: 'deep-confirm', category: 'unstable-evaluation',
          status: 'inconclusive', detail: item.deep.reason, evidencePath,
        });
        this._event(state, 'candidate-deep-unstable', {
          evidencePath, score: score.composite, metrics: deepMetrics, reason: item.deep.reason,
        }, item.candidateId);
      } else {
        item.deep = {
          status: 'done', evidencePath,
          score, games: evidence.metrics.totalGames,
          metrics: deepMetrics,
        };
        item.stage = 'deep-done';
        this.research.evaluation({
          candidateId: item.candidateId, stage: 'deep', evidence,
          metrics: item.deep.metrics, seedWindow: evidence.seedWindow ?? null,
        });
        this._event(state, 'candidate-deep-confirmed', {
          evidencePath, score: score.composite, metrics: item.deep.metrics,
        }, item.candidateId);
        if (this.config.generation.mode === 'multi-module') {
          recordCoEvolutionElite({ state, artifact, evidence, item, strategy: item.strategy ?? null });
          this._event(state, 'coevolution-elite-recorded', {
            candidateId: artifact.candidateId,
            modules: artifact.source?.modules?.map(m => m.id) ?? [],
            mapElites: Object.keys(state.mapElites ?? {}),
            moduleElites: (state.moduleElites ?? []).map(e => e.moduleId),
          }, item.candidateId);
        }
      }
    } catch (error) {
      item.stage = 'deep-failed';
      item.failure = { stage: 'deep-confirm', reason: error.message.slice(0, 500) };
      this._event(state, 'candidate-deep-failed', item.failure, item.candidateId);
    }
    const remaining = roundData.candidates.filter(c => c.evaluationMode === 'game' && c.stage === 'selected').length;
    if (remaining === 0 || state.budgetUsed.deepConfirmations >= this.config.budget.maxDeepConfirmations) {
      roundData.deepDone = true;
      this._event(state, 'deep-confirm-completed', {
        confirmed: roundData.candidates.filter(c => c.deep?.status === 'done').length,
      });
    }
    return true;
  }

  async _approval(state, roundData) {
    const confirmed = roundData.candidates
      .filter(c => c.stage === 'deep-done' && c.deep?.status === 'done')
      .sort((a, b) => rankOfDeep(b) - rankOfDeep(a));
    if (confirmed.length === 0) {
      roundData.approvalDone = true;
      this._event(state, 'approval-request-skipped', { reason: 'no deep-confirmed game candidate' });
      return;
    }
    const item = confirmed[0];
    const artifact = this.store.get(item.candidateId);
    // 多模块协同进化：P0.3 正式挑战资格 ≠ 研究保留资格。只有满足预注册最小有意义效应、
    // 非对照基线、且配对样本量足够的候选才允许进入正式挑战队列；
    // 其余一律标记 research-retained，保留 artifact/证据但不消费验证资源。
    // AI7 descriptor 模式没有配对第一名率证据，保留原有 composite 语义（不影响新路径）。
    const pairedMode = this.config.generation.mode === 'multi-module';
    const eligibility = pairedMode
      ? challengeEligibility({
          item, minPairs: CHALLENGE_MIN_PAIRS, minEffect: CHALLENGE_MIN_EFFECT, minLower: CHALLENGE_MIN_LOWER,
        })
      : { eligible: true, reason: null, mode: 'descriptor-legacy' };
    if (!eligibility.eligible) {
      item.stage = 'research-retained';
      item.failure = { stage: 'challenge-eligibility', reason: eligibility.reason };
      this.store.update(item.candidateId, { status: 'archived' });
      roundData.approvalDone = true;
      this.research.failureCase({
        candidateId: item.candidateId, stage: 'challenge-eligibility',
        category: 'insufficient-evidence', status: 'weakened', detail: eligibility.reason,
        evidencePath: item.deep?.evidencePath ?? null,
      });
      this._event(state, 'candidate-research-retained', {
        candidateId: item.candidateId,
        reason: eligibility.reason,
        eligibility,
        metrics: item.deep?.metrics ?? null,
      }, item.candidateId);
      return;
    }
    const deepDelta = item.deep?.metrics?.firstPlaceDelta ?? null;
    const deepVerdict = !pairedMode
      ? (() => {
          const chanceAdjusted = item.deep?.metrics?.chanceAdjustedRate ?? null;
          return chanceAdjusted === null ? 'inconclusive'
            : chanceAdjusted > 0.05 ? 'promising' : chanceAdjusted < -0.05 ? 'no-advantage' : 'inconclusive';
        })()
      : (deepDelta === null ? 'inconclusive'
        : deepDelta >= CHALLENGE_MIN_EFFECT ? 'promising' : deepDelta > 0 ? 'weak-positive' : 'no-advantage');
    const request = this.governance.requestFormalChallengeApproval({
      campaignId: this.campaignId,
      candidateId: item.candidateId,
      identityDigest: item.identityDigest,
      evidenceDir: item.evidenceDir,
      summary: {
        artifactHash: artifact.artifactHash,
        sourceHash: artifact.sourceHash,
        buildArtifactHash: artifact.buildArtifact.sha256,
        quick: item.quick,
        deep: item.deep,
        deepAssessment: {
          verdict: deepVerdict,
          pairedFirstPlaceDelta: deepDelta,
          pairedFirstPlaceLower: item.deep?.metrics?.firstPlaceLower ?? null,
          pairs: item.deep?.metrics?.pairs ?? null,
          anomalyRate: item.deep?.metrics?.anomalyRate ?? null,
          eligibility,
          note: '小样本深验只用于机器门禁前的排序；正式判定必须使用预注册第一名率挑战',
        },
        recommendation: 'queue-formal-challenge (paired first-place evidence)',
        validationPoolConsumed: false,
        promotionTriggered: false,
      },
    });
    const machineGate = request.status === 'queued-machine-gate';
    const dirName = machineGate ? 'promotion-queue' : 'pending-approval';
    const absoluteRequestPath = resolve(ensureDir(resolve(this.rootDir, dirName)), `${request.requestId}.json`);
    const requestPath = portablePath(absoluteRequestPath);
    writeJSON(absoluteRequestPath, request);
    if (machineGate) {
      state.promotionQueue.push({ ...request, requestPath });
      item.stage = 'promotion-queued';
      item.promotionRequest = { requestId: request.requestId, requestPath, status: request.status };
      this.store.update(item.candidateId, { status: 'promotion-queued' });
      this._event(state, 'promotion-request-queued', {
        requestId: request.requestId, requestPath, gates: request.gates,
      }, item.candidateId);
      if (this.promotionHandler) {
        try {
          const outcome = await this.promotionHandler({
            campaignId: this.campaignId, artifact, request, requestPath,
          });
          state.promotionOutcomes.push({ requestId: request.requestId, at: nowIso(), outcome });
          this.research.formalChallenge({
            candidateId: item.candidateId, requestId: request.requestId,
            planId: request.planId ?? null, challengeIndex: request.challengeIndex ?? null,
            verdict: outcome?.verdict ?? 'unknown', reason: outcome?.reason ?? null,
            evidenceHash: outcome?.evidenceHash ?? null,
          });
          this._event(state, 'promotion-handler-completed', {
            requestId: request.requestId, verdict: outcome?.verdict ?? 'unknown',
          }, item.candidateId);
        } catch (error) {
          state.promotionOutcomes.push({
            requestId: request.requestId, at: nowIso(),
            outcome: { verdict: 'ERROR', reason: String(error.message).slice(0, 500) },
          });
          this.research.formalChallenge({
            candidateId: item.candidateId, requestId: request.requestId,
            verdict: 'ERROR', reason: String(error.message).slice(0, 500),
          });
          this._event(state, 'promotion-handler-failed', {
            requestId: request.requestId, reason: String(error.message).slice(0, 500),
          }, item.candidateId);
        }
      }
    } else {
      state.pendingApprovals.push({ ...request, requestPath });
      item.stage = 'pending-approval';
      this.store.update(item.candidateId, { status: 'pending-approval' });
      this._event(state, 'approval-request-created', {
        requestId: request.requestId, requestPath, status: request.status,
        promotionTriggered: request.promotionTriggered,
      }, item.candidateId);
    }
    roundData.approvalDone = true;
  }

  _loadDiagnostics(roundData) {
    const collections = [];
    const paths = [];
    const resolveRepoPath = p => p ? resolve(REPO_ROOT, p) : null;
    const diagnosticsPath = resolveRepoPath(this.config.diagnosticsPath);
    if (diagnosticsPath && existsSync(diagnosticsPath)) {
      collections.push(labelsFromDiagnosticsAnalysis(readJSON(diagnosticsPath)));
      paths.push(portablePath(diagnosticsPath));
    }
    const humanPath = resolveRepoPath(this.config.humanAnalyticsFailuresPath);
    if (humanPath && existsSync(humanPath)) {
      collections.push(labelsFromHumanAnalytics(readJSON(humanPath)));
      paths.push(portablePath(humanPath));
    }
    if (collections.length === 0) {
      return { labels: [], paths: [], note: 'no public diagnostics file available', researchHints: toResearchHints({ labels: [] }) };
    }
    const merged = mergeLabels(collections);
    return {
      ...merged,
      paths,
      researchHints: toResearchHints(merged),
      discipline: '失败标签只用于研究提示/课程配置，不修改奖励真值',
    };
  }

  _diagnostics(state, roundData) {
    const diagnostics = this._loadDiagnostics(roundData);
    const dir = ensureDir(resolve(this.rootDir, 'diagnostics'));
    // P1.3：对深验最优候选做配对失败归因（只看公开对局明细，不用隐藏信息）。
    const confirmed = roundData.candidates
      .filter(c => c.deep?.status === 'done' && c.deep?.evidencePath)
      .sort((a, b) => (b.deep.metrics.firstPlaceLower ?? -9) - (a.deep.metrics.firstPlaceLower ?? -9));
    let diagnosis = null;
    if (confirmed.length) {
      const item = confirmed[0];
      try {
        const evidence = readJSON(resolvePortable(item.deep.evidencePath));
        const result = diagnosePairedEvidence({ evidence, candidateId: item.candidateId });
        diagnosis = { ...result.summary, evidencePath: item.deep.evidencePath };
        writeJSON(resolve(dir, `failure-diagnosis-r${String(roundData.round).padStart(3, '0')}.json`), diagnosis);
        for (const failureCase of result.summary.failureCases) {
          this.memory.recordFailure({
            candidateId: item.candidateId,
            seatCount: failureCase.seatCount,
            phase: null,
            category: failureCase.category,
            detail: failureCase.detail,
            status: failureCase.status,
            reproducible: failureCase.reproducible,
          });
          this.research.failureCase({
            candidateId: item.candidateId, stage: 'diagnosis',
            category: failureCase.category, status: failureCase.status,
            detail: failureCase.detail, evidencePath: item.deep.evidencePath,
          });
        }
        this._event(state, 'failure-diagnosis-completed', {
          candidateId: item.candidateId,
          pairs: diagnosis.pairs,
          actionDivergedPairs: diagnosis.actionDivergedPairs,
          failureCases: diagnosis.failureCases.length,
        }, item.candidateId);
      } catch (error) {
        this._event(state, 'failure-diagnosis-failed', {
          candidateId: item.candidateId, reason: String(error.message).slice(0, 300),
        }, item.candidateId);
      }
    }
    writeJSON(resolve(dir, `failure-labels-r${String(roundData.round).padStart(3, '0')}.json`), diagnostics);
    writeJSON(resolve(dir, `research-hints-r${String(roundData.round).padStart(3, '0')}.json`), diagnostics.researchHints);
    roundData.diagnostics = { ...diagnostics, diagnosis };
    roundData.diagnosticsDone = true;
    this._event(state, 'failure-diagnostics-completed', {
      paths: diagnostics.paths,
      labels: diagnostics.labels?.filter(l => l.status !== 'absent').map(l => ({ code: l.code, status: l.status, occurrences: l.occurrences })) ?? [],
      suggestedTargets: diagnostics.researchHints?.suggestedTargets ?? [],
      diagnosis: diagnosis ? { pairs: diagnosis.pairs, failureCases: diagnosis.failureCases.length } : null,
    });
  }

  _budgetExhausted(state) {
    if (state.status === 'budget-exhausted') return true;
    if (state.budgetUsed.wallMs > this.config.budget.maxWallMs) return true;
    return false;
  }

  _done(state) {
    const roundData = this._currentRound(state);
    if (!roundData) return true;
    return roundData.generated && roundData.selected && roundData.deepDone
      && roundData.approvalDone && roundData.diagnosticsDone
      && state.currentRoundIndex + 1 >= this.config.rounds;
  }

  async _step(state) {
    const roundData = this._currentRound(state);
    if (!roundData.generated) return this._generate(state, roundData);
    if (roundData.candidates.some(c => c.stage === 'created')) return this._safetyNext(state, roundData);
    if (roundData.candidates.some(c => c.stage === 'checked')) return this._quickNext(state, roundData);
    if (!roundData.selected) return this._select(state, roundData);
    if (!roundData.deepDone) return this._deepNext(state, roundData);
    if (!roundData.approvalDone) return this._approval(state, roundData);
    if (!roundData.diagnosticsDone) return this._diagnostics(state, roundData);
    if (state.currentRoundIndex + 1 < this.config.rounds) {
      this._startRound(state);
      state.phase = 'round-started';
      return;
    }
    state.phase = 'completed';
  }

  async run({ resume = false, maxSteps = null } = {}) {
    this._acquireLock();
    // 新一次 run 清除进程内停止标志；外部 .stop 文件仍在时仍会在循环首步安全停止。
    this._stopRequested = false;
    this._stopReason = null;
    let state;
    try {
      if (existsSync(this.statePath) && !resume) {
        throw new Error(`state 已存在（${this.statePath}）——重复运行保护：请显式 resume 或使用新的 campaign 目录`);
      }
      if (resume) {
        state = readJSON(this.statePath);
        assertCondition(state.schema === SCHEMAS.campaign, 'state schema 非法');
        assertCondition(state.runFingerprint === this.runFingerprint,
          'state runFingerprint 与当前配置不一致——拒绝恢复（防止重复/错配置运行）');
        const currentCodeVersion = computeCodeVersion();
        // 兼容 codeVersion 引入前启动的长跑 campaign：缺失时允许恢复，但事件显式标记
        // legacy，不把当前代码冒充为历史运行起点；新 campaign 仍然强制摘要一致。
        const legacyCodeVersion = !state.codeVersion;
        if (!legacyCodeVersion) {
          assertCondition(sameCodeDigest(state.codeVersion, currentCodeVersion),
            'state codeDigest 与当前代码不一致——拒绝恢复（R09 要求单一可复现代码版本）');
        }
        if (state.status === 'completed') {
          throw new Error('campaign 已完成——重复运行保护（不会再次消费预算/种子）');
        }
        // 事件 append 与 state._save 分两次落盘：若上次进程在 append 之后、save 之前退出，
        // state.lastEventSeq 会落后于日志尾部；以日志最大 seq 续接，避免新事件复用旧 seq。
        state.lastEventSeq = Math.max(
          Number(state.lastEventSeq ?? 0), lastLoggedEventSeq(this.logPath),
        );
      } else {
        state = this._initState();
      }
      state.status = 'running';
      // 恢复时清除上一次停止阶段标签，避免 status=running 却仍显示 stopped-by-*。
      state.phase = state.phase === 'initialized' || String(state.phase ?? '').startsWith('stopped')
        ? 'running'
        : state.phase;
      this._save(state);
      this._event(state, resume ? 'campaign-resumed' : 'campaign-started', {
        runFingerprint: this.runFingerprint,
        codeVersion: {
          codeDigest: state.codeVersion?.codeDigest ?? null,
          headCommit: state.codeVersion?.headCommit ?? null,
          webBuildCommit: state.codeVersion?.webBuild?.gitCommit ?? null,
          legacy: Boolean(resume && !state.codeVersion),
        },
        maxSteps,
      });
      const started = performance.now();
      let steps = 0;
      while (!this._done(state)) {
        if (maxSteps !== null && steps >= maxSteps) {
          state.status = 'stopped';
          state.phase = 'stopped-by-max-steps';
          this._event(state, 'campaign-stopped', { reason: 'max-steps', steps });
          break;
        }
        if (this._stopRequestedNow()) {
          state.status = 'stopped';
          state.phase = 'stopped-by-operator';
          this._event(state, 'campaign-stopped', { reason: this._stopReason ?? 'operator-request', steps });
          break;
        }
        if (this._budgetExhausted(state)) {
          state.status = 'budget-exhausted';
          state.phase = 'stopped-by-budget';
          this._event(state, 'campaign-budget-exhausted', { budgetUsed: state.budgetUsed, steps });
          break;
        }
        const stepStart = performance.now();
        try {
          await this._step(state);
        } catch (error) {
          state.status = 'failed';
          state.phase = 'controller-error';
          state.lastError = { message: error.message, at: nowIso() };
          this._event(state, 'campaign-failed', { message: error.message });
          this._save(state);
          throw error;
        }
        state.budgetUsed.wallMs += Math.round(performance.now() - stepStart);
        steps += 1;
        this._save(state);
      }
      if (this._done(state)) {
        state.status = 'completed';
        state.phase = 'completed';
        this.governance.recordCampaignOutcome({
          campaignId: this.campaignId,
          runFingerprint: this.runFingerprint,
          status: 'completed',
          budgetUsed: state.budgetUsed,
          pendingApprovals: state.pendingApprovals.map(p => p.requestId),
        });
        this._event(state, 'campaign-completed', { budgetUsed: state.budgetUsed });
      }
      this._save(state);
      const results = this.readResults(state);
      writeJSON(resolve(this.rootDir, 'results.json'), results);
      return results;
    } finally {
      if (existsSync(this.stopPath)) {
        try { unlinkSync(this.stopPath); } catch { /* 停止标志已被清理 */ }
      }
      this._releaseLock();
    }
  }

  /** 读取结果（断点重启后也可直接调用）。 */
  readResults(state = null) {
    const current = state ?? (existsSync(this.statePath) ? readJSON(this.statePath) : null);
    assertCondition(current, '没有可读取的 campaign state');
    return deepFreeze({
      schema: 'century-evolution-campaign-results-v1',
      campaignId: current.campaignId,
      runFingerprint: current.runFingerprint,
      status: current.status,
      phase: current.phase,
      checkpointSeq: current.checkpointSeq,
      budget: current.config.budget,
      budgetUsed: current.budgetUsed,
      guardrails: current.guardrails,
      rounds: current.rounds.map(round => ({
        round: round.round,
        seedWindows: round.seedWindows,
        seeds: { screen: round.screenSeeds, deep: round.deepSeeds },
        generated: round.generated,
        generatorMeta: round.generatorMeta ?? null,
        selection: round.selectionSummary,
        rejectedAtGeneration: round.rejectedAtGeneration,
        diagnostics: round.diagnostics ? {
          paths: round.diagnostics.paths,
          labels: round.diagnostics.labels,
          researchHints: round.diagnostics.researchHints,
        } : null,
        candidates: round.candidates.map(c => ({
          candidateId: c.candidateId,
          parentId: c.parentId ?? null,
          identityDigest: c.identityDigest,
          strategy: c.strategy ?? null,
          modules: c.modules ?? null,
          lineage: c.lineage ?? null,
          evaluationMode: c.evaluationMode,
          targetIds: c.targetIds,
          stage: c.stage,
          safetyStatus: c.safetyStatus,
          buildKind: c.buildKind,
          buildArtifactHash: c.buildArtifactHash,
          sourceHash: c.sourceHash,
          generator: c.generator ?? null,
          generatorMeta: c.generatorMeta ?? null,
          evidenceDir: c.evidenceDir,
          quick: c.quick,
          deep: c.deep,
          failure: c.failure,
        })),
      })),
      pendingApprovals: current.pendingApprovals,
      promotionQueue: current.promotionQueue ?? [],
      promotionOutcomes: current.promotionOutcomes ?? [],
      moduleElites: current.moduleElites ?? [],
      mapElites: current.mapElites ?? {},
      generationDiagnostics: current.generationDiagnostics ?? [],
      note: 'autonomous 模式：正式挑战请求进入机器门禁队列；人工审批已被机器门禁取代，门禁本身不删除',
    });
  }
}
