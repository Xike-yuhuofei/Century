#!/usr/bin/env node
/** LLM 决策数据分析、质量审计与蒸馏接口导出。
 *
 * 输入：一个或多个训练运行目录（training/reports/llm-player/<runId>）。
 * 输出（只写派生分析文件，绝不修改原始 JSONL/result.json）：
 * - analysis/analysis.json：质量、分歧、配对结果、统计功效/多重检验；
 * - analysis/training-candidates.jsonl：MLP/PPO 离线训练候选（状态/行动编码）；
 * - analysis/openevolve-diagnosis.jsonl：M01–M12 模块诊断与可复现案例；
 * - analysis/module-signal-matrix.json：12 模块信号覆盖；
 * - analysis/disagreements.jsonl：LLM 与冠军影子决策分歧；
 * - analysis/quality.json、analysis/pairs.jsonl、analysis/analysis.md。
 *
 * 纪律：
 * - LLM 的文字理由不是奖励真值；样本标签只表示“结构有效/待验证/错误/接口异常”；
 * - 胜负只用于终局结果，不倒推单步决策正确性；
 * - 历史 LLM 数据仅供离线模仿学习/诊断，不得当作新鲜 on-policy PPO rollout。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { RunStore } from './store.mjs';
import { GOLEM_BY_ID, MERCHANT_BY_ID } from '../../web-v1/dist/js/data.js';
import {
  encodeState, encodeAction, packF32, STATE_ENCODING_VERSION, ACTION_ENCODING_VERSION,
  STATE_DIM, ACTION_DIM,
} from '../../ai5/ppo/bridge/encode.mjs';
import { actionKey } from '../../web-v1/dist/js/ai/llm/index.js';
import {
  clusterFirstPlacePairs, clusterMeanCI, pooledWeightedDelta,
} from '../evaluator/first-place.mjs';
import { minimumDetectableEffect, requiredSeeds, powerAt } from '../evaluator/power.mjs';
import { wilsonCI } from '../evaluator/stats.mjs';

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valuesOf = flag => {
  const list = [];
  argv.forEach((arg, i) => { if (arg === flag && argv[i + 1]) list.push(argv[i + 1]); });
  return list;
};
const value = (flag, fallback = undefined) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
};
if (has('--help') || has('-h')) {
  console.log(`用法: node training/llm/analyze.mjs --run <runDir> [--run <runDir>...] [--out <analysisDir>]
  --alpha 0.05                 探索性单层 alpha（confirm 默认 0.05/4）
  --power 0.8                  统计功效目标
  --top N                      争议局面/分歧样例上限（默认 20）
  --no-training                不导出训练候选
  --no-openevolve              不导出 OpenEvolve 诊断`);
  process.exit(0);
}

const runPaths = valuesOf('--run');
if (!runPaths.length) throw new Error('至少需要一个 --run <runDir>');
const outRoot = value('--out', null);
const topN = Math.max(1, Number(value('--top', 20)));
const alphaArg = value('--alpha', null);
const powerTarget = Number(value('--power', 0.8));

function openStore(runPath) {
  const absolute = resolve(runPath);
  const root = dirname(absolute);
  const runId = basename(absolute);
  const store = new RunStore({ root, runId });
  return { store, runPath: absolute };
}

function descriptorOf(action) {
  if (!action) throw new Error('缺少行动');
  if (action.type === 'claim') return ['C', action.index];
  if (action.type === 'rest') return ['R'];
  if (action.type === 'acquire') return ['A', action.index, action.payment];
  if (action.type === 'discard') {
    const counts = [0, 0, 0, 0];
    action.colors.forEach(c => { counts[c] += 1; });
    return ['D', counts];
  }
  if (action.type === 'play') {
    const card = MERCHANT_BY_ID[action.cardId];
    if (card?.kind === 'create') return ['P', action.cardId];
    if (card?.kind === 'upgrade') return ['U', action.cardId, action.steps ?? []];
    return ['T', action.cardId, action.repeats ?? 1];
  }
  throw new Error(`未知行动类型：${action.type}`);
}

function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function percentile(values, p) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[index];
}

function hiddenLeakCheck(record) {
  const text = JSON.stringify({
    observation: record.observation,
    candidates: record.candidateSet,
    prompt: record.prompt,
  });
  const patterns = [/merchantDeck/i, /golemDeck/i, /deckOrder/i, /hiddenDeck/i, /futureDeckOrder/i];
  return patterns.filter(pattern => pattern.test(text)).map(pattern => String(pattern));
}

function classifySample(record, result) {
  const flags = {
    llmSource: record.source === 'llm',
    parsed: !!record.parsed,
    reasonPresent: !!record.parsed?.reason,
    primaryGoalPresent: !!record.parsed?.primaryGoal,
    alternativesPresent: (record.parsed?.alternativeActions?.length ?? 0) > 0,
    engineAccepted: record.engineValidation === 'accepted',
    fallback: record.source === 'fallback',
    apiFailure: record.apiFailure === true,
    gameFinished: result?.status === 'finished',
    replayConsistent: result?.replayConsistency?.ok === true,
    shadowAvailable: !!record.championShadow,
    illegalSuggested: (record.attempts ?? []).some(a => /引擎拒绝/.test(a.error ?? '')),
  };
  let label;
  if (flags.fallback) label = 'interface-error';
  else if (!flags.parsed || !flags.engineAccepted || flags.illegalSuggested) label = 'invalid-decision';
  else if (flags.apiFailure) label = 'interface-recovered';
  else if (!flags.gameFinished || !flags.replayConsistent) label = 'pending-verification';
  else if (flags.reasonPresent && flags.primaryGoalPresent && flags.alternativesPresent) label = 'teacher-candidate';
  else label = 'pending-verification';
  return {
    label,
    flags,
    usableForOfflineImitation: label === 'teacher-candidate' || label === 'interface-recovered',
    requiresOfflineValidation: true,
    goldStandard: false,
    note: '标签只描述结构与接口有效性；LLM 理由不构成正确性证明，胜负不倒推单步对错',
  };
}

function outcomeFor(record, result) {
  if (!result || result.status !== 'finished') {
    return { finished: false, firstPlace: null, rank: null, score: null, winnerSeat: null };
  }
  return {
    finished: true,
    firstPlace: result.focusFirst === true,
    rank: result.focusRank,
    score: result.focusScore,
    winnerSeat: result.winnerSeat,
    pairDelta: result.pairId ? null : null,
    arm: result.arm,
  };
}

function moduleMap() {
  const path = resolve('training/evolution/module-registry.json');
  let modules = [];
  try {
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    modules = registry.modules.map(m => ({ id: m.id, name: m.name, label: m.label, functionName: m.functionName }));
  } catch {
    modules = Array.from({ length: 12 }, (_, i) => ({ id: `M${String(i + 1).padStart(2, '0')}`, name: null, label: null }));
  }
  return modules;
}

const MODULE_BY_SIGNAL = {
  goal: ['M01', 'M06'],
  engine: ['M02', 'M03', 'M04'],
  tempo: ['M05', 'M10'],
  contest: ['M07', 'M08'],
  synergy: ['M04', 'M09'],
  capacity: ['M03', 'M10'],
  rest: ['M05'],
  endgame: ['M06', 'M12'],
  risk: ['M10', 'M11'],
};
const MODULE_BY_ACTION = {
  claim: ['M01', 'M06'], acquire: ['M02', 'M03'], 'play-create': ['M02', 'M04'],
  'play-upgrade': ['M04', 'M09'], 'play-trade': ['M02', 'M04'],
  rest: ['M05'], discard: ['M03'],
};

function involvedModules(record) {
  const ids = new Set();
  for (const tag of record.parsed?.strategyTags ?? []) {
    for (const id of MODULE_BY_SIGNAL[tag] ?? []) ids.add(id);
  }
  const kind = record.proposedAction?.type ?? record.executedAction?.type;
  if (kind === 'claim') MODULE_BY_ACTION.claim.forEach(x => ids.add(x));
  if (kind === 'acquire') MODULE_BY_ACTION.acquire.forEach(x => ids.add(x));
  if (kind === 'rest') MODULE_BY_ACTION.rest.forEach(x => ids.add(x));
  if (kind === 'discard') MODULE_BY_ACTION.discard.forEach(x => ids.add(x));
  if (kind === 'play') {
    const card = MERCHANT_BY_ID[record.proposedAction?.cardId ?? record.executedAction?.cardId];
    const key = `play-${card?.kind ?? 'trade'}`;
    (MODULE_BY_ACTION[key] ?? []).forEach(x => ids.add(x));
  }
  return [...ids].sort();
}

function optimizationDirections(modules, tags = []) {
  const directions = [];
  if (modules.includes('M01')) directions.push('检查目标魔像优先级与终局倒计时权重');
  if (modules.includes('M02')) directions.push('检查商人卡获取估值与支付机会成本');
  if (modules.includes('M03')) directions.push('检查商队容量/保留水晶价值');
  if (modules.includes('M04')) directions.push('检查卡牌协同与引擎长期收益');
  if (modules.includes('M05')) directions.push('检查休息节奏与回收成本');
  if (modules.includes('M06')) directions.push('检查终局路线估值与胜率模型');
  if (modules.includes('M07')) directions.push('检查对手需求压力模型');
  if (modules.includes('M08')) directions.push('检查座位竞争/目标存活模型');
  if (modules.includes('M09')) directions.push('检查未知牌支持度估计');
  if (modules.includes('M10')) directions.push('检查根行动候选生成/排序');
  if (modules.includes('M11')) directions.push('检查联合搜索策略覆盖');
  if (modules.includes('M12')) directions.push('检查计算预算分配');
  if (tags.includes('risk')) directions.push('检查高风险行动的回退与保守性');
  return directions.slice(0, 6);
}

// ---------------------------------------------------------------------------
// 读取全部运行
// ---------------------------------------------------------------------------
const runs = [];
for (const path of runPaths) {
  const { store, runPath } = openStore(path);
  runs.push({ store, runPath, run: store.run, runId: store.run.runId });
}
if (!runs.length) throw new Error('没有可用运行');

const allGames = new Map();
const allDecisions = [];
const allPairs = [];
const runMeta = [];
for (const { store, runPath, run, runId } of runs) {
  const gameIds = store.listGames();
  const gameResults = new Map();
  for (const gameId of gameIds) {
    const result = store.readResult(gameId);
    if (result) gameResults.set(gameId, result);
  }
  for (const gameId of gameIds) {
    const result = gameResults.get(gameId) ?? null;
    const meta = store.readGameMeta(gameId);
    allGames.set(`${runId}::${gameId}`, { runId, gameId, meta, result });
    for (const envelope of store.loadEnvelopes(gameId, 'decision')) {
      allDecisions.push({ runId, envelope, record: envelope.record, result, meta });
    }
  }
  for (const pair of store.pairRecords()) allPairs.push({ runId, ...pair });
  runMeta.push({
    runId, runPath, stage: run.config?.stage ?? null,
    provider: run.provider, config: run.config,
    codeVersion: run.codeVersion,
    games: gameIds.length,
    finishedGames: [...gameResults.values()].filter(r => r.status === 'finished').length,
    plannedPairs: (() => {
      try { return JSON.parse(readFileSync(join(runPath, 'summary.json'), 'utf8')).plannedPairs ?? null; }
      catch { return null; }
    })(),
    summaryStatus: (() => {
      try { return JSON.parse(readFileSync(join(runPath, 'summary.json'), 'utf8')).status ?? null; }
      catch { return null; }
    })(),
  });
}

// ---------------------------------------------------------------------------
// 决策质量、分歧与训练候选
// ---------------------------------------------------------------------------
const quality = {
  schema: 'century-llm-quality-v1',
  runs: runMeta,
  totals: {
    decisions: allDecisions.length,
    llmDecisions: allDecisions.filter(d => d.record?.source === 'llm').length,
    fallbackDecisions: allDecisions.filter(d => d.record?.source === 'fallback').length,
    games: allGames.size,
    finishedGames: [...allGames.values()].filter(g => g.result?.status === 'finished').length,
    replayConsistentGames: [...allGames.values()].filter(g => g.result?.replayConsistency?.ok === true).length,
  },
  rates: {},
  sampleClasses: {},
  fallbackCauses: {},
  providerModels: {},
  hiddenLeakFindings: [],
  duplicateRecords: [],
  candidateGeneration: {
    prunedDecisions: 0,
    meanFullLegalCount: null,
    meanKeptCount: null,
  },
  latencyMs: {},
  usage: { tokens: 0, calls: 0, promptTokens: 0, completionTokens: 0 },
};
const contentHashes = new Map();
const parseSuccess = [];
const illegalSuggested = [];
const missingReason = [];
const missingAlternatives = [];
const apiFailures = [];
const retryRecovered = [];
const latencies = [];
const fullCounts = [];
const keptCounts = [];
let prunedDecisions = 0;

for (const d of allDecisions) {
  const record = d.record;
  const result = d.result;
  const sample = classifySample(record, result);
  quality.sampleClasses[sample.label] = (quality.sampleClasses[sample.label] ?? 0) + 1;
  if (record.source === 'fallback') {
    const cause = record.fallbackCause ?? 'unknown';
    quality.fallbackCauses[cause] = (quality.fallbackCauses[cause] ?? 0) + 1;
  }
  const modelKey = `${record.provider?.id ?? 'unknown'}/${record.effectiveModel ?? record.provider?.model ?? 'unknown'}`;
  quality.providerModels[modelKey] = (quality.providerModels[modelKey] ?? 0) + 1;
  parseSuccess.push(record.attempts?.some(a => a.parse === 'ok') === true && !!record.parsed);
  illegalSuggested.push(sample.flags.illegalSuggested);
  missingReason.push(!record.parsed?.reason);
  missingAlternatives.push((record.parsed?.alternativeActions?.length ?? 0) === 0);
  apiFailures.push(record.apiFailure === true);
  retryRecovered.push(sample.label === 'interface-recovered');
  latencies.push(record.totalLatencyMs);
  fullCounts.push(record.candidateSet?.fullLegalCount ?? 0);
  keptCounts.push(record.candidateSet?.keptCount ?? 0);
  if (record.candidateSet?.pruned) prunedDecisions++;
  quality.usage.tokens += record.usage?.totalTokens ?? 0;
  quality.usage.calls += record.attempts?.length ?? 0;
  quality.usage.promptTokens += record.usage?.promptTokens ?? 0;
  quality.usage.completionTokens += record.usage?.completionTokens ?? 0;
  const leaks = hiddenLeakCheck(record);
  if (leaks.length) quality.hiddenLeakFindings.push({ gameId: record.gameId, turnNumber: record.turnNumber, patterns: leaks });
  const contentKey = `${d.runId}|${record.gameId}|${record.observationHash}|${record.seat}|${record.turnNumber}|${record.parsed?.selectedActionId ?? 'none'}|${JSON.stringify(record.executedAction)}`;
  const previous = contentHashes.get(contentKey) ?? 0;
  contentHashes.set(contentKey, previous + 1);
  if (previous > 0) quality.duplicateRecords.push({ gameId: record.gameId, turnNumber: record.turnNumber, contentKey });
}

const total = Math.max(1, allDecisions.length);
quality.rates = {
  parseSuccessRate: parseSuccess.filter(Boolean).length / total,
  illegalSuggestedRate: illegalSuggested.filter(Boolean).length / total,
  missingReasonRate: missingReason.filter(Boolean).length / total,
  missingAlternativesRate: missingAlternatives.filter(Boolean).length / total,
  fallbackRate: (quality.totals.fallbackDecisions ?? 0) / total,
  apiFailureRate: apiFailures.filter(Boolean).length / total,
  retryRecoveredRate: retryRecovered.filter(Boolean).length / total,
  duplicateRecordRate: quality.duplicateRecords.length / total,
  completeGameRate: quality.totals.finishedGames / Math.max(1, quality.totals.games),
  replayConsistencyRate: quality.totals.replayConsistentGames / Math.max(1, quality.totals.games),
  hiddenLeakFree: quality.hiddenLeakFindings.length === 0,
};
quality.candidateGeneration = {
  prunedDecisions,
  meanFullLegalCount: fullCounts.length ? fullCounts.reduce((a, b) => a + b, 0) / fullCounts.length : null,
  meanKeptCount: keptCounts.length ? keptCounts.reduce((a, b) => a + b, 0) / keptCounts.length : null,
  versions: [...new Set(allDecisions.map(d => d.record.candidateSet?.version).filter(Boolean))],
  actionEncoding: ACTION_ENCODING_VERSION,
  stateEncoding: STATE_ENCODING_VERSION,
};
quality.latencyMs = {
  mean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
  median: median(latencies),
  p95: percentile(latencies, 95),
  max: latencies.length ? Math.max(...latencies) : null,
};

// —— 决策分歧（LLM 建议 vs 同状态冠军影子） ——
const disagreements = [];
const agreement = { totalWithShadow: 0, agree: 0, byMode: {} };
for (const d of allDecisions) {
  const record = d.record;
  if (!record.championShadow) continue;
  agreement.totalWithShadow++;
  const same = record.championShadow.agreement === true;
  if (same) agreement.agree++;
  const mode = record.seatCount;
  const modeStats = agreement.byMode[mode] ?? { total: 0, agree: 0 };
  modeStats.total++; if (same) modeStats.agree++; agreement.byMode[mode] = modeStats;
  if (same) continue;
  const pair = allPairs.find(p => p.pairId === d.result?.pairId && p.runId === d.runId);
  const pairDelta = pair?.delta ?? null;
  const outcomeClass = pairDelta === null ? 'unknown'
    : pairDelta > 0 ? 'llm-won-champion-lost'
    : pairDelta < 0 ? 'llm-lost-champion-won' : 'same-outcome';
  const modules = involvedModules(record);
  const tags = record.parsed?.strategyTags ?? [];
  disagreements.push({
    schema: 'century-llm-disagreement-v1',
    runId: d.runId, gameId: record.gameId, pairId: d.result?.pairId ?? null,
    mode, seed: record.seed, focusSeat: record.focusSeat,
    turnNumber: record.turnNumber, seat: record.seat, phase: record.phase,
    observationHash: record.observationHash,
    llm: {
      actionId: record.parsed?.selectedActionId ?? null,
      action: record.proposedAction,
      reason: record.parsed?.reason ?? record.fallbackReason,
      primaryGoal: record.parsed?.primaryGoal ?? null,
      strategyTags: tags,
      risks: record.parsed?.risks ?? [],
    },
    championShadow: {
      action: record.championShadow.action,
      actionKey: record.championShadow.actionKey,
      reason: record.championShadow.reason,
    },
    source: record.source,
    fallbackCause: record.fallbackCause,
    outcomeClass,
    pairDelta,
    finalResult: d.result ? {
      status: d.result.status, focusFirst: d.result.focusFirst, focusRank: d.result.focusRank,
      focusScore: d.result.focusScore, winnerSeat: d.result.winnerSeat,
    } : null,
    involvedModules: modules,
    possibleOptimizationDirections: optimizationDirections(modules, tags),
    diagnosticOnly: true,
    note: '分歧仅表示行动不同，不表示 LLM 或冠军谁正确；结果类别只是配对终局的相关观察',
  });
}
const agreementRate = agreement.totalWithShadow ? agreement.agree / agreement.totalWithShadow : null;

// —— 胜/负配对与争议局面 ——
const pairOutcomes = {
  llmWonChampionLost: allPairs.filter(p => p.delta === 1),
  championWonLlmLost: allPairs.filter(p => p.delta === -1),
  sameOutcome: allPairs.filter(p => p.delta === 0),
  anomaly: allPairs.filter(p => p.anomaly === true || p.delta === null),
};
const controversial = disagreements
  .map(d => ({ ...d, controversyScore: Math.abs(d.pairDelta ?? 0) }))
  .sort((a, b) => b.controversyScore - a.controversyScore)
  .slice(0, topN);

// —— 策略标签错误画像（只作诊断，不把胜负当单步真值） ——
const strategyProfiles = {};
for (const d of allDecisions) {
  for (const tag of d.record.parsed?.strategyTags ?? []) {
    const p = strategyProfiles[tag] ?? { tag, decisions: 0, fallback: 0, invalid: 0, disagreement: 0, llmLostPairs: 0 };
    p.decisions++;
    if (d.record.source === 'fallback') p.fallback++;
    if (d.record.engineValidation !== 'accepted') p.invalid++;
    if (d.record.championShadow && !d.record.championShadow.agreement) p.disagreement++;
    if (d.result?.focusFirst === false) p.llmLostPairs++;
    strategyProfiles[tag] = p;
  }
}

// ---------------------------------------------------------------------------
// 配对实验第一名率与统计功效
// ---------------------------------------------------------------------------
const stageSet = new Set(runs.map(r => r.run.config?.stage).filter(Boolean));
const isConfirm = stageSet.size === 1 && stageSet.has('confirm');
const alpha = alphaArg !== null ? Number(alphaArg) : isConfirm ? 0.05 / 4 : 0.05;
const pairStats = {};
const requestedModes = [...new Set([
  ...allPairs.map(p => p.mode),
  ...runs.flatMap(r => r.run.config?.modes ?? []),
])].sort((a, b) => a - b);
for (const mode of requestedModes) {
  const list = allPairs.filter(p => p.mode === mode);
  const valid = list.filter(p => p.anomaly === false && p.delta !== null && p.armA?.status === 'finished' && p.armB?.status === 'finished');
  const aWins = valid.filter(p => p.armA.focusFirst === true).length;
  const bWins = valid.filter(p => p.armB.focusFirst === true).length;
  let ci = null;
  try {
    const clustered = clusterFirstPlacePairs(valid.map(p => ({
      seed: p.seed, focusSeat: p.focusSeat,
      candidateFirst: p.armA.focusFirst === true ? 1 : 0,
      championFirst: p.armB.focusFirst === true ? 1 : 0,
    })));
    ci = clustered.uniqueSeeds >= 2 ? clusterMeanCI(clustered, { alpha }) : null;
  } catch (error) {
    ci = { error: error.message };
  }
  const n = valid.length;
  const observedDelta = n ? (aWins - bWins) / n : null;
  const mde = n >= 2 ? minimumDetectableEffect({ n, alpha, power: powerTarget, variance: 1 }) : null;
  const observedPower = n >= 2 && observedDelta !== null && observedDelta > 0
    ? powerAt({ n, effect: observedDelta, alpha, variance: 1 })
    : null;
  pairStats[mode] = {
    seatCount: mode,
    plannedPairs: list.length,
    validPairs: n,
    anomalyPairs: list.length - n,
    llmFirst: aWins,
    championFirst: bWins,
    llmFirstRate: n ? aWins / n : null,
    championFirstRate: n ? bWins / n : null,
    llmFirstWilsonCI: n ? wilsonCI(aWins, n) : null,
    championFirstWilsonCI: n ? wilsonCI(bWins, n) : null,
    firstPlaceDelta: observedDelta,
    deltaCounts: {
      plus: valid.filter(p => p.delta === 1).length,
      zero: valid.filter(p => p.delta === 0).length,
      minus: valid.filter(p => p.delta === -1).length,
    },
    pairedDeltaCI: ci,
    mdeAtObservedN: mde,
    powerAtObservedEffect: observedPower,
    requiredSeedsForObservedEffect: observedDelta && observedDelta > 0
      ? requiredSeeds({ effect: observedDelta, alpha, power: powerTarget, variance: 1 })
      : null,
    meanScores: {
      llm: n ? valid.reduce((s, p) => s + (p.armA.focusScore ?? 0), 0) / n : null,
      champion: n ? valid.reduce((s, p) => s + (p.armB.focusScore ?? 0), 0) / n : null,
    },
    meanRank: {
      llm: n ? valid.reduce((s, p) => s + (p.armA.focusRank ?? 0), 0) / n : null,
      champion: n ? valid.reduce((s, p) => s + (p.armB.focusRank ?? 0), 0) / n : null,
    },
    meanGolems: {
      llm: n ? valid.reduce((s, p) => s + (p.armA.focusGolems ?? allGames.get(`${p.runId}::${p.armA.gameId}`)?.result?.focusGolems ?? 0), 0) / n : null,
      champion: n ? valid.reduce((s, p) => s + (p.armB.focusGolems ?? allGames.get(`${p.runId}::${p.armB.gameId}`)?.result?.focusGolems ?? 0), 0) / n : null,
    },
    meanDecisionLatencyMs: median(valid.flatMap(p => p.armA.decisionLatencies ?? [])),
    totalTokens: valid.reduce((s, p) => s + (p.armA.tokens ?? 0), 0),
    meanTokensPerPair: n ? valid.reduce((s, p) => s + (p.armA.tokens ?? 0), 0) / n : null,
    fallbackAffectedPairs: valid.filter(p => (p.armA.fallbackCount ?? 0) > 0).length,
    anomalyRate: list.length ? (list.length - n) / list.length : null,
  };
}
let pooled = null;
try {
  const strata = Object.values(pairStats)
    .filter(s => s.pairedDeltaCI && Number.isFinite(s.pairedDeltaCI.mean))
    .map(s => ({
      seatCount: s.seatCount,
      ci: { mean: s.pairedDeltaCI.mean, variance: s.pairedDeltaCI.variance, n: s.pairedDeltaCI.n },
    }));
  if (strata.length) {
    const weights = Object.fromEntries([2, 3, 4, 5].map(m => [String(m), 0.25]));
    const usableWeights = Object.fromEntries(strata.map(s => [String(s.seatCount), 1 / strata.length]));
    pooled = pooledWeightedDelta({ strata: strata.map(s => ({ ...s, ci: s.ci, seatCount: s.seatCount })), weights: usableWeights, alpha });
  }
} catch (error) {
  pooled = { status: 'error', error: error.message };
}

const validPairsAll = allPairs.filter(p => p.anomaly === false && p.delta !== null);
const plannedPairsTotal = runMeta.reduce((sum, r) => sum + (r.plannedPairs ?? 0), 0);
const allRunsCompleted = runMeta.length > 0 && runMeta.every(r => r.summaryStatus === 'completed');
const inferenceClass = isConfirm
  ? (plannedPairsTotal > 0 && validPairsAll.length >= plannedPairsTotal && allRunsCompleted
    ? 'confirmatory'
    : 'incomplete-confirmatory')
  : 'exploratory';
const conclusion = (() => {
  if (!validPairsAll.length) return '无有效配对，无法比较第一名率';
  const deltas = validPairsAll.map(p => p.delta);
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  if (pooled?.status === 'analyzed') {
    if (pooled.lower > 0) return '配对第一名率增量在统计上为正（仍需按预注册口径解读）';
    if (pooled.upper < 0) return '配对第一名率增量在统计上为负';
    return '配对第一名率增量区间跨越 0，无显著差异';
  }
  return `平均配对增量 ${mean.toFixed(4)}，但样本/功效不足，只能作探索性观察`;
})();

// ---------------------------------------------------------------------------
// 导出训练候选（MLP/PPO 离线模仿）
// ---------------------------------------------------------------------------
const trainingCandidates = [];
const diagnosisCases = [];
const moduleMatrix = Object.fromEntries(moduleMap().map(m => [m.id, {
  ...m, signals: 0, cases: [], optimizationDirections: [],
}]));

if (!has('--no-training') || !has('--no-openevolve')) {
  for (const d of allDecisions) {
    const record = d.record;
    const result = d.result;
    const sample = classifySample(record, result);
    const view = record.observation;
    if (!view) continue;
    let stateEncoding = null;
    let selectedEncoding = null;
    let executedEncoding = null;
    const candidateEncodings = [];
    try {
      stateEncoding = packF32(encodeState(view, view.current));
      const seen = new Set();
      for (const candidate of record.candidateSet?.candidates ?? []) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        candidateEncodings.push({
          actionId: candidate.id,
          actionKey: actionKey(candidate.action),
          kind: candidate.kind,
          encoding: packF32(encodeAction(view, descriptorOf(candidate.action))),
        });
      }
      if (record.proposedAction) selectedEncoding = packF32(encodeAction(view, descriptorOf(record.proposedAction)));
      executedEncoding = packF32(encodeAction(view, descriptorOf(record.executedAction)));
    } catch (error) {
      // 编码失败不阻断分析：记录原因，样本降级为待验证。
      candidateEncodings.push({ error: error.message });
    }
    const alternativeIds = (record.parsed?.alternativeActions ?? []).map(a => a.actionId);
    const order = [];
    if (record.parsed?.selectedActionId) order.push(record.parsed.selectedActionId);
    for (const id of alternativeIds) if (!order.includes(id)) order.push(id);
    if (record.championShadow) {
      const shadowId = record.candidateSet?.candidates?.find(c => actionKey(c.action) === record.championShadow.actionKey)?.id;
      if (shadowId && !order.includes(shadowId)) order.push(shadowId);
    }
    for (const candidate of record.candidateSet?.candidates ?? []) if (!order.includes(candidate.id)) order.push(candidate.id);
    const outcome = outcomeFor(record, result);
    const pair = allPairs.find(p => p.pairId === result?.pairId && p.runId === d.runId);
    const candidate = {
      schema: 'century-llm-training-candidate-v1',
      candidateId: `${d.runId}:${record.gameId}:${record.decisionId}`,
      runId: d.runId,
      gameId: record.gameId,
      decisionId: record.decisionId,
      seed: record.seed,
      mode: record.seatCount,
      seat: record.seat,
      focusSeat: record.focusSeat,
      turnNumber: record.turnNumber,
      phase: record.phase,
      stateEncodingVersion: STATE_ENCODING_VERSION,
      actionEncodingVersion: ACTION_ENCODING_VERSION,
      stateDim: STATE_DIM,
      actionDim: ACTION_DIM,
      stateEncoding,
      selectedActionEncoding: selectedEncoding,
      executedActionEncoding: executedEncoding,
      candidateActionEncodings: candidateEncodings,
      candidateRanking: order,
      selectedActionId: record.parsed?.selectedActionId ?? null,
      selectedAction: record.proposedAction,
      executedAction: record.executedAction,
      championShadowAction: record.championShadow?.action ?? null,
      championShadowAgreement: record.championShadow?.agreement ?? null,
      decisionSource: record.source,
      fallbackCause: record.fallbackCause,
      quality: sample,
      reward: {
        definition: 'firstPlace（焦点席位最终是否取得唯一第一名）',
        value: outcome.firstPlace === true ? 1 : outcome.firstPlace === false ? 0 : null,
        score: outcome.score,
        rank: outcome.rank,
        winnerSeat: outcome.winnerSeat,
        pairDelta: pair?.delta ?? null,
      },
      finalResult: outcome,
      llmText: {
        reason: record.parsed?.reason ?? null,
        primaryGoal: record.parsed?.primaryGoal ?? null,
        expectedBenefits: record.parsed?.expectedBenefits ?? [],
        risks: record.parsed?.risks ?? [],
        strategyTags: record.parsed?.strategyTags ?? [],
      },
      provenance: {
        provider: record.provider,
        effectiveModel: record.effectiveModel,
        promptHash: record.prompt?.promptHash,
        observationHash: record.observationHash,
        recordHash: d.envelope.recordHash,
      },
      trainingPolicy: {
        offlineOnly: true,
        notOnPolicyRollout: true,
        note: '历史 LLM 数据只能用于离线模仿学习/诊断；不得当作新鲜 PPO on-policy rollout',
      },
    };
    trainingCandidates.push(candidate);
    if (record.championShadow && record.championShadow.agreement === false && !has('--no-openevolve')) {
      const modules = involvedModules(record);
      const outcomeClass = pair?.delta === 1 ? 'llm-won-champion-lost'
        : pair?.delta === -1 ? 'llm-lost-champion-won'
        : pair?.delta === 0 ? 'same-outcome' : 'unknown';
      const caseRecord = {
        schema: 'century-openevolve-diagnostic-case-v1',
        caseId: `${d.runId}:${record.gameId}:${record.turnNumber}`,
        runId: d.runId,
        gameId: record.gameId,
        pairId: result?.pairId ?? null,
        mode: record.seatCount,
        seed: record.seed,
        focusSeat: record.focusSeat,
        turnNumber: record.turnNumber,
        observationHash: record.observationHash,
        candidateSetVersion: record.candidateSet?.version,
        llmAction: record.proposedAction,
        llmActionSummary: record.parsed?.reason ?? record.fallbackReason,
        championAction: record.championShadow.action,
        championReason: record.championShadow.reason,
        involvedModules: modules,
        failureReasonCategory: record.fallbackCause
          ? `interface-${record.fallbackCause}`
          : sample.label === 'invalid-decision' ? 'invalid-decision'
          : outcomeClass,
        outcomeClass,
        pairDelta: pair?.delta ?? null,
        llmStrategyTags: record.parsed?.strategyTags ?? [],
        possibleOptimizationDirections: optimizationDirections(modules),
        reproducibleTestCase: {
          runPath: d.runId,
          gameId: record.gameId,
          decisionId: record.decisionId,
          observationHash: record.observationHash,
          replay: '通过运行目录中的 result.json 与该 decision 记录可独立重放决策输入',
        },
        diagnosticOnly: true,
        note: '不得把 LLM 文字理由当作奖励真值；本案例只提供候选分歧与模块定位',
      };
      diagnosisCases.push(caseRecord);
      for (const id of modules) {
        if (!moduleMatrix[id]) continue;
        moduleMatrix[id].signals++;
        if (moduleMatrix[id].cases.length < 20) moduleMatrix[id].cases.push(caseRecord.caseId);
        for (const direction of caseRecord.possibleOptimizationDirections) {
          if (!moduleMatrix[id].optimizationDirections.includes(direction)) moduleMatrix[id].optimizationDirections.push(direction);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 写出派生文件
// ---------------------------------------------------------------------------
const baseOut = outRoot ? resolve(outRoot) : join(runs[0].runPath, 'analysis');
mkdirSync(baseOut, { recursive: true });
const analysis = {
  schema: 'century-llm-analysis-v1',
  generatedAt: new Date().toISOString(),
  runs: runMeta,
  quality,
  agreement: {
    ...agreement,
    agreementRate,
    disagreements: disagreements.length,
  },
  strategyProfiles,
  pairOutcomes: {
    llmWonChampionLost: pairOutcomes.llmWonChampionLost.map(p => ({ pairId: p.pairId, mode: p.mode, seed: p.seed, focusSeat: p.focusSeat, delta: p.delta })),
    championWonLlmLost: pairOutcomes.championWonLlmLost.map(p => ({ pairId: p.pairId, mode: p.mode, seed: p.seed, focusSeat: p.focusSeat, delta: p.delta })),
    sameOutcome: pairOutcomes.sameOutcome.map(p => ({ pairId: p.pairId, mode: p.mode, seed: p.seed, focusSeat: p.focusSeat, delta: p.delta })),
    anomaly: pairOutcomes.anomaly.map(p => ({ pairId: p.pairId, mode: p.mode, seed: p.seed, focusSeat: p.focusSeat, anomaly: p.anomaly })),
  },
  controversial,
  pairStats,
  pooled,
  inference: {
    class: inferenceClass,
    stage: [...stageSet],
    alpha,
    powerTarget,
    multipleTestingControl: isConfirm ? 'Bonferroni α/4（2–5 人四层）' : '探索性：未作正式多重检验；仅供方向性观察',
    conclusion,
    note: isConfirm
      ? '正式推断必须同时满足预注册样本量、无预算中断、异常率与回退率约束；否则标记功效不足'
      : '阶段 A/B 不得宣称统计显著优势，不得据此晋级冠军',
  },
  counts: {
    decisions: allDecisions.length,
    disagreements: disagreements.length,
    trainingCandidates: trainingCandidates.length,
    diagnosisCases: diagnosisCases.length,
  },
  cost: {
    providerMode: [...new Set(runs.map(r => r.run.provider?.mode).filter(Boolean))],
    tokens: quality.usage.tokens,
    calls: quality.usage.calls,
    marginalApiCostUsd: 0,
    basis: 'Codex CLI 使用本机 ChatGPT 登录（订阅内）；无逐 token API 账单。若切换付费 OpenAI-compatible Provider，应按实际账单另计。',
  },
  artifacts: {
    analysis: join(baseOut, 'analysis.json'),
    quality: join(baseOut, 'quality.json'),
    pairs: join(baseOut, 'pairs.jsonl'),
    disagreements: join(baseOut, 'disagreements.jsonl'),
    trainingCandidates: join(baseOut, 'training-candidates.jsonl'),
    openevolveDiagnosis: join(baseOut, 'openevolve-diagnosis.jsonl'),
    moduleMatrix: join(baseOut, 'module-signal-matrix.json'),
  },
};

if (!has('--no-training')) {
  writeFileSync(analysis.artifacts.trainingCandidates, trainingCandidates.map(x => JSON.stringify(x)).join('\n') + (trainingCandidates.length ? '\n' : ''));
}
if (!has('--no-openevolve')) {
  writeFileSync(analysis.artifacts.openevolveDiagnosis, diagnosisCases.map(x => JSON.stringify(x)).join('\n') + (diagnosisCases.length ? '\n' : ''));
  writeFileSync(analysis.artifacts.moduleMatrix, JSON.stringify({
    schema: 'century-openevolve-module-signal-matrix-v1',
    generatedAt: analysis.generatedAt,
    modules: moduleMatrix,
    note: '模块信号来自决策分歧的策略标签与行动类型定位；不是因果证明，也不代表这些模块必然需要修改',
  }, null, 2) + '\n');
}
writeFileSync(analysis.artifacts.disagreements, disagreements.map(x => JSON.stringify(x)).join('\n') + (disagreements.length ? '\n' : ''));
writeFileSync(analysis.artifacts.pairs, allPairs.map(x => JSON.stringify(x)).join('\n') + (allPairs.length ? '\n' : ''));
writeFileSync(analysis.artifacts.quality, JSON.stringify(quality, null, 2) + '\n');
writeFileSync(analysis.artifacts.analysis, JSON.stringify(analysis, null, 2) + '\n');

const md = [
  '# LLM 玩家实验数据分析',
  '',
  `生成时间：${analysis.generatedAt}`,
  `运行：${runMeta.map(r => r.runId).join('、')}`,
  `证据类别：${[...new Set(runs.map(r => r.run.config?.evidenceClass))].join('、')}`,
  '',
  '## 数据质量',
  '',
  `- 决策 ${quality.totals.decisions}（LLM 有效 ${quality.totals.llmDecisions}，回退 ${quality.totals.fallbackDecisions}）`,
  `- 对局 ${quality.totals.finishedGames}/${quality.totals.games} 完成，重放一致 ${quality.totals.replayConsistentGames}`,
  `- 解析成功率 ${(quality.rates.parseSuccessRate * 100).toFixed(1)}%，回退率 ${(quality.rates.fallbackRate * 100).toFixed(1)}%，非法建议率 ${(quality.rates.illegalSuggestedRate * 100).toFixed(1)}%`,
  `- 隐藏信息泄露检查：${quality.rates.hiddenLeakFree ? 'PASS' : 'FAIL'}`,
  `- 样本分类：${Object.entries(quality.sampleClasses).map(([k, v]) => `${k}=${v}`).join('，')}`,
  '',
  '## 第一名率（配对）',
  '',
  '| 人数 | 有效配对 | LLM 第一 | 冠军第一 | LLM 率 | 冠军率 | 配对 delta | 配对 CI | 观察功效 |',
  '|---|---|---|---|---|---|---|---|---|',
  ...Object.values(pairStats).map(s => `| ${s.seatCount} | ${s.validPairs} | ${s.llmFirst} | ${s.championFirst} | ${s.llmFirstRate === null ? '-' : (s.llmFirstRate * 100).toFixed(1) + '%'} | ${s.championFirstRate === null ? '-' : (s.championFirstRate * 100).toFixed(1) + '%'} | ${s.firstPlaceDelta === null ? '-' : (s.firstPlaceDelta * 100).toFixed(1) + 'pp'} | ${s.pairedDeltaCI?.lower === undefined ? '-' : `${(s.pairedDeltaCI.lower * 100).toFixed(1)}, ${(s.pairedDeltaCI.upper * 100).toFixed(1)}`} | ${s.powerAtObservedEffect === null ? '-' : (s.powerAtObservedEffect * 100).toFixed(1) + '%'} |`),
  '',
  `推断级别：${inferenceClass}；结论：${conclusion}`,
  '',
  '## 分歧与模块',
  '',
  `- 具有冠军影子的决策 ${agreement.totalWithShadow}，一致 ${agreement.agree}（${agreementRate === null ? '-' : (agreementRate * 100).toFixed(1)}%）`,
  `- 分歧案例 ${disagreements.length}，诊断案例 ${diagnosisCases.length}`,
  `- 模块信号覆盖：${Object.entries(moduleMatrix).map(([id, m]) => `${id}=${m.signals}`).join('，')}`,
  '',
  '## 统计与成本',
  '',
  `- 决策延迟中位数 ${quality.latencyMs.median === null ? '-' : Math.round(quality.latencyMs.median)}ms，p95 ${quality.latencyMs.p95 === null ? '-' : Math.round(quality.latencyMs.p95)}ms`,
  `- Token ${quality.usage.tokens}，调用 ${quality.usage.calls}`,
  `- 边际 API 费用：$${analysis.cost.marginalApiCostUsd}（${analysis.cost.basis}）`,
  '',
  '> 本分析仅描述可复现数据；LLM 理由不是奖励真值，阶段 A/B 不得宣称显著优势。',
].join('\n');
writeFileSync(join(baseOut, 'analysis.md'), md + '\n');

console.log(JSON.stringify({
  out: baseOut,
  runs: runMeta.map(r => r.runId),
  decisions: allDecisions.length,
  disagreements: disagreements.length,
  pairStats,
  inference: analysis.inference,
  quality: { rates: quality.rates, sampleClasses: quality.sampleClasses },
}, null, 2));
