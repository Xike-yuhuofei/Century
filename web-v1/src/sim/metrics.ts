/** SimulationMetrics：模拟器运行指标（AI6 第二阶段·任务 G）。
 *
 * 只做廉价计数（热路径零时间测量开销）；墙钟吞吐量由基准脚本
 * （scripts/benchmark-public-sim.mjs）外部测量，两者口径分离。
 * 计数器随 fork 复制，使任意分支都能读到自 root 以来的累计量。
 */

export type SimulationMetricCounters = {
  /** createSimulation 次数。 */
  stateBuilds: number;
  /** 成功执行的公共状态转移次数。 */
  transitions: number;
  /** 被拒绝的非法行动尝试次数。 */
  illegalAttempts: number;
  /** fork（状态复制）次数。 */
  forks: number;
  /** 信念采样执行次数（商人 + 魔像各计一次）。 */
  beliefSamples: number;
  /** 信念采样总卡数。 */
  beliefCardsSampled: number;
};

const zeroCounters = (): SimulationMetricCounters => ({
  stateBuilds: 0,
  transitions: 0,
  illegalAttempts: 0,
  forks: 0,
  beliefSamples: 0,
  beliefCardsSampled: 0,
});

export class SimulationMetrics {
  readonly counters: SimulationMetricCounters;

  constructor(initial?: SimulationMetricCounters) {
    this.counters = initial ?? zeroCounters();
  }

  recordStateBuild(): void { this.counters.stateBuilds++; }
  recordTransition(): void { this.counters.transitions++; }
  recordIllegal(): void { this.counters.illegalAttempts++; }
  recordFork(): void { this.counters.forks++; }
  recordBeliefSample(cardCount: number): void {
    this.counters.beliefSamples++;
    this.counters.beliefCardsSampled += cardCount;
  }

  /** 快照（浅拷贝，供报告输出）。 */
  snapshot(): SimulationMetricCounters {
    return { ...this.counters };
  }
}
