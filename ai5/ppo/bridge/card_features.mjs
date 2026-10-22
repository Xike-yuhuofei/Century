/** AI 5.0 卡牌特征表（bridge 侧统一特征源）。
 *
 * 只消费公开卡牌数据库（data.js 编译产物，即正式游戏使用的同一份卡表），
 * 不包含任何对局隐藏信息。训练、推理与导出全部通过本模块取特征，
 * 保证 action 编码在训练与推理两侧逐位一致（协议版本见 encode.mjs）。
 */

import { MERCHANT_BY_ID, GOLEM_BY_ID } from '../../../web-v1/dist/js/data.js';

/** 估值权重（与 data/cards.json 的 valuation_weights 一致：黄1 绿2 蓝3 粉4）。
 * 仅供 value_delta 特征使用，不影响任何游戏规则。 */
export const VALUATION_WEIGHTS = [1, 2, 3, 4];

export const stockValue = (stock) => stock.reduce((s, n, i) => s + n * VALUATION_WEIGHTS[i], 0);

/** 商人卡特征（含起始卡）：kind 独热 3 维 + 输入/输出/升级步数/起始标记/价值增量。 */
export const MERCHANT_FEATURES = new Map();
for (const [id, card] of Object.entries(MERCHANT_BY_ID)) {
  const kindOH = card.kind === 'create' ? [1, 0, 0] : card.kind === 'upgrade' ? [0, 1, 0] : [0, 0, 1];
  const input = card.input ?? [0, 0, 0, 0];
  const output = card.output ?? [0, 0, 0, 0];
  const valueDelta = (stockValue(output) - stockValue(input)) / 12;
  MERCHANT_FEATURES.set(id, {
    kindOH,
    input,
    output,
    steps: card.steps ?? 0,
    starter: card.starter === true,
    valueDelta,
  });
}

/** 魔像卡特征。 */
export const GOLEM_FEATURES = new Map();
for (const [id, card] of Object.entries(GOLEM_BY_ID)) {
  GOLEM_FEATURES.set(id, { cost: card.cost, points: card.points });
}
