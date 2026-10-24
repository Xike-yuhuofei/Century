/** L3 叶子评价器校准（AI6 第四阶段·任务 D / L3）。
 *
 * 方法：在独立校准种子块（AI6_JOINT_CALIB_SUBBLOCK [1.34e9,1.35e9)）的中局
 * 状态上启动联合轨迹（规则对手），沿轨迹周期性采样叶子特征（L2 raw margin
 * 与多玩家向量），并把同一条轨迹真实推进到正式终局，用 engine.ranking 结局
 * 标注每个采样点 → (margin, firstPlace) 样本对。
 * 拟合：按 margin 分位数分桶的分段线性 P(first | margin) + 单 logistic 尺度
 * 网格搜索。样本 ≥ 2000 才产出 valid=true 的校准映射（写入
 * web-v1/src/js/l3-calibration.ts，生成式覆盖，绝不手工编造）。
 *
 * 独立性纪律：校准块与调参/测试块物理隔离；校准只影响 L3 评价器的输出
 * 标定，不改变任何搜索结构或对手模型。
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction, score as engineScore } from '../../web-v1/dist/js/engine.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { createSimulation } from '../../web-v1/dist/js/sim/session.js';
import { buildObservation } from '../../web-v1/dist/js/ai/observation.js';
import { leafVector, l2RawMargin } from '../../web-v1/dist/js/js/evaluators.js';
import { playJointTrajectory } from '../../web-v1/dist/js/js/joint-rollout.js';
import { mulberry32 } from '../../web-v1/dist/js/sim/rng.js';
import { REPO_ROOT } from '../lib/paths.mjs';

const SEED_BASE = 1_340_000_000;
const SEEDS = 60;
const TRAJECTORIES_PER_SEED = 6;
const SAMPLE_INTERVAL = 10; // 每 10 个转移采样一次叶子特征

/** 采集样本对。 */
function collectSamples() {
  const samples = [];
  for (let i = 0; i < SEEDS; i++) {
    const seed = SEED_BASE + i;
    const players = [2, 3, 4, 5][i % 4];
    let g = createGame(Array.from({ length: players }, (_, k) => `P${k}`), seed, Array.from({ length: players - 1 }, (_, k) => k + 1));
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 30 + (i % 5) * 20) {
      const r = chooseJointAction(g, { version: 'joint-js2', workUnits: 4, horizon: 30 });
      g = applyAction(g, r.action);
      moves++;
    }
    if (g.phase === 'finished') continue;
    const mySeat = g.current;
    const view = buildObservation(g, mySeat);
    for (let t = 0; t < TRAJECTORIES_PER_SEED; t++) {
      const sim = createSimulation(view, { simSeed: 1_340_000_000 + t * 7919 });
      const rng = mulberry32((1_340_000_000 ^ (t * 0x9E3779B9)) >>> 0);
      // 手工推进轨迹并周期采样（复用 playJointTrajectory 的策略语义：
      // 己方=启发式贪心，对手=rule 模式）。
      const pending = [];
      let transitions = 0;
      let finished = false;
      const maxTransitions = 600;
      while (!sim.finished && transitions < maxTransitions) {
        const state = sim.view;
        // 采样：仅在 turn 阶段、且每 SAMPLE_INTERVAL 个转移。
        if (state.phase === 'turn' && transitions % SAMPLE_INTERVAL === 0 && state.players.length >= 2) {
          const v = leafVector(state, mySeat);
          pending.push({ margin: l2RawMargin(v, mySeat, state.copper, state.silver), turnNumber: state.turnNumber });
        }
        // 行动分派（与 playJointTrajectory 相同的对手口径）。
        const actor = state.current;
        let action = null;
        if (state.phase === 'overflow') {
          action = { type: 'discard', colors: discardDecision(state.players[actor].stock, state.golemMarket, CHAMPION_PARAMETERS) };
        } else if (actor === mySeat) {
          const ctxH = heuristicContext(state, CHAMPION_PARAMETERS, { name: '中立代理', engine: 1, tempo: 1, contest: 1 });
          action = myRankedActions(state, actor, ctxH).ranked[0]?.action ?? { type: 'rest' };
        } else {
          const sample = sampleOpponentAction(state, rng, createOpponentContext('rule', null));
          action = sample?.action ?? { type: 'rest' };
        }
        try { sim.step(action); } catch { break; }
        transitions++;
      }
      finished = sim.finished;
      if (!finished) continue; // 未到真实终局的轨迹无法标注，弃用
      const ranking = sim.ranking();
      const first = ranking[0] === mySeat;
      for (const p of pending) samples.push({ margin: p.margin, first, players, turnNumber: p.turnNumber });
    }
    process.stdout.write(`seed ${seed} (${players}人)：累计样本 ${samples.length}\r`);
  }
  process.stdout.write('\n');
  return samples;
}

/** 分段线性拟合：按 margin 分位数分桶，桶内 P(first)。 */
function fitPiecewise(samples, bins = 12) {
  const sorted = [...samples].sort((a, b) => a.margin - b.margin);
  const knots = [];
  const values = [];
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor(sorted.length * b / bins);
    const hi = Math.floor(sorted.length * (b + 1) / bins);
    const bin = sorted.slice(lo, hi);
    if (!bin.length) continue;
    knots.push(Number(bin[0].margin.toFixed(3)));
    values.push(Number((bin.filter(s => s.first).length / bin.length).toFixed(4)));
  }
  knots.push(Number(sorted[sorted.length - 1].margin.toFixed(3)));
  values.push(values[values.length - 1]);
  // 单调化（isotonic 后向聚合）：P(first) 对 margin 应非降。
  for (let i = values.length - 2; i >= 0; i--) {
    if (values[i] > values[i + 1]) values[i] = values[i + 1];
  }
  return { knots, values };
}

/** 单 logistic 尺度网格搜索（对照基线；报告用）。 */
function fitLogisticScale(samples) {
  let best = { scale: 8, ll: -Infinity };
  for (let scale = 2; scale <= 30; scale += 0.5) {
    let ll = 0;
    for (const s of samples) {
      const p = 1 / (1 + Math.exp(-s.margin / scale));
      ll += Math.log(Math.max(1e-9, s.first ? p : 1 - p));
    }
    if (ll > best.ll) best = { scale, ll: Number(ll.toFixed(1)) };
  }
  return best;
}

function main() {
  const samples = collectSamples();
  if (samples.length < 2000) {
    console.log(`样本不足（${samples.length} < 2000）：L3 保持 valid=false，评价器回落 L2（诚实披露）。`);
    return;
  }
  const mapping = fitPiecewise(samples);
  const logistic = fitLogisticScale(samples);
  const byPlayers = Object.entries(samples.reduce((acc, s) => {
    (acc[s.players] ??= { n: 0, first: 0 });
    acc[s.players].n++;
    if (s.first) acc[s.players].first++;
    return acc;
  }, {})).map(([p, v]) => ({ players: Number(p), samples: v.n, firstRate: +(v.first / v.n).toFixed(4) }));
  const report = {
    schema: 'century-joint-search-l3-calibration-v1',
    date: new Date().toISOString(),
    seedBlock: 'AI6_JOINT_CALIB_SUBBLOCK [1.34e9, 1.35e9)',
    seeds: SEEDS, samples: samples.length,
    baselineFirstRate: Number((samples.filter(s => s.first).length / samples.length).toFixed(4)),
    byPlayers,
    logisticScale: logistic,
    mapping,
  };
  const out = resolve(REPO_ROOT, 'training/reports/joint-search-v1/l3-calibration.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  // 生成式覆盖 web-v1/src/js/l3-calibration.ts。
  const ts = `/** L3 胜率校准映射（AI6 第四阶段·任务 D / L3）。
 *
 * 本文件由 training/joint/calibrate.mjs 生成式覆盖（${new Date().toISOString()}），
 * 校准种子块 AI6_JOINT_CALIB_SUBBLOCK [1.34e9,1.35e9)，样本 ${samples.length} 条。
 * L3 评价器经分段线性 P(first | L2 raw margin) 输出胜率近似；
 * 校准流程与拟合口径见 training/reports/joint-search-v1/l3-calibration.json。
 */

export type L3Calibration = {
  valid: boolean;
  /** 样本量（校准轨迹采样点数）；样本不足（< 2000）时 valid 保持 false。 */
  samples: number;
  /** 校准种子块（可审计）。 */
  seedBlock: string | null;
  fittedAt: string | null;
  /** 分段线性映射：knots 为 L2 raw margin 断点（升序），values 为 P(first)。 */
  mapping: { knots: number[]; values: number[] };
};

export const L3_CALIBRATION: L3Calibration = {
  valid: true,
  samples: ${samples.length},
  seedBlock: 'AI6_JOINT_CALIB_SUBBLOCK [1.34e9,1.35e9)',
  fittedAt: '${new Date().toISOString()}',
  mapping: ${JSON.stringify(mapping)},
};
`;
  writeFileSync(resolve(REPO_ROOT, 'web-v1/src/js/l3-calibration.ts'), ts);
  console.log(`L3 校准完成：${samples.length} 样本，logistic 尺度 ${logistic.scale}，输出已写入 src/js/l3-calibration.ts`);
  console.log(JSON.stringify(report.mapping, null, 1).slice(0, 600));
}

// 顶层动态导入（ESM 顶层 await；先于 main() 执行）。
const [{ discardDecision, myRankedActions, heuristicContext }, { sampleOpponentAction, createOpponentContext }, { CHAMPION_PARAMETERS }] = await Promise.all([
  import('../../web-v1/dist/js/js/rollout-policy.js'),
  import('../../web-v1/dist/js/js/opponents.js'),
  import('../../web-v1/dist/js/ai/parameters.js'),
]);

main();
