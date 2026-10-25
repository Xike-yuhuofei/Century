/** AI7 可信底座红队回归（任务 A5）。
 *
 * 每个用例对应一种必须被识别并阻断的失败模式：
 * 1. 删除/缺失账本 → fail-closed；
 * 2. 伪造 challengeIndex → 拒绝；
 * 3. 重用已消费种子 → 拒绝；
 * 4. 修改源码但保留旧 dist → 构建一致性校验失败；
 * 5. 修改活动冠军参数后调用冻结 JS5 → 冻结身份/配置不变；
 * 6. 恢复不存在的断点 → evolve-cli 拒绝（见 cli.e2e.test.mjs）；
 * 7. 伪造产物指纹 → 晋级/构建校验拒绝（见 promote.test.mjs）；
 * 8. 缺失人数的晋级文件 → 拒绝（见 promote.test.mjs）。
 * 另外验证 PPO 900M 验证块与 long20 未入账区间被统一治理层识别/占用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../../web-v1/dist/js/engine.js';
import {
  chooseAIAction, BASELINE_PARAMETERS, CHAMPION_PARAMETERS,
  NEUTRAL_PROFILE, validateAIParameters,
} from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { resolveAlgorithmVersion } from '../lib/version-registry.mjs';
import { verifyVersionLock, VERSION_LOCK_PATH, LOCKED_FILES } from '../lib/version-lock.mjs';
import {
  loadSeedGovernance, querySeed, queryInterval, nextFormalValidationBase,
  formalChallengeCount, assertFormalChallengeAllocation, reserveConsumption,
} from '../lib/seed-governance.mjs';
import {
  createBuildManifest, verifyBuildManifest, BUILD_MANIFEST_PATH,
} from '../../web-v1/scripts/build-hash.mjs';
import { VALIDATION_POOL_BASE } from '../lib/seeds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CURRENT = loadSeedGovernance({ strict: true });

test('A1 负向：删除/缺失账本 → 治理层 fail-closed', () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'gov-empty-'));
  assert.throws(
    () => loadSeedGovernance({ root: emptyRoot, strict: true }),
    /种子账本缺失|fail-closed/,
    '缺失任一来源不得按空账本继续',
  );
  const lax = loadSeedGovernance({ root: emptyRoot, strict: false });
  assert.equal(lax.complete, false);
  assert.ok(lax.missingSources.length >= 10);
});

test('A1 负向：伪造 challengeIndex（小于累计/N+1）→ 正式挑战拒绝', () => {
  const nextBase = nextFormalValidationBase(CURRENT);
  const expectedIndex = formalChallengeCount(CURRENT) + 1;
  assert.doesNotThrow(() => assertFormalChallengeAllocation({
    registry: CURRENT, base: nextBase, size: 100, challengeIndex: expectedIndex,
  }));
  assert.throws(
    () => assertFormalChallengeAllocation({
      registry: CURRENT, base: nextBase, size: 100, challengeIndex: 1,
    }),
    /challengeIndex/,
    '伪造成 1 换取宽松阈值必须被拒绝',
  );
});

test('A1 负向：重用已消费的验证种子块 → 登记与分配拒绝', () => {
  const usedBase = 941512402; // challenge-11 已消费块
  const hits = querySeed(CURRENT, usedBase);
  assert.ok(hits.length > 0, '查询接口必须能定位已消费种子');
  assert.ok(queryInterval(CURRENT, usedBase, 10).length > 0);
  assert.throws(
    () => assertFormalChallengeAllocation({
      registry: CURRENT, base: usedBase, size: 100, challengeIndex: formalChallengeCount(CURRENT) + 1,
    }),
    /≠ 治理层下一块|重叠/,
  );
  // reserveConsumption 在写入前就会因区间重叠抛错（不会污染中央登记）。
  assert.throws(
    () => reserveConsumption({
      purposeClass: 'formal-challenge', purpose: 'test-reuse', base: usedBase, size: 10,
      experimentId: 'test-reuse-forbidden', challengeIndex: formalChallengeCount(CURRENT) + 1,
    }),
    /重叠|已消费|下一块/,
  );
});

test('A1 历史：PPO 900M 验证块被识别；long20 未入账区间被保守占用', () => {
  const ppo = CURRENT.entries.find(e => e.sourceId === 'ppo-ledger' && e.purposeClass === 'arena');
  assert.ok(ppo, 'PPO arena 消费的验证池块必须被统一治理层识别');
  assert.equal(ppo.base, 900000000);
  assert.equal(ppo.size, 40);
  const long20 = CURRENT.entries.find(e => e.experimentId === 'openevolve-long20-deep-validation-unledgered');
  assert.ok(long20, 'long20 未入账区间必须以历史只读声明占用');
  assert.equal(long20.base, 300001200);
  assert.equal(long20.size, 100);
  assert.equal(long20.uncertain, true);
  assert.equal(long20.status, 'historical-unverified');
  assert.equal(long20.countsTowardChallengeIndex, false, '深验不得计入正式挑战 alpha');
});

test('A3 负向：修改源码但保留旧 dist → 构建一致性 fail-closed', () => {
  const root = makeBuildFixture();
  const manifestPath = join(root, 'web-v1', BUILD_MANIFEST_PATH);
  const before = verifyBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') });
  assert.equal(before.ok, true, `夹具初始状态应一致：${before.errors.join('；')}`);

  writeFileSync(join(root, 'web-v1', 'src', 'main.ts'), 'export const value = 2;\n');
  const stale = verifyBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.some(e => e.includes('源码在构建后已变更')), stale.errors.join('；'));

  // 重新构建（重写清单）后恢复一致。
  const rebuilt = createBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') });
  writeFileSync(manifestPath, JSON.stringify(rebuilt, null, 2));
  assert.equal(verifyBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') }).ok, true);
});

test('A3/A4 规范化身份：仅参数块变化 → 决策核心不变、参数身份变化', () => {
  const root = makeBuildFixture();
  const manifestPath = join(root, 'web-v1', BUILD_MANIFEST_PATH);
  const before = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const parametersPath = join(root, 'web-v1/src/ai/parameters.ts');
  writeFileSync(parametersPath, readFileSync(parametersPath, 'utf8').replace('engineWeight: 1', 'engineWeight: 2'));
  // 参数块变化仍属于构建输入变化：未重建 → stale（必须 rebuild，不能直接跑）。
  assert.equal(verifyBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') }).ok, false);
  const after = createBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') });
  writeFileSync(manifestPath, JSON.stringify(after, null, 2));
  assert.equal(verifyBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') }).ok, true);
  assert.equal(after.decisionSource.sha256, before.decisionSource.sha256, '决策核心身份不得因参数值变化而漂移');
  assert.notEqual(after.championParameters.sha256, before.championParameters.sha256, '参数身份必须变化');
});

test('A3 负向：篡改 dist 产物 → 清单指纹不一致', () => {
  const root = makeBuildFixture();
  writeFileSync(join(root, 'web-v1', 'dist', 'js', 'ai.js'), 'export const tampered = true;\n');
  const result = verifyBuildManifest({ repoRoot: root, webRoot: join(root, 'web-v1') });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('产物与清单不一致')), result.errors.join('；'));
});

test('A2 冻结身份：不同活动/未来冠军参数不改变冻结 JS5 的决策与配置身份', () => {
  const frozen = resolveAlgorithmVersion('joint-js5-frozen');
  const fingerprintBefore = frozen.fingerprint;
  const game = probeGame(941512402, 9);
  const baseOptions = {
    version: 'joint-js5', gateMode: 'always', workUnits: 64, worlds: 1,
    simSeed: 4242, profile: NEUTRAL_PROFILE,
  };
  const a = chooseJointAction(game, { ...baseOptions, championParameters: frozen.parameters });
  const b = chooseJointAction(game, { ...baseOptions, championParameters: frozen.parameters });
  assert.deepEqual(a.action, b.action, '同一冻结描述符重复决策必须逐位一致');
  assert.equal(a.config.championParametersId, frozen.parameters.id);
  assert.equal(a.config.hash, b.config.hash);

  // 未来冠军（不同权重）作为活动基座：冻结版本的配置身份必须保持独立。
  const future = validateAIParameters({
    ...CHAMPION_PARAMETERS, id: 'future-champion', tempoWeight: 2, restWeight: 0.5,
  });
  const c = chooseJointAction(game, { ...baseOptions, championParameters: future });
  assert.equal(c.config.championParametersId, 'future-champion');
  assert.notEqual(c.config.hash, a.config.hash, '配置身份必须反映实际消费的冠军参数');
  assert.ok(c.action, '未来冠军参数也必须产生合法行动');

  // 冻结指纹不得因外部参数对象变化而漂移。
  assert.equal(resolveAlgorithmVersion('joint-js5-frozen').fingerprint, fingerprintBefore);
});

test('A2 负向：决策核心/归档被静默修改 → 版本锁拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'version-lock-'));
  for (const group of ['archives', 'decisionSources']) {
    for (const rel of LOCKED_FILES[group]) {
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(REPO_ROOT, rel), target);
    }
  }
  const lockTarget = join(root, VERSION_LOCK_PATH);
  mkdirSync(dirname(lockTarget), { recursive: true });
  copyFileSync(join(REPO_ROOT, VERSION_LOCK_PATH), lockTarget);
  assert.equal(verifyVersionLock({ root }).ok, true);
  const tampered = join(root, 'web-v1/src/js/adapter.ts');
  writeFileSync(tampered, readFileSync(tampered, 'utf8') + '\n// silent drift\n');
  const result = verifyVersionLock({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('adapter.ts')), result.errors.join('；'));
});

test('A3 溯源：当前构建清单记录 Git commit、dirty 状态与源码/产物双哈希', () => {
  const root = makeBuildFixture();
  const manifest = JSON.parse(readFileSync(join(root, 'web-v1', BUILD_MANIFEST_PATH), 'utf8'));
  assert.match(manifest.source.sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.ok('gitCommit' in manifest);
  assert.ok('gitDirty' in manifest);
  assert.ok(manifest.source.files.length > 0);
  assert.ok(manifest.artifact.files.some(f => f.path === 'engine.js'));
});

// ---- 夹具 ----

/** 最小 web-v1 构建夹具：验证哈希/清单行为，不依赖真实仓库源码。 */
function makeBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'build-fixture-'));
  const web = join(root, 'web-v1');
  const dirs = [
    'src', 'src/ai', 'scripts', 'dist/js', 'dist/js/ai', 'dist/ai-runtime',
  ];
  for (const dir of dirs) mkdirSync(join(web, dir), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/cards.json'), '{"cards":[]}\n');
  writeFileSync(join(web, 'index.html'), '<html></html>\n');
  writeFileSync(join(web, 'tsconfig.json'), '{}\n');
  writeFileSync(join(web, 'package.json'), JSON.stringify({ devDependencies: { esbuild: '^0.25.0', typescript: '^5.9.0' } }));
  writeFileSync(join(web, 'package-lock.json'), '{}\n');
  writeFileSync(join(web, 'src/main.ts'), 'export const value = 1;\n');
  writeFileSync(join(web, 'src/ai/parameters.ts'), [
    '// === CHAMPION-PARAMETERS-BEGIN（fixture） ===',
    'export const CHAMPION_PARAMETERS = {',
    '  id: "test-champion",',
    '  engineWeight: 1,',
    '};',
    '// === CHAMPION-PARAMETERS-END ===',
    '',
  ].join('\n'));
  for (const script of ['build.mjs', 'build-ai-runtime.mjs', 'build-manifest.mjs', 'build-hash.mjs']) {
    writeFileSync(join(web, 'scripts', script), '// fixture build script\n');
  }
  writeFileSync(join(web, 'dist/js/engine.js'), 'export const engine = 1;\n');
  writeFileSync(join(web, 'dist/js/ai/parameters.js'), 'export const CHAMPION_PARAMETERS = { id: "test-champion", engineWeight: 1 };\n');
  writeFileSync(join(web, 'dist/js/ai.js'), "import './engine.js';\nimport './ai/parameters.js';\nexport const ai = 1;\n");
  writeFileSync(join(web, 'dist/ai-runtime/harness.html'), '<html></html>\n');
  const manifest = createBuildManifest({ repoRoot: root, webRoot: web });
  writeFileSync(join(web, BUILD_MANIFEST_PATH), JSON.stringify(manifest, null, 2));
  return root;
}

/** 固定公开状态探针（与 version-identity 同纪律：基线参数推进，不依赖被测对象）。 */
function probeGame(seed, steps) {
  let game = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  for (let i = 0; i < steps && game.phase !== 'finished'; i++) {
    game.players[game.current].isAI = true;
    const r = chooseAIAction(game, { parameters: BASELINE_PARAMETERS });
    game = applyAction(game, r.action);
  }
  game.players[game.current].isAI = true;
  return game;
}
