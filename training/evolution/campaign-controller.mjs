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
  existsSync, openSync, writeSync, closeSync, unlinkSync, readdirSync,
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
import { runSafetyChecks } from './safety-check.mjs';
import { evaluateCandidate, assertIndependentWindows } from './dev-evaluator.mjs';
import { scoreCandidate, selectCandidates } from './selection.mjs';
import {
  labelsFromDiagnosticsAnalysis, labelsFromHumanAnalytics, mergeLabels, toResearchHints,
} from './failure-labels.mjs';

const CAMPAIGN_CONFIG_VERSION = 1;
/** 深验异常率上限：超过则判"深验不稳定"，绝不进入正式挑战待审批请求。 */
const DEEP_MAX_ANOMALY_RATE = 0.2;

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
  generation: { count: 4, seed: 20_261_025, targetIds: null },
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
  assertCondition(Number.isSafeInteger(merged.retainTopK) && merged.retainTopK > 0, 'retainTopK 非法');
  assertCondition(Number.isSafeInteger(merged.deepConfirmations) && merged.deepConfirmations >= 0, 'deepConfirmations 非法');
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

function expectedGames({ evidenceMode, seeds, playerCounts }) {
  return evidenceMode === 'game' ? seeds.length * playerCounts.length : 0;
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
    assertIndependentWindows({ screenSeeds, deepSeeds });
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
    // 显式父候选优先（可指向人工批准的 artifact；身份由 store 校验）。
    if (this.config.parentCandidateId) {
      try {
        return this.store.get(this.config.parentCandidateId);
      } catch (error) {
        throw new Error(`显式父候选不可用：${this.config.parentCandidateId}（${error.message}）`);
      }
    }
    if (roundData.round > 1 && this.config.continueFromSelected) {
      const previous = state.rounds[roundData.round - 2];
      const bestId = previous?.selectedIds?.[0];
      if (bestId) {
        try { return this.store.get(bestId); } catch { /* 父候选不可用时回到基线 */ }
      }
    }
    return null;
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
    const experiment = this._experimentFor(state, roundData);
    const parentArtifact = this._parentArtifact(state, roundData);
    const hints = state.rounds.length > 1
      ? state.rounds[state.rounds.length - 2]?.diagnostics?.researchHints ?? null
      : null;
    const generator = this.generator ?? ((options) => generateCandidateBatch(options));
    const batch = this._normalizeBatch(generator({
      count, round: roundData.round, seed: this.config.generation.seed + roundData.round,
      experiment, parentArtifact, targetIds: this.config.generation.targetIds, hints,
    }));
    if (batch.generatorMeta) roundData.generatorMeta = batch.generatorMeta;
    for (const rejected of batch.rejectedAtGeneration) {
      roundData.rejectedAtGeneration.push(rejected);
      this._event(state, 'candidate-rejected-at-generation', rejected);
    }
    for (const item of batch.candidates) {
      const artifact = item.artifact;
      assertCondition(artifact, '生成器返回的候选缺少 artifact');
      const put = this.store.put(artifact);
      state.budgetUsed.candidates += 1;
      roundData.candidates.push({
        candidateId: artifact.candidateId,
        parentId: artifact.parentId,
        identityDigest: artifact.identityDigest,
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

  _quickNext(state, roundData) {
    const item = roundData.candidates.find(c => c.stage === 'checked');
    if (!item) return false;
    const evidenceMode = item.evaluationMode;
    const games = expectedGames({ evidenceMode, seeds: roundData.screenSeeds, playerCounts: this.config.playerCounts });
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
      const evidence = evaluator({
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
        metrics: {
          firstPlaceRate: evidence.metrics.firstPlaceRate,
          chanceAdjustedRate: evidence.metrics.chanceAdjustedRate,
          minWilsonLower: evidence.metrics.minWilsonLower,
          anomalyRate: evidence.metrics.anomalyRate,
          proxyDelta: evidence.metrics.proxyDelta,
          p95WallMs: evidence.metrics.p95WallMs,
        },
        artifactHash: updated.artifactHash,
      };
      item.stage = 'quick-done';
      item.safetyStatus = updated.safety.status;
      state.budgetUsed.games += Number(evidence.metrics.totalGames ?? 0);
      this._event(state, 'candidate-quick-evaluated', {
        evidencePath, score: score.composite, metrics: item.quick.metrics,
      }, item.candidateId);
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

  _deepNext(state, roundData) {
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
    const games = expectedGames({ evidenceMode: 'game', seeds: roundData.deepSeeds, playerCounts: this.config.playerCounts });
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
      const evidence = evaluator({
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
      const deepMetrics = {
        firstPlaceRate: evidence.metrics.firstPlaceRate,
        chanceAdjustedRate: evidence.metrics.chanceAdjustedRate,
        minWilsonLower: evidence.metrics.minWilsonLower,
        anomalyRate,
        finishedGames,
      };
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
        this._event(state, 'candidate-deep-confirmed', {
          evidencePath, score: score.composite, metrics: item.deep.metrics,
        }, item.candidateId);
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
      .sort((a, b) => (b.deep?.score?.composite ?? 0) - (a.deep?.score?.composite ?? 0));
    if (confirmed.length === 0) {
      roundData.approvalDone = true;
      this._event(state, 'approval-request-skipped', { reason: 'no deep-confirmed game candidate' });
      return;
    }
    const item = confirmed[0];
    const artifact = this.store.get(item.candidateId);
    const chanceAdjusted = item.deep?.metrics?.chanceAdjustedRate ?? null;
    const deepVerdict = chanceAdjusted === null
      ? 'inconclusive'
      : chanceAdjusted > 0.05 ? 'promising' : chanceAdjusted < -0.05 ? 'no-advantage' : 'inconclusive';
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
          chanceAdjustedRate: chanceAdjusted,
          minWilsonLower: item.deep?.metrics?.minWilsonLower ?? null,
          anomalyRate: item.deep?.metrics?.anomalyRate ?? null,
          note: '小样本深验只用于机器门禁前的排序；正式判定必须使用预注册第一名率挑战',
        },
        recommendation: deepVerdict === 'promising' ? 'queue-formal-challenge (positive signal)' : 'queue-formal-challenge (weak/inconclusive signal)',
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
          this._event(state, 'promotion-handler-completed', {
            requestId: request.requestId, verdict: outcome?.verdict ?? 'unknown',
          }, item.candidateId);
        } catch (error) {
          state.promotionOutcomes.push({
            requestId: request.requestId, at: nowIso(),
            outcome: { verdict: 'ERROR', reason: String(error.message).slice(0, 500) },
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
    writeJSON(resolve(dir, `failure-labels-r${String(roundData.round).padStart(3, '0')}.json`), diagnostics);
    writeJSON(resolve(dir, `research-hints-r${String(roundData.round).padStart(3, '0')}.json`), diagnostics.researchHints);
    roundData.diagnostics = diagnostics;
    roundData.diagnosticsDone = true;
    this._event(state, 'failure-diagnostics-completed', {
      paths: diagnostics.paths,
      labels: diagnostics.labels?.filter(l => l.status !== 'absent').map(l => ({ code: l.code, status: l.status, occurrences: l.occurrences })) ?? [],
      suggestedTargets: diagnostics.researchHints?.suggestedTargets ?? [],
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
        if (state.status === 'completed') {
          throw new Error('campaign 已完成——重复运行保护（不会再次消费预算/种子）');
        }
      } else {
        state = this._initState();
      }
      state.status = 'running';
      state.phase = state.phase === 'initialized' ? 'running' : state.phase;
      this._save(state);
      this._event(state, resume ? 'campaign-resumed' : 'campaign-started', {
        runFingerprint: this.runFingerprint, maxSteps,
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
      note: 'autonomous 模式：正式挑战请求进入机器门禁队列；人工审批已被机器门禁取代，门禁本身不删除',
    });
  }
}
