/** 版本注册表与版本身份测试（AI6 第六阶段 P0）。
 *
 * 防回归目标（任务书 §十二.1/.2/.3）：
 * 1. 历史冠军身份固定，不受当前冠军参数（CHAMPION_PARAMETERS）改变影响；
 * 2. legacy-js0 与 joint-js5 分派正确（束搜索路径 vs 适配器路径）；
 * 3. 对手风格版本具有可观察的决策级行为差异（不是只改被适配器忽略的参数）。
 * 修复前失败证据：confirm-replay-check js0 重放 24/24 → 1/12（js0 静默变 JS5）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../dist/js/ai.js';
import { chooseJointAction } from '../dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS } from '../dist/js/ai/parameters.js';
import { FROZEN_VERSIONS, frozenVersion, parametersFingerprint } from '../dist/js/ai/version-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const LEGACY_CHAMPION = JSON.parse(readFileSync(resolve(HERE, 'fixtures/legacy-champion.json'), 'utf8'));
const CHAMPION_DOC = JSON.parse(readFileSync(resolve(REPO, 'training/champions/champion.json'), 'utf8'));

/** 分身对局序列：对固定种子自对局收集某席位决策（身份差异的决策级探针）。 */
function decisionSequence({ seed, seatCount = 2, probeSeat = 0, play }) {
  let game = createGame(['席位0', '席位1', '席位2', '席位3', '席位4'].slice(0, seatCount), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  const decisions = [];
  let moves = 0;
  while (game.phase !== 'finished' && moves < 1500) {
    const seat = game.current;
    const profile = seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
    const action = play(game, seat, profile);
    if (seat === probeSeat) decisions.push(JSON.stringify(action));
    game = applyAction(game, action);
    moves += 1;
  }
  return { decisions, moves };
}

const beamPlay = (params, structure) => (game, seat, profile) =>
  chooseAIAction(game, { parameters: params, ...(structure ? { structure } : {}), profile }).action;
const jointPlay = (version, extra = {}) => (game, seat, profile) =>
  chooseJointAction(game, { version, workUnits: 16, simSeed: 1300500000, profile, ...extra }).action;

test('冻结版本身份钉定：legacy-js0 参数 = 前任冠军 fixture（逐字）', () => {
  const { _comment, ...expected } = LEGACY_CHAMPION;
  assert.deepEqual(FROZEN_VERSIONS['legacy-js0'].parameters, expected);
  assert.equal(FROZEN_VERSIONS['legacy-js0'].structure, 'beam-rollout');
  assert.equal(FROZEN_VERSIONS['legacy-js0'].algorithm, 'beam-search');
});

test('冻结版本身份钉定：joint-js5-frozen 参数 = champion.json（逐字）', () => {
  assert.deepEqual(FROZEN_VERSIONS['joint-js5-frozen'].parameters, CHAMPION_DOC.parameters);
  assert.equal(FROZEN_VERSIONS['joint-js5-frozen'].parameters.adapter, 'champion-guided');
});

test('冻结版本指纹钉定：任何快照改动都会被捕获', () => {
  // 指纹 = canonical JSON 的 FNV 双通道；以下为提交时登记值（变更即测试红）。
  const pinned = {
    'legacy-js0': '9a2c29e2c19acb77',
    'legacy-js1': 'e8f00873487bb7cd',
    'joint-js5-frozen': '144900ef7c9a9e6e',
  };
  for (const [id, fp] of Object.entries(pinned)) {
    assert.equal(parametersFingerprint(FROZEN_VERSIONS[id].parameters), fp, `${id} 参数快照被改动`);
  }
});

test('legacy-js1 = legacy-js0 参数 + beam-contest 结构（其余逐字相同）', () => {
  const js0 = FROZEN_VERSIONS['legacy-js0'].parameters;
  const js1 = FROZEN_VERSIONS['legacy-js1'].parameters;
  const { structure: s0, ...rest0 } = js0;
  const { structure: s1, ...rest1 } = js1;
  assert.deepEqual(rest1, rest0);
  assert.equal(s1, 'beam-contest');
});

test('注册表与当前冠军解耦：冻结快照 ≠ CHAMPION_PARAMETERS 引用', () => {
  // 冻结版本必须是独立快照对象（克隆语义），而非当前冠军常量的引用——
  // champion.json 更新时对照身份不得漂移。
  assert.notEqual(FROZEN_VERSIONS['joint-js5-frozen'].parameters, CHAMPION_PARAMETERS);
  // 当前值当前恰好一致（部署一致性由 version-gate 另行校验），但身份独立。
  assert.deepEqual(FROZEN_VERSIONS['joint-js5-frozen'].parameters, CHAMPION_PARAMETERS);
});

test('分派身份：legacy-js0 走束搜索路径，joint-js5-frozen 走适配器路径', () => {
  const seed = 1300500000;
  const g0 = createGame(['A', 'B'], seed, [1]); g0.players[0].isAI = true;
  const r0 = chooseAIAction(g0, { parameters: FROZEN_VERSIONS['legacy-js0'].parameters });
  assert.match(r0.reason, /AI 4\.0/);
  assert.match(r0.reason, /ai5-readiness-efficiency/);
  const g5 = createGame(['A', 'B'], seed, [1]); g5.players[0].isAI = true;
  const j5 = chooseJointAction(g5, { version: 'joint-js5', workUnits: 16, simSeed: seed });
  assert.match(j5.reason, /^js5/);
});

test('分派身份：js0 与 js5 在金丝雀状态上存在决策差异（不是同一实现）', () => {
  const seeds = [1300500000, 1300500001, 1300500100, 1300500101];
  let diffStates = 0;
  for (const seed of seeds) {
    const a = decisionSequence({ seed, play: beamPlay(FROZEN_VERSIONS['legacy-js0'].parameters, 'beam-rollout') });
    const b = decisionSequence({ seed, play: jointPlay('joint-js5') });
    if (JSON.stringify(a.decisions) !== JSON.stringify(b.decisions)) diffStates += 1;
  }
  assert.ok(diffStates >= 2, `js0 与 js5 应在多数金丝雀状态上行为不同，实际仅 ${diffStates}/4`);
});

test('js1 经适配器分派 = legacy-js0 + beam-contest（不再是 JS5）', () => {
  // 决策级：joint-js1（champion-contest 委托）必须与显式 beam-contest 束搜索
  // 逐决策一致；且与 js5 存在差异（修复前 js1 静默运行 JS5）。
  const seeds = [1300500000, 1300500001];
  for (const seed of seeds) {
    const a = decisionSequence({ seed, play: (g, seat, profile) =>
      chooseJointAction(g, { version: 'joint-js1', profile }).action });
    const b = decisionSequence({ seed, play: beamPlay(FROZEN_VERSIONS['legacy-js0'].parameters, 'beam-contest') });
    assert.deepEqual(a.decisions, b.decisions, `seed=${seed} js1 应与 legacy beam-contest 逐决策一致`);
  }
  let diffVsJs5 = 0;
  for (const seed of seeds) {
    const a = decisionSequence({ seed, play: (g, seat, profile) =>
      chooseJointAction(g, { version: 'joint-js1', profile }).action });
    const b = decisionSequence({ seed, play: jointPlay('joint-js5') });
    if (JSON.stringify(a.decisions) !== JSON.stringify(b.decisions)) diffVsJs5 += 1;
  }
  assert.ok(diffVsJs5 >= 1, 'js1 与 js5 应存在决策差异（js1 ≠ JS5）');
});

test('风格变体（classic/diverse 池）具有决策级真实行为差异', () => {
  // 池变体在 version-registry 不可见——此处按 pools.mjs 的权重修改幅度
  // 在 legacy 基座上重建（束搜索路径真实消费权重）。
  const b = FROZEN_VERSIONS['legacy-js0'].parameters;
  const variants = {
    'style-tempo': { ...b, tempoWeight: Math.min(1.5, b.tempoWeight * 1.35), restWeight: Math.max(0.5, b.restWeight * 0.8) },
    'style-contest': { ...b, contestWeight: Math.min(2, b.contestWeight * 1.4), goalWeight: Math.min(1.5, b.goalWeight * 1.15) },
    'style-engine': { ...b, engineWeight: Math.min(1.5, b.engineWeight * 1.3), endgameWeight: Math.min(1.5, b.endgameWeight * 1.1) },
    'style-rush': { ...b, tempoWeight: 1.6, restWeight: 0.5, engineWeight: 0.5, endgameWeight: 0.6 },
  };
  const seeds = [1300500000, 1300500001, 1300500100];
  for (const [id, params] of Object.entries(variants)) {
    assert.notDeepEqual(params, b, `${id} 参数必须与基座不同`);
    const base = decisionSequence({ seed: seeds[0], play: beamPlay(b, 'beam-rollout') });
    const varSeq = decisionSequence({ seed: seeds[0], play: beamPlay(params, 'beam-rollout') });
    const differs = JSON.stringify(base.decisions) !== JSON.stringify(varSeq.decisions)
      || seeds.slice(1).some(s => JSON.stringify(decisionSequence({ seed: s, play: beamPlay(b, 'beam-rollout') }).decisions)
        !== JSON.stringify(decisionSequence({ seed: s, play: beamPlay(params, 'beam-rollout') }).decisions));
    assert.ok(differs, `${id} 与基座在金丝雀状态上无决策差异（变体无效）`);
  }
});

test('championParameters 透传：权重修改真实影响 JS5 冠军基座（修复适配器忽略缺陷）', () => {
  const base = FROZEN_VERSIONS['joint-js5-frozen'].parameters;
  const modified = { ...base, tempoWeight: 1.6, restWeight: 0.5, engineWeight: 0.5 };
  const seeds = [1300500000, 1300500001, 1300500100, 1300500101];
  let decisionDiff = 0;
  for (const seed of seeds) {
    const a = decisionSequence({ seed, play: jointPlay('joint-js5') });
    const b = decisionSequence({ seed, play: jointPlay('joint-js5', { championParameters: modified }) });
    if (JSON.stringify(a.decisions) !== JSON.stringify(b.decisions)) decisionDiff += 1;
  }
  assert.ok(decisionDiff >= 1, `修改冠军基座权重应改变 JS5 行为（${decisionDiff}/4 状态有差异）`);
  // 冠军本体透传自身：默认行为不受透传机制影响（决定性状态）。
  const def = decisionSequence({ seed: seeds[0], play: jointPlay('joint-js5') });
  const explicit = decisionSequence({ seed: seeds[0], play: jointPlay('joint-js5', { championParameters: base }) });
  assert.deepEqual(explicit.decisions, def.decisions);
});

test('未知 id 抛错；实验版本身份可解析（算法实现已注册）', () => {
  // js6-experimental 在第六阶段 C/E 完成后已注册算法实现（joint-js6 组合），
  // 可解析并可参与对局（行为受 F 确认与金丝雀约束）；「未注册即拒绝」的
  // 语义由 frozenVersion 的 adapter 检查承担（对未实现算法的占位仍抛错）。
  const js6 = frozenVersion('joint-js6-experimental');
  assert.equal(js6.parameters.jointVersion, 'joint-js6');
  assert.equal(js6.parameters.adapter, 'champion-guided');
  assert.equal(js6.frozen, false);
  assert.throws(() => frozenVersion('no-such-version'), /未知版本 id/);
});
