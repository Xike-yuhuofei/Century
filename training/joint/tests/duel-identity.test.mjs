/** duel 版本身份回归：js0/js1 不得再被活动冠军 adapter 吞掉。
 *
 * 合并上游 P0-1 后，身份由不可变版本注册表解析（legacy-js0 / legacy-js1）；
 * 本测试锁定"标签身份 = 执行身份"的注册表语义。
 *
 * 运行：node --test training/joint/tests/duel-identity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { candidateVersion } from '../duel.mjs';

test('js0 = 冻结束搜索冠军（无 adapter），不是 JS5', () => {
  const v = candidateVersion('js0');
  assert.equal(v.kind, 'champion');
  assert.equal(v.id, 'js0-frozen-champion');
  assert.equal(v.descriptor.registryId, 'legacy-js0');
  assert.equal(v.descriptor.core, 'beam-search');
  assert.equal(v.descriptor.structure, 'beam-rollout');
  assert.equal(v.descriptor.parameters.adapter, undefined, 'js0 参数不得携带 adapter');
  assert.equal(v.descriptor.parameters.id, 'ai5-readiness-efficiency');
  assert.equal(v.descriptor.immutable, true);
});

test('js1 = 冻结基座 + beam-contest 结构（结构真实生效）', () => {
  const v = candidateVersion('js1');
  assert.equal(v.kind, 'champion');
  assert.equal(v.descriptor.registryId, 'legacy-js1');
  assert.equal(v.descriptor.structure, 'beam-contest');
  assert.equal(v.descriptor.parameters.adapter, undefined);
  assert.equal(v.descriptor.immutable, true);
});

test('js5 / js5-opt 仍走联合适配器版本', () => {
  for (const id of ['js5', 'joint-js5', 'joint-js5-opt']) {
    const v = candidateVersion(id);
    assert.equal(v.kind, 'joint');
    assert.equal(v.joint, id.startsWith('joint-') ? id : `joint-${id}`);
  }
});
