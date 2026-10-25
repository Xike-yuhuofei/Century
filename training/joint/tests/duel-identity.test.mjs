/** duel 版本身份回归：js0/js1/beam-pure 不得再被活动冠军 adapter 吞掉。
 *
 * 运行：node --test training/joint/tests/duel-identity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { candidateVersion } from '../duel.mjs';

test('js0 = 历史束搜索冠军（无 adapter），不是 JS5', () => {
  const v = candidateVersion('js0');
  assert.equal(v.kind, 'champion');
  assert.equal(v.id, 'js0-ai5-readiness-efficiency');
  assert.equal(v.parameters.adapter, undefined, 'js0 参数不得携带 adapter');
  assert.equal(v.parameters.id, 'ai5-readiness-efficiency');
  assert.equal(v.parameters.structure, 'beam-rollout');
  assert.equal(v.structure, 'beam-rollout');
});

test('js1 = 历史冠军参数 + beam-contest 结构（结构真实生效）', () => {
  const v = candidateVersion('js1');
  assert.equal(v.kind, 'champion');
  assert.equal(v.parameters.adapter, undefined);
  assert.equal(v.structure, 'beam-contest');
});

test('beam-pure = struct-beam-rollout 纯束搜索基座', () => {
  const v = candidateVersion('beam-pure');
  assert.equal(v.kind, 'champion');
  assert.equal(v.parameters.id, 'struct-beam-rollout');
  assert.equal(v.parameters.adapter, undefined);
  assert.equal(v.parameters.acquisitionVariant, undefined);
  assert.equal(v.structure, 'beam-rollout');
});

test('js5 / js5-opt 仍走联合适配器版本', () => {
  for (const id of ['js5', 'joint-js5', 'joint-js5-opt']) {
    const v = candidateVersion(id);
    assert.equal(v.kind, 'joint');
    assert.equal(v.joint, id.startsWith('joint-') ? id : `joint-${id}`);
  }
});
