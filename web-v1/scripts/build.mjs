import { readFileSync, writeFileSync, copyFileSync, mkdirSync, } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, posix } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(base, p), 'utf-8');
mkdirSync(resolve(base, 'dist'), { recursive: true });
copyFileSync(resolve(base, 'index.html'), resolve(base, 'dist/index.html'));
copyFileSync(resolve(base, 'src/styles.css'), resolve(base, 'dist/styles.css'));

const esbuild = await import('esbuild');
const JS = 'dist/js';

/** 用 esbuild 把入口打成自包含 IIFE（正确处理模块作用域、循环依赖与重名）。
 * 背景（CI 修复）：JS5（PR #26）起决策链 ai/decision → js/adapter 引入 js/*、om/*、
 * sim/* 二十余个新模块；此前 build.mjs 以「剥 import/export + 手工模块清单」扁平拼接，
 * 清单漏加 → 运行时 ReferenceError（chooseJointAction is not defined）→ AI 停摆 →
 * 浏览器冒烟超时。改用 esbuild 后不再可能漏模块或撞名。 */
async function bundle(entryName) {
  const result = await esbuild.build({
    entryPoints: [resolve(base, JS, `${entryName}.js`)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

// 依赖闭包（仅用于 mobile 资产文件拷贝与指纹；内联打包交给 esbuild）。
function depsOf(moduleName) {
  const src = read(`${JS}/${moduleName}.js`);
  const specs = [];
  for (const m of src.matchAll(/^(?:import|export)\s.*?from\s*['"]([^'"]+)['"];?\s*$/gm)) specs.push(m[1]);
  for (const m of src.matchAll(/^import\s+['"]([^'"]+)['"];?\s*$/gm)) specs.push(m[1]);
  return [...new Set(specs.map(s => {
    if (!s.startsWith('.')) return null;
    const t = posix.normalize(posix.join(posix.dirname(`${JS}/${moduleName}`), s));
    if (!t.startsWith(`${JS}/`)) return null;
    return t.slice(JS.length + 1).replace(/\.js$/, '');
  }).filter(Boolean))];
}
function collectModules(entries) {
  const order = [], seen = new Set();
  const visit = name => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of depsOf(name)) visit(dep);
    order.push(name);
  };
  for (const e of entries) visit(e);
  return order;
}

const inlineCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/, '');
const standaloneJS = await bundle('app');
const html = read('index.html').replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${inlineCSS}</style>`)
  .replace('<script type="module" src="./js/app.js"></script>', `<script>${'\n'}(()=>{'use strict';${standaloneJS}})();${'\n'}</script>`);
writeFileSync(resolve(base, 'dist/standalone.html'), html);
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行）');

// 手机入口独立打包；资源目录包含共享引擎/AI 的内容指纹，避免新旧模块混用。
const { createHash } = await import('node:crypto');
const mobileNames = collectModules(['mobile/app', 'mobile/worker']);
const digest = createHash('sha256').update(mobileNames.map(n => read(`${JS}/${n}.js`)).join('\n') + read('src/mobile/styles.css')).digest('hex').slice(0, 12);
const mobileRoot = resolve(base, 'dist/mobile');
const assetPath = `assets/${digest}`;
mkdirSync(resolve(mobileRoot, assetPath), { recursive: true });
for (const name of mobileNames) {
  const target = resolve(mobileRoot, assetPath, `${name}.js`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(base, `${JS}/${name}.js`), target);
}
copyFileSync(resolve(base, 'src/mobile/styles.css'), resolve(mobileRoot, assetPath, 'styles.css'));
const mobileHTML = read('mobile/index.html').replace('./styles.css', `./${assetPath}/styles.css`).replace('./app.js', `./${assetPath}/mobile/app.js`).replace('./worker.js', `./${assetPath}/mobile/worker.js`);
writeFileSync(resolve(mobileRoot, 'modules.html'), mobileHTML);
const offlineWorker = await bundle('mobile/worker');
const offlineMobile = await bundle('mobile/app');
const mobileOfflineHTML = read('mobile/index.html')
  .replace('<link rel="stylesheet" href="./styles.css">', `<style>${read('src/mobile/styles.css')}</style>`)
  .replace('<script type="module" src="./app.js"></script>', `<script type="text/plain" id="offline-worker">${offlineWorker}</script><script>(()=>{'use strict';${offlineMobile}})();</script>`);
// Pages 的 HTML 可能缓存十分钟；主入口自包含，旧 HTML 仍有完整匹配的规则、样式与 Worker。
writeFileSync(resolve(mobileRoot, 'standalone.html'), mobileOfflineHTML);
writeFileSync(resolve(mobileRoot, 'index.html'), mobileOfflineHTML);
writeFileSync(resolve(base, 'dist/.nojekyll'), '');
console.log(`已生成 dist/mobile/（资源 ${digest}，${mobileNames.length} 模块）和 mobile/standalone.html（离线）`);
