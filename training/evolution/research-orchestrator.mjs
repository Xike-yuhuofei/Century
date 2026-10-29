/** P1.1：Research Orchestrator（研究控制层）。
 *
 * Observation → Hypothesis → Intervention → Experiment → Evaluation → Decision
 *
 * 职责边界：
 * - 只决定"下一步研究什么"（方向/模块/策略/预算），不替代 OpenEvolve 的种群搜索；
 * - 决策必须基于**已有实验证据**与研究记忆，不得凭 LLM 文本或单次输赢；
 * - 每轮输出 ResearchBrief（结构化假设 + 可证伪预测），供 LLM 提示通道使用；
 * - 被否定的方向不删除，记录在 memory 中避免重复；
 * - 预算分配以"每单位成本可独立复现的改进"为目标，而不是最大 LLM 调用次数。
 */

import { assertCondition, sha256Canonical } from './core.mjs';

export const DECISIONS = Object.freeze([
  'bootstrap', 'explore', 'exploit-weakness', 'replicate', 'ablate', 'switch-direction', 'pause',
]);

/**
 * 归一化最近若干轮的配对第一名率证据。
 *
 * @param {Array<{round:number, delta:number|null, lower:number|null, pairs:number|null}>} history
 */
export function summarizeTrend(history) {
  const usable = (history ?? []).filter(h => Number.isFinite(h.delta));
  if (!usable.length) return { rounds: 0, meanDelta: null, bestDelta: null, stagnantRounds: 0, decliningRounds: 0 };
  const meanDelta = usable.reduce((s, h) => s + h.delta, 0) / usable.length;
  const bestDelta = Math.max(...usable.map(h => h.delta));
  let stagnant = 0;
  for (const h of [...usable].reverse()) {
    if (h.delta <= 0) stagnant += 1; else break;
  }
  return {
    rounds: usable.length,
    meanDelta: Number(meanDelta.toFixed(4)),
    bestDelta: Number(bestDelta.toFixed(4)),
    stagnantRounds: stagnant,
    decliningRounds: usable.filter(h => h.delta < 0).length,
  };
}

/**
 * 决策：给定趋势、失败归因、研究记忆与预算，选择下一步研究方向。
 *
 * @param {object} options
 * @param {object} options.trend summarizeTrend 输出
 * @param {object|null} options.diagnosis failure-diagnosis 输出
 * @param {object|null} options.memory { testedHypotheses, positiveModules, recentFailures }
 * @param {string[]} options.modules 全部注册模块
 * @param {object|null} options.budget { remainingCandidates, remainingGames }
 * @param {boolean} [options.hasElites]
 */
export function decideNextResearch({
  trend, diagnosis = null, memory = null, modules, budget = null, hasElites = false,
}) {
  assertCondition(Array.isArray(modules) && modules.length > 0, '需要模块列表');

  const tested = (memory?.testedHypotheses ?? []).filter(h => h.status === 'rejected');
  const stagnating = (trend?.stagnantRounds ?? 0) >= 2;
  const supportedStrata = (diagnosis?.failureCases ?? []).filter(f => f.status === 'supported');
  const weakestModules = supportedStrata.length
    ? [...new Set(supportedStrata.flatMap(() => ['M02', 'M04', 'M06', 'M08']))]
    : null;

  if ((budget?.remainingCandidates ?? 1) <= 0) {
    return {
      decision: 'pause',
      reason: '候选预算耗尽——安全暂停，保留状态等待下一轮',
      targetIds: [],
      strategies: [],
      hypothesisBudget: 0,
    };
  }

  if (!trend || trend.rounds === 0) {
    return {
      decision: 'bootstrap',
      reason: '尚无配对证据：先建立行为基线并覆盖多样机制',
      targetIds: modules,
      strategies: ['single', 'pair', 'multi', 'crossover', 'ablation', 'openevolve'],
      hypothesisBudget: 2,
    };
  }

  if (trend.meanDelta < 0 && supportedStrata.length > 0) {
    return {
      decision: 'exploit-weakness',
      reason: `平均配对增量 ${trend.meanDelta} 为负，且失败归因支持 ${supportedStrata.map(s => `${s.seatCount}p`).join('/')} 弱点`,
      targetIds: weakestModules ?? modules,
      strategies: ['single', 'pair', 'openevolve'],
      hypothesisBudget: 2,
    };
  }

  if (stagnating) {
    const positive = (memory?.positiveModules ?? []);
    if (positive.length) {
      return {
        decision: 'replicate',
        reason: `连续 ${trend.stagnantRounds} 轮无正增益：对已有正向证据模块做独立新种子复验`,
        targetIds: positive.map(p => p.moduleId),
        strategies: ['single', 'pair'],
        hypothesisBudget: 1,
      };
    }
    if (hasElites) {
      return {
        decision: 'ablate',
        reason: `连续 ${trend.stagnantRounds} 轮无正增益：用消融判定哪些模块改动实际有效`,
        targetIds: modules,
        strategies: ['ablation', 'crossover'],
        hypothesisBudget: 1,
      };
    }
    return {
      decision: 'switch-direction',
      reason: `连续 ${trend.stagnantRounds} 轮无正增益且缺少可复验方向：切换模块方向，避开已否决组合`,
      targetIds: modules.filter(id => !tested.some(h => (h.moduleScope ?? []).includes(id))),
      strategies: ['pair', 'multi', 'openevolve'],
      hypothesisBudget: 2,
    };
  }

  return {
    decision: 'explore',
    reason: `平均配对增量 ${trend.meanDelta}，继续在允许模块内做有原则的探索`,
    targetIds: modules,
    strategies: ['single', 'pair', 'multi', 'crossover', 'openevolve'],
    hypothesisBudget: 2,
  };
}

/**
 * 组装一轮研究计划（决策 + brief + 预算 + 可审计输入）。
 *
 * @param {object} options
 * @param {object} options.briefContext 直接传给 buildResearchBrief 的参数
 * @param {object} options.plan decideNextResearch 输出
 * @param {object} [options.degenerated] 额外审计字段
 */
export function composeRoundPlan({ plan, briefContext, extra = null }) {
  const payload = {
    decision: plan.decision,
    reason: plan.reason,
    targetIds: [...(plan.targetIds ?? [])].sort(),
    strategies: [...(plan.strategies ?? [])],
    hypothesisBudget: plan.hypothesisBudget ?? 0,
    briefContext: {
      round: briefContext.round,
      parentCandidateId: briefContext.parentArtifact?.candidateId ?? null,
      memorySummary: briefContext.memory ?? null,
    },
    extra,
  };
  return { ...payload, planHash: sha256Canonical(payload) };
}
