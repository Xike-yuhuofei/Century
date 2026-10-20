/** 训练系统公共路径工具：定位仓库根目录与已编译的正式 AI/引擎产物。 */
import { existsSync } from 'node:fs';
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
