/** 扫描 29 局公开观察中的"临近终局 + 候选遗漏"局面（发现集；不用于结论统计）。
 *
 * 输入只用 c83f 已导出的公开观察（public-observations.json，无隐藏牌库）。
 * 对每个 AI 决策点：公开风险 → 当步正式净分最大行动 → 基线 JS5 候选是否覆盖。
 * 输出：evidence/near-terminal-scan.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chooseJointAction } from '../../../../../web-v1/dist/js/js/adapter.js';
import { NEUTRAL_PROFILE } from '../../../../../web-v1/dist/js/ai.js';
import { nearTerminalRisk, maxImmediateScoreAction } from '../../../../../web-v1/dist/js/js/near-terminal.js';
import { enumerateLegalActions } from '../../../../../web-v1/dist/js/sim/legal.js';
import { createSimulation } from '../../../../../web-v1/dist/js/sim/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');
const REPO = resolve(RUN, '../../../..');
const observations = JSON.parse(readFileSync(join(REPO, 'training/reports/human-js5-review/agent-20261025-c83f/evidence/public-observations.json'), 'utf8'));

const clone = v => JSON.parse(JSON.stringify(v));
function gameProxy(view) {
  return {
    version: 2, log: [],
    players: view.players.map(p => ({ ...clone(p), isAI: p.isAI !== false })),
    current: view.current,
    merchantMarket: clone(view.merchantMarket),
    golemMarket: [...view.golemMarket],
    copper: view.copper, silver: view.silver,
    phase: view.phase, triggerPlayer: view.triggerPlayer, turnNumber: view.turnNumber,
    merchantDeck: [], golemDeck: [],
  };
}

const workUnits = Number(process.env.SCAN_WORK ?? 32);
const worlds = Number(process.env.SCAN_WORLDS ?? 4);
const horizon = Number(process.env.SCAN_HORIZON ?? 48);
const seedBase = Number(process.env.SCAN_SEED ?? 2026102509);
const rows = [];
let scanned = 0, risky = 0, missing = 0, changed = 0, failed = 0;
for (const entry of observations) {
  const view = entry.observation;
  if (!view.players[view.playerId]?.isAI) continue;
  if (view.phase !== 'turn') continue;
  const risk = nearTerminalRisk(view);
  if (!risk.risky) continue;
  risky += 1;
  const sim = createSimulation(view, { simSeed: 0 });
  const legal = enumerateLegalActions(sim.view, { dedupe: true });
  const best = maxImmediateScoreAction(view, legal);
  if (!best) continue;
  scanned += 1;
  const seed = seedBase + rows.length;
  let baseline;
  try {
    baseline = chooseJointAction(gameProxy(view), {
      version: 'joint-js5', gateMode: 'always', workUnits, worlds, horizon, simSeed: seed, profile: NEUTRAL_PROFILE,
    });
  } catch (error) {
    failed += 1;
    continue;
  }
  const covered = (baseline.joint?.evaluations ?? []).some(e => JSON.stringify(e.action) === JSON.stringify(best.action));
  if (covered) continue;
  missing += 1;
  let patched;
  try {
    patched = chooseJointAction(gameProxy(view), {
      version: 'joint-js5', gateMode: 'always', workUnits, worlds, horizon, simSeed: seed,
      profile: NEUTRAL_PROFILE, nearTerminalCandidate: 'replace',
    });
  } catch { continue; }
  const actionChanged = JSON.stringify(patched.action) !== JSON.stringify(baseline.action);
  if (actionChanged) changed += 1;
  rows.push({
    game: entry.game, turn: entry.turn, seat: view.playerId,
    risk: { reason: risk.reason, threatenedSeats: risk.threatenedSeats, selfThreatened: risk.selfThreatened },
    maxImmediate: { action: best.action, delta: best.delta, scoreAfter: best.scoreAfter },
    championAction: baseline.joint?.championAction ?? null,
    baselineAction: baseline.action,
    baselineCandidates: (baseline.joint?.evaluations ?? []).map(e => e.action),
    patchedAction: patched.action,
    patchedInjected: patched.joint?.stats?.nearTerminal?.injected ?? null,
    patchedSelected: JSON.stringify(patched.action) === JSON.stringify(best.action),
    actionChanged,
    trials: baseline.joint?.stats?.rollouts ?? 0,
    configHash: baseline.config?.hash ?? null,
  });
  if (rows.length >= 40) break;
}

const out = {
  schema: 'js5-goal-near-terminal-scan-v1',
  source: 'c83f evidence/public-observations.json',
  config: { workUnits, worlds, horizon, seedBase },
  counts: { observations: observations.length, risky, scanned, missing, changed, failed, rows: rows.length },
  rows,
};
writeFileSync(join(RUN, 'evidence', 'near-terminal-scan.json'), JSON.stringify(out, null, 2) + '\n');
process.stdout.write(JSON.stringify(out.counts, null, 2) + '\n');
process.stdout.write(JSON.stringify(rows.slice(0, 12).map(r => ({
  game: r.game, turn: r.turn, seat: r.seat, best: r.maxImmediate, champion: r.championAction,
  baseline: r.baselineAction, patched: r.patchedAction, selected: r.patchedSelected,
})), null, 2) + '\n');
