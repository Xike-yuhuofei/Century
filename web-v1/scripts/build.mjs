import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(base,p),'utf-8');
mkdirSync(resolve(base,'dist'),{recursive:true});
copyFileSync(resolve(base,'index.html'),resolve(base,'dist/index.html'));
copyFileSync(resolve(base,'src/styles.css'),resolve(base,'dist/styles.css'));
const modules = ['data','engine','ai','organize','app'].map(n => read(`dist/js/${n}.js`)
  .replace(/^import\s.*?from\s+['"].*?['"];?\s*$/gm, '')
  .replace(/^export\s+(?=(const|function|class)\b)/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, ''));
const inlineCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/,'');
const html = read('index.html').replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${inlineCSS}</style>`)
  .replace('<script type="module" src="./js/app.js"></script>', `<script>${'\n'}(()=>{'use strict';${modules.join('\n')}})();${'\n'}</script>`);
writeFileSync(resolve(base,'dist/standalone.html'),html);
console.log('已生成 dist/index.html（服务器运行）和 dist/standalone.html（直接双击运行）');
