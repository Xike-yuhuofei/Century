/** LegalActionProvider：公共模拟器的全量合法行动枚举（AI6 第二阶段·任务 D）。
 *
 * 与 ai/planner.ts 的关系：AI5 的 actions() 是搜索用枚举，内含策略性剪枝
 * （支付组合 top-3、每次搜索路径 acquire ≤ 2、非空手牌才休息），不是规则
 * 全量集合。本模块提供与正式引擎逐条对齐的完整合法行动集合，作为正确性
 * 基准；differential harness 对每个位置做"引擎接受集 = 模拟器枚举集"的
 * 双向一致性断言。
 *
 * 枚举口径（与 engine.applyAction 的接受条件严格一致）：
 * - 打出创造卡：1 个动作。
 * - 打出升级卡：所有合法升级步骤序列（长度 0..card.steps，逐步要求当前
 *   库存存在对应颜色；含空序列 steps=[]，engine 允许升级 0 次）。
 * - 打出交易卡：repeats ∈ 1..tradeLimit（engine 导出，含 10 次上限）。
 * - 获取商人卡：对每个市场位置，所有有序支付序列（engine 按支付顺序把
 *   奖励水晶分配给前序槽位，因此不同顺序是不同合法行动、不同后继）。
 * - 认领魔像：所有费用可承担的位置（含 0/1 号位的硬币奖励差异）。
 * - 休息：引擎无条件允许（含空已打出集合），全量口径必须包含。
 * - 弃置（overflow 阶段）：规范排序颜色组合。
 *
 * 可证明等价去重（任务 D 允许，仅在下列可证明后继等价的情形收缩）：
 * - 弃置顺序【必然去重】：弃置 = 对当前玩家库存的逐色独立扣减，不触碰任何
 *   其他字段，任意顺序后继逐位相同（交换律证明）。由于奖励水晶累积可使
 *   超额颗数无上界（真实合法局面），有序枚举是指数级的——因此弃置一律
 *   枚举规范排序组合（多项式级），有序变体是引擎合法但后继恒等的冗余。
 * - 升级步骤序列按"最终库存"去重（不同顺序若终态库存相同则后继等价），
 *   仅在 dedupe 选项开启时启用。
 * - 获取支付顺序【不去重】：顺序改变前序槽位奖励归属 ⇒ 后继不同，全部保留。
 * 未去重（除弃置外）版本始终可用（正确性基准）。
 */

import { count, has, tradeLimit, type Action, type Color } from '../engine.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import type { PublicSimState } from './state.js';

export type LegalEnumerationOptions = {
  /** 可证明后继等价时的动作去重（默认 false = 全量正确性基准）。 */
  dedupe?: boolean;
};

export function enumerateLegalActions(
  state: Readonly<PublicSimState>,
  options?: LegalEnumerationOptions,
): Action[] {
  const result: Action[] = [];
  if (state.phase === 'finished') return result;
  const player = state.players[state.current];
  const dedupe = options?.dedupe === true;

  if (state.phase === 'overflow') {
    const excess = count(player.stock) - 10;
    // 弃置一律输出规范排序组合（顺序与后继可证明无关，见文件头说明）。
    collectDiscards([...player.stock] as Stock, excess, 0, [], result);
    return result;
  }

  // 认领魔像（所有可承担位置）。
  for (let index = 0; index < state.golemMarket.length; index++) {
    if (has(player.stock, GOLEM_BY_ID[state.golemMarket[index]].cost)) {
      result.push({ type: 'claim', index });
    }
  }

  // 打出商人卡（手牌内唯一 id 各枚举一次；同 id 多副本对应同一动作）。
  const seenIds = new Set<string>();
  for (const cardId of player.hand) {
    if (seenIds.has(cardId)) continue;
    seenIds.add(cardId);
    const card = MERCHANT_BY_ID[cardId];
    if (!card) continue;
    if (card.kind === 'create') {
      result.push({ type: 'play', cardId });
    } else if (card.kind === 'upgrade') {
      const seenStocks = dedupe ? new Set<string>() : null;
      collectUpgradeSteps([...player.stock] as Stock, card.steps!, 0, [], cardId, result, seenStocks);
    } else {
      const limit = tradeLimit(player.stock, cardId);
      for (let repeats = 1; repeats <= limit; repeats++) {
        result.push({ type: 'play', cardId, repeats });
      }
    }
  }

  // 休息（引擎无条件允许，全量口径必须包含）。
  result.push({ type: 'rest' });

  // 获取商人卡（每个位置的全体有序支付序列）。
  for (let index = 0; index < state.merchantMarket.length; index++) {
    collectPayments([...player.stock] as Stock, index, 0, [], result);
  }

  return result;
}

/** 升级步骤序列 DFS（undo 式回溯，不拷贝库存）：
 * 每步可选黄(0)/绿(1)/蓝(2)且当前库存 > 0，长度上限 = 卡面 steps；
 * 含空序列（升级 0 次，engine 允许）。前序遍历短序列先出现；
 * dedupe 按最终库存键保留首个（最短路径）代表，整棵子树一并剪除。 */
function collectUpgradeSteps(
  running: Stock,
  maxSteps: number,
  depth: number,
  prefix: Color[],
  cardId: string,
  out: Action[],
  seenStocks: Set<string> | null,
): void {
  if (seenStocks) {
    const key = running.join(',');
    if (seenStocks.has(key)) return;
    seenStocks.add(key);
  }
  out.push({ type: 'play', cardId, steps: [...prefix] });
  if (depth >= maxSteps) return;
  for (let color = 0; color < 3; color++) {
    if (running[color] <= 0) continue;
    running[color]--; running[color + 1]++;
    prefix.push(color as Color);
    collectUpgradeSteps(running, maxSteps, depth + 1, prefix, cardId, out, seenStocks);
    prefix.pop();
    running[color]++; running[color + 1]--;
  }
}

/** 有序支付序列 DFS（长度恰为市场位置 index，engine 要求 payment.length === index）：
 * 每颗水晶从当前库存扣除、颜色可重复；undo 式回溯。
 * 不同支付顺序会改变前序槽位的奖励归属 ⇒ 全部保留，不去重。 */
function collectPayments(
  available: Stock,
  index: number,
  depth: number,
  prefix: Color[],
  out: Action[],
): void {
  if (depth === index) {
    out.push({ type: 'acquire', index, payment: [...prefix] });
    return;
  }
  for (let color = 0; color < 4; color++) {
    if (available[color] <= 0) continue;
    available[color]--;
    prefix.push(color as Color);
    collectPayments(available, index, depth + 1, prefix, out);
    prefix.pop();
    available[color]++;
  }
}

/** 弃置规范组合 DFS：长度恰为超额颗数的非降序颜色组合（多重集 ≤ 库存）。
 * 每个后继等价类恰输出一个代表；undo 式回溯，多项式级规模。 */
function collectDiscards(
  available: Stock,
  excess: number,
  depth: number,
  prefix: Color[],
  out: Action[],
): void {
  if (depth === excess) {
    out.push({ type: 'discard', colors: [...prefix] });
    return;
  }
  const firstColor = prefix.length ? prefix[prefix.length - 1] : 0;
  for (let color = firstColor; color < 4; color++) {
    if (available[color] <= 0) continue;
    available[color]--;
    prefix.push(color as Color);
    collectDiscards(available, excess, depth + 1, prefix, out);
    prefix.pop();
    available[color]++;
  }
}
