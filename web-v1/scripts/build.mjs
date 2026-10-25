import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(base,p),'utf-8');
mkdirSync(resolve(base,'dist'),{recursive:true});
copyFileSync(resolve(base,'src/styles.css'),resolve(base,'dist/styles.css'));

// AI6 第六阶段（任务 G）+ AI7：standalone/服务器入口统一用 esbuild IIFE 打包。
// JS5/JS6 冠军路径引入 js//sim//om/ 模块，手工 strip 清单既缺模块又存在跨模块
// 顶层标识符冲突；esbuild 以模块作用域根治冲突。固定版本 + 无 minify → 确定性构建。
const esbuild = (await import('esbuild')).default;
const buildIIFE = (entry, outfile, banner) => esbuild.buildSync({
  entryPoints: [resolve(base, entry)],
  outfile: resolve(base, outfile),
  bundle: true, format: 'iife', target: 'es2020', minify: false, sourcemap: false,
  logLevel: 'silent', charset: 'utf8',
  ...(banner ? { banner: { js: banner } } : {}),
});

buildIIFE('src/app.ts', 'dist/standalone-bundle.js');
// AI7 E3：Worker 与页面共用同一决策核心（worker-core/decision-core/js/sim/om），
// 打成经典脚本后内联；运行时经 Blob 创建，不请求外部 worker.js。
buildIIFE('src/ai-runtime/worker.ts', 'dist/standalone-ai-worker.js', '/* CENTURY_AI_WORKER */');
const rawApp = read('dist/standalone-bundle.js');
const rawWorker = read('dist/standalone-ai-worker.js');
// 注入 <script> 的防逃逸：代码字符串里的 </script 会提前终止 HTML 标签；
// <\/script 在 JS 字符串/模板/正则中与 </script 等价。
const scriptSafe = code => code.replace(/<\/script/gi, '<\\/script');
const inline = scriptSafe(rawApp);
const inlineAIWorker = scriptSafe(rawWorker);
// 诊断/测试用独立副本（页面使用内联源码；两者仅差 </script> 防逃逸转义）。
writeFileSync(resolve(base,'dist/js/ai-runtime/worker-browser.js'), rawWorker);

const inlineCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/,'');
const template = read('index.html');
const standalone = template.replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${inlineCSS}</style>`)
  .replace('<script type="module" src="./js/app.js"></script>', () => `<script>${'\n'}${inline}${'\n'}</script>`)
  .replace('/*__AI_WORKER_SOURCE__*/', () => inlineAIWorker);
const server = template.replace('/*__AI_WORKER_SOURCE__*/', () => inlineAIWorker);
writeFileSync(resolve(base,'dist/standalone.html'),standalone);
writeFileSync(resolve(base,'dist/index.html'),server);
rmSync(resolve(base,'dist/standalone-bundle.js'));
rmSync(resolve(base,'dist/standalone-ai-worker.js'));
writeFileSync(resolve(base,'dist/.nojekyll'),'');
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行；esbuild IIFE + 内联经典 AI Worker）');
