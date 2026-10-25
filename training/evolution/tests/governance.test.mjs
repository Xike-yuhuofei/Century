/** 治理适配器：只允许开发池、拒绝验证池、挑战请求必须人工审批、绝不自动晋级。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDoubleGovernance, createGovernanceAdapter, rotatedWindowIndex,
} from '../governance-adapter.mjs';
import {
  AI7_DEV_BLOCKS, assertNotValidationSeed, assertWindow, VALIDATION_POOL_BLOCK,
} from '../core.mjs';

test('测试替身只分配 AI7 开发块窗口，screen/deep 互不重叠', () => {
  const provider = createTestDoubleGovernance();
  const adapter = createGovernanceAdapter({ provider });
  const screen = adapter.allocateDevSeedWindow({ campaignId: 'gov-test', round: 1, purpose: 'screen', count: 4 });
  const deep = adapter.allocateDevSeedWindow({ campaignId: 'gov-test', round: 1, purpose: 'deep', count: 4 });
  assert.equal(screen.pool, 'dev');
  assert.equal(deep.pool, 'dev');
  assert.equal(screen.base >= AI7_DEV_BLOCKS.screen[0] && screen.base + screen.count <= AI7_DEV_BLOCKS.screen[1], true);
  assert.equal(deep.base >= AI7_DEV_BLOCKS.deep[0] && deep.base + deep.count <= AI7_DEV_BLOCKS.deep[1], true);
  assert.equal(screen.base < deep.base, true);
  assert.equal(assertNotValidationSeed(screen.base), screen.base);
  assert.throws(() => assertNotValidationSeed(VALIDATION_POOL_BLOCK[0]), /正式验证池/);
});

test('窗口轮换：不同 round 使用不同窗口，已用窗口被排除', () => {
  const provider = createTestDoubleGovernance();
  const adapter = createGovernanceAdapter({ provider });
  const first = adapter.allocateDevSeedWindow({ campaignId: 'gov-rotate', round: 1, purpose: 'screen', count: 2 });
  const second = adapter.allocateDevSeedWindow({
    campaignId: 'gov-rotate', round: 2, purpose: 'screen', count: 2,
    excludeWindowIds: [first.windowId],
  });
  assert.notEqual(first.windowId, second.windowId);
  assert.ok(second.base !== first.base);
  assert.equal(rotatedWindowIndex({ purpose: 'screen', round: 1 }), 0);
  assert.equal(rotatedWindowIndex({ purpose: 'screen', round: 2 }), 1);
});

test('provider 返回验证池/非 dev 池 → 适配器立即拒绝', () => {
  const badPool = {
    ...createTestDoubleGovernance(),
    allocateDevSeedWindow() {
      return { windowId: 'bad', purpose: 'screen', pool: 'validation', base: VALIDATION_POOL_BLOCK[0], count: 2 };
    },
  };
  const adapter = createGovernanceAdapter({ provider: badPool });
  assert.throws(() => adapter.allocateDevSeedWindow({
    campaignId: 'gov-bad', round: 1, purpose: 'screen', count: 2,
  }), /非开发池|正式验证池/);
});

test('provider 返回越界窗口 → 拒绝', () => {
  const badWindow = {
    ...createTestDoubleGovernance(),
    allocateDevSeedWindow() {
      return { windowId: 'bad', purpose: 'screen', pool: 'dev', base: AI7_DEV_BLOCKS.screen[1] - 1, count: 10 };
    },
  };
  const adapter = createGovernanceAdapter({ provider: badWindow });
  assert.throws(() => adapter.allocateDevSeedWindow({
    campaignId: 'gov-bad2', round: 1, purpose: 'screen', count: 2,
  }), /越界/);
});

test('正式挑战请求：必须 pending-human-approval、approvalRequired、promotionTriggered=false', () => {
  const provider = createTestDoubleGovernance();
  const adapter = createGovernanceAdapter({ provider });
  const request = adapter.requestFormalChallengeApproval({
    campaignId: 'gov-approval',
    candidateId: 'cand-ai7-test',
    identityDigest: 'a'.repeat(64),
    evidenceDir: '/tmp/evidence',
    summary: { note: 'demo' },
  });
  assert.equal(request.status, 'pending-human-approval');
  assert.equal(request.approvalRequired, true);
  assert.equal(request.promotionTriggered, false);
  assert.equal(request.validationPoolConsumed, false);
  assert.match(request.requestId, /^greq-/);
  assert.equal(provider.requests().length, 1);
});

test('provider 试图自动批准/晋级 → 适配器拒绝', () => {
  const autoApprove = {
    ...createTestDoubleGovernance(),
    requestFormalChallengeApproval(req) {
      return {
        requestId: 'greq-auto', candidateId: req.candidateId, identityDigest: req.identityDigest,
        status: 'approved', approvalRequired: true, promotionTriggered: false,
      };
    },
  };
  const adapter = createGovernanceAdapter({ provider: autoApprove });
  assert.throws(() => adapter.requestFormalChallengeApproval({
    campaignId: 'gov-auto', candidateId: 'cand-ai7-test', identityDigest: 'b'.repeat(64), evidenceDir: '/tmp/e',
  }), /pending-human-approval/);

  const autoPromote = {
    ...createTestDoubleGovernance(),
    requestFormalChallengeApproval(req) {
      return {
        requestId: 'greq-promote', candidateId: req.candidateId, identityDigest: req.identityDigest,
        status: 'pending-human-approval', approvalRequired: true, promotionTriggered: true,
      };
    },
  };
  const adapter2 = createGovernanceAdapter({ provider: autoPromote });
  assert.throws(() => adapter2.requestFormalChallengeApproval({
    campaignId: 'gov-promote', candidateId: 'cand-ai7-test', identityDigest: 'c'.repeat(64), evidenceDir: '/tmp/e',
  }), /禁止自动晋级/);
});

test('窗口大小/区块参数校验', () => {
  assert.throws(() => assertWindow({ base: 1_610_000_000, count: 20_000_000, block: AI7_DEV_BLOCKS.screen }), /越界/);
  const provider = createTestDoubleGovernance({ windowSize: 2_000 });
  assert.equal(provider.describePolicy().windowSize, 2_000);
  assert.throws(() => createTestDoubleGovernance({ windowSize: 3 }), /整除/);
});
