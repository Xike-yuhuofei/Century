/** D4 静态安全检查：候选 artifact 进入开发池评估前的强制门禁。
 *
 * 检查项全部可复现、无网络、无墙钟依赖：
 * 1. artifact-schema：结构 + 全部哈希可复现；
 * 2. parameter-bounds：目标参数在声明边界内，分人数选项完整；
 * 3. hidden-info：源码/声明模块不得包含隐藏牌库、随机源、未来顺序；
 * 4. forbidden-constructs：不得包含 import/eval/process/fs/网络/时钟等构造；
 * 5. resource-budget：候选数与评估局数在目标预算内；
 * 6. fallback-declared：目标声明了回退策略；
 * 7. governance-boundary：实验种子只引用 dev 窗口，不触正式验证池；
 * 8. production-isolation：proxy 候选不得声明生产接线；game 候选必须显式适配器身份；
 * 9. identity-reproducible：artifact + source + build 哈希可重算。
 *
 * 任一 fail → artifact.safety.status='failed'，控制器隔离该候选，其他候选继续。
 */

import {
  HIDDEN_INFO_KEYS, assertCondition, scanForbiddenConstructs,
} from './core.mjs';
import { validateArtifact, verifyArtifactReproducibility } from './candidate-artifact.mjs';
import {
  getTarget, normalizeModuleSpec, validateSearchJointOptions,
} from './evolution-targets.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { AI7_DEV_BLOCKS, AI9_DEV_BLOCKS } from './core.mjs';
import { moduleRegistry, getModule } from '../../ai5/openevolve/node/module_registry.mjs';

function isModuleArtifact(artifact) {
  return Array.isArray(artifact.source?.modules) && artifact.source.modules.length > 0;
}

function check(id, fn) {
  try {
    const detail = fn();
    return { id, status: 'pass', detail: detail ?? 'ok' };
  } catch (error) {
    return { id, status: 'fail', detail: error.message.slice(0, 300) };
  }
}

function artifactText(artifact) {
  return artifact.source.files.map(f => `${f.path}\n${f.content}`).join('\n');
}

/** 编译产物是 JS（允许 ESM import），但仍禁止运行期危险构造。 */
const COMPILED_FORBIDDEN = Object.freeze([
  { re: /\bprocess\b/, why: 'process' },
  { re: /\bglobalThis\b/, why: 'globalThis' },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, why: '网络' },
  { re: /\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\bMath\.random\b/, why: '时钟/随机源' },
  { re: /\bnode:fs\b|\bnode:net\b|\bnode:child_process\b|\bnode:os\b/, why: '文件/网络/进程模块' },
  { re: /\bmerchantDeck\b|\bgolemDeck\b|\.deck\b/, why: '隐藏牌库' },
]);

function compiledForbiddenHits(text) {
  const hits = [];
  for (const { re, why } of COMPILED_FORBIDDEN) {
    const match = text.match(re);
    if (match) hits.push({ why, token: match[0] });
  }
  return hits;
}

/** 运行全部安全检查；返回 { status, checks }（不修改 artifact）。 */
export function runSafetyChecks(artifact) {
  const checks = [];

  checks.push(check('artifact-schema', () => {
    validateArtifact(artifact);
    return `schema=${artifact.schema}, identity=${artifact.identityDigest.slice(0, 12)}`;
  }));

  checks.push(check('parameter-bounds', () => {
    const targetIds = artifact.algorithmStructure.targetIds;
    if (artifact.algorithmStructure.evaluationMode === 'game') {
      // 冠军权重/适配器身份按正式参数校验器复核，防止重封印 artifact 注入非法参数。
      validateAIParameters(artifact.parameters.values);
    }
    if (isModuleArtifact(artifact)) {
      // 多模块候选：模块身份由注册表逐个复核；参数区只承载冠军基座参数。
      const registry = moduleRegistry();
      const known = new Set(registry.modules.map(m => m.id));
      for (const targetId of targetIds) {
        assertCondition(known.has(targetId), `未注册模块：${targetId}`);
        const meta = artifact.source.modules.find(m => m.id === targetId);
        assertCondition(meta, `artifact 缺少模块元数据：${targetId}`);
        const definition = getModule(targetId, registry);
        assertCondition(meta.functionName === definition.functionName,
          `${targetId} 函数名与注册表不一致`);
        assertCondition(meta.file === `src/${definition.file}`,
          `${targetId} 目标文件与注册表不一致：${meta.file}`);
        assertCondition(meta.interfaceVersion === registry.interfaceVersion,
          `${targetId} 接口版本不一致：${meta.interfaceVersion}`);
        assertCondition((meta.textLength ?? 0) <= definition.maxSourceBytes * 2,
          `${targetId} 源文本 ${meta.textLength}B 超过上限`);
      }
      return `modules=${targetIds.join(',')}`;
    }
    for (const targetId of targetIds) {
      const target = getTarget(targetId);
      if (target.kind === 'parameter-vector') {
        // 搜索控制的真实值在分人数联合选项里（playerCountScope 则体现在
        // applicablePlayerCounts），必须按目标边界逐项校验。
        validateSearchJointOptions({
          targetId,
          jointOptionsByPlayerCount: artifact.algorithmStructure.jointOptionsByPlayerCount,
          applicablePlayerCounts: artifact.applicablePlayerCounts,
        });
      } else if (artifact.buildArtifact?.compiled !== true) {
        // 声明式模块候选：系数/模板/输出范围统一走规范化校验（未知字段/越界即失败）。
        normalizeModuleSpec(targetId, artifact.parameters.values);
      }
      // 编译型候选的参数是编译元数据而非模块 spec，由 compiled-module 检查负责。
    }
    return `targets=${targetIds.join(',')}`;
  }));

  checks.push(check('compiled-module', () => {
    if (artifact.buildArtifact?.compiled !== true) return 'not-compiled';
    assertCondition(artifact.source?.kind === 'esm-module-bundle',
      '编译型候选 source.kind 必须为 esm-module-bundle');
    assertCondition(artifact.buildArtifact.kind === 'esm-module-bundle-v1',
      '编译型候选 buildArtifact.kind 非法');
    assertCondition(typeof artifact.buildArtifact.compiler === 'string' && artifact.buildArtifact.compiler.length > 0,
      '编译型候选缺少 compiler 身份');
    const files = artifact.buildArtifact.files ?? [];
    if (isModuleArtifact(artifact)) {
      // 多模块候选：完整 ESM 决策包必须包含 ai.js + adapter + 全部模块目标文件，
      // 逐文件检查危险构造，总产物不得超过本地推理包预算。
      const required = ['dist/js/ai.js', 'dist/js/js/adapter.js'];
      for (const path of required) {
        assertCondition(files.some(f => f.path === path && f.content.length > 0),
          `编译候选缺少 ${path}`);
      }
      for (const meta of artifact.source.modules) {
        const compiledPath = `dist/js/${meta.file.replace(/^src\//, '').replace(/\.ts$/, '.js')}`;
        assertCondition(files.some(f => f.path === compiledPath && f.content.length > 0),
          `编译候选缺少模块产物：${compiledPath}`);
      }
      const totalBytes = files.reduce((sum, f) => sum + f.content.length, 0);
      assertCondition(totalBytes <= 8 * 1024 * 1024, `编译产物 ${totalBytes}B 超过 8MB 预算`);
      // 只扫描候选实际改写的模块产物（官方其他文件的注释会合法提及隐藏牌库字段名，
      // 扫描全文会产生假阳性；候选不能修改这些文件，源码树完整性已由组装阶段证明）。
      for (const meta of artifact.source.modules) {
        const compiledPath = `dist/js/${meta.file.replace(/^src\//, '').replace(/\.ts$/, '.js')}`;
        const compiled = files.find(f => f.path === compiledPath);
        assertCondition(compiled, `缺少模块产物：${compiledPath}`);
        const hits = compiledForbiddenHits(compiled.content);
        assertCondition(hits.length === 0,
          `模块产物 ${compiledPath} 包含危险构造：${hits.map(h => `${h.why}(${h.token})`).join('；')}`);
      }
      for (const meta of artifact.source.modules) {
        const source = artifact.source.files.find(f => f.path === meta.path);
        assertCondition(source, `缺少模块源码：${meta.id}`);
        assertCondition(new RegExp(`export\\s+function\\s+${meta.functionName}\\s*\\(`).test(source.content),
          `${meta.id} 源码不是注册函数 ${meta.functionName}`);
      }
      return `modules=${artifact.source.modules.length}, bytes=${totalBytes}`;
    }
    const compiled = files.find(f => f.path === 'dist/js/ai/evaluator.js');
    assertCondition(compiled && typeof compiled.content === 'string' && compiled.content.length > 0,
      '编译型候选缺少 dist/js/ai/evaluator.js 产物');
    assertCondition(compiled.content.length <= 64 * 1024,
      `编译产物 ${compiled.content.length}B 超过 64KB 预算`);
    const compiledHits = compiledForbiddenHits(compiled.content);
    assertCondition(compiledHits.length === 0,
      `编译产物包含危险构造：${compiledHits.map(h => `${h.why}(${h.token})`).join('；')}`);
    const sourceText = artifactText(artifact);
    const signatureCount = (sourceText.match(/export\s+function\s+acquisitionValue\s*\(/g) ?? []).length;
    assertCondition(signatureCount === 1, `编译型候选必须恰好导出一个 acquisitionValue（实际 ${signatureCount}）`);
    assertCondition(/\/\*\s*EVOLVE-BLOCK-START\s*\*\//.test(sourceText)
      && /\/\*\s*EVOLVE-BLOCK-END\s*\*\//.test(sourceText),
    '编译型候选缺少 EVOLVE-BLOCK 边界');
    return `compiler=${artifact.buildArtifact.compiler}, bytes=${compiled.content.length}`;
  }));

  checks.push(check('hidden-info', () => {
    const text = artifactText(artifact);
    for (const key of HIDDEN_INFO_KEYS) {
      // 只扫描候选自带的源码/备注文本；descriptor 的公开字段（stock/hand/played）不在此列。
      if (new RegExp(`\\b${key}\\b`).test(text)) {
        throw new Error(`候选源码/声明模块包含隐藏信息字段：${key}`);
      }
    }
    return 'no hidden deck/seed/random access';
  }));

  checks.push(check('forbidden-constructs', () => {
    const hits = scanForbiddenConstructs(artifactText(artifact));
    if (hits.length) throw new Error(hits.map(h => `${h.why}（${h.token}）`).join('；'));
    return 'no forbidden constructs';
  }));

  checks.push(check('resource-budget', () => {
    const targetIds = artifact.algorithmStructure.targetIds;
    if (isModuleArtifact(artifact)) {
      const registry = moduleRegistry();
      const total = artifact.source.modules.reduce((sum, m) => sum + (m.textLength ?? 0), 0);
      const budget = artifact.source.modules.reduce((sum, m) => sum + getModule(m.id, registry).maxSourceBytes, 0);
      assertCondition(total <= budget, `模块源文本 ${total}B 超过预算 ${budget}B`);
      return `modules=${artifact.source.modules.length}, sourceBytes=${total}`;
    }
    for (const targetId of targetIds) {
      const target = getTarget(targetId);
      if (target.kind === 'parameter-vector') {
        assertCondition(artifact.applicablePlayerCounts.length <= 4, '适用人数超过预算');
      } else {
        const text = artifactText(artifact);
        assertCondition(text.length <= target.resourceBudget.maxInputBytes,
          `${targetId} 源文本 ${text.length}B 超过预算 ${target.resourceBudget.maxInputBytes}B`);
      }
    }
    return `players=${artifact.applicablePlayerCounts.join(',')}`;
  }));

  checks.push(check('fallback-declared', () => {
    if (isModuleArtifact(artifact)) {
      const registry = moduleRegistry();
      for (const meta of artifact.source.modules) {
        const target = getModule(meta.id, registry);
        assertCondition(target.fallback, `模块 ${meta.id} 未声明回退策略`);
      }
      return 'module fallback strategy present';
    }
    for (const targetId of artifact.algorithmStructure.targetIds) {
      const target = getTarget(targetId);
      assertCondition(target.fallback && target.fallback.strategy, `目标 ${targetId} 未声明回退策略`);
    }
    return 'fallback strategy present';
  }));

  checks.push(check('governance-boundary', () => {
    const ai9 = String(artifact.experiment.configRef ?? '').startsWith('ai9://');
    const blocks = ai9 ? AI9_DEV_BLOCKS : AI7_DEV_BLOCKS;
    for (const ref of artifact.experiment.seedRefs) {
      const block = blocks[ref.purpose];
      assertCondition(block, `seedRef purpose 非法：${ref.purpose}`);
      assertCondition(ref.base >= block[0] && ref.base + ref.count <= block[1],
        `seedRef ${ref.windowId} 越出 ${ai9 ? 'AI9' : 'AI7'} ${ref.purpose} 开发块`);
    }
    return ai9 ? 'AI9 dev-only seed references' : 'dev-only seed references';
  }));

  checks.push(check('production-isolation', () => {
    const mode = artifact.algorithmStructure.evaluationMode;
    if (mode === 'proxy') {
      assertCondition(artifact.algorithmStructure.integration === 'candidate-plugin-only',
        'proxy 候选不得声明生产接线');
      assertCondition(artifact.algorithmStructure.decisionCore === 'plugin-only',
        'proxy 候选决策核心必须为 plugin-only');
    } else {
      const allowedIntegrations = ['production-seat-dispatch', 'compiled-module-seat'];
      assertCondition(allowedIntegrations.includes(artifact.algorithmStructure.integration),
        `game 候选缺少受支持的生产分派声明（${artifact.algorithmStructure.integration}）`);
      assertCondition(artifact.algorithmStructure.adapter === 'champion-guided',
        'game 候选必须携带 champion-guided 适配器身份');
      assertCondition(artifact.parameters.values?.adapter === 'champion-guided',
        'game 候选参数缺少 adapter=champion-guided');
    }
    return `mode=${mode}`;
  }));

  checks.push(check('identity-reproducible', () => {
    const result = verifyArtifactReproducibility(artifact);
    assertCondition(result.ok, result.error ?? 'artifact 不可复现');
    return `source=${artifact.sourceHash.slice(0, 12)}, build=${artifact.buildArtifact.sha256.slice(0, 12)}`;
  }));

  const status = checks.every(c => c.status === 'pass') ? 'passed' : 'failed';
  return { status, checks };
}
