import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(base,p),'utf-8');
mkdirSync(resolve(base,'dist'),{recursive:true});
copyFileSync(resolve(base,'index.html'),resolve(base,'dist/index.html'));
copyFileSync(resolve(base,'src/styles.css'),resolve(base,'dist/styles.css'));

// AI6 第六阶段（任务 G）：standalone/离线 Worker 改用 esbuild IIFE 打包——
// JS5 晋级后冠军路径引入 js//sim//om/ 模块，手工 strip 清单既缺 31 个模块
// 又存在跨模块顶层标识符冲突（requireThat 等），strip 内联法不可持续。
// esbuild 以模块作用域根治冲突；入口变化时闭包自动跟随（无手工清单可腐烂）。
// 固定版本（devDependencies）+ 无 minify → 同源码同产物（确定性构建）。
const esbuild = (await import('esbuild')).default;
const buildIIFE = (entry, outfile) => esbuild.buildSync({
  entryPoints: [resolve(base, entry)],
  outfile: resolve(base, outfile),
  bundle: true, format: 'iife', target: 'es2020', minify: false, sourcemap: false,
  logLevel: 'silent', charset: 'utf8',
});

buildIIFE('src/app.ts', 'dist/standalone-bundle.js');
buildIIFE('src/ai-worker.ts', 'dist/standalone-ai-worker.js');
const inline = read('dist/standalone-bundle.js');
const inlineAIWorker = read('dist/standalone-ai-worker.js');
const inlineCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/,'');
const html = read('index.html').replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${inlineCSS}</style>`)
  .replace('<script type="module" src="./js/app.js"></script>', `<script>${'\n'}${inline}${'\n'}</script>`)
  // 桌面 AI Worker（G2）：内嵌 classic Worker（file:// 下 module Worker 不可用）。
  .replace('</body>', `<script type="text/plain" id="offline-ai-worker">${inlineAIWorker}</script></body>`);
writeFileSync(resolve(base,'dist/standalone.html'),html);
rmSync(resolve(base,'dist/standalone-bundle.js'));
rmSync(resolve(base,'dist/standalone-ai-worker.js'));
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行；esbuild IIFE 含冠军适配器闭包 + 嵌入 AI Worker）');

// 手机入口：模块模式（modules.html）继续按文件分发（含完整闭包清单，
// 由 dist/js 相对 import 闭包自动计算——与 training/lib/paths.mjs 同算法）。
const { createHash } = await import('node:crypto');
const { existsSync } = await import('node:fs');
const closureNames = entries => {
  const names = [];
  const seen = new Set();
  const pattern = /(?:from\s+|import\s+|import\()\s*['"](\.[^'"]+)['"]/g;
  const visit = rel => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const file = resolve(base, 'dist/js', rel);
    if (!existsSync(file)) throw new Error(`闭包文件缺失：${rel}（先执行 tsc）`);
    const src = readFileSync(file, 'utf8');
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    for (const m of src.matchAll(pattern)) {
      let t = m[1];
      if (!t.endsWith('.js')) t += '.js';
      const parts = dir ? dir.split('/') : [];
      for (const seg of t.split('/')) {
        if (seg === '.' || seg === '') continue;
        else if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      visit(parts.join('/'));
    }
    names.push(rel.replace(/\.js$/, ''));
  };
  for (const e of entries) visit(e);
  return names;
};
const mobileNames = [...new Set([...closureNames(['mobile/app.js','mobile/worker.js']), 'organize','replay','mobile/storage'])];
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
// 离线 mobile：esbuild IIFE 双包（app + worker），无手工清单、无标识符冲突。
buildIIFE('src/mobile/app.ts', 'dist/mobile-standalone-bundle.js');
buildIIFE('src/mobile/worker.ts', 'dist/mobile-standalone-ai-worker.js');
const offlineWorker = read('dist/mobile-standalone-ai-worker.js');
const offlineMobile = read('dist/mobile-standalone-bundle.js');
const mobileOfflineHTML = read('mobile/index.html')
  .replace('<link rel="stylesheet" href="./styles.css">',`<style>${read('src/mobile/styles.css')}</style>`)
  .replace('<script type="module" src="./app.js"></script>',`<script type="text/plain" id="offline-worker">${offlineWorker}</script><script>${offlineMobile}</script>`);
// Pages 的 HTML 可能缓存十分钟；主入口自包含，旧 HTML 仍有完整匹配的规则、样式与 Worker。
writeFileSync(resolve(mobileRoot,'standalone.html'),mobileOfflineHTML);
writeFileSync(resolve(mobileRoot,'index.html'),mobileOfflineHTML);
rmSync(resolve(base,'dist/mobile-standalone-bundle.js'));
rmSync(resolve(base,'dist/mobile-standalone-ai-worker.js'));
writeFileSync(resolve(base,'dist/.nojekyll'),'');
console.log(`已生成 dist/mobile/（资源 ${digest}，${mobileNames.length} 模块）和 mobile/standalone.html（离线，esbuild IIFE）`);
