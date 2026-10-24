import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(base,p),'utf-8');
mkdirSync(resolve(base,'dist'),{recursive:true});
copyFileSync(resolve(base,'index.html'),resolve(base,'dist/index.html'));
copyFileSync(resolve(base,'src/styles.css'),resolve(base,'dist/styles.css'));

// AI6 第六阶段修复：JS5 晋级为默认冠军后，ai/decision 在运行时依赖
// js/（联合搜索适配器）、sim/（公开模拟）、om/（对手模型）模块。打包口径分两类：
// 1) 指纹资产（modules.html 与 Worker）＝原生 ES 模块逐文件复制：从移动入口根
//    计算 tsc 产物的 import 传递闭包（此前为手工清单——AI6 新增 js/sim/om 未纳入，
//    Worker 内 chooseJointAction 未定义，AI 静默停摆且无控制台错误）；闭包自动
//    计算，未来新增 AI 模块不再可能被遗漏。
// 2) 内联产物（桌面 standalone.html、手机 offline 主入口）＝esbuild IIFE 打包：
//    js/sim/om 与 engine/ai 存在大量顶层同名声明（fail/requireThat/mulberry32/
//    sharedOM/applyPlay 等），旧的"剥 import 拼接"方案必然冲突，必须由打包器
//    按模块作用域隔离（顺带正确处理 ai/decision ↔ js/adapter 的循环引用）。
const compiledImports = name => {
  const file = resolve(base,`dist/js/${name}.js`);
  // 兼容 tsc 两种再导出形态：import … from 与 export {…} from / export * from（ai.js 桶）。
  return [...readFileSync(file,'utf8').matchAll(/^(?:import\s.+?|export\s*(?:\{[^}]*\}|\*)\s*)from\s+['"](.+?)['"];?\s*$/gm)]
    .map(m => m[1]).filter(s => s.startsWith('.'))
    .map(s => relative(resolve(base,'dist/js'), join(dirname(file), s)).replace(/\.js$/,'').replace(/\\/g,'/'));
};
const closureOf = roots => {
  const seen = new Set();
  const visit = name => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const imp of compiledImports(name)) visit(imp);
  };
  roots.forEach(visit);
  return [...seen].sort();
};
const mobileNames = closureOf(['data','engine','ai','organize','replay','mobile/storage','mobile/app','mobile/worker']);

const { build: esbuildBuild } = await import('esbuild');
const bundle = async entry => (await esbuildBuild({
  entryPoints: [resolve(base, entry)], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2020', charset: 'utf8', write: false, logLevel: 'warning',
})).outputFiles[0].text;
// 注入 <script> 的防逃逸：代码字符串里的 </script 会提前终止 HTML 标签；
// <\/script 在 JS 字符串/模板/正则中与 </script 等价。
const scriptSafe = code => code.replace(/<\/script/gi, '<\\/script');
const appBundle = scriptSafe(await bundle('src/app.ts'));
const mobileAppBundle = scriptSafe(await bundle('src/mobile/app.ts'));
const workerBundle = scriptSafe(await bundle('src/mobile/worker.ts'));

const inlineCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/,'');
const html = read('index.html').replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${inlineCSS}</style>`)
  .replace('<script type="module" src="./js/app.js"></script>', () => `<script>${appBundle}</script>`);
writeFileSync(resolve(base,'dist/standalone.html'),html);
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行，esbuild 打包）');

// 手机入口独立打包；资源目录包含共享引擎/AI 的内容指纹，避免新旧模块混用。
const { createHash } = await import('node:crypto');
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
const mobileOfflineHTML = read('mobile/index.html')
  .replace('<link rel="stylesheet" href="./styles.css">',`<style>${read('src/mobile/styles.css')}</style>`)
  .replace('<script type="module" src="./app.js"></script>', () => `<script type="text/plain" id="offline-worker">${workerBundle}</script><script>${mobileAppBundle}</script>`);
// Pages 的 HTML 可能缓存十分钟；主入口自包含，旧 HTML 仍有完整匹配的规则、样式与 Worker。
writeFileSync(resolve(mobileRoot,'standalone.html'),mobileOfflineHTML);
writeFileSync(resolve(mobileRoot,'index.html'),mobileOfflineHTML);
writeFileSync(resolve(base,'dist/.nojekyll'),'');
console.log(`已生成 dist/mobile/（资源 ${digest}，${mobileNames.length} 模块闭包）和 mobile/standalone.html（离线）`);
