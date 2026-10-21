/** AI 5.0 离线推理（TypeScript/Node，任务书 12 / 13）。
 *
 * 职责：
 * - 加载导出的 JSON 权重（evaluation/export_weights.py 产物，base64 f64LE）；
 * - 复用 bridge/encode.mjs 的同一份编码实现（训练/推理编码同源）；
 * - 提供三大稳定接口（OpenEvolve 融合准备，任务书 12.1–12.3）：
 *   1) 局面价值：valueOfObservation(observation) → {value, modelVersion}
 *   2) 行动策略：policyScores(observation, candidates) → 每候选概率
 *   3) 模型版本：manifest → 模型/编码/接口版本 + 权重哈希校验
 *
 * 纯 Node 实现（零依赖、无网络、无训练栈），前向 f64，
 * 与 torch f32 输出的一致性由 tests 保证（容差 1e-4）。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildObservation } from '../../../web-v1/dist/js/ai.js';
import { enumerateCandidates } from '../bridge/action_enum.mjs';
import {
  encodeState, encodeAction,
  STATE_ENCODING_VERSION, ACTION_ENCODING_VERSION, STATE_DIM, ACTION_DIM,
} from '../bridge/encode.mjs';

function decodeF64(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Float64Array(buf.length / 8);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat64(i * 8, true);
  return out;
}

/** 加载导出模型；校验权重哈希（原始字节级）与编码/接口版本。 */
export function loadModel(modelJsonPath) {
  const parsed = JSON.parse(readFileSync(modelJsonPath, 'utf8'));
  const { manifest, weights } = parsed;
  if (manifest.weightsFormat !== 'base64-f64le-v1') {
    throw new Error(`权重格式不符：${manifest.weightsFormat}`);
  }
  if (manifest.stateEncodingVersion !== STATE_ENCODING_VERSION
    || manifest.actionEncodingVersion !== ACTION_ENCODING_VERSION) {
    throw new Error(
      `编码版本不符：模型期望 ${manifest.stateEncodingVersion}/${manifest.actionEncodingVersion}，`
      + `当前实现 ${STATE_ENCODING_VERSION}/${ACTION_ENCODING_VERSION}`);
  }
  if (manifest.interfaceVersion !== 'ai5-inference-v1') {
    throw new Error(`接口版本不符：${manifest.interfaceVersion}`);
  }
  const hash = createHash('sha256');
  for (const name of Object.keys(weights).sort()) {
    const raw = Buffer.from(weights[name], 'base64');
    hash.update(`${name}:${raw.length}:`);
    hash.update(raw);
  }
  if (hash.digest('hex') !== manifest.weightsSha256) {
    throw new Error('权重哈希校验失败：导出文件被篡改或不完整');
  }
  const decoded = {};
  for (const [name, b64] of Object.entries(weights)) decoded[name] = decodeF64(b64);
  return { manifest, weights: decoded, shapes: manifest.shapes };
}

function linear(weights, name, x) {
  // name.weight 形状 [out, in]（f64），name.bias 形状 [out]。
  const W = weights[`${name}.weight`];
  const b = weights[`${name}.bias`];
  const inDim = x.length;
  const outDim = b.length;
  const out = new Float64Array(outDim);
  for (let o = 0; o < outDim; o++) {
    let sum = b[o];
    const rowStart = o * inDim;
    for (let i = 0; i < inDim; i++) sum += W[rowStart + i] * x[i];
    out[o] = sum;
  }
  return out;
}

function reluInPlace(x) {
  for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0;
  return x;
}

/** 推理策略句柄。 */
export class Policy {
  constructor(modelJson) {
    const { manifest, weights } = typeof modelJson === 'string' ? loadModel(modelJson) : modelJson;
    this.manifest = manifest;
    this.weights = weights;
    const arch = manifest.arch;
    this.obsDim = arch.obs_dim;
    this.actDim = arch.act_dim;
    this.hidden = arch.hidden;
    this.actEmbedDim = arch.act_embed_dim;
    this.headHidden = arch.head_hidden;
    this.activation = arch.activation;
  }

  /** 状态嵌入（共享主干）。 */
  embedState(obsVec) {
    let h = Float64Array.from(obsVec);
    for (let i = 0; i < this.hidden.length; i++) {
      h = reluInPlace(linear(this.weights, `trunk.${i * 2}`, h));
    }
    return h;
  }

  /** 候选嵌入（行动编码器，权重跨候选共享）。 */
  embedAction(candVec) {
    return reluInPlace(linear(this.weights, 'act_encoder.0', candVec));
  }

  /** Actor logit（单候选）。 */
  logit(stateEmb, candEmb) {
    const joined = new Float64Array(stateEmb.length + candEmb.length);
    joined.set(stateEmb, 0);
    joined.set(candEmb, stateEmb.length);
    const h = reluInPlace(linear(this.weights, 'act_head.0', joined));
    return linear(this.weights, 'act_head.2', h)[0];
  }

  /** Critic 价值。 */
  value(stateEmb) {
    const h = reluInPlace(linear(this.weights, 'critic.0', stateEmb));
    return linear(this.weights, 'critic.2', h)[0];
  }

  /** —— 接口 1：局面价值（任务书 12.1）——
   * 语义：当前行动者视角的期望终局奖励（与训练 reward 模式一致，rank_win ∈ [0,1]）。
   */
  valueOfObservation(view) {
    const emb = this.embedState(encodeState(view, view.current));
    return {
      value: this.value(emb),
      modelVersion: this.manifest.modelVersion,
      interfaceVersion: this.manifest.interfaceVersion,
      stateEncodingVersion: STATE_ENCODING_VERSION,
    };
  }

  /** —— 接口 2：行动策略（任务书 12.2）——
   * 输入：公开观察 + 候选描述符集合（action_enum.mjs 产物或调用方给定合法候选）。
   * 输出：每候选概率（段内归一化）、logit 与枚举覆盖率。
   */
  policyScores(view, candidates) {
    if (!candidates.length) return { probs: [], logits: [], enumStats: null };
    const emb = this.embedState(encodeState(view, view.current));
    const logits = candidates.map(d => this.logit(emb, this.embedAction(encodeAction(view, d))));
    const max = Math.max(...logits);
    const exps = logits.map(l => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return {
      probs: exps.map(e => e / sum),
      logits,
      modelVersion: this.manifest.modelVersion,
    };
  }

  /** 便捷：枚举候选 + 贪心/采样选择。 */
  choose(view, { greedy = true, rng = Math.random, maxCandidates = 512 } = {}) {
    const { candidates, stats } = enumerateCandidates(view, { maxCandidates });
    if (!candidates.length) throw new Error('无合法候选');
    const { probs } = this.policyScores(view, candidates);
    let index;
    if (greedy) {
      index = probs.reduce((best, p, i) => (p > probs[best] ? i : best), 0);
    } else {
      let acc = rng();
      for (index = 0; index < probs.length - 1; index++) {
        acc -= probs[index];
        if (acc <= 0) break;
      }
    }
    return { index, action: candidates[index], probs, enumStats: stats };
  }

  /** 便捷：从完整 Game 出发（内部只取公开观察）。 */
  chooseFromGame(game, options) {
    return this.choose(buildObservation(game), options);
  }

  /** 向量级接口：直接消费已编码的 obs / 候选矩阵（一致性测试、外部搜索框架接入用）。 */
  policyScoresFromVectors(obsVec, candMat, rows) {
    const emb = this.embedState(Float64Array.from(obsVec));
    const logits = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const cand = Float64Array.from(
        candMat.subarray(r * this.actDim, (r + 1) * this.actDim));
      logits[r] = this.logit(emb, this.embedAction(cand));
    }
    const max = Math.max(...logits);
    const exps = logits.map(l => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(e => e / sum);
  }

  valueFromObsVector(obsVec) {
    return this.value(this.embedState(Float64Array.from(obsVec)));
  }
}

export { STATE_DIM, ACTION_DIM, STATE_ENCODING_VERSION, ACTION_ENCODING_VERSION };
