#!/usr/bin/env node
/** 构建清单生成（AI7 任务 A3）：npm run build 的最后一步。
 *
 * 写入 web-v1/dist/build-manifest.json：
 * - source：源码闭包确定性 sha256 + 逐文件哈希；
 * - artifact：运行产物闭包 sha256 + 逐文件哈希（同 engineBundleSha256 口径）；
 * - gitCommit / gitDirty / gitDirtyFiles；
 * - toolchain：node/esbuild/typescript 版本。
 *
 * 训练与挑战启动前由 training/lib/paths.mjs#requireBuiltEngine 复核：
 * 源码改动但未重新构建 → fail-closed。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_MANIFEST_PATH, createBuildManifest } from './build-hash.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '..');
const manifest = createBuildManifest({ repoRoot, webRoot });
const out = resolve(webRoot, BUILD_MANIFEST_PATH);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `已生成构建清单：${BUILD_MANIFEST_PATH}\n` +
  `  source=${manifest.source.sha256.slice(0, 16)}（${manifest.source.fileCount} 文件）\n` +
  `  artifact=${manifest.artifact.sha256.slice(0, 16)}（${manifest.artifact.fileCount} 文件）\n` +
  `  git=${String(manifest.gitCommit).slice(0, 12)} dirty=${manifest.gitDirty}`,
);
