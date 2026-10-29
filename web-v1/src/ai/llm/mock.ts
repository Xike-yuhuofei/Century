/** 确定性 Mock Provider：仅用于 CI 与本地自动化测试，绝不计入真实 LLM 成绩。 */

import type {
  LLMCompletion, LLMCompletionRequest, LLMProvider, LLMProviderInfo,
} from './types.js';

export type MockFailureMode = 'none' | 'invalid-json' | 'schema-invalid' | 'timeout' | 'api-error';

export type MockProviderOptions = {
  id?: string;
  model?: string;
  failure?: MockFailureMode;
  /** 固定选择某个候选 id；缺省选择 metadata.candidateIds[0]。 */
  selectActionId?: string;
  /** 自定义选择（测试可注入）。 */
  choose?: (request: LLMCompletionRequest) => string | null;
  /** 响应延迟（毫秒），用于超时/异步测试。 */
  delayMs?: number;
};

export function createMockProvider(options: MockProviderOptions = {}): LLMProvider {
  const id = options.id ?? 'mock-llm';
  const model = options.model ?? 'mock-llm-v1';
  const info: LLMProviderInfo = {
    id, kind: 'mock', model, endpointHost: null, mode: 'mock',
    parameters: {
      deterministic: true,
      failure: options.failure ?? 'none',
      note: 'Mock 数据不得作为真实 LLM 成绩对外宣称',
    },
  };
  return {
    info: () => info,
    async complete(request: LLMCompletionRequest): Promise<LLMCompletion> {
      const started = Date.now();
      const delay = options.delayMs ?? 0;
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('mock provider aborted by timeout'));
          };
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      const failure = options.failure ?? 'none';
      if (failure === 'timeout') {
        await new Promise<void>((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('mock timeout')), { once: true });
          setTimeout(() => reject(new Error('mock timeout')), Math.max(5, request.timeoutMs + 20));
        });
      }
      if (failure === 'api-error') throw new Error('mock provider failure (deterministic)');
      const ids = request.metadata?.candidateIds ?? [];
      const chosen = options.selectActionId ?? options.choose?.(request) ?? ids[0] ?? 'missing';
      const selected = failure === 'schema-invalid' ? 'not-a-candidate' : chosen;
      const payload = {
        selectedActionId: selected,
        reason: failure === 'schema-invalid' ? '' : 'Mock 确定性选择（仅测试）',
        primaryGoal: '验证 LLM 数据管线',
        alternativeActions: ids.filter(x => x !== selected).slice(0, 2).map(actionId => ({
          actionId, comparison: 'Mock 替代项',
        })),
        expectedBenefits: ['结构合法', '可复现'],
        risks: ['Mock 不代表真实模型能力'],
        strategyTags: ['risk'],
      };
      const text = failure === 'invalid-json' ? '这不是 JSON {broken' : JSON.stringify(payload);
      const usage = {
        promptTokens: Math.ceil((request.messages.map(m => m.content).join('').length) / 4),
        completionTokens: Math.ceil(text.length / 4),
        totalTokens: 0,
      };
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
      return {
        text,
        effectiveModel: model,
        providerRequestId: `mock-${started}`,
        finishReason: 'stop',
        usage,
        latencyMs: Date.now() - started,
      };
    },
  };
}
