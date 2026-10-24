/** 冻结版本决策记录与基准局面装配（战术基准专用）。
 *
 * 职责：给定一个完整引擎位置（Game 去掉 replay），产出一条完整的基准局面记录：
 * - 公开观察（决策同源口径：正式 buildObservation）
 * - 全量合法行动集合（web-v1/src/sim/legal.ts 全量口径，与引擎逐条对齐）
 * - 四个冻结版本的建议行动（全部确定性口径，见 versions.mjs）
 * - 分歧矩阵 / 客观约束 / 战略假设
 *
 * 信息边界纪律：隐藏牌库只存在于 engineState.position（研究侧复演用途，
 * 显式标记 containsHiddenInfo）；决策一律经 chooseAIAction / chooseJointAction
 * 的公开观察入口，本模块从不把牌库内容传给任何决策函数。
 */

import { buildObservation } from '../../../web-v1/dist/js/ai.js';
import { buildPublicSimState, enumerateLegalActions } from '../../../web-v1/dist/js/sim/index.js';
import { legalClaimIndices } from '../../../web-v1/dist/js/engine.js';
import { frozenVersions, decideWithVersion, seatProfile } from './versions.mjs';
import { actionKey, analyzePosition, objectiveConstraints, strategicHypotheses, targetClaims } from './classify.mjs';

export const SCHEMA = 'century-tactical-scenario-v1';

/** 完整位置 → 公开观察（正式入口，与决策函数同源）。 */
export function positionPublicView(position) {
  const game = structuredClone(position);
  for (const p of game.players) p.isAI = true;
  return buildObservation(game);
}

/** 全量合法行动集合（正确性基准口径：弃置以外不去重）。 */
export function fullLegalActions(position) {
  return enumerateLegalActions(buildPublicSimState(positionPublicView(position)), { dedupe: false });
}

const CATEGORY_CODE = {
  'final-round': 'FIN', 'opponent-ending': 'OPP', 'contested-claim': 'CON',
  'multi-claim': 'MCL', 'seat-race': 'RAC', 'acquire-vs-score': 'AVS',
  'caravan-pressure': 'CAR', 'trade-chain-rest': 'TCR',
  'conversion-efficiency': 'CNV', 'engine-overinvest': 'ENG', 'general-position': 'GEN',
};

/** 装配一条基准局面记录（不写盘；写盘由脚本负责）。
 * meta：{ gameSeed, seatCount, decisionIndex, driver, engineCommit, engineBundleSha256, generatedAt, scenarioBlock } */
export function buildScenario(position, meta, seqByCategory) {
  if (position.phase !== 'turn') throw new Error(`基准局面必须是 turn 阶段，实际：${position.phase}`);
  const view = positionPublicView(position);
  const legal = fullLegalActions(position);
  const analysis = analyzePosition(view, legal);
  const profile = seatProfile(view.current);

  const decisions = {};
  for (const v of frozenVersions()) {
    const t0 = performance.now();
    const d = decideWithVersion(position, v, profile);
    decisions[v.key] = {
      label: v.label,
      options: v.recordedOptions,
      action: d.action,
      actionKey: actionKey(d.action),
      reason: d.reason,
      profile: profile.name,
      ms: Number((performance.now() - t0).toFixed(1)),
    };
  }

  const keys = Object.values(decisions).map(d => d.actionKey);
  const unique = [...new Set(keys)];
  const tally = {};
  for (const k of keys) tally[k] = (tally[k] ?? 0) + 1;
  const majorityActionKey = unique.reduce((a, b) => (tally[b] > tally[a] ? b : a));
  const disagreement = {
    versions: Object.keys(decisions),
    actionKeys: keys,
    uniqueActions: unique,
    uniqueCount: unique.length,
    allAgree: unique.length === 1,
    majorityActionKey,
    tally,
  };

  const claimsBySeat = view.players.map(p => p.claimed.length);
  const code = CATEGORY_CODE[analysis.primaryCategory] ?? 'GEN';
  const seq = (seqByCategory.get(`${analysis.primaryCategory}|${meta.seatCount}`) ?? 0) + 1;
  seqByCategory.set(`${analysis.primaryCategory}|${meta.seatCount}`, seq);
  const id = `TS-${meta.seatCount}P-${code}-${String(seq).padStart(3, '0')}`;

  return {
    schema: SCHEMA,
    id,
    title: `${meta.seatCount} 人 · ${analysis.primaryCategory} · 回合 ${position.turnNumber} · 席位 ${view.current}`,
    description: `由正式引擎（web-v1/dist/js）从种子 ${meta.gameSeed} 的完整对局第 ${meta.decisionIndex} 个决策点采集；驱动版本 ${meta.driver}。分类与约束全部来自公开信息推导，冻结版本建议行动以 workUnits 固定工作量/束搜索确定性口径记录。`,
    classification: {
      category: analysis.primaryCategory,
      tags: analysis.tags,
      playerCount: meta.seatCount,
      stage: analysis.stage,
      competition: analysis.competition,
      targetCount: analysis.claimable.length,
      difficulty: analysis.difficulty,
    },
    provenance: {
      generator: 'training/scenarios harvest-v1',
      gameSeed: meta.gameSeed,
      seatCount: meta.seatCount,
      decisionIndex: meta.decisionIndex,
      driver: meta.driver,
      scenarioBlock: meta.scenarioBlock,
      engineCommit: meta.engineCommit,
      engineBundleSha256: meta.engineBundleSha256,
      generatedAt: meta.generatedAt,
    },
    phase: position.phase,
    turnNumber: position.turnNumber,
    currentSeat: view.current,
    decisionProfile: { seat: view.current, name: profile.name },
    endgame: {
      triggerPlayer: view.triggerPlayer,
      targetClaims: targetClaims(view.players.length),
      claimsBySeat,
    },
    publicView: structuredClone(view),
    legalActions: structuredClone(legal),
    legalActionCount: legal.length,
    engineState: {
      containsHiddenInfo: true,
      note: 'position 含 merchantDeck/golemDeck 隐藏牌序，仅供研究侧复演/局部求解；AI 决策输入只允许 publicView（决策函数内部经 buildObservation 构造，隐藏牌序结构上不可达）。',
      position: structuredClone(position),
    },
    decisions,
    disagreement,
    oracle: null,
    objectiveConstraints: objectiveConstraints(view, { ...analysis, legalActionCount: legal.length }),
    strategicHypotheses: strategicHypotheses(view, analysis),
  };
}

/** 校验辅助：记录中的认领行动与引擎 legalClaimIndices 一致（测试与装配共用）。 */
export function recordedClaimIndices(scenario) {
  return scenario.legalActions.filter(a => a.type === 'claim').map(a => a.index).sort((a, b) => a - b);
}
export function engineClaimIndices(position) {
  return legalClaimIndices(structuredClone(position));
}
