/** 版本化算法适配器：联合规划器接入训练/评测的唯一入口（AI6 第四阶段·任务书 §二）。
 *
 * 与正式冠军入口 chooseAIAction 的契约逐项对齐（同参数形态、同溢出处理、
 * 同"搜索转移为快速模型，第一步必须经正式规则引擎复核"的合法性纪律），
 * 但决策核心分派到 JointPlanner——正式网页 AI 路径不 import 本模块，
 * 冠军行为逐位不变；评测经显式 version 注入（版本隔离，禁止静默混用）。
 *
 * 版本注册表（JS 编号 = 本阶段消融编号，非 PR #22 的 B0/B1/B2）：
 * - joint-js1：冠军 + 静态目标存活折扣（beam-contest 结构 + 冠军参数，
 *   委托正式冠军决策入口——零新搜索代码，行为口径与冠军逐位同源）；
 * - joint-js2：JS2 = 本模块联合 rollout + 规则对手；
 * - joint-js3：JS3 = JS2 + Opponent Model V1 对手采样；
 * - joint-js4：JS4 = JS3 + Selective Joint Tree；
 * - joint-js5：JS5 = 冠军引导选择性联合搜索（champion-guided.ts：竞争门控 +
 *   保守覆盖，PR #26 修复后的第二阶段新架构）。
 */

import type { Game, Action, Color } from '../engine.js';
import { applyAction } from '../engine.js';
import { buildObservation } from '../ai/observation.js';
import { CHAMPION_PARAMETERS, validateAIParameters, type AIParameters } from '../ai/parameters.js';
import { trimStock } from '../ai/evaluator.js';
import { chooseAIAction } from '../ai/decision.js';
import type { Profile } from '../ai/profiles.js';
import { createSimulation } from '../sim/session.js';
import { enumerateLegalActions } from '../sim/legal.js';
import { createJointPlanner } from './planner.js';
import { createChampionGuidedPlanner, type ChampionGuidedSearchOptions } from './champion-guided.js';
import { JOINT_VERSIONS, type JointDecision, JointSearchOptions, JointVersionId } from './types.js';

export type JointAdapterOptions = JointSearchOptions & {
  /** 版本 id（必填；未注册版本抛错——禁止静默回退到任何未声明行为）。 */
  version: JointVersionId | string;
  /** 显式人格（缺省中立；训练模拟器按席位映射注入）。 */
  profile?: Profile;
  /** 决策席位（缺省 game.current；非当前席位抛错）。 */
  playerId?: number;
};

export type JointAdapterDecision = {
  action: Action;
  reason: string;
  /** 联合搜索完整决策（joint 版本有值；js1 委托冠军时为 null）。 */
  joint: JointDecision | null;
  version: string;
};

/** planner 实例按版本缓存（无状态；decide 每次独立）。
 * js5（champion-guided）与 joint 版本共用同一显式注入纪律。 */
const planners = new Map<string, ReturnType<typeof createJointPlanner> | ReturnType<typeof createChampionGuidedPlanner>>();
function plannerFor(versionId: string) {
  let p = planners.get(versionId);
  if (!p) {
    const version = JOINT_VERSIONS[versionId as JointVersionId];
    p = version?.kind === 'champion-guided' ? createChampionGuidedPlanner() : createJointPlanner(versionId);
    planners.set(versionId, p);
  }
  return p;
}

/** 联合规划决策入口（训练/评测/未来网页实验路径共用）。
 * 信息边界：完整 Game 仅用于构造 AIObservation 与合法性复核；
 * 决策本体只消费公开观察。 */
export function chooseJointAction(game: Game, options: JointAdapterOptions): JointAdapterDecision {
  const versionId = options.version;
  const version = JOINT_VERSIONS[versionId as JointVersionId];
  if (!version) throw new Error(`未知联合规划版本：${String(versionId)}`);
  const seat = options.playerId ?? game.current;
  if (game.phase === 'finished') throw new Error('游戏结束，无法决策');
  if (game.current !== seat) throw new Error('决策席位不是当前行动者');

  // JS1：冠军 + 静态目标存活折扣 = beam-contest 结构（冠军 beam-rollout +
  // golemSurvivalModel），委托正式冠军入口，保证与冠军代码逐位同源。
  // P0-1 整改（2026-10-25）：基座必须剥离适配器字段——晋级后 CHAMPION_PARAMETERS
  // 携带 adapter='champion-guided'，直接透传会被 decision.ts 静默分派回联合搜索，
  // beam-contest 结构被忽略（js1 实际执行 JS5 的身份污染）。基座 = 冠军参数的
  // 束搜索形态（适配器冠军权重缺省补 1.0 + 结构 beam-rollout，与训练侧
  // beamBaseParameters 同口径）；冠军决策路径（champion-guided 分支）不受影响。
  if (version.kind === 'champion-contest') {
    const beamBase: Record<string, unknown> = { ...CHAMPION_PARAMETERS };
    const wasAdapter = beamBase.adapter !== undefined;
    for (const key of ['adapter', 'jointVersion', 'budgetMs']) delete beamBase[key];
    if (wasAdapter && beamBase.structure === undefined) beamBase.structure = 'beam-rollout';
    const base = validateAIParameters(beamBase as AIParameters);
    const response = chooseAIAction(game, {
      parameters: base,
      structure: 'beam-contest',
      profile: options.profile,
    });
    return { action: response.action, reason: `JS1: ${response.reason}`, joint: null, version: versionId };
  }

  // 溢出：冠军 trimStock 弃置口径（与正式冠军 decision.ts 同一语义）。
  if (game.phase === 'overflow') {
    const p = game.players[seat];
    const discarded = trimStock(p.stock, game.golemMarket, null, CHAMPION_PARAMETERS).discarded as Color[];
    return { action: { type: 'discard', colors: discarded }, reason: '溢出弃置（冠军 trimStock 口径）', joint: null, version: versionId };
  }

  const observation = buildObservation(game, seat);
  const planner = plannerFor(versionId);
  // profile → profileName 映射对全部 joint 版本一致（champion-guided 的冠军基座
  // 与轨迹内策略都必须消费同一人格注入，否则评测席位人格失配——回归审计
  // gate=never vs js0 逐决策一致性强制此项）。
  const decision = version.kind === 'champion-guided'
    ? (planner as ReturnType<typeof createChampionGuidedPlanner>).decide(observation, {
        ...options,
        profileName: options.profile?.name,
      } as ChampionGuidedSearchOptions)
    : (planner as ReturnType<typeof createJointPlanner>).decide(observation, {
        ...options,
        profileName: options.profile?.name,
      });
  const action = decision.action;
  // 第一步合法性复核（与 chooseAIAction 同纪律）：搜索模型非法时回退全量合法集。
  try {
    applyAction(game, action);
  } catch {
    const sim = createSimulation(observation, { simSeed: options.simSeed ?? 0 });
    const legal = enumerateLegalActions(sim.view, { dedupe: true });
    const fallback = legal[0];
    if (!fallback) throw new Error('联合规划决策非法且无合法回退');
    return { action: fallback, reason: '联合规划决策非法，回退首个合法行动（缺陷暴露）', joint: decision, version: versionId };
  }
  return { action, reason: decision.reason, joint: decision, version: versionId };
}

/** 参数校验工具：版本注册表的外部可读视图（评测 runner 用）。 */
export function jointVersionIds(): string[] {
  return Object.keys(JOINT_VERSIONS);
}

export type { AIParameters };
