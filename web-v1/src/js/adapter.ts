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
import { FROZEN_VERSIONS } from '../ai/version-registry.js';
import { trimStock } from '../ai/evaluator.js';
import { chooseAIAction } from '../ai/decision.js';
import type { Profile } from '../ai/profiles.js';
import { createSimulation } from '../sim/session.js';
import { enumerateLegalActions } from '../sim/legal.js';
import { createJointPlanner } from './planner.js';
import { createChampionGuidedPlanner, type ChampionGuidedSearchOptions } from './champion-guided.js';
import { endgameDiscardColors } from './endgame.js';
import { count } from '../engine.js';
import { JOINT_VERSIONS, type JointDecision, JointSearchOptions, JointVersionId } from './types.js';
import { mergeJointOptions, resolveJointConfig, jointConfigHash, type JointSearchResolved } from './config.js';

export type JointAdapterOptions = JointSearchOptions & {
  /** 版本 id（必填；未注册版本抛错——禁止静默回退到任何未声明行为）。 */
  version: JointVersionId | string;
  /** 显式人格（缺省中立；训练模拟器按席位映射注入）。 */
  profile?: Profile;
  /** 决策席位（缺省 game.current；非当前席位抛错）。 */
  playerId?: number;
  /** 冠军基座参数（AI7-A2 身份冻结 / AI6-P0 版本身份透传）：
   * 冻结版本必须传入其归档参数，生产入口传入活动冠军参数；缺省时回退
   * 模块级 CHAMPION_PARAMETERS（仅兼容旧测试调用——训练/评测必须显式传入）。 */
  championParameters?: AIParameters;
};

export type JointAdapterDecision = {
  action: Action;
  reason: string;
  /** 联合搜索完整决策（joint 版本有值；js1 委托冠军时为 null）。 */
  joint: JointDecision | null;
  version: string;
  /** 有效配置身份（版本预设 + 调用方覆盖 + 缺省）与哈希；版本名≠配置。 */
  config: JointSearchResolved & { hash: string };
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

  // 有效配置：版本预设 + 调用方覆盖（opt 不再只是标签）。
  // AI7-A2：冠军基座参数显式解析并注入配置身份（冻结描述符不得回退活动状态）。
  // AI7 候选：版本预设的 parameterVariant（engine-v2 / engine-v2-seat）经
  // mergeJointOptions 注入 championParameters；调用方显式传入时优先。
  const resolvedOptions = mergeJointOptions(versionId, options) as JointAdapterOptions;
  const championParameters = resolvedOptions.championParameters
    ? validateAIParameters(resolvedOptions.championParameters)
    : CHAMPION_PARAMETERS;
  const baseConfig = resolveJointConfig(versionId, resolvedOptions, options.profile?.name);
  const config = { ...baseConfig, hash: jointConfigHash(baseConfig) };

  // JS1：冠军 + 静态目标存活折扣 = beam-contest 结构（冠军 beam-rollout +
  // golemSurvivalModel），委托正式冠军入口，保证与冠军代码逐位同源。
  // AI6 第六阶段 P0 版本身份修复（合并 P0-1 整改语义）：JS1 的"冠军"指
  // 冻结历史冠军 legacy-js0（ai5-readiness-efficiency 晋级归档）。此前委托
  // CHAMPION_PARAMETERS——PR #30 晋级后该常量携带 adapter 字段，决策入口
  // 适配器分支优先于 structure，JS1 会静默运行 JS5（修复前失败证据：
  // confirm-replay-check js0/js1 重放 24/24 → 1-2/12）。基座取自不可变
  // 版本注册表（与训练侧 legacy-js1 = 冻结归档 + beam-contest 同一身份），
  // 与活动冠军解耦——活动冠军切换不得改变历史版本行为；strip-adapter
  // 形态只作参数消毒（适配器字段绝不入束搜索参数）。
  if (version.kind === 'champion-contest') {
    // AI7-A2 与 AI6-P0 合并：JS1 基座来自不可变版本注册表的 frozen legacy-js0
    // （历史归档参数），绝不读活动 CHAMPION_PARAMETERS；JS1 身份不随冠军切换漂移。
    const response = chooseAIAction(game, {
      parameters: validateAIParameters(FROZEN_VERSIONS['legacy-js0'].parameters),
      structure: 'beam-contest',
      profile: options.profile,
    });
    return { action: response.action, reason: `JS1: ${response.reason}`, joint: null, version: versionId, config };
  }

  // 溢出：冠军 trimStock 弃置口径（与正式冠军 decision.ts 同一语义）。
  // AI7 C1（显式 opt-in）：终局圈强制弃置按官方得分口径（非黄留存）。
  if (game.phase === 'overflow') {
    const p = game.players[seat];
    const colors = resolvedOptions.endgameDiscard === true && game.triggerPlayer !== null
      ? endgameDiscardColors(p.stock, count(p.stock) - 10)
      : trimStock(p.stock, game.golemMarket, null, championParameters).discarded as Color[];
    return {
      action: { type: 'discard', colors },
      reason: resolvedOptions.endgameDiscard === true && game.triggerPlayer !== null
        ? '溢出弃置（终局官方得分口径：先弃黄，保留非黄）'
        : '溢出弃置（冠军 trimStock 口径）',
      joint: null, version: versionId, config,
    };
  }

  const observation = buildObservation(game, seat);
  const planner = plannerFor(versionId);
  // profile → profileName 映射对全部 joint 版本一致（champion-guided 的冠军基座
  // 与轨迹内策略都必须消费同一人格注入，否则评测席位人格失配——回归审计
  // gate=never vs js0 逐决策一致性强制此项）。
  // 版本化 guided 缺省（AI6 第六阶段）：JOINT_VERSIONS[version].guided 与
  // optionPreset 都在显式注入之前合并（显式选项最终优先）——使 joint-js5-opt /
  // joint-js6 等 champion-guided 版本自描述（版本身份不依赖调用方记得传对选项）。
  const guidedDefaults = (version as { guided?: Record<string, unknown> }).guided ?? {};
  const decision = version.kind === 'champion-guided'
    ? (planner as ReturnType<typeof createChampionGuidedPlanner>).decide(observation, {
        ...guidedDefaults,
        ...resolvedOptions,
        championParameters,
        profileName: options.profile?.name,
      } as ChampionGuidedSearchOptions)
    : (planner as ReturnType<typeof createJointPlanner>).decide(observation, {
        ...resolvedOptions,
        championParameters,
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
    return { action: fallback, reason: '联合规划决策非法，回退首个合法行动（缺陷暴露）', joint: decision, version: versionId, config };
  }
  return { action, reason: decision.reason, joint: decision, version: versionId, config };
}

/** 参数校验工具：版本注册表的外部可读视图（评测 runner 用）。 */
export function jointVersionIds(): string[] {
  return Object.keys(JOINT_VERSIONS);
}

export type { AIParameters };
