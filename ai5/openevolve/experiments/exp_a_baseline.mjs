/** 实验 A：基线一致性。
 *
 * 命题：未修改的候选算法（初始程序 = 当前冠军实现逐字节一致）在与 AI 4.0
 * 相同的状态、相同的随机种子下，必须产生完全一致的有效行动结果。
 *
 * 验证方法：
 * 1. 静态检查初始程序 → 组装候选树 → 编译 → 探针（2100 个确定性用例）：
 *    候选 acquisitionValue 与官方逐位一致；
 * 2. duel_runner（候选=官方模块）与 training/simulator 的 simulateGame
 *    （versions=null，冠军基线）在相同 50 种子上逐局对比确定性指纹
 *    （种子/状态/胜者/步数/名次表全部一致）；
 * 3. 官方编译产物（engine.js / ai.js）在实验前后 SHA256 不变 —— 冠军零污染。
 *
 * 用法：node experiments/exp_a_baseline.mjs
 * 结果写入 ../results/exp_a_baseline.json；全部断言通过退出码 0。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { simulateGame } from '../../../training/simulator/simulate.mjs';

const here = dirname(fileURLToPath(import.meta.url));      // ai5/openevolve/experiments
const ai5 = dirname(here);                                  // ai5/openevolve
const repo = resolve(ai5, '../..');
const nodeDir = join(ai5, 'node');
const work = '/tmp/ai5-exp-a';
mkdirSync(work, { recursive: true });
const sha256 = p => createHash('sha256').update(p).digest('hex');
const resultsDir = join(ai5, 'results');
mkdirSync(resultsDir, { recursive: true });

const distAI = readFileSync(join(repo, 'web-v1/dist/js/ai.js'));
const distEngine = readFileSync(join(repo, 'web-v1/dist/js/engine.js'));
const shaBefore = { ai: sha256(distAI), engine: sha256(distEngine) };

const SEEDS = Array.from({ length: 50 }, (_, i) => 300_000_000 + i);
const checks = [];

// ---- 1. stage-1 管线（静态 → 组装 → 编译 → 探针）----
execFileSync('node', [join(nodeDir, 'static_check.mjs'), '--program', join(ai5, 'program/acquisition_value.ts'), '--out', `${work}/static.json`], { stdio: 'pipe' });
execFileSync('node', [join(nodeDir, 'assemble_candidate.mjs'), '--program', `${work}/static.fn.ts`, '--out', `${work}/cand`], { stdio: 'pipe' });
execFileSync('node', [join(repo, 'web-v1/node_modules/typescript/bin/tsc'), '-p', `${work}/cand/tsconfig.json`], { stdio: 'pipe' });
execFileSync('node', [join(nodeDir, 'probe.mjs'), '--candidate', `${work}/cand/dist/js/ai/evaluator.js`, '--out', `${work}/probe.json`], { stdio: 'pipe' });
const probe = JSON.parse(readFileSync(`${work}/probe.json`, 'utf8'));
checks.push({ name: `探针：候选 acquisitionValue 与官方逐位一致（${probe.cases} 用例）`, pass: probe.identicalToOfficial === true, detail: { cases: probe.cases, mismatchCount: probe.mismatchCount } });

// ---- 2. 同种子对局逐位一致（duel_runner vs simulateGame）----
const seedFile = `${work}/seeds.txt`;
writeFileSync(seedFile, SEEDS.join('\n'));
execFileSync('node', [join(nodeDir, 'duel_runner.mjs'), '--candidate-official', '--seed-list', seedFile, '--out', `${work}/duel.json`], { stdio: 'pipe' });
const duel = JSON.parse(readFileSync(`${work}/duel.json`, 'utf8'));

let mismatches = 0;
const details = [];
for (const seed of SEEDS) {
  const sim = simulateGame({ seed }); // versions=null → 当前激活参数（冠军）
  const duelA = duel.games.find(g => g.seed === seed && g.direction === 'A');
  const keyOf = r => JSON.stringify({ status: r.status, winner: r.winnerSeat, moves: r.moves, ranking: r.ranking?.map(x => [x.seat, x.score]) });
  if (keyOf(sim) !== keyOf(duelA)) { mismatches++; details.push({ seed, sim: keyOf(sim), duel: keyOf(duelA) }); }
}
checks.push({ name: `同种子对局一致性（${SEEDS.length} 种子，方向 A=官方布局）`, pass: mismatches === 0, detail: { mismatches, samples: details.slice(0, 3) } });

// ---- 3. 配对分差必须为 0（候选=冠军时无任何优势/劣势信号）----
const diffs = duel.seedPairs.filter(p => p.status === 'finished' && p.diff !== 0);
checks.push({ name: '配对分差为零（基线不自证优势）', pass: diffs.length === 0, detail: { nonzeroPairs: diffs.length } });

// ---- 4. 官方产物零污染 ----
const shaAfter = { ai: sha256(readFileSync(join(repo, 'web-v1/dist/js/ai.js'))), engine: sha256(readFileSync(join(repo, 'web-v1/dist/js/engine.js'))) };
checks.push({ name: '官方编译产物 SHA256 前后不变', pass: shaBefore.ai === shaAfter.ai && shaBefore.engine === shaAfter.engine, detail: { shaBefore, shaAfter } });

const allPass = checks.every(c => c.pass);
const result = {
  experiment: 'A：基线一致性',
  timestamp: new Date().toISOString(),
  seeds: SEEDS,
  seedBlock: [300_000_000, 400_000_000],
  candidate: 'official-baseline（初始程序=冠军实现）',
  checks,
  allPass,
};
writeFileSync(join(resultsDir, 'exp_a_baseline.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ allPass, checks: checks.map(c => ({ name: c.name, pass: c.pass })) }, null, 2));
process.exit(allPass ? 0 : 1);
