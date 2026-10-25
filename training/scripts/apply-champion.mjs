#!/usr/bin/env node
/** 冠军参数落地脚本：把 training/champions/champion.json 的参数写入
 * web-v1/src/ai/parameters.ts 的生成区（CHAMPION-PARAMETERS 标记块）。
 *
 * 用途：晋级 PR 中由 GitHub Actions 调用；也可手动执行。
 * 保证训练版与网页实战版永远使用同一套参数值（同一源码 + 同一参数块）。
 *
 * 用法：node training/scripts/apply-champion.mjs [--champion training/champions/champion.json]
 *        [--target web-v1/src/ai/parameters.ts] [--check]
 * --check：仅校验当前生成区与冠军文件一致（CI 用），不一致时退出码 1。
 * --target：测试/隔离工作区用；缺省写正式 parameters.ts（AI7 回归测试不再改动仓库源文件）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBuiltEngine, REPO_ROOT } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const championIndex = args.indexOf('--champion');
const championArg = championIndex >= 0 ? args[championIndex + 1] : undefined;
const championPath = resolve(championArg !== undefined ? process.cwd() : REPO_ROOT, championArg ?? 'training/champions/champion.json');
const targetIndex = args.indexOf('--target');
const targetArg = targetIndex >= 0 ? args[targetIndex + 1] : undefined;

requireBuiltEngine();
const champion = JSON.parse(readFileSync(championPath, 'utf8'));
const parameters = champion.parameters ?? champion;
if (!parameters.id) throw new Error('冠军文件缺少 parameters.id');

const BEGIN = '// === CHAMPION-PARAMETERS-BEGIN';
const END = '// === CHAMPION-PARAMETERS-END ===';
const targetPath = targetArg !== undefined
  ? resolve(process.cwd(), targetArg)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../web-v1/src/ai/parameters.ts');
const source = readFileSync(targetPath, 'utf8');
const beginIndex = source.indexOf(BEGIN);
const endIndex = source.indexOf(END);
if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
  throw new Error('parameters.ts 缺少 CHAMPION-PARAMETERS 标记块');
}

const round = value => Number(value.toFixed(6));
const ordered = ['id', 'engineWeight', 'tempoWeight', 'contestWeight', 'synergyWeight', 'goalWeight', 'capacityWeight', 'restWeight', 'endgameWeight'];
// 适配器冠军（AI6：结构候选晋级，如 JS5 champion-guided）：决策核心在适配器内，
// 权重乘子不参与决策——缺省补 1.0 保持 AIParameters 类型完备，并透传适配器字段。
const adapterMode = parameters.adapter !== undefined;
const lines = ordered.map(key => {
  const value = parameters[key] ?? (adapterMode ? 1 : undefined);
  if (value === undefined) throw new Error(`冠军参数缺少 ${key}`);
  return `  ${key}: ${typeof value === 'string' ? JSON.stringify(value) : round(value)},`;
});
// 结构变体是冠军版本的一部分：冠军参数携带 structure 时必须透传，
// 否则网页端会静默回落 beam-lineage，破坏"训练与实战同参"约束。
if (parameters.structure !== undefined) {
  lines.push(`  structure: ${JSON.stringify(parameters.structure)},`);
}
// AI5 收集变体同理：acquisitionVariant 决定 acquisitionValue 走哪个实现，
// 缺失时网页端会静默回落 baseline 收集价值（回归：AI5 readiness-efficiency 晋级后被 fairness 测试拦截）。
if (parameters.acquisitionVariant !== undefined) {
  lines.push(`  acquisitionVariant: ${JSON.stringify(parameters.acquisitionVariant)},`);
}
// 适配器冠军字段：决策入口（decision.ts）按 adapter 分派到适配器决策核心。
if (adapterMode) {
  if (!parameters.jointVersion) throw new Error('适配器冠军缺少 jointVersion');
  lines.push(`  adapter: ${JSON.stringify(parameters.adapter)},`);
  lines.push(`  jointVersion: ${JSON.stringify(parameters.jointVersion)},`);
  if (parameters.budgetMs !== undefined) {
    lines.push(`  budgetMs: ${parameters.budgetMs},`);
  }
}
const block = [
  `${BEGIN}（由 training/scripts/apply-champion.mjs 生成，勿手改） ===`,
  'export const CHAMPION_PARAMETERS: AIParameters = {',
  ...lines,
  '};',
  END,
].join('\n');

const updated = source.slice(0, beginIndex) + block + source.slice(endIndex + END.length);
if (checkOnly) {
  const matches = updated === source;
  console.log(matches ? `OK：parameters.ts 与冠军 ${parameters.id} 一致` : `MISMATCH：parameters.ts 落后于冠军 ${parameters.id}，需要运行 apply-champion.mjs`);
  process.exit(matches ? 0 : 1);
}
writeFileSync(targetPath, updated);
console.log(`已把冠军 ${parameters.id} 的参数写入 ${targetPath}`);
console.log('请运行 web-v1 测试与构建验证后提交。');
