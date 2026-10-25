/** 对抗性联赛·运行入口 CLI（overnight-adversarial-league）。
 *
 * 用法：
 *   node training/adversarial/run-league.mjs --mode matrix \
 *     --versions js5-frozen-champion,style-rush --players 2,5 \
 *     --seeds 4 --block smoke --joint fast --out training/reports/adversarial-league
 *
 *   node training/adversarial/run-league.mjs --mode evaluate \
 *     --candidates training/adversarial/candidates.json --candidate-ids cand-x \
 *     --players 2,5 --seeds 20 --block matrix-dev --joint fast --out ...
 *
 * 模式：
 * - matrix：注册表版本两两胜率矩阵（h2h 2p / 有向场 3–5p）；
 * - evaluate：候选双轴评估（轴 A 对抗 / 轴 G 通用）+ 强对手筛选。
 *
 * 种子纪律：--block 从 ai5/lib/seed_policy.mjs 的联赛子块解析（dev/smoke/
 * matrix-dev/prereg），assertInBlock 全程强制；本 CLI 绝不触碰验证池。
 * 算力纪律：--joint fast（workUnits 确定性快档）用于冒烟/开发；正式联赛
 * 必须 --joint official（冻结冠军 budgetMs=100 墙钟口径）。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  buildRegistry, registryFingerprint, resolveVersion,
} from './registry.mjs';
import { registerCandidates, CANDIDATE_SCHEMA } from './candidate.mjs';
import { planMatrix, runPlan, summarizeLeague } from './league.mjs';
import { evaluateCandidate, selectStrongOpponents, GENERALITY_POOL } from './evaluate.mjs';
import {
  AI6_LEAGUE_DEV_SUBBLOCK, AI6_LEAGUE_SMOKE_SUBBLOCK,
  AI6_LEAGUE_MATRIX_DEV_SUBBLOCK, AI6_LEAGUE_PREREG_SUBBLOCK,
} from '../../ai5/lib/seed_policy.mjs';

const BLOCKS = {
  dev: AI6_LEAGUE_DEV_SUBBLOCK,
  smoke: AI6_LEAGUE_SMOKE_SUBBLOCK,
  'matrix-dev': AI6_LEAGUE_MATRIX_DEV_SUBBLOCK,
  prereg: AI6_LEAGUE_PREREG_SUBBLOCK,
};

function parseArgs() {
  const args = {
    mode: 'matrix', versions: null, candidates: null, candidateIds: null,
    players: [2, 5], seeds: 4, block: 'smoke', joint: 'fast',
    out: resolve('training/reports/adversarial-league'), label: null,
    registryJoint: null, seedOffset: 0,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--mode') args.mode = argv[++i];
    else if (flag === '--versions') args.versions = argv[++i].split(',');
    else if (flag === '--candidates') args.candidates = resolve(argv[++i]);
    else if (flag === '--candidate-ids') args.candidateIds = argv[++i].split(',');
    else if (flag === '--players') args.players = argv[++i].split(',').map(Number);
    else if (flag === '--seeds') args.seeds = Number(argv[++i]);
    else if (flag === '--block') args.block = argv[++i];
    else if (flag === '--joint') args.joint = argv[++i];
    else if (flag === '--out') args.out = resolve(argv[++i]);
    else if (flag === '--label') args.label = argv[++i];
    else if (flag === '--seed-offset') args.seedOffset = Number(argv[++i]);
    else throw new Error(`未知参数：${flag}`);
  }
  if (!Number.isSafeInteger(args.seedOffset) || args.seedOffset < 0) {
    throw new Error(`--seed-offset 必须为非负安全整数，实际：${args.seedOffset}`);
  }
  return args;
}

function jointOverridesFor(joint) {
  if (joint === 'fast') return { workUnits: 64 };
  if (joint === 'official') return null;
  throw new Error(`--joint 必须为 fast|official，实际：${joint}`);
}

/** 读取候选规范文件（JSON 数组或单个对象）。 */
function loadCandidateSpecs(path) {
  if (!existsSync(path)) throw new Error(`候选规范文件不存在：${path}`);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const specs = Array.isArray(doc) ? doc : [doc];
  for (const spec of specs) {
    if (spec.schema !== CANDIDATE_SCHEMA) throw new Error(`候选文件 schema 非法：${String(spec.schema)}`);
  }
  return specs;
}

function printMatrix(matrix, versionIds) {
  const header = [''].concat(versionIds);
  process.stdout.write(`${'胜率矩阵（行=焦点版本，列=对手版本，单元格=焦点第一名率）'}\n`);
  process.stdout.write(`${header.map(h => h.slice(0, 24).padStart(24)).join('')}\n`);
  for (const row of versionIds) {
    const cells = [row.slice(0, 24).padStart(24)];
    for (const col of versionIds) {
      const cell = matrix[row]?.[col];
      cells.push(cell ? `${(cell.firstPlaceRate * 100).toFixed(1)}%(${cell.games})`.padStart(24) : '-'.padStart(24));
    }
    process.stdout.write(`${cells.join('')}\n`);
  }
}

async function main() {
  const args = parseArgs();
  if (!BLOCKS[args.block]) throw new Error(`--block 必须为 ${Object.keys(BLOCKS).join('|')}，实际：${args.block}`);
  if (args.mode !== 'matrix' && args.mode !== 'evaluate') throw new Error(`--mode 必须为 matrix|evaluate，实际：${args.mode}`);
  const block = BLOCKS[args.block];
  const jointOverrides = jointOverridesFor(args.joint);

  // 注册表：--joint official 时冻结冠军按归档 budgetMs=100；fast 档在
  // playLeagueGame 层覆盖（注册表 jointOptions 保留 null 语义）。
  const baseRegistry = buildRegistry({ jointOptions: null });
  let registry = baseRegistry;
  if (args.candidates) {
    registry = registerCandidates(baseRegistry, loadCandidateSpecs(args.candidates));
  }

  const label = args.label ?? `${args.mode}-${args.block}-${args.seeds}s-${args.joint}`;
  const outDir = resolve(args.out, label);
  mkdirSync(outDir, { recursive: true });

  if (args.mode === 'matrix') {
    const versionIds = args.versions ?? Object.keys(registry.versions);
    for (const id of versionIds) resolveVersion(registry, id);
    const plan = planMatrix({
      versionIds, seatCounts: args.players, seedsPerPair: args.seeds,
      seedBase: block[0] + args.seedOffset, block,
    });
    process.stdout.write(`赛程：${plan.matches.length} 场，${plan.matches.reduce((s, m) => s + m.seeds.length, 0)} 局，种子 [${plan.seedBase}, ${plan.seedEnd})\n`);
    const t0 = performance.now();
    const games = runPlan(plan, registry, { jointOverrides });
    const report = summarizeLeague({ plan, games, registry, jointOverrides });
    const out = resolve(outDir, 'league-report.json');
    writeFileSync(out, JSON.stringify(report, null, 2));
    printMatrix(report.matrix, versionIds);
    process.stdout.write(`异常局：${report.totals.anomalies}/${report.totals.games}；总耗时 ${Math.round((performance.now() - t0) / 1000)}s\n`);
    process.stdout.write(`报告已写入：${out}\n`);
  } else {
    const candidateIds = args.candidateIds ?? (registry.snapshot.candidates ?? []);
    if (!candidateIds.length) throw new Error('evaluate 模式需要 --candidates + --candidate-ids（或候选文件中的候选）');
    // 双轴种子分区（块内：offset 前段保留给既定方案，轴 A 随后，轴 G 收尾，绝不重叠）。
    const axisAGamesPerCell = args.players.reduce((s, n) => s + (n === 2 ? 1 : 2), 0);
    const axisANeed = axisAGamesPerCell * args.seeds;
    const axisGNeed = args.players.length * args.seeds;
    if (args.seedOffset + axisANeed + axisGNeed > block[1] - block[0]) {
      throw new Error(`种子需求 offset ${args.seedOffset} + ${axisANeed} + ${axisGNeed} 超出块容量 ${block[1] - block[0]}`);
    }
    const evaluations = [];
    for (const candidateId of candidateIds) {
      process.stdout.write(`评估候选 ${candidateId}（轴 A ${axisANeed} 局 + 轴 G ${axisGNeed} 局）...\n`);
      const t0 = performance.now();
      const evaluation = evaluateCandidate({
        registry, candidateId, seatCounts: args.players, seedsPerCell: args.seeds,
        axisASeedBase: block[0] + args.seedOffset, axisGSeedBase: block[0] + args.seedOffset + axisANeed, block,
        jointOverrides,
      });
      process.stdout.write(`  完成 ${Math.round(performance.now() - t0) / 1000}s｜轴A ${evaluation.axisA.cells.map(c => `${(c.firstPlaceRate * 100).toFixed(1)}%(${c.games})`).join(' ')}｜轴G ${evaluation.axisG.cells.map(c => `${(c.firstPlaceRate * 100).toFixed(1)}%(${c.games})`).join(' ')}\n`);
      evaluations.push(evaluation);
    }
    const selection = selectStrongOpponents(evaluations);
    const report = {
      schema: 'century-adversarial-evaluation-v1',
      date: new Date().toISOString(),
      registryFingerprint: registryFingerprint(registry),
      engineBundleSha256: baseRegistry.snapshot.engineBundleSha256,
      block: [...block], jointOverrides, seedsPerCell: args.seeds, players: args.players,
      seedOffset: args.seedOffset,
      generalityPool: GENERALITY_POOL,
      selection,
      evaluations: evaluations.map(e => ({
        candidateId: e.candidateId, fingerprint: e.fingerprint,
        axisA: e.axisA, axisG: e.axisG,
        axisAGames: e.axisAGames, axisGGames: e.axisGGames,
      })),
    };
    const out = resolve(outDir, 'evaluation-report.json');
    writeFileSync(out, JSON.stringify(report, null, 2));
    for (const row of selection.all) {
      process.stdout.write(`${row.candidateId}: ${row.verdict}（轴A ${row.axisA.firstPlaceRate} 下界 ${row.axisA.wilsonLower?.toFixed(3)}；轴G 下界 ${row.axisG.wilsonLowerMin?.toFixed(3)} 分差 ${row.axisG.scoreDiffMin}）\n`);
    }
    process.stdout.write(`报告已写入：${out}\n`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch(error => { console.error(error); process.exit(1); });
}
