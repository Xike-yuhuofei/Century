import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(base,p),'utf-8');
mkdirSync(resolve(base,'dist'),{recursive:true});
copyFileSync(resolve(base,'index.html'),resolve(base,'dist/index.html'));
copyFileSync(resolve(base,'src/styles.css'),resolve(base,'dist/styles.css'));

// AI6 第六阶段修复：JS5 晋级为默认冠军后，ai/decision 在运行时依赖
// js/（联合搜索适配器）、sim/（公开模拟）、om/（对手模型）模块。桌面内联产物
// 改用 esbuild IIFE 打包：js/sim/om 与 engine/ai 存在大量顶层同名声明
// （fail/requireThat/mulberry32/sharedOM/applyPlay 等），旧的"剥 import 拼接"
// 方案必然冲突，必须由打包器按模块作用域隔离（顺带正确处理
// ai/decision ↔ js/adapter 的循环引用）。
const { build: esbuildBuild } = await import('esbuild');
const bundle = async entry => (await esbuildBuild({
  entryPoints: [resolve(base, entry)], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2020', charset: 'utf8', write: false, logLevel: 'warning',
})).outputFiles[0].text;
// 注入 <script> 的防逃逸：代码字符串里的 </script 会提前终止 HTML 标签；
// <\/script 在 JS 字符串/模板/正则中与 </script 等价。
const scriptSafe = code => code.replace(/<\/script/gi, '<\\/script');
const appBundle = scriptSafe(await bundle('src/app.ts'));

const inlineCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/,'');
const html = read('index.html').replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${inlineCSS}</style>`)
  .replace('<script type="module" src="./js/app.js"></script>', () => `<script>${appBundle}</script>`);
writeFileSync(resolve(base,'dist/standalone.html'),html);
writeFileSync(resolve(base,'dist/.nojekyll'),'');
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行，esbuild 打包）');
