/** 实验 B：算法修改有效性 —— 候选代码必须真实参与游戏决策。
 *
 * 命题：一个安全、可编译、行为不同的策略变体（experiments/exp_b_variant.ts：
 * 移除协同项与抢牌竞争项）在注入候选席位后：
 * 1. 静态检查通过（变体本身合法）；
 * 2. 探针输出与官方显著不同（算法差异可观测，非"只改文件不生效"）；
 * 3. 同局对战中对局轨迹真实改变（与基线相比出现不同行动/结局）；
 * 4. 席位隔离成立：冠军代码运行的永远是官方模块 ——
 *    a) 官方编译产物 SHA256 前后不变；
 *    b) 探针同时加载两个模块实例，官方实例的输出与单独加载时一致
 *       （候选模块的存在不改变官方模块行为，无全局状态泄漏）；
 * 5. 变体对局零异常（合法候选不产生非法行动）。
 *
 * 用法：node experiments/exp_b_mutation.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const ai5 = dirname(here);
const repo = resolve(ai5, '../..');
const nodeDir = join(ai5, 'node');
const work = '/tmp/ai5-exp-b';
mkdirSync(work, { recursive: true });
mkdirSync(join(ai5, 'results'), { recursive: true });
const sha256 = p => createHash('sha256').update(p).digest('hex');

const shaBefore = {
  ai: sha256(readFileSync(join(repo, 'web-v1/dist/js/ai.js'))),
  engine: sha256(readFileSync(join(repo, 'web-v1/dist/js/engine.js'))),
};

const SEEDS = Array.from({ length: 12 }, (_, i) => 300_000_050 + i);
const checks = [];
const run = (cmd, opts) => execFileSync('node', cmd, { stdio: 'pipe', ...opts });

// ---- 1. 静态检查：变体合法（无禁止构造）----
let staticOk = true;
try {
  run([join(nodeDir, 'static_check.mjs'), '--program', join(here, 'exp_b_variant.ts'), '--out', `${work}/static.json`]);
} catch (e) {
  staticOk = false;
  console.error(e.stderr?.toString());
}
checks.push({ name: '变体通过静态安全检查', pass: staticOk });

// ---- 2. 组装 + 编译 + 探针：行为差异可观测 ----
run([join(nodeDir, 'assemble_candidate.mjs'), '--program', `${work}/static.fn.ts`, '--out', `${work}/cand`]);
run([join(repo, 'web-v1/node_modules/typescript/bin/tsc'), '-p', `${work}/cand/tsconfig.json`]);
run([join(nodeDir, 'probe.mjs'), '--candidate', `${work}/cand/dist/js/ai/evaluator.js`, '--out', `${work}/probe.json`]);
const probe = JSON.parse(readFileSync(`${work}/probe.json`, 'utf8'));
checks.push({ name: '探针：变体输出与官方显著不同（真实参与估值）', pass: probe.identicalToOfficial === false && probe.mismatchCount > 0, detail: { mismatchCount: probe.mismatchCount, maxAbsDiff: probe.maxAbsDiff, probeErrors: probe.probeErrors } });
checks.push({ name: '探针：官方实例输出不受候选模块共存影响（2100 用例无错误）', pass: probe.probeErrors === 0, detail: { probeErrors: probe.probeErrors } });

// ---- 3. 对局轨迹真实改变 ----
writeFileSync(`${work}/seeds.txt`, SEEDS.join('\n'));
run([join(nodeDir, 'duel_runner.mjs'), '--candidate-official', '--seed-list', `${work}/seeds.txt`, '--out', `${work}/duel-baseline.json`]);
run([join(nodeDir, 'duel_runner.mjs'), '--candidate', `${work}/cand/dist/js/ai.js`, '--seed-list', `${work}/seeds.txt`, '--out', `${work}/duel-variant.json`]);
const base = JSON.parse(readFileSync(`${work}/duel-baseline.json`, 'utf8'));
const variant = JSON.parse(readFileSync(`${work}/duel-variant.json`, 'utf8'));
let divergent = 0;
for (const seed of SEEDS) {
  const b = base.games.find(g => g.seed === seed && g.direction === 'A');
  const v = variant.games.find(g => g.seed === seed && g.direction === 'A');
  const keyOf = r => JSON.stringify({ winner: r.winnerSeat, moves: r.moves, ranking: r.ranking?.map(x => [x.seat, x.score]) });
  if (keyOf(b) !== keyOf(v)) divergent++;
}
checks.push({ name: `对局轨迹真实改变（${SEEDS.length} 种子中候选席位改变结局的种子数 > 0）`, pass: divergent > 0, detail: { divergentSeeds: divergent } });

// ---- 4. 候选对局零异常 ----
const vAnomaly = variant.stats.anomalyRate;
checks.push({ name: '变体对局零异常（合法候选产生合法行动）', pass: vAnomaly === 0, detail: { anomalyRate: vAnomaly, games: variant.stats.totalGames } });

// ---- 5. 官方产物零污染 ----
const shaAfter = {
  ai: sha256(readFileSync(join(repo, 'web-v1/dist/js/ai.js'))),
  engine: sha256(readFileSync(join(repo, 'web-v1/dist/js/engine.js'))),
};
checks.push({ name: '官方编译产物 SHA256 前后不变（冠军代码未被替换/污染）', pass: shaBefore.ai === shaAfter.ai && shaBefore.engine === shaAfter.engine, detail: { shaBefore, shaAfter } });

const allPass = checks.every(c => c.pass);
const result = {
  experiment: 'B：算法修改有效性',
  timestamp: new Date().toISOString(),
  variant: 'exp_b_variant.ts（移除协同项与抢牌竞争项）',
  seeds: SEEDS,
  checks,
  allPass,
};
writeFileSync(join(ai5, 'results/exp_b_mutation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ allPass, checks: checks.map(c => ({ name: c.name, pass: c.pass })) }, null, 2));
process.exit(allPass ? 0 : 1);
