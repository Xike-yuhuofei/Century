/** OpenRouter 免费模型备用 Provider（Node-only，OpenAI-compatible）。
 *
 * 默认模型：`xingchen-agi/xing4.0-29b-a4b:free`（2026-10-27 实测结构化 JSON 可用）。
 * 可用 `OPENROUTER_MODEL` 或调用参数覆盖；免费模型不稳定时由 LLMPlayer 回退。
 *
 * 安全与并发：
 * - 密钥只从本机 `OPENROUTER_API_KEY` 读取，不进入仓库/前端/日志/ProviderInfo；
 * - 免费额度默认串行（并发 1）+ 最小间隔 4s（约 15 req/min，低于常见 20/min）；
 * - 429 退避后重试；404/401 等非限流错误立即交由 LLMPlayer 记录并回退。
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
 * @param {string} [options.apiKey] 默认 process.env.OPENROUTER_API_KEY
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number} [options.maxConcurrency]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.maxTokens]
 * @param {number} [options.maxRateLimitRetries]
 * @param {number} [options.retryBaseMs]
 * @param {number} [options.retryMaxMs]
 * @param {object} [options.innerProvider] 测试注入（不访问网络）
 */
export function createOpenRouterProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  const baseUrl = options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const model = options.model ?? process.env.OPENROUTER_MODEL ?? 'xingchen-agi/xing4.0-29b-a4b:free';
  const maxConcurrency = Math.max(1, Math.min(2, Math.floor(options.maxConcurrency ?? numberEnv('OPENROUTER_MAX_CONCURRENCY', 1))));
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? numberEnv('OPENROUTER_MIN_INTERVAL_MS', 4000)));
  const maxTokens = Math.max(400, Math.floor(options.maxTokens ?? numberEnv('OPENROUTER_MAX_TOKENS', 2000)));
  const maxRateLimitRetries = Math.max(0, Math.floor(options.maxRateLimitRetries ?? numberEnv('OPENROUTER_RATE_LIMIT_RETRIES', 6)));
  const retryBaseMs = Math.max(5, Math.floor(options.retryBaseMs ?? numberEnv('OPENROUTER_RETRY_BASE_MS', 5000)));
  const retryMaxMs = Math.max(retryBaseMs, Math.floor(options.retryMaxMs ?? numberEnv('OPENROUTER_RETRY_MAX_MS', 60000)));

  let inner = options.innerProvider;
  if (!inner) {
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY 未配置：请在本机环境变量或受控后端注入，不要在仓库/前端硬编码');
    }
    inner = createOpenAICompatibleProvider({
      id: 'openrouter-free',
      baseUrl,
      apiKey,
      model,
      headers: {
        'HTTP-Referer': 'https://xike-yuhuofei.github.io/Century/',
        'X-Title': 'Century AI',
      },
    });
  }

  const info = {
    id: 'openrouter-free',
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
      note: 'OpenRouter 免费模型；默认串行 + 退避，ProviderInfo 不含密钥',
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

export const OPENROUTER_DEFAULT_MODEL = 'xingchen-agi/xing4.0-29b-a4b:free';
