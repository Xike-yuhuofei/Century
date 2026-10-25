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
  loadLedger, registerExperiment, setExperimentStatus, nextSeedBase, verifyLedger,
} from './seed-ledger.mjs';
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
    registryJoint: null,
    // P0-4 种子账本：experimentId（缺省 = label）；--seed-base 显式绝对起点或
    // --seed-offset 块内相对起点（PR #42 引入，向后兼容；两者都经账本校验）；
    // 缺省 = 块内下一个未消费起点；--ledger-path 仅供测试注入；
    // --crn-group 声明有意 CRN 配对复用；--purpose 用途披露。
    experimentId: null, seedBase: null, seedOffset: null, ledgerPath: null, crnGroup: null, purpose: null,
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
    else if (flag === '--experiment-id') args.experimentId = argv[++i];
    else if (flag === '--seed-base') args.seedBase = Number(argv[++i]);
    else if (flag === '--seed-offset') args.seedOffset = Number(argv[++i]);
    else if (flag === '--ledger-path') args.ledgerPath = resolve(argv[++i]);
    else if (flag === '--crn-group') args.crnGroup = argv[++i];
    else if (flag === '--purpose') args.purpose = argv[++i];
    else throw new Error(`未知参数：${flag}`);
  }
  if (args.seedBase !== null && args.seedOffset !== null) {
    throw new Error('--seed-base 与 --seed-offset 互斥（前者为绝对起点，后者为块内相对起点）');
  }
  if (args.seedOffset !== null && (!Number.isSafeInteger(args.seedOffset) || args.seedOffset < 0)) {
    throw new Error(`--seed-offset 必须为非负安全整数，实际：${args.seedOffset}`);
  }
  return args;
}

/** P0-4 种子账本登记：fail-closed（缺账本/区间重叠/越块一律抛错）。
 * 种子起点解析优先级：--seed-base（绝对）> --seed-offset（块内相对，兼容 PR #42
 * 手动偏移方案）> nextSeedBase（块内下一个未消费起点）。全部路径都经账本校验与
 * 登记——手工偏移不再是绕过防重的旁路。
 * 返回 {seedBase, seedEnd, experimentId, ledgerPath}。注册发生在对局开始前。 */
function allocateSeeds(args, block, needSeeds, fingerprints) {
  const ledgerPath = args.ledgerPath ?? undefined;
  const ledger = loadLedger(ledgerPath);
  const defects = verifyLedger(ledger);
  if (defects.length) throw new Error(`联赛种子账本存在结构缺陷（fail-closed）：\n- ${defects.join('\n- ')}`);
  const seedBase = args.seedBase
    ?? (args.seedOffset !== null ? block[0] + args.seedOffset : undefined)
    ?? nextSeedBase(args.block, { ledgerPath });
  const experimentId = args.experimentId ?? `${args.label ?? `${args.mode}-${args.block}-${args.seeds}s-${args.joint}`}`;
  const registered = registerExperiment({
    experimentId,
    blockName: args.block,
    seedBase,
    seedCount: needSeeds,
    purpose: args.purpose ?? `${args.mode}（${args.joint} 档${args.seedOffset !== null ? `，seed-offset=${args.seedOffset}` : ''}）`,
    crnGroup: args.crnGroup,
    algorithmFingerprints: fingerprints,
    ledgerPath,
  });
  return { seedBase, seedEnd: registered.seedEnd, experimentId, ledgerPath };
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

/** 分层矩阵展示（P0-3 整改：按 (seatCount, protocol) 分节打印，绝不跨人数合并）。
 * 单元格 = 焦点第一名率(局数)；异常局以 +aN 后缀披露。 */
function printMatrix(matrix, versionIds) {
  // 收集全部协议层（保持数字人数升序）。
  const protocols = new Set();
  for (const row of Object.values(matrix)) {
    for (const entry of Object.values(row)) {
      for (const p of Object.keys(entry.byProtocol)) protocols.add(p);
    }
  }
  const ordered = [...protocols].sort((a, b) => {
    const sa = Number(a.split('@')[1]) || 0;
    const sb = Number(b.split('@')[1]) || 0;
    return sa - sb || a.localeCompare(b);
  });
  for (const protocol of ordered) {
    process.stdout.write(`\n胜率矩阵（${protocol}｜行=焦点版本，列=对手版本，单元格=焦点第一名率(局数)）\n`);
    const header = [''].concat(versionIds);
    process.stdout.write(`${header.map(h => h.slice(0, 24).padStart(24)).join('')}\n`);
    for (const row of versionIds) {
      const cells = [row.slice(0, 24).padStart(24)];
      for (const col of versionIds) {
        const cell = matrix[row]?.[col]?.byProtocol[protocol];
        cells.push(cell
          ? `${(cell.firstPlaceRate * 100).toFixed(1)}%(${cell.games})${cell.anomalies ? `+异常${cell.anomalies}` : ''}`.padStart(24)
          : '-'.padStart(24));
      }
      process.stdout.write(`${cells.join('')}\n`);
    }
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
    // P0-4：先按赛程总量登记种子消费（fail-closed），再从账本起点生成赛程。
    const seatCounts = args.players;
    const pairCount = seatCounts.reduce((s, n) => s + (n === 2 ? 1 : 2), 0) * (versionIds.length * (versionIds.length - 1) / 2);
    const needSeeds = pairCount * args.seeds;
    const allocation = allocateSeeds(args, block, needSeeds, versionIds.map(id => registry.versions[id].fingerprint));
    const plan = planMatrix({
      versionIds, seatCounts: args.players, seedsPerPair: args.seeds,
      seedBase: allocation.seedBase, block,
    });
    process.stdout.write(`赛程：${plan.matches.length} 场，${plan.matches.reduce((s, m) => s + m.seeds.length, 0)} 局，种子 [${plan.seedBase}, ${plan.seedEnd})（账本实验 ${allocation.experimentId}）\n`);
    const t0 = performance.now();
    const games = runPlan(plan, registry, { jointOverrides });
    const report = summarizeLeague({ plan, games, registry, jointOverrides });
    report.seedLedger = { experimentId: allocation.experimentId, seedStart: allocation.seedBase, seedEnd: allocation.seedEnd, ledgerPath: allocation.ledgerPath ?? 'training/adversarial/seed-ledger.json' };
    const out = resolve(outDir, 'league-report.json');
    writeFileSync(out, JSON.stringify(report, null, 2));
    setExperimentStatus(allocation.experimentId, 'completed', { ledgerPath: allocation.ledgerPath });
    printMatrix(report.matrix, versionIds);
    process.stdout.write(`异常局：${report.totals.anomalies}/${report.totals.games}；总耗时 ${Math.round((performance.now() - t0) / 1000)}s\n`);
    process.stdout.write(`报告已写入：${out}\n`);
  } else {
    const candidateIds = args.candidateIds ?? (registry.snapshot.candidates ?? []);
    if (!candidateIds.length) throw new Error('evaluate 模式需要 --candidates + --candidate-ids（或候选文件中的候选）');
    // 双轴种子分区（块内：轴 A 前段，轴 G 后段，绝不重叠；显式 --seed-offset 时
    // 前段保留给既定方案，轴 A 从 offset 起步——全部经账本校验）。
    const axisAGamesPerCell = args.players.reduce((s, n) => s + (n === 2 ? 1 : 2), 0);
    const axisANeed = axisAGamesPerCell * args.seeds;
    const axisGNeed = args.players.length * args.seeds;
    if (args.seedOffset !== null && args.seedOffset + axisANeed + axisGNeed > block[1] - block[0]) {
      throw new Error(`种子需求 offset ${args.seedOffset} + ${axisANeed} + ${axisGNeed} 超出块容量 ${block[1] - block[0]}`);
    }
    // P0-4：多候选共享同一轴 A/轴 G 种子 = 有意 CRN 配对（跨候选配对比较），
    // 必须显式声明 crnGroup；缺省拒绝静默共享（fail-closed）。
    const crnGroup = args.crnGroup ?? (() => {
      throw new Error('evaluate 模式的多候选共享种子属有意 CRN 配对，必须显式声明 --crn-group（防意外重复消费）');
    })();
    const allocation = allocateSeeds(args, block, axisANeed + axisGNeed, candidateIds.map(id => registry.versions[id]?.fingerprint).filter(Boolean));
    const evaluations = [];
    for (const candidateId of candidateIds) {
      process.stdout.write(`评估候选 ${candidateId}（轴 A ${axisANeed} 局 + 轴 G ${axisGNeed} 局）...\n`);
      const t0 = performance.now();
      const evaluation = evaluateCandidate({
        registry, candidateId, seatCounts: args.players, seedsPerCell: args.seeds,
        axisASeedBase: allocation.seedBase, axisGSeedBase: allocation.seedBase + axisANeed, block,
        jointOverrides,
      });
      process.stdout.write(`  完成 ${Math.round(performance.now() - t0) / 1000}s｜轴A ${evaluation.axisA.cells.map(c => `${(c.firstPlaceRate * 100).toFixed(1)}%(${c.games})`).join(' ')}｜轴G ${evaluation.axisG.cells.map(c => `${(c.firstPlaceRate * 100).toFixed(1)}%(${c.games})`).join(' ')}\n`);
      evaluations.push(evaluation);
    }
    const selection = selectStrongOpponents(evaluations);
    const report = {
      schema: 'century-adversarial-evaluation-v2',
      date: new Date().toISOString(),
      registryFingerprint: registryFingerprint(registry),
      engineBundleSha256: baseRegistry.snapshot.engineBundleSha256,
      block: [...block], jointOverrides, seedsPerCell: args.seeds, players: args.players,
      seedLedger: { experimentId: allocation.experimentId, seedStart: allocation.seedBase, seedEnd: allocation.seedEnd, crnGroup, ledgerPath: allocation.ledgerPath ?? 'training/adversarial/seed-ledger.json' },
      ...(args.seedOffset !== null ? { seedOffset: args.seedOffset } : {}),
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
    setExperimentStatus(allocation.experimentId, 'completed', { ledgerPath: allocation.ledgerPath });
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
