/** 串行/限并发 Provider 包装：免费接口共用。
 *
 * - 每个 Provider 实例内部维护队列，默认并发 1；
 * - 可配置最小请求间隔，避免免费额度短时间被打满；
 * - 对 429/1305/rate-limit 做指数退避；
 * - 统一覆盖 maxTokens（免费推理模型可能把额度耗在 reasoning 上）；
 * - 不读取/记录密钥；info 由调用方构造，必须已脱敏。
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function defaultIsRateLimit(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /HTTP\s*429|1305|访问量过大|rate.?limit|too many requests|temporarily rate-limited/i.test(text);
}

/**
 * @param {object} options
 * @param {object} options.innerProvider
 * @param {object} options.info
 * @param {number} [options.maxConcurrency]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.maxTokens]
 * @param {number} [options.maxRateLimitRetries]
 * @param {number} [options.retryBaseMs]
 * @param {number} [options.retryMaxMs]
 * @param {(error:unknown)=>boolean} [options.isRateLimit]
 */
export function createQueuedProvider(options) {
  const inner = options.innerProvider;
  const info = options.info;
  const maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? 0));
  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? 2000));
  const maxRateLimitRetries = Math.max(0, Math.floor(options.maxRateLimitRetries ?? 6));
  const retryBaseMs = Math.max(5, Math.floor(options.retryBaseMs ?? 5000));
  const retryMaxMs = Math.max(retryBaseMs, Math.floor(options.retryMaxMs ?? 60000));
  const isRateLimit = options.isRateLimit ?? defaultIsRateLimit;

  let active = 0;
  const waiters = [];
  let nextStartAt = 0;

  async function acquire() {
    if (active < maxConcurrency) { active += 1; return; }
    await new Promise(resolve => waiters.push(resolve));
  }
  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) { active += 1; next(); }
  }
  async function throttle() {
    const wait = Math.max(0, nextStartAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextStartAt = Date.now() + minIntervalMs;
  }

  return {
    info: () => info,
    async complete(request) {
      await acquire();
      try {
        let lastError = null;
        for (let attempt = 0; attempt <= maxRateLimitRetries; attempt++) {
          await throttle();
          try {
            return await inner.complete({ ...request, maxTokens });
          } catch (error) {
            lastError = error;
            if (!isRateLimit(error) || attempt >= maxRateLimitRetries) throw error;
            const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** attempt)) + Math.floor(Math.random() * 500);
            await sleep(delay);
          }
        }
        throw lastError ?? new Error('Provider 请求失败');
      } finally {
        release();
      }
    },
  };
}
