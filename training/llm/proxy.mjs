#!/usr/bin/env node
/** 本地 Codex 代理（浏览器 LLM 玩家的唯一接入点）。
 *
 * - 只监听 127.0.0.1（可用 LLM_PROXY_HOST/PORT 覆盖）；
 * - 浏览器不持有任何 API Key；认证由本机 `codex login`（ChatGPT）管理；
 * - 提供最小 OpenAI-compatible `/v1/chat/completions`，把消息转给 Codex CLI；
 * - CORS 仅允许 localhost / 127.0.0.1 / GitHub Pages 源；处理 Private Network Access 预检；
 * - 不记录提示词、响应或任何凭证，只记录方法/路径/状态/耗时；
 * - 全局并发上限（默认 2），超限返回 429，避免并发 Codex 进程压垮本机。
 */

import { createServer } from 'node:http';
import { createCodexProvider } from './provider-codex.mjs';

const host = process.env.LLM_PROXY_HOST || '127.0.0.1';
const port = Number(process.env.LLM_PROXY_PORT || 8787);
const model = process.env.LLM_CODEX_MODEL || 'gpt-5.6-sol';
const reasoningEffort = process.env.LLM_CODEX_REASONING || 'low';
const maxConcurrency = Math.max(1, Number(process.env.LLM_PROXY_CONCURRENCY || 2));
const defaultTimeoutMs = Math.max(1000, Number(process.env.LLM_PROXY_TIMEOUT_MS || 150000));
const maxBodyBytes = 2 * 1024 * 1024;
const allowedOrigins = new Set([
  'https://xike-yuhuofei.github.io',
  'http://localhost:4173', 'http://127.0.0.1:4173',
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:8080', 'http://127.0.0.1:8080',
  'http://localhost:8788', 'http://127.0.0.1:8788',
]);

const provider = createCodexProvider({ model, reasoningEffort, maxConcurrency });
let active = 0;

function corsHeaders(origin) {
  const allowed = origin && (allowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-LLM-Proxy-Token',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  };
}

function send(res, status, value, origin, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(origin),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error('请求体超过上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.length <= 8 &&
    messages.every(m => m && typeof m.role === 'string' && typeof m.content === 'string' &&
      ['system', 'user', 'assistant'].includes(m.role) && m.content.length <= 120_000);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const origin = req.headers.origin;
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  const finish = status => {
    res.once('finish', () => {
      console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    });
  };
  try {
    if (req.method === 'OPTIONS') {
      finish(204);
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      finish(200);
      send(res, 200, {
        ok: true,
        service: 'century-llm-codex-proxy',
        provider: provider.info(),
        active,
        maxConcurrency,
        note: 'API Key 不经过浏览器；认证由本机 codex login 管理',
      }, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      finish(200);
      send(res, 200, {
        object: 'list',
        data: [{ id: 'codex-exec', object: 'model', owned_by: 'local-codex', created: 0 }],
      }, origin);
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      finish(404);
      send(res, 404, { error: { message: 'Not found' } }, origin);
      return;
    }
    if (active >= maxConcurrency) {
      finish(429);
      send(res, 429, { error: { code: 'busy', message: `本地 Codex 并发已满（${maxConcurrency}），请稍后重试` } }, origin);
      return;
    }
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw); } catch {
      finish(400);
      send(res, 400, { error: { message: '请求体不是合法 JSON' } }, origin);
      return;
    }
    if (!validMessages(payload.messages)) {
      finish(400);
      send(res, 400, { error: { message: 'messages 非法（1–8 条，单条 ≤120000 字符）' } }, origin);
      return;
    }
    active++;
    const requestedModel = typeof payload.model === 'string' ? payload.model : 'codex-exec';
    const timeoutMs = Math.min(240_000, Math.max(5_000, Number(payload.timeout_ms || defaultTimeoutMs)));
    const maxTokens = Math.min(2000, Math.max(64, Number(payload.max_tokens || 700)));
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const completion = await provider.complete({
        messages: payload.messages,
        maxTokens,
        temperature: Number(payload.temperature ?? 0),
        timeoutMs,
        signal: controller.signal,
        metadata: {
          candidateIds: [],
          phase: 'turn',
          turnNumber: 0,
          observationHash: '',
        },
      });
      finish(200);
      send(res, 200, {
        id: completion.providerRequestId || `codex-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: completion.effectiveModel || model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: completion.text },
          finish_reason: completion.finishReason || 'stop',
        }],
        usage: completion.usage ? {
          prompt_tokens: completion.usage.promptTokens,
          completion_tokens: completion.usage.completionTokens,
          total_tokens: completion.usage.totalTokens,
        } : undefined,
        requested_model: requestedModel,
        local_latency_ms: completion.latencyMs,
      }, origin);
    } finally {
      active--;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish(502);
    if (!res.headersSent) send(res, 502, { error: { message: message.slice(0, 400) } }, origin);
    else res.end();
  }
});

server.listen(port, host, () => {
  const info = provider.info();
  console.log(`Century LLM Codex 代理已启动：http://${host}:${port}`);
  console.log(`模型：${info.model} · 推理：${info.parameters.reasoningEffort} · 并发上限：${maxConcurrency}`);
  console.log('浏览器端只需配置代理地址，不需要 API Key；密钥/登录不进入前端。');
  console.log('健康检查：GET /health · OpenAI-compatible：POST /v1/chat/completions');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`收到 ${signal}，关闭代理…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
