/** 浏览器 DedicatedWorker 入口（module worker）。
 *
 * 薄壳：把 self 消息事件桥接到环境无关的 worker-core（见 ./worker-core.ts）。
 * 决策、协议、防火墙逻辑全部在 worker-core——Node 测试与浏览器同核。
 *
 * 构建路径：
 * - 桌面 ESM 页面：dist/js/ai-runtime/worker.js 由 tsc 直接产出，以
 *   `new Worker(url, { type: 'module' })` 创建（需同源 http 服务）；
 * - 离线单文件 HTML：见 OVERNIGHT-REPORT.md 的独立实现方案（本文件不变）。
 */

import { createAIWorkerCore } from './worker-core.js';
import type { AIWorkerResponse } from './protocol.js';

type WorkerScope = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: AIWorkerResponse): void;
};

const scope = self as unknown as WorkerScope;
const core = createAIWorkerCore(message => scope.postMessage(message));
scope.onmessage = (event: { data: unknown }) => core.handleMessage(event.data);
