/** 冠军版本一致性审计（AI6 第四阶段·任务书 §二 + 交付 9）。
 *
 * 背景：冠军原始产物 c1dd8272…（b029567 构建）与 HEAD 构建产物 b0df3fc4…
 * 存在指纹差异（beam-contest 变体等 AI 源码新增所致）。本审计回答唯一问题：
 * **冠军执行路径（beam-rollout + readiness-efficiency）在 HEAD dist 上是否
 * 与冻结冠军 dist 逐位决策一致**。一致 ⇒ 单宇宙对局（同一规则引擎推进、
 * 双方决策函数来自各自版本）对 JS0/JS1 是公平的；不一致 ⇒ 回退双宇宙镜像评测。
 *
 * 方法：同一 seed / 席位数 / 席位版本（冻结冠军参数）分别在
 * - 宇宙 C：champion worktree dist（c1dd8272…，已核验 = provenance）
 * - 宇宙 H：主仓 HEAD dist（b0df3fc4…）
 * 下完整对局，比较确定性结果指纹（剔除计时字段）与全部决策序列。
 *
 * 用法：node training/joint/audit.mjs [--seeds 24] [--players 2,3,5]
 * 输出：training/reports/joint-search-v1/version-audit.json + 控制台结论。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Volumes/Extreme SSD/Projects/Century';
const CHAMPION_DIST = pathToFileURL(resolve(REPO, '../Century-champion-dist/web-v1/dist/js')).href;
const HEAD_DIST = pathToFileURL(resolve(REPO, 'web-v1/dist/js')).href;

/** 解析命令行参数。 */
function parseArgs() {
  const args = { seeds: 24, players: [2, 3, 5], outDir: resolve(REPO, 'training/reports/joint-search-v1') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') args.seeds = Number(argv[++i]);
    else if (argv[i] === '--players') args.players = argv[++i].split(',').map(Number);
    else if (argv[i] === '--out') args.outDir = resolve(argv[++i]);
  }
  return args;
}

/** 席位人格映射（与 training/simulator/simulate.mjs 完全一致）。 */
async function loadProfiles(distUrl) {
  const ai = await import(`${distUrl}/ai.js`);
  return { NEUTRAL_PROFILE: ai.NEUTRAL_PROFILE, PROFILES: ai.PROFILES };
}

/** 单宇宙完整对局（镜像 simulate.mjs 主循环，决策函数可注入 dist）。 */
async function runUniverse(distUrl, { seed, seatCount, championParams, maxMoves = 1200, deadlineMs = 60_000 }) {
  const engine = await import(`${distUrl}/engine.js`);
  const ai = await import(`${distUrl}/ai.js`);
  const { NEUTRAL_PROFILE, PROFILES } = await loadProfiles(distUrl);
  const seatProfile = seat => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

  let game;
  try {
    game = engine.createGame(
      Array.from({ length: seatCount }, (_, i) => `席位${i}`),
      seed,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1),
    );
    game.players[0].isAI = true;
  } catch (error) {
    return { status: 'anomaly', reason: `createGame 失败：${error.message}` };
  }

  const decisions = [];
  let moves = 0;
  const started = performance.now();
  try {
    while (game.phase !== 'finished') {
      if (moves >= maxMoves) return { status: 'anomaly', reason: `步数上限 ${maxMoves}` };
      if (performance.now() - started > deadlineMs) return { status: 'anomaly', reason: '超时' };
      const seat = game.current;
      const response = ai.chooseAIAction(game, {
        parameters: championParams,
        profile: seatProfile(seat),
      });
      decisions.push(response.action);
      game = engine.applyAction(game, response.action);
      moves += 1;
    }
  } catch (error) {
    return { status: 'anomaly', reason: `对局异常：${error.message}`, decisions };
  }
  const ranked = engine.ranking(game);
  return {
    status: 'finished',
    winnerSeat: ranked[0].id,
    moves,
    ranking: ranked.map(p => ({ seat: p.id, score: engine.score(p), golems: p.claimed.length })),
    decisions,
  };
}

/** 剔除决策顺序后的确定性键（决策序列另行比较）。 */
function outcomeKey(r) {
  return JSON.stringify({ status: r.status, winnerSeat: r.winnerSeat, moves: r.moves, ranking: r.ranking ?? null });
}

async function main() {
  const { seeds, players, outDir } = parseArgs();
  const freeze = JSON.parse((await import('node:fs')).readFileSync(resolve(REPO, 'training/baseline/champion-freeze.json'), 'utf8'));
  const championParams = freeze.champion.parameters;

  const rows = [];
  let mismatches = 0;
  let anomalies = 0;
  for (const seatCount of players) {
    for (let i = 0; i < seeds; i++) {
      // AI6_JOINT_SEARCH_BLOCK 审计子块 [1.30e9, 1.30e9+seeds)：与全部既有块物理隔离。
      const seed = 1_300_000_000 + i;
      const champ = await runUniverse(CHAMPION_DIST, { seed, seatCount, championParams });
      const head = await runUniverse(HEAD_DIST, { seed, seatCount, championParams });
      const sameOutcome = outcomeKey(champ) === outcomeKey(head);
      const sameDecisions = champ.status === 'finished' && head.status === 'finished'
        ? JSON.stringify(champ.decisions) === JSON.stringify(head.decisions)
        : null;
      if (!sameOutcome || sameDecisions === false) mismatches += 1;
      if (champ.status !== 'finished' || head.status !== 'finished') anomalies += 1;
      rows.push({ seed, seatCount, champStatus: champ.status, headStatus: head.status, sameOutcome, sameDecisions });
    }
  }

  const verdict = mismatches === 0
    ? 'CONSISTENT（冠军执行路径在 HEAD dist 上逐位一致；单宇宙对局公平性成立）'
    : `INCONSISTENT（${mismatches} 局决策不一致；评测必须回退双宇宙镜像方案）`;
  const report = {
    schema: 'century-joint-search-version-audit-v1',
    date: new Date().toISOString(),
    championDistRoot: CHAMPION_DIST,
    championBundleSha256: 'c1dd8272ae15fb26d7724a9c1d1044bd2773bc13d898e3b937cd0c17d1acf8eb',
    headDistRoot: HEAD_DIST,
    headBundleSha256: 'b0df3fc49bfe8589ae5f1b792270821c6f7a81183439c3bbe6a4e4a89193d0a8',
    championParams: { id: championParams.id, structure: championParams.structure, acquisitionVariant: championParams.acquisitionVariant },
    seeds, players, totalPairs: rows.length, mismatches, anomalies,
    verdict,
    note: '种子取自 AI6_JOINT_SEARCH_BLOCK 审计子块 [1.3e9,1.3e9+seeds)，不与训练/验证/基线块重叠。',
    rows,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'version-audit.json'), JSON.stringify(report, null, 2));
  console.log(`审计完成：${rows.length} 配对，不一致 ${mismatches}，异常 ${anomalies}`);
  console.log(`结论：${verdict}`);
  if (mismatches > 0) process.exitCode = 2;
}

main().catch(error => { console.error(error); process.exit(1); });
