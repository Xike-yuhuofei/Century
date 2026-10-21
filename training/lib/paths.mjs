/** 训练系统公共路径工具：定位仓库根目录与已编译的正式 AI/引擎产物。 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRAINING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(TRAINING_ROOT, '..');
export const WEB_V1_ROOT = resolve(REPO_ROOT, 'web-v1');
export const DIST_ROOT = resolve(WEB_V1_ROOT, 'dist', 'js');

/** 训练与正式网页游戏使用同一份编译产物，禁止训练侧自带算法副本。 */
export function requireBuiltEngine() {
  const engine = resolve(DIST_ROOT, 'engine.js');
  const ai = resolve(DIST_ROOT, 'ai.js');
  if (!existsSync(engine) || !existsSync(ai)) {
    throw new Error(
      '未找到 web-v1/dist/js 编译产物。训练系统与正式游戏共用同一决策核心，请先执行：\n' +
      '  cd web-v1 && npm install && npm run build',
    );
  }
  return { engine, ai };
}

/** 从入口出发收集 dist/js 内相对 import 闭包（训练/网页实际加载的运行时文件集）。 */
function moduleClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  const importPattern = /(?:from\s+|import\s+|import\()\s*['"](\.[^'"]+)['"]/g;
  while (queue.length > 0) {
    const file = resolve(queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      let target = resolve(dirname(file), match[1]);
      if (!target.endsWith('.js')) target += '.js';
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].sort();
}

/** 运行时产物指纹（P1 证据完整性）：对 engine.js + ai.js 的相对 import 闭包内
 * 全部文件做确定性 sha256（路径 + 内容），代表"证据生成时所用的实际引擎版本"。
 * esbuild 构建确定性 + package-lock 锁定工具链 → 同源码同指纹。
 * 晋级核验时与确认挑战证据中的指纹比对，不一致说明引擎在证据生成后已变更，
 * 证据不再适用（须重新挑战），杜绝"旧引擎证据晋级到新引擎"的追溯断链。 */
export function engineBundleSha256() {
  const { engine, ai } = requireBuiltEngine();
  const files = moduleClosure([engine, ai]);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.slice(DIST_ROOT.length + 1));
    hash.update('\0');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
