/** ai-runtime 构建步骤：把 opt-in 验收页复制进 dist（跟随 npm run build）。
 * 不参与 dist/index.html / standalone.html 的任何内联产物——
 * 默认桌面/离线单文件行为完全不变。 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(base, 'dist/ai-runtime'), { recursive: true });
copyFileSync(resolve(base, 'src/ai-runtime/harness.html'), resolve(base, 'dist/ai-runtime/harness.html'));
console.log('已生成 dist/ai-runtime/harness.html（opt-in Worker 验收页）');
