/** 离线构建闭包完整性测试（AI6 第六阶段·任务 G / AI7 E3）。
 *
 * 防回归目标：训练与实战使用相同算法描述符；网页离线（standalone/服务器）
 * 嵌入的 Worker 必须包含完整冠军闭包，并能在无宿主页面的沙箱中真实执行
 * 一次协议决策。
 *
 * AI7 起嵌入 Worker 从 G2 的 "整份 Game 进 Worker" 改为公开观察 + 协议
 * （worker-core/decision-core）；本测试同步改为在 Node vm 沙箱里跑
 * init + decision 往返，确保内联产物不是空壳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createGame } from '../dist/js/engine.js';
import { buildObservation } from '../dist/js/ai/observation.js';
import { PROTOCOL_VERSION } from '../dist/js/ai-runtime/protocol.js';

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

test('桌面 standalone：嵌入 Worker 含完整冠军闭包并能执行协议决策', () => {
  const worker = loadEmbeddedWorker('../dist/standalone.html', 'ai-worker-source');
  const game = createGame(['人类', 'AI 甲', 'AI 乙'], 99_000_001, [1, 2]);
  game.current = 1;
  game.phase = 'turn';
  const observation = buildObservation(game, 1);
  const responses = [];
  worker.postMessage = (msg) => { responses.push(msg); };

  worker.onmessage({ data: { kind: 'init', protocolVersion: PROTOCOL_VERSION } });
  assert.equal(responses.at(-1)?.kind, 'ready', '内联 Worker 未完成协议握手');

  worker.onmessage({
    data: {
      kind: 'decision', protocolVersion: PROTOCOL_VERSION,
      requestId: 'offline-check-1', gameStateVersion: 1,
      payload: {
        observation, ai: { jointVersion: 'joint-js5' },
        budget: { mode: 'fixed-work', workUnits: 2 }, simSeed: 1, horizon: 20,
      },
    },
  });
  const response = responses.at(-1);
  assert.equal(response?.kind, 'decision', `内联 Worker 未返回决策：${JSON.stringify(response)}`);
  assert.ok(response.diagnostics.action && typeof response.diagnostics.action.type === 'string', '决策缺少合法行动');
});

test('桌面 standalone 主内联脚本含适配器冠军路径（chooseJointAction 可用）', () => {
  const html = readFileSync(resolve(HERE, '../dist/standalone.html'), 'utf8');
  assert.ok(html.includes('function chooseJointAction'), '主内联缺少 js/adapter 闭包');
  assert.ok(html.includes('createChampionGuidedPlanner'), '主内联缺少 champion-guided 闭包');
  assert.ok(html.includes('id="ai-worker-source"'), '桌面 standalone 缺少嵌入 AI Worker');
});
