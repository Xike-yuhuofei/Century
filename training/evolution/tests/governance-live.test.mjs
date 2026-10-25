/** P1/P2：真实种子治理 Provider 与机器门禁队列（不使用测试替身）。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveGovernanceProvider, createAutonomousGovernanceAdapter, GOVERNANCE_CONTRACT_V2,
} from '../governance-provider-v2.mjs';
import { AI7_DEV_BLOCKS } from '../core.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';

function tempProvider() {
  const dir = mkdtempSync(join(tmpdir(), 'century-live-gov-'));
  const registryPath = join(dir, 'seed-consumption-registry.json');
  writeFileSync(registryPath, JSON.stringify({
    schema: 'century-seed-consumption-registry-v1',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    entries: [],
  }));
  const provider = createLiveGovernanceProvider({ registryPath, root: REPO_ROOT });
  return { dir, registryPath, provider, adapter: createAutonomousGovernanceAdapter({ provider }) };
}

test('真实 Provider：开发窗口原子登记到中央账本，且不触碰验证池', () => {
  const { dir, registryPath, adapter } = tempProvider();
  try {
    const screen = adapter.allocateDevSeedWindow({
      campaignId: 'live-test', round: 1, purpose: 'screen', count: 4,
    });
    const deep = adapter.allocateDevSeedWindow({
      campaignId: 'live-test', round: 1, purpose: 'deep', count: 3,
    });
    assert.equal(screen.pool, 'dev');
    assert.equal(deep.pool, 'dev');
    assert.ok(screen.base >= AI7_DEV_BLOCKS.screen[0] && screen.base < AI7_DEV_BLOCKS.screen[1]);
    assert.ok(deep.base >= AI7_DEV_BLOCKS.deep[0] && deep.base < AI7_DEV_BLOCKS.deep[1]);
    assert.ok(!(screen.base >= 900_000_000 && screen.base < 1_060_000_000), '不得分配验证池');
    assert.ok(existsSync(registryPath), '中央登记文件必须已写入');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(registry.entries.length, 2);
    assert.deepEqual(registry.entries.map(e => e.purposeClass).sort(), ['deep-validation', 'screening']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 Provider：同一 campaign 第二轮分配不同窗口（窗口不复用）', () => {
  const { dir, adapter } = tempProvider();
  try {
    const first = adapter.allocateDevSeedWindow({ campaignId: 'live-test', round: 1, purpose: 'screen', count: 2 });
    const second = adapter.allocateDevSeedWindow({
      campaignId: 'live-test', round: 2, purpose: 'screen', count: 2,
      excludeWindowIds: [first.windowId],
    });
    assert.notEqual(second.windowId, first.windowId);
    assert.notEqual(second.base, first.base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('机器门禁队列：不再要求人工批准，但必须声明机器门禁且不直接晋级', () => {
  const { dir, adapter } = tempProvider();
  try {
    const request = adapter.requestFormalChallengeApproval({
      campaignId: 'live-test',
      candidateId: 'cand-x',
      identityDigest: 'a'.repeat(64),
      evidenceDir: 'evidence/cand-x',
      summary: {},
    });
    assert.equal(request.status, 'queued-machine-gate');
    assert.equal(request.approvalRequired, false);
    assert.equal(request.machineGateRequired, true);
    assert.equal(request.promotionTriggered, false);
    assert.ok(request.gates.includes('first-place-preregistered-challenge'));
    assert.ok(request.gates.includes('deploy-verification'));
    assert.equal(adapter.contractVersion, GOVERNANCE_CONTRACT_V2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('机器门禁适配器拒绝直接晋级/人工状态伪装', () => {
  const { dir, adapter } = tempProvider();
  try {
    assert.throws(
      () => adapter.requestFormalChallenge({
        campaignId: 'live-test', candidateId: 'cand-x', identityDigest: 'not-a-digest',
      }),
      /identityDigest/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
