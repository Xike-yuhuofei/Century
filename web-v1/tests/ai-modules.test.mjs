/** AI 4.0 模块化测试：参数管理、版本注册、参数灵敏度（禁止虚假参数）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../dist/js/engine.js';
import {
  chooseAIAction, BASELINE_PARAMETERS, CHAMPION_PARAMETERS,
  setAIParameters, resetAIParameters, registerAIVersion, resolveAIParameters,
  validateAIParameters, getAIParameters,
} from '../dist/js/ai.js';

test('冠军基线参数与 BASELINE 一致且全部为合法数值', () => {
  for (const key of ['engineWeight', 'tempoWeight', 'contestWeight', 'synergyWeight', 'goalWeight', 'capacityWeight', 'restWeight', 'endgameWeight']) {
    assert.equal(typeof BASELINE_PARAMETERS[key], 'number');
    assert.equal(BASELINE_PARAMETERS[key], 1, `基线 ${key} 应为中性 1.0`);
  }
  assert.equal(validateAIParameters(CHAMPION_PARAMETERS).id, CHAMPION_PARAMETERS.id);
});

test('参数校验拒绝越界、非有限值与缺失字段', () => {
  assert.throws(() => validateAIParameters(null), /对象/);
  assert.throws(() => validateAIParameters({ id: 'x' }), /engineWeight/);
  assert.throws(() => validateAIParameters({ ...BASELINE_PARAMETERS, id: 'x', engineWeight: 99 }), /engineWeight/);
  assert.throws(() => validateAIParameters({ ...BASELINE_PARAMETERS, id: 'x', tempoWeight: Number.NaN }), /tempoWeight/);
  assert.throws(() => validateAIParameters({ ...BASELINE_PARAMETERS, id: '' }), /id/);
  assert.doesNotThrow(() => validateAIParameters({ ...BASELINE_PARAMETERS, id: 'ok', endgameWeight: 0.25 }));
});

test('激活参数设置与复位', () => {
  try {
    setAIParameters({ ...BASELINE_PARAMETERS, id: 'temp', tempoWeight: 2 });
    assert.equal(getAIParameters().id, 'temp');
  } finally {
    resetAIParameters();
  }
  assert.equal(getAIParameters().id, CHAMPION_PARAMETERS.id);
});

test('版本注册与解析', () => {
  registerAIVersion({ ...BASELINE_PARAMETERS, id: 'registered-v1', engineWeight: 1.4 });
  assert.equal(resolveAIParameters('registered-v1').engineWeight, 1.4);
  assert.throws(() => resolveAIParameters('not-registered'), /未注册/);
  const direct = resolveAIParameters({ ...BASELINE_PARAMETERS, id: 'inline', restWeight: 0.5 });
  assert.equal(direct.restWeight, 0.5);
});

/** 采集中局位置用于灵敏度检测。 */
function collectPositions(count) {
  const positions = [];
  for (let seed = 1; seed <= 8 && positions.length < count; seed++) {
    let g = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 500 && positions.length < count) {
      if (g.phase === 'turn' && g.turnNumber % 5 === 2) positions.push(JSON.parse(JSON.stringify(g)));
      const { action } = chooseAIAction(g);
      g = applyAction(g, action);
      moves++;
    }
  }
  return positions;
}

test('全部 8 个参数真实影响决策（灵敏度测试，禁止虚假参数）', () => {
  const positions = collectPositions(24);
  assert.ok(positions.length >= 16, `采集中局位置不足：${positions.length}`);
  const params = ['engineWeight', 'tempoWeight', 'contestWeight', 'synergyWeight', 'goalWeight', 'capacityWeight', 'restWeight', 'endgameWeight'];
  const decisions = new Map();
  for (const key of params) {
    decisions.set(key, []);
  }
  // 预计算基线决策。
  const baseline = positions.map(p => JSON.stringify(chooseAIAction(p).action));
  for (const key of params) {
    const low = { ...BASELINE_PARAMETERS, id: `sens-${key}-low`, [key]: 0.05 };
    const high = { ...BASELINE_PARAMETERS, id: `sens-${key}-high`, [key]: 5 };
    if (key === 'endgameWeight') { low[key] = 0.25; high[key] = 4; }
    let diffs = 0;
    for (let i = 0; i < positions.length; i++) {
      const lowDecision = JSON.stringify(chooseAIAction(positions[i], { parameters: low }).action);
      const highDecision = JSON.stringify(chooseAIAction(positions[i], { parameters: high }).action);
      if (lowDecision !== highDecision || lowDecision !== baseline[i]) diffs++;
    }
    decisions.set(key, diffs);
    assert.ok(diffs > 0, `参数 ${key} 在 ${positions.length} 个位置上未产生任何决策差异，疑似虚假参数`);
  }
});
