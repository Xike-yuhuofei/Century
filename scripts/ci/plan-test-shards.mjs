#!/usr/bin/env node
/** CI 测试分片计划（纯函数 + CLI）。
 *
 * 背景：training 单测串行执行约 21 分钟，是 PR 墙钟的主要来源。分片把它拆成
 * 多个并行矩阵作业，覆盖不变（每个测试文件仍真实执行，且必须恰好被分配一次）。
 *
 * 分片依据：文件字节数（与运行时长正相关的稳定代理，无需历史数据）。贪心
 * 装入当前最小的分片，并按文件名排序保证确定性——同一提交在任何机器上得到
 * 同一份分片计划。
 *
 * 用法：
 *   node scripts/ci/plan-test-shards.mjs --dir training/tests --shards 3 --index 0
 *   node scripts/ci/plan-test-shards.mjs --dir training/tests --shards 3 --json out.json
 *
 * 输出（stdout）：空格分隔的测试文件路径（供 node --test 直接消费）。
 * 校验失败（目录为空、索引越界）一律非零退出，避免“空分片静默通过”。
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 生成分片计划：每个文件恰好出现一次，分片间按字节数尽量均衡。 */
export function planTestShards({ files, shards }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('测试文件列表为空');
  if (!Number.isSafeInteger(shards) || shards < 1) throw new Error(`分片数非法：${String(shards)}`);
  const count = Math.min(shards, files.length);
  const sorted = [...files].sort((a, b) => (b.bytes - a.bytes) || a.path.localeCompare(b.path));
  const buckets = Array.from({ length: count }, (_, index) => ({ index, files: [], bytes: 0 }));
  for (const file of sorted) {
    const target = buckets.reduce((min, bucket) => (bucket.bytes < min.bytes ? bucket : min), buckets[0]);
    target.files.push(file.path);
    target.bytes += file.bytes;
  }
  const covered = buckets.flatMap(b => b.files);
  if (covered.length !== files.length || new Set(covered).size !== files.length) {
    throw new Error('分片计划未恰好覆盖全部测试文件');
  }
  return buckets.map(bucket => ({
    index: bucket.index,
    bytes: bucket.bytes,
    files: [...bucket.files].sort(),
  }));
}

function collectFiles(dir) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => ({ path: `${dir}/${name}`.replaceAll('\\', '/'), bytes: statSync(resolve(dir, name)).size }));
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
  const files = collectFiles(dir);
  if (files.length === 0) {
    console.error(`目录中没有测试文件：${dir}`);
    process.exit(1);
  }
  const plan = planTestShards({ files, shards });
  if (args.json) {
    writeFileSync(resolve(String(args.json)), JSON.stringify({ dir, shards, plan }, null, 2));
  }
  if (args.index === undefined) {
    console.log(JSON.stringify({ dir, files: files.length, plan }, null, 2));
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
