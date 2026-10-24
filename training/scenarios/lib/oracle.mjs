/** 局部终局求解 oracle（战术基准专用）。
 *
 * 使命：对"终局在即、剩余行动有界"的基准局面，用正式规则引擎做穷举式局部求解，
 * 输出各候选行动下当前席位的名次/得分区间。两条铁律：
 * 1. 只在可精确计算的范围输出 exact 结论；穷举超限或行动后续仍开放（终局未触发
 *    且行动本身不触发）一律如实降级为 conditional / open，绝不假装得到完整最优策略。
 * 2. 穷举使用记录位置中的真实牌库（研究侧 ground truth 口径，标记
 *    exact-under-recorded-deck）；AI 决策输入仍然只有公开观察——oracle 是评估
 *    基准，不是 AI 输入。
 *
 * 对手模型：guaranteed = 其余席位逐一采取对当前席位最不利的合法行动（极大化当前
 * 席位名次、次级极小化其得分）；best = 全部配合当前席位。这两端是穷举精确界，
 * 不是"唯一正确答案"；中间的真实博弈结果留待对局模拟研究。
 *
 * 转移去重：不同支付顺序若收敛到同一后继（状态键逐位相同）只扩张一次；状态键含
 * 完整牌库顺序，保证穷举精确性。节点/时间双上限防意外长跑（固定工作量纪律）。
 */

import { applyAction, score, ranking } from '../../../web-v1/dist/js/engine.js';
import { GOLEM_BY_ID } from '../../../web-v1/dist/js/data.js';
import { buildObservation } from '../../../web-v1/dist/js/ai.js';
import { buildPublicSimState, enumerateLegalActions } from '../../../web-v1/dist/js/sim/index.js';

export class OracleLimitExceeded extends Error {}

const GOLEM_COST = Object.fromEntries(Object.entries(GOLEM_BY_ID).map(([id, g]) => [id, g.cost]));

const stateKey = (g) => JSON.stringify([
  g.players.map(p => [[...p.stock], [...p.hand].sort(), [...p.played].sort(), [...p.claimed].sort(), p.copper, p.silver, p.turns]),
  g.merchantMarket.map(m => [m.id, [...m.bonus]]),
  [...g.golemMarket], [...g.merchantDeck], [...g.golemDeck],
  g.current, g.phase, g.triggerPlayer, g.copper, g.silver,
]);

const step = (g, a) => {
  const next = applyAction(g, a);
  delete next.replay; // 局部求解不消费复盘记录，避免逐行动深拷贝
  return next;
};

/** 名次元组 [名次(小优), 得分(大优)] 的偏序。 */
const betterThan = (a, b) => (a[0] !== b[0] ? a[0] < b[0] : a[1] > b[1]);
const worseThan = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] < b[1]);

/** 有界终局段的精确穷举（转移级去重 + 置换表；置换命中免费，不占预算）。 */
function solveBounded(game, rootSeat, budget) {
  if (game.phase === 'finished') {
    const rank = ranking(game).findIndex(p => p.id === rootSeat) + 1;
    const sc = score(game.players[rootSeat]);
    return { guaranteed: [rank, sc], best: [rank, sc] };
  }
  const key = stateKey(game);
  const memo = budget.memo;
  const cached = memo.get(key);
  if (cached) return cached;
  if (++budget.nodes > budget.nodeCap) throw new OracleLimitExceeded(`节点上限 ${budget.nodeCap}`);
  if (performance.now() - budget.t0 > budget.timeCapMs) throw new OracleLimitExceeded(`时间上限 ${budget.timeCapMs}ms`);

  const successors = new Map(); // 后继状态键 → 首个代表（转移级去重）
  for (const action of enumerateLegalActions(buildPublicSimState(buildObservation(game)), { dedupe: false })) {
    let next;
    try { next = step(structuredClone(game), action); } catch { continue; } // 枚举-引擎一致性由专项测试覆盖
    const k = stateKey(next);
    if (!successors.has(k)) successors.set(k, next);
    budget.edges++;
  }

  const isRootTurn = game.current === rootSeat;
  let g = null, b = null;
  for (const next of successors.values()) {
    const v = solveBounded(next, rootSeat, budget);
    if (g === null) { g = v.guaranteed; b = v.best; continue; }
    if (isRootTurn) {
      if (betterThan(v.guaranteed, g)) g = v.guaranteed;
      if (betterThan(v.best, b)) b = v.best;
    } else {
      if (worseThan(v.guaranteed, g)) g = v.guaranteed;
      if (betterThan(v.best, b)) b = v.best;
    }
  }
  if (g === null) throw new OracleLimitExceeded('无可用后继（枚举全部非法——口径不一致）');
  const result = { guaranteed: g, best: b };
  memo.set(key, result);
  return result;
}

/** 对单个基准局面运行 oracle。
 * 有界性：triggerPlayer !== null（终局圈中，全部行动有界）或某行动本身触发终局
 * （该行动后有界）；其余行动 scope:'open'。节点/时间预算为整个局面共享的固定
 * 工作量，超限的行动逐个降级为 conditional，绝不输出未经穷举的"结论"。
 * 返回 { status, model, actions?, reason?, stats? }；status ∈ exact | partial | exceeded | skipped。 */
export function solveEndgame(position, { nodeCap = 120_000, timeCapMs = 10_000 } = {}) {
  const game = structuredClone(position);
  for (const p of game.players) p.isAI = true;
  const rootSeat = game.current;
  if (game.phase !== 'turn') return { status: 'skipped', reason: `阶段 ${game.phase} 无候选行动`, model: null };
  const budget = { nodeCap, timeCapMs, t0: performance.now(), nodes: 0, edges: 0, memo: new Map() };
  const model = 'exact-under-recorded-deck（guaranteed=对手逐利穷举下界 / best=配合穷举上界；研究侧口径，AI 决策输入仍只有公开观察）';

  const actions = enumerateLegalActions(buildPublicSimState(buildObservation(game)), { dedupe: false });
  const out = { status: 'exact', model, actions: [], stats: null };
  let anyOpen = false;

  for (const action of actions) {
    let next;
    try { next = step(structuredClone(game), action); } catch { continue; }
    const bounded = game.triggerPlayer !== null || next.triggerPlayer !== null;
    if (!bounded) {
      out.actions.push({ actionKeyOf: action, scope: 'open', note: '行动后终局仍未触发，后续事件超出局部求解范围' });
      anyOpen = true;
      continue;
    }
    try {
      const r = solveBounded(next, rootSeat, budget);
      out.actions.push({
        actionKeyOf: action, scope: 'exact',
        guaranteed: { rank: r.guaranteed[0], score: r.guaranteed[1] },
        best: { rank: r.best[0], score: r.best[1] },
      });
    } catch (error) {
      if (!(error instanceof OracleLimitExceeded)) throw error;
      out.actions.push({ actionKeyOf: action, scope: 'conditional', reason: `穷举超限（${error.message}），不输出结论` });
      anyOpen = true;
    }
  }

  out.status = anyOpen ? 'partial' : 'exact';
  out.stats = { nodes: budget.nodes, edges: budget.edges, ms: Math.round(performance.now() - budget.t0), nodeCap, timeCapMs };
  return out;
}

/** 该局面是否值得运行 oracle（生成端筛选，控制固定工作量）。 */
export function oracleEligible(position) {
  if (position.phase !== 'turn') return false;
  if (position.triggerPlayer !== null) return true;
  const target = position.players.length >= 4 ? 5 : 6;
  const me = position.players[position.current];
  if (me.claimed.length !== target - 1) return false;
  return position.golemMarket.some(id => {
    const cost = GOLEM_COST[id];
    return cost && cost.every((c, i) => me.stock[i] >= c);
  });
}
