/** v2：失败诊断反馈注入 + 多轴模块选择 的回归测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResearchFeedback, mapResearchTargets } from '../openevolve-multi-bridge.mjs';
import { selectOpenEvolveModules } from '../multi-module-generator.mjs';
import { composeProgram } from '../../../ai5/openevolve/node/module_registry.mjs';

test('研究提示转成短注释行并限制数量/长度', () => {
  const hints = {
    suggestedTargets: ['M03', 'M10', 'M08', 'M11', 'M01', 'M02', 'M04'],
    curriculum: {
      targetPriority: ['M03', 'M10'],
      focusLabels: [
        { code: 'claim-delay', label: '认领延迟', status: 'finding', occurrences: 32 },
        { code: 'contest-loss', label: '竞争抢牌失败', status: 'finding', occurrences: 12 },
        { code: 'rest-waste', label: '休息浪费', status: 'absent', occurrences: 0 },
      ],
    },
    promptHints: [
      '研究提示（认领延迟）：竞争机会 4 次未转化为获取；优先探索 M10/M03。',
      '研究提示（竞争抢牌失败）：4 次他人获取时本席付得起位置费。',
      'x'.repeat(500),
    ],
  };
  const lines = formatResearchFeedback(hints, { selectedModules: ['M03', 'M10', 'M08', 'M11'] });
  assert.equal(lines.length, 7);
  assert.match(lines[0], /Selected modules: M03, M10, M08, M11/);
  assert.match(lines[1], /Prioritize modules: M03, M10, M08, M11/);
  assert.match(lines[2], /claim-delay/);
  assert.match(lines[2], /contest-loss/);
  assert.ok(!lines[2].includes('rest-waste'));
  assert.ok(lines.every(line => line.length <= 300));
  assert.match(lines.at(-1), /validate with real paired games/);
});

test('AI7 诊断目标名映射到本次选中的 AI9 模块', () => {
  const lines = formatResearchFeedback(
    { suggestedTargets: ['candidateCap', 'acquisitionValue'], promptHints: [] },
    { selectedModules: ['M10', 'M03'] },
  );
  assert.match(lines[0], /Selected modules: M10, M03/);
  assert.match(lines[1], /Prioritize modules: M10, M03/);
});

test('无诊断输入不产生反馈行', () => {
  assert.deepEqual(formatResearchFeedback(null), []);
  assert.deepEqual(formatResearchFeedback({}), []);
  assert.deepEqual(formatResearchFeedback({ promptHints: [] }), []);
});

test('多轴选择覆盖 4–6 个唯一模块', () => {
  const ids = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'];
  const low = selectOpenEvolveModules(ids, () => 0);
  assert.equal(low.length, 4);
  assert.equal(new Set(low).size, 4);
  const high = selectOpenEvolveModules(ids, () => 0.99);
  assert.equal(high.length, 6);
  assert.equal(new Set(high).size, 6);
  assert.deepEqual(selectOpenEvolveModules(['M01', 'M02'], () => 0), ['M01', 'M02']);
});

test('失败诊断优先模块进入提案', () => {
  const ids = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'];
  const selected = selectOpenEvolveModules(ids, () => 0, ['M10', 'M12']);
  assert.equal(selected.length, 4);
  assert.equal(new Set(selected).size, 4);
  assert.ok(selected.includes('M10'));
  assert.ok(selected.includes('M12'));
});

test('AI7 诊断目标映射到选中模块并去重', () => {
  const mapped = mapResearchTargets(
    { suggestedTargets: ['candidateCap', 'acquisitionValue', 'candidateCap'] },
    ['M10', 'M03', 'M08'],
  );
  assert.deepEqual(mapped, ['M10', 'M03']);
});

test('反馈只进入程序头注释，不改变 EVOLVE-BLOCK 数量', () => {
  const feedback = ['Prioritize modules: M03, M10.', 'Hint: 竞争抢牌失败优先。'];
  const program = composeProgram(['M01', 'M02'], { feedback });
  assert.match(program, /RESEARCH FEEDBACK \(advisory only; not reward truth\)/);
  assert.match(program, /\/\/ Prioritize modules: M03, M10\./);
  assert.equal((program.match(/EVOLVE-BLOCK-START/g) || []).length, 2);
  assert.equal((program.match(/EVOLVE-BLOCK-END/g) || []).length, 2);
  const baseline = composeProgram(['M01', 'M02']);
  assert.ok(!baseline.includes('RESEARCH FEEDBACK'));
});
