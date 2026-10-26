/** AI9 模块注册表 / 种子区块 / 确定性变异的结构测试。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  moduleRegistry, listModules, getModule, officialFunctionText, composeProgram,
  extractEvolveBlocks, functionParams, stripLiterals,
} from '../../../ai5/openevolve/node/module_registry.mjs';
import {
  AI7_DEV_BLOCKS, AI9_DEV_BLOCKS,
} from '../core.mjs';
import {
  AI9_BLOCK, AI9_OPENEVOLVE_STAGE2_BLOCK, AI9_PROBE_BLOCK, AI9_OPENEVOLVE_STAGE3_BLOCK,
} from '../../../ai5/lib/seed_policy.mjs';
import { MODULE_MUTATIONS, mutateModuleFunction, allMutationVariants } from '../module-mutations.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

test('注册表：恰好 12 个模块，M01–M12 唯一且接口版本统一', () => {
  const registry = moduleRegistry();
  assert.equal(registry.schema, 'century-evolvable-module-registry-v1');
  const ids = registry.modules.map(m => m.id);
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
  assert.equal(new Set(ids).size, 12);
  for (const module of registry.modules) {
    assert.equal(module.interfaceVersion, undefined);
    assert.ok(module.wiring.length > 0);
    assert.ok(module.file.endsWith('.ts'));
    assert.ok(!module.file.startsWith('/') && !module.file.includes('..'));
  }
});

test('注册表：官方函数文本可提取且参数签名逐参一致', () => {
  for (const module of listModules()) {
    const text = officialFunctionText(module);
    assert.match(text, new RegExp(`export\\s+function\\s+${module.functionName}\\s*\\(`));
    const stripped = stripLiterals(text);
    const params = functionParams(stripped);
    assert.deepEqual(params, module.signature, `${module.id} 签名漂移`);
  }
});

test('注册表：全部模块依赖存在且目标文件位于 web-v1/src', () => {
  const registry = moduleRegistry();
  const ids = new Set(registry.modules.map(m => m.id));
  for (const module of registry.modules) {
    for (const dep of module.dependsOn ?? []) {
      assert.ok(ids.has(dep), `${module.id} 依赖未注册：${dep}`);
    }
    const path = resolve(REPO_ROOT, 'web-v1/src', module.file);
    assert.ok(readFileSync(path, 'utf8').includes(`function ${module.functionName}`));
  }
});

test('多模块程序：composeProgram 每个 EVOLVE-BLOCK 映射唯一模块且可解析', () => {
  const ids = ['M01', 'M02', 'M05', 'M10'];
  const program = composeProgram(ids);
  const parsed = extractEvolveBlocks(program);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.blocks.length, ids.length);
  const names = parsed.blocks.map(block =>
    [...stripLiterals(block.text).matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])[0]);
  assert.deepEqual(names.map(name => moduleRegistry().modules.find(m => m.functionName === name).id), ids);
});

test('确定性变异：每个模块至少一个单点变异且都能改变函数哈希', () => {
  for (const module of listModules()) {
    const variants = allMutationVariants(module.id);
    assert.ok(variants.length >= 1, `${module.id} 缺少确定性变异`);
    const official = officialFunctionText(module);
    for (const variant of variants) {
      assert.notEqual(variant.text, official, `${module.id}/${variant.label} 未改变源码`);
    }
  }
});

test('确定性变异：官方函数结构变化时必须显式抛错（唯一命中保护）', () => {
  const module = getModule('M01');
  const official = officialFunctionText(module);
  // 模拟官方结构变化：变异锚点消失 → replaceOnce 必须拒绝而不是静默改写。
  const mutated = MODULE_MUTATIONS.M01[0].apply(official);
  assert.notEqual(mutated, official);
  assert.throws(() => MODULE_MUTATIONS.M01[0].apply('export function goalPriority() { return 2; }'),
    /变异点不唯一|官方函数结构变更/);
});

test('种子区块：AI9 研究/开发/确认块与 AI7、验证池、全部既有块零交集', () => {
  const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
  const ai9Blocks = [
    AI9_OPENEVOLVE_STAGE2_BLOCK, AI9_OPENEVOLVE_STAGE3_BLOCK, AI9_PROBE_BLOCK,
    AI9_DEV_BLOCKS.screen, AI9_DEV_BLOCKS.deep,
    [1_680_000_000, 1_690_000_000],
  ];
  const others = [
    AI7_DEV_BLOCKS.screen, AI7_DEV_BLOCKS.deep,
    [900_000_000, 1_060_000_000], [1_100_000_000, 1_200_000_000],
    [1_300_000_000, 1_400_000_000], [1_400_000_000, 1_500_000_000],
    [1_500_000_000, 1_600_000_000], [1_610_000_000, 1_630_000_000],
  ];
  for (const block of ai9Blocks) {
    assert.ok(block[0] < block[1] && block[1] <= 2 ** 31 - 1);
    for (const other of others) {
      assert.ok(!overlaps(block, other), `AI9 块 ${block} 与既有块 ${other} 重叠`);
    }
  }
  assert.deepEqual(AI9_BLOCK, [1_650_000_000, 1_700_000_000]);
});
