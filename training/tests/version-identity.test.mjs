/** 版本身份回归测试（AI6 合并后整改 P0-1 + 第六阶段 P0 合并）。
 *
 * 缺陷背景：PR #30 晋级后 CHAMPION_PARAMETERS 携带 adapter='champion-guided'，
 * duel.mjs 的 js0/js1 候选路径、equivalence-audit 的 js0 侧、adapter.ts 的
 * joint-js1 分支全部实际执行 JS5 联合搜索（audit-versions V2/V3 8/8 探针实锤，
 * 首个动作分歧 @step=1）。修复：不可变版本注册表（training/lib/version-registry.mjs
 * 与 web-v1/src/ai/version-registry.ts 双通道、同一归档快照来源）
 * + 冻结归档身份 + 全部调用点改经描述符分派。
 *
 * 本测试全部基于**真实行为与有效版本分派**（行动、reason 标记、指纹链接），
 * 不只检查描述符名称。禁止以「把 JS0 改名成 JS5」的方式消除本文件任何断言。
 *
 * 两套注册表的关系：training/lib/version-registry.mjs（Node 侧，sha256 指纹，
 * 读晋级归档）与 web-v1/src/ai/version-registry.ts（浏览器侧，FNV 指纹，
 * 参数内联自同一归档）——身份语义一致，指纹算法不同（各自登记处披露）。
 * 对手池单一事实来源 = training/joint/pools.mjs（第六阶段 P0 整改）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, BASELINE_PARAMETERS, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { FROZEN_VERSIONS, frozenVersion, parametersFingerprint } from '../../web-v1/dist/js/ai/version-registry.js';
import { POOLS, HISTORICAL_POOLS } from '../joint/pools.mjs';
import {
  resolveAlgorithmVersion, decisionOptions, describeVersionRegistry,
  assertFrozenBaseline, identityFingerprint,
} from '../lib/version-registry.mjs';
import { candidateVersion, runGame, classicPool, diversePool } from '../joint/duel.mjs';

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(here, '..', '..');
const CANARY = resolve(REPO_ROOT, 'training/joint/version-canary.json');

/** 公开状态探针：固定种子 5 人局，冻结冠军推进 steps 步后停在确定状态。 */
function probeState(seed, steps) {
  const js0 = resolveAlgorithmVersion('legacy-js0');
  let game = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  for (let i = 0; i < steps && game.phase !== 'finished'; i++) {
    const r = chooseAIAction(game, { parameters: js0.parameters, structure: js0.structure });
    game = applyAction(game, r.action);
  }
  return game;
}
const PROBES = [];
for (const seed of [941512402, 941512419, 941512436]) {
  for (const steps of [1, 4, 9]) PROBES.push(probeState(seed, steps));
}
const act = r => JSON.stringify(r.action);
const isJoint = r => r.reason.includes('联合');

test('注册表：冻结描述符结构不变量（legacy 无适配器字段、js1=beam-contest、深冻结）', () => {
  const js0 = resolveAlgorithmVersion('legacy-js0');
  const js1 = resolveAlgorithmVersion('legacy-js1');
  for (const d of [js0, js1]) {
    assert.equal(d.core, 'beam-search');
    for (const key of ['adapter', 'jointVersion', 'budgetMs']) {
      assert.equal(d.parameters[key], undefined, `${d.registryId} 参数不得携带 ${key}`);
    }
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.parameters));
  }
  assert.equal(js0.structure, 'beam-rollout');
  assert.equal(js1.structure, 'beam-contest');
  // 同一归档参数基座（js1 只差结构）。
  assert.deepEqual({ ...js0.parameters, structure: undefined }, { ...js1.parameters, structure: undefined });
});

test('注册表：js0 参数逐字等于晋级归档文件（活动冠军切换不得漂移历史身份）', () => {
  const js0 = resolveAlgorithmVersion('legacy-js0');
  const archive = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/candidates/ai5-readiness-efficiency.json'), 'utf8'));
  assert.deepEqual(js0.parameters, archive.parameters ?? archive);
  // 与活动冠军别名严格区分：live-champion 携带适配器、指纹不同。
  const live = resolveAlgorithmVersion('live-champion');
  assert.equal(live.parameters.adapter, 'champion-guided');
  assert.notEqual(live.fingerprint, js0.fingerprint);
  // 指纹确定性：重复解析结果一致。
  assert.equal(resolveAlgorithmVersion('legacy-js0').fingerprint, js0.fingerprint);
  assert.equal(identityFingerprint(js0), js0.fingerprint);
});

test('注册表：live-champion 禁止用于历史对照（assertFrozenBaseline）', () => {
  assert.throws(() => assertFrozenBaseline(resolveAlgorithmVersion('live-champion'), '消融基线'), /live-champion/);
  assert.doesNotThrow(() => assertFrozenBaseline(resolveAlgorithmVersion('legacy-js0'), '消融基线'));
});

test('行为学：js0 实际执行冻结束搜索（= 归档冠军逐行动一致；不进 JS5 适配器）', () => {
  const js0 = resolveAlgorithmVersion('legacy-js0');
  const js0Opts = decisionOptions(js0);
  let jointRouted = 0;
  let diffFromArchive = 0;
  for (const game of PROBES) {
    const a0 = chooseAIAction(game, { ...js0Opts.beam });
    const ap = chooseAIAction(game, {
      parameters: JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/candidates/ai5-readiness-efficiency.json'), 'utf8')).parameters ?? {},
      structure: 'beam-rollout',
    });
    if (isJoint(a0)) jointRouted++;
    if (act(a0) !== act(ap)) diffFromArchive++;
  }
  assert.equal(jointRouted, 0, 'js0 决策不得进入 JS5 适配器（联合标记）');
  assert.equal(diffFromArchive, 0, 'js0 行动必须与归档冻结冠军逐决策一致');
});

test('行为学：js1 实际执行 beam-contest（结构标记在场 + 与 js0 存在行动分歧 + 不进适配器）', () => {
  const js1 = resolveAlgorithmVersion('legacy-js1');
  const js1Opts = decisionOptions(js1);
  const js0Opts = decisionOptions(resolveAlgorithmVersion('legacy-js0'));
  let jointRouted = 0, missingTag = 0, differsFromJs0 = 0;
  for (const game of PROBES) {
    const a1 = chooseAIAction(game, { ...js1Opts.beam });
    if (isJoint(a1)) jointRouted++;
    if (!a1.reason.includes('·beam-contest')) missingTag++;
    const a0 = chooseAIAction(game, { ...js0Opts.beam });
    if (act(a1) !== act(a0)) differsFromJs0++;
  }
  assert.equal(jointRouted, 0, 'js1 决策不得进入 JS5 适配器');
  assert.equal(missingTag, 0, 'js1 必须携带 ·beam-contest 结构标记（结构真实参与决策）');
  assert.ok(differsFromJs0 > 0, `beam-contest 与 beam-rollout 必须存在行动分歧（实测 ${differsFromJs0}/${PROBES.length} 探针分歧）`);
});

test('行为学：JS5 候选实际执行联合搜索（duel joint 分派 + 适配器 reason）', () => {
  // duel 的 js5 候选 = joint 路径：终局前某决策点 reason 含联合标记。
  const js5 = resolveAlgorithmVersion('joint-js5-frozen');
  assert.equal(js5.core, 'champion-guided');
  assert.equal(js5.parameters.adapter, 'champion-guided');
  let jointSeen = 0;
  for (const game of PROBES) {
    const r = chooseJointAction(game, { version: 'joint-js5', budgetMs: 100 });
    if (isJoint(r)) jointSeen++;
  }
  assert.ok(jointSeen > 0, `js5 必须进入联合搜索（实测 ${jointSeen}/${PROBES.length} 探针为联合仲裁/规划决策）`);
});

test('调用点链接：duel 与 equivalence-audit 的 js0/js1 解析到同一冻结描述符', () => {
  const js0 = resolveAlgorithmVersion('legacy-js0').fingerprint;
  const js1 = resolveAlgorithmVersion('legacy-js1').fingerprint;
  assert.equal(candidateVersion('js0').descriptor.fingerprint, js0);
  assert.equal(candidateVersion('js1').descriptor.fingerprint, js1);
  assert.notEqual(candidateVersion('js0').descriptor.fingerprint, CHAMPION_PARAMETERS.adapter ? resolveAlgorithmVersion('live-champion').fingerprint : js0);
});

test('对手池：全部变体 strip-adapter 且权重真实生效（极端权重探针可达束搜索核）', () => {
  const js0 = resolveAlgorithmVersion('legacy-js0');
  const base = js0.parameters;
  const pools = [...classicPool(), ...diversePool()];
  for (const entry of pools) {
    if (entry.randomLegal) continue;
    // 冠军本体席位（live-champion 或冻结注册身份 championBody）按定义携带
    // 适配器字段（经 decision.ts 适配器分派 = 当前/冻结冠军行为），不属变体。
    if (!entry.liveChampion && !entry.championBody) {
      for (const key of ['adapter', 'jointVersion', 'budgetMs']) {
        assert.equal(entry.parameters[key], undefined, `池变体 ${entry.id} 不得携带 ${key}`);
      }
    }
  }
  // 风格变体标签不得冠以冠军 id（style-* 为第六阶段命名；ai5-readiness-efficiency@*
  // 为第五阶段历史口径——两者都以冻结 legacy-js0 为权重基座）。
  const classicIds = classicPool().map(e => e.id);
  const variantIds = classicIds.filter(id => id !== 'joint-js5-frozen' && id !== 'neutral-baseline');
  assert.ok(variantIds.length >= 3, `classic 池应含至少 3 个风格变体，实际：${classicIds.join('、')}`);
  for (const id of variantIds) {
    assert.ok(!id.startsWith('joint-js5'), `风格变体标签不得冠以冠军 id：${id}`);
  }
  // 权重活性：极端 tempo/rest 扰动必须改变行动（权重路径可达、未被适配器劫持）。
  const extreme = { ...base, id: 'extreme-probe', tempoWeight: 5, restWeight: 0.05 };
  let differs = 0;
  for (const game of PROBES) {
    const rE = chooseAIAction(game, { parameters: extreme, structure: base.structure });
    if (isJoint(rE)) assert.fail('极端权重变体被适配器路由——权重路径被劫持');
    const rB = chooseAIAction(game, { parameters: base, structure: base.structure });
    if (act(rE) !== act(rB)) differs++;
  }
  assert.ok(differs > 0, `极端权重必须产生行动分歧（实测 ${differs}/${PROBES.length}）`);
});

test('端到端：duel.runGame js0 候选席位完成对局且版本披露可审计', () => {
  // 2 人局小样本：对局完成 + 终局指纹在独立复跑间逐位一致（决策分派确定性），
  // 版本披露含冻结候选 id 与冻结对手标签。
  const seed = 1_320_000_100; // AI6_JOINT_TEST_SUBBLOCK 内测试种子
  const pool = classicPool().filter(e => !e.liveChampion && !e.championBody); // 池不含候选本体语义
  const run1 = runGame({ seed, seatCount: 2, candidateSeats: [0], candidate: candidateVersion('js0'), opponents: pool });
  const run2 = runGame({ seed, seatCount: 2, candidateSeats: [0], candidate: candidateVersion('js0'), opponents: pool });
  assert.equal(run1.status, 'finished');
  assert.equal(run2.status, 'finished');
  assert.equal(run1.moves, run2.moves, '同种子同配置必须逐位复现（候选分派确定性）');
  assert.equal(run1.winnerSeat, run2.winnerSeat);
  assert.ok(run1.moves > 0);
  assert.ok(run1.versionsIds.includes('js0-frozen-champion'), `候选席位版本披露：${run1.versionsIds.join('、')}`);
  // 对手席位标签 = 冻结池 id（不得随活动冠军漂移）。
  const frozenOpponentIds = new Set(pool.map(e => e.id));
  for (const id of run1.versionsIds) {
    if (id !== 'js0-frozen-champion') assert.ok(frozenOpponentIds.has(id), `对手席位 ${id} 必须来自冻结池`);
  }
});

test('端到端：duel.runGame js0 与 js5 候选在同一受支持配置下行为不同（基线非 JS5 自我对弈）', () => {
  const seed = 1_320_000_102;
  const pool = classicPool().filter(e => !e.liveChampion && !e.championBody);
  const js0Run = runGame({ seed, seatCount: 2, candidateSeats: [0], candidate: candidateVersion('js0'), opponents: pool });
  const js5Run = runGame({ seed, seatCount: 2, candidateSeats: [0], candidate: candidateVersion('js5'), opponents: pool, jointOptions: { budgetMs: 100 } });
  assert.equal(js0Run.status, 'finished');
  assert.equal(js5Run.status, 'finished');
  const differ = js0Run.moves !== js5Run.moves || js0Run.winnerSeat !== js5Run.winnerSeat
    || js0Run.meanScore.toFixed(6) !== js5Run.meanScore.toFixed(6);
  assert.ok(differ, 'js0 与 js5 候选对局必须可区分（若逐位相同，先怀疑 js0 被污染为 JS5）');
});

test('注册表快照：describeVersionRegistry 披露全部身份字段与指纹（报告可审计）', () => {
  const snap = describeVersionRegistry();
  assert.equal(snap.schema, 'century-algorithm-version-registry-v1');
  const ids = snap.versions.map(v => v.registryId);
  assert.deepEqual(ids, ['legacy-js0', 'legacy-js1', 'joint-js5-frozen', 'live-champion']);
  for (const v of snap.versions) {
    assert.ok(/^[0-9a-f]{64}$/.test(v.fingerprint), `${v.registryId} 指纹缺失`);
    assert.ok(v.source, `${v.registryId} 缺少来源披露`);
  }
  const js0 = snap.versions.find(v => v.registryId === 'legacy-js0');
  assert.equal(js0.parametersId, 'ai5-readiness-efficiency');
  assert.equal(snap.liveChampionParametersId, CHAMPION_PARAMETERS.id);
});

// ===== AI6 第六阶段追加：金丝雀账本 + pools.mjs 单一事实来源 =====

test('金丝雀账本一致性：version-canary.json 指纹与 web-v1 注册表一致', () => {
  assert.ok(existsSync(CANARY), 'version-canary.json 必须提交入库（金丝雀登记）');
  const doc = JSON.parse(readFileSync(CANARY, 'utf8'));
  for (const [id, fp] of Object.entries(doc.fingerprints)) {
    assert.equal(parametersFingerprint(FROZEN_VERSIONS[id].parameters), fp, `${id} 冻结参数漂移`);
  }
  assert.ok(doc.digests['legacy-js0'], '金丝雀决策摘要必须含 legacy-js0');
  assert.ok(doc.digests['joint-js5-frozen'], '金丝雀决策摘要必须含 joint-js5-frozen');
});

test('classic 池（pools.mjs）：风格变体参数 ≠ 基座且走束搜索结构；冠军席 = joint-js5-frozen', () => {
  const pool = POOLS.classic();
  const ids = pool.map(m => m.id);
  assert.equal(ids[0], 'joint-js5-frozen');
  assert.ok(ids.includes('neutral-baseline'));
  const legacy = frozenVersion('legacy-js0');
  for (const id of ['style-tempo', 'style-contest', 'style-engine']) {
    const m = pool.find(x => x.id === id);
    assert.ok(m, `${id} 缺失`);
    assert.notDeepEqual(m.parameters, legacy.parameters, `${id} 权重修改无效`);
    assert.equal(m.structure, 'beam-rollout');
  }
  // 冠军席参数 = 冻结 js5（适配器分派）。
  assert.deepEqual(pool[0].parameters, FROZEN_VERSIONS['joint-js5-frozen'].parameters);
});

test('diverse 池（pools.mjs）：结构多样性成员齐全且变体参数互不相同', () => {
  const pool = POOLS.diverse();
  const ids = pool.map(m => m.id);
  for (const expected of ['joint-js5-frozen', 'ai4-struct-beam-rollout', 'style-rush', 'style-engine', 'random-legal']) {
    assert.ok(ids.includes(expected), `diverse 池缺少 ${expected}`);
  }
  const rush = pool.find(m => m.id === 'style-rush');
  const eng = pool.find(m => m.id === 'style-engine');
  assert.notDeepEqual(rush.parameters, eng.parameters);
  assert.equal(pool.find(m => m.id === 'random-legal').randomLegal, true);
});

test('phase5 历史池：冠军席 id = ai5-readiness-efficiency（历史重放专用）', () => {
  const pool = HISTORICAL_POOLS.classic();
  assert.equal(pool[0].id, 'ai5-readiness-efficiency');
  assert.equal(pool[0].parameters.id, 'ai5-readiness-efficiency');
  const dpool = HISTORICAL_POOLS.diverse();
  assert.equal(dpool[0].id, 'ai5-readiness-efficiency');
});

test('决策级身份不等式：legacy-js0 ≠ legacy-js1 ≠ joint-js5（单局自对局）', () => {
  const seed = 1300500000;
  const selfPlay = play => {
    let game = createGame(['A', 'B'], seed, [1]);
    game.players[0].isAI = true;
    const decisions = [];
    let moves = 0;
    while (game.phase !== 'finished' && moves < 1500) {
      const seat = game.current;
      const profile = seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
      const action = play(game, seat, profile);
      decisions.push(JSON.stringify(action));
      game = applyAction(game, action);
      moves += 1;
    }
    return JSON.stringify(decisions);
  };
  const beam = (v) => selfPlay((g, seat, profile) =>
    chooseAIAction(g, { parameters: frozenVersion(v).parameters, structure: frozenVersion(v).structure, profile }).action);
  const js5 = selfPlay((g, seat, profile) =>
    chooseJointAction(g, { version: 'joint-js5', workUnits: 16, simSeed: seed, profile }).action);
  const d0 = beam('legacy-js0');
  const d1 = beam('legacy-js1');
  assert.notEqual(d0, d1, 'legacy-js0 与 legacy-js1（beam-contest）必须有行为差异');
  assert.notEqual(d0, js5, 'legacy-js0 与 joint-js5 必须有行为差异');
  assert.notEqual(d1, js5, 'legacy-js1 与 joint-js5 必须有行为差异');
});
