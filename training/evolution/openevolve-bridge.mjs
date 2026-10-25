/** P1：OpenEvolve 真实运行桥（LLM 离线研发 → 编译型 Candidate Artifact）。
 *
 * 纪律：
 * - 只有真实启动 OpenEvolve（codex CLI / ChatGPT 登录）并读到 best_program 时，
 *   才允许标记 generator='openevolve-llm'；
 * - OpenEvolve 不可用/失败时返回 available:false + reason，调用方必须显式选择
 *   deterministic-bounded-mutation 或安全停止，不得伪装成 OpenEvolve 成功；
 * - LLM 只参与离线研发；最终游戏推理完全本地离线，不调用任何 API。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { sha256Hex } from './core.mjs';
import { createCompiledAcquisitionCandidate } from './compiled-candidate.mjs';

const OPENEVOLVE_ROOT = resolve(REPO_ROOT, 'ai5/openevolve');
const VENV_PYTHON = resolve(OPENEVOLVE_ROOT, '.venv/bin/python');
const RUNNER = resolve(OPENEVOLVE_ROOT, 'run_openevolve.py');
const PROGRAM = resolve(OPENEVOLVE_ROOT, 'program/acquisition_value.ts');
const EVALUATOR = resolve(OPENEVOLVE_ROOT, 'century_evaluator.py');
const CONFIG = resolve(OPENEVOLVE_ROOT, 'config.yaml');

/** 探测运行条件（不产生任何副作用）。 */
export function probeOpenEvolve() {
  const checks = [];
  const add = (id, pass, evidence) => checks.push({ id, status: pass ? 'PASS' : 'BLOCKED', evidence });
  add('venv-python', existsSync(VENV_PYTHON), VENV_PYTHON);
  add('runner', existsSync(RUNNER), RUNNER);
  add('program', existsSync(PROGRAM), PROGRAM);
  add('evaluator', existsSync(EVALUATOR), EVALUATOR);
  let codex = null;
  let codexOk = false;
  try {
    const result = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 30_000 });
    codex = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || result.error?.message || '';
    codexOk = result.status === 0 && /Logged in using ChatGPT/i.test(codex);
  } catch (error) {
    codex = String(error.message).slice(0, 300);
  }
  add('codex-login', codexOk, codex.split('\n')[0] ?? '');
  const blocked = checks.filter(c => c.status !== 'PASS');
  return {
    available: blocked.length === 0,
    checks,
    blocked: blocked.map(c => c.id),
    generator: 'openevolve-llm',
  };
}

/**
 * 运行真实 OpenEvolve（LLM 生成 + 级联评估）。可能运行数分钟到数小时。
 *
 * @param {object} options
 * @param {number} [options.iterations]
 * @param {string} [options.outputDir]
 * @param {number} [options.timeoutMs]
 */
export function runOpenEvolve({ iterations = 2, outputDir = null, timeoutMs = 3_600_000 } = {}) {
  const probe = probeOpenEvolve();
  if (!probe.available) {
    return { available: false, reason: `OpenEvolve 不可用：${probe.blocked.join(', ')}`, probe };
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`iterations 非法：${iterations}`);
  const outDir = outputDir
    ? resolve(process.cwd(), outputDir)
    : resolve(OPENEVOLVE_ROOT, 'results', `ai8-openevolve-${Date.now()}`);
  const args = [
    RUNNER, PROGRAM, EVALUATOR,
    '--config', CONFIG,
    '--iterations', String(iterations),
    '--output', outDir,
  ];
  const started = Date.now();
  const result = spawnSync(VENV_PYTHON, args, {
    cwd: OPENEVOLVE_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const elapsedMs = Date.now() - started;
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const bestPath = resolve(outDir, 'best/best_program.ts');
  const infoPath = resolve(outDir, 'best/best_program_info.json');
  const ok = result.status === 0 && existsSync(bestPath);
  return {
    available: true,
    ok,
    status: result.status,
    signal: result.signal ?? null,
    elapsedMs,
    outputDir: outDir,
    bestProgramPath: existsSync(bestPath) ? bestPath : null,
    bestProgramInfoPath: existsSync(infoPath) ? infoPath : null,
    logTail: log.slice(-4000),
    generator: 'openevolve-llm',
  };
}

/** 读取 OpenEvolve best program（真实 LLM 产物）并提取 EVOLVE-BLOCK 内的函数。 */
export function loadOpenEvolveBestProgram({ outputDir }) {
  const bestPath = resolve(outputDir, 'best/best_program.ts');
  const infoPath = resolve(outputDir, 'best/best_program_info.json');
  if (!existsSync(bestPath)) {
    return { available: false, reason: `best_program.ts 不存在：${bestPath}` };
  }
  const text = readFileSync(bestPath, 'utf8');
  const start = text.indexOf('/* EVOLVE-BLOCK-START */');
  const end = text.indexOf('/* EVOLVE-BLOCK-END */');
  if (start < 0 || end <= start) {
    return { available: false, reason: 'best_program 缺少 EVOLVE-BLOCK 标记' };
  }
  const programText = text.slice(start + '/* EVOLVE-BLOCK-START */'.length, end).trim();
  const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, 'utf8')) : null;
  return {
    available: true,
    programText,
    functionSha256: sha256Hex(programText),
    info,
    bestProgramPath: bestPath,
    generator: 'openevolve-llm',
  };
}

/**
 * 把 OpenEvolve best program 编译成 Candidate Artifact（真实源码候选，非 JSON 描述符）。
 * 静态检查、独立编译、Seatbelt 探针全部走既有受控管线。
 */
export function createCandidateFromOpenEvolve({ outputDir, experiment, round = 1, index = 0, parentId = null }) {
  const loaded = loadOpenEvolveBestProgram({ outputDir });
  if (!loaded.available) throw new Error(`OpenEvolve 产物不可用：${loaded.reason}`);
  const created = createCompiledAcquisitionCandidate({
    experiment,
    round,
    index,
    parentId,
    programText: loaded.programText,
    mutationLabel: 'openevolve-best-program',
    sourceOrigin: 'openevolve-llm',
  });
  return {
    ...created,
    provenance: {
      generator: 'openevolve-llm',
      outputDir,
      bestProgramPath: loaded.bestProgramPath,
      functionSha256: loaded.functionSha256,
      bestInfo: loaded.info,
    },
  };
}
