/** ai-runtime 测试共享工具：Node Worker 桥接 + 中局位置采样。
 *
 * 桥接契约（与浏览器 DedicatedWorker 对齐的 WorkerLike）：
 * - postMessage / terminate 与浏览器同语义；
 * - onmessage / onerror 为可写属性（client 会在 spawn 后赋值）。
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const WORKER_URL = fileURLToPath(new URL('./ai-runtime-node-worker.mjs', import.meta.url));

/** 生成与 createAIDecisionClient({ spawn }) 兼容的 Node worker 工厂。 */
export function spawnNodeAIWorker() {
  const nodeWorker = new Worker(WORKER_URL);
  const like = {
    onmessage: null,
    onerror: null,
    postMessage(message) { nodeWorker.postMessage(message); },
    terminate() { return nodeWorker.terminate(); },
  };
  nodeWorker.on('message', message => {
    if (like.onmessage) like.onmessage({ data: message });
  });
  nodeWorker.on('error', error => {
    if (like.onerror) like.onerror({ message: String(error?.message ?? error), preventDefault() {} });
  });
  nodeWorker.on('exit', code => {
    if (code !== 0 && like.onerror) like.onerror({ message: `worker 退出码 ${code}`, preventDefault() {} });
  });
  return like;
}

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 固定种子 mulberry32（与 tests/joint-fairness.test.mjs 同实现）。 */
export const mulberry32 = seed => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 14), 1 | t)) >>> 0;
    return t / 4294967296;
  };
};

/** 采集中局位置（正式规则引擎推进；与 joint-fairness 同口径，开销受控）。 */
export async function midgamePositions(count, { engine, adapter } = {}) {
  const { createGame, applyAction } = engine;
  const positions = [];
  for (let seed = 6100; seed <= 6140 && positions.length < count; seed++) {
    let g = createGame(['A', 'B', 'C', 'D'], seed, [1, 2, 3]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 400 && positions.length < count) {
      if (g.phase === 'turn' && g.turnNumber % 9 === 4 && g.players[g.current].claimed.length === 0) {
        positions.push(JSON.parse(JSON.stringify(g)));
      }
      const r = adapter(g);
      g = applyAction(g, r.action);
      moves++;
    }
  }
  return positions;
}
