/** AI9 真实决策接线：候选模块必须实际控制 chooseAIAction（不是只注册接口）。
 *
 * 三层证据：
 * 1. 官方模块候选的探针输出与官方逐值一致（缺省行为不变）；
 * 2. 确定性变异候选的探针输出发生真实变化（每个模块都被执行）；
 * 3. 变异候选在同一公开对局中产生与官方不同的真实决策（决策级接线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCompiledModuleCandidate, loadCompiledCandidateModules, MULTI_MODULE_INFO,
} from '../multi-module-candidate.mjs';
import { mutateModules, mutateModuleFunction } from '../module-mutations.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const experiment = {
  configRef: 'ai9://test/wiring',
  configHash: 'b'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: 'ai9-screen-w001', base: 1_660_001_000, count: 4 },
    { purpose: 'deep', windowId: 'ai9-deep-w001', base: 1_670_001_000, count: 4 },
  ],
};

const WIRING_MODULES = [
  'M01', 'M02', 'M03', 'M04', 'M05', 'M06',
  'M07', 'M08', 'M09', 'M10', 'M11', 'M12',
];

test('决策接线：官方模块候选 ≈ 冻结冠军（探针逐值一致），变异候选全部模块可观测', { timeout: 240_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true);
  const neutral = createCompiledModuleCandidate({
    moduleIds: WIRING_MODULES,
    experiment,
    round: 1,
    index: 0,
    sourceOrigin: 'test-neutral',
    candidateId: 'cand-ai9-test-neutral',
  });
  assert.equal(neutral.probe.identicalToOfficial, true);
  assert.equal(neutral.probe.probeErrors, 0);

  const mutated = createCompiledModuleCandidate({
    modules: mutateModules(WIRING_MODULES),
    moduleIds: WIRING_MODULES,
    experiment,
    round: 1,
    index: 1,
    sourceOrigin: 'test-mutated',
    candidateId: 'cand-ai9-test-mutated',
  });
  assert.deepEqual(mutated.probe.changedModules.sort(), [...WIRING_MODULES].sort());
  assert.equal(mutated.probe.probeErrors, 0);
});

test('M06/M07/M09 算法级变异：公开名次/对手推断/后验支持候选可编译并通过探针', { timeout: 240_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true);
  const ids = ['M06', 'M07', 'M09'];
  const created = createCompiledModuleCandidate({
    modules: ids.map(id => mutateModuleFunction(id, 0)),
    moduleIds: ids,
    experiment,
    round: 1,
    index: 7,
    sourceOrigin: 'test-algorithmic-variants',
    candidateId: 'cand-ai9-test-algorithmic',
  });
  assert.equal(created.probe.probeErrors, 0);
  assert.equal(created.probe.identicalToOfficial, false);
  assert.deepEqual(created.probe.changedModules.sort(), [...ids].sort());
});

test('正式挑战执行器：编译候选注入 A 臂后与免费冠军臂逐局一致（中性模块）', { timeout: 240_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, async () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true);
  const created = createCompiledModuleCandidate({
    moduleIds: ['M01', 'M02'],
    experiment,
    round: 1,
    index: 3,
    sourceOrigin: 'test-formal-executor',
    candidateId: 'cand-ai9-test-formal-exec',
  });
  const loaded = await loadCompiledCandidateModules(created.artifact);
  const { buildRegistry } = await import('../../adversarial/registry.mjs');
  const { runFirstPlaceSeatChallenge } = await import('../../tournament/first-place-challenge.mjs');
  const registry = buildRegistry({ jointOptions: { workUnits: 4 } });
  const champion = registry.versions['js5-frozen-champion'];
  const opponents = ['style-engine', 'neutral-baseline'].map(id => ({
    ...registry.versions[id].parameters, id,
  }));
  try {
    const run = runFirstPlaceSeatChallenge({
      champion: champion.parameters,
      candidate: created.artifact.parameters.values,
      opponents,
      seeds: [1_654_000_100, 1_654_000_101],
      seatCount: 2,
      workUnits: 4,
      executorA: { aiModule: loaded.aiModule, jointModule: loaded.jointModule },
    });
    assert.equal(run.anomalyGames, 0, JSON.stringify(run.games.filter(g => g.status !== 'finished')));
    for (const pair of run.pairs) {
      assert.equal(pair.candidateFirst, pair.championFirst,
        `中性编译候选在 seed=${pair.seed} 与冠军出现行为差异：${JSON.stringify(pair)}`);
    }
  } finally {
    loaded.cleanup();
  }
});

test('决策接线：同一公开对局中变异候选与官方第一次分歧可复现', { timeout: 240_000, skip: !MULTI_MODULE_INFO.seatbeltAvailable }, async () => {
  assert.equal(MULTI_MODULE_INFO.seatbeltAvailable, true);
  const created = createCompiledModuleCandidate({
    modules: mutateModules(WIRING_MODULES),
    moduleIds: WIRING_MODULES,
    experiment,
    round: 1,
    index: 2,
    sourceOrigin: 'test-mutated-decision',
    candidateId: 'cand-ai9-test-decision',
  });
  const loaded = await loadCompiledCandidateModules(created.artifact);
  const officialAI = await import(pathToFileURL(join(REPO_ROOT, 'web-v1/dist/js/ai.js')).href);
  const engine = await import(pathToFileURL(join(REPO_ROOT, 'web-v1/dist/js/engine.js')).href);
  const champion = JSON.parse(await import('node:fs').then(fs =>
    fs.readFileSync(join(REPO_ROOT, 'training/champions/champion.json'), 'utf8'))).parameters;
  const temp = mkdtempSync(join(tmpdir(), 'ai9-decision-'));
  try {
    const seed = 1_640_000_001; // 未分配评测块，仅作接线回归
    const makeGame = () => {
      const game = engine.createGame(['S0', 'S1', 'S2', 'S3', 'S4'], seed, [1, 2, 3, 4]);
      game.players[0].isAI = true;
      return game;
    };
    let officialGame = makeGame();
    let candidateGame = makeGame();
    let divergence = null;
    for (let move = 0; move < 40 && officialGame.phase !== 'finished'; move++) {
      const seat = officialGame.current;
      const profile = seat === 0 ? officialAI.NEUTRAL_PROFILE : officialAI.PROFILES[(seat - 1) % officialAI.PROFILES.length];
      const officialResponse = officialAI.chooseAIAction(officialGame, {
        parameters: champion, profile, workUnits: 8,
      });
      const candidateResponse = loaded.aiModule.chooseAIAction(candidateGame, {
        parameters: { ...champion, id: 'ai9-test-decision' }, profile, workUnits: 8,
      });
      const a = JSON.stringify(officialResponse.action);
      const b = JSON.stringify(candidateResponse.action);
      if (a !== b) {
        divergence = { seat, move, official: officialResponse.action, candidate: candidateResponse.action };
        break;
      }
      officialGame = engine.applyAction(officialGame, officialResponse.action);
      candidateGame = engine.applyAction(candidateGame, candidateResponse.action);
    }
    assert.ok(divergence, '变异候选在 40 步内未产生任何决策差异——模块没有真正接线');
    assert.notEqual(JSON.stringify(divergence.official), JSON.stringify(divergence.candidate));
  } finally {
    loaded.cleanup();
    rmSync(temp, { recursive: true, force: true });
  }
});
