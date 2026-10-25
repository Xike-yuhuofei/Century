/** confirm 对局重放验证：当前 dist 是否与 confirm 实验加载的代码决策一致。
 * 取已记录的 confirm 对局种子，用当前构建重放（同协议），比较终局指纹。
 * js0 对局作为重放器健全性对照（冠军路径与本阶段改动无关，必须逐位一致）；
 * js5 对局为预算模式（墙钟截断随负载变化）——少量分歧可由截断差异解释，
 * 全量分歧则说明 confirm 进程加载了不同代码。
 * 用法：node training/joint/confirm-replay-check.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction, score as engineScore, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { REPO_ROOT } from '../lib/paths.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { enumerateLegalActions } from '../../web-v1/dist/js/sim/legal.js';
import { resolveAlgorithmVersion, decisionOptions } from '../lib/version-registry.mjs';

const seatProfile = seat => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

// P0-1 整改：confirm 历史数据生成于晋级前——当时的池冠军 = ai5-readiness-efficiency
// （冻结 js0），风格变体从它浅拷贝。修复前本工具用 CHAMPION_PARAMETERS 重建池与
// js0 候选席位——晋级后 CHAMPION_PARAMETERS=joint-js5 适配器 → 重放身份全错
// （js0 24/24 → 1/12、2/12 实锤）。历史重放的全部身份必须来自冻结归档。
const JS0 = resolveAlgorithmVersion('legacy-js0');
const JS0_OPTS = decisionOptions(JS0);

function classicPool() {
  const base = JS0.parameters;
  return [
    { id: base.id, parameters: base, structure: base.structure },
    { id: 'neutral-baseline', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure },
    { id: `${base.id}@tempo`, parameters: { ...base, tempoWeight: Math.min(1.5, base.tempoWeight * 1.35), restWeight: Math.max(0.5, base.restWeight * 0.8) }, structure: base.structure },
    { id: `${base.id}@contest`, parameters: { ...base, contestWeight: Math.min(2, base.contestWeight * 1.4), goalWeight: Math.min(1.5, base.goalWeight * 1.15) }, structure: base.structure },
    { id: `${base.id}@engine`, parameters: { ...base, engineWeight: Math.min(1.5, base.engineWeight * 1.3), endgameWeight: Math.min(1.5, base.endgameWeight * 1.1) }, structure: base.structure },
  ];
}
function diversePool() {
  const base = JS0.parameters;
  const hist = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/candidates/struct-beam-rollout.json'), 'utf8'));
  const hp = hist.parameters ?? hist;
  return [
    { id: base.id, parameters: base, structure: base.structure },
    { id: 'ai4-struct-beam-rollout', parameters: hp, structure: hp.structure, randomLegal: false },
    { id: 'style-rush', parameters: { ...base, tempoWeight: 1.6, restWeight: 0.5, engineWeight: 0.5, endgameWeight: 0.6 }, structure: base.structure, randomLegal: false },
    { id: 'style-engine', parameters: { ...base, engineWeight: 1.6, capacityWeight: 1.4, tempoWeight: 0.7 }, structure: base.structure, randomLegal: false },
    { id: 'random-legal', parameters: BASELINE_PARAMETERS, structure: BASELINE_PARAMETERS.structure, randomLegal: true },
  ];
}
const POOLS = { classic: classicPool, diverse: diversePool };
function versionsForSeats(candidateSeats, candidateId, opponents, seedIndex, seatCount) {
  const poolSize = opponents.length;
  return Array.from({ length: seatCount }, (_, seat) => {
    if (candidateSeats.includes(seat)) {
      return candidateId === 'js0'
        ? { candidate: true, kind: 'champion', id: 'js0-frozen-champion' }
        : { candidate: true, kind: 'joint', id: `joint-${candidateId}`, joint: `joint-${candidateId}` };
    }
    const opponentIndex = (poolSize - 1) * ((seedIndex + seat) % poolSize) % poolSize;
    const opponent = opponents[opponentIndex];
    return { candidate: false, id: opponent.id, parameters: opponent.parameters, structure: opponent.structure, randomLegal: opponent.randomLegal === true };
  });
}
/** 随机合法对手（与 duel.mjs 同一实现：全量枚举 + 确定性均匀采样）。 */
function randomLegalAction(game, rng) {
  const view = {
    current: game.current, phase: game.phase, turnNumber: game.turnNumber,
    players: game.players.map(p => ({ id: p.id, stock: [...p.stock], hand: [...p.hand], played: [...p.played], claimed: [...p.claimed] })),
    golemMarket: [...game.golemMarket],
    merchantMarket: game.merchantMarket.map(m => ({ id: m.id })),
  };
  const legal = enumerateLegalActions(view, { dedupe: false });
  if (!legal.length) return { type: 'rest' };
  return legal[Math.floor(rng() * legal.length)];
}
function replay({ seed, seatCount, candidateSeats, candidateId, pool }) {
  const versions = versionsForSeats(candidateSeats, candidateId, POOLS[pool](), seed % 100000, seatCount);
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  const seatRngs = new Map();
  const rngFor = seat => { if (!seatRngs.has(seat)) seatRngs.set(seat, mulberry32(((seed >>> 0) ^ Math.imul(seat + 1, 0x9E3779B9)) >>> 0)); return seatRngs.get(seat); };
  let moves = 0;
  while (game.phase !== 'finished') {
    const seat = game.current;
    const version = versions[seat];
    let action;
    if (version.candidate && version.kind === 'joint') {
      const r = chooseJointAction(game, { version: version.joint, budgetMs: 100, simSeed: seed, profile: seatProfile(seat) });
      action = r.action;
    } else if (version.candidate && version.kind === 'champion') {
      action = chooseAIAction(game, { ...JS0_OPTS.beam, profile: seatProfile(seat) }).action;
    } else if (version.randomLegal) {
      action = randomLegalAction(game, rngFor(seat));
    } else {
      action = chooseAIAction(game, { ...(version.parameters ? { parameters: version.parameters } : {}), ...(version.structure ? { structure: version.structure } : {}), profile: seatProfile(seat) }).action;
    }
    game = applyAction(game, action);
    moves += 1;
  }
  const ranked = ranking(game);
  return { winnerSeat: ranked[0].id, moves, scores: ranked.map(p => engineScore(p)).join(',') };
}

function check(candidateId, dir, file, sample) {
  const doc = JSON.parse(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  const cell = doc.cells.find(c => c.seatCount === 2);
  const games = cell.games.filter(g => g.status === 'finished').slice(0, sample);
  let match = 0, total = 0;
  for (const g of games) {
    const r = replay({ seed: g.seed, seatCount: 2, candidateSeats: g.candidateSeats, candidateId, pool: dir.includes('div') || dir.includes('diverse') ? 'diverse' : 'classic' });
    total += 1;
    const ok = r.winnerSeat === g.winnerSeat && r.moves === g.moves;
    if (ok) match += 1;
    else console.log(`  分歧 seed=${g.seed} dir=${g.direction}: 重放 winner=${r.winnerSeat} moves=${r.moves} vs 记录 winner=${g.winnerSeat} moves=${g.moves}`);
  }
  console.log(`${candidateId} ${dir}: ${match}/${total} 逐位一致`);
  return { candidateId, dir, match, total };
}
function rankedScoresOf(g) { return null; } // scoreDiff 足够时省略——此处用 winner+moves 判定

const results = [];
results.push(check('js0', 'classic', 'training/reports/js5-phase5/confirm/js0-classic/ablation-confirm-js0-2_3_4_5-200s.json', 12));
results.push(check('js5', 'classic', 'training/reports/js5-phase5/confirm/js5-classic/ablation-confirm-js5-2_3_4_5-200s.json', 12));
// diverse 池跨 4147439 重建的冠军路径不变性验证（js0-diverse 于接线前运行）。
results.push(check('js0', 'diverse', 'training/reports/js5-phase5/confirm/js0-diverse/ablation-confirm-js0-2_3_4_5-200s-div.json', 12));
console.log(JSON.stringify(results));
