import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(base,p),'utf-8');
mkdirSync(resolve(base,'dist'),{recursive:true});
copyFileSync(resolve(base,'index.html'),resolve(base,'dist/index.html'));
copyFileSync(resolve(base,'src/styles.css'),resolve(base,'dist/styles.css'));
// AI 4.0：决策核心拆分为 ai/ 目录；'ai' 为兼容桶（mobile/app 与 worker 经 '../ai.js' 引用）。
const AI_MODULES = ['ai/parameters','ai/profiles','ai/observation','ai/knowledge','ai/opponent-model','ai/evaluator','ai/planner','ai/decision'];
const modules = ['data','engine',...AI_MODULES,'organize','replay','app'].map(n => read(`dist/js/${n}.js`)
  .replace(/^import\s.*?from\s+['"].*?['"];?\s*$/gm, '')
  .replace(/^export\s+(?=(const|function|class)\b)/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, ''));
const inlineCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/,'');
const html = read('index.html').replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${inlineCSS}</style>`)
  .replace('<script type="module" src="./js/app.js"></script>', `<script>${'\n'}(()=>{'use strict';${modules.join('\n')}})();${'\n'}</script>`);
writeFileSync(resolve(base,'dist/standalone.html'),html);
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行）');

// 手机入口独立打包；资源目录包含共享引擎/AI 的内容指纹，避免新旧模块混用。
const { createHash } = await import('node:crypto');
const mobileNames = ['data','engine',...AI_MODULES,'ai','organize','replay','mobile/storage','mobile/app','mobile/worker'];
const digest = createHash('sha256').update(mobileNames.map(n=>read(`dist/js/${n}.js`)).join('\n') + read('src/mobile/styles.css')).digest('hex').slice(0,12);
const mobileRoot = resolve(base,'dist/mobile');
const assetPath = `assets/${digest}`;
mkdirSync(resolve(mobileRoot,assetPath),{recursive:true});
for(const name of mobileNames){
  const target=resolve(mobileRoot,assetPath,`${name}.js`);
  mkdirSync(dirname(target),{recursive:true});
  copyFileSync(resolve(base,`dist/js/${name}.js`),target);
}
copyFileSync(resolve(base,'src/mobile/styles.css'),resolve(mobileRoot,assetPath,'styles.css'));
const mobileHTML = read('mobile/index.html').replace('./styles.css',`./${assetPath}/styles.css`).replace('./app.js',`./${assetPath}/mobile/app.js`).replace('./worker.js',`./${assetPath}/mobile/worker.js`);
writeFileSync(resolve(mobileRoot,'modules.html'),mobileHTML);
const strip = n => read(`dist/js/${n}.js`).replace(/^import\s.*?from\s+['"].*?['"];?\s*$/gm,'').replace(/^export\s+(?=(const|function|class)\b)/gm,'').replace(/^export\s*\{[^}]*\};?\s*$/gm,'');
const offlineWorker = ['data','engine',...AI_MODULES,'mobile/worker'].map(strip).join('\n');
const offlineMobile = ['data','engine',...AI_MODULES,'organize','replay','mobile/storage','mobile/app'].map(strip).join('\n');
const mobileOfflineHTML = read('mobile/index.html')
  .replace('<link rel="stylesheet" href="./styles.css">',`<style>${read('src/mobile/styles.css')}</style>`)
  .replace('<script type="module" src="./app.js"></script>',`<script type="text/plain" id="offline-worker">${offlineWorker}</script><script>(()=>{'use strict';${offlineMobile}})();</script>`);
// Pages 的 HTML 可能缓存十分钟；主入口自包含，旧 HTML 仍有完整匹配的规则、样式与 Worker。
writeFileSync(resolve(mobileRoot,'standalone.html'),mobileOfflineHTML);
writeFileSync(resolve(mobileRoot,'index.html'),mobileOfflineHTML);
writeFileSync(resolve(base,'dist/.nojekyll'),'');
console.log(`已生成 dist/mobile/（资源 ${digest}）和 mobile/standalone.html（离线）`);
