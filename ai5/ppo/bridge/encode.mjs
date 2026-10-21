/** AI 5.0 状态/行动编码协议（版本化，训练与推理唯一共享源）。
 *
 * 设计原则（任务书 5.4 / 6 / 12.3）：
 * - 编码只消费 AIObservation 公开信息与候选描述符，隐藏牌库顺序不可达；
 * - 布局完全确定、版本化：STATE_ENCODING_VERSION / ACTION_ENCODING_VERSION，
 *   任何布局变更必须升版本并在 tests 中同步 fixture；
 * - 训练（Python 训练器消费向量）与推理（TS 推理模块复用本文件）共享同一实现，
 *   不存在第二套编码实现；Python 侧通过 fixture 一致性测试验证协议理解。
 *
 * 向量以 Float32 序列化；跨进程传输使用 base64(f32LE)（见 packF32/unpackF32）。
 *
 * ============ 状态编码布局 ai5-state-v1（共 STATE_DIM 维） ============
 * [0,3)     阶段独热（turn/overflow/finished）
 * [3,9)     当前行动者席位独热（最多 6 席）
 * [9,15)    观察视角席位（我方）独热
 * [15,22)   终局触发者独热（0-5 席 + 6=无）
 * [22,46)   全局标量（24 维，见 SCALARS）
 * [46,46+6*SEAT_DIM)      逐席位块（最多 6 席，空席全零）
 *   SEAT_DIM = 16 标量 + 45 手牌独热 + 45 已打出独热 + 36 已认领独热 = 142
 * [.] 市场块：6 槽 × (商人独热 45 + 奖励水晶 4 + 位置 1 + 空槽 1) = 6×51
 * [.] 魔像块：5 槽 × (魔像独热 36 + 费用 4 + 分值 1 + 位置 1 + 空槽 1) = 5×43
 *
 * ============ 行动编码布局 ai5-action-v1（共 ACTION_DIM = 84 维） ============
 * [0,7)     行动类型独热（创造/升级/交易/获取/认领/休息/弃置）
 * [7,21)    商人卡特征（类型独热 3 + 输入 4 + 输出 4 + 升级上限 1 + 起始 1 + 价值增量 1）
 * [21,26)   魔像特征（费用 4 + 分值 1）
 * [26,31)   上下文（获取槽位/支付长度/认领槽位/交易次数/升级步数）
 * [31,56)   有序支付编码：5 位 × (颜色独热 4 + 有效位)
 * [56,68)   升级步序编码：3 步 × (来源色独热 3 + 有效位)
 * [68,72)   弃置颜色计数（4）
 * [72,82)   行动后我方水晶预测（库存 4 + 总量 1 + 增量 4）
 * [82,84)   标记（手牌含该卡 / 认领可负担）
 */

import { MERCHANT_BY_ID, GOLEM_BY_ID } from '../../../web-v1/dist/js/data.js';
import { MERCHANT_FEATURES, GOLEM_FEATURES } from './card_features.mjs';

export const STATE_ENCODING_VERSION = 'ai5-state-v1';
export const ACTION_ENCODING_VERSION = 'ai5-action-v1';

export const MERCHANT_IDS = Object.keys(MERCHANT_BY_ID).sort();
export const GOLEM_IDS = Object.keys(GOLEM_BY_ID).sort();
const MERCHANT_INDEX = new Map(MERCHANT_IDS.map((id, i) => [id, i]));
const GOLEM_INDEX = new Map(GOLEM_IDS.map((id, i) => [id, i]));

export const MAX_SEATS = 6;
export const MAX_MARKET_SLOTS = 6;
export const MAX_GOLEM_SLOTS = 5;
const SEAT_SCALARS = 16;
export const SEAT_DIM = SEAT_SCALARS + MERCHANT_IDS.length + MERCHANT_IDS.length + GOLEM_IDS.length; // 142
const MARKET_SLOT_DIM = MERCHANT_IDS.length + 4 + 1 + 1; // 51
const GOLEM_SLOT_DIM = GOLEM_IDS.length + 4 + 1 + 1 + 1; // 43
const SCALAR_DIM = 3 + 6 + 6 + 7 + 24; // 46
export const STATE_DIM = SCALAR_DIM + MAX_SEATS * SEAT_DIM + MAX_MARKET_SLOTS * MARKET_SLOT_DIM + MAX_GOLEM_SLOTS * GOLEM_SLOT_DIM; // 1419

export const ACTION_DIM = 7 + 14 + 5 + 5 + 25 + 12 + 4 + 10 + 2; // 84

const TOTAL = (s) => s.reduce((a, b) => a + b, 0);
const claimThreshold = (seatCount) => (seatCount >= 4 ? 5 : 6);
const seatScore = (p) =>
  p.claimed.reduce((sum, id) => sum + GOLEM_BY_ID[id].points, 0) + p.copper * 3 + p.silver
  + p.stock.slice(1).reduce((a, b) => a + b, 0);

/** 公开观察 → 状态向量（Float32Array）。perspective = 编码视角席位（默认当前席位）。 */
export function encodeState(view, perspective = view.current) {
  const v = new Float32Array(STATE_DIM);
  let o = 0;
  v[o + (view.phase === 'turn' ? 0 : view.phase === 'overflow' ? 1 : 2)] = 1; o += 3;
  v[o + view.current] = 1; o += 6;
  v[o + perspective] = 1; o += 6;
  v[o + (view.triggerPlayer === null ? 6 : view.triggerPlayer)] = 1; o += 7;

  const seatCount = view.players.length;
  const threshold = claimThreshold(seatCount);
  const me = view.players[perspective];
  const maxClaimed = Math.max(...view.players.map(p => p.claimed.length));
  // 公开可推导的未翻开牌数：牌库构成公开，减去全部可见卡。
  const drawnMerchants = view.merchantMarket.filter(Boolean).length
    + view.players.reduce((s, p) => s + p.hand.length + p.played.length, 0);
  const drawnGolems = view.golemMarket.length
    + view.players.reduce((s, p) => s + p.claimed.length, 0);
  const unseenMerchants = Math.max(0, MERCHANT_IDS.length - 2 - drawnMerchants); // 牌库 43 张（不含起始卡）
  const unseenGolems = Math.max(0, GOLEM_IDS.length - drawnGolems);
  const myScore = seatScore(me);
  const bestOther = Math.max(...view.players.filter(p => p.id !== perspective).map(p => seatScore(p)), 0);

  const scalars = [
    view.turnNumber / 150,
    view.copper / 10, view.silver / 10,
    seatCount / 6, threshold / 6,
    me.claimed.length / threshold, maxClaimed / threshold,
    unseenMerchants / 43, unseenGolems / 36,
    view.golemMarket.length / 5, view.merchantMarket.filter(Boolean).length / 6,
    Math.max(0, TOTAL(me.stock) - 10) / 6,
    TOTAL(me.stock) / 10, me.hand.length / 12, me.played.length / 12, me.claimed.length / 6,
    myScore / 70, bestOther / 70, (myScore - bestOther) / 40,
    (threshold - me.claimed.length) / 6,
    unseenMerchants / Math.max(1, MERCHANT_IDS.length - 2), unseenGolems / GOLEM_IDS.length,
    view.copper / Math.max(1, seatCount * 2), view.silver / Math.max(1, seatCount * 2),
  ];
  for (const x of scalars) v[o++] = x;

  // —— 逐席位块 ——
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    const p = view.players[seat];
    if (!p) { o += SEAT_DIM; continue; }
    p.stock.forEach((n, c) => { v[o + c] = n / 10; });
    v[o + 4] = TOTAL(p.stock) / 10;
    v[o + 5] = p.hand.length / 12;
    v[o + 6] = p.played.length / 12;
    v[o + 7] = p.claimed.length / 6;
    v[o + 8] = p.copper / 2;
    v[o + 9] = p.silver / 2;
    v[o + 10] = p.turns / 40;
    v[o + 11] = seatScore(p) / 70;
    v[o + 12] = seat === view.current ? 1 : 0;
    v[o + 13] = seat === perspective ? 1 : 0;
    v[o + 14] = view.triggerPlayer === seat ? 1 : 0;
    v[o + 15] = seatCount - 1 - seat >= 0 && seat < seatCount ? 1 : 0;
    o += SEAT_SCALARS;
    for (const id of p.hand) { const i = MERCHANT_INDEX.get(id); if (i !== undefined) v[o + i] = 1; }
    o += MERCHANT_IDS.length;
    for (const id of p.played) { const i = MERCHANT_INDEX.get(id); if (i !== undefined) v[o + i] = 1; }
    o += MERCHANT_IDS.length;
    for (const id of p.claimed) { const i = GOLEM_INDEX.get(id); if (i !== undefined) v[o + i] = 1; }
    o += GOLEM_IDS.length;
  }

  // —— 商人市场块 ——
  for (let slot = 0; slot < MAX_MARKET_SLOTS; slot++) {
    const offer = view.merchantMarket[slot];
    if (offer) {
      const i = MERCHANT_INDEX.get(offer.id);
      if (i !== undefined) v[o + i] = 1;
      offer.bonus.forEach((n, c) => { v[o + MERCHANT_IDS.length + c] = n / 6; });
      v[o + MERCHANT_IDS.length + 4] = slot / 5;
    } else {
      v[o + MERCHANT_IDS.length + 5] = 1;
    }
    o += MARKET_SLOT_DIM;
  }

  // —— 魔像市场块 ——
  for (let slot = 0; slot < MAX_GOLEM_SLOTS; slot++) {
    const id = view.golemMarket[slot];
    if (id) {
      const i = GOLEM_INDEX.get(id);
      if (i !== undefined) v[o + i] = 1;
      const g = GOLEM_FEATURES.get(id);
      g.cost.forEach((n, c) => { v[o + GOLEM_IDS.length + c] = n / 8; });
      v[o + GOLEM_IDS.length + 4] = g.points / 40;
      v[o + GOLEM_IDS.length + 5] = slot / 5;
    } else {
      v[o + GOLEM_IDS.length + 6] = 1;
    }
    o += GOLEM_SLOT_DIM;
  }
  return v;
}

/** 行动后我方水晶库存预测（与引擎对行动者库存的语义一致；硬币不计入水晶）。 */
export function predictedStockAfter(view, descriptor) {
  const me = view.players[view.current];
  const s = [...me.stock];
  const applyColor = (c) => { s[c]--; s[c + 1]++; };
  switch (descriptor[0]) {
    case 'P': {
      const f = MERCHANT_FEATURES.get(descriptor[1]);
      f.output.forEach((n, c) => { s[c] += n; });
      break;
    }
    case 'U':
      descriptor[2].forEach(applyColor);
      break;
    case 'T': {
      const f = MERCHANT_FEATURES.get(descriptor[1]);
      for (let i = 0; i < descriptor[2]; i++) {
        f.input.forEach((n, c) => { s[c] -= n; });
        f.output.forEach((n, c) => { s[c] += n; });
      }
      break;
    }
    case 'A': {
      const offer = view.merchantMarket[descriptor[1]];
      descriptor[2].forEach(c => { s[c]--; });
      if (offer) offer.bonus.forEach((n, c) => { s[c] += n; });
      break;
    }
    case 'C': {
      const g = GOLEM_FEATURES.get(view.golemMarket[descriptor[1]]);
      if (g) g.cost.forEach((n, c) => { s[c] -= n; });
      break;
    }
    case 'R': break;
    case 'D':
      descriptor[1].forEach((n, c) => { s[c] -= n; });
      break;
  }
  return s;
}

/** 候选描述符 → 行动向量（Float32Array[ACTION_DIM]）。 */
export function encodeAction(view, descriptor) {
  const v = new Float32Array(ACTION_DIM);
  const [type, a, b] = descriptor;
  const typeIdx = { P: 0, U: 1, T: 2, A: 3, C: 4, R: 5, D: 6 }[type];
  v[typeIdx] = 1;
  let o = 7;
  if (type === 'P' || type === 'U' || type === 'T' || type === 'A') {
    const cardId = type === 'A' ? view.merchantMarket[a]?.id : a;
    const f = cardId ? MERCHANT_FEATURES.get(cardId) : null;
    if (f) {
      f.kindOH.forEach((x, i) => { v[o + i] = x; });
      f.input.forEach((n, c) => { v[o + 3 + c] = n / 8; });
      f.output.forEach((n, c) => { v[o + 7 + c] = n / 8; });
      v[o + 11] = f.steps / 3;
      v[o + 12] = f.starter ? 1 : 0;
      v[o + 13] = f.valueDelta;
    }
  }
  o += 14;
  if (type === 'C') {
    const g = GOLEM_FEATURES.get(view.golemMarket[a]);
    if (g) {
      g.cost.forEach((n, c) => { v[o + c] = n / 8; });
      v[o + 4] = g.points / 40;
    }
  }
  o += 5;
  const me = view.players[view.current];
  v[o] = type === 'A' ? a / 5 : 0;
  v[o + 1] = type === 'A' ? b.length / 5 : 0;
  v[o + 2] = type === 'C' ? a / 5 : 0;
  v[o + 3] = type === 'T' ? b / 10 : 0;
  v[o + 4] = type === 'U' ? b.length / 3 : 0;
  o += 5;
  if (type === 'A') {
    b.forEach((color, pos) => {
      if (pos < 5) { v[o + pos * 5 + color] = 1; v[o + pos * 5 + 4] = 1; }
    });
  }
  o += 25;
  if (type === 'U') {
    b.forEach((src, pos) => {
      if (pos < 3) { v[o + pos * 4 + src] = 1; v[o + pos * 4 + 3] = 1; }
    });
  }
  o += 12;
  if (type === 'D') {
    // 弃置描述符为 ['D', counts]：counts 在 a（双元素描述符）。
    a.forEach((n, c) => { v[o + c] = n / 6; });
  }
  o += 4;
  const after = predictedStockAfter(view, descriptor);
  after.forEach((n, c) => { v[o + c] = n / 10; });
  v[o + 4] = TOTAL(after) / 10;
  after.forEach((n, c) => { v[o + 5 + c] = (n - me.stock[c]) / 8; });
  o += 10;
  v[o] = type === 'P' || type === 'U' || type === 'T' ? 1 : 0;
  v[o + 1] = type === 'C' ? 1 : 0;
  return v;
}

/** 批量编码：状态向量 + 候选矩阵 + 全量统计。 */
export function encodeDecision(view, candidates) {
  const obs = encodeState(view, view.current);
  const mat = new Float32Array(candidates.length * ACTION_DIM);
  candidates.forEach((d, i) => mat.set(encodeAction(view, d), i * ACTION_DIM));
  return { obs, candMat: mat };
}

/** f32 → base64（LE），跨进程传输。 */
export function packF32(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return Buffer.from(bytes).toString('base64');
}

/** base64 → Float32Array。 */
export function unpackF32(b64, expectedLength) {
  const buf = Buffer.from(b64, 'base64');
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (expectedLength !== undefined && arr.length !== expectedLength) {
    throw new Error(`向量长度不符：期望 ${expectedLength}，实际 ${arr.length}`);
  }
  return arr;
}
