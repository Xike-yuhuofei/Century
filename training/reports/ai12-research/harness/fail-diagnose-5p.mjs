/**
 * AI12 诊断：5 人局冠军失败画像（正式对手池 + 正式座位接线）。
 *
 * 记录焦点席位每个决策的公开上下文、合法可认领数、冠军计划首步、JS5 实际行动
 * 与仲裁元数据；终局记录全部席位的分数/认领/打出/休息/回合。
 *
 * 目的：把“5p 引擎空转、认领不足”从描述性画像变成逐决策证据，并区分
 * “可立即认领却选择不认领”的频率在胜局/败局中的差异。
 *
 * 用法：node training/reports/ai12-research/harness/fail-diagnose-5p.mjs --games 40 --seed-base 1770000000 --wu 64
 */
import { writeFileSync } from 'node:fs';
import { createGame, applyAction, score as engineScore, ranking } from '../../../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { choosePlan } from '../../../../web-v1/dist/js/ai/planner.js';
import { buildObservation } from '../../../../web-v1/dist/js/ai/observation.js';
import { createSimulation } from '../../../../web-v1/dist/js/sim/session.js';
import { enumerateLegalActions } from '../../../../web-v1/dist/js/sim/legal.js';
import { chooseJointAction } from '../../../../web-v1/dist/js/js/adapter.js';
import { buildRegistry } from '../../../adversarial/registry.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../../../lib/sim-stream.mjs';
import { toSeatVersion, opponentForSeat, focusSeatFor } from '../../../tournament/first-place-challenge.mjs';

const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const registry = buildRegistry();
const CH = registry.versions['js5-frozen-champion'].parameters;
const seatProfile = (seat) => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const games = Number(arg('games', 40));
const seedBase = Number(arg('seed-base', 1770000000));
const WU = Number(arg('wu', 64));
const out = arg('out', '/tmp/ai12-fail-5p.json');

const records = [];
for (let g = 0; g < games; g++) {
  const seatCount = 5;
  const seed = seedBase + g;
  const seedIndex = g;
  const focusSeat = focusSeatFor({ seedIndex, seatCount });
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  const decisions = [];
  while (game.phase !== 'finished') {
    const seat = game.current;
    let action;
    if (seat === focusSeat && game.phase === 'turn') {
      const obs = buildObservation(game, seat);
      const profile = seatProfile(seat);
      const plan = choosePlan(obs, CH, profile, 'beam-rollout');
      const sim = createSimulation(obs, { simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT) });
      const legal = enumerateLegalActions(sim.view, { dedupe: true });
      const claims = legal.filter(a => a.type === 'claim');
      const claimableIds = claims.map(a => (obs.golemMarket[a.index] ? a.index : -1));
      const threshold = seatCount >= 4 ? 5 : 6;
      const remaining = threshold - obs.players[seat].claimed.length;
      const scores = obs.players.map(p => engineScore(p));
      const maxOther = Math.max(...obs.players.filter(p => p.id !== seat).map(p => engineScore(p)));
      const js5 = chooseJointAction(game, {
        version: 'joint-js5', workUnits: WU, championParameters: CH, profile,
        simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
      });
      decisions.push({
        turn: game.turnNumber,
        remaining,
        score: scores[seat],
        myEngineScore: scores[seat],
        lead: scores[seat] - maxOther,
        trigger: obs.triggerPlayer !== null,
        legalClaims: claims.length,
        legalClaimIndices: claimableIds,
        legalTotal: legal.length,
        plan: plan?.first ?? null,
        planPreferred: plan?.preferred ?? null,
        js5: js5.action,
        gated: js5.joint?.gated ?? null,
        candidateCount: js5.joint?.stats?.candidateCount ?? null,
        chosenTrials: js5.joint?.chosen?.trials ?? null,
        override: plan?.first ? JSON.stringify(plan.first) !== JSON.stringify(js5.action) : null,
        claimChosen: js5.action.type === 'claim',
        availableClaimIgnored: claims.length > 0 && js5.action.type !== 'claim',
      });
      action = js5.action;
    } else {
      const descriptor = opponentForSeat({ seedIndex, seat, opponents: OPPONENT_IDS });
      action = chooseAIAction(game, { parameters: registry.versions[descriptor].parameters, profile: seatProfile(seat) }).action;
    }
    game = applyAction(game, action);
  }
  const ranked = ranking(game);
  const first = ranked[0]?.id === focusSeat;
  const seats = game.players.map(p => ({
    id: p.id,
    focus: p.id === focusSeat,
    score: engineScore(p),
    claims: p.claimed.length,
    plays: p.played.length,
    turns: p.turns,
    hand: p.hand.length,
  }));
  records.push({ seed, focusSeat, won: first, winner: ranked[0]?.id ?? null, ranked: ranked.map(r => ({ id: r.id, score: r.score })), decisions, seats });
}
writeFileSync(out, JSON.stringify({ schema: 'century-ai12-fail-5p-v1', games, seedBase, workUnits: WU, records }, null, 2));
console.log(JSON.stringify({ games, seedBase, out, wins: records.filter(r => r.won).length }));
