/** AI 9.0 多模块候选真实对局评估（OpenEvolve stage2/3 共用）。
 *
 * 候选 = 独立编译的完整 ESM 决策包（dist/js）；冠军/对手 = 官方 dist。
 * 配对设计：每个种子 A=候选焦点席、B=冻结冠军同一焦点席；其余席位与种子完全
 * 相同（同一随机世界、同一对手身份、同一座位）。
 * 2–5 人全部覆盖，主指标 = 焦点席位配对第一名率增量（种子簇 CI）。
 *
 * 用法：
 *   node ai9_duel_runner.mjs --candidate <dist/js> --seed-list <file> \
 *     --out <json> --player-counts 2,3,4,5 --work-units 32 [--mode screen]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { moduleRegistry } from './module_registry.mjs';
import { REPO_ROOT } from './module_registry.mjs';
import { simulateGame } from '../../../training/simulator/simulate.mjs';
import { buildRegistry, toSeatVersion } from '../../../training/adversarial/registry.mjs';
import {
  clusterFirstPlacePairs, clusterMeanCI,
} from '../../../training/evaluator/first-place.mjs';
import { wilsonCI } from '../../../training/evaluator/stats.mjs';
import { AI9_OPENEVOLVE_STAGE2_BLOCK, AI9_OPENEVOLVE_STAGE3_BLOCK, parseSeedList } from '../../lib/seed_policy.mjs';

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const candidateRoot = arg('candidate');
const seedListPath = arg('seed-list');
const outPath = arg('out');
const playerCounts = String(arg('player-counts', '2,3,4,5')).split(',').map(Number);
const workUnits = Number(arg('work-units', '32'));
const mode = arg('mode', 'screen');
const maxMoves = Number(arg('max-moves', '500'));
const deadlineMs = Number(arg('deadline-ms', '90000'));
if (!candidateRoot || !seedListPath || !outPath) {
  console.error('用法: node ai9_duel_runner.mjs --candidate <dist/js> --seed-list <file> --out <json>');
  process.exit(2);
}
for (const n of playerCounts) {
  if (![2, 3, 4, 5].includes(n)) throw new Error(`人数非法：${n}`);
}
if (!Number.isSafeInteger(workUnits) || workUnits < 1 || workUnits > 4096) throw new Error(`work-units 非法：${workUnits}`);
if (mode !== 'screen' && mode !== 'deep') throw new Error(`mode 非法：${mode}`);

const ROTATION = [
  'js5-frozen-champion', 'ai5-readiness-efficiency', 'style-rush',
  'style-engine', 'style-contest', 'neutral-baseline',
];

function readShard(purpose) {
  const text = readFileSync(seedListPath, 'utf8');
  return parseSeedList(text, {
    block: purpose === 'deep' ? AI9_OPENEVOLVE_STAGE3_BLOCK : AI9_OPENEVOLVE_STAGE2_BLOCK,
    requireUnique: true,
  });
}

function opponentIdsFor({ seatCount, seedIndex }) {
  const ids = [];
  if (mode === 'deep') ids.push('js5-frozen-champion');
  const start = seedIndex % ROTATION.length;
  for (let i = 0; ids.length < seatCount - 1; i++) {
    ids.push(ROTATION[(start + i) % ROTATION.length]);
  }
  return ids;
}

function seatVersionOf(descriptor) {
  const seat = toSeatVersion(descriptor);
  return descriptor.decisionCore === 'champion-guided'
    ? { ...seat, adapter: 'champion-guided', jointOptions: { workUnits } }
    : seat;
}

async function main() {
  const allSeeds = readShard(mode);
  if (allSeeds.length % playerCounts.length !== 0) {
    throw new Error(`种子数 ${allSeeds.length} 不能被人数层数 ${playerCounts.length} 整除（每人数的种子必须独立且等量）`);
  }
  const perCount = allSeeds.length / playerCounts.length;
  if (perCount < 2) throw new Error(`每个人数至少需要 2 个种子，实际 ${perCount}`);
  const seedsByCount = new Map(playerCounts.map((count, index) => [
    count, allSeeds.slice(index * perCount, (index + 1) * perCount),
  ]));
  const candidateAI = await import(pathToFileURL(join(candidateRoot, 'ai.js')).href);
  const candidateJoint = await import(pathToFileURL(join(candidateRoot, 'js/adapter.js')).href);
  if (typeof candidateAI.chooseAIAction !== 'function' || typeof candidateJoint.chooseJointAction !== 'function') {
    throw new Error('候选决策包缺少 chooseAIAction / chooseJointAction');
  }
  const registry = buildRegistry({ jointOptions: { workUnits } });
  const champion = registry.versions['js5-frozen-champion'];
  if (!champion) throw new Error('缺少冻结冠军注册身份');
  // 权威模块身份来自注册表；这里只披露候选构建包含的模块（由源码哈希保证）。
  const programPath = arg('program');
  let moduleIds = null;
  if (programPath) {
    const text = readFileSync(programPath, 'utf8');
    const names = [...text.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
    moduleIds = names.map(name => moduleRegistry().modules.find(m => m.functionName === name)?.id).filter(Boolean);
  }

  const games = [];
  const pairs = [];
  const candidateParams = JSON.parse(readFileSync(join(REPO_ROOT, 'training/champions/champion.json'), 'utf8')).parameters;
  let seedIndex = 0;
  for (const seatCount of playerCounts) {
    for (const seed of seedsByCount.get(seatCount)) {
      const focusSeat = seedIndex % seatCount;
      const opponentIds = opponentIdsFor({ seatCount, seedIndex });
      const opponents = opponentIds.map(id => {
        const descriptor = registry.versions[id];
        if (!descriptor) throw new Error(`对手未注册：${id}`);
        return seatVersionOf(descriptor);
      });
      const baseSeats = Array.from({ length: seatCount }, (_, seat) => {
        if (seat === focusSeat) return null;
        const before = seat < focusSeat ? seat : seat - 1;
        return opponents[before % opponents.length];
      });
      const candidateSeat = {
        id: 'ai9-candidate',
        decisionCore: 'champion-guided',
        parameters: { ...candidateParams, id: 'ai9-candidate' },
        adapter: 'champion-guided',
        jointVersion: candidateParams.jointVersion ?? 'joint-js5',
        jointOptions: { workUnits },
        aiModule: candidateAI,
        jointModule: candidateJoint,
      };
      const arms = [
        { arm: 'A', version: candidateSeat },
        { arm: 'B', version: seatVersionOf(champion) },
      ];
      const results = {};
      for (const { arm, version } of arms) {
        const versions = baseSeats.map(v => (v === null ? version : v));
        const result = simulateGame({ seed, versions, seatCount, maxMoves, deadlineMs });
        results[arm] = result;
        const finished = result.status === 'finished';
        games.push({
          seed, seedIndex, seatCount, focusSeat, arm,
          status: result.status, reason: result.reason ?? null,
          firstPlace: finished ? result.ranking[0]?.seat === focusSeat : null,
          winnerSeat: result.winnerSeat ?? null,
          moves: result.moves ?? 0, wallMs: result.wallMs ?? 0,
          meanDecisionMs: result.metrics?.meanDecisionMs ?? null,
          opponentIds,
        });
      }
      const a = results.A;
      const b = results.B;
      const aFinished = a.status === 'finished';
      const bFinished = b.status === 'finished';
      pairs.push({
        seed, focusSeat, seatCount,
        candidateFirst: aFinished ? (a.ranking[0]?.seat === focusSeat ? 1 : 0) : null,
        championFirst: bFinished ? (b.ranking[0]?.seat === focusSeat ? 1 : 0) : null,
        anomalies: (aFinished ? 0 : 1) + (bFinished ? 0 : 1),
        status: aFinished && bFinished ? 'finished' : 'anomaly',
      });
      seedIndex += 1;
    }
  }

  const cleanPairs = pairs.filter(p => p.status === 'finished' && p.anomalies === 0);
  const clustered = clusterFirstPlacePairs(cleanPairs.map(p => ({
    seed: p.seed, focusSeat: p.focusSeat,
    candidateFirst: p.candidateFirst, championFirst: p.championFirst, anomalies: 0,
  })));
  const ci = clustered.uniqueSeeds >= 2 ? clusterMeanCI(clustered, { alpha: 0.05 }) : null;
  const byPlayerCount = {};
  for (const seatCount of playerCounts) {
    const stratumPairs = cleanPairs.filter(p => p.seatCount === seatCount);
    const stratumRows = games.filter(g => g.seatCount === seatCount && g.status === 'finished');
    const candidateWins = stratumRows.filter(g => g.arm === 'A' && g.firstPlace).length;
    const championWins = stratumRows.filter(g => g.arm === 'B' && g.firstPlace).length;
    const ca = stratumRows.filter(g => g.arm === 'A').length;
    const cb = stratumRows.filter(g => g.arm === 'B').length;
    byPlayerCount[String(seatCount)] = {
      seatCount,
      pairs: stratumPairs.length,
      delta: stratumPairs.length
        ? Number((stratumPairs.reduce((s, p) => s + (p.candidateFirst - p.championFirst), 0) / stratumPairs.length).toFixed(4))
        : null,
      candidateFirstRate: ca ? Number((candidateWins / ca).toFixed(4)) : null,
      championFirstRate: cb ? Number((championWins / cb).toFixed(4)) : null,
      candidateWilson: ca ? wilsonCI(candidateWins, ca) : null,
    };
  }
  const totalGames = games.length;
  const finishedGames = games.filter(g => g.status === 'finished').length;
  const p95 = (() => {
    const list = games.filter(g => g.arm === 'A').map(g => g.wallMs).sort((a, b) => a - b);
    return list.length ? Number(list[Math.min(list.length - 1, Math.floor(list.length * 0.95))].toFixed(1)) : null;
  })();

  const stats = {
    totalGames,
    finishedGames,
    anomalyGames: totalGames - finishedGames,
    anomalyRate: totalGames ? Number(((totalGames - finishedGames) / totalGames).toFixed(4)) : 1,
    uniqueSeedCount: new Set(allSeeds).size,
    pairs: cleanPairs.length,
    candidateFirstRate: clustered.uniqueSeeds
      ? Number((clustered.clusters.reduce((s, c) => s + c.candidateFirst, 0) / clustered.uniqueSeeds).toFixed(4))
      : null,
    championFirstRate: clustered.uniqueSeeds
      ? Number((clustered.clusters.reduce((s, c) => s + c.championFirst, 0) / clustered.uniqueSeeds).toFixed(4))
      : null,
    firstPlaceDelta: { ci: ci ?? null, byPlayerCount },
    p95WallMs: p95,
    meanDecisionMs: mean(games.filter(g => g.arm === 'A').map(g => g.meanDecisionMs)),
    primaryMetric: 'pairedFirstPlaceRateDelta',
  };

  const out = {
    config: {
      candidate: resolve(candidateRoot), mode, playerCounts, workUnits,
      seedList: resolve(seedListPath), seeds: allSeeds.length, moduleIds,
      control: 'js5-frozen-champion (immutable archive)',
    },
    modules: { candidate: 'independent-compiled-esm', champion: 'official-dist-esm', registry: moduleRegistry().version },
    games,
    pairs,
    stats,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, stats: { ...stats, firstPlaceDelta: stats.firstPlaceDelta.ci } }));
}

function mean(values) {
  const list = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return list.length ? Number((list.reduce((s, v) => s + v, 0) / list.length).toFixed(3)) : null;
}

main().catch(error => {
  console.error(`AI9 duel runner 失败：${error.stack ?? error.message}`);
  process.exit(1);
});
