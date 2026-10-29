#!/usr/bin/env node
/** AI9 模块依赖图（从注册表生成，不手填）。
 *
 * 输出节点、功能依赖边、同文件编译原子组与交互审查组：
 * - functional：一个模块的进化语义直接读取另一个模块的输出（当前仅 M02 → M03/M04）；
 * - compile-atomic：同一源码文件中的模块必须共享接口版本并一起通过 tsc；
 * - interaction-review：共享决策链路、需要联合实验检查抵消/增益的模块组。
 *
 * 这是依赖/版本证据，不是强度证据。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { writeJSON } from '../lib/io.mjs';

const registry = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/evolution/module-registry.json'), 'utf8'));
const modules = registry.modules ?? [];

const nodes = modules.map(module => ({
  id: module.id,
  label: module.label,
  functionName: module.functionName,
  file: module.file,
  interfaceVersion: module.interfaceVersion ?? registry.interfaceVersion,
  dependsOn: module.dependsOn ?? [],
  independentlyEvolvable: (module.dependsOn ?? []).length === 0,
  realDecisionPath: module.realDecisionPath,
  fallback: module.fallback,
}));

const edges = modules.flatMap(module => (module.dependsOn ?? []).map(dep => ({
  from: module.id,
  to: dep,
  type: 'functional',
  reason: 'M02 acquisitionValue 读取 M03 engineValue 与 M04 keepValue 的公开结果',
})));

const byFile = new Map();
for (const module of modules) {
  const list = byFile.get(module.file) ?? [];
  list.push(module.id);
  byFile.set(module.file, list);
}
const compileAtomicGroups = [...byFile.entries()]
  .filter(([, ids]) => ids.length > 1)
  .map(([file, ids]) => ({ file, modules: ids, reason: '同一源码文件，候选编译必须保持接口签名一致' }));

const interactionGroups = [
  {
    modules: ['M02', 'M07', 'M09'],
    reason: '共同进入 acquisitionValue 的对手压力与未来未知牌支持链路，组合后可能互相抵消或放大',
    evidence: 'training/reports/ai9/interaction-experiment.json',
  },
  {
    modules: ['M06', 'M10', 'M11'],
    reason: '终局回传、根行动筛选与联合搜索结构共同决定最终行动；M06 使用公开名次快照',
    evidence: 'training/reports/ai9/structural-search-candidates.json',
  },
  {
    modules: ['M10', 'M11', 'M12'],
    reason: '候选生成、搜索结构与计算预算共享联合搜索路径，需按同一 workUnits 口径比较',
    evidence: 'training/reports/ai9/module-wiring-audit.json',
  },
];

const report = {
  schema: 'century-ai9-module-dependency-graph-v1',
  generatedAt: new Date().toISOString(),
  registry: {
    path: 'training/evolution/module-registry.json',
    version: registry.version,
    interfaceVersion: registry.interfaceVersion,
  },
  nodes,
  edges,
  groups: {
    independentlyEvolvable: nodes.filter(n => n.independentlyEvolvable).map(n => n.id),
    functionallyCoupled: modules.filter(m => (m.dependsOn ?? []).length > 0)
      .map(m => ({ modules: [m.id, ...m.dependsOn], reason: 'function output dependency' })),
    compileAtomic: compileAtomicGroups,
    interactionReview: interactionGroups,
  },
  note: '依赖图用于候选组合/交叉前的接口与交互检查；真实强弱仍只由完整候选的配对第一名率决定。',
};

const out = resolve(REPO_ROOT, 'training/reports/ai9/module-dependency-graph.json');
writeJSON(out, report);
console.log(JSON.stringify({
  out,
  nodes: nodes.length,
  functionalEdges: edges.length,
  compileAtomicGroups: compileAtomicGroups.length,
  interactionGroups: interactionGroups.length,
}, null, 2));
