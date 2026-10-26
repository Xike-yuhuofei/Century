/** OpenAI-compatible Provider（浏览器经本地代理；Node 可直连兼容端点）。
 *
 * 安全：API Key 只由调用方通过环境/本地代理注入；本模块不读取环境变量，
 * 不把 Key 写入日志、错误或 ProviderInfo。浏览器构建只使用代理地址（无 Key）。
 */

import type {
  LLMCompletion, LLMCompletionRequest, LLMProvider, LLMProviderInfo, LLMUsage,
} from './types.js';

export type OpenAICompatibleOptions = {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 额外请求头（不得包含密钥；密钥请用 apiKey）。 */
  headers?: Record<string, string>;
  /** 额外请求体（例如某些服务的 thinking 配置）。 */
  body?: Record<string, unknown>;
  mode?: 'real' | 'mock';
};

function endpointFor(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function hostOf(baseUrl: string): string | null {
  try { return new URL(baseUrl).host || null; } catch { return null; }
}

function usageOf(value: unknown): LLMUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const prompt = Number(raw.prompt_tokens ?? 0);
  const completion = Number(raw.completion_tokens ?? 0);
  const total = Number(raw.total_tokens ?? prompt + completion);
  if (![prompt, completion, total].every(Number.isFinite)) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function contentOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        return (item as { text: string }).text;
      }
      return '';
    }).join('');
  }
  return '';
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): LLMProvider {
  const endpoint = endpointFor(options.baseUrl);
  const info: LLMProviderInfo = {
    id: options.id ?? 'openai-compatible',
    kind: 'openai-compatible',
    model: options.model,
    endpointHost: hostOf(options.baseUrl),
    mode: options.mode ?? 'real',
    parameters: { wireApi: 'chat-completions', responseFormat: 'json_object' },
  };
  return {
    info: () => info,
    async complete(request: LLMCompletionRequest): Promise<LLMCompletion> {
      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs));
      const onAbort = () => controller.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
            ...(options.headers ?? {}),
          },
          body: JSON.stringify({
            model: options.model,
            messages: request.messages,
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            stream: false,
            response_format: { type: 'json_object' },
            ...(options.body ?? {}),
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          let message = text;
          try {
            const parsed = JSON.parse(text) as { error?: { message?: string } };
            message = parsed?.error?.message ?? text;
          } catch { /* 保留原文 */ }
          throw new Error(`HTTP ${response.status}: ${String(message).slice(0, 300)}`);
        }
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error('Provider 返回非 JSON 响应');
        }
        const choices = Array.isArray(json.choices) ? json.choices : [];
        const first = choices[0] as Record<string, unknown> | undefined;
        const message = (first?.message ?? {}) as Record<string, unknown>;
        const content = contentOf(message.content);
        if (!content) throw new Error('Provider 返回空 content');
        return {
          text: content,
          effectiveModel: typeof json.model === 'string' ? json.model : options.model,
          providerRequestId: typeof json.id === 'string' ? json.id : null,
          finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : null,
          usage: usageOf(json.usage),
          latencyMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
