/** AI 结构变体测试：束宽度自适应与蒙特卡洛 rollout。
 * 约束：全部结构确定性可复现、行动合法、只读公开信息（公平性静态扫描自动覆盖新模块）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import {
  chooseAIAction, BASELINE_PARAMETERS, buildObservation,
  AI_STRUCTURES, DEFAULT_STRUCTURE, normalizeStructure, adaptiveWidth,
} from '../dist/js/ai.js';

test('结构标识归一化：缺省为冠军结构，非法值报错', () => {
  assert.equal(normalizeStructure(undefined), 'beam-lineage');
  assert.equal(normalizeStructure(null), 'beam-lineage');
  assert.equal(normalizeStructure('beam-rollout'), 'beam-rollout');
  assert.equal(normalizeStructure('beam-contest'), 'beam-contest');
  assert.equal(DEFAULT_STRUCTURE, 'beam-lineage');
  assert.deepEqual(AI_STRUCTURES, ['beam-lineage', 'beam-adaptive', 'beam-rollout', 'beam-contest']);
  assert.throws(() => normalizeStructure('monte-carlo-9000'), /未知 AI 结构/);
});

test('自适应束宽：确定性、单调递减（前置宽后置窄）、有下界', () => {
  for (const depth of [1, 3, 6]) {
    let previous = Infinity;
    for (let layer = 1; layer <= depth; layer++) {
      const w = adaptiveWidth(layer, depth, 14);
      assert.ok(Number.isInteger(w) && w >= 4, `宽度越界：layer=${layer} w=${w}`);
      assert.ok(w <= previous, `宽度应随层号不增：layer=${layer}`);
      previous = w;
    }
  }
  assert.equal(adaptiveWidth(1, 6, 14), adaptiveWidth(1, 6, 14));
  assert.ok(adaptiveWidth(1, 6, 14) > adaptiveWidth(6, 6, 14), '浅层应宽于深层');
});

/** 构造真实中局位置（全 AI 推进），供多结构一致性测试。 */
function midgamePositions(count) {
  const positions = [];
  for (let seed = 1; seed <= 8 && positions.length < count; seed++) {
    let g = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 400 && positions.length < count) {
      if (g.phase === 'turn' && g.turnNumber % 4 === 2) positions.push(JSON.parse(JSON.stringify(g)));
      const { action } = chooseAIAction(g);
      g = applyAction(g, action);
      moves++;
    }
  }
  return positions;
}

test('全部结构的决策在正式引擎下合法（多位置 × 三结构）', () => {
  const positions = midgamePositions(6);
  assert.ok(positions.length >= 4);
  for (const structure of AI_STRUCTURES) {
    for (const g of positions) {
      const snapshot = JSON.stringify(g);
      const { action } = chooseAIAction(g, { structure, parameters: BASELINE_PARAMETERS });
      assert.equal(JSON.stringify(g), snapshot, '决策不得修改输入局面');
      assert.doesNotThrow(() => applyAction(g, action), `structure=${structure} 产生非法行动：${JSON.stringify(action)}`);
    }
  }
});

test('结构变体确定性：同结构同局面决策逐位一致（含 rollout 随机源）', () => {
  const positions = midgamePositions(4);
  for (const structure of AI_STRUCTURES) {
    for (const g of positions) {
      const a = chooseAIAction(g, { structure, parameters: BASELINE_PARAMETERS });
      const b = chooseAIAction(g, { structure, parameters: BASELINE_PARAMETERS });
      assert.deepEqual(a.action, b.action, `structure=${structure} 决策不可复现`);
      assert.deepEqual(a.plan?.actions, b.plan?.actions);
    }
  }
});

test('结构变体真实生效：至少一个位置上规划与冠军结构不同（非退化）', () => {
  const positions = midgamePositions(24);
  let adaptiveDiff = 0, rolloutDiff = 0;
  for (const g of positions) {
    const base = JSON.stringify(chooseAIAction(g, { parameters: BASELINE_PARAMETERS }).plan);
    if (JSON.stringify(chooseAIAction(g, { structure: 'beam-adaptive', parameters: BASELINE_PARAMETERS }).plan) !== base) adaptiveDiff++;
    if (JSON.stringify(chooseAIAction(g, { structure: 'beam-rollout', parameters: BASELINE_PARAMETERS }).plan) !== base) rolloutDiff++;
  }
  assert.ok(adaptiveDiff > 0, `beam-adaptive 在 ${positions.length} 个位置上与基线完全一致，疑似未生效`);
  assert.ok(rolloutDiff > 0, `beam-rollout 在 ${positions.length} 个位置上与基线完全一致，疑似未生效`);
});

test('结构可内嵌于参数集并通过验证透传', async () => {
  const { validateAIParameters } = await import('../dist/js/ai/parameters.js');
  const ok = validateAIParameters({ ...BASELINE_PARAMETERS, id: 's1', structure: 'beam-rollout' });
  assert.equal(ok.structure, 'beam-rollout');
  const stripped = validateAIParameters({ ...BASELINE_PARAMETERS, id: 's2' });
  assert.equal(stripped.structure, undefined);
  assert.throws(() => validateAIParameters({ ...BASELINE_PARAMETERS, id: 's3', structure: 'bad' }), /未知 AI 结构/);
});

test('rollout 结构决策耗时保持在交互预算内', () => {
  let g = createGame(['A', 'B', 'C', 'D', 'E'], 77, [1, 2, 3, 4]);
  g.players[0].isAI = true;
  let turns = 0;
  let maxMs = 0;
  while (g.phase !== 'finished' && turns < 40) {
    const t0 = performance.now();
    const { action } = chooseAIAction(g, { structure: 'beam-rollout', parameters: BASELINE_PARAMETERS });
    maxMs = Math.max(maxMs, performance.now() - t0);
    g = applyAction(g, action);
    turns++;
  }
  assert.ok(maxMs < 500, `rollout 单步决策峰值 ${maxMs.toFixed(1)}ms 超出预算`);
});

test('观察对象在结构变体路径下仍为唯一信息入口', () => {
  const g = createGame(['A', 'B', 'C', 'D', 'E'], 42, [1, 2, 3, 4]);
  g.players[0].isAI = true;
  const view = buildObservation(g);
  for (const structure of AI_STRUCTURES) {
    assert.doesNotThrow(() => chooseAIAction(g, { structure, parameters: BASELINE_PARAMETERS }));
  }
  assert.equal(JSON.stringify(view).includes('merchantDeck'), false);
});
