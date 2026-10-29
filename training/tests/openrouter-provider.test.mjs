/** OpenRouter 免费模型 Provider 测试：并发、429 退避、密钥不泄露。
 * 全部使用注入 fake inner，不访问网络、不需要真实 OPENROUTER_API_KEY。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterProvider } from '../llm/provider-openrouter.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function completion() {
  return {
    text: '{"selectedActionId":"a1","reason":"ok","primaryGoal":"ok","alternativeActions":[],"expectedBenefits":[],"risks":[],"strategyTags":["risk"]}',
    effectiveModel: 'xingchen-agi/xing4.0-29b-a4b:free',
    providerRequestId: 'fake-or',
    finishReason: 'stop',
    usage: { promptTokens: 80, completionTokens: 30, totalTokens: 110 },
    latencyMs: 4,
  };
}

function fakeInner({ failures = 0, delayMs = 10 } = {}) {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const requests = [];
  return {
    async complete(request) {
      calls += 1;
      requests.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await sleep(delayMs);
        if (calls <= failures) throw new Error('HTTP 429: temporarily rate-limited upstream');
        return completion();
      } finally {
        active -= 1;
      }
    },
    stats: () => ({ calls, maxActive, requests }),
  };
}

test('OpenRouter Provider 默认免费模型、串行、maxTokens 覆盖、信息无密钥', async () => {
  const inner = fakeInner({ delayMs: 12 });
  const provider = createOpenRouterProvider({
    apiKey: 'or-secret-key', innerProvider: inner,
    maxConcurrency: 2, minIntervalMs: 0, maxTokens: 2000,
  });
  const info = provider.info();
  assert.equal(info.id, 'openrouter-free');
  assert.equal(info.kind, 'openai-compatible');
  assert.equal(info.mode, 'real');
  assert.equal(info.model, 'xingchen-agi/xing4.0-29b-a4b:free');
  assert.equal(info.endpointHost, 'openrouter.ai');
  assert.equal(info.parameters.freeTier, true);
  assert.equal(JSON.stringify(info).includes('or-secret-key'), false);
  const results = await Promise.all(Array.from({ length: 4 }, () => provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 700, temperature: 0, timeoutMs: 5000,
  })));
  assert.equal(results.length, 4);
  assert.ok(inner.stats().maxActive <= 2);
  assert.equal(inner.stats().calls, 4);
  assert.ok(inner.stats().requests.every(r => r.maxTokens === 2000));
});

test('OpenRouter Provider 对 429 退避后成功', async () => {
  const inner = fakeInner({ failures: 2, delayMs: 1 });
  const provider = createOpenRouterProvider({
    apiKey: 'test', innerProvider: inner,
    maxConcurrency: 1, minIntervalMs: 0, maxTokens: 2000,
    maxRateLimitRetries: 3, retryBaseMs: 5, retryMaxMs: 20,
  });
  const result = await provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 700, temperature: 0, timeoutMs: 5000,
  });
  assert.ok(result.text.includes('selectedActionId'));
  assert.equal(inner.stats().calls, 3);
});

test('OpenRouter Provider 无密钥 fail-closed', () => {
  assert.throws(() => createOpenRouterProvider({ apiKey: '' }), /OPENROUTER_API_KEY 未配置/);
});

test('OpenRouter Provider 非限流错误立即抛出', async () => {
  const inner = { async complete() { throw new Error('HTTP 404: Provider returned error'); } };
  const provider = createOpenRouterProvider({ apiKey: 'test', innerProvider: inner, minIntervalMs: 0, retryBaseMs: 5 });
  await assert.rejects(() => provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 700, temperature: 0, timeoutMs: 5000,
  }), /HTTP 404/);
});
