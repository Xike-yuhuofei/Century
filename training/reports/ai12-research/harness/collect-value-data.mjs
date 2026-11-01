/**
 * AI12 学习型叶价值：自博弈位置采集（开发池，本地离线）。
 *
 * 与 simulate.mjs 同构的席位分派：焦点席位走 champion-guided（joint-js5），
 * 其余席位走冻结对手池（beam-search 参数）。每个焦点席位决策前记录公开特征，
 * 对局结束后写入标签（焦点席位是否第一名）。
 *
 * 训练/验证种子互不相交（shard 内进一步按 game index 奇偶切分）。
 * 用法：node training/reports/ai12-research/harness/collect-value-data.mjs --shard 0 --shards 5 --games 120 --seed-base 1737400000
 */
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createGame, applyAction, score as engineScore, ranking } from '../../../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../../../web-v1/dist/js/js/adapter.js';
import { buildRegistry } from '../../../adversarial/registry.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../../../lib/sim-stream.mjs';
import { GOLEM_BY_ID } from '../../../../web-v1/dist/js/data.js';

const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const registry = buildRegistry();
const CH = registry.versions['js5-frozen-champion'].parameters;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const shard = Number(arg('shard', 0));
const shards = Number(arg('shards', 4));
const games = Number(arg('games', 100));
const seedBase = Number(arg('seed-base', 1737400000));
const WU = Number(arg('wu', 32));
const out = arg('out', `/tmp/ai12-value-shard-${shard}.jsonl`);

const seatProfile = (seat) => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

/** 与 evaluators.leafVector 同口径的特征（全部公开信息）。 */
function features(game, seat) {
  const players = game.players;
  const n = players.length;
  const thr = n >= 4 ? 5 : 6;
  const scores = players.map(p => engineScore(p));
  const claimed = players.map(p => p.claimed.length);
  const engines = players.map(p => p.hand.length + p.played.length);
  const crystals = players.map(p => p.stock[1] + p.stock[2] + p.stock[3]);
  const turns = players.map(p => p.turns);
  const mine = scores[seat];
  let best = -Infinity;
  for (const p of players) if (p.id !== seat) best = Math.max(best, scores[p.id]);
  let bestClaim = 0, bestEngine = 0, bestCrystal = 0, bestTurns = 1;
  for (const p of players) {
    if (p.id === seat) continue;
    bestClaim = Math.max(bestClaim, claimed[p.id]);
    bestEngine = Math.max(bestEngine, engines[p.id]);
    bestCrystal = Math.max(bestCrystal, crystals[p.id]);
    bestTurns = Math.max(bestTurns, turns[p.id]);
  }
  const myTurns = Math.max(1, turns[seat]);
  const myRate = mine / myTurns;
  const bestRate = best / Math.max(1, bestTurns);
  // 市场最佳目标（按分值）与双方覆盖
  let bestGoal = 0, myCov = 0, rivalCov = 0;
  for (const id of game.golemMarket) {
    const goal = GOLEM_BY_ID[id];
    if (!goal) continue;
    if (goal.points > bestGoal) {
      bestGoal = goal.points;
      const total = goal.cost.reduce((s, x) => s + x, 0);
      myCov = total ? goal.cost.reduce((s, x, c) => s + Math.min(x, players[seat].stock[c]), 0) / total : 0;
      rivalCov = Math.max(...players.filter(p => p.id !== seat).map(p => (total
        ? goal.cost.reduce((s, x, c) => s + Math.min(x, p.stock[c]), 0) / total : 0)));
    }
  }
  return {
    scoreDiff: mine - best,
    claimDiff: claimed[seat] - bestClaim,
    myClaims: claimed[seat],
    bestClaims: bestClaim,
    remainingMe: thr - claimed[seat],
    remainingBest: thr - bestClaim,
    rateDiff: myRate - bestRate,
    myRate,
    engineDiff: engines[seat] - bestEngine,
    crystalDiff: crystals[seat] - bestCrystal,
    turnsElapsed: game.turnNumber / 50,
    copperPool: game.copper / 20,
    silverPool: game.silver / 20,
    myCoins: (players[seat].copper * 3 + players[seat].silver) / 10,
    triggered: game.triggerPlayer !== null ? 1 : 0,
    bestGoalPoints: bestGoal / 20,
    coverageGap: myCov - rivalCov,
  };
}

const lines = [];
for (let g = 0; g < games; g++) {
  const seed = seedBase + shard * 100000 + g;
  const seatCount = 2 + (g % 4);
  const focusSeat = (g + shard) % seatCount;
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  const sample = [];
  while (game.phase !== 'finished') {
    const seat = game.current;
    let action;
    if (seat === focusSeat && game.turnNumber >= 2) sample.push(features(game, seat));
    if (seat === focusSeat) {
      const res = chooseJointAction(game, {
        version: 'joint-js5', workUnits: WU, championParameters: CH, profile: seatProfile(seat),
        simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
      });
      action = res.action;
    } else {
      action = chooseAIAction(game, { parameters: registry.versions[OPPONENT_IDS[(g + seat) % OPPONENT_IDS.length]].parameters, profile: seatProfile(seat) }).action;
    }
    game = applyAction(game, action);
  }
  const ranked = ranking(game);
  const label = ranked[0]?.id === focusSeat ? 1 : 0;
  for (const f of sample) lines.push(JSON.stringify({ ...f, label, seed, seatCount, focusSeat }));
}
mkdirSync('/tmp', { recursive: true });
writeFileSync(out, lines.join('\n') + '\n');
console.log(JSON.stringify({ shard, games, samples: lines.length, out }));
