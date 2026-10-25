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
import { frozenVersion } from '../../web-v1/dist/js/ai/version-registry.js';
import { HISTORICAL_POOLS } from './pools.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { enumerateLegalActions } from '../../web-v1/dist/js/sim/legal.js';

/** 历史冠军参数（AI6 第六阶段 P0 修复）：本工具重放第五阶段 confirm 对局，
 * 其"js0 席位"= 晋级前冠军 ai5-readiness-efficiency。此前引用
 * CHAMPION_PARAMETERS——晋级后该常量为 JS5 描述符，重放静默换成 JS5 决策，
 * js0 重放率从 24/24 崩到 1-2/12（污染实况证据）。冻结参数从注册表取。 */
const LEGACY = frozenVersion('legacy-js0');

const seatProfile = seat => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);
const POOLS = HISTORICAL_POOLS;
function versionsForSeats(candidateSeats, candidateId, opponents, seedIndex, seatCount) {
  const poolSize = opponents.length;
  return Array.from({ length: seatCount }, (_, seat) => {
    if (candidateSeats.includes(seat)) {
      return candidateId === 'js0'
        ? { candidate: true, kind: 'frozen', id: LEGACY.id, parameters: LEGACY.parameters, structure: LEGACY.structure }
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
    } else if (version.candidate && version.kind === 'frozen') {
      action = chooseAIAction(game, { parameters: version.parameters, ...(version.structure ? { structure: version.structure } : {}), profile: seatProfile(seat) }).action;
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
