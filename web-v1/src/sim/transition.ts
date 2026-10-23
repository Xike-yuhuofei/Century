/** PublicTransition：精确公共状态转移（AI6 第二阶段·任务 C）。
 *
 * 规则权威声明：正式 engine.ts 是唯一规则权威。本文件是同一规则的紧凑整数
 * 实现（无 log / 无 replay / 无完整 Game 深拷贝），逐条镜像 engine 的校验
 * 条件与转移语义；等价性由 tests/public-sim.differential.test.mjs 的
 * 2 万级 differential 对照强制保证（零不一致为验收门）。若出现无法可靠
 * 解决的规则偏差，按任务书要求回退为"正确但较慢"的委托式实现。
 *
 * 镜像清单（与 engine.ts 一一对应）：
 * - applyPlay：创造 / 升级（合法升级顺序、只升黄绿蓝、次数上限）/ 交易（重复次数 1–10、逐次校验库存）
 * - applyAcquire：逐位置支付校验、按支付顺序累积市场卡上奖励、补牌
 * - applyClaim：费用扣除、0 号位铜币→银币回退、1 号位铜银双全才给银币、补牌、终局触发
 * - finishAction：溢出进入弃置阶段（不推进回合）；弃置后重查；座位轮转；
 *   触发终局后完成当前整轮（回到 0 号位结算）
 * - 弃置：必须恰好弃 excess 颗，属于同一玩家当前行动的溢出处理，不推进其他玩家回合
 * - 2–3 人终局门槛 6 张魔像，4–5 人 5 张
 * - 牌库耗尽：翻牌为空时市场不补牌（与 engine.drawMerchant/drawGolem 一致）
 */

import { COLOR_NAMES, count, has, type Action, type Color } from '../engine.js';
import { GOLEM_BY_ID, MERCHANT_BY_ID, type Stock } from '../data.js';
import { removeFromUnseen, type PublicSimState } from './state.js';

const fail = (message: string): never => { throw new Error(message); };
const requireThat = (condition: unknown, message: string) => { if (!condition) fail(message); };
const isColor = (i: number): i is Color => Number.isInteger(i) && i >= 0 && i <= 3;

/** 模拟器内核：公共状态 + 模拟翻牌队列（队列对决策函数物理不可见）。 */
export type SimCore = {
  state: PublicSimState;
  /** 模拟商人翻牌队列（队首 = 下一次翻开）。与真实牌库零关联。 */
  queueMerchant: string[];
  /** 模拟魔像翻牌队列（队首 = 下一次翻开）。 */
  queueGolem: string[];
};

function addStock(target: Stock, delta: readonly number[]): void {
  for (let i = 0; i < 4; i++) target[i] += delta[i];
}

function subStock(target: Stock, delta: readonly number[]): void {
  for (let i = 0; i < 4; i++) target[i] -= delta[i];
}

/** 市场补牌：翻开模拟队列队首商人卡；队列空则不补（镜像 engine.drawMerchant）。
 * 翻开的卡即刻进入该模拟轨迹的公开状态，并从未公开集合移除。 */
function drawMerchant(core: SimCore): void {
  const id = core.queueMerchant.shift();
  if (id) {
    core.state.merchantMarket.push({ id, bonus: [0, 0, 0, 0] });
    removeFromUnseen(core.state.unseenMerchants, id);
  }
}

function drawGolem(core: SimCore): void {
  const id = core.queueGolem.shift();
  if (id) {
    core.state.golemMarket.push(id);
    removeFromUnseen(core.state.unseenGolems, id);
  }
}

/** 行动收尾（镜像 engine.finishAction）：
 * 溢出 → 进入弃置阶段（回合不推进，仍属当前玩家）；
 * 否则推进到下一席位；终局已触发且整轮完成 → finished。 */
function finishAction(core: SimCore): void {
  const s = core.state;
  const player = s.players[s.current];
  if (count(player.stock) > 10) {
    s.phase = 'overflow';
    return;
  }
  player.turns += 1;
  const next = (s.current + 1) % s.playerCount;
  if (s.triggerPlayer !== null && next === 0) {
    s.phase = 'finished';
  } else {
    s.current = next;
    s.turnNumber += 1;
  }
}

function applyPlay(core: SimCore, a: Extract<Action, { type: 'play' }>): void {
  const s = core.state;
  const p = s.players[s.current];
  const idx = p.hand.indexOf(a.cardId);
  requireThat(idx >= 0, '只能打出当前手牌中的商人卡');
  const card = MERCHANT_BY_ID[a.cardId];
  requireThat(!!card, '未知商人卡');
  if (card.kind === 'create') {
    requireThat(!a.steps?.length && a.repeats === undefined, '创造卡不接受额外参数');
    addStock(p.stock, card.output!);
  } else if (card.kind === 'upgrade') {
    const steps = a.steps ?? [];
    requireThat(a.repeats === undefined && steps.length <= card.steps!, `本卡最多升级 ${card.steps} 次`);
    for (const source of steps) {
      requireThat(isColor(source) && source < 3, '只能升级黄、绿、蓝水晶');
      requireThat(p.stock[source] > 0, `没有可升级的${COLOR_NAMES[source]}水晶`);
      p.stock[source]--;
      p.stock[source + 1]++;
    }
  } else {
    const n = a.repeats ?? 1;
    requireThat(Number.isSafeInteger(n) && n >= 1 && n <= 10 && !a.steps?.length, '交易次数无效');
    for (let i = 0; i < n; i++) {
      requireThat(has(p.stock, card.input!), `第 ${i + 1} 次交易的水晶不足`);
      subStock(p.stock, card.input!);
      addStock(p.stock, card.output!);
    }
  }
  p.hand.splice(idx, 1);
  p.played.push(card.id);
  finishAction(core);
}

function applyAcquire(core: SimCore, a: Extract<Action, { type: 'acquire' }>): void {
  const s = core.state;
  const p = s.players[s.current];
  requireThat(Number.isInteger(a.index) && a.index >= 0 && a.index < s.merchantMarket.length, '无效商人卡位置');
  requireThat(Array.isArray(a.payment) && a.payment.length === a.index, `需要支付 ${a.index} 颗水晶`);
  const remaining = [...p.stock] as Stock;
  for (const c of a.payment) {
    requireThat(isColor(c) && remaining[c] > 0, '市场位置费用无效或水晶不足');
    remaining[c]--;
  }
  // 支付顺序决定前序槽位的奖励水晶归属（镜像 engine：逐位置累积）。
  for (let i = 0; i < a.index; i++) s.merchantMarket[i].bonus[a.payment[i]]++;
  const target = s.merchantMarket.splice(a.index, 1)[0];
  addStock(remaining, target.bonus);
  p.stock = remaining;
  p.hand.push(target.id);
  drawMerchant(core);
  finishAction(core);
}

function applyClaim(core: SimCore, a: Extract<Action, { type: 'claim' }>): void {
  const s = core.state;
  const p = s.players[s.current];
  requireThat(Number.isInteger(a.index) && a.index >= 0 && a.index < s.golemMarket.length, '无效魔像卡位置');
  const id = s.golemMarket[a.index];
  const card = GOLEM_BY_ID[id];
  requireThat(has(p.stock, card.cost), '商队水晶不足，无法认领该魔像');
  subStock(p.stock, card.cost);
  p.claimed.push(id);
  // 硬币奖励规则（镜像 engine.applyClaim）：
  // 0 号位：优先铜币（3 分）；铜币耗尽回退银币（1 分）；
  // 1 号位：铜银双全时给银币（1 分）；其余位置无硬币。
  if (a.index === 0 && s.copper > 0) { s.copper--; p.copper++; }
  else if (a.index === 0 && s.copper === 0 && s.silver > 0) { s.silver--; p.silver++; }
  else if (a.index === 1 && s.copper > 0 && s.silver > 0) { s.silver--; p.silver++; }
  s.golemMarket.splice(a.index, 1);
  drawGolem(core);
  // 终局触发：2–3 人 6 张、4–5 人 5 张；触发后完成当前整轮再结算。
  const threshold = s.playerCount >= 4 ? 5 : 6;
  if (p.claimed.length >= threshold && s.triggerPlayer === null) {
    s.triggerPlayer = s.current;
  }
  finishAction(core);
}

/** 执行一步公共状态转移。非法行动抛错（条件与 engine.applyAction 完全一致）。
 * 原地修改 core；分支模拟请先 fork（见 session.ts）。 */
export function stepCore(core: SimCore, action: Action): void {
  const s = core.state;
  requireThat(s.phase !== 'finished', '游戏已经结束');
  const p = s.players[s.current];
  if (s.phase === 'overflow') {
    // 与 engine 一致使用裸 throw：保证 action 收窄为 discard 变体。
    if (action.type !== 'discard') throw new Error('必须先弃置超出上限的水晶');
    const excess = count(p.stock) - 10;
    requireThat(Array.isArray(action.colors) && action.colors.length === excess, `必须弃置恰好 ${excess} 颗`);
    for (const color of action.colors) {
      requireThat(isColor(color) && p.stock[color] > 0, '弃置的水晶不存在');
      p.stock[color]--;
    }
    s.phase = 'turn';
    finishAction(core);
    return;
  }
  requireThat(action.type !== 'discard', '当前无需弃置水晶');
  if (action.type === 'play') applyPlay(core, action);
  else if (action.type === 'acquire') applyAcquire(core, action);
  else if (action.type === 'claim') applyClaim(core, action);
  else if (action.type === 'rest') {
    p.hand.push(...p.played);
    p.played = [];
    finishAction(core);
  } else fail('未知行动类型');
}

/** SimCore 深拷贝：紧凑字段逐项复制，不含 replay/log 等转移无关数据
 * （任务书 A：不得在每个搜索节点复制完整 replay/log）。 */
export function cloneCore(core: SimCore): SimCore {
  const s = core.state;
  return {
    state: {
      playerCount: s.playerCount,
      players: s.players.map(p => ({
        ...p,
        stock: [...p.stock] as Stock,
        hand: [...p.hand],
        played: [...p.played],
        claimed: [...p.claimed],
      })),
      current: s.current,
      merchantMarket: s.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] as Stock })),
      golemMarket: [...s.golemMarket],
      copper: s.copper,
      silver: s.silver,
      phase: s.phase,
      triggerPlayer: s.triggerPlayer,
      turnNumber: s.turnNumber,
      unseenMerchants: [...s.unseenMerchants],
      unseenGolems: [...s.unseenGolems],
    },
    queueMerchant: [...core.queueMerchant],
    queueGolem: [...core.queueGolem],
  };
}
