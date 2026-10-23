/** AI5 获取估值变体（acquisitionVariant）测试。
 *
 * 覆盖：
 * 1. 参数校验：合法值透传，非法值拒绝，缺省不注入；
 * 2. 分派正确性：'goal-remaining' 走演化实现，缺省/'baseline' 走冠军基线；
 * 3. 行为敏感性：在目标费用被部分持有的状态上两实现输出不同（变体真实生效），
 *    在无目标或未持任何相关水晶的状态上两实现逐位一致（差异面精确受控）；
 * 4. 确定性：同输入同输出；
 * 5. 公平性回归：CHAMPION_PARAMETERS 的变体字段与冠军记录一致（训练与实战同参）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acquisitionValue, acquisitionValueGoalRemaining, acquisitionValueReadinessEfficiency } from '../dist/js/ai/evaluator.js';
import { chooseAIAction, validateAIParameters, CHAMPION_PARAMETERS, PROFILES, NEUTRAL_PROFILE } from '../dist/js/ai.js';
import { createGame, applyAction } from '../dist/js/engine.js';

const baseParams = {
  id: 'variant-test', structure: 'beam-rollout',
  engineWeight: 1, tempoWeight: 1, contestWeight: 1, synergyWeight: 1,
  goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
};
const variantParams = { ...baseParams, acquisitionVariant: 'goal-remaining' };
const pressure = { mean: {}, peak: {} };

// ---- 1. 参数校验 ----
assert.equal(validateAIParameters({ ...baseParams, acquisitionVariant: 'goal-remaining' }).acquisitionVariant, 'goal-remaining');
assert.equal(validateAIParameters({ ...baseParams, acquisitionVariant: 'baseline' }).acquisitionVariant, 'baseline');
assert.equal(validateAIParameters(baseParams).acquisitionVariant, undefined, '缺省不注入变体字段');
assert.throws(() => validateAIParameters({ ...baseParams, acquisitionVariant: 'cheat' }), /未知获取估值变体/);
// 新变体 'readiness-efficiency'（AI5 多样性轮最优）的校验与分派。
assert.equal(validateAIParameters({ ...baseParams, acquisitionVariant: 'readiness-efficiency' }).acquisitionVariant, 'readiness-efficiency');
const stateMixed = { stock: [1, 0, 2, 0], hand: ['M01'], played: [] };
const reBase = acquisitionValue(stateMixed, 'M14', 'G09', { engine: 1, contest: 1 }, pressure, baseParams);
const reVariant = acquisitionValue(stateMixed, 'M14', 'G09', { engine: 1, contest: 1 }, pressure, { ...baseParams, acquisitionVariant: 'readiness-efficiency' });
assert.equal(reVariant, acquisitionValueReadinessEfficiency(stateMixed, 'M14', 'G09', { engine: 1, contest: 1 }, pressure, baseParams), '分派必须命中 readiness-efficiency 实现');
assert.notEqual(reVariant, reBase, 'readiness-efficiency 与基线输出必须不同');
assert.equal(acquisitionValue(stateMixed, 'M14', 'G09', { engine: 1, contest: 1 }, pressure, { ...baseParams, acquisitionVariant: 'readiness-efficiency' }), reVariant, '变体必须确定性');

// ---- 2/3. 分派与敏感性 ----
// 状态 A：目标 G01 cost [2,1,0,1]，已持有 [2,1,0,1] 全部费用水晶 →
// 基线 goalFit 与原始重叠成正比（>0），变体 goalFit = 0（不缺任何水晶）。
const stateFull = {
  stock: [2, 1, 0, 1],
  hand: ['M01'],
  played: [],
};
const fullBase = acquisitionValue(stateFull, 'M35', 'G01', { engine: 1, contest: 1 }, pressure, baseParams);
const fullVariant = acquisitionValue(stateFull, 'M35', 'G01', { engine: 1, contest: 1 }, pressure, variantParams);
assert.ok(fullBase > 0, '基线在已持全费水晶时 goalFit 仍 > 0');
assert.ok(fullVariant < fullBase, `变体不重复计分已持有水晶（${fullVariant} < ${fullBase}）`);
// 分派一致性：acquisitionVariant='goal-remaining' 的输出 == 直接调用演化实现。
assert.equal(
  fullVariant,
  acquisitionValueGoalRemaining(stateFull, 'M35', 'G01', { engine: 1, contest: 1 }, pressure, baseParams),
  '分派必须命中演化实现',
);
// 对照：无 preferred 时 goalFit 恒 0，两实现逐位一致（差异面受控）。
const noGoalBase = acquisitionValue(stateFull, 'M35', null, { engine: 1, contest: 1 }, pressure, baseParams);
const noGoalVariant = acquisitionValue(stateFull, 'M35', null, { engine: 1, contest: 1 }, pressure, variantParams);
assert.equal(noGoalBase, noGoalVariant, '无目标时两实现必须逐位一致');
// 'baseline' 显式值也走基线。
assert.equal(
  acquisitionValue(stateFull, 'M35', 'G01', { engine: 1, contest: 1 }, pressure, { ...baseParams, acquisitionVariant: 'baseline' }),
  fullBase,
);

// ---- 4. 确定性 ----
assert.equal(
  acquisitionValue(stateFull, 'M35', 'G01', { engine: 1, contest: 1 }, pressure, variantParams),
  fullVariant,
  '变体必须确定性（同输入同输出）',
);

// ---- 5. 决策级敏感性：变体在部分对局中真实改变行动 ----
// 多种子扫描：至少一个种子上 chooseAIAction 的行动或理由与基线不同。
let divergentSeeds = 0;
for (let seed = 1; seed <= 20; seed++) {
  const mk = () => {
    const game = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    game.players[0].isAI = true;
    return game;
  };
  const g1 = mk(), g2 = mk();
  const r1 = chooseAIAction(g1, { parameters: baseParams, profile: NEUTRAL_PROFILE });
  const r2 = chooseAIAction(g2, { parameters: variantParams, profile: NEUTRAL_PROFILE });
  if (JSON.stringify(r1.action) !== JSON.stringify(r2.action)) divergentSeeds++;
}
assert.ok(divergentSeeds > 0, `变体必须在至少一个初始局面改变行动（实际 ${divergentSeeds}/20）`);

// ---- 6. 公平性回归：冠军参数与冠军记录的变体字段一致 ----
// 此前冠军未携带变体时此处断言 acquisitionVariant === undefined（行为零变化）；
// AI5 readiness-efficiency 经 challengeIndex=9 晋级后冠军本身即变体，
// 正确不变量是：CHAMPION_PARAMETERS 必须与冠军记录逐字段一致（含变体字段），
// 与 ai-fairness.test.mjs 的逐字段核对互为双向防线。
{
  const record = JSON.parse(readFileSync(new URL('../../training/champions/champion.json', import.meta.url), 'utf8'));
  const recorded = record.parameters ?? record;
  assert.equal(
    CHAMPION_PARAMETERS.acquisitionVariant,
    recorded.acquisitionVariant,
    '冠军变体字段必须与冠军记录一致（训练与实战同参）',
  );
}
// 变体行动合法性由正式引擎兜底：变体行动可被引擎接受。
{
  const game = createGame(['A', 'B', 'C', 'D', 'E'], 3, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  const response = chooseAIAction(game, { parameters: variantParams, profile: PROFILES[0] });
  const after = applyAction(game, response.action); // 非法行动会抛出
  assert.ok(after, '变体行动必须通过正式引擎合法性校验');
}

console.log('ai5-variant.test.mjs：全部断言通过');
