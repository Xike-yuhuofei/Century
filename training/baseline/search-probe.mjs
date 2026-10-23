/** 搜索节点扩展率探针（AI6 第一阶段任务 D 补充）。
 *
 * 目的：测量 beam-rollout 冠军的 search node expansions/s——冻结 bundle 未暴露
 * 搜索计数器，instrument 正式产物会改变冠军指纹（违反冻结约束）。本探针采用
 * 「诊断构建」方案：
 *
 * 1. 从 `--ref`（默认 = 冠军注册提交，champion.json provenance.codeCommit）
 *    用 git archive 提取 web-v1 源码到临时目录（绝不触碰 web-v1/dist 正式产物）；
 * 2. 打 4 处只读计数补丁（beam 展开节点 / rollout 步进 / 决策次数）；
 * 3. 在临时目录构建诊断 dist（工具链与正式构建完全一致）；
 * 4. 【行为等价验证】同一批种子 + 冠军参数下，诊断构建与冻结 dist 的
 *    对局结果（终局名次指纹）必须逐位一致——证明计数器不改变任何决策；
 * 5. 测量节点扩展率与每决策节点数，输出 JSON 报告。
 *
 * 语义：node = 搜索中成功模拟一个行动产生一个后继状态的次数（beam 展开的
 * step() 成功调用 + rollout 步进的 step() 成功调用）。
 *
 * 注意：必须用冠军注册提交的源码（--ref 默认值），不能用 HEAD——已实测
 * HEAD 源码构建（含 beam-contest 等后续改动）在冠军决策路径上与冠军注册
 * 产物存在对局结果分歧（见基线报告 §4.3 漂移审计）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const WEB_V1 = join(REPO_ROOT, 'web-v1');
const PROBE_ROOT = join(tmpdir(), `century-search-probe-${process.pid}`);
const OUT_PATH = resolve(REPO_ROOT, 'training/reports/baseline-perf/search-probe.json');

/** 探针源码引用：默认冠军注册提交（与 provenance.engineBundleSha256 对应的源码）。 */
function championSourceRef() {
  const champion = JSON.parse(readFileSync(join(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
  return champion.provenance.codeCommit ?? 'HEAD';
}
const SOURCE_REF = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : championSourceRef();

/** 冠军参数版本（与训练模拟器同源：来自冻结 dist 的参数区）。 */
const { chooseAIAction, PROFILES, NEUTRAL_PROFILE } = await import(resolve(WEB_V1, 'dist/js/ai.js'));
const { createGame, applyAction, ranking, score } = await import(resolve(WEB_V1, 'dist/js/engine.js'));

const seatProfile = seat => seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];

/** 冻结 dist 的对局结果指纹（行为等价验证的基准）。 */
function frozenOutcomeKey(seed, seatCount) {
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed,
    Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  let moves = 0;
  while (game.phase !== 'finished') {
    const seat = game.current;
    const response = chooseAIAction(game, { profile: seatProfile(seat) });
    game = applyAction(game, response.action);
    moves += 1;
    if (moves > 1200) throw new Error(`frozen seed ${seed} 超出步数上限`);
  }
  const ranked = ranking(game);
  return JSON.stringify(ranked.map(p => [p.id, score(p), p.claimed.length]));
}

// ---------- 1. 从 SOURCE_REF 提取源码到临时目录（git archive，可审计、确定性） ----------
if (existsSync(PROBE_ROOT)) rmSync(PROBE_ROOT, { recursive: true, force: true });
mkdirSync(PROBE_ROOT, { recursive: true });
execSync(`git archive ${SOURCE_REF} web-v1 | tar -x --strip-components=1 -C "${PROBE_ROOT}"`, { cwd: REPO_ROOT });
symlinkSync(join(WEB_V1, 'node_modules'), join(PROBE_ROOT, 'node_modules'), 'dir');
console.log(`[probe] 源码已从 ${SOURCE_REF} 提取到临时目录：${PROBE_ROOT}`);

// ---------- 2. 打只读计数补丁 ----------
const plannerPath = join(PROBE_ROOT, 'src', 'ai', 'planner.ts');
let planner = readFileSync(plannerPath, 'utf8');
const patches = [];

// 补丁 1：模块级只读计数器（挂在 globalThis，诊断构建专用）。
{
  const anchor = `/** 主规划入口：只依赖 AIObservation 与参数集，不接触任何隐藏信息。`;
  if (!planner.includes(anchor)) throw new Error('补丁 1 锚点未命中');
  planner = planner.replace(anchor,
    `// PROBE-ONLY: 只读搜索计数器（诊断构建专用，绝不进入正式冠军产物；不影响任何决策）。\n` +
    `const __searchProbe = ((globalThis as any).__AI_SEARCH_PROBE__ ?? { nodes: 0, decisions: 0 });\n` +
    `(globalThis as any).__AI_SEARCH_PROBE__ = __searchProbe;\n\n` + anchor);
  patches.push('counter-init');
}
// 补丁 2：决策计数。
{
  const anchor = `  const structure = structureInput ?? 'beam-lineage';`;
  if (!planner.includes(anchor)) throw new Error('补丁 2 锚点未命中');
  planner = planner.replace(anchor, anchor + `\n  __searchProbe.decisions += 1;`);
  patches.push('decision-count');
}
// 补丁 3：beam 展开节点计数（step 成功 = 一个后继状态）。
{
  const anchor = `          const next = step(position, action, preferred, params);\n          if (!next) continue;`;
  if (!planner.includes(anchor)) throw new Error('补丁 3 锚点未命中');
  planner = planner.replace(anchor, anchor + `\n          __searchProbe.nodes += 1;`);
  patches.push('beam-node-count');
}
// 补丁 4：rollout 步进计数。
{
  const anchor = `          const next = step(cursor, pick, preferred, params);\n          if (!next) break;`;
  if (!planner.includes(anchor)) throw new Error('补丁 4 锚点未命中');
  planner = planner.replace(anchor, anchor + `\n          __searchProbe.nodes += 1;`);
  patches.push('rollout-node-count');
}
writeFileSync(plannerPath, planner);
console.log(`[probe] 已打补丁：${patches.join(', ')}`);

// ---------- 3. 构建（与正式构建同一工具链） ----------
execSync('npm run build', { cwd: PROBE_ROOT, stdio: 'pipe' });
const probeDist = join(PROBE_ROOT, 'dist', 'js');
if (!existsSync(join(probeDist, 'ai.js')) || !existsSync(join(probeDist, 'engine.js'))) {
  throw new Error('诊断构建未产出 dist/js（engine.js/ai.js 缺失）');
}
console.log('[probe] 诊断构建完成（临时目录，未触碰 web-v1/dist）');

// ---------- 4. 行为等价验证 + 5. 测量 ----------
const probeAi = await import(join(probeDist, 'ai.js'));
const probeEngine = await import(join(probeDist, 'engine.js'));
const probeStats = globalThis.__AI_SEARCH_PROBE__;
if (!probeStats) throw new Error('诊断构建未暴露 __AI_SEARCH_PROBE__（补丁失效）');

const SEEDS = [1_109_000_001, 1_109_000_002, 1_109_000_003, 1_109_000_004, 1_109_000_005];
const SEAT_COUNTS = [2, 3, 4, 5];

// 4a. 行为等价：冻结 dist vs 诊断构建，同种子同配置逐位一致。
const equivalence = [];
for (const seed of SEEDS.slice(0, 3)) {
  for (const seatCount of SEAT_COUNTS) {
    // 冻结 dist 指纹（主实例 = 正式产物）。
    const frozen = frozenOutcomeKey(seed, seatCount);
    // 诊断构建对局。
    let game = probeEngine.createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed,
      Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
    game.players[0].isAI = true;
    let moves = 0;
    while (game.phase !== 'finished') {
      const seat = game.current;
      const response = probeAi.chooseAIAction(game, { profile: seatProfile(seat) });
      game = probeEngine.applyAction(game, response.action);
      moves += 1;
      if (moves > 1200) throw new Error(`probe seed ${seed} 超出步数上限`);
    }
    const probeKey = JSON.stringify(probeEngine.ranking(game).map(p => [p.id, probeEngine.score(p), p.claimed.length]));
    equivalence.push({ seed, seatCount, identical: frozen === probeKey });
  }
}
const allIdentical = equivalence.every(e => e.identical);
console.log(`[probe] 行为等价验证：${equivalence.filter(e => e.identical).length}/${equivalence.length} 组逐位一致${allIdentical ? '' : ' —— 失败！'}`);
if (!allIdentical) {
  console.error(JSON.stringify(equivalence.filter(e => !e.identical), null, 2));
  throw new Error('诊断构建与冻结产物对局结果不一致——计数器改变了行为，测量无效');
}

// 4b. 决策级等价（参数注入路径）：冻结 vs 诊断在同一决策点的行动选择。
let decisionEquivalenceChecked = 0, decisionEquivalencePassed = 0;
{
  const seed = SEEDS[0];
  let gA = createGame(Array.from({ length: 5 }, (_, i) => `席位${i}`), seed, [1, 2, 3, 4]);
  gA.players[0].isAI = true;
  let gB = probeEngine.createGame(Array.from({ length: 5 }, (_, i) => `席位${i}`), seed, [1, 2, 3, 4]);
  gB.players[0].isAI = true;
  for (let i = 0; i < 60; i++) {
    if (gA.phase !== 'finished' && gB.phase !== 'finished') {
      const seat = gA.current;
      const a = chooseAIAction(gA, { profile: seatProfile(seat) });
      const b = probeAi.chooseAIAction(gB, { profile: seatProfile(seat) });
      decisionEquivalenceChecked += 1;
      if (JSON.stringify(a.action) === JSON.stringify(b.action)) decisionEquivalencePassed += 1;
      gA = applyAction(gA, a.action);
      gB = probeEngine.applyAction(gB, b.action);
    }
  }
  console.log(`[probe] 逐决策行动一致：${decisionEquivalencePassed}/${decisionEquivalenceChecked}`);
  if (decisionEquivalencePassed !== decisionEquivalenceChecked) {
    throw new Error('逐决策行动不一致——诊断构建行为偏移，测量无效');
  }
}

// 5. 测量：节点扩展率（重置计数器 → 计时跑局 → 读数）。
probeStats.nodes = 0;
probeStats.decisions = 0;
const perSeatCount = [];
for (const seatCount of SEAT_COUNTS) {
  probeStats.nodes = 0;
  probeStats.decisions = 0;
  const warm = 1;
  for (let i = 0; i < warm; i++) {
    let game = probeEngine.createGame(Array.from({ length: seatCount }, (_, s) => `席位${s}`), 1_109_009_000 + i,
      Array.from({ length: seatCount - 1 }, (_, s) => s + 1));
    game.players[0].isAI = true;
    while (game.phase !== 'finished') {
      const response = probeAi.chooseAIAction(game, { profile: seatProfile(game.current) });
      game = probeEngine.applyAction(game, response.action);
    }
  }
  probeStats.nodes = 0;
  probeStats.decisions = 0;
  const measured = 5;
  const t0 = performance.now();
  let moves = 0;
  for (let i = 0; i < measured; i++) {
    let game = probeEngine.createGame(Array.from({ length: seatCount }, (_, s) => `席位${s}`), 1_109_010_000 + i,
      Array.from({ length: seatCount - 1 }, (_, s) => s + 1));
    game.players[0].isAI = true;
    while (game.phase !== 'finished') {
      const response = probeAi.chooseAIAction(game, { profile: seatProfile(game.current) });
      game = probeEngine.applyAction(game, response.action);
      moves += 1;
    }
  }
  const wallMs = performance.now() - t0;
  perSeatCount.push({
    seatCount,
    measuredGames: measured,
    nodesExpanded: probeStats.nodes,
    decisions: probeStats.decisions,
    nodesPerDecision: Number((probeStats.nodes / Math.max(1, probeStats.decisions)).toFixed(1)),
    nodesExpandedPerSecond: Math.round(probeStats.nodes / (wallMs / 1000)),
    wallMs: Number(wallMs.toFixed(1)),
    moves,
    note: '含 applyAction 墙钟（AI 决策占比 99.8%，与 perf.json 口径一致）',
  });
  console.log(`[probe] N=${seatCount}: ${probeStats.nodes} nodes / ${probeStats.decisions} decisions → ${perSeatCount.at(-1).nodesExpandedPerSecond}/s`);
}

const result = {
  schema: 'century-search-probe-v1',
  measuredAt: new Date().toISOString(),
  method: 'diagnostic-build（git archive 冠军注册源码 → 只读计数补丁 → 构建 → 行为等价验证 → 测量；正式冻结产物零改动）',
  sourceRef: SOURCE_REF,
  patches,
  behaviorEquivalence: {
    gameOutcomeIdentical: allIdentical,
    checks: equivalence.length,
    perDecisionActionIdentical: `${decisionEquivalencePassed}/${decisionEquivalenceChecked}`,
  },
  nodeDefinition: '成功模拟一个行动产生一个后继状态的次数（beam 展开 step() + rollout 步进 step()）',
  probeSourceCommit: execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim(),
  frozenBundleSha256Note: '正式冻结产物仍为 c1dd8272…（champion-freeze.json），本探针不改变也不替代它',
  perSeatCount,
};

mkdirSync(resolve(OUT_PATH, '..'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + '\n');
rmSync(PROBE_ROOT, { recursive: true, force: true });
console.log(`[probe] 完成，结果写入 ${OUT_PATH}（临时目录已清理）`);
