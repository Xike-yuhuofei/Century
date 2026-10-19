import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(base, path), 'utf-8');
mkdirSync(resolve(base, 'dist/mobile'), { recursive:true });
copyFileSync(resolve(base,'index.html'),resolve(base,'dist/index.html'));
copyFileSync(resolve(base,'src/styles.css'),resolve(base,'dist/styles.css'));

const modules = ['data','engine','ai','organize','app'].map(name => read(`dist/js/${name}.js`)
  .replace(/^import\s.*?from\s+['"].*?['"];?\s*$/gm, '')
  .replace(/^export\s+(?=(const|function|class)\b)/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, ''));
const sourceCSS = read('src/styles.css').replace(/^@import url\(''\);\s*/,'');
const script = `<script>\n(()=>{'use strict';${modules.join('\n')}})();\n</script>`;

function bundle(css) {
  return read('index.html')
    .replace('<link rel="stylesheet" href="./styles.css"/>', `<style>${css}</style>`)
    .replace('<script type="module" src="./js/app.js"></script>', script);
}

const desktopHTML = bundle(sourceCSS);
writeFileSync(resolve(base,'dist/standalone.html'),desktopHTML);

// 专属 /mobile/ 入口在任何窗口宽度均强制使用手机界面。
// 把独立的移动端样式媒体查询变成无条件规则，仅应用于该 HTML，
// 而不是复制游戏逻辑、规则或 AI 实现。
const marker = '/* MOBILE GAME V1';
const markerIndex = sourceCSS.indexOf(marker);
if (markerIndex < 0) throw new Error('找不到手机端样式块');
const mobileCSS = sourceCSS.slice(0,markerIndex) +
  sourceCSS.slice(markerIndex).replace('@media (max-width:980px) {', '@media (min-width:0px) {');
if (mobileCSS === sourceCSS) throw new Error('无法将手机端样式应用于独立页面');

const mobileHTML = bundle(mobileCSS)
  .replace('<html lang="zh-CN">', '<html lang="zh-CN" data-century-mode="mobile">')
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>')
  .replace(/<title>[^<]*<\/title>/,
    '<title>晶石回廊 · 手机版</title>')
  .replace('</head>',
    '<meta name="apple-mobile-web-app-capable" content="yes"/>\n<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>\n</head>');
writeFileSync(resolve(base,'dist/mobile/index.html'),mobileHTML);
console.log('已生成 dist/standalone.html（电脑版/响应式）和 dist/mobile/index.html（独立手机版）');
