/** 公共世界模拟器（Public Belief Simulator）公共出口。
 * AI6 第二阶段（任务 G）：为后续多人联合搜索（CAHJP）提供精确、公平、
 * 可复现、高性能的公共世界模拟底座。
 *
 * 模块独立性：
 * - 本目录不依赖 src/ai/ 的任何运行时代码（仅类型引用 AIObservation）；
 * - src/ai/ 亦不导入本模块——正式网页 AI 行为保持逐位不变，
 *   由 tests/public-sim.fairness.test.mjs 静态扫描双向强制。
 *
 * 稳定接口清单：
 * - PublicStateBuilder      buildPublicSimState(observation)
 * - BeliefDeckSampler       接口 + randomBeliefSampler(seed)
 * - LegalActionProvider     enumerateLegalActions(state, options?)
 * - PublicTransition        PublicSimulation.create/step/fork + simulatePublicAction
 * - PublicStateHasher       publicStateKey / hashPublicState
 * - SimulationMetrics       会话级计数器
 */

export { buildPublicSimState, deriveUnseenMerchants, deriveUnseenGolems, removeFromUnseen } from './state.js';
export type { PublicSimState, PublicSimPlayer, PublicMarketSlot, UnseenSet, PublicHistorySummary } from './state.js';

export {
  appendEvent, cloneHistory, createEmptyHistory, derivePublicEvent, historyDigest,
  snapshotFromObservation, snapshotFromSimState, HISTORY_WINDOW_CAPACITY,
} from './history.js';
export type {
  PublicEvent, PublicEventKind, PublicPlayerHistory, PublicSnapshot,
  PlayEvent, AcquireEvent, RestEvent, ClaimEvent, DiscardEvent,
  StockDelta, ListDelta,
} from './history.js';

export { randomBeliefSampler } from './sampler.js';
export type { BeliefDeckSampler } from './sampler.js';

export { enumerateLegalActions } from './legal.js';
export type { LegalEnumerationOptions } from './legal.js';

export { PublicSimulation, createSimulation, simulatePublicAction } from './session.js';
export type { SimulationOptions } from './session.js';

export { publicStateKey, hashPublicState } from './hash.js';

export { SimulationMetrics } from './metrics.js';
export type { SimulationMetricCounters } from './metrics.js';

export { mulberry32, shuffled } from './rng.js';
