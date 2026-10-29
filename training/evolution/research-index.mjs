/** P0.2：统一实验与谱系证据契约（本地 append-only JSONL 研究索引）。
 *
 * 为什么不重复实现 Program Database：
 * OpenEvolve 原生 Program Database 负责种群/岛屿/检查点；本索引只补充
 * **跨进程可检索的研究证据**：
 *   Candidate → Lineage → Hypothesis → Experiment → EvaluationResult
 *   → FailureCase → FormalChallenge
 * 每条记录带 schema、内容哈希、时间与来源，append-only，不可覆盖。
 *
 * 纪律：
 * - LLM 解释只作为 Hypothesis（待验证），不得写成事实；
 * - 真实 LLM 调用 / 回退来源 / token 用量必须如实记录，未知记为 null；
 * - 正式挑战记录只写"请求/结果"，晋级仍由 CI 机器门禁决定。
 */

import { appendJSONL } from '../lib/io.mjs';
import { sha256Canonical, assertCondition } from './core.mjs';

export const RESEARCH_SCHEMAS = Object.freeze({
  candidate: 'century-research-candidate-v1',
  lineage: 'century-research-lineage-v1',
  hypothesis: 'century-research-hypothesis-v1',
  experiment: 'century-research-experiment-v1',
  evaluation: 'century-research-evaluation-v1',
  failureCase: 'century-research-failure-case-v1',
  formalChallenge: 'century-research-formal-challenge-v1',
});

/** 规范化 LLM 核算信息：任何字段缺失都显式为 null，不猜测。 */
export function normalizeLlmUsage(llm) {
  if (!llm) return null;
  return {
    provider: llm.provider ?? 'codex',
    models: Array.isArray(llm.models) ? llm.models : null,
    calls: Number.isFinite(llm.calls) ? llm.calls : null,
    promptTokens: Number.isFinite(llm.promptTokens) ? llm.promptTokens : null,
    completionTokens: Number.isFinite(llm.completionTokens) ? llm.completionTokens : null,
    totalTokens: Number.isFinite(llm.totalTokens) ? llm.totalTokens : null,
    billing: llm.billing ?? 'unknown',
    fallbackReason: llm.fallbackReason ?? null,
    contextHash: llm.contextHash ?? null,
  };
}

/**
 * 研究索引写入器。
 *
 * @param {object} options
 * @param {string} options.path JSONL 路径（通常是 <campaign>/research-index.jsonl）
 * @param {string} [options.campaignId]
 */
export function createResearchIndex({ path, campaignId = null }) {
  assertCondition(typeof path === 'string' && path.length > 0, 'research index 需要 path');

  function append(kind, payload) {
    const body = {
      schema: RESEARCH_SCHEMAS[kind],
      campaignId,
      at: new Date().toISOString(),
      ...payload,
    };
    const record = { ...body, recordHash: sha256Canonical(body) };
    appendJSONL(path, record);
    return record;
  }

  return {
    path,

    candidate({
      artifact, strategy = null, generator = null, experiment = null, hypothesisId = null,
      llm = null, researchContextHash = null,
    }) {
      assertCondition(artifact?.candidateId, 'candidate 记录缺少 artifact.candidateId');
      assertCondition(researchContextHash === null || /^[0-9a-f]{64}$/.test(String(researchContextHash)),
        `researchContextHash 非法：${String(researchContextHash)}`);
      return append('candidate', {
        candidateId: artifact.candidateId,
        parentId: artifact.parentId ?? null,
        identityDigest: artifact.identityDigest ?? null,
        artifactHash: artifact.artifactHash ?? null,
        sourceHash: artifact.sourceHash ?? null,
        buildArtifactHash: artifact.buildArtifact?.sha256 ?? null,
        modules: artifact.source?.modules?.map(m => m.id) ?? null,
        evaluationMode: artifact.algorithmStructure?.evaluationMode ?? null,
        strategy,
        generator,
        hypothesisId,
        // 该候选生成时模型实际看到的 ResearchBrief 上下文哈希（无简报时为 null）。
        researchContextHash,
        experiment,
        llm: normalizeLlmUsage(llm),
      });
    },

    lineage({ candidateId, lineage }) {
      assertCondition(candidateId, 'lineage 记录缺少 candidateId');
      assertCondition(lineage, 'lineage 记录缺少 lineage 内容');
      return append('lineage', {
        candidateId,
        parentCandidateId: lineage.parentCandidateId ?? null,
        parentSourceHash: lineage.parentSourceHash ?? null,
        inputProgramHash: lineage.inputProgramHash ?? null,
        outputProgramHash: lineage.outputProgramHash ?? null,
        bestProgramHash: lineage.bestProgramHash ?? null,
        modulesChanged: lineage.modulesChanged ?? [],
        operator: lineage.operator ?? null,
        hypothesisId: lineage.hypothesisId ?? null,
        configPath: lineage.configPath ?? null,
        checkpointResumedFrom: lineage.checkpointResumedFrom ?? null,
      });
    },

    hypothesis({ hypothesisId, candidateId = null, statement, mechanisms = [], predictions = [], status = 'untested', evidenceRefs = [] }) {
      assertCondition(typeof statement === 'string' && statement.length > 0, 'hypothesis 缺少 statement');
      assertCondition(Array.isArray(mechanisms) && mechanisms.length >= 2,
        'hypothesis 必须提供至少两个可区分的机制解释');
      return append('hypothesis', {
        hypothesisId,
        candidateId,
        statement,
        mechanisms,
        predictions,
        status,
        evidenceRefs,
      });
    },

    evaluation({ candidateId, stage, evidence, metrics = null, games = null, seedWindow = null }) {
      assertCondition(candidateId, 'evaluation 记录缺少 candidateId');
      return append('evaluation', {
        candidateId,
        stage,
        evidenceHash: evidence ? sha256Canonical(evidence) : null,
        metrics: metrics ?? evidence?.metrics ?? null,
        games: games ?? evidence?.metrics?.totalGames ?? null,
        seedWindow: seedWindow ?? evidence?.seedWindow ?? null,
        // 行为探针哈希：用于区分"源码变化"与"实际行为变化"。
        behaviorHash: evidence?.behaviorHash ?? null,
        pairs: evidence?.metrics?.pairs ?? null,
        firstPlaceDelta: evidence?.metrics?.firstPlaceDelta ?? null,
        anomalyRate: evidence?.metrics?.anomalyRate ?? null,
      });
    },

    failureCase({ candidateId, stage, category, status, detail, evidencePath = null }) {
      assertCondition(['supported', 'weakened', 'rejected', 'inconclusive'].includes(status),
        `failure case 状态非法：${String(status)}`);
      return append('failureCase', {
        candidateId, stage, category, status, detail, evidencePath,
      });
    },

    formalChallenge({ candidateId, requestId = null, planId = null, challengeIndex = null, verdict, reason = null, evidenceHash = null }) {
      return append('formalChallenge', {
        candidateId, requestId, planId, challengeIndex, verdict, reason, evidenceHash,
      });
    },
  };
}
