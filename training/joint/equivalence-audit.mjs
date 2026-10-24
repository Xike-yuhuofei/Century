/** JS5(gate=never) ≡ JS0 逐决策等价审计（AI6 第五阶段·任务 A1）。
 *
 * 目标（任务书 A1）：在 2–5 人、不同公开状态和人格映射下验证
 * `JS5(gate=never) ≡ JS0`——决策级对照要求行动及相关确定性决策输出一致。
 * gate=never 模式下 JS5 的冠军直通路径必须与冻结冠军逐决策一致；
 * 这是"JS5 的全部差异来自联合仲裁、不来自冠军路径扰动"的归因基础
 * （PR #27 曾以此捕获 profile 注入缺陷，但当时的审计脚本未入库）。
 * 本工具将其固化为可复现审计：任何 JS5 代码改动后必须重跑并保持零不一致。
 *
 * 协议：
 * - 同 seed、同席位数、同席位版本分配（候选席位分别以 js0 与 js5(gate=never)
 *   注入，其余席位完全一致）下完整对局；
 * - 比较候选席位的逐决策行动序列 + 终局结果（winner/moves/ranking）；
 * - 人格映射覆盖：席位 0 = NEUTRAL，其余 = PROFILES 轮换（与训练模拟器一致）；
 *   另支持 --profile-shift 平移人格映射（不同人格映射下复验）；
 * - 种子：AI6_JOINT_AUDIT_SUBBLOCK 内未消费段 [1.305e9, 1.305e9+K)（与
 *   version-audit 使用的 [1.3e9,1.3e9+24) 不重叠；审计子块 = 开发/审计基础设施，
 *   不用于任何强度结论）。
 *
 * 用法：node training/joint/equivalence-audit.mjs [--seeds 8] [--players 2,3,4,5] [--profile-shift 0]
 * 输出：training/reports/js5-phase5/equivalence-audit.json + 控制台结论（不一致 exit 2）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, applyAction, score as engineScore, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { assertInBlock } from '../../ai5/lib/seed_policy.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

/** 席位人格映射（与 training/simulator/simulate.mjs 完全一致 + 可选平移）。 */
function seatProfile(seat, shift) {
  if (seat === 0 && !shift) return NEUTRAL_PROFILE;
  return PROFILES[((seat - 1 + (shift || 0)) % PROFILES.length + PROFILES.length) % PROFILES.length];
}

function candidateVersion(id) {
  const jointId = id.startsWith('joint-') ? id : `joint-${id}`;
  if (id === 'js0') return { kind: 'champion', id: 'js0-frozen-champion' };
  return { kind: 'joint', id: jointId, joint: jointId };
}

/** 单局（镜像 duel.runGame，只保留候选席位决策序列 + 终局指纹）。 */
function runGame({ seed, seatCount, candidateSeat, candidate, jointOptions, profileShift, maxMoves = 1200, deadlineMs = 120_000 }) {
  const versions = Array.from({ length: seatCount }, (_, seat) => {
    if (seat === candidateSeat) return { candidate: true, ...candidate };
    return { candidate: false, id: 'opponent-frozen-champion', parameters: CHAMPION_PARAMETERS, structure: CHAMPION_PARAMETERS.structure };
  });
  let game;
  game = createGame(
    Array.from({ length: seatCount }, (_, i) => `席位${i}`),
    seed,
    Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
  );
  game.players[0].isAI = true;
  const decisions = [];
  const decisionMeta = [];
  let moves = 0;
  const started = performance.now();
  while (game.phase !== 'finished') {
    if (moves >= maxMoves) return { status: 'anomaly', reason: `步数上限 ${maxMoves}` };
    if (performance.now() - started > deadlineMs) return { status: 'anomaly', reason: `单局超时 ${deadlineMs}ms` };
    const seat = game.current;
    const version = versions[seat];
    const profile = seatProfile(seat, profileShift);
    let action;
    if (version.candidate && version.kind === 'joint') {
      const r = chooseJointAction(game, { version: version.joint, ...jointOptions, simSeed: seed, profile });
      action = r.action;
      decisions.push(action);
      decisionMeta.push({ gated: r.joint?.gated ?? null, phase: game.phase });
    } else if (version.candidate && version.kind === 'champion') {
      const r = chooseAIAction(game, { parameters: CHAMPION_PARAMETERS, profile });
      action = r.action;
      decisions.push(action);
      decisionMeta.push({ gated: null, phase: game.phase });
    } else {
      const r = chooseAIAction(game, { parameters: CHAMPION_PARAMETERS, structure: CHAMPION_PARAMETERS.structure, profile });
      action = r.action;
    }
    game = applyAction(game, action);
    moves += 1;
  }
  const turnCounts = new Set(game.players.map(p => p.turns));
  if (turnCounts.size !== 1) return { status: 'anomaly', reason: '终局回合数不一致' };
  const ranked = ranking(game);
  return {
    status: 'finished',
    winnerSeat: ranked[0].id,
    moves,
    ranking: ranked.map(p => ({ seat: p.id, score: engineScore(p), golems: p.claimed.length })),
    decisions,
    decisionMeta,
  };
}

function parseArgs() {
  const args = { seeds: 8, players: [2, 3, 4, 5], profileShift: 0, outDir: resolve(REPO_ROOT, 'training/reports/js5-phase5') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--profile-shift') args.profileShift = Number(argv[++i]);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

async function main() {
  const { seeds, players, profileShift, outDir } = parseArgs();
  const jointOptions = { gateMode: 'never', budgetMs: 100 };
  const rows = [];
  let mismatches = 0;
  let anomalies = 0;
  let totalDecisions = 0;
  for (const seatCount of players) {
    for (let i = 0; i < seeds; i++) {
      // 审计子块内未消费段：version-audit 使用 [1.3e9, 1.3e9+24)，本审计从
      // 1.3e9+100 起（同子块不同段，天然不重叠；审计子块 = 基础设施种子，
      // 不用于任何强度结论）。
      const seed = 1_300_000_100 + i + seeds * players.indexOf(seatCount);
      assertInBlock(seed, [1_300_000_000, 1_301_000_000], '审计种子');
      for (const candidateSeat of [i % seatCount]) {
        const js0 = runGame({ seed, seatCount, candidateSeat, candidate: candidateVersion('js0'), jointOptions: {}, profileShift });
        const js5n = runGame({ seed, seatCount, candidateSeat, candidate: candidateVersion('js5'), jointOptions, profileShift });
        const sameOutcome = JSON.stringify({ w: js0.winnerSeat, m: js0.moves, r: js0.ranking }) === JSON.stringify({ w: js5n.winnerSeat, m: js5n.moves, r: js5n.ranking });
        let firstDiff = null;
        if (js0.status === 'finished' && js5n.status === 'finished') {
          const n = Math.max(js0.decisions.length, js5n.decisions.length);
          for (let d = 0; d < n; d++) {
            if (JSON.stringify(js0.decisions[d]) !== JSON.stringify(js5n.decisions[d])) { firstDiff = d; break; }
          }
          totalDecisions += js0.decisions.length;
        }
        const sameDecisions = (js0.status === 'finished' && js5n.status === 'finished') ? firstDiff === null : null;
        if (!sameOutcome || sameDecisions === false) mismatches += 1;
        if (js0.status !== 'finished' || js5n.status !== 'finished') anomalies += 1;
        rows.push({
          seed, seatCount, candidateSeat,
          js0Status: js0.status, js5nStatus: js5n.status,
          sameOutcome, sameDecisions, firstDiffDecision: firstDiff,
          js0Decisions: js0.decisions?.length ?? null, js5nDecisions: js5n.decisions?.length ?? null,
        });
      }
    }
  }
  const verdict = mismatches === 0 && anomalies === 0
    ? `EQUIVALENT（JS5 gate=never ≡ JS0：${rows.length} 局、${totalDecisions} 决策零不一致）`
    : mismatches === 0
      ? `EQUIVALENT_WITH_ANOMALIES（决策一致但存在 ${anomalies} 局异常——先排查异常再下结论）`
      : `INCONSISTENT（${mismatches} 局不一致）——立即停止一切强度结论，先查明原因`;
  const report = {
    schema: 'century-js5-equivalence-audit-v1',
    date: new Date().toISOString(),
    protocol: 'js5(gate=never) vs js0 逐决策对照；种子=审计子块未消费段 [1.305e9,+)；人格映射 shift=' + profileShift,
    jointOptions, seeds, players, profileShift,
    totalPairs: rows.length, mismatches, anomalies, totalDecisions,
    verdict,
    rows,
  };
  mkdirSync(outDir, { recursive: true });
  const suffix = `${players.join('_')}-${seeds}s-shift${profileShift}`;
  writeFileSync(resolve(outDir, `equivalence-audit-${suffix}.json`), JSON.stringify(report, null, 2));
  console.log(`审计完成：${rows.length} 局 / ${totalDecisions} 决策，不一致 ${mismatches}，异常 ${anomalies}`);
  console.log(`结论：${verdict}`);
  if (mismatches > 0 || anomalies > 0) process.exitCode = 2;
}

main().catch(error => { console.error(error); process.exit(1); });
