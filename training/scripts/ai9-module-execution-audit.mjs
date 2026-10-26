#!/usr/bin/env node
/** AI9 模块执行审计：在真实规则引擎对局中统计每个可进化钩子的调用次数。
 *
 * 方法：把官方 dist 复制到临时目录，仅在临时副本的 12 个钩子函数入口插入
 * 计数器（不改官方源码/构建，也不改候选产物），然后用该副本完整运行
 * 2–5 人真实对局（普通 AI 路径 + 冠军引导联合搜索路径），统计调用次数。
 *
 * 目的：证明“注册成功但真实对局从未使用”的模块不存在。
 * 这是执行证据，不是强度/胜率证据。
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { seatProfile } from '../simulator/simulate.mjs';

const OUT = resolve(REPO_ROOT, 'training/reports/ai9/module-execution-audit.json');
const TARGETS = {
  'ai/evolve/modules.js': {
    M01: 'goalPriority', M05: 'restMultiplier', M06: 'endgameBonus',
    M07: 'opponentPressureDelta', M08: 'seatContestFactor', M09: 'unknownSupportFactor',
    M10: 'rankRootActions', M11: 'searchPolicyOverrides', M12: 'budgetForDecision',
  },
  'ai/evaluator.js': { M02: 'acquisitionValue', M04: 'keepValue' },
  'ai/knowledge.js': { M03: 'cardEngineValue' },
};
const AI_MODULES = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09'];
const JOINT_MODULES = ['M10', 'M11', 'M12'];
const AI_CASES = [
  { seatCount: 2, seed: 1_640_000_021 },
  { seatCount: 3, seed: 1_640_000_022 },
  { seatCount: 4, seed: 1_640_000_023 },
  { seatCount: 5, seed: 1_640_000_024 },
];
const JOINT_CASES = [
  { seatCount: 2, seed: 1_640_000_031 },
  { seatCount: 3, seed: 1_640_000_032 },
  { seatCount: 4, seed: 1_640_000_033 },
  { seatCount: 5, seed: 1_640_000_034 },
];
const MAX_MOVES = 600;

function instrument(source, functionName, moduleId) {
  const declaration = `function ${functionName}(`;
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`未找到函数 ${functionName}`);
  let index = source.indexOf('(', start);
  let depth = 0;
  for (; index < source.length; index++) {
    const ch = source[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) { index += 1; break; }
    }
  }
  const brace = source.indexOf('{', index);
  if (brace < 0) throw new Error(`${functionName} 缺少函数体`);
  const statement = `globalThis.__AI9_CALLS["${moduleId}"]=(globalThis.__AI9_CALLS["${moduleId}"]||0)+1;`;
  return source.slice(0, brace + 1) + statement + source.slice(brace + 1);
}

function prepareInstrumentedDist() {
  const root = mkdtempSync(join(tmpdir(), 'ai9-exec-audit-'));
  const dist = join(root, 'dist');
  cpSync(resolve(REPO_ROOT, 'web-v1/dist/js'), join(dist, 'js'), { recursive: true });
  for (const [file, functions] of Object.entries(TARGETS)) {
    const path = join(dist, 'js', file);
    let source = readFileSync(path, 'utf8');
    for (const [moduleId, functionName] of Object.entries(functions)) {
      source = instrument(source, functionName, moduleId);
    }
    writeFileSync(path, source);
  }
  return root;
}

function makeGame(engine, seatCount, seed) {
  const names = Array.from({ length: seatCount }, (_, i) => `S${i}`);
  const game = engine.createGame(names, seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players.forEach(player => { player.isAI = true; });
  return game;
}

function championParameters() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8')).parameters;
}

function snapshot() {
  const counts = globalThis.__AI9_CALLS ?? {};
  const result = {};
  for (const id of [...AI_MODULES, ...JOINT_MODULES]) result[id] = counts[id] ?? 0;
  return result;
}

async function main() {
  const root = prepareInstrumentedDist();
  try {
    globalThis.__AI9_CALLS = {};
    const base = pathToFileURL(join(root, 'dist/js') + '/');
    const ai = await import(new URL('ai.js', base).href);
    const adapter = await import(new URL('js/adapter.js', base).href);
    const engine = await import(new URL('engine.js', base).href);
    const champion = championParameters();
    globalThis.__AI9_CALLS = {};

    let aiGames = 0;
    let aiDecisions = 0;
    for (const { seatCount, seed } of AI_CASES) {
      let game = makeGame(engine, seatCount, seed);
      let moves = 0;
      while (game.phase !== 'finished' && moves < MAX_MOVES) {
        const seat = game.current;
        const response = ai.chooseAIAction(game, {
          parameters: champion, profile: seatProfile(seat),
        });
        game = engine.applyAction(game, response.action);
        moves += 1;
        aiDecisions += 1;
      }
      if (game.phase === 'finished') aiGames += 1;
    }
    const aiPath = { games: aiGames, decisions: aiDecisions, counts: snapshot() };

    globalThis.__AI9_CALLS = {};
    let jointGames = 0;
    let jointDecisions = 0;
    for (const { seatCount, seed } of JOINT_CASES) {
      let game = makeGame(engine, seatCount, seed);
      let moves = 0;
      while (game.phase !== 'finished' && moves < MAX_MOVES) {
        const seat = game.current;
        const response = seat === 0
          ? adapter.chooseJointAction(game, {
              version: 'joint-js5',
              championParameters: champion,
              budgetMs: 100,
              profile: seatProfile(seat),
            })
          : ai.chooseAIAction(game, { parameters: champion, profile: seatProfile(seat) });
        game = engine.applyAction(game, response.action);
        moves += 1;
        jointDecisions += 1;
      }
      if (game.phase === 'finished') jointGames += 1;
    }
    const jointPath = { games: jointGames, decisions: jointDecisions, counts: snapshot() };

    const modules = [...AI_MODULES, ...JOINT_MODULES].map(id => {
      const expectedPath = AI_MODULES.includes(id) ? 'chooseAIAction' : 'chooseJointAction';
      const counts = { ai: aiPath.counts[id] ?? 0, joint: jointPath.counts[id] ?? 0 };
      const total = counts.ai + counts.joint;
      return { id, expectedPath, counts, total, status: total > 0 ? 'EXECUTED' : 'NEVER-CALLED' };
    });
    const report = {
      schema: 'century-ai9-module-execution-audit-v1',
      generatedAt: new Date().toISOString(),
      method: 'instrumented-copy-of-official-dist (official source/build untouched)',
      seedNote: '未分配评测块，仅作执行接线审计',
      cases: { ai: AI_CASES, joint: JOINT_CASES },
      aiPath,
      jointPath,
      modules,
      summary: {
        total: modules.length,
        executed: modules.filter(m => m.status === 'EXECUTED').length,
        neverCalled: modules.filter(m => m.status !== 'EXECUTED').map(m => m.id),
      },
    };
    writeJSON(OUT, report);
    console.log(JSON.stringify({
      outPath: OUT,
      aiGames, aiDecisions, jointGames, jointDecisions,
      counts: Object.fromEntries(modules.map(m => [m.id, m.counts])),
      summary: report.summary,
    }, null, 2));
    if (report.summary.neverCalled.length) process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`执行审计失败：${error.stack ?? error.message}`);
  process.exit(1);
});
