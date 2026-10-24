/** Joint Search V1 统一出口（AI6 第四阶段）。
 *
 * 正式网页 AI（src/ai）不 import 本模块；训练评测经 adapter 按版本注入。
 */

export type {
  JointPlanner, JointSearchOptions, JointDecision, JointVersionId,
  JointOpponentMode, LeafEvaluatorLevel, JointSearchVariant,
  RootActionEvaluation, DecisionTrace, JointVersionSpec,
} from './types.js';
export { JOINT_VERSIONS } from './types.js';
export { createJointPlanner, worldSeed } from './planner.js';
export { createChampionGuidedPlanner, competitionRisk, type ChampionGuidedDecision, type ChampionGuidedOptions, type ChampionGuidedSearchOptions } from './champion-guided.js';
export { chooseJointAction, jointVersionIds, type JointAdapterOptions, type JointAdapterDecision } from './adapter.js';
export { evaluateLeaf, leafVector, logisticWin, evaluateL0, evaluateL1, evaluateL2, evaluateL3, type LeafVector } from './evaluators.js';
export { playJointTrajectory, runJointRollout, firstPlaceOf } from './joint-rollout.js';
export { runJointTreeTrial } from './joint-tree.js';
export { L3_CALIBRATION, type L3Calibration } from './l3-calibration.js';
