/** 复用正式游戏引擎（PR #28 导出链路同一份代码）的加载器。
 *
 * 纪律：本目录不重新实现游戏规则。对局合法性验证与公开局面重建
 * 一律使用 web-v1 正式引擎（tsc 编译产物 dist/js/engine.js + data.js，
 * 与浏览器运行完全同源），避免出现第二套规则实现导致结论分歧。
 *
 * dist/ 不入库（构建产物）；缺失时尝试用本地 typescript 编译一次，
 * 失败则给出明确的构建指引。只编译，不改任何游戏逻辑。
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const WEB_DIR = resolve(REPO_ROOT, 'web-v1');
export const ENGINE_PATH = resolve(WEB_DIR, 'dist', 'js', 'engine.js');
export const REPLAY_PATH = resolve(WEB_DIR, 'dist', 'js', 'replay.js');

function tryBuild() {
  const tscCandidates = [
    resolve(WEB_DIR, 'node_modules', 'typescript', 'bin', 'tsc'),
    resolve(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  const tsc = tscCandidates.find(existsSync);
  if (!tsc) return { ok: false, reason: '未找到 typescript（web-v1/node_modules 缺失）' };
  const result = spawnSync(process.execPath, [tsc, '-p', resolve(WEB_DIR, 'tsconfig.json')], { encoding: 'utf-8' });
  if (result.status !== 0 || !existsSync(ENGINE_PATH)) {
    return { ok: false, reason: `tsc 编译失败：${(result.stderr || result.stdout || '').slice(0, 400)}` };
  }
  return { ok: true };
}

let cache = null;

/** 返回 { engine, data, replay }：均为 web-v1/dist/js 下的编译产物。 */
export async function loadEngine() {
  if (cache) return cache;
  if (!existsSync(ENGINE_PATH)) {
    const build = tryBuild();
    if (!build.ok) {
      throw new Error(`正式引擎尚未编译：缺少 ${ENGINE_PATH}\n原因：${build.reason}\n请在 web-v1 目录执行一次构建（npm install && npx tsc -p tsconfig.json，或 npm run build）后重试。本工具不自带第二套规则实现。`);
    }
  }
  const engine = await import(pathToFileURL(ENGINE_PATH).href);
  const data = await import(pathToFileURL(resolve(WEB_DIR, 'dist', 'js', 'data.js')).href);
  const replay = await import(pathToFileURL(REPLAY_PATH).href);
  cache = { engine, data, replay };
  return cache;
}
