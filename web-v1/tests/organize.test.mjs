import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleOrder, moveInOrder, stepInOrder, groupOrder } from '../dist/js/organize.js';
test('整理不丢卡，获取新牌自动追加', () => {
  assert.deepEqual(visibleOrder(['M2','M1','M3'], ['M1','M2']), ['M1','M2','M3']);
  assert.deepEqual(visibleOrder(['M1'], ['M1','M9']), ['M1']);
});
test('拖动插入不重置其他卡顺序', () => {
  assert.deepEqual(moveInOrder(['A','B','C','D'], ['A','B','C','D'], 'D','B'), ['A','D','B','C']);
  assert.deepEqual(moveInOrder(['A','B'], ['A','B'], 'Z','A'), ['A','B']);
});
test('左移右移遵守边界', () => {
  assert.deepEqual(stepInOrder(['A','B','C'], ['A','B','C'], 'B',-1), ['B','A','C']);
  assert.deepEqual(stepInOrder(['A','B','C'], ['A','B','C'], 'A',-1), ['A','B','C']);
});
test('分类排序保持同类别原有顺序', () => {
  const m={A:'trade',B:'create',C:'upgrade',D:'create',E:'trade'};
  assert.deepEqual(groupOrder(['A','B','C','D','E'], ['E','D','A','C','B'], id=>m[id]),['D','B','C','E','A']);
});
