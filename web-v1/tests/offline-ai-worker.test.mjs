/** 离线构建闭包完整性测试（AI6 第六阶段·任务 G）。
 *
 * 防回归目标（任务书 §十二.16/.18）：训练与实战使用相同算法描述符；
 * 网页离线（standalone/mobile）与 Node 环境输出的决策版本一致。
 * 背景：JS5 晋级后冠军路径引入 js//sim//om/ 模块，手工构建清单缺失 31 个
 * 模块，离线版适配器冠军路径损坏（chooseJointAction 未定义）——本测试
 * 提取嵌入 Worker blob 并在 Node 沙箱实跑一次决策，确保冠军路径完整。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createGame } from '../dist/js/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 从 HTML 提取嵌入 Worker blob（classic 脚本）并在 Node 沙箱执行。 */
function loadEmbeddedWorker(htmlPath, markerId) {
  const html = readFileSync(resolve(HERE, htmlPath), 'utf8');
  const marker = `id="${markerId}">`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `${htmlPath} 缺少嵌入 ${markerId}`);
  const blobStart = start + marker.length;
  const blobEnd = html.indexOf('</script>', blobStart);
  const blob = html.slice(blobStart, blobEnd);
  assert.ok(blob.length > 10000, `${markerId} blob 过小（${blob.length} 字符）——闭包缺失`);
  assert.ok(!/^import\s/m.test(blob), `${markerId} 含残留 import 行（classic 脚本非法）`);
  assert.ok(!/^export\s/m.test(blob), `${markerId} 含残留 export 行（classic 脚本非法）`);
  const sandbox = {
    self: { onmessage: null, postMessage: () => {} },
    performance, console, URL, Blob: class {},
  };
  vm.createContext(sandbox);
  vm.runInContext(blob, sandbox, { filename: `${markerId}.js` });
  assert.ok(typeof sandbox.self.onmessage === 'function', `${markerId} 未注册 onmessage`);
  return sandbox.self;
}

test('桌面 standalone：嵌入 AI Worker 含完整冠军闭包并能实跑 JS5 决策', () => {
  const worker = loadEmbeddedWorker('../dist/standalone.html', 'offline-ai-worker');
  const game = createGame(['人类', 'AI 甲', 'AI 乙'], 99_000_001, [1, 2]);
  for (const p of game.players) p.isAI = true;
  let response = null;
  worker.postMessage = (msg) => { response = msg; };
  worker.onmessage({ data: game });
  assert.ok(response, 'Worker 未返回决策');
  assert.ok(!response.error, `Worker 决策报错：${response.error}`);
  assert.ok(response.action && typeof response.action.type === 'string', '决策缺少合法行动');
});

test('桌面 standalone 主内联脚本含适配器冠军路径（chooseJointAction 可用）', () => {
  const html = readFileSync(resolve(HERE, '../dist/standalone.html'), 'utf8');
  assert.ok(html.includes('function chooseJointAction'), '主内联缺少 js/adapter 闭包');
  assert.ok(html.includes('createChampionGuidedPlanner'), '主内联缺少 champion-guided 闭包');
  assert.ok(html.includes("id=\"offline-ai-worker\""), '桌面 standalone 缺少嵌入 AI Worker');
});
