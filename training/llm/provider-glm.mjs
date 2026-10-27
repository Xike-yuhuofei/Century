/** GLM 4.7 Flash 备用 Provider（Node-only，OpenAI-compatible）。
 *
 * 用途：Codex 配额/服务不可用时的备用真实 LLM（不参与已发布的 AI10 实验结论）。
 *
 * 安全与并发：
 * - 密钥只从本机环境变量 `GLM_API_KEY` 读取；不得写入仓库、日志、ProviderInfo、
 *   前端或构建产物。推荐 `~/.century-llm/env`（chmod 600）后 source 再启动。
 * - 免费接口默认串行：`GLM_MAX_CONCURRENCY=1`，默认最小请求间隔 3s；
 * - 对 1305/429（上游访问量过大）做指数退避，默认最多 8 次、封顶 60s；
 * - `glm-4.7-flash` 默认关闭 thinking（GLM_THINKING=disabled）：
 *   否则 reasoning tokens 会吃掉 max_tokens，导致 content 为空。
 */

import { createOpenAICompatibleProvider } from '../../web-v1/dist/js/ai/llm/index.js';
import { createQueuedProvider } from './provider-queue.mjs';

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function hostOf(baseUrl) {
  try { return new URL(baseUrl).host || null; } catch { return null; }
}

/**
 * @param {object} [options]
 * @param {string} [options.apiKey] 默认 process.env.GLM_API_KEY
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number} [options.maxConcurrency]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.maxTokens]
 * @param {number} [options.maxRateLimitRetries]
 * @param {number} [options.retryBaseMs]
 * @param {number} [options.retryMaxMs]
 * @param {string} [options.thinking] disabled/enabled；默认 disabled
 * @param {object} [options.innerProvider] 测试注入（不访问网络）
 */
export function createGLMProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.GLM_API_KEY ?? '';
  const baseUrl = options.baseUrl ?? process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4';
  const model = options.model ?? process.env.GLM_MODEL ?? 'glm-4.7-flash';
  const maxConcurrency = Math.max(1, Math.min(4, Math.floor(options.maxConcurrency ?? numberEnv('GLM_MAX_CONCURRENCY', 1))));
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? numberEnv('GLM_MIN_INTERVAL_MS', 3000)));
  const maxTokens = Math.max(800, Math.floor(options.maxTokens ?? numberEnv('GLM_MAX_TOKENS', 2500)));
  const maxRateLimitRetries = Math.max(0, Math.floor(options.maxRateLimitRetries ?? numberEnv('GLM_RATE_LIMIT_RETRIES', 8)));
  const retryBaseMs = Math.max(5, Math.floor(options.retryBaseMs ?? numberEnv('GLM_RETRY_BASE_MS', 5000)));
  const retryMaxMs = Math.max(retryBaseMs, Math.floor(options.retryMaxMs ?? numberEnv('GLM_RETRY_MAX_MS', 60000)));
  const thinking = options.thinking ?? process.env.GLM_THINKING ?? 'disabled';

  let inner = options.innerProvider;
  if (!inner) {
    if (!apiKey) {
      throw new Error('GLM_API_KEY 未配置：请在本机环境变量或受控后端注入，不要在仓库/前端硬编码');
    }
    inner = createOpenAICompatibleProvider({
      id: 'glm-4.7-flash',
      baseUrl,
      apiKey,
      model,
      body: thinking ? { thinking: { type: thinking } } : undefined,
    });
  }

  const info = {
    id: 'glm-4.7-flash',
    kind: 'openai-compatible',
    model,
    endpointHost: hostOf(baseUrl),
    mode: 'real',
    parameters: {
      freeTier: true,
      maxConcurrency,
      minIntervalMs,
      maxTokens,
      maxRateLimitRetries,
      retryBaseMs,
      retryMaxMs,
      thinking: thinking || null,
      note: '免费接口；默认串行 + 退避，ProviderInfo 不含密钥',
    },
  };

  return createQueuedProvider({
    innerProvider: inner,
    info,
    maxConcurrency,
    minIntervalMs,
    maxTokens,
    maxRateLimitRetries,
    retryBaseMs,
    retryMaxMs,
  });
}

export const GLM_DEFAULT_MODEL = 'glm-4.7-flash';
