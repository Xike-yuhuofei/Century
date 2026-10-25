/** Node worker_threads 桥接（ai-runtime 测试专用）。
 *
 * 与浏览器共用同一份环境无关 worker 核（dist/js/ai-runtime/worker-core.js），
 * 保证 `node --test` 验证的就是浏览器 Worker 将要执行的决策逻辑。
 */
import { parentPort } from 'node:worker_threads';
import { createAIWorkerCore } from '../dist/js/ai-runtime/worker-core.js';

const core = createAIWorkerCore(message => parentPort.postMessage(message));
parentPort.on('message', raw => core.handleMessage(raw));
