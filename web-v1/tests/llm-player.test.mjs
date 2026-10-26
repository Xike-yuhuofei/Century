/** LLM 玩家共享层测试：候选合法性、信息公平性、Schema、Mock Provider 与回退。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import { buildObservation, chooseAIAction } from '../dist/js/ai.js';
import {
  buildCandidateSet, buildLLMPrompt, validateLLMResponse, actionKey, createLLMPlayer,
  createMockProvider, verifyEngineAction,
} from '../dist/js/ai/llm/index.js';

const shuffle = (array, random) => {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};
const mulberry32 = seed => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

function game(seed = 42, seats = 3) {
  const names = Array.from({ length: seats }, (_, i) => `P${i}`);
  const aiSeats = Array.from({ length: seats - 1 }, (_, i) => i + 1);
  const g = createGame(names, seed, aiSeats);
  g.players[0].isAI = true;
  return g;
}

function midgame(seed = 42, seats = 3, moves = 12) {
  let g = game(seed, seats);
  for (let i = 0; i < moves && g.phase !== 'finished'; i++) {
    const decision = chooseAIAction(g, { workUnits: 8 });
    g = applyAction(g, decision.action);
  }
  return g;
}

test('候选行动全部通过正式引擎（多人数 × 多局面）', () => {
  let checked = 0;
  for (const seats of [2, 3, 5]) {
    for (const seed of [7, 42]) {
      const g = midgame(seed, seats, 10);
      const view = buildObservation(g);
      const set = buildCandidateSet(view, { candidateLimit: 64 });
      assert.ok(set.candidates.length > 0, '候选集不能为空');
      assert.ok(set.keptCount <= 64);
      for (const candidate of set.candidates) {
        assert.doesNotThrow(() => applyAction(g, candidate.action), `候选 ${candidate.id} 应被正式引擎接受`);
        checked++;
      }
    }
  }
  assert.ok(checked > 30, `候选检查数量异常：${checked}`);
});

test('隐藏牌库顺序改变不改变观察、候选或提示词', () => {
  const positions = [midgame(11, 3, 14), midgame(12, 5, 18)];
  for (const base of positions) {
    const baseView = buildObservation(base);
    const baseSet = buildCandidateSet(baseView);
    const basePrompt = buildLLMPrompt({ view: baseView, candidateSet: baseSet });
    for (let variant = 0; variant < 3; variant++) {
      const shuffled = JSON.parse(JSON.stringify(base));
      const random = mulberry32(9000 + variant);
      shuffled.merchantDeck = shuffle(shuffled.merchantDeck, random);
      shuffled.golemDeck = shuffle(shuffled.golemDeck, random);
      const view = buildObservation(shuffled);
      assert.deepEqual(view, baseView, '隐藏牌库顺序不应进入公开观察');
      const set = buildCandidateSet(view);
      assert.deepEqual(set.candidates.map(c => [c.id, c.action]), baseSet.candidates.map(c => [c.id, c.action]));
      const prompt = buildLLMPrompt({ view, candidateSet: set });
      assert.equal(prompt.system, basePrompt.system);
      assert.equal(prompt.user, basePrompt.user);
      assert.equal(prompt.promptHash, basePrompt.promptHash);
    }
  }
});

test('提示词与候选不包含隐藏牌库字段', () => {
  const g = midgame(21, 5, 20);
  const view = buildObservation(g);
  const set = buildCandidateSet(view);
  const prompt = buildLLMPrompt({ view, candidateSet: set });
  const text = prompt.system + '\n' + prompt.user + '\n' + JSON.stringify(set.candidates);
  assert.equal(/merchantDeck|golemDeck|deckOrder|hiddenDeck/i.test(text), false);
});

test('结构化 Schema：合法响应接受，非法响应拒绝', () => {
  const ids = ['a1', 'a2'];
  const valid = {
    selectedActionId: 'a2', reason: '测试理由', primaryGoal: '测试目标',
    alternativeActions: [{ actionId: 'a1', comparison: '替代' }],
    expectedBenefits: ['收益'], risks: ['风险'], strategyTags: ['engine', '终局'],
  };
  assert.equal(validateLLMResponse(valid, ids).ok, true);
  assert.equal(validateLLMResponse(JSON.stringify(valid), ids).ok, true);
  assert.equal(validateLLMResponse('```json\n' + JSON.stringify(valid) + '\n```', ids).ok, true);
  assert.equal(validateLLMResponse('not json', ids).ok, false);
  assert.equal(validateLLMResponse({ ...valid, selectedActionId: 'nope' }, ids).ok, false);
  assert.equal(validateLLMResponse({ ...valid, reason: '' }, ids).ok, false);
  assert.equal(validateLLMResponse({ ...valid, extra: 1 }, ids).ok, false);
  assert.equal(validateLLMResponse({ ...valid, strategyTags: [] }, ids).ok, true);
  const normalized = validateLLMResponse({ ...valid, strategyTags: ['引擎', '终局', 'unknown'] }, ids);
  assert.deepEqual(normalized.value.strategyTags, ['engine', 'endgame']);
});

test('Mock Provider：成功、超时、非法 JSON、接口失败、Schema 失败均正确标记', async () => {
  const base = midgame(31, 2, 8);
  const context = { gameId: 'test', seed: 31, seatCount: 2, focusSeat: 0, experimentId: 'test', channel: 'test' };
  const cases = [
    { failure: 'none', expected: 'llm', cause: null },
    { failure: 'invalid-json', expected: 'fallback', cause: 'invalid-json' },
    { failure: 'schema-invalid', expected: 'fallback', cause: 'schema-invalid' },
    { failure: 'api-error', expected: 'fallback', cause: 'api-error' },
    { failure: 'timeout', expected: 'fallback', cause: 'timeout' },
  ];
  for (const item of cases) {
    const player = createLLMPlayer({
      provider: createMockProvider({ failure: item.failure }),
      config: { maxRetries: 0, timeoutMs: 60, maxCalls: 5, tokenBudget: 200000, shadowChampion: true },
    });
    const decision = await player.decide(JSON.parse(JSON.stringify(base)), context);
    assert.equal(decision.source, item.expected, `${item.failure} 来源`);
    if (item.cause) assert.equal(decision.record.fallbackCause, item.cause);
    assert.equal(decision.record.engineValidation, item.expected === 'llm' ? 'accepted' : 'fallback-accepted');
    assert.doesNotThrow(() => applyAction(base, decision.action), '最终行动必须合法');
    if (item.expected === 'llm') {
      assert.ok(decision.record.parsed?.reason);
      assert.ok(decision.record.championShadow);
      assert.equal(typeof decision.record.championShadow.agreement, 'boolean');
    } else {
      assert.equal(decision.record.apiFailure, true);
    }
  }
});

test('调用上限与 Token 预算触发合法回退', async () => {
  const g = midgame(41, 2, 6);
  const context = { gameId: 'budget', seed: 41, seatCount: 2, focusSeat: 0, experimentId: 'test', channel: 'test' };
  const limited = createLLMPlayer({
    provider: createMockProvider(), config: { maxCalls: 1, maxRetries: 0, tokenBudget: 200000 },
  });
  const first = await limited.decide(JSON.parse(JSON.stringify(g)), context);
  assert.equal(first.source, 'llm');
  const next = applyAction(g, first.action);
  const second = await limited.decide(JSON.parse(JSON.stringify(next)), context);
  assert.equal(second.source, 'fallback');
  assert.equal(second.record.fallbackCause, 'call-limit');

  const budget = createLLMPlayer({
    provider: createMockProvider(), config: { maxCalls: 5, maxRetries: 0, tokenBudget: 1 },
  });
  const third = await budget.decide(JSON.parse(JSON.stringify(g)), context);
  assert.equal(third.source, 'fallback');
  assert.equal(third.record.fallbackCause, 'token-budget');
});

test('正式引擎拒绝非法行动', () => {
  const g = game(51, 3);
  const bad = { type: 'claim', index: 99 };
  assert.equal(verifyEngineAction(g, bad).ok, false);
  const good = { type: 'rest' };
  assert.equal(verifyEngineAction(g, good).ok, true);
});

test('行动键稳定且支付顺序被视为不同行动', () => {
  const a = { type: 'acquire', index: 2, payment: [0, 1] };
  const b = { type: 'acquire', index: 2, payment: [1, 0] };
  assert.equal(actionKey(a), actionKey({ type: 'acquire', index: 2, payment: [0, 1] }));
  assert.notEqual(actionKey(a), actionKey(b));
});

test('恢复预算与历史重建接口', () => {
  const player = createLLMPlayer({ provider: createMockProvider(), config: {} });
  player.restoreUsage({ calls: 7, tokens: 1234, decisions: 5, fallbacks: 2 });
  assert.deepEqual(player.stats(), { calls: 7, tokens: 1234, decisions: 5, fallbacks: 2, lastError: null });
  player.seedHistory(1, [{ turnNumber: 3, actionSummary: '休息', primaryGoal: '测试', reason: '测试' }]);
  player.reset();
  assert.deepEqual(player.stats(), { calls: 0, tokens: 0, decisions: 0, fallbacks: 0, lastError: null });
});
