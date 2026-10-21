#!/usr/bin/env node
/** 冠军参数落地脚本：把 training/champions/champion.json 的参数写入
 * web-v1/src/ai/parameters.ts 的生成区（CHAMPION-PARAMETERS 标记块）。
 *
 * 用途：晋级 PR 中由 GitHub Actions 调用；也可手动执行。
 * 保证训练版与网页实战版永远使用同一套参数值（同一源码 + 同一参数块）。
 *
 * 用法：node training/scripts/apply-champion.mjs [--champion training/champions/champion.json] [--check]
 * --check：仅校验当前生成区与冠军文件一致（CI 用），不一致时退出码 1。
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

requireBuiltEngine();
const champion = JSON.parse(readFileSync(championPath, 'utf8'));
const parameters = champion.parameters ?? champion;
if (!parameters.id) throw new Error('冠军文件缺少 parameters.id');

const BEGIN = '// === CHAMPION-PARAMETERS-BEGIN';
const END = '// === CHAMPION-PARAMETERS-END ===';
const targetPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../web-v1/src/ai/parameters.ts');
const source = readFileSync(targetPath, 'utf8');
const beginIndex = source.indexOf(BEGIN);
const endIndex = source.indexOf(END);
if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
  throw new Error('parameters.ts 缺少 CHAMPION-PARAMETERS 标记块');
}

const round = value => Number(value.toFixed(6));
const ordered = ['id', 'engineWeight', 'tempoWeight', 'contestWeight', 'synergyWeight', 'goalWeight', 'capacityWeight', 'restWeight', 'endgameWeight'];
const lines = ordered.map(key => {
  const value = parameters[key];
  if (value === undefined) throw new Error(`冠军参数缺少 ${key}`);
  return `  ${key}: ${typeof value === 'string' ? JSON.stringify(value) : round(value)},`;
});
// 结构变体是冠军版本的一部分：冠军参数携带 structure 时必须透传，
// 否则网页端会静默回落 beam-lineage，破坏"训练与实战同参"约束。
if (parameters.structure !== undefined) {
  lines.push(`  structure: ${JSON.stringify(parameters.structure)},`);
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
