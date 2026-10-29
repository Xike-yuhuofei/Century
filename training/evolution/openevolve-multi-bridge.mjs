/** AI 11.0 OpenEvolve 多模块桥：真实父代源码继承 + 原生 checkpoint + 成本核算。
 *
 * 纪律：
 * - 只有真实启动 OpenEvolve（codex CLI / ChatGPT 登录）并读到 best_program 时，
 *   才允许标记 generator='openevolve-llm'；
 * - 初始程序必须是**父代真实源码**（缺失模块才回落官方实现，并逐模块标注），
 *   绝不把"从官方源码重新开始"冒充第 N 代继承；
 * - OpenEvolve 不可用/失败时返回 available:false + reason，调用方必须显式选择
 *   确定性变异或安全停止，不得伪装成 OpenEvolve 成功；
 * - LLM 只参与离线研发；最终游戏推理完全本地离线；
 * - best program 的每个 EVOLVE-BLOCK 必须精确映射到注册模块，否则拒绝；
 * - token 用量从 OpenEvolve 自身日志聚合（无法获取时显式记 null，不猜）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { sha256Hex } from './core.mjs';
import {
  moduleRegistry, composeProgram, composeProgramFromTexts, extractEvolveBlocks, stripLiterals,
  extractFunction, moduleByFunctionName,
} from '../../ai5/openevolve/node/module_registry.mjs';
import { createCompiledModuleCandidate } from './multi-module-candidate.mjs';

const OPENEVOLVE_ROOT = resolve(REPO_ROOT, 'ai5/openevolve');
const VENV_PYTHON = resolve(OPENEVOLVE_ROOT, '.venv/bin/python');
const RUNNER = resolve(OPENEVOLVE_ROOT, 'run_openevolve.py');
const EVALUATOR = resolve(OPENEVOLVE_ROOT, 'century_evaluator_ai9.py');
const CONFIG = resolve(OPENEVOLVE_ROOT, 'config-ai9.yaml');
const PROGRAM_DIR = resolve(OPENEVOLVE_ROOT, 'work-ai9/programs');

/** 探测运行条件（无副作用）。 */
export function probeOpenEvolveAI9() {
  const checks = [];
  const add = (id, pass, evidence) => checks.push({ id, status: pass ? 'PASS' : 'BLOCKED', evidence });
  add('venv-python', existsSync(VENV_PYTHON), VENV_PYTHON);
  add('runner', existsSync(RUNNER), RUNNER);
  add('evaluator', existsSync(EVALUATOR), EVALUATOR);
  add('config', existsSync(CONFIG), CONFIG);
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
  return { available: blocked.length === 0, checks, blocked: blocked.map(c => c.id), generator: 'openevolve-llm' };
}

/**
 * 生成并落盘多模块初始程序。
 *
 * @param {string[]} moduleIds
 * @param {object} [options]
 * @param {string|null} [options.outputDir]
 * @param {Record<string,string>|null} [options.moduleTexts] 父代模块源码；提供时逐模块继承
 * @returns {{path:string, program:string, hash:string, moduleIds:string[],
 *           inherited:string[], fallbackToOfficial:string[]}}
 */
export function materializeMultiModuleProgram(moduleIds, { outputDir, moduleTexts = null } = {}) {
  const registry = moduleRegistry();
  const texts = moduleTexts ?? {};
  const inherited = moduleIds.filter(id => typeof texts[id] === 'string' && texts[id].trim().length > 0);
  const fallbackToOfficial = moduleIds.filter(id => !inherited.includes(id));
  const program = moduleTexts
    ? composeProgramFromTexts(moduleIds, texts, { registry })
    : composeProgram(moduleIds, { registry });
  const hash = sha256Hex(program);
  const dir = outputDir ? resolve(outputDir) : PROGRAM_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `program-${hash.slice(0, 16)}.ts`);
  writeFileSync(path, program);
  return { path, program, hash, moduleIds: [...moduleIds], inherited, fallbackToOfficial };
}

/** 聚合 OpenEvolve 自身日志中的 token 用量（无日志时返回 null，不估算）。 */
export function aggregateTokenUsage(outputDir) {
  const logsDir = resolve(outputDir, 'logs');
  if (!existsSync(logsDir)) return null;
  let calls = 0;
  let prompt = 0;
  let completion = 0;
  let matched = 0;
  for (const name of readdirSync(logsDir).filter(f => f.endsWith('.log'))) {
    const text = readFileSync(join(logsDir, name), 'utf8');
    const re = /Total LLM Token Usage \((\d+) calls?\): total_tokens=(\d+) \(prompt_tokens=(\d+), completion_tokens=(\d+)\)/g;
    for (const match of text.matchAll(re)) {
      calls += Number(match[1]);
      prompt += Number(match[3]);
      completion += Number(match[4]);
      matched += 1;
    }
  }
  if (!matched) return null;
  return {
    calls, promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion,
    source: 'openevolve-log', billing: 'unknown (Codex 订阅额度，非按 token 现金计费)',
  };
}

/**
 * 真实运行 OpenEvolve 多模块联合进化（父代源码为初始程序）。
 *
 * @param {object} options
 * @param {string[]} options.moduleIds 至少一个注册模块（建议 2–6 个）
 * @param {number} [options.iterations]
 * @param {string|null} [options.outputDir]
 * @param {number} [options.timeoutMs]
 * @param {Record<string,string>|null} [options.moduleTexts] 父代模块源码
 * @param {string|null} [options.checkpoint] OpenEvolve 原生 checkpoint 目录（跨运行恢复）
 * @param {string|null} [options.configPath] 每轮生成的配置（研究简报注入）
 */
export function runMultiModuleOpenEvolve({
  moduleIds, iterations = 3, outputDir = null, timeoutMs = 7_200_000,
  moduleTexts = null, checkpoint = null, configPath = null, briefFile = null,
}) {
  if (!Array.isArray(moduleIds) || moduleIds.length === 0) throw new Error('moduleIds 不能为空');
  const registry = moduleRegistry();
  for (const id of moduleIds) {
    if (!registry.modules.some(m => m.id === id)) throw new Error(`未注册模块：${String(id)}`);
  }
  const probe = probeOpenEvolveAI9();
  if (!probe.available) return { available: false, reason: `OpenEvolve 不可用：${probe.blocked.join(', ')}`, probe };
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`iterations 非法：${iterations}`);
  if (checkpoint !== null && !existsSync(checkpoint)) {
    return { available: true, ok: false, reason: `checkpoint 不存在：${checkpoint}`, checkpointMissing: true };
  }
  const outDir = outputDir ? resolve(outputDir) : resolve(OPENEVOLVE_ROOT, 'results', `ai9-openevolve-${Date.now()}`);
  const program = materializeMultiModuleProgram(moduleIds, { outputDir: join(outDir, 'input'), moduleTexts });
  const config = configPath ? resolve(configPath) : CONFIG;
  if (!existsSync(config)) return { available: true, ok: false, reason: `配置不存在：${config}` };
  const started = Date.now();
  const args = [
    RUNNER, program.path, EVALUATOR,
    '--config', config,
    '--iterations', String(iterations),
    '--output', outDir,
  ];
  if (checkpoint) args.push('--checkpoint', checkpoint);
  const result = spawnSync(VENV_PYTHON, args, {
    cwd: OPENEVOLVE_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      ...(briefFile ? { CENTURY_RESEARCH_BRIEF: resolve(briefFile) } : {}),
    },
  });
  const elapsedMs = Date.now() - started;
  const bestPath = resolve(outDir, 'best/best_program.ts');
  const infoPath = resolve(outDir, 'best/best_program_info.json');
  const tokenUsage = aggregateTokenUsage(outDir);
  return {
    available: true,
    ok: result.status === 0 && existsSync(bestPath),
    status: result.status,
    signal: result.signal ?? null,
    elapsedMs,
    outputDir: outDir,
    programPath: program.path,
    inputProgramHash: program.hash,
    inheritedModules: program.inherited,
    fallbackToOfficial: program.fallbackToOfficial,
    configPath: config,
    checkpointResumedFrom: checkpoint,
    bestProgramPath: existsSync(bestPath) ? bestPath : null,
    bestProgramInfoPath: existsSync(infoPath) ? infoPath : null,
    tokenUsage,
    logTail: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-4000),
    generator: 'openevolve-llm',
  };
}

/** 从 best program 中提取全部模块函数（拒绝未注册/重复/额外代码）。 */
export function loadMultiModuleBestProgram({ outputDir, expectedModuleIds = null }) {
  const bestPath = resolve(outputDir, 'best/best_program.ts');
  if (!existsSync(bestPath)) return { available: false, reason: `best_program.ts 不存在：${bestPath}` };
  const text = readFileSync(bestPath, 'utf8');
  const parsed = extractEvolveBlocks(text);
  if (parsed.error) return { available: false, reason: parsed.error };
  if (!parsed.blocks.length) return { available: false, reason: 'best program 缺少 EVOLVE-BLOCK' };
  const modules = [];
  for (const block of parsed.blocks) {
    const stripped = stripLiterals(block.text);
    const matches = [...stripped.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
    if (matches.length !== 1) return { available: false, reason: `block 函数数量异常：${matches.length}` };
    const fnName = matches[0][1];
    const module = moduleByFunctionName(fnName);
    if (!module) return { available: false, reason: `未注册函数：${fnName}` };
    const fn = extractFunction(stripped, block.text, fnName);
    if (fn.error) return { available: false, reason: `${module.id}: ${fn.error}` };
    modules.push({ id: module.id, label: module.label, text: fn.text, functionSha256: sha256Hex(fn.text) });
  }
  if (expectedModuleIds) {
    const actual = modules.map(m => m.id).sort();
    const expected = [...expectedModuleIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return { available: false, reason: `best program 模块集合变化：期望 ${expected.join(',')}，实际 ${actual.join(',')}` };
    }
  }
  const info = existsSync(resolve(outputDir, 'best/best_program_info.json'))
    ? JSON.parse(readFileSync(resolve(outputDir, 'best/best_program_info.json'), 'utf8'))
    : null;
  return {
    available: true,
    modules,
    moduleIds: modules.map(m => m.id),
    combinedSha256: sha256Hex(modules.map(m => `${m.id}:${m.functionSha256}`).join('\n')),
    bestProgramHash: sha256Hex(text),
    info,
    bestProgramPath: bestPath,
    generator: 'openevolve-llm',
  };
}

/**
 * best program → 多模块编译候选（真实 LLM 来源 + 父代谱系）。
 *
 * @param {object} options
 * @param {object|null} [options.parentArtifact] 父代候选 artifact（谱系必需）
 */
export function createCandidateFromOpenEvolveMulti({
  outputDir, experiment, round = 1, index = 0, parentArtifact = null, expectedModuleIds = null,
  parentModuleTexts = null, run = null, hypothesisId = null,
}) {
  const loaded = loadMultiModuleBestProgram({ outputDir, expectedModuleIds });
  if (!loaded.available) throw new Error(`OpenEvolve 产物不可用：${loaded.reason}`);
  const parentId = parentArtifact?.candidateId ?? null;
  const parentModuleHashes = parentModuleTexts
    ? Object.fromEntries(Object.entries(parentModuleTexts).map(([id, text]) => [id, sha256Hex(text)]))
    : null;
  const modulesChanged = parentModuleHashes
    ? loaded.modules.filter(m => parentModuleHashes[m.id] !== m.functionSha256).map(m => m.id).sort()
    : [...loaded.moduleIds].sort();
  const created = createCompiledModuleCandidate({
    modules: loaded.modules,
    moduleIds: loaded.moduleIds,
    experiment,
    round,
    index,
    parentId,
    sourceOrigin: 'openevolve-llm',
    mutationLabel: 'openevolve-best-program',
    lineage: {
      parentCandidateId: parentId,
      parentSourceHash: parentArtifact?.sourceHash ?? null,
      parentModuleHashes,
      inputProgramHash: run?.inputProgramHash ?? null,
      outputProgramHash: loaded.combinedSha256,
      bestProgramHash: loaded.bestProgramHash,
      modulesChanged,
      modulesInherited: run?.inheritedModules ?? null,
      fallbackToOfficial: run?.fallbackToOfficial ?? null,
      operator: 'openevolve-llm',
      hypothesisId,
      configPath: run?.configPath ?? null,
      checkpointResumedFrom: run?.checkpointResumedFrom ?? null,
      llm: run?.tokenUsage ?? null,
      outputDir,
      bestProgramPath: loaded.bestProgramPath,
    },
  });
  return {
    ...created,
    provenance: {
      generator: 'openevolve-llm',
      outputDir,
      bestProgramPath: loaded.bestProgramPath,
      combinedSha256: loaded.combinedSha256,
      modules: loaded.moduleIds,
      bestInfo: loaded.info,
      tokenUsage: run?.tokenUsage ?? null,
      inheritedModules: run?.inheritedModules ?? null,
      fallbackToOfficial: run?.fallbackToOfficial ?? null,
    },
  };
}

export { OPENEVOLVE_ROOT, CONFIG as AI9_CONFIG_PATH };
