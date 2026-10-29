/** Codex CLI Provider（Node-only）：`codex exec --json` 子进程。
 *
 * 认证完全由本机 `codex login`（ChatGPT）管理；本模块不读取、不存储、不输出
 * 任何 API Key。每次决策都是独立的 ephemeral 会话，工作目录为临时空目录，
 * read-only 沙箱，输出由 JSON Schema 约束。
 *
 * 这是当前唯一真实 LLM Provider（用户指定使用 Codex，不使用智谱）。
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DECISION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['selectedActionId', 'reason', 'primaryGoal', 'alternativeActions', 'expectedBenefits', 'risks', 'strategyTags'],
  properties: {
    selectedActionId: { type: 'string' },
    reason: { type: 'string' },
    primaryGoal: { type: 'string' },
    alternativeActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['actionId', 'comparison'],
        properties: {
          actionId: { type: 'string' },
          comparison: { type: 'string' },
        },
      },
    },
    expectedBenefits: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    strategyTags: { type: 'array', items: { type: 'string' } },
  },
};

let cliVersionCache = null;
function codexVersion() {
  if (cliVersionCache !== null) return cliVersionCache;
  try {
    cliVersionCache = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    cliVersionCache = null;
  }
  return cliVersionCache;
}

function killProcess(child) {
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }, 2000).unref?.();
}

function parseEvents(stdout) {
  const texts = [];
  let usage = null;
  let threadId = null;
  let turnError = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
    if (event.type === 'item.completed') {
      const item = event.item ?? {};
      if (item.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text);
    }
    if (event.type === 'turn.completed') {
      const raw = event.usage ?? {};
      usage = {
        promptTokens: Number(raw.input_tokens ?? 0),
        completionTokens: Number(raw.output_tokens ?? 0),
        totalTokens: Number(raw.input_tokens ?? 0) + Number(raw.output_tokens ?? 0),
      };
    }
    if (event.type === 'turn.failed') {
      turnError = String((event.error ?? {}).message ?? 'codex turn failed').slice(0, 400);
    }
    if (event.type === 'error' && event.message) {
      // 非致命错误（如模型元数据提示）不立即失败；turn.failed 才是终止信号。
      if (!turnError && /invalid_request_error|failed/i.test(String(event.message))) {
        turnError = String(event.message).slice(0, 400);
      }
    }
  }
  return { text: texts.join('\n\n').trim(), usage, threadId, turnError };
}

/**
 * @param {object} [options]
 * @param {string} [options.model] Codex 模型 slug（默认 gpt-5.6-sol）
 * @param {'low'|'medium'|'high'} [options.reasoningEffort]
 * @param {string} [options.codexBin]
 * @param {number} [options.maxConcurrency] 仅用于 ProviderInfo 披露（进程池由运行器控制）
 */
export function createCodexProvider(options = {}) {
  const model = options.model ?? 'gpt-5.6-sol';
  const reasoningEffort = options.reasoningEffort ?? 'low';
  const codexBin = options.codexBin ?? 'codex';
  const info = {
    id: 'codex-exec',
    kind: 'codex-cli',
    model,
    endpointHost: null,
    mode: 'real',
    parameters: {
      transport: 'codex exec --json',
      reasoningEffort,
      sandbox: 'read-only',
      ephemeral: true,
      ignoreUserConfig: true,
      outputSchema: 'century-llm-decision-v1',
      cliVersion: codexVersion(),
      maxConcurrency: options.maxConcurrency ?? 1,
    },
  };
  return {
    info: () => info,
    async complete(request) {
      const started = Date.now();
      const workDir = mkdtempSync(join(tmpdir(), 'century-codex-'));
      const schemaPath = join(workDir, 'schema.json');
      const outputPath = join(workDir, 'last-message.json');
      writeFileSync(schemaPath, JSON.stringify(DECISION_SCHEMA, null, 2));
      const prompt = [
        ...request.messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`),
        'Do not call any tools. Do not inspect files. Return only the final JSON object required by the schema.',
      ].join('\n\n');
      const args = [
        'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--sandbox', 'read-only', '-C', workDir,
        '-m', model, '-c', `model_reasoning_effort="${reasoningEffort}"`,
        '--output-schema', schemaPath, '-o', outputPath, '--json', prompt,
      ];
      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn(codexBin, args, {
            cwd: workDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
          });
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            killProcess(child);
            const error = new Error(`Codex 决策超时（${request.timeoutMs}ms）`);
            error.code = 'CODEX_TIMEOUT';
            reject(error);
          }, Math.max(1, request.timeoutMs));
          const onAbort = () => {
            clearTimeout(timer);
            killProcess(child);
            const error = new Error('Codex 决策被取消');
            error.code = 'CODEX_ABORT';
            reject(error);
          };
          if (request.signal?.aborted) onAbort();
          else request.signal?.addEventListener('abort', onAbort, { once: true });
          child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000); });
          child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12_000); });
          child.on('error', error => {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
            reject(new Error(`无法启动 codex CLI：${error.message}`));
          });
          child.on('close', code => {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
            resolve({ code, stdout, stderr });
          });
        });
        const events = parseEvents(result.stdout);
        let text = events.text;
        if (!text && existsSync(outputPath)) {
          text = readFileSync(outputPath, 'utf8').trim();
        }
        if (events.turnError) throw new Error(`Codex 失败：${events.turnError}`);
        if (result.code !== 0 && !text) {
          const tail = result.stderr.split('\n').slice(-3).join(' ').slice(0, 500);
          throw new Error(`codex exec 退出码 ${result.code}：${tail}`);
        }
        if (!text) throw new Error('codex exec 未返回 agent_message');
        return {
          text,
          effectiveModel: model,
          providerRequestId: events.threadId,
          finishReason: 'stop',
          usage: events.usage,
          latencyMs: Date.now() - started,
        };
      } finally {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
      }
    },
  };
}

export const CODEX_DECISION_SCHEMA = DECISION_SCHEMA;
