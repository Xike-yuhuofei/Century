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
writeFileSync(resolve(base,'dist/.nojekyll'),'');
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行；esbuild IIFE 含冠军适配器闭包 + 嵌入 AI Worker）');
