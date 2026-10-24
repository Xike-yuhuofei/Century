/** Joint Rollout：真实多人行动时序的联合模拟（AI6 第四阶段·任务 B + C）。
 *
 * 这是本阶段最高优先级任务的落地核心。旧 Beam Search 的推演序列是
 * "我→我→我→我"（纯单代理）；本模块的推演序列是：
 *
 *   我行动 → 下家行动 → 其余玩家按座位行动 → 轮到我再次行动 → ……
 *   → 真实终局 或 视野上限叶子
 *
 * 结构保证（逐条对应任务 B 要求）：
 * 1. 每位玩家只在自己的合法行动节点行动（循环以 sim.view.current 分派）；
 * 2. 对手行动由 Opponent Model V1 采样 / 规则 / 均匀三种模式生成（opponents.ts）；
 * 3. 所有行动经 PublicSimulation.step 精确推进（differential 锚定正式引擎）；
 * 4. 对手认领后目标立即从市场消失（transition.applyClaim 语义，测试强制）；
 * 5. 市场补牌由独立 Belief Sampler 队列处理（root 采样一次，分支共享 = CRN）；
 * 6. 市场变化后我的策略逐决策点重新计算（myRankedActions 每次重入）；
 * 7. 对手提前触发终局被自然处理（finishAction 整轮结算 → finished）；
 * 8. 我只在 current === mySeat 时插入行动——绝不在失去行动机会后继续规划；
 * 9. 轨迹内公共目标竞争相互依赖（同一市场状态，认领互斥）。
 */

import type { Action } from '../engine.js';
import { ranking } from '../engine.js';
import type { PublicSimulation } from '../sim/session.js';
import type { PublicSimState } from '../sim/state.js';
import { GOLEM_BY_ID } from '../data.js';
import { mulberry32 } from '../sim/rng.js';
import { heuristicContext, myRankedActions, discardDecision } from './rollout-policy.js';
import { createOpponentContext, sampleOpponentAction, describe, familyOf } from './opponents.js';
import { evaluateLeaf } from './evaluators.js';
import { PressureCache, profileByName } from './simview.js';
import { CHAMPION_PARAMETERS } from '../ai/parameters.js';
import type {
  JointOpponentMode, JointSearchOptions, LeafEvaluatorLevel,
} from './types.js';

/** 单条轨迹的执行上下文。 */
export type RolloutContext = {
  mySeat: number;
  mode: JointOpponentMode;
  evaluator: LeafEvaluatorLevel;
  horizon: number;
  om: import('../om/index.js').OpponentModel | null;
  profileName?: string;
  /** 墙钟硬上限（预算模式；逐转移检查，超调 ≤ 1 步。固定工作量模式缺省 = 无）。 */
  deadline?: number;
  /** 市场事件采集（轨迹解释；仅选定行动的首条轨迹挂载）。 */
  events?: { transition: number; kind: 'claim' | 'refill'; seat: number; golemId?: string; merchantId?: string }[];
  /** 行动日志（座位时序审计与 Issue #20 轨迹输出；对手行动含 family/p 解释）。 */
  actorLog?: { seat: number; action: Action; transition: number; family?: string; p?: number; label?: string }[];
  /** 对手预测耗时记账（stats.omTimeMs）。 */
  omTimeMs?: { value: number };
  /** 逐步执行日志（PR #26 修复回归测试与逐回合复盘用）：
   * 每次成功 step 后追加 { 实际行动者 = step 前的 state.current, 行动 }。
   * 观测性钩子，不参与决策语义。 */
  stepLog?: { seat: number; action: Action }[];
};

/** 轨迹执行结果。 */
export type RolloutOutcome = {
  value: number;
  transitions: number;
  finished: boolean;
  /** 轨迹终局我的名次（未终局为 null）。 */
  finalRank: number | null;
};

/** 正式规则第一名判定（engine.ranking 平分语义复用）。 */
export function firstPlaceOf(state: PublicSimState, seat: number): boolean {
  const pseudoGame = { players: state.players } as unknown as Parameters<typeof ranking>[0];
  return ranking(pseudoGame)[0]?.id === seat;
}

/** 市场事件差分采集：step 前后魔像/商人市场对比。 */
function collectEvents(before: PublicSimState, after: PublicSimState, transition: number, sink: NonNullable<RolloutContext['events']>): void {
  const actor = before.current;
  for (const id of before.golemMarket) {
    if (!after.golemMarket.includes(id)) {
      sink.push({ transition, kind: 'claim', seat: actor, golemId: id });
    }
  }
  for (const m of before.merchantMarket) {
    if (!after.merchantMarket.some(x => x.id === m.id)) {
      sink.push({ transition, kind: 'refill', seat: actor, merchantId: m.id });
    }
  }
}

/** 从指定模拟状态推进一条完整联合轨迹到终局或视野上限。
 * sim 调用方持有（root 分支或 tree 节点分支）；本函数继续推进并就地修改。 */
export function playJointTrajectory(
  sim: PublicSimulation,
  rng: () => number,
  ctx: RolloutContext,
): RolloutOutcome {
  const mode = ctx.mode;
  const om = ctx.om;
  const opponentCtx = createOpponentContext(mode, om);
  const pressureCache = new PressureCache();
  let transitions = 0;
  let opponentMeta: { family: string; p: number; label: string } | null = null;
  while (!sim.finished && transitions < ctx.horizon) {
    if (ctx.deadline !== undefined && performance.now() > ctx.deadline) break;
    const state = sim.view;
    const actor = state.current;
    // 任务 B.8：行动者只可能是当前席位——己方分支以 current === mySeat 判定，
    // 绝不在失去行动机会后插入规划行动。
    let action: Action | null = null;
    if (actor === ctx.mySeat) {
      if (state.phase === 'overflow') {
        action = { type: 'discard', colors: discardDecision(state.players[actor].stock, state.golemMarket, CHAMPION_PARAMETERS) };
      } else {
        const ctxH = heuristicContext(state, CHAMPION_PARAMETERS, profileByName(ctx.profileName), pressureCache);
        const ranked = myRankedActions(state, actor, ctxH).ranked;
        action = ranked[0]?.action ?? { type: 'rest' };
      }
    } else {
      const sample = sampleOpponentAction(state, rng, opponentCtx, ms => { ctx.omTimeMs && (ctx.omTimeMs.value += ms); });
      action = sample?.action ?? { type: 'rest' };
      if (sample) opponentMeta = { family: sample.family, p: sample.p, label: sample.label };
    }
    if (!action) break;
    const events = ctx.events;
    const actorLog = ctx.actorLog;
    const stepLog = ctx.stepLog;
    const logEntry = () => {
      if (!actorLog) return;
      actorLog.push(opponentMeta
        ? { seat: actor, action, transition: transitions, family: opponentMeta.family, p: opponentMeta.p, label: opponentMeta.label }
        : { seat: actor, action, transition: transitions, family: familyOf(action), label: describe(action) });
    };
    if (events && transitions < 400) {
      const before = sim.view;
      try {
        logEntry();
        sim.step(action);
        collectEvents(before, sim.view, transitions, events);
      } catch {
        // 理论不可达（行动均来自合法枚举）；防御性终止轨迹并按叶子计价。
        break;
      }
    } else {
      try {
        logEntry();
        sim.step(action);
      } catch {
        break;
      }
    }
    stepLog?.push({ seat: actor, action });
    transitions += 1;
    opponentMeta = null;
  }
  const finished = sim.finished;
  const value = evaluateLeaf(sim.view, finished, ctx.mySeat, ctx.evaluator, firstPlaceOf);
  const finalRank = finished ? (firstPlaceOf(sim.view, ctx.mySeat) ? 1 : (ranking({ players: sim.view.players } as unknown as Parameters<typeof ranking>[0]).findIndex(r => r.id === ctx.mySeat) + 1)) : null;
  return { value, transitions, finished, finalRank };
}

/** 试验随机流派生（PR #26 P1-1 修复：多世界采样 + Common Random Numbers）。
 * - world：信念世界索引（0..W-1）——不同 world = 不同未知牌序采样（多世界覆盖）；
 * - replica：同一世界内的对手采样重复索引。
 * 同一 (world, replica) 对跨根行动派生同一随机流 ⇒ 配对比较（CRN）：
 * 根行动间价值差来自行动本身而非对手/翻牌噪声。 */
export function trialRngSeed(simSeed: number, world: number, replica: number): number {
  return ((simSeed >>> 0) ^ Math.imul(world + 1, 0x9E3779B9) ^ Math.imul(replica + 1, 0x85EBCA6B)) >>> 0;
}

/** 根行动联合评估：fork root → 执行根行动 → 推进联合轨迹。
 * world/replica 经 trialRngSeed 派生对手采样随机流（CRN 语义见上）。 */
export function runJointRollout(
  root: PublicSimulation,
  rootAction: Action,
  world: number,
  replica: number,
  simSeed: number,
  ctx: RolloutContext,
): RolloutOutcome {
  const branch = root.fork();
  branch.step(rootAction); // 根行动来自合法枚举；非法立即抛错（暴露缺陷）。
  const rng = mulberry32(trialRngSeed(simSeed, world, replica));
  return playJointTrajectory(branch, rng, ctx);
}

/** 魔像目标标签（轨迹输出）。 */
export function golemLabel(id: string): string {
  return GOLEM_BY_ID[id] ? `${id}(${GOLEM_BY_ID[id].points}分)` : id;
}

export type { JointSearchOptions };
