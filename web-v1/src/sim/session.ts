/** PublicSimulation：公共世界模拟会话（AI6 第二阶段·任务 C/G）。
 *
 * 职责：
 * - 持有 PublicSimState（紧凑公共状态）与模拟翻牌队列（信念采样的私有产物）；
 * - step()：精确公共状态转移（委托 transition.stepCore，规则权威经
 *   differential harness 与正式 engine 锚定）；
 * - fork()：状态复制，供分支模拟与 Common Random Numbers（采样在 root
 *   完成一次，分支共享同一随机世界）；
 * - score()/ranking()：计分与名次直接复用正式 engine 的 score/ranking
 *   （规则权威唯一，模拟器不另设计分公式）。
 *
 * 信息公平性（结构性保证）：
 * - 模拟翻牌队列存放于 ES #private 字段：不可枚举、不可被外部代码读取，
 *   JSON.stringify 不会泄漏，"已采样但未翻开的未来牌序"对 AI 决策函数
 *   物理不可见（tests/public-sim.fairness.test.mjs 强制验证）。
 * - 会话只从 AIObservation 构造；真实隐藏牌序在结构上无法进入。
 *
 * Node / 浏览器兼容：纯 TypeScript，无 DOM / Node 专属 API 依赖。
 */

import { ranking as engineRanking, score as engineScore, type Game, type Player } from '../engine.js';
import { buildPublicSimState, type PublicSimState } from './state.js';
import { randomBeliefSampler, type BeliefDeckSampler } from './sampler.js';
import { cloneCore, stepCore, type SimCore } from './transition.js';
import { appendEvent, derivePublicEvent, snapshotFromSimState, type PublicHistorySummary } from './history.js';
import { SimulationMetrics } from './metrics.js';

export type SimulationOptions = {
  /** 信念采样器（缺省 randomBeliefSampler(simSeed)）。
   * differential 测试经此注入预设翻牌序列；生产路径不传入。 */
  sampler?: BeliefDeckSampler;
  /** 模拟随机流种子（采样器缺省时生效；相同公开状态 + 相同种子 ⇒ 相同模拟结果）。 */
  simSeed?: number;
  /** 附加公开历史摘要（公开历史追踪器产物；深拷贝进入会话，缺省空摘要）。 */
  historySummary?: PublicHistorySummary;
};

const fail = (message: string): never => { throw new Error(message); };

/** 校验采样器输出的多重集与未知卡集合一致（采样器契约的防御性检查，
 * 亦使"观察推导遗漏公开卡"类缺陷在 session 创建时即刻暴露）。 */
function requireSameMultiset(unseen: readonly string[], queue: readonly string[], kind: string): void {
  if (queue.length !== unseen.length) {
    fail(`信念采样 ${kind} 队列长度 ${queue.length} ≠ 未知卡集合长度 ${unseen.length}`);
  }
  const expected = [...unseen].sort().join(',');
  const actual = [...queue].sort().join(',');
  if (expected !== actual) {
    fail(`信念采样 ${kind} 队列与未知卡集合多重集不一致（公开信息推导或采样器实现缺陷）`);
  }
}

export class PublicSimulation {
  #core: SimCore;
  #metrics: SimulationMetrics;

  private constructor(core: SimCore, metrics: SimulationMetrics) {
    this.#core = core;
    this.#metrics = metrics;
  }

  /** 从合法公开观察创建模拟会话。信念采样在创建时执行一次（root 采样），
   * 之后 fork 共享同一随机世界（CRN）。 */
  static create(observation: Parameters<typeof buildPublicSimState>[0], options?: SimulationOptions): PublicSimulation {
    const state = buildPublicSimState(observation, { historySummary: options?.historySummary });
    const sampler = options?.sampler ?? randomBeliefSampler(options?.simSeed ?? 0);
    const queueMerchant = sampler.sampleMerchantDeck(state.unseenMerchants);
    const queueGolem = sampler.sampleGolemDeck(state.unseenGolems);
    requireSameMultiset(state.unseenMerchants, queueMerchant, '商人');
    requireSameMultiset(state.unseenGolems, queueGolem, '魔像');
    const metrics = new SimulationMetrics();
    metrics.recordStateBuild();
    metrics.recordBeliefSample(state.unseenMerchants.length);
    metrics.recordBeliefSample(state.unseenGolems.length);
    return new PublicSimulation({ state, queueMerchant, queueGolem }, metrics);
  }

  /** 公共状态只读视图（调用方不得修改；转移经 step 接口执行）。 */
  get view(): Readonly<PublicSimState> {
    return this.#core.state;
  }

  get finished(): boolean {
    return this.#core.state.phase === 'finished';
  }

  /** 模拟器指标（计数器快照）。 */
  get metrics(): SimulationMetrics {
    return this.#metrics;
  }

  /** 执行一步公共状态转移。非法行动抛错（条件与正式 engine 一致）。
   * 转移成功后由公开状态前后差分推导 PublicEvent 并增量追加到
   * state.historySummary（任务 A）；事件推导失败立即抛错（规则层缺陷暴露）。 */
  step(action: Parameters<typeof stepCore>[1]): void {
    const before = snapshotFromSimState(this.#core.state);
    try {
      stepCore(this.#core, action);
      const event = derivePublicEvent(before, action, snapshotFromSimState(this.#core.state));
      appendEvent(this.#core.state.historySummary, event);
      this.#metrics.recordTransition();
    } catch (error) {
      this.#metrics.recordIllegal();
      throw error;
    }
  }

  /** 试探性执行：合法返回 true（状态已推进），非法返回 false（状态不变）。 */
  tryStep(action: Parameters<typeof stepCore>[1]): boolean {
    try {
      this.step(action);
      return true;
    } catch {
      return false;
    }
  }

  /** 状态复制：分支模拟入口。复制公共状态 + 模拟翻牌队列，
   * 分支间共享 root 采样得到的同一随机世界（Common Random Numbers）。 */
  fork(): PublicSimulation {
    this.#metrics.recordFork();
    return new PublicSimulation(cloneCore(this.#core), new SimulationMetrics({ ...this.#metrics.counters }));
  }

  /** 指定玩家的正式规则得分（直接复用 engine.score，无模拟器计分公式）。 */
  score(playerId: number): number {
    const player = this.#core.state.players[playerId];
    if (!player) fail(`玩家不存在：${playerId}`);
    return engineScore(player as unknown as Player);
  }

  /** 最终名次（玩家 id 序列，复用 engine.ranking 的平分决胜语义：
   * 分数降序，同分后手席位优先）。 */
  ranking(): number[] {
    const pseudoGame = { players: this.#core.state.players } as unknown as Game;
    return engineRanking(pseudoGame).map(p => p.id);
  }
}

/** 功能式转移接口：返回新会话（fork + step），原会话不变。
 * 热路径（搜索内层循环）建议使用 sim.fork() + step() 复用分支。 */
export function simulatePublicAction(sim: PublicSimulation, action: Parameters<PublicSimulation['step']>[0]): PublicSimulation {
  const next = sim.fork();
  next.step(action);
  return next;
}

/** 会话工厂（PublicStateBuilder + BeliefDeckSampler 的组装入口）。 */
export function createSimulation(observation: Parameters<typeof buildPublicSimState>[0], options?: SimulationOptions): PublicSimulation {
  return PublicSimulation.create(observation, options);
}
