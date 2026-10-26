#!/usr/bin/env node
/** CI 测试分片计划（纯函数 + CLI）。
 *
 * 背景：training 单测串行执行约 21 分钟，是 PR 墙钟的主要来源。分片把它拆成
 * 多个并行矩阵作业，覆盖不变（每个测试文件仍真实执行，且必须恰好被分配一次）。
 *
 * 权重来源（按优先级）：
 * 1. `--weights <json>`：实测权重（键为仓库相对路径，值为秒），用于修正纯字节
 *    代理在少数重测试上的偏差；
 * 2. 文件字节数（稳定代理）。
 * 贪心装入当前最小的分片，并按权重降序 + 路径字典序保证确定性——同一提交在
 * 任何机器上得到同一份分片计划。
 *
 * 用法：
 *   node scripts/ci/plan-test-shards.mjs --dir training/tests --shards 4 --index 0
 *   node scripts/ci/plan-test-shards.mjs --dir web-v1/tests --shards 4 --index 1 \
 *     --exclude tests/ai.test.mjs --weights scripts/ci/test-runtime-weights.json
 *
 * `--exclude` 把个别超长测试文件移出通用分片（它们由专用并行作业按同一份对局
 * 拆分执行，覆盖率不变）。被排除的文件必须真实存在，拼写错误立即失败。
 *
 * 输出（stdout）：空格分隔的测试文件路径（供 node --test 直接消费）。
 * 校验失败（目录为空、索引越界、空分片）一律非零退出，避免“空分片静默通过”。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 实测权重缺失时的默认秒数：与字节数不可直接相加，只有提供权重表时才启用。 */
const DEFAULT_RUNTIME_SECONDS = 5;

/** 生成分片计划：每个文件恰好出现一次，分片间按权重尽量均衡。 */
export function planTestShards({ files, shards, weights = {} }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('测试文件列表为空');
  if (!Number.isSafeInteger(shards) || shards < 1) throw new Error(`分片数非法：${String(shards)}`);
  const count = Math.min(shards, files.length);
  const hasWeights = Object.keys(weights).length > 0;
  const weighted = files.map(file => {
    const measured = Number(weights[file.path]);
    const weight = Number.isFinite(measured) && measured > 0
      ? measured
      : (hasWeights ? DEFAULT_RUNTIME_SECONDS : file.bytes);
    return { ...file, weight };
  });
  const sorted = [...weighted].sort((a, b) => (b.weight - a.weight) || a.path.localeCompare(b.path));
  const buckets = Array.from({ length: count }, (_, index) => ({ index, files: [], weight: 0 }));
  for (const file of sorted) {
    const target = buckets.reduce((min, bucket) => (bucket.weight < min.weight ? bucket : min), buckets[0]);
    target.files.push(file.path);
    target.weight += file.weight;
  }
  const covered = buckets.flatMap(b => b.files);
  if (covered.length !== files.length || new Set(covered).size !== files.length) {
    throw new Error('分片计划未恰好覆盖全部测试文件');
  }
  return buckets.map(bucket => ({
    index: bucket.index,
    weight: bucket.weight,
    files: [...bucket.files].sort(),
  }));
}

/** 读取实测权重文件（缺失或损坏时返回空权重，退回字节代理）。 */
export function loadWeights(path) {
  if (!path) return {};
  const absolute = resolve(path);
  if (!existsSync(absolute)) return {};
  try {
    const doc = JSON.parse(readFileSync(absolute, 'utf8'));
    const table = doc?.weights ?? doc;
    return Object.fromEntries(Object.entries(table ?? {})
      .filter(([key, value]) => typeof key === 'string' && Number.isFinite(Number(value)) && Number(value) > 0)
      .map(([key, value]) => [key, Number(value)]));
  } catch {
    return {};
  }
}

function collectFiles(dir) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => ({ path: `${dir}/${name}`.replaceAll('\\', '/'), bytes: statSync(resolve(dir, name)).size }));
}

/** 解析 --exclude（逗号分隔，支持相对文件名）。 */
export function parseExcludes(raw, dir = null) {
  if (!raw) return [];
  const names = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (dir) {
    const available = collectFiles(dir).map(f => f.path.split('/').pop());
    for (const name of names) {
      const base = name.split('/').pop();
      if (!available.includes(base)) {
        throw new Error(`--exclude 指向不存在的测试文件：${name}（目录 ${dir} 中无 ${base}）`);
      }
    }
  }
  return names;
}

function isExcluded(path, excludes) {
  return excludes.some(ex => path === ex || path.endsWith(`/${ex}`) || path.split('/').pop() === ex.split('/').pop());
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`无法识别的参数：${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = String(args.dir ?? 'training/tests');
  const shards = Number(args.shards ?? 2);
  const excludes = parseExcludes(args.exclude ? String(args.exclude) : null, dir);
  const all = collectFiles(dir);
  const files = all.filter(file => !isExcluded(file.path, excludes));
  if (files.length === 0) {
    console.error(`目录中没有可分配的测试文件：${dir}（exclude=${excludes.join(',') || '无'}）`);
    process.exit(1);
  }
  const weights = loadWeights(args.weights ? String(args.weights) : null);
  const plan = planTestShards({ files, shards, weights });
  if (args.json) {
    writeFileSync(resolve(String(args.json)), JSON.stringify({
      dir, shards, excludes,
      weights: Object.keys(weights).length,
      excludedFiles: all.filter(f => isExcluded(f.path, excludes)).map(f => f.path),
      plan,
    }, null, 2));
  }
  if (args.index === undefined) {
    console.log(JSON.stringify({
      dir, files: files.length, excludes, weights: Object.keys(weights).length, plan,
    }, null, 2));
    return;
  }
  const index = Number(args.index);
  const bucket = plan[index];
  if (!bucket) {
    console.error(`分片索引越界：${index}（共 ${plan.length} 片）`);
    process.exit(1);
  }
  if (bucket.files.length === 0) {
    console.error(`分片 ${index} 没有分配到任何测试文件——拒绝静默通过`);
    process.exit(1);
  }
  console.log(bucket.files.join(' '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`分片计划失败：${error.message}`);
    process.exit(1);
  }
}
