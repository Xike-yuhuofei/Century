/**
 * AI13 决策探针：同状态下比较冠军默认选项与候选选项的行动差异（开发池）。
 * 轨迹始终按默认策略推进，候选只用于“同状态反事实”比较；不产生胜率证据。
 *
 * 用法：
 *   node decision-probe.mjs --a '{"evaluator":"L6"}' --games 8 --seed-base 1809000000
 *   node decision-probe.mjs --a '{"horizon":96}' --games 4 --seed-base 1809000000
 */
import { createGame, applyAction } from '../../../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../../../web-v1/dist/js/js/adapter.js';
import { buildRegistry } from '../../../adversarial/registry.mjs';
import { deriveSimStreamSeed, DEFAULT_SIM_SALT } from '../../../lib/sim-stream.mjs';

const OPPONENT_IDS = ['ai5-readiness-efficiency', 'ai4-struct-beam-rollout', 'style-engine', 'style-rush', 'style-contest', 'neutral-baseline'];
const registry = buildRegistry();
const CH = registry.versions['js5-frozen-champion'].parameters;
const seatProfile = (seat) => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);
const key = a => JSON.stringify(a);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const candidateA = JSON.parse(arg('a', '{}'));
const gamesPerCount = Number(arg('games', 8));
const seedBase = Number(arg('seed-base', 1809000000));
const WU = Number(arg('wu', 32));
const seats = String(arg('seats', '2,3,4,5')).split(',').map(Number);
const out = arg('out', null);

let decisions = 0, changed = 0, gated = 0;
const byCount = {};
const examples = [];
for (const seatCount of seats) {
  byCount[seatCount] = { decisions: 0, changed: 0, gated: 0 };
  for (let g = 0; g < gamesPerCount; g++) {
    const seed = seedBase + seatCount * 1000 + g;
    const focusSeat = (g * 7 + 3) % seatCount;
    let game = createGame(Array.from({ length: seatCount }, (_, i) => `P${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
    game.players[0].isAI = true;
    while (game.phase !== 'finished') {
      const seat = game.current;
      let action;
      if (seat === focusSeat && game.phase === 'turn') {
        const simSeed = deriveSimStreamSeed(seed, DEFAULT_SIM_SALT);
        const base = { version: 'joint-js5', workUnits: WU, championParameters: CH, profile: seatProfile(seat), simSeed };
        const a0 = chooseJointAction(game, base);
        const a1 = chooseJointAction(game, { ...base, ...candidateA });
        decisions += 1;
        byCount[seatCount].decisions += 1;
        if (a1.gated) { gated += 1; byCount[seatCount].gated += 1; }
        if (key(a0.action) !== key(a1.action)) {
          changed += 1;
          byCount[seatCount].changed += 1;
          if (examples.length < 8) {
            examples.push({
              seats: seatCount, turn: game.turnNumber, seat,
              default: a0.action, candidate: a1.action,
              defaultGated: a0.gated, candidateGated: a1.gated,
              defaultChosen: a0.chosen?.mean, candidateChosen: a1.chosen?.mean,
            });
          }
        }
        action = a0.action;
      } else {
        action = chooseJointAction(game, {
          version: 'joint-js5', workUnits: WU, championParameters: CH, profile: seatProfile(seat),
          simSeed: deriveSimStreamSeed(seed, DEFAULT_SIM_SALT),
        }).action;
      }
      game = applyAction(game, action);
    }
  }
}
const result = { candidateA, gamesPerCount, seedBase, workUnits: WU, seats, decisions, gated, changed, changedRate: +(changed / Math.max(1, decisions)).toFixed(4), byCount, examples };
console.log(JSON.stringify(result, null, 2));
if (out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify(result, null, 2));
}
