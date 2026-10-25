/** AI 模块公共出口（兼容层）。
 * 历史调用点：src/app.ts、tests/*.test.mjs、scripts/benchmark-ai.mjs
 * 均从 './ai.js' 导入 chooseAIAction。
 */

export { chooseAIAction, type AIOptions, type AIDecision } from './ai/decision.js';
export {
  BASELINE_PARAMETERS, CHAMPION_PARAMETERS, PARAMETER_BOUNDS,
  getAIParameters, setAIParameters, resetAIParameters,
  registerAIVersion, resolveAIParameters, validateAIParameters,
  type AIParameters,
} from './ai/parameters.js';
export { buildObservation, type AIObservation, type ObservationPlayer } from './ai/observation.js';
export { contestPressure, peakPressure, pressureModel, golemSurvivalModel, type PressureModel } from './ai/opponent-model.js';
export { PROFILES, profileFor, NEUTRAL_PROFILE, type Profile } from './ai/profiles.js';
export { choosePlan } from './ai/planner.js';
export {
  AI_STRUCTURES, DEFAULT_STRUCTURE, normalizeStructure,
  adaptiveWidth, ROLLOUT_DEFAULTS, type AIStructure,
} from './ai/structures.js';
