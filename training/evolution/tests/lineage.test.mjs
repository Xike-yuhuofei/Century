/** P0.1 验收：跨代源码继承（三代真实读取父代代码）+ 父代损坏拒绝继续。
 *
 * 设计：
 * - 真实多模块候选生成（Seatbelt + tsc），只注入假评估器避免长对局；
 * - 第 2/3 轮父代来自第 1/2 轮深验精英（真实 artifact 源码）；
 * - 断言每代 lineage 的父代源码哈希、父模块哈希与 modulesChanged；
 * - 断言未被修改的模块逐字节等于父代（证明继承而不是重新生成）；
 * - 断言父代缺失/哈希不符时拒绝继续。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampaignController } from '../campaign-controller.mjs';
import { createTestDoubleGovernance, createGovernanceAdapter } from '../governance-adapter.mjs';
import { AI9_DEV_BLOCKS, sha256Canonical } from '../core.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { SEATBELT_AVAILABLE } from '../sandbox/seatbelt.mjs';

// 编译型候选依赖 macOS Seatbelt；在无沙箱环境（如 ubuntu CI）必须显式跳过，
// 不能把"没有沙箱"当成通过证据。
const seatbeltSkip = SEATBELT_AVAILABLE ? false : 'Seatbelt 不可用（非 macOS）：跨代继承测试需在 macOS Runner 执行';

function baseConfig(overrides = {}) {
  return {
    configRef: 'ai9://test-lineage',
    rounds: 3,
    playerCounts: [2],
    quickSeeds: 2,
    deepSeeds: 2,
    maxMoves: 60,
    deadlineMs: 5_000,
    retainTopK: 2,
    deepConfirmations: 1,
    generation: {
      count: 2, seed: 424242, mode: 'multi-module', strategies: ['single'],
      includeControl: false, allowDeterministicFallback: true, openevolveIterations: 1,
    },
    budget: { maxCandidates: 20, maxGames: 400, maxWallMs: 3_600_000, maxConcurrent: 1, maxDeepConfirmations: 3 },
    diagnosticsPath: null,
    humanAnalyticsFailuresPath: null,
    ...overrides,
  };
}

/** 假评估器：返回配对设计证据（16 个配对单位），不跑真实对局。
 * 证据随调用次数单调递增，保证精英排序与代际链稳定可断言。 */
let evaluationSeq = 0;
function fakeEvaluator({ artifact, seeds, purpose }) {
  evaluationSeq += 1;
  const delta = 0.1 + evaluationSeq * 0.002;
  const modules = artifact.source?.modules?.map(m => m.id) ?? [];
  const behaviorSignature = {
    kind: 'compiled-module-behavior-v1',
    actions: { acquire: 0.2, claim: 0.1, rest: 0.2, play: 0.4 },
    modules,
  };
  return {
    schema: 'test-evidence', candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest, evaluationMode: 'game', purpose,
    metrics: {
      evidenceType: 'dev-game-compiled-modules',
      totalGames: 32, finishedGames: 32, anomalies: 0, anomalyRate: 0,
      pairs: 16, finishedPairs: 16,
      candidateFirstRate: 0.5, championFirstRate: 0.35,
      firstPlaceDelta: Number(delta.toFixed(4)), firstPlaceDeltaPooledCi: { oneSidedLower: -0.05 },
      chanceAdjustedRate: 0.1, minWilsonLower: 0.2,
    },
    behaviorSignature, behaviorHash: sha256Canonical(behaviorSignature),
  };
}

function makeController(root, config = {}) {
  const provider = createTestDoubleGovernance({
    screenBlock: AI9_DEV_BLOCKS.screen, deepBlock: AI9_DEV_BLOCKS.deep,
  });
  const governance = createGovernanceAdapter({ provider, blocks: AI9_DEV_BLOCKS });
  return new CampaignController({
    campaignId: 'lineage-test', rootDir: root, governance,
    config: baseConfig(config), evaluator: fakeEvaluator,
  });
}

test('三代跨代继承：每代真实读取父代源码并累积修改', { skip: seatbeltSkip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai11-lineage-'));
  const results = await makeController(root).run();
  assert.equal(results.status, 'completed', `status=${results.status}`);
  const store = new ArtifactStore({ root: join(root, 'artifacts') });
  const rounds = results.rounds;
  assert.equal(rounds.length, 3);

  const deepElite = round => round.candidates.find(c => c.deep?.status === 'done');

  const first = deepElite(rounds[0]);
  assert.ok(first, '第一轮必须有深验通过候选');
  assert.equal(first.parentId, null, '引导代不得声明父代');
  assert.ok(first.lineage.modulesChanged.length >= 1, '引导代必须记录被改动的模块');

  let parent = first;
  for (const round of rounds.slice(1)) {
    const child = deepElite(round);
    assert.ok(child, `第 ${round.round} 轮必须有深验通过候选`);
    assert.equal(child.parentId, parent.candidateId,
      `第 ${round.round} 轮父代必须来自上一代精英（实际 ${String(child.parentId)}）`);
    const parentArtifact = store.get(parent.candidateId);
    assert.equal(child.lineage.parentSourceHash, parentArtifact.sourceHash,
      'lineage.parentSourceHash 必须等于父代 artifact 的真实 sourceHash');
    for (const [id, hash] of Object.entries(child.lineage.parentModuleHashes ?? {})) {
      const parentModule = parentArtifact.source.modules.find(m => m.id === id);
      assert.equal(hash, parentModule.functionSha256, `父代模块 ${id} 哈希必须与实际源码一致`);
    }
    assert.ok(child.lineage.modulesChanged.length >= 1, `第 ${round.round} 轮必须与父代源码不同`);
    assert.ok(child.lineage.inputProgramHash, '必须记录本代输入程序哈希');
    assert.ok(child.lineage.outputProgramHash, '必须记录本代输出程序哈希');

    const childArtifact = store.get(child.candidateId);
    const childHashes = Object.fromEntries(childArtifact.source.modules.map(m => [m.id, m.functionSha256]));
    for (const module of parentArtifact.source.modules) {
      if (child.lineage.modulesChanged.includes(module.id)) continue;
      assert.equal(childHashes[module.id], module.functionSha256,
        `${module.id} 未被修改时必须逐字节继承父代源码`);
    }
    parent = child;
  }
});

test('父代缺失：拒绝继续进化（不得静默回落到官方基线）', { skip: seatbeltSkip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai11-lineage-missing-'));
  const controller = makeController(root, { rounds: 1, parentCandidateId: 'cand-does-not-exist' });
  await assert.rejects(() => controller.run(), /显式父候选不可用/);
});

test('父代哈希被篡改：拒绝继续进化', { skip: seatbeltSkip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai11-lineage-tamper-'));
  const results = await makeController(root, { rounds: 1 }).run();
  const candidate = results.rounds[0].candidates.find(c => c.deep?.status === 'done');
  assert.ok(candidate, '需要真实 artifact 才能构造篡改场景');
  const objectDir = join(root, 'artifacts', 'objects', candidate.candidateId);
  const digestDir = readdirSync(objectDir)[0];
  const artifactPath = join(objectDir, digestDir, 'candidate.json');
  const tampered = JSON.parse(readFileSync(artifactPath, 'utf8'));
  tampered.sourceHash = 'f'.repeat(64);
  writeFileSync(artifactPath, JSON.stringify(tampered));

  const second = makeController(join(root, 'second'), { rounds: 1, parentCandidateId: candidate.candidateId });
  await assert.rejects(() => second.run(), /父候选不可用|sourceHash|哈希/i);
});

test('消融候选（移除模块）是真实变化，不得被判为"无变化伪代"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai11-lineage-ablation-'));
  const provider = createTestDoubleGovernance({
    screenBlock: AI9_DEV_BLOCKS.screen, deepBlock: AI9_DEV_BLOCKS.deep,
  });
  const governance = createGovernanceAdapter({ provider, blocks: AI9_DEV_BLOCKS });
  const controller = new CampaignController({
    campaignId: 'lineage-ablation', rootDir: root, governance,
    config: baseConfig({ rounds: 1, generation: { count: 1, seed: 1, mode: 'multi-module', strategies: ['single'], includeControl: false } }),
    evaluator: fakeEvaluator,
  });
  const parent = {
    candidateId: 'cand-parent-ablation',
    parentId: null,
    sourceHash: 'a'.repeat(64),
    source: { modules: [
      { id: 'M02', functionSha256: 'b'.repeat(64) },
      { id: 'M03', functionSha256: 'c'.repeat(64) },
    ] },
  };
  const child = {
    candidateId: 'cand-child-ablation',
    parentId: parent.candidateId,
    sourceHash: 'd'.repeat(64),
    source: { modules: [{ id: 'M02', functionSha256: 'b'.repeat(64) }] },
    lineage: {
      parentCandidateId: parent.candidateId,
      parentSourceHash: parent.sourceHash,
      parentModuleHashes: { M02: 'b'.repeat(64), M03: 'c'.repeat(64) },
      inputProgramHash: null,
      outputProgramHash: 'e'.repeat(64),
      bestProgramHash: null,
      modulesChanged: [],
      modulesInherited: null,
      fallbackToOfficial: null,
      operator: 'ablation:remove-M03',
      hypothesisId: null,
      configPath: null,
      checkpointResumedFrom: null,
      llm: null,
      outputDir: null,
      bestProgramPath: null,
    },
  };
  assert.equal(controller._verifyLineage({ artifact: child, parentArtifact: parent, round: 2 }), true,
    '移除模块的消融候选必须被接受');
  const noChange = {
    ...child,
    source: { modules: [
      { id: 'M02', functionSha256: 'b'.repeat(64) },
      { id: 'M03', functionSha256: 'c'.repeat(64) },
    ] },
  };
  assert.throws(() => controller._verifyLineage({ artifact: noChange, parentArtifact: parent, round: 2 }),
    /既无修改也无移除模块/, '真正无变化的候选必须被拒绝');
});
