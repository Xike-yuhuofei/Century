/** 编译型候选：真实的静态检查 → 独立 tsc 编译 → Seatbelt 探针。
 *
 * 本轮只启用一个有界函数：acquisitionValue 的 baseline 函数体，仅调整
 * goalFit 系数（2.0 → 2.4）。它证明候选可以脱离人工搬运，经过：
 *   EVOLVE-BLOCK 包装 → AI5 static_check（沙箱）→ assemble（沙箱）
 *   → tsc（沙箱）→ 编译产物哈希 → artifact 注册。
 *
 * 纪律：
 * - 源码来自官方 evaluator.ts 的 acquisitionValue 函数，只做单点有界变异；
 * - 不修改官方源码/冠军产物；编译在独立工作目录完成；
 * - 非 macOS / Seatbelt 不可用时 fail closed，不做无沙箱执行；
 * - 探针只读取公开 fixture，不接触隐藏牌库/种子。
 */

import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCandidateArtifact } from './candidate-artifact.mjs';
import { getTarget } from './evolution-targets.mjs';
import {
  SCHEMAS, assertCondition, gameRulesDescriptor, sha256Canonical, sha256Hex, shortHash,
} from './core.mjs';
import { REPO_ROOT, SEATBELT_AVAILABLE, runNodeSeatbelt } from './sandbox/seatbelt.mjs';

export const COMPILED_TARGET_ID = 'acquisitionValue';
export const COMPILED_SOURCE_PATH = 'src/ai/evaluator.acquisitionValue.fn.ts';
const OFFICIAL_SRC = resolve(REPO_ROOT, 'web-v1/src/ai/evaluator.ts');
const OFFICIAL_DIST = resolve(REPO_ROOT, 'web-v1/dist/js');
const STATIC_CHECK = resolve(REPO_ROOT, 'ai5/openevolve/node/static_check.mjs');
const ASSEMBLE = resolve(REPO_ROOT, 'ai5/openevolve/node/assemble_candidate.mjs');
const TSC = resolve(REPO_ROOT, 'web-v1/node_modules/typescript/bin/tsc');
const TSC_PACKAGE = resolve(REPO_ROOT, 'web-v1/node_modules/typescript/package.json');
const PROBE = resolve(REPO_ROOT, 'training/evolution/sandbox/probe_compiled.mjs');

let tscVersionCache = null;
/** 延迟读取 tsc 版本：没有 web-v1 node_modules 时也不影响非编译路径的导入。 */
function readTscVersion() {
  if (!tscVersionCache) {
    tscVersionCache = JSON.parse(readFileSync(TSC_PACKAGE, 'utf8')).version;
  }
  return tscVersionCache;
}

/** 与 AI5 assemble 相同的字符串/注释剥离，用于定位官方函数。 */
function stripLiterals(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += ' '; i++; continue; }
      if (c === '"') { mode = 'dq'; out += ' '; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } else out += ' '; i++; continue; }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; out += '  '; i += 2; } else { out += c === '\n' ? c : ' '; i++; }
      continue;
    }
    if (mode === 'sq') { if (c === '\\') { out += '  '; i += 2; } else if (c === "'") { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
    if (mode === 'dq') { if (c === '\\') { out += '  '; i += 2; } else if (c === '"') { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
    if (mode === 'tpl') { if (c === '\\') { out += '  '; i += 2; } else if (c === '`') { mode = 'code'; out += ' '; i++; } else { out += ' '; i++; } continue; }
  }
  return out;
}

function extractBaselineFunction() {
  const original = readFileSync(OFFICIAL_SRC, 'utf8');
  const stripped = stripLiterals(original);
  const match = stripped.match(/export\s+function\s+acquisitionValue\s*\(/);
  assertCondition(match, '官方 evaluator.ts 中未找到 acquisitionValue');
  const stack = [];
  let end = -1;
  for (let i = match.index; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      const open = stack.pop();
      const expected = c === '}' ? '{' : c === ')' ? '(' : '[';
      assertCondition(open === expected, `官方 acquisitionValue 括号错配（偏移 ${i - match.index}）`);
      if (stack.length === 0 && c === '}') { end = i + 1; break; }
    }
  }
  assertCondition(end > 0, '官方 acquisitionValue 括号不配平');
  return original.slice(match.index, end);
}

/** 单点有界变异：goalFit 权重 2.0 → 2.4（仅 baseline 分支）。 */
export function mutateBaselineFunction(functionText) {
  const needle = 'goalFit * 2 * params.goalWeight';
  const occurrences = functionText.split(needle).length - 1;
  assertCondition(occurrences === 1,
    `goalFit 变异点不唯一（期望 1，实际 ${occurrences}）——官方函数结构变更，拒绝静默变异`);
  return functionText.replace(needle, 'goalFit * 2.4 * params.goalWeight');
}

function programWithMarkers(functionText) {
  return `/* EVOLVE-BLOCK-START */\n${functionText}\n/* EVOLVE-BLOCK-END */\n`;
}

function cleanup(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* 临时目录清理失败不阻断 */ }
}

/**
 * 编译候选并创建 artifact。
 * @param {object} options
 * @param {object} options.experiment
 * @param {number} [options.round]
 * @param {number} [options.index]
 * @param {string|null} [options.candidateId]
 * @param {string|null} [options.parentId]
 */
export function createCompiledAcquisitionCandidate({
  experiment, round = 1, index = 0, candidateId = null, parentId = null,
}) {
  assertCondition(SEATBELT_AVAILABLE, 'Seatbelt 不可用——拒绝创建编译型候选（不做无沙箱编译）');
  assertCondition(existsSync(TSC), `tsc 不存在：${TSC}`);
  assertCondition(experiment && typeof experiment === 'object', '编译型候选必须提供 experiment 引用');
  const tscVersion = readTscVersion();

  const baselineText = extractBaselineFunction();
  const mutatedText = mutateBaselineFunction(baselineText);
  const programText = programWithMarkers(mutatedText);
  const functionSha256 = sha256Hex(mutatedText);
  const id = candidateId ?? `cand-ai7-compiled-acq-r${round}c${index}-${shortHash(sha256Canonical({ programText, round, index }), 6)}`;

  const workRoot = mkdtempSync(join(tmpdir(), 'ai7-compiled-'));
  const buildDir = join(workRoot, 'candidate');
  const programPath = join(workRoot, 'program.fn.ts');
  const staticJson = join(workRoot, 'static.json');
  writeFileSync(programPath, programText);

  try {
    const staticRun = runNodeSeatbelt({
      workRoot, script: STATIC_CHECK,
      args: ['--program', programPath, '--out', staticJson], timeoutMs: 60_000,
    });
    assertCondition(staticRun.ok, `静态检查失败：${staticRun.stderr.slice(-600)}`);

    const fnPath = staticJson.replace(/\.json$/, '.fn.ts');
    assertCondition(existsSync(fnPath), '静态检查未产出函数文本');

    const assemble = runNodeSeatbelt({
      workRoot, script: ASSEMBLE,
      args: ['--program', fnPath, '--out', buildDir], timeoutMs: 120_000,
    });
    assertCondition(assemble.ok, `源码树组装失败：${assemble.stderr.slice(-800)}`);

    // 独立构建目录没有 package.json 时 tsc 按 CommonJS 产出；写入 type=module
    // 使产物与官方 web-v1 一致为 ESM，兑现 artifact 的 esm-module-bundle 语义。
    writeFileSync(join(buildDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

    const compile = runNodeSeatbelt({
      workRoot, script: TSC, args: ['-p', join(buildDir, 'tsconfig.json')],
      timeoutMs: 180_000, cwd: buildDir,
    });
    assertCondition(compile.ok, `tsc 编译失败：${(compile.stderr || compile.stdout).slice(-800)}`);

    const compiledPath = join(buildDir, 'dist/js/ai/evaluator.js');
    assertCondition(existsSync(compiledPath), 'tsc 成功但未产出候选 evaluator.js');
    const compiledContent = readFileSync(compiledPath, 'utf8');
    const compiledSha256 = sha256Hex(compiledContent);

    const artifact = createCandidateArtifact({
      candidateId: id,
      parentId,
      algorithmStructure: {
        targetIds: [COMPILED_TARGET_ID],
        decisionCore: 'plugin-only',
        adapter: null,
        structure: 'compiled-acquisition-goalfit-2.4',
        jointVersion: null,
        evaluationMode: 'proxy',
        jointOptionsByPlayerCount: null,
        integration: 'candidate-plugin-only',
      },
      parameters: {
        id,
        version: 1,
        values: {
          kind: 'compiled-acquisition-v1',
          mutation: 'goalFit-weight-2.4',
          baselineVariant: 'baseline',
          functionSha256,
        },
        boundsVersion: 'compiled-module-v1',
      },
      source: {
        kind: 'esm-module-bundle',
        entry: COMPILED_SOURCE_PATH,
        files: [{ path: COMPILED_SOURCE_PATH, content: programText }],
      },
      experiment,
      applicablePlayerCounts: [2, 3, 4, 5],
      safety: { status: 'pending', checks: [] },
      buildInput: {
        kind: 'esm-module-bundle-v1',
        compiler: `tsc ${tscVersion}`,
        files: [{ path: 'dist/js/ai/evaluator.js', content: compiledContent }],
      },
      gameRules: gameRulesDescriptor(),
    });

    return {
      artifact,
      targetValues: artifact.parameters.values,
      evaluationMode: 'proxy',
      buildLog: {
        compiler: `tsc ${tscVersion}`,
        functionSha256,
        compiledSha256,
        compiledBytes: compiledContent.length,
        sourceBytes: programText.length,
        sandbox: 'macos-seatbelt',
      },
    };
  } finally {
    cleanup(workRoot);
  }
}

/** 公开 fixture → acquisitionValue 参数列表。 */
function acquisitionFixtures() {
  const target = getTarget(COMPILED_TARGET_ID);
  const params = {
    id: 'ai7-probe', engineWeight: 1, tempoWeight: 1, contestWeight: 1,
    synergyWeight: 1, goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
    acquisitionVariant: 'baseline',
  };
  return target.fixtures.map((fixture, i) => {
    const input = fixture.input;
    return {
      id: fixture.name ?? `fixture-${i}`,
      args: [
        { stock: input.stock, hand: input.hand, played: input.played },
        input.cardId,
        input.preferred ?? null,
        input.profile,
        input.pressure,
        params,
      ],
    };
  });
}

/** 将 artifact 内的编译产物与官方 dist 组合，在 Seatbelt 内运行探针。 */
export function probeCompiledCandidate({ artifact, round = 1 }) {
  assertCondition(artifact.algorithmStructure.targetIds.includes(COMPILED_TARGET_ID),
    '编译型探针只支持 acquisitionValue');
  assertCondition(artifact.buildArtifact?.compiled === true, '候选不是编译型 artifact');
  const compiled = (artifact.buildArtifact.files ?? []).find(f => f.path.endsWith('ai/evaluator.js'));
  assertCondition(compiled, '编译产物缺少 ai/evaluator.js');

  const workRoot = mkdtempSync(join(tmpdir(), 'ai7-probe-'));
  try {
    cpSync(OFFICIAL_DIST, join(workRoot, 'dist/js'), { recursive: true });
    writeFileSync(join(workRoot, 'dist/js/ai/evaluator.js'), compiled.content, 'utf8');
    const fixturesPath = join(workRoot, 'fixtures.json');
    const outPath = join(workRoot, 'probe.json');
    writeFileSync(fixturesPath, JSON.stringify(acquisitionFixtures(), null, 2));
    const probe = runNodeSeatbelt({
      workRoot,
      script: PROBE,
      args: [
        '--candidate', join(workRoot, 'dist/js/ai/evaluator.js'),
        '--fixtures', fixturesPath, '--out', outPath,
      ],
      timeoutMs: 120_000,
    });
    assertCondition(existsSync(outPath), `探针未产出结果（status=${probe.status}）：${probe.stderr.slice(-600)}`);
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    assertCondition(probe.ok, `编译型探针失败（probeErrors=${result.probeErrors}）：${probe.stderr.slice(-600)}`);
    assertCondition(result.probeErrors === 0 && result.pairs > 0, '编译型探针存在调用错误或没有有效配对');
    return result;
  } finally {
    cleanup(workRoot);
  }
}

/** 编译型候选的离线证据（不冒充对局强度）。 */
export function evaluateCompiledProxy({ artifact, round = 1 }) {
  const probe = probeCompiledCandidate({ artifact, round });
  const values = probe.rows.map(row => Number((row.candidate ?? 0).toFixed(6)));
  const behaviorSignature = {
    kind: 'compiled-acquisition-v1',
    targetId: COMPILED_TARGET_ID,
    values,
    mismatchCount: probe.mismatchCount,
  };
  const metrics = {
    evidenceType: 'offline-proxy',
    moduleForm: 'compiled-esm',
    sandbox: 'macos-seatbelt',
    totalGames: 0,
    fixtures: probe.cases,
    probeErrors: probe.probeErrors,
    mismatchCount: probe.mismatchCount,
    fallbackCount: probe.probeErrors,
    fallbackRate: probe.cases ? Number((probe.probeErrors / probe.cases).toFixed(4)) : 0,
    proxyDelta: probe.meanSignedDelta,
    meanAbsDelta: probe.meanAbsDelta,
    maxAbsDelta: probe.maxAbsDelta,
    productionWiring: 'not-wired',
    targetId: COMPILED_TARGET_ID,
  };
  return {
    schema: SCHEMAS.evaluationEvidence,
    candidateId: artifact.candidateId,
    identityDigest: artifact.identityDigest,
    evaluationMode: 'proxy',
    purpose: 'proxy',
    round,
    seedWindow: null,
    opponentPolicy: null,
    metrics,
    behaviorSignature,
    behaviorHash: sha256Canonical(behaviorSignature),
    probe,
  };
}

export const COMPILED_CANDIDATE_INFO = Object.freeze({
  targetId: COMPILED_TARGET_ID,
  sourcePath: COMPILED_SOURCE_PATH,
  compiler: 'tsc (web-v1 node_modules)',
  sandbox: 'macos-seatbelt',
  seatbeltAvailable: SEATBELT_AVAILABLE,
});
