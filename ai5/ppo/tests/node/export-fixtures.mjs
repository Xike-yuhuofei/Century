/** 导出一致性 fixture 生成器（由 Python 测试通过子进程调用）。
 *
 * 流程：加载导出 JSON → 桥接 worker 随机合法对局推进 → 在每个 MLP 决策点
 * 记录（obs 向量、候选矩阵、TS 推理概率、TS 价值）→ 写 fixtures JSON。
 * Python 侧用同一模型重算概率/价值并对比。
 *
 * 用法：node export-fixtures.mjs <model.json> <out.json> <numStates>
 */

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [, , modelPath, outPath, numStatesArg] = process.argv;
const numStates = Number(numStatesArg ?? 40);

const { Policy, loadModel } = await import('../../inference/policy.mjs');
const policy = new Policy(loadModel(modelPath));

// —— 随机合法对局推进（直接复用 worker 进程） ——
const workerPath = join(here, '../../bridge/env_worker.mjs');
const proc = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const states = [];

function send(msg) { proc.stdin.write(JSON.stringify(msg) + '\n'); }

function decodeLocal(field) {
  const buf2 = Buffer.from(field.b64, 'base64');
  return new Float32Array(buf2.buffer, buf2.byteOffset, buf2.byteLength / 4);
}

function record(msg) {
  // TS 推理：同一模型、同一编码器（向量级接口）。
  const obs = decodeLocal(msg.obs);
  const candMat = decodeLocal(msg.candMat);
  const t0 = performance.now();
  const probs = policy.policyScoresFromVectors(obs, candMat, msg.candMat.rows);
  const value = policy.valueFromObsVector(obs);
  const ms = performance.now() - t0;
  states.push({
    obsB64: msg.obs.b64, obsLen: msg.obs.len,
    candB64: msg.candMat.b64, rows: msg.candMat.rows, cols: msg.candMat.cols,
    probsTS: probs, valueTS: value, tsInferMs: ms,
    enumFull: msg.enum.fullCount, enumKept: msg.enum.keptCount,
  });
}

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'decision') {
      record(msg);
      send({ type: 'action', gameId: msg.gameId, index: (states.length * 7 + 3) % msg.candidates.length });
      if (states.length >= numStates) {
        writeFileSync(outPath, JSON.stringify({
          modelVersion: policy.manifest.modelVersion,
          weightsSha256: policy.manifest.weightsSha256,
          arch: policy.manifest.arch,
          states,
        }));
        proc.kill();
        process.exit(0);
      }
    } else if (msg.type === 'terminal') {
      send({ type: 'game', gameId: (msg.gameId ?? 0) + 1, seed: 500 + states.length, seats: [{ kind: 'mlp' }, { kind: 'mlp' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'neutral' }] });
    }
  }
});

send({ type: 'game', gameId: 0, seed: 42, seats: [{ kind: 'mlp' }, { kind: 'mlp' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'champion' }, { kind: 'node', variant: 'neutral' }] });
setTimeout(() => { console.error('fixture 生成超时'); proc.kill(); process.exit(1); }, 120000);
