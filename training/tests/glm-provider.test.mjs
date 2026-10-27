/** GLM 4.7 Flash 备用 Provider 测试：并发、429 退避、密钥不泄露。
 * 全部使用注入的 fake inner provider，不访问网络、不需要真实 GLM_API_KEY。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGLMProvider } from '../llm/provider-glm.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function completion(text = '{"ok":true}') {
  return {
    text,
    effectiveModel: 'glm-4.7-flash',
    providerRequestId: 'fake-1',
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    latencyMs: 5,
  };
}

function fakeInner({ failures = 0, delayMs = 10 } = {}) {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const requests = [];
  return {
    info: () => ({ id: 'fake-inner', kind: 'mock', model: 'fake', endpointHost: null, mode: 'mock', parameters: {} }),
    async complete(request) {
      calls += 1;
      requests.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await sleep(delayMs);
        if (calls <= failures) throw new Error('HTTP 429: 1305 该模型当前访问量过大，请您稍后再试');
        return completion();
      } finally {
        active -= 1;
      }
    },
    stats: () => ({ calls, maxActive, requests }),
  };
}

test('GLM Provider 默认串行、maxTokens 覆盖、信息不含密钥', async () => {
  const inner = fakeInner({ delayMs: 15 });
  const provider = createGLMProvider({
    apiKey: 'test-secret-key', innerProvider: inner,
    maxConcurrency: 2, minIntervalMs: 0, maxTokens: 2500,
  });
  const info = provider.info();
  assert.equal(info.kind, 'openai-compatible');
  assert.equal(info.mode, 'real');
  assert.equal(info.model, 'glm-4.7-flash');
  assert.equal(info.parameters.freeTier, true);
  assert.equal(info.parameters.maxConcurrency, 2);
  assert.equal(JSON.stringify(info).includes('test-secret-key'), false);
  const results = await Promise.all(Array.from({ length: 4 }, () => provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 700,
    temperature: 0,
    timeoutMs: 5000,
  })));
  assert.equal(results.length, 4);
  assert.ok(inner.stats().maxActive <= 2, `并发超过上限：${inner.stats().maxActive}`);
  assert.equal(inner.stats().calls, 4);
  assert.ok(inner.stats().requests.every(r => r.maxTokens === 2500));
});

test('GLM Provider 对 1305/429 指数退避后成功', async () => {
  const inner = fakeInner({ failures: 2, delayMs: 1 });
  const provider = createGLMProvider({
    apiKey: 'test', innerProvider: inner,
    maxConcurrency: 1, minIntervalMs: 0, maxTokens: 2500,
    maxRateLimitRetries: 3, retryBaseMs: 5, retryMaxMs: 20,
  });
  const result = await provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 700, temperature: 0, timeoutMs: 5000,
  });
  assert.ok(result.text.includes('ok'));
  assert.equal(inner.stats().calls, 3);
});

test('GLM Provider 在无密钥且无注入时 fail-closed', () => {
  assert.throws(() => createGLMProvider({ apiKey: '' }), /GLM_API_KEY 未配置/);
});

test('GLM Provider 非限流错误立即抛出（交给 LLMPlayer 记录/回退）', async () => {
  const inner = {
    info: () => ({}),
    async complete() { throw new Error('HTTP 401: invalid key'); },
  };
  const provider = createGLMProvider({ apiKey: 'test', innerProvider: inner, minIntervalMs: 0, retryBaseMs: 5 });
  await assert.rejects(() => provider.complete({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 700, temperature: 0, timeoutMs: 5000,
  }), /HTTP 401/);
});
