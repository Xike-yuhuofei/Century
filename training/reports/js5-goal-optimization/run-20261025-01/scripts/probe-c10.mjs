/** C10 候选覆盖探针：固定公开局面（web-v1/tests/fixtures/js5-near-terminal-c10.json）。
 *
 * 用法：node .../scripts/probe-c10.mjs [--policy off|replace|add] [--work 32] [--worlds 4] [--seed 2026102509]
 * 输出：evidence/probe-c10-<policy>.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAction, score } from '../../../../../web-v1/dist/js/engine.js';
import { chooseJointAction } from '../../../../../web-v1/dist/js/js/adapter.js';
import { NEUTRAL_PROFILE } from '../../../../../web-v1/dist/js/ai.js';
import { GOLEM_BY_ID } from '../../../../../web-v1/dist/js/data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');
const REPO = resolve(RUN, '../../../..');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const policy = getArg('--policy', 'off');
const workUnits = Number(getArg('--work', '32'));
const worlds = Number(getArg('--worlds', '4'));
const simSeed = Number(getArg('--seed', '2026102509'));
const horizon = Number(getArg('--horizon', '48'));

const fixture = JSON.parse(readFileSync(join(REPO, 'web-v1/tests/fixtures/js5-near-terminal-c10.json'), 'utf8'));
const game = structuredClone(fixture.game);

const result = chooseJointAction(game, {
  version: 'joint-js5', workUnits, worlds, horizon, simSeed,
  profile: NEUTRAL_PROFILE,
  ...(policy !== 'off' ? { nearTerminalCandidate: policy } : {}),
  collectTrials: true,
});
const beforeScore = score(game.players[0]);
const legalScores = [];
const out = {
  schema: 'js5-goal-c10-probe-v1',
  fixture: 'web-v1/tests/fixtures/js5-near-terminal-c10.json',
  config: { workUnits, worlds, horizon, simSeed, policy },
  beforeScore,
  championAction: result.joint?.championAction,
  action: result.action,
  actionImmediateScore: (() => { const g = structuredClone(game); try { applyAction(g, result.action); return score(g.players[0]) - beforeScore; } catch { return null; } })(),
  gated: result.joint?.gated,
  stats: result.joint?.stats,
  evaluations: result.joint?.evaluations,
  reason: result.reason,
  trials: result.joint?.trials?.length ?? 0,
};
// 合法根动作的即时正式净分（公开信息，仅供核对；不进入决策）。
import('../../../../../web-v1/dist/js/sim/session.js').then(({ createSimulation }) => {
  return import('../../../../../web-v1/dist/js/sim/legal.js').then(async ({ enumerateLegalActions }) => {
    const { buildObservation } = await import('../../../../../web-v1/dist/js/ai/observation.js');
    const sim = createSimulation(buildObservation(game, 0), { simSeed: 0 });
    const legal = enumerateLegalActions(sim.view, { dedupe: true });
    for (const action of legal) {
      const g = structuredClone(game);
      try {
        const next = applyAction(g, action);
        if (next.phase === 'finished' || next.phase === 'overflow') continue;
        legalScores.push({ action, delta: score(next.players[0]) - beforeScore });
      } catch { /* 非法或代理限制，忽略 */ }
    }
    legalScores.sort((a, b) => b.delta - a.delta);
    out.topImmediate = legalScores.slice(0, 8);
    out.legalActionCount = legal.length;
    writeFileSync(join(RUN, 'evidence', `probe-c10-${policy}.json`), JSON.stringify(out, null, 2) + '\n');
    process.stdout.write(JSON.stringify({
      champion: out.championAction,
      chosen: out.action,
      chosenDelta: out.actionImmediateScore,
      candidates: out.evaluations?.map(e => ({ action: e.action, trials: e.trials, mean: Number(e.mean.toFixed(4)) })),
      topImmediate: out.topImmediate,
      stats: out.stats,
    }, null, 2) + '\n');
  });
}).catch(error => { console.error(error); process.exit(1); });
