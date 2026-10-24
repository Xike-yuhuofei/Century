/** 对抗性联赛测试：对手算法真实性审计（CHAMPION_PARAMETERS.adapter 缺陷）。
 *
 * 审计结论（2026-10-24，本测试固化）：
 * AI6 第五阶段晋级接线后，CHAMPION_PARAMETERS 携带 adapter='champion-guided'。
 * web-v1/src/ai/decision.ts 按 params.adapter 分派——适配器冠军的决策核心在
 * 联合搜索内，权重乘子不参与决策。因此任何从当前冠军浅拷贝派生的"风格变体"
 * （{...CHAMPION_PARAMETERS, tempoWeight: X}）都会被静默分派到 JS5 联合搜索，
 * 权重 100% 失效——变体行为 ≡ 冠军本体。
 *
 * 影响范围（只审计不改他人模块——修复属独立 PR）：
 * - training/lib/opponents.mjs styleVariants()（AI4 进化对手池）；
 * - training/joint/duel.mjs classicPool()/diversePool() 的 @tempo/@contest/
 *   @engine/style-rush/style-engine 条目（JS 消融对手池）。
 * 本模块（training/adversarial/registry.mjs）的 strip-adapter 纪律是该缺陷的
 * 结构性修复；本测试用行为探针固化缺陷机理与修复有效性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS, BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { stripAdapter, buildRegistry } from '../adversarial/registry.mjs';

/** 公开状态探针：固定种子 2 人局，中立基线推进 steps 步后停在确定状态。
 * 重复构造保证每次探针同一状态（引擎对固定种子确定性）。 */
function probeState(seed, steps) {
  let game = createGame(['A', 'B'], seed, [1]);
  game.players[0].isAI = true;
  for (let i = 0; i < steps; i++) {
    if (game.phase === 'finished') break;
    const r = chooseAIAction(game, { parameters: BASELINE_PARAMETERS });
    game = applyAction(game, r.action);
  }
  return game;
}

test('审计缺陷复现：携带 adapter 的权重变体被分派到 JS5，权重不可达（确定性路由证明）', () => {
  // 极端权重扰动（tempo 5x / rest 下界）——若权重参与决策，必然走束搜索核。
  const legacyVariant = { ...CHAMPION_PARAMETERS, id: 'legacy-rush', tempoWeight: 5, restWeight: 0.05 };
  let routedToJoint = 0;
  let championRoutedToJoint = 0;
  const probes = [];
  for (let seed = 1_400_000_000; seed < 1_400_000_006; seed++) {
    for (const steps of [3, 9]) probes.push({ seed, steps });
  }
  for (const { seed, steps } of probes) {
    const rLegacy = chooseAIAction(probeState(seed, steps), { parameters: legacyVariant });
    const rChampion = chooseAIAction(probeState(seed, steps), { parameters: CHAMPION_PARAMETERS });
    if (/JS5|js5/.test(rLegacy.reason)) routedToJoint += 1;
    if (/JS5|js5/.test(rChampion.reason)) championRoutedToJoint += 1;
  }
  // 路由证明（确定性，不依赖搜索深度）：权重变体与冠军本体全部被分派到
  // JS5 联合搜索核。该核（champion-guided.ts）结构上只消费 CHAMPION_PARAMETERS
  // /o.championParameters——任何传入参数对象的权重乘子都不参与决策。
  assert.equal(routedToJoint, probes.length, '携带 adapter 的变体必须全部被分派到 JS5 联合搜索（reason 披露）');
  assert.equal(championRoutedToJoint, probes.length, '冠军本体同核（对照组）');
  // 对照：同一极端权重在束搜索核内可达（strip-adapter 后 reason 走束搜索路径）。
  const strippedProbe = { ...stripAdapter(legacyVariant), structure: 'beam-rollout' };
  const rStripped = chooseAIAction(probeState(1_400_000_000, 5), { parameters: strippedProbe });
  assert.match(rStripped.reason, /beam-rollout/);
  assert.doesNotMatch(rStripped.reason, /JS5|js5/);
});

test('修复有效性：strip-adapter 后同一权重扰动真实生效（束搜索路径）', () => {
  const fixedVariant = { ...stripAdapter({ ...CHAMPION_PARAMETERS, id: 'fixed-rush', tempoWeight: 5, restWeight: 0.05 }), structure: 'beam-rollout' };
  const champBase = { ...stripAdapter(CHAMPION_PARAMETERS), id: 'js5-base', structure: 'beam-rollout' };
  // 1) fixed 不再走联合搜索（reason 含束搜索路径标记，不含 JS5 直通标记）。
  const rFixed = chooseAIAction(probeState(1_400_000_000, 5), { parameters: fixedVariant });
  assert.doesNotMatch(rFixed.reason, /JS5|js5/);
  assert.match(rFixed.reason, /beam-rollout/);
  assert.match(rFixed.reason, /fixed-rush/);
  // 2) 权重扰动在束搜索核内真实生效：与未扰动基座至少在一个探针状态分歧。
  let differ = 0;
  const total = 12;
  for (let seed = 1_400_000_000; seed < 1_400_000_000 + 6; seed++) {
    for (const steps of [3, 9]) {
      const aFixed = JSON.stringify(chooseAIAction(probeState(seed, steps), { parameters: fixedVariant }).action);
      const aBase = JSON.stringify(chooseAIAction(probeState(seed, steps), { parameters: champBase }).action);
      if (aFixed !== aBase) differ += 1;
    }
  }
  assert.ok(differ >= 1, `极端权重扰动必须在束搜索核内产生行为分歧（实测 ${differ}/${total}）`);
});

test('注册表风格族：结构上无 adapter 字段，行为上与 JS5 冠军分歧', () => {
  const reg = buildRegistry({ jointOptions: null });
  for (const id of ['style-rush', 'style-engine', 'style-contest', 'style-balanced']) {
    const v = reg.versions[id];
    assert.equal(v.parameters.adapter, undefined, `${id} 不得携带 adapter 字段`);
    assert.equal(v.decisionCore, 'beam-search');
  }
  // 行为分歧：每个风格变体与 JS5 冠军在 ≥1 个探针状态行动不同。
  // 冠军侧走同一联合搜索核的确定性快档（workUnits——不依赖墙钟，负载无关）。
  for (const id of ['style-rush', 'style-engine', 'style-contest']) {
    let differ = 0;
    for (let seed = 1_400_000_000; seed < 1_400_000_000 + 4; seed++) {
      for (const steps of [3, 9]) {
        const state = probeState(seed, steps);
        const rStyle = chooseAIAction(state, {
          parameters: reg.versions[id].parameters, structure: reg.versions[id].structure,
        });
        const state2 = probeState(seed, steps);
        const rChampion = chooseJointAction(state2, { version: 'joint-js5', workUnits: 64 });
        if (JSON.stringify(rStyle.action) !== JSON.stringify(rChampion.action)) differ += 1;
      }
    }
    assert.ok(differ >= 1, `${id} 必须与 JS5 冠军存在行为分歧（实测 ${differ}/8 探针）`);
  }
});
