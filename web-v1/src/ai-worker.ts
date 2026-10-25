/** AI 决策 Worker（桌面端，AI6 第六阶段·任务 G2）。
 *
 * 与 src/mobile/worker.ts 同一协议：主线程 postMessage(game) → Worker 内
 * chooseAIAction → postMessage({action})。搜索预算 ≥500ms 时主线程同步
 * 决策会冻结 UI——本 Worker 使游戏界面在 AI 长思考期间保持响应。
 * 信息边界：完整 Game 仅在入口用于构造公开观察与合法性核验（与主线程
 * 同一决策入口），隐藏牌库顺序不出本进程。
 */
import { chooseAIAction } from './ai.js';

self.onmessage = (event: MessageEvent) => {
  try { self.postMessage({ action: chooseAIAction(event.data).action }); }
  catch (e) { self.postMessage({ error: e instanceof Error ? e.message : String(e) }); }
};
