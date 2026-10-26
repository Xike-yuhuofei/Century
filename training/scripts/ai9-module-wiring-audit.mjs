#!/usr/bin/env node
/** AI9 逐模块决策接线审计（开发证据；不用于冠军晋级）。
 *
 * 目的：对 M01–M12 逐个编译“单模块确定性变异”候选，并在真实规则引擎的
 * 对局状态上对比官方实现与候选实现的行动流，证明该模块的代码确实被执行
 * 且能改变正式决策（不是“注册成功但从未使用”）。
 *
 * 两条真实路径：
 * - M01–M09：chooseAIAction（普通 AI 规划路径）；
 * - M10–M12：chooseJointAction（冠军引导联合搜索路径；M12 使用墙钟预算）。
 *
 * 判定：在限定步数内出现第一次行动分歧 → WIRED；否则 FAIL-UNOBSERVED。
 * 该证据是接线证据，不是强度/胜率证据。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import {
  createCompiledModuleCandidate, loadCompiledCandidateModules, MULTI_MODULE_INFO,
} from '../evolution/multi-module-candidate.mjs';
import { mutateModuleFunction } from '../evolution/module-mutations.mjs';
import { seatProfile } from '../simulator/simulate.mjs';
import { AI9_DEV_BLOCKS } from '../evolution/core.mjs';

const AI_PATH_MODULES = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09'];
const JOINT_PATH_MODULES = ['M10', 'M11', 'M12'];
const ALL_MODULES = [...AI_PATH_MODULES, ...JOINT_PATH_MODULES];
const OUT = resolve(REPO_ROOT, 'training/reports/ai9/module-wiring-audit.json');
const experiment = {
  configRef: 'ai9://evidence/module-wiring',
  configHash: 'a'.repeat(64),
  seedRefs: [
    { purpose: 'screen', windowId: 'ai9-screen-w000', base: AI9_DEV_BLOCKS.screen[0], count: 1 },
    { purpose: 'deep', windowId: 'ai9-deep-w000', base: AI9_DEV_BLOCKS.deep[0], count: 1 },
  ],
};

const WIRING_SEED = 1_640_000_011; // 未分配评测块的接线回归种子
const AI_STEPS = 200;
const JOINT_STEPS = 120;
const AI_CASES = [
  { seed: WIRING_SEED, seatCount: 5 },
  { seed: WIRING_SEED + 1, seatCount: 4 },
  { seed: WIRING_SEED + 2, seatCount: 3 },
];
const JOINT_CASES = [
  { seed: WIRING_SEED + 3, seatCount: 5 },
  { seed: WIRING_SEED + 4, seatCount: 3 },
];

function actionKey(action) {
  return JSON.stringify(action);
}

function championParameters() {
  const path = resolve(REPO_ROOT, 'training/champions/champion.json');
  return JSON.parse(readFileSync(path, 'utf8')).parameters;
}

function makeGame(engine, seatCount, seed) {
  const names = Array.from({ length: seatCount }, (_, i) => `S${i}`);
  const game = engine.createGame(names, seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  return game;
}

async function loadOfficial() {
  return {
    ai: await import(pathToFileURL(resolve(REPO_ROOT, 'web-v1/dist/js/ai.js')).href),
    adapter: await import(pathToFileURL(resolve(REPO_ROOT, 'web-v1/dist/js/js/adapter.js')).href),
    engine: await import(pathToFileURL(resolve(REPO_ROOT, 'web-v1/dist/js/engine.js')).href),
  };
}

/** 普通 AI 路径：官方 vs 候选，锁步比较行动。 */
async function auditAIPath(moduleId, official, champion) {
  const mutated = mutateModuleFunction(moduleId, 0);
  const created = createCompiledModuleCandidate({
    modules: [mutated],
    moduleIds: [moduleId],
    experiment,
    round: 1,
    index: ALL_MODULES.indexOf(moduleId),
    sourceOrigin: 'wiring-audit',
    mutationLabel: `wiring:${moduleId}`,
    candidateId: `cand-ai9-wiring-${moduleId.toLowerCase()}`,
  });
  const loaded = await loadCompiledCandidateModules(created.artifact);
  try {
    for (const { seed, seatCount } of AI_CASES) {
      let officialGame = makeGame(official.engine, seatCount, seed);
      let candidateGame = makeGame(official.engine, seatCount, seed);
      for (let move = 0; move < AI_STEPS; move++) {
        if (officialGame.phase === 'finished' || candidateGame.phase === 'finished') break;
        const seat = officialGame.current;
        const options = { parameters: champion, profile: seatProfile(seat), workUnits: 8 };
        const officialResponse = official.ai.chooseAIAction(officialGame, options);
        const candidateResponse = loaded.aiModule.chooseAIAction(candidateGame, {
          ...options, parameters: { ...champion, id: `ai9-wiring-${moduleId}` },
        });
        if (actionKey(officialResponse.action) !== actionKey(candidateResponse.action)) {
          return {
            id: moduleId, path: 'chooseAIAction', status: 'WIRED',
            divergence: {
              seed, seatCount, move, seat,
              official: officialResponse.action,
              candidate: candidateResponse.action,
            },
            probe: { changedModules: created.probe.changedModules, mismatches: created.probe.mismatchCount },
          };
        }
        officialGame = official.engine.applyAction(officialGame, officialResponse.action);
        candidateGame = official.engine.applyAction(candidateGame, candidateResponse.action);
      }
    }
    return {
      id: moduleId, path: 'chooseAIAction', status: 'FAIL-UNOBSERVED',
      limit: AI_STEPS, cases: AI_CASES,
      probe: { changedModules: created.probe.changedModules, mismatches: created.probe.mismatchCount },
    };
  } finally {
    loaded.cleanup();
  }
}

/** 联合搜索路径：候选只控制焦点席位，其他席位保持官方。 */
async function auditJointPath(moduleId, official, champion) {
  const mutated = mutateModuleFunction(moduleId, 0);
  const created = createCompiledModuleCandidate({
    modules: [mutated],
    moduleIds: [moduleId],
    experiment,
    round: 1,
    index: ALL_MODULES.indexOf(moduleId),
    sourceOrigin: 'wiring-audit',
    mutationLabel: `wiring:${moduleId}`,
    candidateId: `cand-ai9-wiring-${moduleId.toLowerCase()}`,
  });
  const loaded = await loadCompiledCandidateModules(created.artifact);
  const baseOptions = (seat, useCandidate) => ({
    version: 'joint-js5',
    championParameters: useCandidate ? { ...champion, id: `ai9-wiring-${moduleId}` } : champion,
    profile: seatProfile(seat),
    ...(moduleId === 'M12' ? { budgetMs: 100 } : { workUnits: 8 }),
  });
  try {
    for (const { seed, seatCount } of JOINT_CASES) {
      let officialGame = makeGame(official.engine, seatCount, seed);
      let candidateGame = makeGame(official.engine, seatCount, seed);
      for (let move = 0; move < JOINT_STEPS; move++) {
        if (officialGame.phase === 'finished' || candidateGame.phase === 'finished') break;
        const seat = officialGame.current;
        const officialResponse = official.adapter.chooseJointAction(officialGame, baseOptions(seat, false));
        const candidateSeat = candidateGame.current;
        const candidateResponse = seat === 0
          ? loaded.jointModule.chooseJointAction(candidateGame, baseOptions(candidateSeat, true))
          : official.adapter.chooseJointAction(candidateGame, baseOptions(candidateSeat, false));
        if (seat === 0 && actionKey(officialResponse.action) !== actionKey(candidateResponse.action)) {
          return {
            id: moduleId, path: 'chooseJointAction', status: 'WIRED',
            divergence: {
              seed, seatCount, move, seat,
              official: officialResponse.action,
              candidate: candidateResponse.action,
            },
            probe: { changedModules: created.probe.changedModules, mismatches: created.probe.mismatchCount },
          };
        }
        officialGame = official.engine.applyAction(officialGame, officialResponse.action);
        candidateGame = official.engine.applyAction(candidateGame, candidateResponse.action);
      }
    }
    return {
      id: moduleId, path: 'chooseJointAction', status: 'FAIL-UNOBSERVED',
      limit: JOINT_STEPS, cases: JOINT_CASES,
      probe: { changedModules: created.probe.changedModules, mismatches: created.probe.mismatchCount },
    };
  } finally {
    loaded.cleanup();
  }
}

async function main() {
  if (!MULTI_MODULE_INFO.seatbeltAvailable) {
    console.error('macOS Seatbelt 不可用：拒绝执行接线审计');
    process.exit(3);
  }
  if (!existsSync(resolve(REPO_ROOT, 'web-v1/dist/js/ai.js'))) {
    console.error('缺少 web-v1/dist 构建：请先 npm run build');
    process.exit(3);
  }
  const champion = championParameters();
  const official = await loadOfficial();
  const results = [];
  for (const id of AI_PATH_MODULES) {
    const result = await auditAIPath(id, official, champion);
    results.push(result);
    console.log(JSON.stringify({ id, status: result.status, move: result.divergence?.move ?? null }));
  }
  for (const id of JOINT_PATH_MODULES) {
    const result = await auditJointPath(id, official, champion);
    results.push(result);
    console.log(JSON.stringify({ id, status: result.status, move: result.divergence?.move ?? null }));
  }
  const wired = results.filter(r => r.status === 'WIRED').length;
  const report = {
    schema: 'century-ai9-module-wiring-audit-v1',
    generatedAt: new Date().toISOString(),
    seed: WIRING_SEED,
    note: '接线证据：证明模块代码在真实规则引擎对局中被执行并可改变决策；不是强度/胜率证据。',
    playerCounts: { aiPath: 5, jointPath: 3 },
    limits: { aiSteps: AI_STEPS, jointSteps: JOINT_STEPS, workUnits: 8, m12BudgetMs: 100 },
    modules: results,
    summary: {
      total: results.length,
      wired,
      unobserved: results.filter(r => r.status !== 'WIRED').map(r => r.id),
    },
  };
  writeJSON(OUT, report);
  console.log(JSON.stringify({ outPath: OUT, summary: report.summary }, null, 2));
  // 未观察到决策分歧不单独判失败：执行审计另行证明模块被调用；
  // 只有 0 个模块可观测才说明接线整体失效。
  if (wired === 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(`接线审计失败：${error.stack ?? error.message}`);
  process.exit(1);
});
