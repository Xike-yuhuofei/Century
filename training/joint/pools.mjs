/** 对手池定义（AI6 第六阶段 P0：对手池单一事实来源）。
 *
 * P0 缺陷背景：duel.mjs / confirm-replay-check.mjs 各自维护池构造，且
 * classicPool/diversePool 以 CHAMPION_PARAMETERS 为基座展开风格变体——
 * PR #30 晋级后基座携带 adapter 字段，变体权重修改被适配器静默忽略，
 * 全部风格变体与冠军本体行为相同（修复前失败证据：历史 js5 对局重放率
 * 4-6/12 → 1/12，因对手池构成漂移）。修复后：
 * - 冠军席 = joint-js5-frozen（当前正式冠军，适配器分派，权重透传修复后
 *   基于其权重的修改真实生效——但本池风格变体仍以 legacy 基座展开，
 *   与第五阶段池语义逐字连续：晋级前冠军 = legacy-js0）；
 * - 风格变体基座 = legacy-js0（束搜索路径真实消费权重修改，变体间存在
 *   决策级可证的行为差异，由 version-gate 强制验证）；
 * - 权重修改幅度与第五阶段池逐字一致（保持池语义连续性与历史可比性）。
 *
 * phase5HistoricalPool()：第五阶段 confirm 实验的精确池复原（冠军席 =
 * 晋级前冠军 ai5-readiness-efficiency）——仅供历史证据重放取证，
 * 禁止用于新实验。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAMPION_PARAMETERS, BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { frozenVersion } from '../../web-v1/dist/js/ai/version-registry.js';
import { REPO_ROOT } from '../lib/paths.mjs';

/** 历史冠军归档参数（AI4 struct-beam-rollout，diverse 池成员）。 */
export function ai4StructBeamRolloutParameters() {
  const path = resolve(REPO_ROOT, 'training/champions/candidates/struct-beam-rollout.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const params = doc.parameters ?? doc;
  if (!params?.id) throw new Error(`历史冠军归档缺少 parameters.id：${path}`);
  return params;
}

/** 第六阶段 classic 池（不含候选席位本体）：
 * 当前正式冠军 + 中立基线 + 冠军族风格变体（legacy 基座，权重真实生效）。 */
export function classicPool() {
  const champ = frozenVersion('joint-js5-frozen');
  const legacy = frozenVersion('legacy-js0');
  const b = legacy.parameters;
  return [
    { id: 'joint-js5-frozen', parameters: champ.parameters, championBody: true },
    { id: 'neutral-baseline', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure },
    { id: 'style-tempo', parameters: { ...b, tempoWeight: Math.min(1.5, b.tempoWeight * 1.35), restWeight: Math.max(0.5, b.restWeight * 0.8) }, structure: legacy.structure },
    { id: 'style-contest', parameters: { ...b, contestWeight: Math.min(2, b.contestWeight * 1.4), goalWeight: Math.min(1.5, b.goalWeight * 1.15) }, structure: legacy.structure },
    { id: 'style-engine', parameters: { ...b, engineWeight: Math.min(1.5, b.engineWeight * 1.3), endgameWeight: Math.min(1.5, b.endgameWeight * 1.1) }, structure: legacy.structure },
  ];
}

/** 第六阶段 diverse 池（不含候选席位本体）：
 * 当前正式冠军 + AI4 历史冠军 + 手调风格 + 随机合法（结构多样性维度）。 */
export function diversePool() {
  const champ = frozenVersion('joint-js5-frozen');
  const legacy = frozenVersion('legacy-js0');
  const b = legacy.parameters;
  const hist = ai4StructBeamRolloutParameters();
  return [
    { id: 'joint-js5-frozen', parameters: champ.parameters, championBody: true },
    { id: 'ai4-struct-beam-rollout', parameters: hist, structure: hist.structure },
    { id: 'style-rush', parameters: { ...b, tempoWeight: 1.6, restWeight: 0.5, engineWeight: 0.5, endgameWeight: 0.6 }, structure: legacy.structure },
    { id: 'style-engine', parameters: { ...b, engineWeight: 1.6, capacityWeight: 1.4, tempoWeight: 0.7 }, structure: legacy.structure },
    { id: 'random-legal', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure, randomLegal: true },
  ];
}

/** 第五阶段 confirm 池精确复原（历史证据重放专用）：
 * 冠军席 = 晋级前冠军 ai5-readiness-efficiency（= legacy-js0）。
 * 逐字对齐 confirm-replay-check.mjs 修复前实现所依赖的第五阶段池语义
 * （当时 CHAMPION_PARAMETERS 尚为束搜索冠军，权重修改真实生效）。 */
export function phase5HistoricalPool() {
  const legacy = frozenVersion('legacy-js0');
  const b = legacy.parameters;
  return [
    { id: b.id, parameters: b, structure: legacy.structure },
    { id: 'neutral-baseline', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure },
    { id: `${b.id}@tempo`, parameters: { ...b, tempoWeight: Math.min(1.5, b.tempoWeight * 1.35), restWeight: Math.max(0.5, b.restWeight * 0.8) }, structure: legacy.structure },
    { id: `${b.id}@contest`, parameters: { ...b, contestWeight: Math.min(2, b.contestWeight * 1.4), goalWeight: Math.min(1.5, b.goalWeight * 1.15) }, structure: legacy.structure },
    { id: `${b.id}@engine`, parameters: { ...b, engineWeight: Math.min(1.5, b.engineWeight * 1.3), endgameWeight: Math.min(1.5, b.endgameWeight * 1.1) }, structure: legacy.structure },
  ];
}

/** 第五阶段 confirm diverse 池精确复原（历史证据重放专用）。 */
export function phase5HistoricalDiversePool() {
  const legacy = frozenVersion('legacy-js0');
  const b = legacy.parameters;
  const hist = ai4StructBeamRolloutParameters();
  return [
    { id: b.id, parameters: b, structure: legacy.structure },
    { id: 'ai4-struct-beam-rollout', parameters: hist, structure: hist.structure, randomLegal: false },
    { id: 'style-rush', parameters: { ...b, tempoWeight: 1.6, restWeight: 0.5, engineWeight: 0.5, endgameWeight: 0.6 }, structure: legacy.structure, randomLegal: false },
    { id: 'style-engine', parameters: { ...b, engineWeight: 1.6, capacityWeight: 1.4, tempoWeight: 0.7 }, structure: legacy.structure, randomLegal: false },
    { id: 'random-legal', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure, randomLegal: true },
  ];
}

export const POOLS = { classic: classicPool, diverse: diversePool };
export const HISTORICAL_POOLS = { classic: phase5HistoricalPool, diverse: phase5HistoricalDiversePool };

/** 当前部署冠军身份披露（CHAMPION_PARAMETERS 只是"当前部署冠军"的镜像，
 * 不充当任何历史版本身份）。 */
export function deployedChampionIdentity() {
  return { id: CHAMPION_PARAMETERS.id, adapter: CHAMPION_PARAMETERS.adapter ?? null, jointVersion: CHAMPION_PARAMETERS.jointVersion ?? null, budgetMs: CHAMPION_PARAMETERS.budgetMs ?? null };
}
