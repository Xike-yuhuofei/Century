#!/usr/bin/env node
/** 2–5 人 LLM vs 冻结冠军配对实验运行器。
 *
 * 配对设计（Common Random Numbers）：
 * - 同一 seed + 同人数 + 同焦点席位 + 同冻结对手（所有非焦点席位 = 当前冠军）；
 * - A 局：焦点席位由 LLM 控制；B 局：同一焦点席位由冻结冠军控制；
 * - 焦点席位按配对序号均衡轮换；
 * - 每个种子产生一个配对 delta ∈ {−1,0,+1}，主指标为第一名率。
 *
 * 阶段：
 * - smoke：每种人数 1 个种子，验证完整对局与数据链路；
 * - exploratory：预算受控的探索样本，结论标记为探索性；
 * - confirm：仅接受预注册计划，使用独立确认种子。
 *
 * 真实 Provider 默认 Codex CLI（ChatGPT 登录，无 API Key）；mock 仅用于 CI/自测，
 * 其 summary 标记 evidenceClass=mock，不得冒充真实 LLM 成绩。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { RunStore, newRunId, codeVersion } from './store.mjs';
import { runGame } from './game-runner.mjs';
import {
  MODES, STAGES, DEFAULT_CODEX_MODEL, DEFAULT_GLM_MODEL, DEFAULT_OPENROUTER_MODEL, REPO_ROOT,
  loadChampion, stageSeeds, focusSeatFor, gameIds, frozenVersions,
  createProvider, defaultLlmConfig, providerIdentity,
} from './config.mjs';
import { createCodexProvider } from './provider-codex.mjs';
import { createGLMProvider } from './provider-glm.mjs';
import { createOpenRouterProvider } from './provider-openrouter.mjs';
import { clusterMeanCI, clusterFirstPlacePairs } from '../../training/evaluator/first-place.mjs';
import { wilsonCI } from '../../training/evaluator/stats.mjs';

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const value = (flag, fallback = undefined) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
};
const required = flag => {
  const v = value(flag);
  if (v === undefined) throw new Error(`缺少参数 ${flag}`);
  return v;
};
if (has('--help') || has('-h')) {
  console.log(`用法: node training/llm/pair-experiment.mjs --stage smoke|exploratory|confirm [options]
  --modes 2,3,4,5              人数（默认全部）
  --seeds-per-mode N           每人数配对种子数（smoke 默认 1，exploratory 默认 4）
  --offset N                   种子块内偏移（默认 0，不得与已完成种子重叠）
  --run-id ID                  运行 id（默认自动生成）；--resume 复用已有运行
  --root PATH                  数据根（默认 training/reports/llm-player）
  --provider codex|glm|openrouter|mock  真实 Provider 默认 codex；glm/openrouter 为免费备用
  --model MODEL                Codex 默认 ${DEFAULT_CODEX_MODEL}；GLM 默认 ${DEFAULT_GLM_MODEL}；OpenRouter 默认 ${DEFAULT_OPENROUTER_MODEL}
  --reasoning-effort low|medium|high
  --concurrency N              并发对局数（默认 2）
  --max-calls-per-game N       每局 LLM 调用上限（默认 120）
  --token-budget-per-game N    每局 LLM Token 预算（默认 2500000）
  --run-token-budget N         整次运行 Token 预算（默认 25000000）
  --run-call-budget N          整次运行调用预算（默认 1500）
  --max-wall-minutes N         调度墙钟上限（默认 240）
  --max-pairs N                最多运行配对数（调试用）
  --preregistration PATH       阶段 C 预注册计划
  --mock-action ID             Mock Provider 固定选择（测试用）
  --allow-anomaly-retry        （保留；默认跳过已记录配对）
  --dry-run                    只打印计划与种子，不运行
  --no-export                  不生成完整 JSON 导出`);
  process.exit(0);
}

function preregHash(plan) {
  const { planHash, ...rest } = plan;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function loadPreregistration(path) {
  const resolved = resolve(path);
  const plan = JSON.parse(readFileSync(resolved, 'utf8'));
  if (plan.schema !== 'century-llm-preregistration-v1') throw new Error(`预注册 schema 不识别：${plan.schema}`);
  if (!plan.planHash || preregHash(plan) !== plan.planHash) throw new Error('预注册 planHash 校验失败（计划被修改）');
  if (!plan.lockedAt) throw new Error('预注册缺少 lockedAt');
  return { plan, path: resolved, planHash: plan.planHash };
}

function parseModes() {
  const raw = value('--modes', '2,3,4,5');
  const modes = String(raw).split(',').map(Number).filter(n => Number.isInteger(n));
  if (!modes.length || modes.some(m => !MODES.includes(m))) throw new Error(`--modes 非法：${raw}`);
  return [...new Set(modes)].sort((a, b) => a - b);
}

function scanUsage(store) {
  let calls = 0;
  let tokens = 0;
  let decisions = 0;
  let llmGames = new Set();
  for (const gameId of store.listGames()) {
    for (const envelope of store.loadEnvelopes(gameId, 'decision')) {
      const record = envelope.record ?? {};
      calls += record.attempts?.length ?? 0;
      tokens += record.usage?.totalTokens ?? 0;
      decisions += 1;
      llmGames.add(gameId);
    }
  }
  return { calls, tokens, decisions, llmGames: llmGames.size };
}

function summarizePairs(pairs, requestedModes, stage, plannedPairs, status, usage, providerInfo) {
  const modes = requestedModes;
  const strata = {};
  for (const mode of modes) {
    const list = pairs.filter(p => p.mode === mode);
    const valid = list.filter(p => p.anomaly === false && p.armA?.status === 'finished' && p.armB?.status === 'finished');
    const firstA = valid.filter(p => p.armA.focusFirst === true).length;
    const firstB = valid.filter(p => p.armB.focusFirst === true).length;
    const deltas = valid.map(p => p.delta).filter(d => Number.isFinite(d));
    let ci = null;
    try {
      const clustered = clusterFirstPlacePairs(valid.map(p => ({
        seed: p.seed,
        candidateFirst: p.armA.focusFirst === true ? 1 : 0,
        championFirst: p.armB.focusFirst === true ? 1 : 0,
        focusSeat: p.focusSeat,
      })));
      ci = clustered.uniqueSeeds >= 2 ? clusterMeanCI(clustered, { alpha: stage === 'confirm' ? 0.05 / 4 : 0.05 }) : null;
    } catch (error) {
      ci = { error: error.message };
    }
    const fallbackGames = valid.filter(p => (p.armA.fallbackCount ?? 0) > 0).length;
    strata[mode] = {
      seatCount: mode,
      pairs: list.length,
      validPairs: valid.length,
      anomalies: list.length - valid.length,
      candidateFirst: firstA,
      championFirst: firstB,
      candidateFirstRate: valid.length ? firstA / valid.length : null,
      championFirstRate: valid.length ? firstB / valid.length : null,
      candidateWilsonCI: valid.length ? wilsonCI(firstA, valid.length) : null,
      championWilsonCI: valid.length ? wilsonCI(firstB, valid.length) : null,
      meanPairedDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
      pairedDeltaCI: ci,
      deltaCounts: {
        plus: deltas.filter(d => d > 0).length,
        zero: deltas.filter(d => d === 0).length,
        minus: deltas.filter(d => d < 0).length,
      },
      fallbackGames,
      fallbackRate: valid.length ? fallbackGames / valid.length : null,
      medianDecisionLatencyMs: median(valid.flatMap(p => p.armA.decisionLatencies ?? [])),
      totalTokens: valid.reduce((sum, p) => sum + (p.armA.tokens ?? 0), 0),
      meanTokensPerGame: valid.length ? valid.reduce((sum, p) => sum + (p.armA.tokens ?? 0), 0) / valid.length : null,
      meanGameWallMs: valid.length ? valid.reduce((sum, p) => sum + (p.armA.wallMs ?? 0), 0) / valid.length : null,
    };
  }
  const totalValid = Object.values(strata).reduce((sum, s) => sum + s.validPairs, 0);
  const totalAnomalies = Object.values(strata).reduce((sum, s) => sum + s.anomalies, 0);
  const totalFallbacks = Object.values(strata).reduce((sum, s) => sum + s.fallbackGames, 0);
  return {
    schema: 'century-llm-pair-summary-v1',
    stage,
    status,
    evidenceClass: providerInfo?.mode === 'mock' ? 'mock' : 'real-llm',
    provider: providerInfo,
    plannedPairs,
    completedPairs: pairs.length,
    validPairs: totalValid,
    anomalyPairs: totalAnomalies,
    fallbackAffectedPairs: totalFallbacks,
    usage,
    strata,
    limitations: [
      'LLM Provider 非确定性（Codex/ChatGPT 后端可能在相同输入下产生不同行动），配对仅共享初始随机世界，不保证后续轨迹一致。',
      '第一名率以焦点席位是否取得唯一第一名定义；异常局不计入有效配对。',
      stage === 'confirm'
        ? '阶段 C 应仅报告预注册样本；任何中途停止或预算不足都必须标记为功效不足。'
        : '阶段 A/B 为功能验证/探索性结论，不构成统计显著优势；不得据此宣称 LLM 更强或晋级冠军。',
    ],
  };
}

function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

const stage = value('--stage');
if (!STAGES.includes(stage)) throw new Error(`--stage 必须为 ${STAGES.join('|')}`);
const modes = parseModes();
const defaults = stage === 'smoke' ? 1 : stage === 'confirm' ? null : 4;
const seedsPerModeRaw = value('--seeds-per-mode', defaults);
const seedsPerMode = seedsPerModeRaw === null || seedsPerModeRaw === undefined ? null : Number(seedsPerModeRaw);
if (stage !== 'confirm' && (!Number.isInteger(seedsPerMode) || seedsPerMode <= 0)) {
  throw new Error('--seeds-per-mode 必须为正整数');
}
if (seedsPerMode !== null && (!Number.isInteger(seedsPerMode) || seedsPerMode <= 0)) {
  throw new Error('--seeds-per-mode 必须为正整数');
}
const offset = Number(value('--offset', 0));
const concurrency = Math.max(1, Number(value('--concurrency', 2)));
const maxPairs = Number(value('--max-pairs', Number.MAX_SAFE_INTEGER));
const maxWallMinutes = Number(value('--max-wall-minutes', 240));
const runTokenBudget = Number(value('--run-token-budget', 25_000_000));
const runCallBudget = Number(value('--run-call-budget', 1500));
const providerKind = value('--provider', 'codex');
if (!['codex', 'glm', 'openrouter', 'mock'].includes(providerKind)) throw new Error('--provider 支持 codex|glm|openrouter|mock');
const model = value('--model', providerKind === 'glm' ? DEFAULT_GLM_MODEL : providerKind === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_CODEX_MODEL);
const reasoningEffort = value('--reasoning-effort', 'low');
const llmConfig = defaultLlmConfig({
  maxCallsPerGame: Number(value('--max-calls-per-game', 120)),
  tokenBudgetPerGame: Number(value('--token-budget-per-game', 2_500_000)),
  timeoutMs: Number(value('--decision-timeout-ms', 120_000)),
  maxRetries: Number(value('--max-retries', 1)),
  maxTokens: Number(value('--max-tokens', providerKind === 'glm' ? 2500 : providerKind === 'openrouter' ? 2000 : 700)),
  candidateLimit: Number(value('--candidate-limit', 64)),
});
const root = resolve(value('--root', 'training/reports/llm-player'));
const experimentId = value('--experiment-id', 'ai10-llm-v1');
const runId = value('--run-id', newRunId(`${experimentId}-${stage}`));
const resume = has('--resume');
const dryRun = has('--dry-run');
const preregPath = value('--preregistration');

let prereg = null;
if (preregPath) {
  prereg = loadPreregistration(preregPath);
  if (stage !== 'confirm') throw new Error('预注册计划只能用于 confirm 阶段');
  if (prereg.plan.provider?.model && prereg.plan.provider.model !== model) {
    throw new Error(`预注册模型 ${prereg.plan.provider.model} 与本次 ${model} 不一致`);
  }
}
if (stage === 'confirm' && !prereg) throw new Error('confirm 阶段必须提供 --preregistration 预注册计划');

const champion = loadChampion();
const dist = await import('../../web-v1/dist/js/ai/llm/index.js');
const provider = createProvider({
  kind: providerKind, model, reasoningEffort, concurrency,
  dist, codexModule: { createCodexProvider }, glmModule: { createGLMProvider },
  openrouterModule: { createOpenRouterProvider },
  mockActionId: value('--mock-action'),
});
const providerInfo = providerIdentity(provider);

// 种子与焦点席位：confirm 严格使用预注册列表；A/B 使用阶段子块顺序种子。
const planStrata = {};
for (const mode of modes) {
  let seeds;
  let focusSeats;
  if (prereg) {
    const planned = prereg.plan.strata?.[String(mode)] ?? prereg.plan.strata?.[mode];
    if (!planned?.seeds?.length) throw new Error(`预注册缺少 ${mode} 人层 seeds`);
    seeds = planned.seeds;
    focusSeats = planned.focusSeats ?? seeds.map((_, index) => focusSeatFor(index, mode));
    if (planned.seedCount !== undefined && planned.seedCount !== seeds.length) throw new Error(`预注册 ${mode} 人层 seedCount 不一致`);
  } else {
    seeds = stageSeeds(stage, mode, seedsPerMode, offset);
    focusSeats = seeds.map((_, index) => focusSeatFor(index, mode));
  }
  if (new Set(seeds).size !== seeds.length) throw new Error(`${mode} 人层存在重复种子`);
  planStrata[mode] = { seeds, focusSeats };
}

const plannedPairs = modes.reduce((sum, mode) => sum + planStrata[mode].seeds.length, 0);
if (dryRun) {
  const plan = {
    schema: 'century-llm-run-plan-v1', stage, experimentId, runId,
    modes, seedsPerMode, offset, plannedPairs, concurrency,
    provider: providerInfo, champion: { id: champion.id, fingerprint: champion.fingerprint },
    llmConfig, budgets: { runTokenBudget, runCallBudget, maxWallMinutes },
    preregistration: prereg ? { path: prereg.path, planHash: prereg.planHash } : null,
    strata: planStrata,
  };
  const planOut = value('--plan-out');
  if (planOut) {
    const path = resolve(planOut);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
    console.log(`计划已写入 ${path}`);
  }
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const runConfig = {
  schema: 'century-llm-experiment-config-v1',
  experimentId, stage, modes, seedsPerMode, offset,
  focusSeatRotation: 'pairIndex % seatCount（同一阶段/人数内均衡轮换）',
  opponentPool: 'frozen-champion-all-non-focus-seats',
  champion: { id: champion.id, fingerprint: champion.fingerprint, sourceSha256: champion.sourceSha256 },
  provider: providerInfo,
  llmConfig, budgets: { runTokenBudget, runCallBudget, maxWallMinutes, concurrency },
  preregistration: prereg ? { path: prereg.path, planHash: prereg.planHash, lockedAt: prereg.plan.lockedAt } : null,
  codeVersion: codeVersion(),
  evidenceClass: providerKind === 'mock' ? 'mock' : 'real-llm',
};
const store = resume
  ? RunStore.open(root, runId)
  : RunStore.create({ root, runId, runConfig, providerInfo });

if (resume) {
  const previous = store.run.config ?? {};
  if (previous.stage !== stage) throw new Error(`恢复运行 stage 不一致：${previous.stage} vs ${stage}`);
  if (previous.provider?.model !== providerInfo.model) throw new Error(`恢复运行模型不一致：${previous.provider?.model} vs ${providerInfo.model}`);
}

const existingPairs = new Set(store.pairRecords().map(p => p.pairId));
const tasks = [];
for (const mode of modes) {
  const { seeds, focusSeats } = planStrata[mode];
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const focusSeat = focusSeats[i];
    const ids = gameIds({ experimentId, stage, mode, seed, focusSeat, arm: '' });
    const pairId = ids.pairId;
    if (existingPairs.has(pairId)) continue;
    tasks.push({ mode, seed, focusSeat, pairId, index: i });
  }
}
if (tasks.length > maxPairs) tasks.length = maxPairs;

let usage = scanUsage(store);
let completed = 0;
let stopping = false;
const startedAt = Date.now();
const stopByWall = () => Date.now() - startedAt > maxWallMinutes * 60_000;
const budgetExhausted = () => usage.tokens >= runTokenBudget || usage.calls >= runCallBudget || stopByWall();
process.on('SIGINT', () => { stopping = true; console.error('收到 SIGINT：停止调度新配对，等待运行中对局结束…'); });
process.on('SIGTERM', () => { stopping = true; });

async function runPair(task) {
  if (stopping || budgetExhausted()) return null;
  const { mode, seed, focusSeat, pairId } = task;
  const idsB = gameIds({ experimentId, stage, mode, seed, focusSeat, arm: 'B' });
  const idsA = gameIds({ experimentId, stage, mode, seed, focusSeat, arm: 'A' });
  const versions = frozenVersions(champion, mode);
  const b = await runGame({
    store, gameId: idsB.gameId, seed, seatCount: mode, focusSeat, arm: 'champion',
    versions, championParameters: champion.parameters,
    experimentId, pairId, channel: 'experiment',
  });
  if (b.status !== 'finished') {
    const pair = {
      schema: 'century-llm-pair-v1', pairId, experimentId, stage, mode, seed, focusSeat,
      armA: { gameId: idsA.gameId, status: 'skipped', reason: 'champion arm anomaly' },
      armB: summarizeArm(b), anomaly: true, delta: null,
      createdAt: new Date().toISOString(),
    };
    store.appendPair(pair);
    completed++;
    console.log(`[${completed}/${tasks.length}] ${pairId} B异常：${b.anomalyReason}`);
    return pair;
  }
  const a = await runGame({
    store, gameId: idsA.gameId, seed, seatCount: mode, focusSeat, arm: 'llm',
    llmProvider: provider, llmConfig, versions, championParameters: champion.parameters,
    experimentId, pairId, channel: 'experiment',
  });
  usage = scanUsage(store);
  const decisionLatencies = store.loadEnvelopes(idsA.gameId, 'decision')
    .map(e => e.record?.totalLatencyMs).filter(Number.isFinite);
  const pair = {
    schema: 'century-llm-pair-v1', pairId, experimentId, stage, mode, seed, focusSeat,
    armA: summarizeArm(a, decisionLatencies),
    armB: summarizeArm(b),
    anomaly: a.status !== 'finished' || b.status !== 'finished',
    delta: a.status === 'finished' && b.status === 'finished'
      ? (a.focusFirst === true ? 1 : 0) - (b.focusFirst === true ? 1 : 0)
      : null,
    createdAt: new Date().toISOString(),
  };
  store.appendPair(pair);
  completed++;
  console.log(`[${completed}/${tasks.length}] ${pairId} A=${a.status}/${a.focusFirst ? '第一' : a.focusRank} B=${b.status}/${b.focusFirst ? '第一' : b.focusRank} fb=${a.fallbackCount}/${a.llmDecisionCount} tokens=${usage.tokens}`);
  return pair;
}

function summarizeArm(result, decisionLatencies = []) {
  return {
    gameId: result.gameId,
    status: result.status,
    anomalyReason: result.anomalyReason ?? null,
    focusFirst: result.focusFirst ?? null,
    focusRank: result.focusRank ?? null,
    focusScore: result.focusScore ?? null,
    focusGolems: result.focusGolems ?? null,
    winnerSeat: result.winnerSeat ?? null,
    moves: result.moves ?? null,
    wallMs: result.wallMs ?? null,
    replayConsistent: result.replayConsistency?.ok ?? null,
    llmDecisions: result.llmDecisionCount ?? 0,
    fallbackCount: result.fallbackCount ?? 0,
    tokens: result.llmUsage?.totalTokens ?? 0,
    decisionLatencies,
  };
}

async function worker() {
  while (!stopping) {
    if (budgetExhausted()) {
      stopping = true;
      console.error(`预算/墙钟耗尽：tokens=${usage.tokens}/${runTokenBudget} calls=${usage.calls}/${runCallBudget} wall=${Math.round((Date.now() - startedAt) / 60000)}min`);
      break;
    }
    const task = tasks.shift();
    if (!task) break;
    try {
      await runPair(task);
    } catch (error) {
      console.error(`配对 ${task.pairId} 失败：${error instanceof Error ? error.message : error}`);
      store.note(`配对失败 ${task.pairId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const workers = Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, () => worker());
await Promise.all(workers);

const pairs = store.pairRecords();
const status = pairs.length >= plannedPairs
  ? 'completed'
  : (stopping || budgetExhausted()) ? (budgetExhausted() ? 'budget-exhausted' : 'stopped') : 'completed';
const summary = summarizePairs(pairs, modes, stage, plannedPairs, status, usage, providerInfo);
summary.runId = runId;
summary.runPath = store.path;
summary.startedAt = new Date(startedAt).toISOString();
summary.finishedAt = new Date().toISOString();
summary.codeVersion = codeVersion();
summary.champion = { id: champion.id, fingerprint: champion.fingerprint };
summary.preregistration = prereg ? { path: prereg.path, planHash: prereg.planHash, lockedAt: prereg.plan.lockedAt } : null;
mkdirSync(join(store.path, 'analysis'), { recursive: true });
const summaryPath = join(store.path, 'summary.json');
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
store.updateRun({ status, summaryPath });
const manifest = store.finalize({ analysisPath: summaryPath });
if (!has('--no-export')) store.exportJson();
console.log(JSON.stringify({
  runId, runPath: store.path, status,
  plannedPairs, completedPairs: summary.completedPairs, validPairs: summary.validPairs,
  evidenceClass: summary.evidenceClass,
  usage,
  strata: Object.fromEntries(Object.entries(summary.strata).map(([mode, s]) => [mode, {
    pairs: s.validPairs, candidateFirstRate: s.candidateFirstRate, championFirstRate: s.championFirstRate,
    meanPairedDelta: s.meanPairedDelta, deltaCI: s.pairedDeltaCI,
  }])),
  manifest: manifest.counts,
}, null, 2));
