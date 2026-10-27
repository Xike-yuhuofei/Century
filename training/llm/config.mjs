/** LLM 实时玩家实验配置：冻结冠军、种子分区、Provider 工厂与预算。 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  AI10_LLM_BLOCK, AI10_LLM_SMOKE_BLOCK, AI10_LLM_EXPLORATORY_BLOCK,
  AI10_LLM_CONFIRM_BLOCK, AI10_LLM_SMOKE_MODE_BASE,
  AI10_LLM_EXPLORE_MODE_BASE, AI10_LLM_CONFIRM_MODE_BASE,
  assertInBlock,
} from '../../ai5/lib/seed_policy.mjs';

export const MODES = Object.freeze([2, 3, 4, 5]);
export const STAGES = Object.freeze(['smoke', 'exploratory', 'confirm']);
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_GLM_MODEL = 'glm-4.7-flash';
export const DEFAULT_OPENROUTER_MODEL = 'xingchen-agi/xing4.0-29b-a4b:free';
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function loadChampion() {
  const path = resolve(REPO_ROOT, 'training/champions/champion.json');
  if (!existsSync(path)) throw new Error(`冠军记录不存在：${path}`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const parameters = record.parameters ?? record;
  if (!parameters?.id) throw new Error('冠军记录缺少 parameters.id');
  return {
    record,
    parameters,
    id: parameters.id,
    fingerprint: createHash('sha256').update(JSON.stringify(parameters)).digest('hex'),
    sourcePath: 'training/champions/champion.json',
    sourceSha256: sha256File(path),
  };
}

export function modeBlock(stage, mode) {
  if (!MODES.includes(mode)) throw new Error(`人数模式必须是 2–5：${mode}`);
  if (stage === 'smoke') return { block: AI10_LLM_SMOKE_BLOCK, base: AI10_LLM_SMOKE_MODE_BASE(mode), capacity: 1_000, name: `AI10 LLM smoke ${mode}p` };
  if (stage === 'exploratory') return { block: AI10_LLM_EXPLORATORY_BLOCK, base: AI10_LLM_EXPLORE_MODE_BASE(mode), capacity: 100_000, name: `AI10 LLM exploratory ${mode}p` };
  if (stage === 'confirm') return { block: AI10_LLM_CONFIRM_BLOCK, base: AI10_LLM_CONFIRM_MODE_BASE(mode), capacity: 2_500_000, name: `AI10 LLM confirm ${mode}p` };
  throw new Error(`未知阶段：${stage}`);
}

/** 顺序种子（无随机；同阶段同人数不重叠，跨阶段块物理隔离）。 */
export function stageSeeds(stage, mode, count, offset = 0) {
  if (!Number.isInteger(count) || count <= 0) throw new Error(`count 必须为正整数：${count}`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`offset 必须为非负整数：${offset}`);
  const { block, base, capacity, name } = modeBlock(stage, mode);
  if (offset + count > capacity) {
    throw new Error(`${name} 种子不足：offset=${offset} count=${count} capacity=${capacity}`);
  }
  const seeds = [];
  for (let i = 0; i < count; i++) {
    const seed = base + offset + i;
    assertInBlock(seed, block, `${name} seed`);
    assertInBlock(seed, AI10_LLM_BLOCK, 'AI10 block');
    seeds.push(seed);
  }
  return seeds;
}

/** 平衡席位轮换：同一阶段/人数内，焦点席位按配对序号循环。 */
export function focusSeatFor(pairIndex, seatCount) {
  if (!Number.isInteger(pairIndex) || pairIndex < 0) throw new Error(`pairIndex 非法：${pairIndex}`);
  if (!MODES.includes(seatCount)) throw new Error(`seatCount 非法：${seatCount}`);
  return pairIndex % seatCount;
}

export function gameIds({ experimentId, stage, mode, seed, focusSeat, arm }) {
  const pairId = `${experimentId}-${stage}-${mode}p-${seed}-f${focusSeat}`;
  return { pairId, gameId: `${pairId}-${arm}` };
}

/** 所有非焦点席位冻结为当前冠军（固定对手池 = 冻结冠军本体）。 */
export function frozenVersions(champion, seatCount) {
  return Array.from({ length: seatCount }, () => ({
    id: champion.id,
    parameters: champion.parameters,
    fingerprint: champion.fingerprint,
  }));
}

export function createProvider(options = {}) {
  const kind = options.kind ?? 'codex';
  if (kind === 'mock') {
    const { createMockProvider } = options.dist;
    if (!createMockProvider) throw new Error('mock provider 需要传入 dist 模块');
    return createMockProvider({
      selectActionId: options.mockActionId,
      failure: options.mockFailure,
      delayMs: options.mockDelayMs,
    });
  }
  if (kind === 'codex') {
    const { createCodexProvider } = options.codexModule;
    if (!createCodexProvider) throw new Error('缺少 codex provider 模块');
    return createCodexProvider({
      model: options.model ?? DEFAULT_CODEX_MODEL,
      reasoningEffort: options.reasoningEffort ?? 'low',
      maxConcurrency: options.concurrency ?? 1,
    });
  }
  if (kind === 'glm') {
    const { createGLMProvider } = options.glmModule;
    if (!createGLMProvider) throw new Error('缺少 glm provider 模块');
    return createGLMProvider({
      model: options.model ?? DEFAULT_GLM_MODEL,
      maxConcurrency: 1,
      apiKey: process.env.GLM_API_KEY,
    });
  }
  if (kind === 'openrouter') {
    const { createOpenRouterProvider } = options.openrouterModule;
    if (!createOpenRouterProvider) throw new Error('缺少 openrouter provider 模块');
    return createOpenRouterProvider({
      model: options.model ?? DEFAULT_OPENROUTER_MODEL,
      maxConcurrency: 1,
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  }
  throw new Error(`不支持的 Provider：${kind}（支持 codex|glm|openrouter|mock）`);
}

export function defaultLlmConfig({
  timeoutMs = 120_000, maxRetries = 1, maxTokens = 700,
  maxCallsPerGame = 120, tokenBudgetPerGame = 2_500_000,
  candidateLimit = 64, temperature = 0,
} = {}) {
  return {
    timeoutMs, maxRetries, maxTokens, temperature,
    maxCalls: maxCallsPerGame, tokenBudget: tokenBudgetPerGame,
    candidateLimit, shadowChampion: true,
  };
}

export function providerIdentity(provider) {
  const info = provider.info();
  return {
    id: info.id, kind: info.kind, model: info.model, mode: info.mode,
    endpointHost: info.endpointHost, parameters: info.parameters,
  };
}
