/** AI 9.0 多模块编译候选：静态检查 → 隔离组装 → 独立 tsc → 编译产物封印。
 *
 * 与 AI7 compiled-candidate.mjs 的区别：
 * - 一个候选可包含多个模块，可修改多个策略文件；
 * - 候选源码与模块身份（id/函数/目标文件/接口版本/函数哈希）全部进入 artifact；
 * - 编译产物为完整 ESM 决策包（dist/js/**），加载侧无需原构建目录即可复现；
 * - 所有不可信步骤（静态检查/组装/编译）在 macOS Seatbelt 内执行；
 * - 非 macOS / Seatbelt 不可用时 fail closed，绝不无沙箱编译。
 *
 * 候选只用于离线研发/真实对局评估；正式游戏推理仍完全本地离线。
 */

import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertCondition, gameRulesDescriptor, sha256Hex, sha256Canonical, shortHash,
} from './core.mjs';
import { createCandidateArtifact, validateArtifact, verifyArtifactReproducibility } from './candidate-artifact.mjs';
import { REPO_ROOT, SEATBELT_AVAILABLE, runNodeSeatbelt } from './sandbox/seatbelt.mjs';
import { moduleRegistry, getModule, composeProgram } from '../../ai5/openevolve/node/module_registry.mjs';

export const MULTI_MODULE_PROTOCOL = 'century-multi-module-candidate-v1';
const STATIC_CHECK = resolve(REPO_ROOT, 'ai5/openevolve/node/static_check_modules.mjs');
const ASSEMBLE = resolve(REPO_ROOT, 'ai5/openevolve/node/assemble_modules.mjs');
const PROBE = resolve(REPO_ROOT, 'ai5/openevolve/node/ai9_probe.mjs');
const TSC = resolve(REPO_ROOT, 'web-v1/node_modules/typescript/bin/tsc');
const TSC_PACKAGE = resolve(REPO_ROOT, 'web-v1/node_modules/typescript/package.json');
const CHAMPION = resolve(REPO_ROOT, 'training/champions/champion.json');

let tscVersionCache = null;
function readTscVersion() {
  if (!tscVersionCache) tscVersionCache = JSON.parse(readFileSync(TSC_PACKAGE, 'utf8')).version;
  return tscVersionCache;
}

/** 默认候选参数 = 冻结冠军参数集（只把 id 换成候选 id；行为由模块源码决定）。 */
export function candidateParametersFor(candidateId) {
  const champion = JSON.parse(readFileSync(CHAMPION, 'utf8'));
  assertCondition(champion?.parameters?.id, '冠军文件缺少 parameters');
  return { ...JSON.parse(JSON.stringify(champion.parameters)), id: candidateId };
}

function cleanup(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* 临时目录清理失败不阻断 */ }
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path, rel));
    else if (entry.isFile()) out.push({ path: rel, absolute: path, size: statSync(path).size });
  }
  return out;
}

/** 由模块文本构建 OpenEvolve 程序（组合为多 EVOLVE-BLOCK）。 */
function programFromModules(modules) {
  const registry = moduleRegistry();
  return modules.map(({ id, text }) => {
    const module = getModule(id, registry);
    return `// ===== ${module.id} ${module.label}（${module.functionName}） =====\n/* EVOLVE-BLOCK-START */\n${text.trim()}\n/* EVOLVE-BLOCK-END */\n`;
  }).join('\n');
}

/**
 * 创建多模块编译候选。
 *
 * @param {object} options
 * @param {Array<{id:string,text:string}>|null} [options.modules] 模块函数文本
 * @param {string|null} [options.programText] 直接提供多 EVOLVE-BLOCK 程序
 * @param {string|null} [options.moduleIds] 逗号/数组形式的期望模块集合
 * @param {object} options.experiment 实验引用
 * @param {number} [options.round]
 * @param {number} [options.index]
 * @param {string|null} [options.candidateId]
 * @param {string|null} [options.parentId]
 * @param {object|null} [options.parameters] 候选 AIParameters（缺省冻结冠军）
 * @param {number[]} [options.applicablePlayerCounts]
 * @param {string} [options.sourceOrigin] 'openevolve-llm' | 'deterministic-template' | 'crossover'
 */
export function createCompiledModuleCandidate({
  modules = null, programText = null, moduleIds = null,
  experiment, round = 1, index = 0, candidateId = null, parentId = null,
  parameters = null, applicablePlayerCounts = [2, 3, 4, 5],
  sourceOrigin = 'deterministic-template', mutationLabel = null,
  timeoutMs = 300_000, probe = true,
}) {
  assertCondition(SEATBELT_AVAILABLE, 'Seatbelt 不可用——拒绝创建编译型多模块候选（不做无沙箱编译）');
  assertCondition(existsSync(TSC), `tsc 不存在：${TSC}`);
  assertCondition(experiment && typeof experiment === 'object', '多模块候选必须提供 experiment 引用');
  assertCondition(programText !== null || (Array.isArray(modules) && modules.length > 0) || moduleIds,
    '必须提供 modules、programText 或 moduleIds');
  const registry = moduleRegistry();
  const requestedIds = moduleIds
    ? (Array.isArray(moduleIds) ? moduleIds : String(moduleIds).split(',').map(s => s.trim()).filter(Boolean))
    : null;
  const finalProgram = programText ?? (modules
    ? programFromModules(modules)
    : composeProgram(requestedIds, { registry }));
  const id = candidateId ?? `cand-ai9-multi-r${round}c${index}-${shortHash(sha256Canonical({ program: finalProgram, round, index }), 6)}`;
  const params = parameters ?? candidateParametersFor(id);
  const workRoot = mkdtempSync(join(tmpdir(), 'ai9-multi-'));
  const buildStartedAt = Date.now();
  const programPath = join(workRoot, 'program.ts');
  const staticJson = join(workRoot, 'static.json');
  const buildDir = join(workRoot, 'candidate');
  writeFileSync(programPath, finalProgram);

  try {
    const staticArgs = ['--program', programPath, '--out', staticJson];
    if (requestedIds) staticArgs.push('--modules', requestedIds.join(','));
    const staticRun = runNodeSeatbelt({ workRoot, script: STATIC_CHECK, args: staticArgs, timeoutMs: 60_000 });
    assertCondition(staticRun.ok, `多模块静态检查失败：${(staticRun.stderr || staticRun.stdout).slice(-800)}`);
    assertCondition(existsSync(staticJson), '多模块静态检查未产出 JSON');
    const staticResult = JSON.parse(readFileSync(staticJson, 'utf8'));
    assertCondition(staticResult.ok === true, `静态检查拒绝：${staticResult.reason ?? 'unknown'}`);
    const moduleEntries = staticResult.modules.map(m => ({
      ...m,
      functionPath: staticResult.moduleFiles?.[m.id],
    }));
    assertCondition(moduleEntries.every(m => m.functionPath && existsSync(m.functionPath)), '静态检查未落盘全部模块函数文本');
    const ids = moduleEntries.map(m => m.id).sort();
    if (requestedIds) {
      const expected = [...requestedIds].sort();
      assertCondition(JSON.stringify(ids) === JSON.stringify(expected),
        `模块集合与请求不一致：请求 ${expected.join(',')}，实际 ${ids.join(',')}`);
    }

    const assembleRun = runNodeSeatbelt({
      workRoot, script: ASSEMBLE,
      args: ['--manifest', staticJson, '--out', buildDir], timeoutMs: 120_000,
    });
    assertCondition(assembleRun.ok, `多模块组装失败：${(assembleRun.stderr || assembleRun.stdout).slice(-800)}`);
    writeFileSync(join(buildDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

    const compile = runNodeSeatbelt({
      workRoot, script: TSC, args: ['-p', join(buildDir, 'tsconfig.json')],
      timeoutMs, cwd: buildDir,
    });
    assertCondition(compile.ok, `tsc 编译失败：${(compile.stderr || compile.stdout).slice(-1200)}`);
    const distDir = join(buildDir, 'dist/js');
    assertCondition(existsSync(distDir), 'tsc 成功但未产出 dist/js');
    const aiEntry = join(distDir, 'ai.js');
    const adapterEntry = join(distDir, 'js/adapter.js');
    assertCondition(existsSync(aiEntry) && existsSync(adapterEntry), '编译产物缺少 ai.js 或 js/adapter.js');

    let probeResult = null;
    if (probe) {
      const probeOut = join(workRoot, 'probe.json');
      const probeRun = runNodeSeatbelt({
        workRoot, script: PROBE,
        args: ['--candidate', distDir, '--modules', ids.join(','), '--out', probeOut],
        timeoutMs: 120_000,
      });
      assertCondition(probeRun.ok, `行为探针失败：${(probeRun.stderr || probeRun.stdout).slice(-800)}`);
      assertCondition(existsSync(probeOut), '行为探针未产出结果');
      probeResult = JSON.parse(readFileSync(probeOut, 'utf8'));
      assertCondition(probeResult.probeErrors === 0,
        `行为探针存在调用错误：${probeResult.probeErrors}`);
    }
    const distFiles = listFiles(distDir).filter(f => f.path.endsWith('.js'));
    assertCondition(distFiles.length > 0, '编译产物为空');
    const compiledFiles = distFiles.map(f => ({
      path: `dist/js/${f.path}`,
      content: readFileSync(f.absolute, 'utf8'),
    }));
    const compiledBytes = compiledFiles.reduce((sum, f) => sum + f.content.length, 0);
    assertCondition(compiledBytes <= 8 * 1024 * 1024, `编译产物 ${compiledBytes}B 超过 8MB 上限`);

    const sourceFiles = moduleEntries.map(m => ({
      path: `modules/${m.id}.fn.ts`,
      content: readFileSync(m.functionPath, 'utf8'),
    }));
    const sourceModules = moduleEntries.map((m, i) => ({
      id: m.id,
      functionName: m.functionName,
      file: `src/${m.file}`,
      interfaceVersion: m.interfaceVersion ?? registry.interfaceVersion,
      path: sourceFiles[i].path,
      functionSha256: sha256Hex(sourceFiles[i].content),
      textLength: sourceFiles[i].content.length,
    }));
    const buildManifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));

    const artifact = createCandidateArtifact({
      candidateId: id,
      parentId,
      algorithmStructure: {
        targetIds: ids,
        decisionCore: 'champion-guided',
        adapter: 'champion-guided',
        structure: null,
        jointVersion: params.jointVersion ?? 'joint-js5',
        evaluationMode: 'game',
        jointOptionsByPlayerCount: null,
        integration: 'compiled-module-seat',
      },
      parameters: {
        id,
        version: 1,
        values: params,
        boundsVersion: 'ai-parameters-v1',
      },
      source: {
        kind: 'esm-module-bundle',
        entry: sourceFiles[0].path,
        files: sourceFiles,
        modules: sourceModules,
      },
      experiment,
      applicablePlayerCounts,
      safety: { status: 'pending', checks: [] },
      buildInput: {
        kind: 'esm-module-bundle-v1',
        compiler: `tsc ${readTscVersion()}`,
        files: compiledFiles,
      },
      gameRules: gameRulesDescriptor(),
    });
    validateArtifact(artifact);

    return {
      artifact,
      evaluationMode: 'game',
      targetValues: { modules: ids },
      probe: probeResult,
      buildLog: {
        protocol: MULTI_MODULE_PROTOCOL,
        compiler: `tsc ${readTscVersion()}`,
        modules: ids,
        moduleHashes: Object.fromEntries(sourceModules.map(m => [m.id, m.functionSha256])),
        combinedModuleHash: buildManifest.combinedModuleHash,
        compiledFiles: compiledFiles.length,
        compiledBytes,
        sourceOrigin,
        mutation: mutationLabel,
        sandbox: 'macos-seatbelt',
        elapsedMs: Date.now() - buildStartedAt,
      },
    };
  } finally {
    cleanup(workRoot);
  }
}

/** 把 artifact 封印的编译产物写成可直接 import 的 ESM 包。 */
export function materializeCompiledCandidate(artifact, { dir = null } = {}) {
  const reproducibility = verifyArtifactReproducibility(artifact);
  assertCondition(reproducibility.ok, `候选 artifact 不可复现：${reproducibility.error}`);
  assertCondition(artifact.buildArtifact?.compiled === true, '候选不是编译型 artifact');
  assertCondition(artifact.source?.modules?.length > 0, '候选不是多模块 artifact');
  const targetDir = dir ?? mkdtempSync(join(tmpdir(), 'ai9-loaded-'));
  for (const file of artifact.buildArtifact.files ?? []) {
    assertCondition(file.path.startsWith('dist/js/'), `编译产物路径非法：${file.path}`);
    const path = join(targetDir, file.path);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, file.content);
  }
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  return {
    dir: targetDir,
    owned: dir === null,
    aiEntry: join(targetDir, 'dist/js/ai.js'),
    adapterEntry: join(targetDir, 'dist/js/js/adapter.js'),
    moduleIds: artifact.source.modules.map(m => m.id),
    cleanup: () => { if (dir === null) cleanup(targetDir); },
  };
}

/** 动态加载编译候选：返回与冠军代码互不共享状态的模块实例。 */
export async function loadCompiledCandidateModules(artifact, options = {}) {
  const materialized = materializeCompiledCandidate(artifact, options);
  try {
    const aiModule = await import(pathToFileURL(materialized.aiEntry).href);
    const jointModule = await import(pathToFileURL(materialized.adapterEntry).href);
    assertCondition(typeof aiModule.chooseAIAction === 'function', '编译候选缺少 chooseAIAction 导出');
    assertCondition(typeof jointModule.chooseJointAction === 'function', '编译候选缺少 chooseJointAction 导出');
    return {
      ...materialized,
      aiModule,
      jointModule,
      executorHash: sha256Canonical({
        artifactHash: artifact.artifactHash,
        buildArtifactHash: artifact.buildArtifact.sha256,
        modules: artifact.source.modules.map(m => [m.id, m.functionSha256]),
      }),
    };
  } catch (error) {
    materialized.cleanup();
    throw error;
  }
}

export const MULTI_MODULE_INFO = Object.freeze({
  protocol: MULTI_MODULE_PROTOCOL,
  registry: 'training/evolution/module-registry.json',
  staticCheck: STATIC_CHECK,
  assemble: ASSEMBLE,
  sandbox: 'macos-seatbelt',
  seatbeltAvailable: SEATBELT_AVAILABLE,
});

export { relative };
