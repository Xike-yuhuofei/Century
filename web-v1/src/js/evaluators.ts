/** 联合搜索的叶子评价器分层（AI6 第四阶段·任务 D）。
 *
 * 目标量：P(当前玩家最终排名第一 | 状态, 对手模型) 的近似。
 * - 真实到达终局的轨迹：直接用正式规则结算（engine.ranking 语义），
 *   value = 1（第一名）/ 0（其余）——绝不用启发式替代；
 * - 未到终局的叶子：L0–L3 分层评价器输出 (0,1) 的胜率近似（logistic 映射），
 *   层级间严格分离且全部显式标注口径。
 *
 * 诚实性边界（任务 D）：资源估值/分差永远不直接称为"真实获胜概率"；
 * L3 的校准映射由离线脚本（training/joint/calibrate.mjs）在独立种子块上
 * 拟合并写入 l3-calibration.ts；无校准权重时自动回落 L2 并在结果中披露。
 *
 * 价值向量区分玩家（任务 D）：LeafVector 按席位逐玩家给出
 * [score, claimed, engine, crystals]，标量化只发生在明确的比较维度上，
 * 绝不把全部对手合并成一个负效用项。
 */

import { GOLEM_BY_ID } from '../data.js';
import { score as engineScore, type Player } from '../engine.js';
import type { PublicSimState } from '../sim/state.js';
import { reachableStockOf } from './simview.js';
import { VALUES, weighted } from '../ai/knowledge.js';
import { L3_CALIBRATION, type L3Calibration } from './l3-calibration.js';
import type { LeafEvaluatorLevel } from './types.js';

/** logistic 映射：原始 margin → (0,1) 胜率近似。尺度参数（分差尺度 8 分 ≈
 * 一张中档魔像）为 L3 校准前的默认口径；L3 校准时由数据重估。 */
export function logisticWin(margin: number, scale = 8): number {
  return 1 / (1 + Math.exp(-margin / scale));
}

/** 按席位的多玩家价值向量（任务 D：区分玩家的显式向量）。 */
export type LeafVector = {
  seats: number[];
  score: number[];
  claimed: number[];
  engine: number[];
  crystals: number[];
  /** 市场魔像的竞争态势（我的覆盖 vs 最强对手覆盖）。 */
  golems: { id: string; points: number; myCoverage: number; maxRivalCoverage: number }[];
  triggerPlayer: number | null;
  turnNumber: number;
};

export function leafVector(state: PublicSimState, mySeat: number): LeafVector {
  const players = state.players;
  const score = players.map(p => engineScore(p as unknown as Player));
  const claimed = players.map(p => p.claimed.length);
  const engine = players.map(p => p.hand.length + p.played.length);
  const crystals = players.map(p => weighted(p.stock));
  const golems = state.golemMarket.map(id => {
    const goal = GOLEM_BY_ID[id];
    const total = goal ? weighted(goal.cost) : 0;
    const coverageOf = (seat: number) => {
      if (!goal) return 0;
      const reach = reachableStockOf(players[seat].stock, players[seat].hand);
      const covered = goal.cost.reduce((s, n, c) => s + Math.min(n, reach[c]) * VALUES[c], 0);
      return total > 0 ? covered / total : 0;
    };
    const myCoverage = coverageOf(mySeat);
    let maxRivalCoverage = 0;
    for (const p of players) {
      if (p.id === mySeat) continue;
      maxRivalCoverage = Math.max(maxRivalCoverage, coverageOf(p.id));
    }
    return { id, points: goal?.points ?? 0, myCoverage, maxRivalCoverage };
  });
  return { seats: players.map(p => p.id), score, claimed, engine, crystals, golems, triggerPlayer: state.triggerPlayer, turnNumber: state.turnNumber };
}

function maxOther(values: number[], mySeat: number, seats: number[]): number {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (seats[i] === mySeat) continue;
    if (values[i] > max) max = values[i];
  }
  return Number.isFinite(max) ? max : 0;
}

/** L0：当前冠军启发式口径——纯得分差（冠军 routeGrade 的核心信号）。 */
export function evaluateL0(v: LeafVector, mySeat: number): number {
  const my = v.score[v.seats.indexOf(mySeat)] ?? 0;
  return logisticWin(my - maxOther(v.score, mySeat, v.seats));
}

/** L1：相对分数 + 已认领魔像 + 资源状态的多人向量估值（logistic 压缩）。 */
export function evaluateL1(v: LeafVector, mySeat: number): number {
  return logisticWin(l1RawMargin(v, mySeat));
}

/** L1 原始 margin（多人向量标量化；权重显式披露）。 */
export function l1RawMargin(v: LeafVector, mySeat: number): number {
  const i = v.seats.indexOf(mySeat);
  return (v.score[i] - maxOther(v.score, mySeat, v.seats))
    + 0.35 * (v.claimed[i] - maxOther(v.claimed, mySeat, v.seats))
    + 0.12 * (v.engine[i] - maxOther(v.engine, mySeat, v.seats))
    + 0.08 * (v.crystals[i] - maxOther(v.crystals, mySeat, v.seats));
}

/** L2 原始 margin：L1 + 目标竞争覆盖优势 + 终局时间压力（静态公开模型，
 * 不做 Monte Carlo——ETA/Survival 级别的昂贵预测只允许在根节点使用）。
 * - 市场魔像：我的可达覆盖 − 最强对手覆盖，按分值 0.10 加权；
 * - 终局风险：他人触发终局时，领先 +0.5 / 落后 −0.8（终局结算临近）；
 * - 硬币池：领先者对 0/1 号位认领奖励的边际通道。 */
export function l2RawMargin(v: LeafVector, mySeat: number, copperPool: number, silverPool: number): number {
  const i = v.seats.indexOf(mySeat);
  const myScore = v.score[i];
  const maxOpp = maxOther(v.score, mySeat, v.seats);
  let margin = l1RawMargin(v, mySeat);
  for (const g of v.golems) {
    margin += (g.myCoverage - g.maxRivalCoverage) * g.points * 0.10;
  }
  if (v.triggerPlayer !== null) margin += myScore >= maxOpp ? 0.5 : -0.8;
  margin += (myScore >= maxOpp ? 0.08 : 0) * Math.min(4, copperPool + 0.5 * silverPool);
  return margin;
}

/** L2：L1 + 竞争与终局增强（logistic 压缩）。 */
export function evaluateL2(v: LeafVector, mySeat: number, copperPool: number, silverPool: number): number {
  return logisticWin(l2RawMargin(v, mySeat, copperPool, silverPool));
}

/** L3：独立校准的胜率近似（分段线性 P(first | L2 raw margin)）。
 * 无校准权重时回落 L2（在 stats/报告披露）。 */
export function evaluateL3(v: LeafVector, mySeat: number, copperPool: number, silverPool: number, calibration: L3Calibration | null): number {
  if (!calibration || !calibration.valid) return evaluateL2(v, mySeat, copperPool, silverPool);
  const raw = l2RawMargin(v, mySeat, copperPool, silverPool);
  const { knots, values } = calibration.mapping;
  if (raw <= knots[0]) return values[0];
  if (raw >= knots[knots.length - 1]) return values[values.length - 1];
  for (let i = 1; i < knots.length; i++) {
    if (raw <= knots[i]) {
      const t = (raw - knots[i - 1]) / (knots[i] - knots[i - 1] || 1);
      return values[i - 1] + t * (values[i] - values[i - 1]);
    }
  }
  return values[values.length - 1];
}

/** 评价器主入口。finished → 正式规则第一名判定；否则按层级。 */
export function evaluateLeaf(
  state: PublicSimState,
  finished: boolean,
  mySeat: number,
  level: LeafEvaluatorLevel,
  firstPlaceOf: (state: PublicSimState, seat: number) => boolean,
): number {
  if (finished) return firstPlaceOf(state, mySeat) ? 1 : 0;
  const v = leafVector(state, mySeat);
  switch (level) {
    case 'L0': return evaluateL0(v, mySeat);
    case 'L1': return evaluateL1(v, mySeat);
    case 'L2': return evaluateL2(v, mySeat, state.copper, state.silver);
    case 'L3': return evaluateL3(v, mySeat, state.copper, state.silver, L3_CALIBRATION);
  }
}
