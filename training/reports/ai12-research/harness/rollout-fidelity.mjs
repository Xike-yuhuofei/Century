/**
 * AI12 诊断：轨迹内自身策略（rollout own-policy）与冠军计划的保真度。
 *
 * 问题：JS5 的 rollout 中「我」的席位由 rollout-policy.ts 的 1-ply 贪心策略扮演，
 * 而真实策略是冠军 6 层束搜索 + 联合仲裁。若两者在同一状态的首步经常不同，
 * 说明仲裁看到的未来并不是真实策略的未来（模拟失真），这是最后一个未量化的杠杆。
 *
 * 输出：逐步一致率（plan.first vs 1-ply 首步）、按阶段/认领可用性分层、以及实际 JS5 选择。
 * 用法：node training/reports/ai12-research/harness/rollout-fidelity.mjs --games 12
 */
import { pathToFileURL } from 'node:url';
import { createGame, applyAction, ranking } from '../../../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { choosePlan } from '../../../../web-v1/dist/js/ai/planner.js';
import { buildObservation } from '../../../../web-v1/dist/js/ai/observation.js';
import { createSimulation } from '../../../../web-v1/dist/js/sim/session.js';
import { chooseJointAction } from '../../../../web-v1/dist/js/js/adapter.js';
import { heuristicContext, myRankedActions } from '../../../../web-v1/dist/js/js/rollout-policy.js';
import { buildRegistry } from '../../../adversarial/registry.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../../../lib/sim-stream.mjs';

const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const registry = buildRegistry();
const CH = registry.versions['js5-frozen-champion'].parameters;
const seatProfile = (seat) => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const games = Number(arg('games', 12));
const seedBase = Number(arg('seed-base', 1737600000));
const key = a => JSON.stringify(a);

const stats = { decisions: 0, same: 0, samePre: 0, pre: 0, samePost: 0, post: 0, claimAvailable: 0, sameClaim: 0, js5AgreeWithPlan: 0, js5AgreeWithGreedy: 0 };
const examples = [];
for (let g = 0; g < games; g++) {
  const seatCount = 2 + (g % 4);
  const seed = seedBase + seatCount * 1000 + g;
  const focusSeat = g % seatCount;
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  while (game.phase !== 'finished') {
    const seat = game.current;
    let action;
    if (seat === focusSeat) {
      const obs = buildObservation(game, seat);
      const plan = choosePlan(obs, CH, seatProfile(seat), 'beam-rollout');
      const sim = createSimulation(obs, { simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT) });
      const ctx = heuristicContext(sim.view, CH, seatProfile(seat));
      const greedy = myRankedActions(sim.view, seat, ctx).ranked[0]?.action ?? null;
      const js5 = chooseJointAction(game, {
        version: 'joint-js5', workUnits: 32, championParameters: CH, profile: seatProfile(seat),
        simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
      });
      const post = obs.triggerPlayer !== null;
      const claimable = js5.joint ? js5.joint.evaluations?.length > 0 : false;
      stats.decisions++;
      if (post) stats.post++; else stats.pre++;
      const same = plan && greedy && key(plan.first) === key(greedy);
      if (same) { stats.same++; if (post) stats.samePost++; else stats.samePre++; }
      if (js5.action && plan && key(js5.action) === key(plan.first)) stats.js5AgreeWithPlan++;
      if (js5.action && greedy && key(js5.action) === key(greedy)) stats.js5AgreeWithGreedy++;
      if (claimable) {
        stats.claimAvailable++;
        if (same) stats.sameClaim++;
      }
      if (!same && examples.length < 6) {
        examples.push({ seatCount, turn: game.turnNumber, post, plan: plan?.first ?? null, greedy, js5: js5.action, gated: js5.joint?.gated ?? null });
      }
      action = js5.action;
    } else {
      action = chooseAIAction(game, { parameters: registry.versions[OPPONENT_IDS[(g + seat) % OPPONENT_IDS.length]].parameters, profile: seatProfile(seat) }).action;
    }
    game = applyAction(game, action);
  }
}
const rate = (a, b) => (b ? +(a / b).toFixed(3) : null);
console.log(JSON.stringify({
  games, seedBase,
  decisions: stats.decisions,
  planVsGreedyAgreement: rate(stats.same, stats.decisions),
  preTriggerAgreement: rate(stats.samePre, stats.pre),
  postTriggerAgreement: rate(stats.samePost, stats.post),
  js5VsPlanAgreement: rate(stats.js5AgreeWithPlan, stats.decisions),
  js5VsGreedyAgreement: rate(stats.js5AgreeWithGreedy, stats.decisions),
  examples,
}, null, 2));
